/** Regressions for the server bugs found by the UI end-to-end run. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { runEngine } from "../../server/engine";
import type { ClashDiff } from "../../core/types";
import { FixtureSource } from "../../server/source/fixtures";
import { acceptGroups, HUMAN, ingest, makeCoord, MODEL_SET_ID, ROOT, tempHome, testConfig, TEST_V41, TEST_V42 } from "./helpers";

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

  it("7. the reappeared ledger is persisted per model set after each ingest diff (idempotent per version)", async () => {
    const seen: Array<{ version: number; counts: ClashDiff["counts"] }> = [];
    const c = new Coordinator({
      root: ROOT,
      home,
      source: new FixtureSource({ home }),
      config: testConfig(),
      ledgerUpdater: (ledger, diff, ctx) => {
        seen.push({ version: ctx.version, counts: diff.counts });
        const l = (ledger as { seen: string[] } | undefined) ?? { seen: [] };
        return { seen: [...new Set([...l.seen, ...diff.resolved])] };
      },
    });
    await c.ingest({ projectId: "b.demo-proyecto", modelSetId: MODEL_SET_ID, testId: TEST_V41 });
    expect(await c.ledger.load("b.demo-proyecto", MODEL_SET_ID)).toBeUndefined(); // no previous version yet
    await c.ingest({ projectId: "b.demo-proyecto", modelSetId: MODEL_SET_ID, testId: TEST_V42 });
    await c.ingest({ projectId: "b.demo-proyecto", modelSetId: MODEL_SET_ID, testId: TEST_V42, refresh: true });
    const f = await c.ledger.load<{ seen: string[] }>("b.demo-proyecto", MODEL_SET_ID);
    expect(f?.meta.appliedVersions).toEqual([42]);
    expect(f!.ledger.seen.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    // Without an updater (core module not landed yet) nothing is written.
    const t2 = tempHome();
    try {
      const c2 = makeCoord(t2.home);
      await ingest(c2, 41, false);
      await ingest(c2, 42, false);
      expect(await c2.ledger.load("b.demo-proyecto", MODEL_SET_ID)).toBeUndefined();
    } finally {
      t2.cleanup();
    }
  });
});
