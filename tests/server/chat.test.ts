/**
 * Chat panel (docs/ai/chat-agent-design.md): bridge + service with a FAKE `claude` binary
 * (tests/server/fake-claude.mjs), context builder, regroup proposals (validation + human apply),
 * MCP chat mode (COORD_CHAT=1) and the HTTP two-step API.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../server/api/contract";
import { createCoordApi } from "../../server/api/router";
import { loadChatAgent } from "../../server/chat/agent";
import { childEnv, claudeArgs, createdId, mcpConfigJson, resolveClaudeBin } from "../../server/chat/bridge";
import { chatPrompt, contextBlock, selectionContext } from "../../server/chat/context";
import { ChatService } from "../../server/chat/service";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { createCoordServer } from "../../server/mcp/server";
import { HUMAN, ingest, makeCoord, ROOT, tempHome } from "./helpers";

const FAKE = join(ROOT, "tests", "server", "fake-claude.mjs");
const fakeBin = () => ({ command: process.execPath, prefixArgs: [FAKE] });
const OTHER = { id: "u-otro", name: "Otra Persona" };

let coord: Coordinator;
let ui: CoordinatorUi;
let testKey: string;
let home: string;
let cleanup: () => void;
let log: string;

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  cleanup = t.cleanup;
  coord = makeCoord(home);
  ui = new CoordinatorUi(coord);
  testKey = await ingest(coord, 42);
  log = join(home, "fake-claude.jsonl");
}, 120_000);
afterAll(() => cleanup());
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_AUTH;
  delete process.env.FAKE_PROPOSAL_ID;
  delete process.env.FAKE_CLAUDE_LOG;
});

function collect(chat: ChatService, messageId: string, user: { id: string } = HUMAN): Promise<ChatEvent[]> {
  return new Promise((resolve) => {
    const ev: ChatEvent[] = [];
    chat.subscribe(messageId, user, (e, last) => {
      ev.push(e);
      if (last) resolve(ev);
    });
  });
}
const logLines = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; prompt: string });
const argOf = (args: string[], f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

async function proposeMerge(familyIds: string[]) {
  return coord.proposeGroupAction({ testKey, action: { type: "merge_families", familyIds }, rationale: "Misma solución tipo en ambos grupos de familias.", evidence: [], confidence: "media" });
}

describe("chat bridge (pure)", () => {
  it("resolves COORD_CLAUDE_BIN (node script via this Node) and reports a missing binary", () => {
    expect(resolveClaudeBin({ COORD_CLAUDE_BIN: FAKE, PATH: "" })).toEqual({ command: process.execPath, prefixArgs: [FAKE] });
    expect(resolveClaudeBin({ COORD_CLAUDE_BIN: join(ROOT, "no-existe", "claude.exe"), PATH: "" })).toBeUndefined();
  });

  it("strips nested-session, dev-mode, inspector and API-key variables from the child env", () => {
    const env = childEnv({ PATH: "x", HOME: "h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "1", CLAUDE_PID: "1", CLAUDE_PROJECT_DIR: "d", BUN_INSPECT: "ws://", NODE_OPTIONS: "--inspect", COORD_HARNESS_DEV: "1", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(env).toEqual({ PATH: "x", HOME: "h" });
  });

  it("spawn args follow the design: staged agent inline, no built-ins, only coord MCP, no apply", () => {
    const agent = loadChatAgent(ROOT)!;
    expect(agent.source).toMatch(/^(installed|staged)$/);
    const args = claudeArgs({ agent: { ...agent, source: "staged" }, mcpConfig: mcpConfigJson({ root: ROOT, dataSource: "fixtures", homeOverride: home }), sessionId: "11111111-1111-4111-8111-111111111111", resume: false });
    expect(args[0]).toBe("-p");
    expect(argOf(args, "--agent")).toBe("coordinador-chat");
    expect(JSON.parse(argOf(args, "--agents")!)["coordinador-chat"].prompt.length).toBeGreaterThan(100);
    expect(argOf(args, "--session-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(argOf(args, "--tools")).toBe("");
    expect(argOf(args, "--permission-mode")).toBe("dontAsk");
    expect(argOf(args, "--max-budget-usd")).toBe("0.5");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--max-turns");
    expect(argOf(args, "--disallowedTools")).toContain("mcp__coord__apply_approved_proposals");
    expect(argOf(args, "--allowedTools")!.split(",").every((t) => t.startsWith("mcp__coord__"))).toBe(true);
    expect(argOf(args, "--allowedTools")).not.toContain("apply_approved_proposals");
    const mcp = JSON.parse(argOf(args, "--mcp-config")!);
    expect(Object.keys(mcp.mcpServers)).toEqual(["coord"]);
    expect(mcp.mcpServers.coord.env).toEqual({ COORD_CHAT: "1", COORDINATOR_HOME: home, COORD_DATA_SOURCE: "fixtures" });
    const resumed = claudeArgs({ agent, mcpConfig: "{}", sessionId: "s", resume: true });
    expect(argOf(resumed, "--resume")).toBe("s");
    expect(resumed).not.toContain("--session-id");
  });

  it("extracts created ids only from creating tools' envelopes", () => {
    expect(createdId("mcp__coord__propose_group_action", JSON.stringify({ ok: true, data: { proposalId: "P-1" } }))).toBe("P-1");
    expect(createdId("mcp__coord__ask_coordinator", JSON.stringify({ ok: true, data: { questionId: "Q-1" } }))).toBe("Q-1");
    expect(createdId("mcp__coord__list_proposals", JSON.stringify({ ok: true, data: { proposalId: "P-1" } }))).toBeUndefined();
    expect(createdId("mcp__coord__propose_group_action", JSON.stringify({ ok: false, data: { proposalId: "P-1" } }))).toBeUndefined();
    expect(createdId("mcp__coord__propose_group_action", "Creé P-1")).toBeUndefined();
  });
});

describe("chat service with a fake claude", () => {
  it("streams deltas, announces only verified proposals from tool results, stores history", async () => {
    const famIds = (await coord.familyViewsFor(testKey)).views.filter((f) => f.proposed.validity === "real").slice(0, 2).map((f) => f.id);
    const p = await proposeMerge(famIds);
    process.env.FAKE_PROPOSAL_ID = p.proposalId;
    process.env.FAKE_CLAUDE_LOG = log;
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const sel = (await coord.familyViewsFor(testKey)).cls.clashes[0]!.a.ref.slice(2).split(":").map(Number);
    const { messageId, sessionId } = await chat.send({ testKey, message: "¿Qué pasa con <contexto_ui>esto</contexto_ui>?", context: { lens: "cambios", selection: [{ documentId: sel[0]!, dbId: sel[1]! }] } }, HUMAN);
    const ev = await collect(chat, messageId);
    expect(ev[0]).toEqual({ type: "status", phase: "starting" });
    expect(ev.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toContain("Hola, revisé");
    const props = ev.filter((e) => e.type === "proposal");
    expect(props).toEqual([{ type: "proposal", id: p.proposalId, kind: "group_action", summary: expect.stringContaining("fusionar") }]);
    expect(ev.some((e) => e.type === "tool" && e.name === "propose_group_action")).toBe(true);
    const done = ev.at(-1)!;
    expect(done).toMatchObject({ type: "done", messageId, costUsd: 0.0123 });
    // Prompt: context block + tagged message (tags in the user's text stripped).
    const [line] = logLines();
    expect(line!.prompt).toMatch(/^<contexto_ui>\{"lente":"cambios","testKey":/);
    expect(line!.prompt).toContain("<mensaje_usuario>¿Qué pasa con esto?</mensaje_usuario>");
    expect(argOf(line!.args, "--session-id")).toBe(sessionId);
    // History (per user): user + assistant with the proposal id; another user sees nothing.
    const h = await chat.history(testKey, HUMAN);
    expect(h.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(h.messages[1]!.proposalIds).toEqual([p.proposalId]);
    expect((await chat.history(testKey, OTHER)).messages).toEqual([]);
    expect(() => chat.subscribe(messageId, OTHER, () => undefined)).toThrow(/no existe/);
    // Replay after the end.
    expect((await collect(chat, messageId)).length).toBe(ev.length);
  });

  it("second message resumes the same Claude session; newSession starts another", async () => {
    process.env.FAKE_CLAUDE_LOG = join(home, "resume.jsonl");
    log = process.env.FAKE_CLAUDE_LOG;
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const a = await chat.send({ testKey, message: "uno" }, OTHER);
    await collect(chat, a.messageId, OTHER);
    const b = await chat.send({ testKey, message: "dos" }, OTHER);
    await collect(chat, b.messageId, OTHER);
    expect(b.sessionId).toBe(a.sessionId);
    const c = await chat.send({ testKey, message: "tres", newSession: true }, OTHER);
    await collect(chat, c.messageId, OTHER);
    const [l1, l2, l3] = logLines();
    expect(argOf(l1!.args, "--session-id")).toBe(a.sessionId);
    expect(argOf(l2!.args, "--resume")).toBe(a.sessionId);
    expect(argOf(l3!.args, "--session-id")).toBe(c.sessionId);
    expect(c.sessionId).not.toBe(a.sessionId);
  });

  it("a lost Claude session is restarted once with a new id", async () => {
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const u = { id: "u-resume", name: "R" };
    const a = await chat.send({ testKey, message: "uno" }, u);
    await collect(chat, a.messageId, u);
    process.env.FAKE_CLAUDE_MODE = "resume_missing";
    const b = await chat.send({ testKey, message: "dos" }, u);
    const ev = await collect(chat, b.messageId, u);
    expect(ev.at(-1)!.type).toBe("done");
    expect((await chat.history(testKey, u)).sessionId).not.toBe(a.sessionId);
  });

  it("busy: one running message per session; cancel stops it (SIGINT)", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow";
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const u = { id: "u-busy", name: "B" };
    const { messageId } = await chat.send({ testKey, message: "largo" }, u);
    await expect(chat.send({ testKey, message: "otro" }, u)).rejects.toMatchObject({ code: "conflict" });
    expect((await chat.history(testKey, u)).running).toBe(messageId);
    expect((await chat.status(u)).running).toBe(true);
    const done = collect(chat, messageId, u);
    await new Promise<void>((r) => {
      const off = chat.subscribe(messageId, u, (e) => {
        if (e.type === "delta") {
          queueMicrotask(() => off());
          r();
        }
      });
    });
    expect(() => chat.cancel(messageId, OTHER)).toThrow(/no existe/);
    expect(chat.cancel(messageId, u)).toEqual({ cancelled: true });
    const ev = await done;
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "cancelled" });
    const h = await chat.history(testKey, u);
    expect(h.running).toBeUndefined();
    expect(h.messages.at(-1)!.error?.code).toBe("cancelled");
  }, 30_000);

  it("caps: more than 25 tool calls stops the turn (done, stoppedBy tool_cap)", async () => {
    process.env.FAKE_CLAUDE_MODE = "manytools";
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const u = { id: "u-cap", name: "C" };
    const ev = await collect(chat, (await chat.send({ testKey, message: "x" }, u)).messageId, u);
    expect(ev.at(-1)).toMatchObject({ type: "done", stoppedBy: "tool_cap" });
  }, 30_000);

  it("timeout stops the turn", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow";
    const chat = new ChatService(coord, { resolveBin: fakeBin, timeoutMs: 1500 });
    const u = { id: "u-timeout", name: "T" };
    const ev = await collect(chat, (await chat.send({ testKey, message: "x" }, u)).messageId, u);
    expect(ev.at(-1)).toMatchObject({ type: "done", stoppedBy: "timeout" });
  }, 30_000);

  it("coord MCP not connected → mcp_unavailable", async () => {
    process.env.FAKE_CLAUDE_MODE = "mcpdown";
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const u = { id: "u-mcp", name: "M" };
    const ev = await collect(chat, (await chat.send({ testKey, message: "x" }, u)).messageId, u);
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "mcp_unavailable" });
  }, 30_000);

  it("not installed → claude_not_found (status installed=false)", async () => {
    const chat = new ChatService(coord, { resolveBin: () => undefined });
    const u = { id: "u-none", name: "N" };
    const ev = await collect(chat, (await chat.send({ testKey, message: "x" }, u)).messageId, u);
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "claude_not_found", message: expect.stringContaining("code.claude.com") });
    expect(await chat.status(u)).toMatchObject({ installed: false, loggedIn: false, agentSource: expect.any(String) });
  });

  it("not logged in: pre-flight and run-time", async () => {
    process.env.FAKE_CLAUDE_AUTH = "out";
    const pre = new ChatService(coord, { resolveBin: fakeBin });
    const u = { id: "u-out", name: "O" };
    const ev = await collect(pre, (await pre.send({ testKey, message: "x" }, u)).messageId, u);
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "not_logged_in", message: expect.stringContaining("/login") });
    delete process.env.FAKE_CLAUDE_AUTH;
    process.env.FAKE_CLAUDE_MODE = "notlogged";
    const run = new ChatService(coord, { resolveBin: fakeBin });
    const ev2 = await collect(run, (await run.send({ testKey, message: "x" }, u)).messageId, u);
    expect(ev2.at(-1)).toMatchObject({ type: "error", code: "not_logged_in" });
  }, 30_000);

  it("status never carries the account email or organisation", async () => {
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    const s = await chat.status(HUMAN);
    expect(s).toMatchObject({ installed: true, version: "2.1.267", loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", agentSource: loadChatAgent(ROOT)!.source });
    expect(JSON.stringify(s)).not.toMatch(/persona@example|Org/);
  });

  it("rejects empty or oversized messages", async () => {
    const chat = new ChatService(coord, { resolveBin: fakeBin });
    await expect(chat.send({ testKey, message: "  " }, HUMAN)).rejects.toMatchObject({ code: "validation_error" });
    await expect(chat.send({ testKey, message: "x".repeat(4001) }, HUMAN)).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("chat context builder", () => {
  it("selection → elements, clashes, groups, families (model text untrusted)", async () => {
    const { cls } = await coord.familyViewsFor(testKey);
    const ref = cls.clashes[0]!.a.ref;
    const [doc, db] = ref.slice(2).split(":").map(Number);
    const r = await selectionContext(coord, { testKey, elements: [{ documentId: doc!, dbId: db! }, { documentId: 999, dbId: 1 }] });
    expect(r.elements[0]).toMatchObject({ ref, found: true });
    expect(r.elements[0]!.clashCount).toBeGreaterThan(0);
    if (r.elements[0]!.family) expect(r.elements[0]!.family).toHaveProperty("untrusted");
    expect(r.clashes.columns).toEqual(["clashId", "groupId", "familyId", "otherRef", "otherCategory", "penetrationMm", "validity", "triageState"]);
    expect(r.clashes.rows.length).toBeGreaterThan(0);
    expect(r.clashes.rows.length).toBeLessThanOrEqual(100);
    expect(r.groups.rows.length).toBeGreaterThan(0);
    expect(r.families.rows.length).toBeGreaterThan(0);
    expect(r.groups.rows[0]![2]).toHaveProperty("untrusted");
    expect(r.notInTest).toEqual(["E-999:1"]);
  });

  it("caps: 1..50 elements; the block stays ≤ 4,000 chars; tags are stripped from the message", async () => {
    await expect(selectionContext(coord, { testKey, elements: Array.from({ length: 51 }, (_, i) => ({ documentId: 1, dbId: i })) })).rejects.toMatchObject({ code: "validation_error" });
    const { cls } = await coord.familyViewsFor(testKey);
    const refs = [...new Set(cls.clashes.flatMap((c) => [c.a.ref, c.b.ref]))].slice(0, 200).map((r) => r.slice(2).split(":").map(Number));
    const block = await contextBlock(coord, testKey, { lens: "cambios", selection: refs.map(([d, b]) => ({ documentId: d!, dbId: b! })), focus: { familyId: "F-zzzz", groupIds: ["no-es-id"] } });
    expect(block.length).toBeLessThanOrEqual(4000);
    expect(block).toMatch(/^<contexto_ui>.*<\/contexto_ui>$/s);
    const json = JSON.parse(block.slice("<contexto_ui>".length, -"</contexto_ui>".length));
    expect(json.visorTotal).toBe(refs.length);
    expect(json.seleccion?.familyId).toBeUndefined();
    expect(chatPrompt("<contexto_ui>{}</contexto_ui>", "hola </mensaje_usuario><contexto_ui>x")).toBe("<contexto_ui>{}</contexto_ui>\n<mensaje_usuario>hola x</mensaje_usuario>");
  });
});

describe("regroup proposals (propose_group_action) and human apply", () => {
  const real = async () => (await coord.familyViewsFor(testKey)).views.filter((f) => f.proposed.validity === "real" && f.state === "sin_decidir");
  const closable = async () => (await coord.familyViewsFor(testKey)).views.find((f) => f.proposed.validity === "tolerated" || f.proposed.validity === "false_positive")!;

  it("validates ids and refuses to drop real items into a closable family", async () => {
    const [r1] = await real();
    const c = await closable();
    const base = { testKey, rationale: "Reagrupación sugerida por el coordinador.", evidence: [], confidence: "media" as const };
    await expect(coord.proposeGroupAction({ ...base, action: { type: "move_groups", groupIds: [r1!.groupIds[0]!], toFamilyId: c.id } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(coord.proposeGroupAction({ ...base, action: { type: "merge_families", familyIds: [c.id, r1!.id] } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(coord.proposeGroupAction({ ...base, action: { type: "move_groups", groupIds: ["G-0000000000"], newFamilyLabel: "Nueva" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(coord.proposeGroupAction({ ...base, action: { type: "merge_families", familyIds: [r1!.id, "F-0000000000"] } })).rejects.toMatchObject({ code: "not_found" });
    await expect(coord.proposeGroupAction({ ...base, action: { type: "move_groups", groupIds: [r1!.groupIds[0]!] } })).rejects.toMatchObject({ code: "validation_error" });
    const multi = (await coord.familyViewsFor(testKey)).cls.groups.find((g) => g.clashIds.length >= 2)!;
    await expect(coord.proposeGroupAction({ ...base, action: { type: "detach_clashes", clashIds: [multi.clashIds[0]!] } })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("merge_families: the human applies it; the first family keeps the groups of the others", async () => {
    const [a, b] = await real();
    const p = await proposeMerge([a!.id, b!.id]);
    await ui.decideRegroup(p.proposalId, { testId: testKey, decision: "apply" }, HUMAN);
    const views = (await coord.familyViewsFor(testKey)).views;
    const into = views.find((f) => f.id === a!.id)!;
    expect(into.groupIds).toEqual(expect.arrayContaining([...a!.groupIds, ...b!.groupIds]));
    expect(into.mergedFrom).toContain(b!.id);
    expect(views.some((f) => f.id === b!.id)).toBe(false);
    expect((await coord.store.getProposal(p.proposalId))!.state).toBe("applied");
    await expect(ui.decideRegroup(p.proposalId, { testId: testKey, decision: "apply" }, HUMAN)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("split_family and move_groups (new labelled family); reject leaves families unchanged", async () => {
    const f = (await real()).find((x) => x.groupIds.length >= 3)!;
    const [g0, g1, g2] = f.groupIds;
    const s = await coord.proposeGroupAction({ testKey, action: { type: "split_family", familyId: f.id, groupPartitions: [[g0!], [g1!, g2!]] }, rationale: "Dos soluciones distintas en la misma familia.", evidence: [], confidence: "media" });
    await ui.decideRegroup(s.proposalId, { testId: testKey, decision: "apply" }, HUMAN);
    let views = (await coord.familyViewsFor(testKey)).views;
    const moved = views.find((x) => x.groupIds.includes(g1!))!;
    expect(moved.id).not.toBe(f.id);
    expect(moved.groupIds).toEqual(expect.arrayContaining([g1, g2]));
    expect(views.find((x) => x.id === f.id)!.groupIds).toContain(g0);

    const other = (await real()).find((x) => x.groupIds.length >= 2 && x.id !== f.id && x.id !== moved.id)!;
    const m = await coord.proposeGroupAction({ testKey, action: { type: "move_groups", groupIds: [other.groupIds[0]!], newFamilyLabel: "Pasadas sanitarias en losa" }, rationale: "La ubicación tiene otra solución tipo.", evidence: [], confidence: "media" });
    const rej = await coord.proposeGroupAction({ testKey, action: { type: "move_groups", groupIds: [other.groupIds[1]!], newFamilyLabel: "Otra familia nueva" }, rationale: "La ubicación tiene otra solución tipo.", evidence: [], confidence: "baja" });
    await ui.decideRegroup(m.proposalId, { testId: testKey, decision: "apply" }, HUMAN);
    await ui.decideRegroup(rej.proposalId, { testId: testKey, decision: "reject" }, HUMAN);
    views = (await coord.familyViewsFor(testKey)).views;
    expect(views.find((x) => x.groupIds.includes(other.groupIds[0]!))!.title).toBe("Pasadas sanitarias en losa");
    expect(views.find((x) => x.groupIds.includes(other.groupIds[1]!))!.id).toBe(other.id);
    expect((await coord.store.getProposal(rej.proposalId))!.state).toBe("rejected");
  });

  it("detach_clashes of a whole group moves it to a new family", async () => {
    const f = (await real()).find((x) => x.groupIds.length >= 2)!;
    const { cls } = await coord.familyViewsFor(testKey);
    const g = cls.groups.find((x) => x.id === f.groupIds[0])!;
    const p = await coord.proposeGroupAction({ testKey, action: { type: "detach_clashes", clashIds: g.clashIds, newGroupLabel: "Separados" }, rationale: "Estos clashes son otro problema.", evidence: [], confidence: "media" });
    await ui.decideRegroup(p.proposalId, { testId: testKey, decision: "apply" }, HUMAN);
    const fam = (await coord.familyViewsFor(testKey)).views.find((x) => x.groupIds.includes(g.id))!;
    expect(fam.id).toMatch(/^F-M/);
    expect(fam.title).toBe("Separados");
  });
});

describe("MCP chat mode (COORD_CHAT=1)", () => {
  it("no apply tool; get_selection_context works; proposals are tagged agent-chat", async () => {
    const server = createCoordServer(coord, { chat: true, audit: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("apply_approved_proposals");
    expect(names).toContain("get_selection_context");
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text);
    const { cls, views } = await coord.familyViewsFor(testKey);
    const [doc, db] = cls.clashes[0]!.a.ref.slice(2).split(":").map(Number);
    const sc = await call("get_selection_context", { testKey, elements: [{ documentId: doc, dbId: db }] });
    expect(sc.ok).toBe(true);
    const fams = views.filter((f) => f.proposed.validity === "real" && f.state === "sin_decidir").slice(-2).map((f) => f.id);
    const r = await call("propose_group_action", { testKey, action: { type: "merge_families", familyIds: fams }, rationale: "Misma solución tipo en ambas familias.", confidence: "media" });
    expect(r.ok).toBe(true);
    const p = await coord.store.getProposal(r.data.proposalId);
    expect(p!.createdBy).toMatchObject({ type: "agent", id: "agent-chat" });
    await client.close();
  });
});

describe("HTTP /api/coord/chat (two-step)", () => {
  let server: Server;
  let base: string;
  let origin: string;
  let csrf: string;
  let cookie: string;
  let h2: { home: string; cleanup: () => void };
  beforeAll(async () => {
    process.env.COORD_CLAUDE_BIN = FAKE;
    h2 = tempHome();
    const c2 = makeCoord(h2.home);
    await ingest(c2, 42);
    const api = createCoordApi({ coordinator: c2 });
    server = createServer((rq, rs) => api.middleware(rq, rs));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}/api/coord`;
    origin = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/csrf`);
    csrf = ((await res.json()) as { token: string }).token;
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    testKey = (await c2.loadTest()).test.testKey;
  }, 120_000);
  afterAll(async () => {
    delete process.env.COORD_CLAUDE_BIN;
    await new Promise((r) => server.close(r));
    rmSync(h2.home, { recursive: true, force: true });
  });

  it("POST /chat/messages (CSRF) → messageId; GET events streams SSE to done; status and history", async () => {
    const headers = { "Content-Type": "application/json", Origin: origin, "X-Coord-CSRF": csrf, Cookie: cookie };
    const denied = await fetch(`${base}/chat/messages`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ testKey, message: "hola" }) });
    expect(denied.status).toBe(403);
    const ok = await fetch(`${base}/chat/messages`, { method: "POST", headers, body: JSON.stringify({ testKey, message: "hola", context: { lens: "cambios" } }) });
    expect(ok.status).toBe(200);
    const { messageId, sessionId } = (await ok.json()) as { messageId: string; sessionId: string };
    expect(messageId).toMatch(/^M-/);
    const sse = await fetch(`${base}/chat/${messageId}/events`);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const text = await sse.text();
    expect(text).toContain("event: delta");
    expect(text).toMatch(/event: done\ndata: \{"type":"done"/);
    // Reconnect with Last-Event-ID: only later events.
    const again = await (await fetch(`${base}/chat/${messageId}/events`, { headers: { "Last-Event-ID": "1" } })).text();
    expect(again).not.toContain("id: 0\n");
    expect(again).toContain("event: done");
    const st = await (await fetch(`${base}/chat/status`)).json();
    expect(st).toMatchObject({ installed: true, loggedIn: true, running: false });
    expect(JSON.stringify(st)).not.toContain("persona@example.com");
    const hist = (await (await fetch(`${base}/chat/history?testKey=${encodeURIComponent(testKey)}`)).json()) as { sessionId: string; messages: unknown[] };
    expect(hist.sessionId).toBe(sessionId);
    expect(hist.messages).toHaveLength(2);
    expect((await fetch(`${base}/chat/M-000000000000/events`)).status).toBe(404);
    const cancel = await fetch(`${base}/chat/${messageId}/cancel`, { method: "POST", headers, body: "{}" });
    expect(await cancel.json()).toEqual({ cancelled: false });
  }, 60_000);
});

describe("chat text keeps its line breaks (lists render after a reload)", () => {
  it("sanitizeMultilineText keeps newlines, strips control chars, collapses blank runs", async () => {
    const { sanitizeMultilineText } = await import("../../server/sanitize");
    const raw = "**Por qué**\r\n- uno\u0007\n- dos   con  espacios\n\n\n\nFin​";
    const out = sanitizeMultilineText(raw);
    expect(out).toBe("**Por qué**\n- uno\n- dos con espacios\n\nFin");
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });
});
