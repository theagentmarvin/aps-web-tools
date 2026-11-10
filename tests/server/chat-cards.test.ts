/**
 * G12 chat: cards from store data (action, validity, target, clash count; questions in full),
 * the narration / English-preamble safety net, and the header chip ignoring the chat agent.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../server/api/contract";
import { chatCard } from "../../server/chat/cards";
import { looksEnglish, looksLikeNarration, NarrationFilter } from "../../server/chat/narration";
import { ChatService } from "../../server/chat/service";
import { CHAT_AGENT_ACTOR, type Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { HUMAN, ingest, makeCoord, ROOT, tempHome } from "./helpers";

const FAKE = join(ROOT, "tests", "server", "fake-claude.mjs");
const fakeBin = () => ({ command: process.execPath, prefixArgs: [FAKE] });

let coord: Coordinator;
let testKey: string;
let cleanup: () => void;

beforeAll(async () => {
  const t = tempHome();
  cleanup = t.cleanup;
  coord = makeCoord(t.home);
  testKey = await ingest(coord, 42);
}, 120_000);
afterAll(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  cleanup();
});

describe("narration filter (pure)", () => {
  const run = (steps: Array<string | boolean>) => {
    const out: string[] = [];
    const f = new NarrationFilter((t) => out.push(t));
    for (const s of steps) typeof s === "string" ? f.push(s) : f.end(s);
    return out.join("");
  };
  it("drops English or narrating preambles before a tool call, keeps the answer", () => {
    expect(looksEnglish("I'll check the family's details first.")).toBe(true);
    expect(looksEnglish("Reviso la familia y el grupo de la ubicación.")).toBe(false);
    expect(looksLikeNarration("Reviso el grupo…")).toBe(true);
    expect(looksLikeNarration("El grupo es un Conflicto.")).toBe(false);
    expect(run(["I'll check the family's details first.", true, "Reviso el grupo…", true, "El grupo es un Conflicto.", false])).toBe("El grupo es un Conflicto.");
    // Spanish content before a tool call (e.g. before creating a proposal) is kept, paragraphs apart.
    expect(run(["El ducto cruza la viga.", true, "Propuestas: P-1", false])).toBe("El ducto cruza la viga.\n\nPropuestas: P-1");
    // A final answer is never hidden, even in English.
    expect(run(["The duct crosses the beam.", false])).toBe("The duct crosses the beam.");
  });
  it("long Spanish text streams live once past the hold window", () => {
    const out: string[] = [];
    const f = new NarrationFilter((t) => out.push(t));
    f.push("el grupo de la ubicación ".repeat(4));
    expect(out.length).toBe(0);
    f.push("el grupo de la ubicación ".repeat(4));
    expect(out.length).toBe(1);
    f.push(" más");
    expect(out.length).toBe(2);
  });
});

describe("chat cards (server data only)", () => {
  it("classification card: action + validity + ubicación name and clash count", async () => {
    const cls = (await coord.store.getClassification(testKey))!;
    const g = cls.groups[0]!;
    const r = await coord.proposeClassification({ testKey, target: { groupId: g.id }, validity: "real", suggestedAction: "create_issue", disagreesWithEngine: false, rationale: "Confirmo la interferencia.", evidence: [], confidence: "alta" });
    const card = (await chatCard(coord, r.proposalId, "proposal"))!;
    expect(card).toMatchObject({ id: r.proposalId, kind: "classification", action: "create_issue", validity: "real", target: { kind: "group", id: g.id, label: g.title, clashCount: g.clashIds.length } });
  });
  it("family decision card targets the grupo; question card carries the full question", async () => {
    const { views } = await coord.familyViewsFor(testKey);
    const f = views.find((v) => v.proposed.validity === "real")!;
    const r = await coord.proposeFamilyDecision({ testKey, familyId: f.id, validity: "real", action: "create_issue", rationale: "Misma solución tipo." });
    expect(await chatCard(coord, r.proposalId, "proposal")).toMatchObject({ kind: "family_decision", action: "create_issue", validity: "real", target: { kind: "family", id: f.id } });
    const g = (await coord.store.getClassification(testKey))!.groups[1]!;
    const q = await coord.askCoordinator({ testKey, groupIds: [g.id], question: "¿El ducto pasa bajo la viga o la atraviesa?", options: [{ label: "La atraviesa", validity: "real" }, { label: "Pasa bajo", validity: "false_positive" }], kind: "validity" });
    const qc = (await chatCard(coord, q.questionId, "question"))!;
    expect(qc).toMatchObject({ kind: "question", state: "open", target: { kind: "group", id: g.id }, question: { id: q.questionId, options: [{ label: "La atraviesa" }, { label: "Pasa bajo" }] } });
    expect(await chatCard(coord, "P-20991231-9999", "proposal")).toBeUndefined();
  });
});

describe("chat stream safety net (fake claude)", () => {
  it("an English preamble and pre-tool narration never reach the bubble", async () => {
    process.env.FAKE_CLAUDE_MODE = "preamble";
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const { messageId } = await chat.send({ testKey, message: "¿Qué es este grupo?" }, HUMAN);
    const ev = await new Promise<ChatEvent[]>((resolve) => {
      const all: ChatEvent[] = [];
      chat.subscribe(messageId, HUMAN, (e, last) => {
        all.push(e);
        if (last) resolve(all);
      });
    });
    const text = ev.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("El grupo es un **Conflicto**: el ducto CLI cruza la viga EST.");
    expect(ev.at(-1)).toMatchObject({ type: "done" });
    const h = await chat.history(testKey, HUMAN);
    expect(h.messages.at(-1)!.text).not.toMatch(/I'll|Reviso/);
  }, 60_000);
});

describe("header chip", () => {
  it("the chat agent's tool calls do not mark the agent as analysing", async () => {
    const t = tempHome();
    try {
      const c2 = makeCoord(t.home);
      await c2.store.audit({ actor: CHAT_AGENT_ACTOR, action: "group.read", targetIds: [] });
      expect((await new CoordinatorUi(c2).agentStatus()).running).toBe(false);
      await c2.store.audit({ actor: { type: "agent", id: "claude-code", name: "Agente" }, action: "group.read", targetIds: [] });
      expect((await new CoordinatorUi(c2).agentStatus()).running).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
