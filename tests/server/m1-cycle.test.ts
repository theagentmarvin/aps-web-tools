/**
 * M1 (docs/PLAN-core-features-simplified.md §3): X1 ACC sync, X6 scope guard, "Qué cambió".
 * Fixtures: tests/fixtures/mc/v41|v42/acc-groups.json (ACC assigned/closed groups).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffTestVersions } from "../../core/ingest";
import { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { detectScopeChanges, outOfScopePredicate } from "../../server/cycle";
import { FixtureSource } from "../../server/source/fixtures";
import { doc } from "../engine/helpers";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, ROOT, tempHome, testConfig } from "./helpers";

const P = "demo-proyecto";
const RDB = ["41299469584418", "41299469592337", "41299469600256", "41299469608175"];
const TOL = ["41299471191975", "41299471199894", "41299471223651"];
const TRAY = ["41299470415913", "41299470431751", "41299470471346"];
const ISSUE1 = "0b6c1f00-0000-4000-8000-00000000i001";

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

describe("X1 ACC sync", () => {
  it("projects ACC-assigned/closed state on groups, families and the payload; ACC-decided clashes are never re-proposed", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    expect(tri.accSync).toMatchObject({ assignedGroups: 6, closedGroups: 1, issues: 6 });
    const byClash = new Map(tri.groups.flatMap((g) => g.clashIds.map((c) => [c.replace(/^C-/, ""), g] as const)));
    const g1 = byClash.get(RDB[0]!)!;
    expect(g1.acc).toMatchObject({ status: "assigned", issueIds: [ISSUE1] });
    expect(g1.acc!.existing).toBeGreaterThan(0);
    expect(g1.acc!.resolved).toBe(1);
    const gt = byClash.get(TOL[0]!)!;
    expect(gt.acc).toMatchObject({ status: "closed", closedReason: "MINIMAL_OVERLAP" });
    // never re-proposed: a group fully decided in ACC has no action and no draft
    const props = (await ui.proposals(k42, undefined, 1000)).items;
    for (const g of tri.groups.filter((x) => x.acc && x.acc.existing === x.clashIds.length)) {
      const p = props.find((x) => x.targetId === g.id)!;
      expect(p.fields.action.value).toEqual({ createIssue: false, setStatus: null });
      expect(p.issueDraft).toBeUndefined();
    }
    // families aggregate it
    const fam = tri.families!.find((f) => f.groupIds.includes(g1.id))!;
    expect(fam.acc?.issueIds).toContain(ISSUE1);
    expect(fam.instances.find((i) => i.groupId === g1.id)!.acc?.status).toBe("assigned");
    // batches: accept every group; no ACC-decided clash is in any item
    const decided = new Set([...RDB, ...TOL, ...TRAY, "41299469806150", "41299469798231"]);
    const { acceptGroups } = await import("./helpers");
    const touched = tri.groups.filter((g) => g.clashIds.some((c) => decided.has(c.replace(/^C-/, ""))));
    await acceptGroups(ui, k42, [...touched, ...tri.groups.filter((g) => !touched.includes(g)).slice(0, 5)].map((g) => g.id));
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    for (const i of b.items) for (const t of i.targetIds) expect(decided.has(t.replace(/^C-/, ""))).toBe(false);
  }, 60_000);

  it("wiping .coordinator/ledgers and re-ingesting reproduces the same ACC-decided state", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const snap = async () => {
      const t = await ui.triage(P, MODEL_SET_ID, k42);
      return { sync: { ...t.accSync, at: "" }, groups: t.groups.filter((g) => g.acc).map((g) => [g.id, g.acc]).sort() };
    };
    const before = await snap();
    expect(before.groups.length).toBeGreaterThan(0);
    rmSync(coord.store.path("ledgers"), { recursive: true, force: true });
    expect(await coord.ledger.load(`b.${P}`, MODEL_SET_ID)).toBeUndefined();
    await coord.ingest({ projectId: P, modelSetId: MODEL_SET_ID, testId: (await coord.store.getTest(k42))!.testId });
    expect(await snap()).toEqual(before);
  });
});

describe("X6 scope guard", () => {
  it("pure: removed / replaced / added documents and the view change; resolved → out_of_scope only for affected documents", () => {
    const d = (id: number, name: string, lin: string, view = "{3D}") => ({ ...doc(id, name), lineageUrn: lin, viewableName: view });
    const prevDocs = [d(0, "A.rvt", "lin-a"), d(1, "B.rvt", "lin-b"), d(2, "C.rvt", "lin-c")];
    const nextDocs = [d(5, "A.rvt", "lin-a"), d(6, "C.rvt", "lin-c2"), d(7, "D.rvt", "lin-d")];
    const mk = (id: string, l: number, r: number) => ({ id, left: { documentId: l, objectId: 1, viewerDbId: 1 }, right: { documentId: r, objectId: 2, viewerDbId: 2 } });
    const prevClashes = [mk("1", 0, 1), mk("2", 0, 2), mk("3", 0, 0)] as never[];
    const prelim = { resolved: ["1", "2", "3"], element_deleted: [] };
    const s = detectScopeChanges({ viewName: "V", documents: prevDocs as never, clashes: prevClashes }, { viewName: "V", documents: nextDocs as never }, prelim);
    expect(s.changes.map((c) => [c.kind, c.fileName])).toEqual([
      ["document_removed", "B.rvt"],
      ["model_replaced", "C.rvt"],
      ["document_added", "D.rvt"],
    ]);
    expect([...s.affectedPrevDocs].sort()).toEqual([1, 2]);
    const diff = diffTestVersions(prevClashes as never, [], { outOfScope: outOfScopePredicate(s.affectedPrevDocs) });
    expect(diff.out_of_scope.sort()).toEqual(["1", "2"]);
    expect(diff.resolved).toEqual(["3"]);
    const view = detectScopeChanges({ viewName: "V1", documents: prevDocs as never, clashes: [] }, { viewName: "V2", documents: prevDocs as never }, { resolved: [], element_deleted: [] });
    expect(view.changes.map((c) => c.kind)).toEqual(["test_config_changed"]);
    expect(view.affectedPrevDocs.size).toBe(3);
  });

  it("removing one document from the fixture produces 0 resolved for its clashes (server path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-x6-"));
    try {
      cpSync(join(ROOT, "tests", "fixtures"), dir, { recursive: true });
      const v42 = join(dir, "mc", "v42");
      const REMOVED = 5; // PRJ-ELE-MOD-001.rvt
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

      const c = new Coordinator({ root: ROOT, home, dataSource: "fixtures", source: new FixtureSource({ home, dir }), config: testConfig() });
      await ingest(c, 41);
      const k42 = await ingest(c, 42);
      const test = (await c.store.getTest(k42))!;
      const scope = await c.scopeChangesFor(test);
      expect(scope.map((s) => [s.kind, s.fileName])).toContainEqual(["document_removed", "PRJ-ELE-MOD-001.rvt"]);
      const diff = (await c.diffForTest(test))!;
      const raw41 = await c.loadRaw((await c.store.getTest(test.previousTestKey!))!);
      const touches = new Set(raw41.clashes.filter((x) => x.left.documentId === REMOVED || x.right.documentId === REMOVED).map((x) => x.id));
      expect(touches.size).toBeGreaterThan(0);
      expect([...diff.resolved, ...diff.element_deleted].filter((id) => touches.has(id))).toEqual([]);
      expect(diff.out_of_scope.length).toBeGreaterThan(0);
      expect(diff.out_of_scope.filter((id) => !touches.has(id)), JSON.stringify(scope)).toEqual([]);
      const tri = await new CoordinatorUi(c).triage(P, MODEL_SET_ID, k42);
      expect(tri.scopeChanges!.some((s) => s.kind === "document_removed")).toBe(true);
      expect(tri.changeSummary!.outOfScope).toBe(diff.out_of_scope.length);
      expect(tri.changeSummary!.resolved).toBe(diff.resolved.length + diff.element_deleted.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Qué cambió", () => {
  it("pure: changed = |Δpenetration| > 10 mm or different element types; one word per item", async () => {
    const { clashChanges, itemChange } = await import("../../server/cycle");
    const side = (type: string) => ({ type, category: "X" }) as never;
    const cur = [
      { id: "1", penetrationMm: 50, a: side("T1"), b: side("T2") },
      { id: "2", penetrationMm: 50, a: side("T1"), b: side("T2") },
      { id: "3", penetrationMm: 50, a: side("T1"), b: side("T9") },
      { id: "4", penetrationMm: 5, a: side("T1"), b: side("T2") },
      { id: "5", penetrationMm: 5, a: side("T1"), b: side("T2") },
    ] as never[];
    const prev = new Map([
      ["1", { penetrationMm: 45, a: side("T1"), b: side("T2") }],
      ["2", { penetrationMm: 30, a: side("T1"), b: side("T2") }],
      ["3", { penetrationMm: 50, a: side("T1"), b: side("T2") }],
    ]) as never;
    const diff = { new: ["4"], persisting: ["1", "2", "3"], reappeared: ["5"], resolved: [], element_deleted: [], out_of_scope: [], matchedByPairKey: [], counts: {} } as never;
    const m = clashChanges(cur, diff, prev);
    expect([...m]).toEqual([["1", "unchanged"], ["2", "changed"], ["3", "changed"], ["4", "new"], ["5", "reappeared"]]);
    expect(itemChange(["1", "5"], m)).toBe("reappeared");
    expect(itemChange(["4"], m)).toBe("new");
    expect(itemChange(["1", "4"], m)).toBe("changed");
    expect(itemChange(["1"], m)).toBe("unchanged");
  });

  it("one change word per group and per family; summary consistent with the ledger diff", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const s = tri.changeSummary!;
    expect(s.previousVersion).toBe(41);
    expect(s.clashes.new).toBe(70);
    expect(s.clashes.reappeared).toBe(13);
    expect(s.clashes.changed + s.clashes.unchanged).toBe(220);
    expect(s.groups.new + s.groups.changed + s.groups.reappeared + s.groups.unchanged).toBe(tri.groups.length);
    for (const g of tri.groups) expect(["new", "changed", "reappeared", "unchanged"]).toContain(g.change);
    expect(tri.groups.filter((g) => g.change === "reappeared").length).toBe(s.groups.reappeared);
    for (const f of tri.families!) {
      const c = f.changeCounts!;
      expect(c.new + c.changed + c.reappeared + c.unchanged).toBe(f.instanceCount);
    }
    // first version: everything is new
    const t41 = await ui.triage(P, MODEL_SET_ID, (await coord.store.getTest(k42))!.previousTestKey!);
    expect(t41.changeSummary!.clashes.changed + t41.changeSummary!.clashes.unchanged).toBe(0);
    expect(t41.scopeChanges).toEqual([]);
  });
});
