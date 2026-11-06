/**
 * Group review policy (docs/ai/harness-design.md §3.1). The harness config
 * uses its own validity vocabulary; the mapping to the domain taxonomy is:
 *   real -> real
 *   false_positive with nature duplicate -> duplicate
 *   false_positive -> false_positive
 *   tolerated -> tolerance
 *   needs_info -> always needs review (no auto-accept)
 * `by_design` / `model_error` have no domain counterpart and are unused here.
 */
import type { Severity, Validity, Nature } from "../rules/schemas";

export interface ReviewPolicy {
  autoAccept: { real: number; false_positive: number; duplicate: number; tolerance: number };
  reviewFloor: number;
  alwaysReview: { severity: Severity[]; minClashCount: number; unmatched: boolean; rulesConflict: boolean };
  /** Methodology: bulk closure of more than this many clashes needs a human. */
  bulkClosureMax: number;
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  autoAccept: { real: 0.8, false_positive: 0.92, duplicate: 0.9, tolerance: 0.92 },
  reviewFloor: 0.55,
  alwaysReview: { severity: ["critical"], minClashCount: 150, unmatched: true, rulesConflict: true },
  bulkClosureMax: 50,
};

export type ConfidenceBand = "alta" | "media" | "baja";

export function autoAcceptThreshold(policy: ReviewPolicy, validity: Validity, nature: Nature): number | undefined {
  switch (validity) {
    case "real": return policy.autoAccept.real;
    case "false_positive": return nature === "duplicate" ? policy.autoAccept.duplicate : policy.autoAccept.false_positive;
    case "tolerated": return policy.autoAccept.tolerance;
    case "needs_info": return undefined;
  }
}

export function confidenceBand(policy: ReviewPolicy, validity: Validity, nature: Nature, confidence: number): ConfidenceBand {
  const t = autoAcceptThreshold(policy, validity, nature);
  if (t !== undefined && confidence >= t) return "alta";
  return confidence >= policy.reviewFloor ? "media" : "baja";
}
