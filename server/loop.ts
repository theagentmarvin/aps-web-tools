/**
 * Agent ↔ coordinator loop, server side (docs/ux/agent-human-loop-proposal.md): provenance of what a
 * panel shows (rule with accuracy · agent with its differences · inherited · human), the batch a
 * family / ubicación is in (loop rail), learning summaries for receipts and the cycle dashboard.
 * Read models only: nothing here writes. Every number comes from the store (rule accuracy from the
 * shared tally in rule-accuracy.ts — the same as the Reglas page).
 */
import type * as C from "./api/contract";
import type { Coordinator } from "./coordinator";
import { loadRules } from "./engine";
import type { FamilyView } from "./families";
import { THRESHOLDS } from "./next-steps";
import { learningDelta, mergeInto, rateOf, topCorrection, type AccuracyMap } from "./rule-accuracy";
import { ruleLabelEs } from "./rule-effect";
import type { BatchRecord, ClassificationRecord, DecisionRecord, GroupRecord, ProposalRecord, TestRecord } from "./store/types";
import { bareProjectId } from "./util";

const FALLBACK = "DEF-999";
const PENDING = new Set(["draft", "pending_review"]);
const BAND_CONF: Record<string, number> = { alta: 0.9, media: 0.7, baja: 0.5 };

export interface LoopCtx {
  testKey: string;
  accuracy: AccuracyMap;
  names: Map<string, string>;
  versionOf: Map<string, number>;
  /** groupId → ruleId → clashes. */
  ruleWeights: Map<string, Map<string, number>>;
  groups: Map<string, GroupRecord>;
  familyBatch: Map<string, C.LoopBatchRef>;
  groupBatch: Map<string, C.LoopBatchRef>;
}

/** One context per projection (triage payload / families list): accuracy is computed once. */
export async function loopContext(core: Coordinator, test: TestRecord, cls: ClassificationRecord): Promise<LoopCtx> {
  const rs = loadRules();
  const names = new Map(rs.source.classification.rules.map((r) => [r.id, ruleLabelEs(r, rs)]));
  const accuracy = await core.ruleAuthoring.accuracy().catch(() => new Map() as AccuracyMap);
  const versionOf = new Map((await core.store.listTests()).map((t) => [t.testKey, t.modelSetVersion]));
  const ruleWeights = new Map<string, Map<string, number>>();
  for (const c of cls.clashes) {
    if (!c.ruleId) continue;
    const m = ruleWeights.get(c.groupId) ?? new Map<string, number>();
    m.set(c.ruleId, (m.get(c.ruleId) ?? 0) + 1);
    ruleWeights.set(c.groupId, m);
  }
  const { familyBatch, groupBatch } = batchIndex((await core.store.listBatches()).filter((b) => b.testKey === test.testKey && b.state !== "discarded"));
  return { testKey: test.testKey, accuracy, names, versionOf, ruleWeights, groups: new Map(cls.groups.map((g) => [g.id, g])), familyBatch, groupBatch };
}

/** Latest live batch per family / ubicación, with the ACC results of its items. */
export function batchIndex(batches: readonly BatchRecord[]): { familyBatch: Map<string, C.LoopBatchRef>; groupBatch: Map<string, C.LoopBatchRef> } {
  const familyBatch = new Map<string, C.LoopBatchRef>();
  const groupBatch = new Map<string, C.LoopBatchRef>();
  const sorted = [...batches].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const add = (m: Map<string, C.LoopBatchRef>, key: string, b: BatchRecord, i: BatchRecord["items"][number]) => {
    let r = m.get(key);
    if (r && r.id !== b.id) return; // a newer batch already holds it
    r ??= { id: b.id, state: b.state, stale: false, items: 0, applied: 0, failed: 0 };
    r.items++;
    if (i.result?.status === "applied") {
      r.applied++;
      if (i.result.accRefs?.length) r.accIssueIds = [...new Set([...(r.accIssueIds ?? []), ...i.result.accRefs])].slice(0, 10);
    }
    if (i.result?.status === "failed") {
      r.failed++;
      if (i.result.message) r.message = i.result.message.slice(0, 200);
    }
    m.set(key, r);
  };
  for (const b of sorted)
    for (const i of b.items) {
      if (i.excluded) continue;
      if (i.familyId) {
        add(familyBatch, i.familyId, b, i);
        for (const g of i.groupIds ?? []) add(groupBatch, g, b, i);
      } else if (i.groupId) add(groupBatch, i.groupId, b, i);
      else if (i.targetType === "group") for (const g of i.targetIds) add(groupBatch, g, b, i);
    }
  return { familyBatch, groupBatch };
}

function ruleRows(ctx: LoopCtx, groupIds: readonly string[]): C.ProvenanceRule[] {
  const weight = new Map<string, number>();
  const groups = new Map<string, number>();
  for (const gid of groupIds) {
    for (const [r, n] of ctx.ruleWeights.get(gid) ?? []) weight.set(r, (weight.get(r) ?? 0) + n);
    const dom = ctx.groups.get(gid)?.ruleIds[0];
    if (dom) groups.set(dom, (groups.get(dom) ?? 0) + 1);
  }
  for (const r of groups.keys()) if (!weight.has(r)) weight.set(r, 0);
  return [...weight.entries()]
    .sort((a, b) => (groups.get(b[0]) ?? 0) - (groups.get(a[0]) ?? 0) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([id, w]) => {
      const a = ctx.accuracy.get(id);
      const top = topCorrection(a);
      return {
        id,
        nameEs: ctx.names.get(id) ?? id,
        weight: w,
        groups: groups.get(id) ?? 0,
        accuracy: { agree: a?.agree ?? 0, n: a?.n ?? 0, rate: rateOf(a), ...(top ? { topCorrection: top } : {}) },
        ...(id === FALLBACK ? { fallback: true } : {}),
      };
    });
}

type AgentPayload = { validity?: string; action?: string; responsibleDiscipline?: string; solutionOption?: string; confidence?: unknown };

/** Agent fields that differ from the engine proposal (shown as «≠ regla: …» per row). */
export function agentDiffs(proposed: { validity: string; action: string; responsibleDiscipline: string; solutionOption?: string }, payload: AgentPayload): NonNullable<C.Provenance["agent"]>["diffs"] {
  const out: NonNullable<C.Provenance["agent"]>["diffs"] = [];
  for (const field of ["validity", "action", "responsibleDiscipline", "solutionOption"] as const) {
    const a = payload[field];
    if (a === undefined || a === null || a === "") continue;
    const r = proposed[field];
    if (String(a) !== String(r ?? "")) out.push({ field, ruleValue: String(r ?? ""), agentValue: String(a) });
  }
  return out;
}

export function familyProvenance(ctx: LoopCtx, v: FamilyView, pending: ProposalRecord | undefined): C.Provenance {
  const rules = ruleRows(ctx, v.groupIds);
  const dec = v.decision;
  if (dec) {
    if (dec.testKey === ctx.testKey) return { source: "human", rules, human: { version: dec.version, decidedBy: dec.decidedBy, decidedAt: dec.decidedAt } };
    return { source: "inherited", rules, inheritedFrom: { version: ctx.versionOf.get(dec.testKey) ?? 0, source: "family", decidedBy: dec.decidedBy } };
  }
  if (pending && pending.payload.kind === "family_decision") {
    const p = pending.payload as unknown as AgentPayload;
    const num = typeof p.confidence === "number" ? p.confidence : null;
    return {
      source: "agent",
      rules,
      agent: { proposalId: pending.id, confidence: num, confidenceBand: pending.confidence, diffs: agentDiffs(v.proposed, p) },
    };
  }
  return { source: "rule", rules };
}

export function groupProvenance(ctx: LoopCtx, g: GroupRecord, view: C.Proposal, decided: DecisionRecord | undefined, inherited: C.InheritedDecision | undefined): C.Provenance {
  const rules = ruleRows(ctx, [g.id]);
  if (decided && (decided.kind === "accept" || decided.kind === "correct" || decided.kind === "reject")) return { source: "human", rules, human: { decidedBy: decided.userName, decidedAt: decided.decidedAt } };
  if (inherited) return { source: "inherited", rules, inheritedFrom: { version: inherited.fromVersion, source: inherited.source, ...(inherited.decidedBy ? { decidedBy: inherited.decidedBy } : {}) } };
  if (view.origin === "agent") {
    const agentId = view.sourceProposalIds.find((id) => !id.startsWith("E-")) ?? view.id;
    const diffs: NonNullable<C.Provenance["agent"]>["diffs"] = [];
    if (view.fields.validity.value !== g.validity) diffs.push({ field: "validity", ruleValue: g.validity, agentValue: view.fields.validity.value });
    if (view.fields.owner.value !== g.responsibleDiscipline) diffs.push({ field: "responsibleDiscipline", ruleValue: g.responsibleDiscipline, agentValue: view.fields.owner.value });
    const conf = view.fields.validity.source === "llm" ? view.fields.validity.confidence : null;
    return { source: "agent", rules, agent: { proposalId: agentId, confidence: conf, diffs } };
  }
  return { source: "rule", rules };
}

export async function uncuratedCount(core: Coordinator): Promise<number> {
  return (await core.store.listFeedback()).filter((f) => !f.curated).length;
}

/** Learning of a decision: per-rule deltas of the SAME tally (before/after one test) + global after. */
export async function learningSummary(core: Coordinator, before: AccuracyMap, after: AccuracyMap, globalBefore: AccuracyMap): Promise<C.LearningSummary> {
  return { learning: learningDelta(before, after, globalBefore), uncuratedCorrections: await uncuratedCount(core), curationThreshold: THRESHOLDS.uncuratedFeedback };
}

/** Agent confidence for display when the proposal carries only a band. */
export function bandConfidence(band: string | undefined): number | null {
  return band ? (BAND_CONF[band] ?? null) : null;
}

// ── Cycle dashboard ────────────────────────────────────────────────────────

export async function cycleLoop(
  core: Coordinator,
  projectId: string,
  test: TestRecord,
  groups: readonly C.ClashGroup[],
  families: readonly C.TriageFamily[],
): Promise<C.CycleLoop> {
  const cls = (await core.store.getClassification(test.testKey))!;
  const decided = await core.effectiveDecisions(test.testKey);
  const famOf = new Map<string, C.TriageFamily>();
  for (const f of families) for (const g of f.groupIds) famOf.set(g, f);
  const proposals = { engine: 0, agent: 0 };
  const decisions = { total: groups.length, accepted: 0, corrected: 0, pending: 0, oneByOne: 0 };
  for (const g of groups) {
    const f = g.familyId ? famOf.get(g.id) : undefined;
    const agentProposed = g.provenance?.source === "agent" || (!!f && f.provenance?.source === "agent");
    if (agentProposed) proposals.agent++;
    else proposals.engine++;
    const d = decided.get(g.id);
    if (d && (d.kind === "accept" || d.kind === "correct" || d.kind === "reject")) {
      if (d.kind === "accept" || (d.kind === "correct" && !d.changes.some((c) => c.field === "validity" || c.field === "owner"))) decisions.accepted++;
      else decisions.corrected++;
      continue;
    }
    const inst = f?.instances.find((i) => i.groupId === g.id);
    if (f?.decision?.status === "approved" && inst && (inst.inheritance.state === "inherited" || inst.inheritance.state === "exception")) {
      const gr = cls.groups.find((x) => x.id === g.id);
      if (inst.inheritance.state === "exception" || (gr && (f.decision.validity !== gr.validity || f.decision.responsibleDiscipline !== gr.responsibleDiscipline))) decisions.corrected++;
      else decisions.accepted++;
      continue;
    }
    if (g.inherited && !g.inherited.needsConfirmation) {
      decisions.accepted++;
      continue;
    }
    if (f?.decision?.status === "rejected") decisions.oneByOne++;
    else decisions.pending++;
  }
  // Batch: latest live one of this test.
  const batches = (await core.store.listBatches()).filter((b) => b.testKey === test.testKey && b.state !== "discarded").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const lb = batches[0];
  const acc = { applied: 0, failed: 0 };
  for (const b of batches) for (const i of b.items) if (!i.excluded) {
    if (i.result?.status === "applied") acc.applied++;
    if (i.result?.status === "failed") acc.failed++;
  }
  // Learning: corrections recorded for this project (feedback), rule suggestions and publications.
  const fb = (await core.store.listFeedback()).filter((f) => !f.projectId || bareProjectId(f.projectId) === bareProjectId(projectId));
  const rc = await core.store.listProposals((p) => p.kind === "rule_change");
  let published = 0;
  for (const p of rc) if ((await core.rulePublisher.stage(p)) === "published") published++;
  // Engine accuracy per analysed version of this model set (same tally as Reglas, per test).
  const sameSet = (await core.store.listTests()).filter((t) => t.modelSetId === test.modelSetId && bareProjectId(t.projectId) === bareProjectId(test.projectId)).sort((a, b) => a.modelSetVersion - b.modelSetVersion);
  const accuracyByVersion: C.CycleLoop["accuracyByVersion"] = [];
  for (const t of sameSet) {
    if (!(await core.store.hasClassification(t.testKey))) continue;
    const m = await core.ruleAuthoring.accuracyForTest(t.testKey).catch(() => new Map() as AccuracyMap);
    const tot = mergeInto(new Map(), m);
    let agree = 0;
    let n = 0;
    for (const s of tot.values()) {
      agree += s.agree;
      n += s.n;
    }
    if (n) accuracyByVersion.push({ version: t.modelSetVersion, agree, n, rate: rateOf({ agree, n }) });
  }
  // Agent family proposals of this test: decided (applied / rejected) vs pending; unchanged = the decision equals the payload.
  const fps = await core.store.listProposals((p) => p.kind === "family_decision" && p.testKey === test.testKey);
  const agent = { decided: 0, acceptedUnchanged: 0, rejected: 0, pending: 0 };
  for (const p of fps) {
    if (p.payload.kind !== "family_decision") continue;
    if (PENDING.has(p.state)) agent.pending++;
    else if (p.state === "rejected") {
      agent.decided++;
      agent.rejected++;
    } else if (p.state === "approved" || p.state === "applied") {
      agent.decided++;
      const f = families.find((x) => x.id === (p.payload as { familyId: string }).familyId || x.mergedFrom.includes((p.payload as { familyId: string }).familyId));
      const d = f?.decision;
      const pl = p.payload;
      if (d && d.validity === pl.validity && d.action === pl.action && (!pl.responsibleDiscipline || d.responsibleDiscipline === pl.responsibleDiscipline)) agent.acceptedUnchanged++;
    }
  }
  return {
    projectId: bareProjectId(projectId),
    testKey: test.testKey,
    version: test.modelSetVersion,
    proposals,
    decisions,
    ...(lb ? { batch: { id: lb.id, state: lb.state, items: lb.items.filter((i) => !i.excluded).length, approved: lb.state === "approved" || lb.state === "applied" || lb.state === "partial" } } : {}),
    acc,
    learning: { corrections: fb.filter((f) => f.verdict !== "correct").length, uncurated: fb.filter((f) => !f.curated).length, suggestions: rc.length, published },
    accuracyByVersion,
    agent,
  };
}
