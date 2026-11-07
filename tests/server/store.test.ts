import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, MAX_SUPPORTED_LEVEL } from "../../server/config";
import { Store } from "../../server/store";
import { canTransitionBatch, canTransitionProposal } from "../../server/store/state-machine";
import { withFileLock, writeJsonAtomic } from "../../server/store/fs";
import { tempHome } from "./helpers";

const homes: Array<() => void> = [];
afterEach(() => homes.splice(0).forEach((c) => c()));
function store(): Store {
  const t = tempHome();
  homes.push(t.cleanup);
  return new Store({ home: t.home });
}

const actor = { type: "agent" as const, id: "a", name: "Agente" };

describe("store atomicity and locking", () => {
  it("assigns unique sequential proposal ids under concurrency", async () => {
    const s = store();
    const ids = await Promise.all(Array.from({ length: 25 }, () => s.newProposalId()));
    expect(new Set(ids).size).toBe(25);
    for (const id of ids) expect(id).toMatch(/^P-\d{8}-\d{4}$/);
    expect(ids.map((i) => Number(i.slice(-4))).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("atomic JSON writes never leave temp files or torn content", async () => {
    const s = store();
    const file = s.path("x", "data.json");
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeJsonAtomic(file, { i, pad: "x".repeat(5000) })));
    const v = JSON.parse(await readFile(file, "utf8")) as { i: number; pad: string };
    expect(v.pad).toHaveLength(5000);
    expect((await readdir(s.path("x"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("the file lock serialises critical sections and is re-entrant", async () => {
    const s = store();
    const lock = s.path("state", "t.lock");
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withFileLock(lock, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await withFileLock(lock, async () => undefined); // re-entrant
          await new Promise((r) => setTimeout(r, 2));
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });

  it("takes over a stale lock left by a crashed process", async () => {
    const s = store();
    const lock = s.path("state", "store.lock");
    await writeJsonAtomic(lock, { pid: 99999, at: 0 });
    const { utimes } = await import("node:fs/promises");
    await utimes(lock, new Date(0), new Date(0));
    expect(await s.nextSeq("x")).toBe(1);
  });

  it("decisions are idempotent by id", async () => {
    const s = store();
    const d = { id: "dec-1", proposalId: "P-1", targetType: "group" as const, targetId: "G-1", testId: "T-1", modelSetId: "m", projectId: "p", kind: "accept" as const, changes: [], viewedInViewerMs: 0, decidedAt: "", userId: "u", userName: "U", receivedAt: "" };
    await s.appendDecisions([d, d]);
    await s.appendDecisions([d]);
    expect(await s.listDecisions()).toHaveLength(1);
  });
});

describe("proposal and batch state machines", () => {
  it("allows only the documented transitions", () => {
    expect(canTransitionProposal("draft", "pending_review")).toBe(true);
    expect(canTransitionProposal("pending_review", "approved")).toBe(true);
    expect(canTransitionProposal("pending_review", "applied")).toBe(false);
    expect(canTransitionProposal("approved", "applied")).toBe(true);
    expect(canTransitionProposal("rejected", "approved")).toBe(false);
    expect(canTransitionProposal("withdrawn", "pending_review")).toBe(false);
    expect(canTransitionProposal("applied", "failed")).toBe(false);
    expect(canTransitionBatch("ready", "approved")).toBe(true);
    expect(canTransitionBatch("draft", "approved")).toBe(false);
    expect(canTransitionBatch("applied", "draft")).toBe(false);
  });

  it("enforces transitions in the store and records history", async () => {
    const s = store();
    const p = await s.createProposal({
      kind: "classification",
      createdBy: actor,
      target: { groupIds: ["G-1"], clashIds: [] },
      payload: { kind: "classification", validity: "real", disagreesWithEngine: false },
      rationale: "x",
      evidence: [],
      confidence: "alta",
      risk: "medium",
      affectedClashes: 1,
    });
    expect(p.state).toBe("pending_review");
    await expect(s.transitionProposal(p.id, "applied", "x")).rejects.toThrow(/no puede pasar/);
    const a = await s.transitionProposal(p.id, "approved", "Camila");
    expect(a.history.map((h) => h.to)).toEqual(["pending_review", "approved"]);
    await expect(s.updateProposal(p.id, (x) => (x.state = "applied"))).rejects.toThrow();
  });
});

describe("hash-chained audit log", () => {
  it("verifies and detects tampering", async () => {
    const s = store();
    for (let i = 0; i < 5; i++) await s.audit({ actor, action: "proposal.created", projectId: "p", details: { i } });
    expect(await s.verifyAudit()).toEqual({ ok: true, events: 5 });
    const file = s.path("audit", "audit.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const ev = JSON.parse(lines[2]!);
    ev.details.i = 42;
    lines[2] = JSON.stringify(ev);
    await writeFile(file, lines.join("\n") + "\n");
    expect(await s.verifyAudit()).toMatchObject({ ok: false, brokenAt: 3 });
  });
});

describe("config", () => {
  it("hard-caps autonomy at L1 whatever the files say", async () => {
    const t = tempHome();
    homes.push(t.cleanup);
    await writeFile(join(t.home, "coordinator.config.json"), JSON.stringify({ autonomy: { level: 3 } }));
    await writeFile(join(t.home, "coordinator.config.local.json"), JSON.stringify({ language: "en" }));
    const c = loadConfig(t.home, {});
    expect(c.configuredLevel).toBe(3);
    expect(c.effectiveLevel).toBe(MAX_SUPPORTED_LEVEL);
    expect(MAX_SUPPORTED_LEVEL).toBe(1);
    expect(c.config.language).toBe("en");
    expect(c.sources).toEqual(["coordinator.config.json", "coordinator.config.local.json"]);
  });

  it("falls back to the server template when the committed config is absent", () => {
    const t = tempHome();
    homes.push(t.cleanup);
    const c = loadConfig(t.home, {});
    expect(c.sources).toEqual(["server/templates/coordinator.config.json"]);
    expect(c.effectiveLevel).toBe(1);
    expect(c.config.classification.llmMayClose).toEqual(["close_not_issue", "mark_reviewed"]);
  });

  it("local file overrides deep-merge and L0 is respected", async () => {
    const t = tempHome();
    homes.push(t.cleanup);
    await writeFile(join(t.home, "coordinator.config.json"), JSON.stringify({ autonomy: { level: 1, approvalExpiryDays: 7 } }));
    await writeFile(join(t.home, "coordinator.config.local.json"), JSON.stringify({ autonomy: { level: 0 } }));
    const c = loadConfig(t.home, {});
    expect(c.effectiveLevel).toBe(0);
    expect(c.config.autonomy.approvalExpiryDays).toBe(7);
  });
});
