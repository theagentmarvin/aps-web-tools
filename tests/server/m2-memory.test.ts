/**
 * M2 (docs/PLAN-core-features-simplified.md §3): F1 decision memory (inheritance), the review
 * baseline, X3 coordinator questions, capture codes (V01–V05) and Proposal.origin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../../server/api/contract";
import type { Coordinator } from "../../server/coordinator";
import { CoordinatorUi } from "../../server/coordinator-ui";
import { inheritPolicyReasons } from "../../server/families";
import { HUMAN, ingest, makeCoord, MODEL_SET_ID, ROOT, tempHome } from "./helpers";

const P = "demo-proyecto";
type Cyc = { cycle: { counts: Record<string, number>; clashCounts: Record<string, number> } & Record<string, unknown> };
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

let n = 0;
async function decide(testKey: string, groupId: string, kind: Decision["kind"], changes: Decision["changes"] = [], extra: Partial<Decision> = {}) {
  const p = (await ui.proposals(testKey, undefined, 1000)).items.find((x) => x.targetId === groupId)!;
  await ui.saveDecisions(
    [{ id: `d-m2-${n++}`, proposalId: p.id, targetType: "group", targetId: groupId, testId: testKey, modelSetId: MODEL_SET_ID, projectId: P, kind, changes, viewedInViewerMs: 1000, decidedAt: new Date().toISOString(), userId: "x", userName: "x", ...extra }],
    HUMAN,
  );
}

/** v42 groups whose clashes all persist unchanged from ONE v41 group and are not in ACC. */
async function stableGroups(k41: string, k42: string) {
  const t41 = await ui.triage(P, MODEL_SET_ID, k41);
  const t42 = await ui.triage(P, MODEL_SET_ID, k42);
  const g41Of = new Map(t41.groups.flatMap((g) => g.clashIds.map((c) => [c, g] as const)));
  const out: Array<{ g41: (typeof t41.groups)[number]; g42: (typeof t42.groups)[number] }> = [];
  for (const g of t42.groups) {
    if (g.acc || g.change !== "unchanged") continue;
    const src = new Set(g.clashIds.map((c) => g41Of.get(c)?.id));
    if (src.size !== 1 || src.has(undefined)) continue;
    const g41 = t41.groups.find((x) => x.id === [...src][0])!;
    if (g41.clashIds.length !== g.clashIds.length) continue;
    out.push({ g41, g42: g });
  }
  return out;
}

describe("F1 decision memory", () => {
  it("an unchanged group inherits the human decision of the reviewed version and counts as decided", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    expect((await ui.triage(P, MODEL_SET_ID, k42)).changeSummary!.baseReason).toBe("previous");
    // G7: pick one that no policy reason re-asks (critical, structural opening, life safety).
    const cls42 = (await coord.requireClassified(k42)).cls;
    const policyFree = (id: string) => inheritPolicyReasons(cls42.groups.find((g) => g.id === id)!).length === 0;
    const pair = (await stableGroups(k41, k42)).find((x) => policyFree(x.g42.id));
    expect(pair).toBeDefined();
    await decide(k41, pair!.g41.id, "accept");
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const g = tri.groups.find((x) => x.id === pair!.g42.id)!;
    expect(g.inherited).toMatchObject({ source: "human", fromVersion: 41, fromTestKey: k41, decision: "accept", decidedBy: HUMAN.name });
    expect(g.reviewState).toBe("decided");
    expect(tri.changeSummary).toMatchObject({ baseReason: "last_reviewed", baseVersion: 41 });
    expect(tri.changeSummary!.inherited).toBeGreaterThan(0);
    const p = tri.proposals.find((x) => x.targetId === g.id)!;
    expect(p.inherited).toMatchObject({ testId: k41, kind: "accept" });
    // the ledger holds the reference with the geometry
    const ledger = (await coord.ledger.load(`b.${P}`, MODEL_SET_ID))!;
    const ref = ledger.entries[pair!.g41.clashIds[0]!.replace(/^C-/, "")]!.decision!;
    expect(ref).toMatchObject({ source: "human", decision: "accept", decidedAtVersion: 41 });
    expect(typeof ref.penetrationMm).toBe("number");
    expect(ref.elementTypes).toContain("|");
    // undo removes the reference
    const d = (await ui.listDecisions({ testId: k41 })).items[0]!;
    await decide(k41, pair!.g41.id, "undo", [], { undoes: d.id });
    expect((await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === g.id)!.inherited).toBeUndefined();
  });

  it("a changed clash (|Δpenetration| > 10 mm) does not inherit", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const [pair] = await stableGroups(k41, k42);
    await decide(k41, pair!.g41.id, "accept");
    // simulate the geometry change: the reference was taken 50 mm deeper
    await coord.ledger.withLedger(`b.${P}`, MODEL_SET_ID, (l) => {
      const e = l.entries[pair!.g41.clashIds[0]!.replace(/^C-/, "")]!;
      e.decision = { ...e.decision!, penetrationMm: e.decision!.penetrationMm + 50 };
      return l;
    });
    expect((await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === pair!.g42.id)!.inherited).toBeUndefined();
  });

  it("a closure is never inherited by a real clash", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const pair = (await stableGroups(k41, k42)).find((x) => x.g42.validity === "real")!;
    expect(pair).toBeDefined();
    await decide(k41, pair.g41.id, "correct", [{ field: "action", aiValue: { createIssue: true, setStatus: null }, humanValue: { createIssue: false, setStatus: "closed" } }], { reasonCode: "R01" });
    const ledger = (await coord.ledger.load(`b.${P}`, MODEL_SET_ID))!;
    expect(ledger.entries[pair.g41.clashIds[0]!.replace(/^C-/, "")]!.decision!.effect).toBe("close");
    const g = (await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === pair.g42.id)!;
    expect(g.inherited).toBeUndefined();
    expect(g.reviewState).not.toBe("decided");
  });

  it("ACC-decided groups inherit from ACC (D8); out-of-order ingest still inherits", async () => {
    const k42 = await ingest(coord, 42);
    const k41 = await ingest(coord, 41); // older version ingested later: v42 is relinked to v41
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const accGroups = tri.groups.filter((g) => g.acc && g.acc.existing === g.clashIds.length);
    expect(accGroups.length).toBeGreaterThan(0);
    for (const g of accGroups) expect(g.inherited?.source).toBe("acc");
    const [pair] = await stableGroups(k41, k42);
    await decide(k41, pair!.g41.id, "accept");
    expect((await ui.triage(P, MODEL_SET_ID, k42)).groups.find((x) => x.id === pair!.g42.id)!.inherited?.source).toBe("human");
  });

  it("the baseline is the last REVIEWED version (decision or approved batch), else the previous one", async () => {
    const k41 = await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const t42 = (await coord.store.getTest(k42))!;
    expect(await coord.baselineFor(t42)).toMatchObject({ reason: "previous", base: { testKey: k41 } });
    const t41 = (await coord.store.getTest(k41))!;
    expect((await coord.baselineFor(t41)).base).toBeUndefined();
    const [pair] = await stableGroups(k41, k42);
    await decide(k41, pair!.g41.id, "postpone");
    expect((await coord.baselineFor(t42)).reason).toBe("previous"); // a postponement is not a review
    await decide(k41, pair!.g41.id, "accept");
    expect(await coord.baselineFor(t42)).toMatchObject({ reason: "last_reviewed", base: { testKey: k41 } });
  });
});

describe("X3 coordinator questions", () => {
  it("ask → answer (validity) → human decisions; other answers are stored; validation like agent text", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const g = tri.groups.find((x) => !x.acc && !x.inherited && x.validity === "real")!;
    await expect(coord.askCoordinator({ testKey: k42, groupIds: [g.id], question: "¿Ver https://evil.example.com?", kind: "other" })).rejects.toThrow();
    await expect(coord.askCoordinator({ testKey: k42, groupIds: ["G-0000000000"], question: "¿Es real esta interferencia?", kind: "validity" })).rejects.toThrow(/inexistentes/);
    const q = await coord.askCoordinator({ testKey: k42, groupIds: [g.id], question: "¿El ducto pasa bajo la viga o la atraviesa?", options: [{ label: "Real", validity: "real" }, { label: "Falso positivo", validity: "false_positive" }], kind: "validity" });
    const t2 = await ui.triage(P, MODEL_SET_ID, k42);
    expect(t2.questions!.map((x) => x.id)).toContain(q.questionId);
    expect(t2.groups.find((x) => x.id === g.id)!.questionIds).toEqual([q.questionId]);
    expect((await ui.questionsOf(k42)).find((x) => x.id === q.questionId)!.state).toBe("open");
    await expect(ui.answerQuestion(q.questionId, { optionIndex: 4 }, HUMAN)).rejects.toThrow(/no existe/);
    const a = await ui.answerQuestion(q.questionId, { optionIndex: 1, reasonCode: "R01" }, HUMAN);
    expect(a).toMatchObject({ state: "answered", answer: "Falso positivo", answeredBy: HUMAN.id, affectedGroups: 1 });
    expect(a.decisionIds).toHaveLength(1);
    const d = (await ui.listDecisions({ testId: k42 })).items.find((x) => x.id === a.decisionIds![0])!;
    expect(d).toMatchObject({ kind: "correct", targetId: g.id, reasonCode: "R01" });
    expect(d.changes[0]).toMatchObject({ field: "validity", humanValue: "false_positive" });
    const t3 = await ui.triage(P, MODEL_SET_ID, k42);
    expect(t3.groups.find((x) => x.id === g.id)!.reviewState).toBe("decided");
    expect(t3.groups.find((x) => x.id === g.id)!.questionIds).toBeUndefined();
    await expect(ui.answerQuestion(q.questionId, { optionIndex: 0 }, HUMAN)).rejects.toThrow(/respondida/);
    // other: stored only
    const q2 = await coord.askCoordinator({ testKey: k42, familyId: tri.families!.find((f) => f.groupIds.length <= 20)!.id, question: "¿Qué detalle típico usan para estas pasadas?", kind: "other" });
    const a2 = await ui.answerQuestion(q2.questionId, { answer: "Camisa Ø+50 con sello" }, HUMAN);
    expect(a2.decisionIds).toBeUndefined();
    const list = await coord.listQuestions({ testKey: k42, limit: 50 });
    expect(list.rows.find((r) => r[0] === q2.questionId)![6]).toMatchObject({ untrusted: "Camisa Ø+50 con sello" });
  });

  it("an open question goes stale when its clashes change in a newer version", async () => {
    const truth = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "fixture-truth.json"), "utf8")) as { expectedDiff: Record<string, string[]> };
    const k41 = await ingest(coord, 41);
    const goneId = truth.expectedDiff.resolved![0]!;
    const q = await coord.askCoordinator({ testKey: k41, clashIds: [goneId], question: "¿Esta interferencia es de diseño?", kind: "validity" });
    const keep = (await coord.requireClassified(k41)).cls.clashes.find((c) => truth.expectedDiff.persisting!.includes(c.id))!;
    const q2 = await coord.askCoordinator({ testKey: k41, clashIds: [keep.id], question: "¿Se mantiene esta pasada?", kind: "other" });
    const k42 = await ingest(coord, 42);
    const all = await coord.questions.forModelSet(`b.${P}`, MODEL_SET_ID);
    expect(all.find((x) => x.id === q.questionId)).toMatchObject({ state: "stale" });
    expect(all.find((x) => x.id === q.questionId)!.staleReason).toMatch(/^v42: /);
    expect(all.find((x) => x.id === q2.questionId)!.state).toBe("open");
    // the open one is carried to v42; the stale one is not offered for answering
    expect((await ui.questionsOf(k42)).map((x) => x.id)).toEqual([q2.questionId]);
    await expect(ui.answerQuestion(q.questionId, { answer: "sí" }, HUMAN)).rejects.toThrow(/obsoleta/);
  });
});

describe("capture", () => {
  it("V01–V05 reason codes are accepted; every proposal says who proposed it", async () => {
    const k42 = await ingest(coord, 42);
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    expect(tri.proposals.every((p) => p.origin === "engine" || p.origin === "agent")).toBe(true);
    const g = tri.groups.find((x) => !x.acc)!;
    await decide(k42, g.id, "reject", [], { reasonCode: "V04" });
    expect((await ui.listDecisions({ testId: k42 })).items[0]!.reasonCode).toBe("V04");
    await coord.proposeClassification({ testKey: k42, target: { groupId: g.id }, validity: "real", disagreesWithEngine: false, rationale: "Confirmo.", evidence: [], confidence: "alta" });
    expect((await ui.proposals(k42, undefined, 1000)).items.find((p) => p.targetId === g.id)!.origin).toBe("agent");
  });
});

describe("agent shapes for /preparar-ciclo and /acta", () => {
  it("ingest / run_classification report the cycle; list_families filters by delta and needsReview; get_family / get_group carry delta, previousDecision and humanReview", async () => {
    const r41 = await coord.ingest({ projectId: P, modelSetId: MODEL_SET_ID, testId: (await import("./helpers")).TEST_V41 });
    expect(r41.cycle).toMatchObject({ baseVersion: null, baseReason: "first_cycle", scopeChanges: [] });
    const c41 = await coord.classify({ testKey: r41.testKey });
    expect((c41 as unknown as Cyc).cycle).toMatchObject({ baseVersion: null, baseReason: "first_cycle" });
    const k42 = await ingest(coord, 42, false);
    const c42 = await coord.classify({ testKey: k42 });
    expect((c42 as unknown as Cyc).cycle).toMatchObject({ baseVersion: 41, baseReason: "previous", accSync: { assignedGroups: 6, closedGroups: 1 } });
    const counts = (c42 as unknown as Cyc).cycle!.counts!;
    expect(counts.new + counts.changed + counts.reappeared + counts.unchanged).toBe((await coord.requireClassified(k42)).cls.groups.length);
    expect(counts.inherited).toBeGreaterThan(0); // ACC-decided groups
    expect((c42 as unknown as Cyc).cycle!.clashCounts).toMatchObject({ new: 70, reappeared: 13 });

    const all = await coord.listFamilies({ testKey: k42, limit: 100 });
    const col = (name: string) => all.columns.indexOf(name);
    const changed = await coord.listFamilies({ testKey: k42, delta: ["new", "changed", "reappeared"], limit: 100 });
    expect(changed.total).toBeGreaterThan(0);
    expect(changed.total).toBeLessThanOrEqual(all.total);
    for (const r of changed.rows) expect((r[col("delta")] as string[]).some((d) => ["new", "changed", "reappeared"].includes(d))).toBe(true);
    const review = await coord.listFamilies({ testKey: k42, needsReview: true, limit: 100 });
    for (const r of review.rows) expect(r[col("needsReview")]).toBeGreaterThan(0);
    const noReview = await coord.listFamilies({ testKey: k42, needsReview: false, limit: 100 });
    expect(review.total + noReview.total).toBe(all.total);

    const fam = await coord.getFamily({ testKey: k42, familyId: changed.rows[0]![0] as string });
    expect(["new", "changed", "reappeared", "unchanged"]).toContain(fam.delta.state);
    expect(typeof fam.humanReview).toBe("boolean");
    expect(fam).toHaveProperty("previousDecision");
    const tri = await ui.triage(P, MODEL_SET_ID, k42);
    const accGroup = tri.groups.find((g) => g.inherited?.source === "acc")!;
    const gd = await coord.getGroup({ testKey: k42, groupId: accGroup.id, sampleClashes: 2, includeElementProps: false });
    expect(gd.previousDecision).toMatchObject({ source: "acc" });
    expect(gd.humanReview).toBe(false);
    expect(gd.delta).toHaveProperty("deltaPenetrationMm");
    expect(gd.delta).toHaveProperty("typeChanged");
  });
});

describe("performance: memoized triage", () => {
  it("returns the same payload object until something it reads changes (decision, question, family decision)", async () => {
    await ingest(coord, 41);
    const k42 = await ingest(coord, 42);
    const a = await ui.triage(P, MODEL_SET_ID, k42);
    const b = await ui.triage(P, MODEL_SET_ID, k42);
    expect(b).toBe(a);
    const g = a.groups.find((x) => !x.acc && !x.inherited)!;
    await decide(k42, g.id, "accept");
    const c = await ui.triage(P, MODEL_SET_ID, k42);
    expect(c).not.toBe(a);
    expect(c.groups.find((x) => x.id === g.id)!.reviewState).toBe("decided");
    const q = await coord.askCoordinator({ testKey: k42, groupIds: [a.groups[1]!.id], question: "¿Es una pasada de diseño?", kind: "other" });
    const d = await ui.triage(P, MODEL_SET_ID, k42);
    expect(d).not.toBe(c);
    expect(d.questions!.map((x) => x.id)).toContain(q.questionId);
  });
});
