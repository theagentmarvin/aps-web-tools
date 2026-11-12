/**
 * Mock batch building: turns accepted/corrected decisions into field-level
 * BatchItems (what ACC would receive) and recomputes batch counters.
 */
import { effectiveValues, minConfidence } from "../decision-utils";
import type { AccStatus, Batch, BatchItem, Clash, ClashGroup, Decision, IssueDraft, Proposal } from "../types";

const STATUS_ES: Record<AccStatus, string> = { active: "Activa", reviewed: "Revisada", resolved: "Resuelta", closed: "Cerrada" };
const PRIORITY_ES = ["", "P1 Crítica", "P2 Alta", "P3 Media", "P4 Baja"];

export interface BatchSources {
  groups: Map<string, ClashGroup>;
  clashes: Map<string, Clash>;
  proposals: Map<string, Proposal>;
}

export function buildItems(decisions: Decision[], src: BatchSources, reviewer: string): BatchItem[] {
  const items: BatchItem[] = [];
  let seq = 0;
  for (const d of decisions) {
    if (d.kind !== "accept" && d.kind !== "correct") continue;
    const proposal = src.proposals.get(d.proposalId);
    const eff = effectiveValues(proposal, d);
    const group = d.targetType === "group" ? src.groups.get(d.targetId) : src.groups.get(src.clashes.get(d.targetId)?.groupId ?? "");
    const clashIds = d.targetType === "group" ? (group?.clashIds ?? []) : [d.targetId];
    const origin: BatchItem["origin"] = !proposal ? "manual" : d.kind === "accept" ? "ai_accepted" : "ai_corrected";
    const conf = proposal ? minConfidence(proposal) : undefined;
    const common = {
      decisionIds: [d.id],
      proposalIds: proposal ? [proposal.id] : [],
      origin,
      reasonCode: d.reasonCode,
      reviewer,
      aiConfidence: conf,
      lowConfidence: conf !== undefined && conf < 0.6,
      viewedInViewer: d.viewedInViewerMs >= 1500,
      groupId: group?.id,
    };
    const action = eff.action;
    if (action?.setStatus) {
      for (const cid of clashIds) {
        const c = src.clashes.get(cid);
        if (!c || c.status === action.setStatus) continue;
        items.push({
          ...common,
          id: `I-${d.id.slice(0, 8)}-${seq++}`,
          targetType: "clash",
          targetIds: [cid],
          label: cid,
          operation: "clash.setStatus",
          mcOperation: "clash.close",
          fields: [{ field: "Estado", accCurrent: STATUS_ES[c.status], accNew: STATUS_ES[action.setStatus] }],
          accCurrent: c.status,
          accNew: action.setStatus,
        });
      }
    }
    if (action?.createIssue && group) {
      const issue: IssueDraft = proposal?.issueDraft
        ? { ...proposal.issueDraft, ownerDiscipline: eff.owner ?? proposal.issueDraft.ownerDiscipline }
        : {
            title: group.title,
            description: `Interferencias del grupo ${group.id}.`,
            ownerDiscipline: eff.owner ?? group.pair[1],
            dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
            includeView: true,
            linkClashIds: group.clashIds.slice(0, 10),
          };
      const priorityLabel = PRIORITY_ES[eff.priority ?? 3];
      items.push({
        ...common,
        id: `I-${d.id.slice(0, 8)}-${seq++}`,
        targetType: "issue",
        targetIds: [group.id],
        label: group.title,
        operation: "issue.create",
        mcOperation: "clash.assign",
        fields: [
          { field: "Título", accCurrent: null, accNew: issue.title },
          { field: "Asignado a", accCurrent: null, accNew: issue.assigneeRole ?? `Modelador ${issue.ownerDiscipline}` },
          { field: "Prioridad", accCurrent: null, accNew: priorityLabel },
          { field: "Fecha límite", accCurrent: null, accNew: issue.dueDate },
          { field: "Interferencias vinculadas", accCurrent: null, accNew: issue.linkClashIds.length },
        ],
        accNew: { title: issue.title },
        issue: { ...issue, priorityLabel },
      });
    }
  }
  return items;
}

/** Recompute counters from non-excluded items. Mutates and returns the batch. */
export function recount(batch: Batch): Batch {
  const live = batch.items.filter((i) => !i.excluded);
  const transitions = new Map<string, { from: AccStatus; to: AccStatus; count: number }>();
  const byDisc: Record<string, number> = {};
  const decisionOrigin = new Map<string, BatchItem["origin"]>();
  let low = 0;
  let lowViewed = 0;
  for (const i of live) {
    for (const d of i.decisionIds) decisionOrigin.set(d, i.origin);
    if (i.operation === "clash.setStatus") {
      const k = `${i.accCurrent}>${i.accNew}`;
      const t = transitions.get(k) ?? { from: i.accCurrent as AccStatus, to: i.accNew as AccStatus, count: 0 };
      t.count++;
      transitions.set(k, t);
    }
    if (i.operation === "issue.create" && i.issue) byDisc[i.issue.ownerDiscipline] = (byDisc[i.issue.ownerDiscipline] ?? 0) + 1;
    if (i.lowConfidence) {
      low++;
      if (i.viewedInViewer) lowViewed++;
    }
  }
  const origins = [...decisionOrigin.values()];
  batch.counts = {
    issuesCreate: live.filter((i) => i.operation === "issue.create").length,
    statusChanges: live.filter((i) => i.operation === "clash.setStatus").length,
    assignments: 0,
    comments: live.filter((i) => i.operation === "issue.comment").length,
  };
  batch.origin = {
    accepted: origins.filter((o) => o === "ai_accepted").length,
    corrected: origins.filter((o) => o === "ai_corrected").length,
    manual: origins.filter((o) => o === "manual").length,
  };
  batch.review = { humanReviewedPct: 100, lowConfidence: low, lowConfidenceViewed: lowViewed };
  batch.statusTransitions = [...transitions.values()].sort((a, b) => b.count - a.count);
  const issues = live.filter((i) => i.operation === "issue.create");
  batch.issueEffects = { issues: issues.length, clashesLinked: issues.reduce((n, i) => n + (i.issue?.linkClashIds.length ?? 0), 0) };
  batch.issuesByDiscipline = byDisc;
  return batch;
}
