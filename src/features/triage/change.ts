/**
 * "What changed" vocabulary (docs/PLAN-core-features-simplified.md §2):
 * users see 3 words — Nuevo · Cambió · Reapareció — and "sin cambios" hidden.
 * The server sends ClashGroup.change; older payloads derive it from deltaSummary.
 */
import type { ChangeKind, Clash, FamilyGroup, TriageFamily } from "~/lib/api/types";

export const CHANGED: ReadonlySet<ChangeKind> = new Set(["new", "changed", "reappeared"]);

/** Change of a ubicación (group) since the previous version. */
export function groupChange(g: FamilyGroup | undefined): ChangeKind {
  if (!g) return "unchanged";
  if (g.change) return g.change;
  const ds = g.deltaSummary;
  if (!ds) return g.delta === "new" ? "new" : g.delta === "reappeared" ? "reappeared" : g.delta === "modified" ? "changed" : "unchanged";
  if (ds.reappeared > 0) return "reappeared";
  if (ds.new > 0 && ds.persisting === 0 && ds.modified === 0) return "new";
  if (ds.new + ds.modified > 0) return "changed";
  return "unchanged";
}

/** Change word of one clash (out_of_scope is not a change: it is greyed, never "resolved"). */
export function clashChange(c: Clash): ChangeKind | null {
  const d = c.delta as string;
  if (d === "out_of_scope") return null;
  return d === "new" ? "new" : d === "modified" ? "changed" : d === "reappeared" ? "reappeared" : "unchanged";
}

/** Most important change among counts: Reapareció > Cambió > Nuevo. */
export function topChange(counts: Partial<Record<ChangeKind, number>> | undefined): ChangeKind | null {
  if (!counts) return null;
  if (counts.reappeared) return "reappeared";
  if (counts.changed) return "changed";
  if (counts.new) return "new";
  return null;
}

/** changeCounts of a family: server value, else counted from its groups. */
export function familyChangeCounts(f: TriageFamily & { changeCounts?: Partial<Record<ChangeKind, number>> }, groups: Map<string, FamilyGroup>): Partial<Record<ChangeKind, number>> {
  if (f.changeCounts) return f.changeCounts;
  const out: Partial<Record<ChangeKind, number>> = {};
  for (const id of f.groupIds) {
    const k = groupChange(groups.get(id));
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
