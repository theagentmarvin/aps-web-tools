/**
 * Compare two clash test versions.
 *
 * Matching order:
 * 1. Stable MC clash id. research §3.2 (T:clash): `id` "is stable across
 *    successive model set versions".
 * 2. Fallback `pairKey` (sorted element externalIds, see ./pair-key.ts) for
 *    clashes whose id did not match, e.g. when a document was replaced in the
 *    model set (new lineage → new clash ids). This follows
 *    docs/domain/clash-triage-methodology.md "Clash memory".
 *
 * Unmatched prev clashes are `element_deleted` when a side's element token is
 * missing from `nextElementKeys`, else `resolved`. Unmatched next clashes are
 * `reappeared` when their id or pairKey is in `history`, else `new`.
 */
import type { ClashDiff, DiffState } from "../types";
import { pairKeyTokens } from "./pair-key";

export interface DiffOptions {
  /** Clash ids and/or pairKeys seen in any version OLDER than `prev`. */
  history?: Iterable<string>;
  /**
   * Every element token (externalId, or `<lineage>:<objectId>` fallback) that
   * exists in the NEXT model set version — all elements, not only clashing
   * ones. Without it `element_deleted` cannot be detected and those clashes
   * are reported as `resolved`.
   */
  nextElementKeys?: Iterable<string>;
  /**
   * X6 scope guard: a prev clash left unmatched for which this returns true is
   * `out_of_scope` instead of resolved / element_deleted.
   */
  outOfScope?: (prevClash: DiffableClash) => boolean;
}

export interface DiffableClash {
  id: string;
  pairKey?: string;
}

const byNumericThenText = (a: string, b: string): number => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

export function diffTestVersions<T extends DiffableClash>(
  prev: readonly T[],
  next: readonly T[],
  options: DiffOptions = {},
): ClashDiff {
  const history = new Set(options.history ?? []);
  const elementKeys = options.nextElementKeys ? new Set(options.nextElementKeys) : undefined;

  const result: ClashDiff = {
    new: [],
    persisting: [],
    resolved: [],
    element_deleted: [],
    reappeared: [],
    out_of_scope: [],
    matchedByPairKey: [],
    counts: { new: 0, persisting: 0, resolved: 0, element_deleted: 0, reappeared: 0, out_of_scope: 0 },
  };
  const push = (state: DiffState, id: string): void => {
    result[state].push(id);
    result.counts[state]++;
  };

  // 1. Match by clash id.
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const matchedPrev = new Set<string>();
  const unmatchedNext: T[] = [];
  const seenNext = new Set<string>();
  for (const c of next) {
    if (seenNext.has(c.id)) continue;
    seenNext.add(c.id);
    if (prevById.has(c.id)) {
      matchedPrev.add(c.id);
      push("persisting", c.id);
    } else unmatchedNext.push(c);
  }

  // 2. Fallback by pairKey among the leftovers (first come, first matched).
  const prevByPair = new Map<string, T[]>();
  for (const c of prevById.values()) {
    if (matchedPrev.has(c.id) || !c.pairKey) continue;
    const list = prevByPair.get(c.pairKey);
    if (list) list.push(c);
    else prevByPair.set(c.pairKey, [c]);
  }
  for (const c of unmatchedNext) {
    const candidate = c.pairKey ? prevByPair.get(c.pairKey)?.shift() : undefined;
    if (candidate && c.pairKey) {
      matchedPrev.add(candidate.id);
      push("persisting", c.id);
      result.matchedByPairKey.push({ prevId: candidate.id, nextId: c.id, pairKey: c.pairKey });
    } else if (history.has(c.id) || (c.pairKey !== undefined && history.has(c.pairKey))) {
      push("reappeared", c.id);
    } else {
      push("new", c.id);
    }
  }

  // 3. Prev leftovers: deleted element vs resolved.
  for (const c of prevById.values()) {
    if (matchedPrev.has(c.id)) continue;
    if (options.outOfScope?.(c)) {
      push("out_of_scope", c.id);
      continue;
    }
    const deleted = elementKeys && c.pairKey ? pairKeyTokens(c.pairKey).some((t) => !elementKeys.has(t)) : false;
    push(deleted ? "element_deleted" : "resolved", c.id);
  }

  for (const s of ["new", "persisting", "resolved", "element_deleted", "reappeared", "out_of_scope"] as const) {
    result[s].sort(byNumericThenText);
  }
  return result;
}

/**
 * Map each clash id to its diff state. Ids of `next` get new / persisting /
 * reappeared; ids of `prev` get resolved / element_deleted.
 */
export function diffStateIndex(diff: ClashDiff): Map<string, DiffState> {
  const m = new Map<string, DiffState>();
  for (const s of ["resolved", "element_deleted", "out_of_scope", "new", "persisting", "reappeared"] as const) {
    for (const k of diff[s]) m.set(k, s);
  }
  return m;
}
