/**
 * Who moves (discipline-matrix.yaml `whoMoves`):
 * 1. overrides, in order, on the unordered class pair;
 * 2. otherwise the lower moveRank moves when the ranks differ by more than
 *    `tieThreshold`;
 * 3. tie -> the smaller sizeMm moves; still tied/unknown -> no mover.
 *
 * Resolved ambiguity: a `mover: other` override whose first class matches
 * BOTH sides (e.g. gravity vs gravity) has no defined mover, so it is skipped
 * and resolution continues (it then usually ends in a tie -> no mover).
 */
import type { CompiledRuleSet } from "../rules/load";
import type { ElementFacts } from "../enrich/element";

export interface MoverResult {
  mover?: ElementFacts;
  /** Index of the override used, or "rank" / "size" / "tie". */
  basis: number | "rank" | "size" | "tie" | "unranked";
  approver?: string;
}

export function whoMoves(rs: CompiledRuleSet, a: ElementFacts, b: ElementFacts): MoverResult {
  for (const o of rs.whoMoves.overrides) {
    const ab = o.x(a.elementClass) && o.y(b.elementClass);
    const ba = o.x(b.elementClass) && o.y(a.elementClass);
    if (!ab && !ba) continue;
    const approver = o.approver ? { approver: o.approver } : {};
    if (o.mover === "other") {
      const xa = o.x(a.elementClass);
      const xb = o.x(b.elementClass);
      if (xa && xb) continue; // both sides are the "fixed" class: undefined mover
      return { mover: xa ? b : a, basis: o.index, ...approver };
    }
    const ma = o.mover(a.elementClass);
    const mb = o.mover(b.elementClass);
    if (ma && !mb) return { mover: a, basis: o.index, ...approver };
    if (mb && !ma) return { mover: b, basis: o.index, ...approver };
  }
  if (a.moveRank === undefined || b.moveRank === undefined) return { basis: "unranked" };
  if (Math.abs(a.moveRank - b.moveRank) > rs.whoMoves.tieThreshold) {
    return { mover: a.moveRank < b.moveRank ? a : b, basis: "rank" };
  }
  if (a.sizeMm !== undefined && b.sizeMm !== undefined && a.sizeMm !== b.sizeMm) {
    return { mover: a.sizeMm < b.sizeMm ? a : b, basis: "size" };
  }
  return { basis: "tie" };
}
