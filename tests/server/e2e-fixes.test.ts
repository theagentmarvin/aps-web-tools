/** Regressions for the server bugs found by the UI end-to-end run. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { runEngine } from "../../server/engine";
import { acceptGroups, HUMAN, ingest, makeCoord, MODEL_SET_ID, ROOT, tempHome, testConfig, TEST_V42 } from "./helpers";

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

describe("UI e2e regressions", () => {
  it("1. GET /projects counts model sets from the source, even before any ingest", async () => {
    const [p] = await ui.projects();
    expect(p!.modelSetCount).toBe(1);
  });

  it("2. statusTransitions only count status changes; issue effects are reported separately", async () => {
    const key = await ingest(coord, 42);
    const views = (await ui.proposals(key, undefined, 1000)).items;
    const close = views.filter((v) => v.fields.action.value.setStatus === "closed" && !v.fields.action.value.createIssue).slice(0, 2);
    const issue = views.filter((v) => v.fields.action.value.createIssue).slice(0, 2);
    await acceptGroups(ui, key, [...close, ...issue].map((v) => v.targetId));
    const b = await ui.sendToApproval({ projectId: "demo-proyecto", modelSetId: MODEL_SET_ID, testId: key }, HUMAN);
    const sum = b.statusTransitions.reduce((n, t) => n + t.count, 0);
    expect(sum).toBe(b.counts.statusChanges);
    expect(b.statusTransitions.every((t) => t.to === "closed")).toBe(true);
    expect(b.issueEffects.issues).toBe(b.counts.issuesCreate);
    expect(b.issueEffects.clashesLinked).toBeGreaterThan(0);
    expect(b.review.humanReviewedPct).toBeGreaterThanOrEqual(0);
    expect(b.review.humanReviewedPct).toBeLessThanOrEqual(100);
  });

  it("4. the rationale and the issue draft use the same deterministic representative clash", async () => {
    const key = await ingest(coord, 42);
    const { cls } = await coord.requireClassified(key);
    const byId = new Map(cls.clashes.map((c) => [c.id, c]));
    const views = (await ui.proposals(key, undefined, 1000)).items;
    let checked = 0;
    for (const g of cls.groups) {
      expect(g.representativeClashId && g.clashIds.includes(g.representativeClashId)).toBe(true);
      expect(g.rationale).toBe(byId.get(g.representativeClashId!)!.rationale);
      const v = views.find((x) => x.targetId === g.id)!;
      const vp = (v.issueDraft as { viewpointClashId?: string } | undefined)?.viewpointClashId;
      if (v.issueDraft) {
        expect(vp).toBe(g.representativeClashId);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    // G-8efa2e317d (the group from the UI report), when present with the current rules.
    const g = cls.groups.find((x) => x.id === "G-8efa2e317d");
    if (g) expect(views.find((x) => x.targetId === g.id)!.rationale).toBe(g.rationale);

    // Deterministic: same representatives with the input order reversed.
    const t = (await coord.loadTest(key)).test;
    const raw = await coord.loadRaw(t);
    const a = runEngine({ ...raw, config: coord.config });
    const b = runEngine({ clashes: [...raw.clashes].reverse(), elements: [...raw.elements].reverse(), documents: raw.documents, config: coord.config });
    const repA = new Map(a.groups.map((x) => [x.id, x.representativeClashId]));
    for (const x of b.groups) expect(x.representativeClashId).toBe(repA.get(x.id));
  });

  it("5. audit events carry the test key as testId and the ACC id as accTestId", async () => {
    const key = await ingest(coord, 42);
    const ev = await coord.store.listAudit();
    for (const action of ["test.ingested", "classification.run"]) {
      const e = ev.find((x) => x.action === action)!;
      expect(e.testId).toBe(key);
      expect(e.accTestId).toBe(TEST_V42);
    }
  });

  it("6. rules updatedAt is the rules file mtime; issuesClosed is gone", async () => {
    const rules = await ui.rules();
    expect(rules[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const r = await ui.report({});
    expect("issuesClosed" in r.kpis).toBe(false);
  });

  it("7. ledger: fixtures v41→v42 yields exactly the 13 reappeared clashes, tagged regresion end to end", async () => {
    const truth = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "fixture-truth.json"), "utf8")) as { expectedDiff: Record<string, string[]> };
    const expected = [...truth.expectedDiff.reappeared!].sort();
    expect(expected).toHaveLength(13);
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const test42 = (await coord.loadTest(k42)).test;
    const diff = (await coord.diffForTest(test42))!;
    expect([...diff.reappeared].sort()).toEqual(expected);
    expect([...diff.element_deleted].sort()).toEqual([...truth.expectedDiff.element_deleted!].sort());
    expect([...diff.new].sort()).toEqual([...truth.expectedDiff.new!].sort());

    // Persisted ledger (seeded with v40 in fixtures mode), idempotent on re-ingest.
    await coord.ingest({ projectId: "b.demo-proyecto", modelSetId: MODEL_SET_ID, testId: TEST_V42, refresh: true });
    const ledger = (await coord.ledger.load("b.demo-proyecto", MODEL_SET_ID))!;
    expect(ledger.versions).toEqual([40, 41, 42]);

    // Engine tag + UI delta chips.
    const { cls } = await coord.requireClassified(k42);
    const tagged = cls.clashes.filter((c) => (c.tags ?? []).includes("regresion")).map((c) => c.id).sort();
    expect(tagged).toEqual(expected.filter((id) => cls.clashes.some((c) => c.id === id)));
    const ui42 = await ui.triage("demo-proyecto", MODEL_SET_ID, k42);
    expect(ui42.clashes.filter((c) => c.delta === "reappeared").map((c) => c.id.replace(/^C-/, "")).sort()).toEqual(tagged);

    // MCP diff_test_versions reports the same numbers.
    const d = await coord.diffVersions({ baseTestKey: k41, targetTestKey: k42, groupBy: "disciplinePair", topPersisting: 5 });
    expect(d.totals.reappeared).toBe(13);
    expect(d.totals.new).toBe(truth.expectedDiff.new!.length);
    expect(d.totals.elementDeleted).toBe(truth.expectedDiff.element_deleted!.length);
  });

  it("8. hygiene groups get engine issue drafts; needs_info groups never do", async () => {
    const key = await ingest(coord, 42);
    const { cls } = await coord.requireClassified(key);
    const drafts = (cls as typeof cls & { issueDrafts?: Record<string, unknown> }).issueDrafts ?? {};
    const hygiene = cls.groups.filter((g) => g.engineStrategy === "hygiene" && g.validity !== "needs_info");
    for (const g of hygiene) expect(drafts[g.id]).toBeDefined();
    for (const g of cls.groups.filter((x) => x.validity === "needs_info")) expect(drafts[g.id]).toBeUndefined();
  });

  it("9. config levelMap reaches the engine", async () => {
    const key = await ingest(coord, 42);
    const { cls } = await coord.requireClassified(key);
    const lvl = cls.clashes.find((c) => c.level)!.level!;
    const c2 = new Coordinator({ root: ROOT, home, source: coord.source, config: testConfig({ levelMap: { [lvl]: "NIVEL-MAPEADO" } }) });
    await c2.classify({ testKey: key });
    const { cls: cls2 } = await c2.requireClassified(key);
    expect(cls2.clashes.some((c) => c.level === "NIVEL-MAPEADO")).toBe(true);
  });

  it("10. /api/auth/refresh without APS credentials answers 503 aps_not_configured", async () => {
    const { createBrowserAuthHandlers } = await import("../../server/api/browser-auth");
    const h = createBrowserAuthHandlers({ tokenFile: join(home, "secret", "b.json") });
    let status = 0;
    let body = "";
    const { Readable } = await import("node:stream");
    const rq = Object.assign(Readable.from([Buffer.from("")]), { method: "POST", headers: {} });
    await h.refresh(rq as never, { writeHead: (s: number) => (status = s), end: (b: string) => (body = b) } as never);
    expect(status).toBe(503);
    expect(JSON.parse(body).error).toBe("aps_not_configured");
  });
});

describe("M0 baseline: ledger through the server path", () => {
  it("out-of-order ingest (v42 first, then v41) relinks v42 to v41 and still yields the 13 reappeared clashes", async () => {
    const truth = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "fixture-truth.json"), "utf8")) as { expectedDiff: Record<string, string[]> };
    const expected = [...truth.expectedDiff.reappeared!].sort();
    const k42 = await ingest(coord, 42);
    expect((await coord.loadTest(k42)).test.previousTestKey).toBeUndefined();
    const k41 = await ingest(coord, 41);
    const t42 = (await coord.loadTest(k42)).test;
    expect(t42.previousTestKey).toBe(k41);
    const diff = (await coord.diffForTest(t42))!;
    expect([...diff.reappeared].sort()).toEqual(expected);
    expect([...diff.new].sort()).toEqual([...truth.expectedDiff.new!].sort());
    const ledger = (await coord.ledger.load("b.demo-proyecto", MODEL_SET_ID))!;
    expect(ledger.versions).toEqual([40, 41, 42]);
    // v42 was re-classified after the relink: regresion tags and delta chips are there.
    const { cls } = await coord.requireClassified(k42);
    const tagged = cls.clashes.filter((c) => (c.tags ?? []).includes("regresion")).map((c) => c.id).sort();
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((id) => expected.includes(id))).toBe(true);
    expect(cls.clashes.some((c) => c.delta === "persisting")).toBe(true);
  });
});

describe("M0 baseline: TOL-008 never tolerates a wall of unknown fire rating", () => {
  it("every real_pipe_wall clash of v41 and v42 stays real; TOL-008 never fires without a declared rating", async () => {
    const truth = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "fixture-truth.json"), "utf8")) as { patterns: Record<string, string> };
    for (const v of [41, 42] as const) {
      const key = await ingest(coord, v);
      const { cls } = await coord.requireClassified(key);
      const walls = cls.clashes.filter((c) => truth.patterns[c.id] === "real_pipe_wall");
      expect(walls.length).toBeGreaterThan(0);
      expect(walls.filter((c) => c.validity !== "real").map((c) => `${c.id}:${c.ruleId}`)).toEqual([]);
      expect(cls.clashes.filter((c) => c.ruleId === "TOL-008")).toEqual([]);
    }
  });
});

describe("M0 baseline: the human-review invariant end to end", () => {
  it("confidence < 0.70, needs_info, critical, structural openings, seguridad_personas and DEF-999 always reach a human (engine → payload → filter)", async () => {
    const key = await ingest(coord, 42);
    const { cls } = await coord.requireClassified(key);
    const byId = new Map(cls.clashes.map((c) => [c.id, c]));
    const must = (g: (typeof cls.groups)[number]) =>
      g.confidence < 0.7 ||
      g.clashIds.some((id) => (byId.get(id)?.confidence ?? 1) < 0.7) ||
      g.validity === "needs_info" ||
      g.severity === "critical" ||
      g.tags.includes("pasada_estructural") ||
      g.tags.includes("seguridad_personas") ||
      g.ruleIds.includes("DEF-999");
    const required = cls.groups.filter(must);
    expect(required.length).toBeGreaterThan(10);
    expect(required.filter((g) => g.reviewState !== "needs_review").map((g) => `${g.id} ${g.ruleIds.join(",")} ${g.tags.join(",")}`)).toEqual([]);

    // An agent proposal does not take a group out of "Requiere revisión": only a human decision does.
    const g0 = required.find((g) => g.validity === "real")!;
    await coord.proposeClassification({ testKey: key, target: { groupId: g0.id }, validity: "real", disagreesWithEngine: false, rationale: "Confirmo: interferencia real.", evidence: [], confidence: "alta" });
    const tri = await ui.triage("demo-proyecto", MODEL_SET_ID, key);
    const p = tri.groups.find((g) => g.id === g0.id)!;
    expect(p.humanReview).toBe(true);
    expect(p.reviewState).toBe("needs_review");
    expect(p.reviewReasons!.length).toBeGreaterThan(0);
    // payload ↔ engine: same set, the UI filter (reviewState === needs_review) sees every required group
    const flagged = new Set(tri.groups.filter((g) => g.reviewState === "needs_review").map((g) => g.id));
    for (const g of required) expect(flagged.has(g.id)).toBe(true);
    expect(tri.groups.filter((g) => g.humanReview).length).toBe(cls.groups.filter((g) => g.reviewState === "needs_review").length);
    // after a human decision the group leaves the queue
    await acceptGroups(ui, key, [g0.id]);
    const after = await ui.triage("demo-proyecto", MODEL_SET_ID, key);
    expect(after.groups.find((g) => g.id === g0.id)!.reviewState).toBe("decided");
    expect(after.groups.find((g) => g.id === g0.id)!.humanReview).toBe(true);
  });
});
