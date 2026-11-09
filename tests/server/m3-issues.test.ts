/**
 * M3 (docs/PLAN-core-features-simplified.md §3 F2/F5): issue verification against the next run,
 * read-only against ACC. Fixtures: tests/fixtures/issues/issues.json + mc/v41|v42/acc-groups.json.
 *   i001 avance · i002 dice_resuelta (closed in ACC, clashes remain) · i003 resuelta (CLI model v3→v4)
 *   i004 displaced (an element of the resolved set clashes again in v42) · i005 stale model (INC v3→v3)
 *   i006 sigue_abierta in v41 and v42 (P1 → stuck for 2 cycles)
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Coordinator } from "../../server/coordinator";
import { Coordinator as CoordinatorClass } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { FixtureSource } from "../../server/source/fixtures";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, ROOT, tempHome, testConfig } from "./helpers";

const I = (n: number) => `0b6c1f00-0000-4000-8000-00000000i00${n}`;
let home: string;
let cleanup: () => void;
let coord: Coordinator;
let ui: CoordinatorUi;
beforeEach(() => {
  ({ home, cleanup } = tempHome());
  coord = makeCoord(home);
  ui = new CoordinatorUi(coord);
});
afterEach(() => cleanup());

async function cycle() {
  const k41 = await ingest(coord, 41);
  const c41 = await ui.issueChecks(k41); // records the v41 verdicts (stuck history)
  const k42 = await ingest(coord, 42);
  return { k41, k42, c41, c42: await ui.issueChecks(k42) };
}

describe("F2 verdicts", () => {
  it("one verdict per ACC issue with the checks that decide it", async () => {
    const { c41, c42 } = await cycle();
    const v = (id: string) => c42.checks.find((c) => c.issueId === id)!;
    expect(c42.checks).toHaveLength(6);
    expect(v(I(1))).toMatchObject({ verdict: "avance", existing: 4, resolved: 1, accStatus: "open", displayId: 101 });
    expect(v(I(1)).reason).toBe("Avance: quedan 4 de 5.");
    expect(v(I(2))).toMatchObject({ verdict: "dice_resuelta", existing: 3, accStatus: "closed", overdue: false });
    expect(v(I(3))).toMatchObject({ verdict: "resuelta", existing: 0, resolved: 2, checks: { displacement: "ok", modelAge: "ok", scope: "ok" }, discipline: "CLI" });
    expect(v(I(3)).groupIds.length).toBeGreaterThan(0); // the previous version's groups
    expect(v(I(4))).toMatchObject({ verdict: "no_verificable", checks: { displacement: "blocked" } });
    expect(v(I(4)).reason).toMatch(/vuelven a chocar/);
    expect(v(I(5))).toMatchObject({ verdict: "no_verificable", checks: { modelAge: "stale", displacement: "ok" }, discipline: "INC" });
    expect(v(I(5)).reason).toMatch(/INC no tiene una versión nueva/);
    expect(v(I(6))).toMatchObject({ verdict: "sigue_abierta", existing: 2, resolved: 0, stuckCycles: 2, stuck: true, priority: 1, overdue: true });
    expect(c42.counts).toEqual({ resuelta: 1, avance: 1, sigue_abierta: 1, dice_resuelta: 1, no_verificable: 2 });
    // ordering: contradictions first
    expect(c42.checks[0]!.verdict).toBe("dice_resuelta");
    // evidence is a template, ≤ 400 chars, Spanish
    for (const c of c42.checks) {
      expect(c.evidence.length).toBeLessThanOrEqual(400);
      expect(c.evidence).toMatch(/^v42: \d+ de \d+ interferencias siguen/);
    }
    // v41: everything still open (stuck history starts there)
    expect(c41.checks.find((c) => c.issueId === I(6))).toMatchObject({ verdict: "sigue_abierta", stuckCycles: 1, stuck: false });
  });

  it("MCP list_issue_checks: read-only rows with untrusted titles and filters", async () => {
    const { k42 } = await cycle();
    const all = await coord.listIssueChecks({ testKey: k42, limit: 50 });
    expect(all.rows).toHaveLength(6);
    expect(all.rows[0]![2]).toHaveProperty("untrusted");
    const stuck = await coord.listIssueChecks({ testKey: k42, stuckOnly: true, limit: 50 });
    expect(stuck.rows.map((r) => r[0])).toEqual([I(6)]);
    const dice = await coord.listIssueChecks({ testKey: k42, verdict: ["dice_resuelta"], limit: 50 });
    expect(dice.rows.map((r) => r[0])).toEqual([I(2)]);
  });

  it("scope freeze: a removed document makes its issue not verifiable (never resuelta)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-m3-"));
    try {
      cpSync(join(ROOT, "tests", "fixtures"), dir, { recursive: true });
      // Remove the CLI model (doc 2) from v42: i003's clashes become out of scope.
      const v42 = join(dir, "mc", "v42");
      const REMOVED = 2;
      const docs = JSON.parse(readFileSync(join(v42, "scope-version-document.json"), "utf8"));
      docs.documents = docs.documents.filter((x: { id: number }) => x.id !== REMOVED);
      writeFileSync(join(v42, "scope-version-document.json"), JSON.stringify(docs));
      const inst = JSON.parse(readFileSync(join(v42, "scope-version-clash-instance.json"), "utf8"));
      const dropped = new Set<number>(inst.instances.filter((i: { ldid: number; rdid: number }) => i.ldid === REMOVED || i.rdid === REMOVED).map((i: { cid: number }) => i.cid));
      inst.instances = inst.instances.filter((i: { cid: number }) => !dropped.has(i.cid));
      writeFileSync(join(v42, "scope-version-clash-instance.json"), JSON.stringify(inst));
      const cl = JSON.parse(readFileSync(join(v42, "scope-version-clash.json"), "utf8"));
      cl.clashes = cl.clashes.filter((c: { id: number }) => !dropped.has(c.id));
      writeFileSync(join(v42, "scope-version-clash.json"), JSON.stringify(cl));
      const c = new CoordinatorClass({ root: ROOT, home, dataSource: "fixtures", source: new FixtureSource({ home, dir }), config: testConfig() });
      await ingest(c, 41);
      const k42 = await ingest(c, 42);
      const checks = await c.issueChecksFor(k42);
      const i3 = checks.checks.find((x) => x.issueId === I(3))!;
      expect(i3.checks.scope).toBe("out_of_scope");
      expect(i3.verdict).toBe("no_verificable");
      expect(i3.reason).toMatch(/alcance/);
      expect(checks.counts.resuelta).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F5 reminders", () => {
  it("one template text per discipline: contradictions and overdue first, no person names, no resuelta", async () => {
    const { k42 } = await cycle();
    const rs = await ui.reminders(k42);
    expect(rs.length).toBeGreaterThan(0);
    const all = rs.flatMap((r) => r.issueIds);
    expect(all).not.toContain(I(3)); // resuelta: nothing to remind
    expect(all).toContain(I(2));
    const r2 = rs.find((r) => r.issueIds.includes(I(2)))!;
    expect(r2.text).toMatch(/^Recordatorio [A-Z]+ — coordinación v42/);
    expect(r2.text.indexOf("Marcadas resueltas")).toBeLessThan(r2.text.indexOf("Por favor"));
    expect(r2.counts.diceResuelta).toBe(1);
    const r6 = rs.find((r) => r.issueIds.includes(I(6)))!;
    expect(r6.text).toMatch(/Vencidas:/);
    for (const r of rs) {
      expect(r.text).not.toMatch(/Camila|Rojas|@/);
      expect(r.text).toMatch(/#10\d/);
    }
  });
});

describe("verdict decisions and the M5 gate", () => {
  it("accept / reject (V codes) are stored per cycle; the gate needs 2 cycles ≥ 90 %", async () => {
    const { k41, k42 } = await cycle();
    await expect(ui.decideIssueVerdict(k42, I(3), { decision: "reject" }, HUMAN)).rejects.toThrow(/reasonCode/);
    const c = await ui.decideIssueVerdict(k42, I(3), { decision: "accept" }, HUMAN);
    expect(c.decision).toMatchObject({ kind: "accept", decidedBy: HUMAN.name });
    await ui.decideIssueVerdict(k42, I(2), { decision: "accept", note: "a la reunión" }, HUMAN);
    // recorded as a decision with targetType issue (not part of the triage decisions)
    const recs = (await coord.store.listDecisions()).filter((d) => d.targetType === "issue");
    expect(recs.map((d) => d.targetId).sort()).toEqual([I(2), I(3)]);
    expect((await ui.listDecisions({ testId: k42 })).items.some((d) => (d.targetId as string) === I(3))).toBe(false);
    let gate = await ui.issueGate("demo-proyecto", MODEL_SET_ID);
    expect(gate).toMatchObject({ cycles: 1, acceptedUnchangedPct: 100, ready: false });
    // a second cycle with a rejected resuelta (V03)
    await coord.issueChecks.mutate(`b.demo-proyecto`, MODEL_SET_ID, (f) => {
      f.decisions["41"] = { [I(9)]: { verdict: "resuelta", kind: "reject", reasonCode: "V03", decidedBy: HUMAN.name, decidedAt: new Date().toISOString(), testKey: k41 } };
      return true;
    });
    gate = await ui.issueGate("demo-proyecto", MODEL_SET_ID);
    expect(gate.cycles).toBe(2);
    expect(gate.acceptedUnchangedPct).toBe(50);
    expect(gate.ready).toBe(false);
    expect(gate.perCycle.map((p) => p.version)).toEqual([41, 42]);
  });
});
