/**
 * Coordinator journey 2026-11:
 *  - G2: "Aprobar grupo" (family) decisions count: TriageFamily.pendingSend, a families-only batch,
 *    and the project page counts inherited instances as reviewed.
 *  - G3: "Llevar decisiones a vN" re-bases a batch prepared on an older version (human only).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../../server/api/contract";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import type { FixtureSource } from "../../server/source/fixtures";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, tempHome } from "./helpers";

const P = "demo-proyecto";
let cleanup: () => void;
let coord: Coordinator;
let ui: CoordinatorUi;
beforeEach(() => {
  const t = tempHome();
  cleanup = t.cleanup;
  coord = makeCoord(t.home);
  ui = new CoordinatorUi(coord);
});
afterEach(() => cleanup());

let n = 0;
async function decide(testKey: string, groupId: string, kind: Decision["kind"], changes: Decision["changes"] = [], extra: Partial<Decision> = {}) {
  const p = (await ui.proposals(testKey, undefined, 1000)).items.find((x) => x.targetId === groupId)!;
  await ui.saveDecisions(
    [{ id: `d-rb-test-${n++}`, proposalId: p.id, targetType: "group", targetId: groupId, testId: testKey, modelSetId: MODEL_SET_ID, projectId: P, kind, changes, viewedInViewerMs: 1000, decidedAt: new Date().toISOString(), userId: "x", userName: "x", ...extra }],
    HUMAN,
  );
}

/** v42 groups whose clashes all persist unchanged from ONE v41 group (same size) and are not in ACC. */
async function stableGroups(k41: string, k42: string) {
  const t41 = await ui.triage(P, MODEL_SET_ID, k41);
  const t42 = await ui.triage(P, MODEL_SET_ID, k42);
  const g41Of = new Map(t41.groups.flatMap((g) => g.clashIds.map((c) => [c, g] as const)));
  const out: Array<{ g41: (typeof t41.groups)[number]; g42: (typeof t42.groups)[number] }> = [];
  for (const g of t42.groups) {
    if (g.acc || g.change !== "unchanged" || g.familyId && t42.families?.find((f) => f.id === g.familyId)?.decision) continue;
    const src = new Set(g.clashIds.map((c) => g41Of.get(c)?.id));
    if (src.size !== 1 || src.has(undefined)) continue;
    const g41 = t41.groups.find((x) => x.id === [...src][0])!;
    if (g41.clashIds.length !== g.clashIds.length || g41.acc) continue;
    out.push({ g41, g42: g });
  }
  return { out, t41, t42 };
}

const toIssue: Decision["changes"] = [{ field: "action", aiValue: null, humanValue: { createIssue: true, setStatus: null } }];
const toClose: Decision["changes"] = [{ field: "action", aiValue: null, humanValue: { createIssue: false, setStatus: "closed" } }];

describe("G2: family decisions count", () => {
  it("pendingSend, a families-only batch and the project page count inherited instances", async () => {
    const k42 = await ingest(coord, 42);
    const fams = await ui.families(k42);
    const f = fams.families.find((x) => x.state === "sin_decidir" && x.instanceCount >= 2 && x.proposed.validity === "real" && !x.validityMix.tolerated && !x.validityMix.false_positive && (x.acc?.existing ?? 0) < x.rawClashCount)!;
    expect(f).toBeDefined();
    expect(f.pendingSend).toBe(0);
    const before = (await ui.modelSets(P)).find((m) => m.id === MODEL_SET_ID)!.groupsReviewed;
    const decided = await ui.decideFamily(f.id, { testId: k42, decision: "approve", spotChecked: [f.groupIds[0]!] }, HUMAN);
    const inherited = decided.instances.filter((i) => i.inheritance.state === "inherited").length;
    expect(inherited).toBeGreaterThan(0);
    // the toolbar counts it: pendingSend > 0 in the triage payload and in GET families
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    expect(tri.families!.find((x) => x.id === f.id)!.pendingSend).toBeGreaterThan(0);
    expect((await ui.family(k42, f.id)).pendingSend).toBeGreaterThan(0);
    // project page: inherited instances count as reviewed (no group decision exists)
    expect((await ui.listDecisions({ testId: k42 })).items).toHaveLength(0);
    expect((await ui.modelSets(P)).find((m) => m.id === MODEL_SET_ID)!.groupsReviewed).toBe(before + inherited);
    // families-only batch
    const b = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k42 }, HUMAN);
    expect(b.items.length).toBeGreaterThan(0);
    expect(b.items.every((i) => i.familyId === f.id)).toBe(true);
    expect((await ui.family(k42, f.id)).pendingSend).toBe(0);
    await ui.discard(b.id, HUMAN);
    expect((await ui.family(k42, f.id)).pendingSend).toBeGreaterThan(0);
  });
});

describe("G3: Llevar decisiones a vN", () => {
  async function staleBatch() {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const { out, t41, t42 } = await stableGroups(k41, k42);
    const issuePair = out[0]!;
    const realPair = out.find((x) => x !== issuePair && x.g42.validity === "real" && x.g41.validity === "real")!;
    expect(issuePair).toBeDefined();
    expect(realPair).toBeDefined();
    // a v41 group none of whose clashes survive in v42
    const in42 = new Set(t42.groups.flatMap((g) => g.clashIds));
    const resolved = t41.groups.find((g) => !g.acc && g.clashIds.every((c) => !in42.has(c)) && g.id !== issuePair.g41.id && g.id !== realPair.g41.id)!;
    expect(resolved).toBeDefined();
    await decide(k41, issuePair.g41.id, "correct", toIssue, { reasonCode: "R01" });
    await decide(k41, realPair.g41.id, "correct", toClose, { reasonCode: "R01" });
    await decide(k41, resolved.id, "correct", toIssue, { reasonCode: "R01" });
    const b41 = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k41 }, HUMAN);
    return { k41, k42, b41, issuePair, realPair, resolved };
  }

  it("carries unchanged items, lists changed/resolved ones, never carries a real closure; old batch superseded and audited; the new one accepts a demo approval", async () => {
    const { k42, b41, issuePair, realPair, resolved } = await staleBatch();
    expect(b41.stale).toBe(true);
    expect(b41.rebase).toEqual({ available: true, targetVersion: 42 });
    expect(b41.items.some((i) => i.groupId === realPair.g41.id && i.mcOperation === "clash.close")).toBe(true);
    expect(b41.items.some((i) => i.groupId === resolved.id)).toBe(true);
    // the old batch can never be approved (no "Aplicar igualmente")
    await expect(ui.approve(b41.id, { confirmWord: "APLICAR", excludedItemIds: [], demo: true }, HUMAN)).rejects.toThrow(/Llevar decisiones a v42/);
    // agent parity: get_session_status points to the human action
    const st = await coord.sessionStatus();
    expect(st.pending.staleBatches).toEqual([expect.objectContaining({ batchId: b41.id, version: 41, latestVersion: 42, canRebase: true, hint: expect.stringContaining(`/aprobaciones/${b41.id}`) })]);
    // an edited issue text is copied 1:1
    const issueItem = b41.items.find((i) => i.groupId === issuePair.g41.id && i.mcOperation === "clash.assign")!;
    expect(issueItem).toBeDefined();
    await ui.updateIssue(b41.id, issueItem.id, { title: "Bajar ducto en eje C (texto editado)" });
    const feedbackBefore = (await coord.store.listFeedback()).length;

    const r = await ui.rebaseBatch(b41.id, HUMAN);
    expect(r.previous).toBe(b41.id);
    expect(r.batch).toMatchObject({ state: "ready", modelSetVersion: 42, testId: k42, stale: false });
    expect(r.batch.approval).toBeUndefined();
    expect(r.batch.rebase).toBeUndefined();
    const carried = r.batch.items.find((i) => i.groupId === issuePair.g42.id)!;
    expect(carried).toBeDefined();
    expect(carried.issue?.title).toBe("Bajar ducto en eje C (texto editado)");
    expect((carried.accNew as { title: string }).title).toBe("Bajar ducto en eje C (texto editado)");
    // the real closure is never carried, the resolved group is listed
    expect(r.batch.items.some((i) => i.groupId === realPair.g42.id)).toBe(false);
    expect(r.needsReview).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/real/) }), expect.objectContaining({ groupId: resolved.id, reason: expect.stringMatching(/Resuelta en v42/) })]));
    expect(r.batch.rebasedFrom).toMatchObject({ batchId: b41.id, fromVersion: 41 });
    // carried decisions: new v42 records, batched, no feedback
    const dec = (await coord.store.listDecisions()).filter((d) => d.testId === k42);
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ targetId: issuePair.g42.id, batchId: r.batch.id, kind: "correct" });
    expect(dec[0]!.carriedFrom).toMatch(/^d-rb-test-/);
    expect((await coord.store.listFeedback()).length).toBe(feedbackBefore);
    // the old batch is superseded and audited; its decisions stay attached
    const old = await ui.getBatch(b41.id);
    expect(old).toMatchObject({ state: "discarded", supersededBy: r.batch.id });
    expect((await coord.store.listDecisions()).filter((d) => d.batchId === b41.id).length).toBeGreaterThan(0);
    const audit = await ui.audit({ action: "batch.superseded", limit: 10 });
    expect(audit.items.some((e) => e.batchId === b41.id)).toBe(true);
    expect((await ui.audit({ action: "decision.carried", limit: 10 })).items).toHaveLength(1);
    // not offered twice
    expect((await coord.sessionStatus()).pending.staleBatches).toEqual([]);
    // the new batch needs (and accepts) a fresh approval
    const ap = await ui.approve(r.batch.id, { confirmWord: "APLICAR", excludedItemIds: [], demo: true }, HUMAN);
    expect(ap.state).toBe("approved");
  });

  it("refuses when the latest version is not analysed, or when the batch is current", async () => {
    const { b41 } = await staleBatch();
    (coord.source as FixtureSource).latestVersion = async () => 43;
    const b = await ui.getBatch(b41.id);
    expect(b.rebase).toMatchObject({ available: false, targetVersion: 43, reason: expect.stringMatching(/Analizar v43/) });
    await expect(ui.rebaseBatch(b41.id, HUMAN)).rejects.toThrow(/v43 no está analizada/);
    expect((await ui.getBatch(b41.id)).state).toBe("ready");
    expect((await coord.sessionStatus()).pending.staleBatches).toEqual([expect.objectContaining({ batchId: b41.id, canRebase: false })]);
    (coord.source as FixtureSource).latestVersion = async () => 41;
    await expect(ui.rebaseBatch(b41.id, HUMAN)).rejects.toThrow(/versión vigente/);
  });

  it("families-only batch: family items are rebuilt on v42 from the current family decision", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const a = await ui.families(k41);
    const b = await ui.families(k42);
    const candidates = a.families.filter((x) => {
      const y = b.families.find((z) => z.id === x.id);
      return x.proposed.validity === "real" && !x.validityMix.tolerated && !x.validityMix.false_positive && (x.acc?.existing ?? 0) < x.rawClashCount && y && (y.acc?.existing ?? 0) < y.rawClashCount;
    });
    // A family whose v41 decision is inherited silently by at least one v42 instance with a live clash.
    let f: (typeof candidates)[number] | undefined;
    let inherited42: string[] = [];
    for (const x of candidates) {
      await ui.decideFamily(x.id, { testId: k41, decision: "approve", spotChecked: [x.groupIds[0]!] }, HUMAN);
      const y = await ui.family(k42, x.id);
      inherited42 = y.instances.filter((i) => i.inheritance.state === "inherited" && (i.acc?.existing ?? 0) < i.rawClashCount).map((i) => i.groupId);
      if (inherited42.length) {
        f = x;
        break;
      }
      await ui.decideFamily(x.id, { testId: k41, decision: "reject", note: "prueba" }, HUMAN);
    }
    expect(f).toBeDefined();
    const b41 = await ui.sendToApproval({ projectId: P, modelSetId: MODEL_SET_ID, testId: k41 }, HUMAN);
    expect(b41.items.length).toBeGreaterThan(0);
    expect(b41.items.every((i) => i.familyId === f!.id)).toBe(true);
    const r = await ui.rebaseBatch(b41.id, HUMAN);
    expect(r.batch.modelSetVersion).toBe(42);
    const items = r.batch.items.filter((i) => i.familyId === f!.id);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) for (const g of i.groupIds ?? []) expect(inherited42).toContain(g);
    // v42 clash ids only
    const ids42 = new Set((await ui.triage(P, MODEL_SET_ID, k42)).clashes.map((c) => c.id));
    for (const i of items) for (const t of i.targetIds) expect(ids42.has(t)).toBe(true);
  });
});
