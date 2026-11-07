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

/**
 * Calibration (engine review 2026-11, docs/domain/engine-review-2026-11.md §4):
 * - real 0.75: auto-accepting "real" never closes anything; it only queues an
 *   issue draft that a human approves. MM-010 (0.75) is reliable on validity.
 * - false_positive 0.88 / tolerance 0.85: deterministic geometry/practice rules
 *   (FP-003/006/010/013/014, TOL-001/003) clear; heuristics (FP-002, FP-007/009,
 *   TOL-004/005/007/008, AE-003, DUP-004/5/6) stay in review.
 * - Safety triggers that no threshold can bypass: critical severity, closing
 *   with seguridad_personas, structural openings (isStructuralOpening).
 */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  autoAccept: { real: 0.75, false_positive: 0.88, duplicate: 0.9, tolerance: 0.85 },
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

/** Tag for penetrations/embedments in structure (engine-native, see classify). */
export const STRUCTURAL_OPENING_TAG = "pasada_estructural";

/**
 * Structural opening or embedment (tag `pasada_estructural`): closing it or
 * asking for the opening means accepting a penetration in structure, which only
 * the calculista can approve (methodology "always human"). Hard-coded on
 * purpose: it is NOT part of ReviewPolicy and cannot be configured away.
 */
export function isStructuralOpening(validity: Validity, rootCause: string, tags: ReadonlySet<string>): boolean {
  const closable = validity === "false_positive" || validity === "tolerated";
  return tags.has(STRUCTURAL_OPENING_TAG) && (closable || rootCause === "missing_opening");
}
