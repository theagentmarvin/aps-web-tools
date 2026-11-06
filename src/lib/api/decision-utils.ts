/**
 * Pure helpers shared by the UI store and the mock server: resolving the
 * effective decision of a target, its UI state, and effective field values.
 */
import type {
  ConfidenceBandName,
  Decision,
  DecisionState,
  DisciplineCode,
  Priority,
  Proposal,
  ProposedAction,
  Validity,
} from "./types";

export interface Thresholds {
  high: number;
  medium: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { high: 0.85, medium: 0.6 };

/**
 * Latest effective decision per target. `note` decisions never change state;
 * `undo` removes the decision it references, so the previous one (if any)
 * becomes effective again. Input must be in chronological order.
 */
export function latestDecisions(decisions: Iterable<Decision>): Map<string, Decision> {
  const stacks = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.kind === "note") continue;
    const stack = stacks.get(d.targetId) ?? [];
    if (d.kind === "undo") {
      const idx = stack.findIndex((x) => x.id === d.undoes);
      if (idx >= 0) stack.splice(idx, 1);
    } else {
      stack.push(d);
    }
    stacks.set(d.targetId, stack);
  }
  const out = new Map<string, Decision>();
  for (const [k, s] of stacks) if (s.length) out.set(k, s[s.length - 1]);
  return out;
}

export function decisionState(decision: Decision | undefined, proposal: Proposal | undefined): DecisionState {
  if (!decision) return proposal?.inherited ? "inherited" : "pending";
  switch (decision.kind) {
    case "accept":
      return "accepted";
    case "correct":
      return "corrected";
    case "reject":
      return "rejected";
    case "postpone":
      return "postponed";
    default:
      return "pending";
  }
}

export interface EffectiveValues {
  validity?: Validity;
  priority?: Priority;
  owner?: DisciplineCode;
  action?: ProposedAction;
}

export function effectiveValues(proposal: Proposal | undefined, decision: Decision | undefined): EffectiveValues {
  const base: EffectiveValues = proposal
    ? {
        validity: proposal.fields.validity.value,
        priority: proposal.fields.priority.value,
        owner: proposal.fields.owner.value,
        action: proposal.fields.action.value,
      }
    : {};
  if (!decision || decision.kind === "reject" || decision.kind === "postpone") return base;
  const out = { ...base } as Record<string, unknown>;
  for (const c of decision.changes) {
    if (c.field === "validity" || c.field === "priority" || c.field === "owner" || c.field === "action") {
      out[c.field] = c.humanValue;
    }
  }
  return out as EffectiveValues;
}

export function band(confidence: number, t: Thresholds = DEFAULT_THRESHOLDS): ConfidenceBandName {
  if (confidence >= t.high) return "alta";
  if (confidence >= t.medium) return "media";
  return "baja";
}

/** Weakest-link confidence across proposed fields (spec §4.1). */
export function minConfidence(p: Proposal): number {
  const f = p.fields;
  return Math.min(f.validity.confidence, f.priority.confidence, f.owner.confidence, f.action.confidence);
}

/** Unordered pair key, alphabetical: "CLI:EST". */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
