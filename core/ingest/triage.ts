/**
 * Derive per-clash triage state from clash groups (research §3.3):
 * `assigned` if in an assigned group's `existing`, `closed` if in a closed
 * group's `existing`, else `open`. Trust this over the raw `status` field.
 */
import type { NormalizedClash, TriageState } from "../types";

/** Shape of `GET tests/{testId}/clashes/assigned|closed` groups (research §3.3). */
export interface GroupIntersection {
  id: string;
  existing?: readonly number[];
  resolved?: readonly number[];
}

export function triageStateIndex(
  assigned: readonly GroupIntersection[],
  closed: readonly GroupIntersection[],
): Map<string, TriageState> {
  const m = new Map<string, TriageState>();
  for (const g of closed) for (const id of g.existing ?? []) m.set(String(id), "closed");
  // Assigned wins over closed if a clash is somehow in both (an issue exists for it).
  for (const g of assigned) for (const id of g.existing ?? []) m.set(String(id), "assigned");
  return m;
}

/** Return copies of the clashes with `triage` filled in. */
export function applyTriageState(
  clashes: readonly NormalizedClash[],
  index: ReadonlyMap<string, TriageState>,
): NormalizedClash[] {
  return clashes.map((c) => ({ ...c, triage: index.get(c.id) ?? "open" }));
}
