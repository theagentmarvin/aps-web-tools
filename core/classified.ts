/**
 * The engine's per-clash output and side helpers.
 */
import type { Classification } from "./classify";
import type { ClashFacts } from "./enrich/clash";
import type { ElementFacts } from "./enrich/element";
import type { PriorityResult } from "./score";
import type { NormalizedClash } from "./types";

export interface ClassifiedClash {
  /** Identity key: sortedPair(side tokens) (methodology "Clash memory"). */
  key: string;
  /** Representative MC clash id (the worst penetration among duplicates). */
  id: string;
  /** Every MC clash id merged into this one by G0 dedupe (sorted). */
  mcClashIds: string[];
  /** Representative normalized clash (absent for synthetic single evaluations). */
  clash?: NormalizedClash;
  left: ElementFacts;
  right: ElementFacts;
  facts: ClashFacts;
  classification: Classification;
  /** Clash-level priority (groupCount = 1). */
  priority: PriorityResult;
  /** Level of the clash: mover side, else `a` side, else the other side. */
  level?: string;
}

export function sideA(c: ClassifiedClash): ElementFacts {
  return c.classification.binding.a === "left" ? c.left : c.right;
}

export function sideB(c: ClassifiedClash): ElementFacts {
  return c.classification.binding.a === "left" ? c.right : c.left;
}

export function moverOf(c: ClassifiedClash): ElementFacts | undefined {
  const m = c.classification.mover;
  return m === "left" ? c.left : m === "right" ? c.right : undefined;
}

/** The side that does NOT move, if there is a mover. */
export function fixedOf(c: ClassifiedClash): ElementFacts | undefined {
  const m = c.classification.mover;
  return m === "left" ? c.right : m === "right" ? c.left : undefined;
}

/**
 * "Moving side" for run/zone grouping: mover ?? side with lower moveRank ??
 * left (grouping-strategies.md G5). Returns [moverSide, counterpart].
 */
export function moverSideOf(c: ClassifiedClash): [ElementFacts, ElementFacts] {
  const m = moverOf(c);
  if (m) return [m, m === c.left ? c.right : c.left];
  const l = c.left.moveRank;
  const r = c.right.moveRank;
  if (l !== undefined && r !== undefined && l !== r) return l < r ? [c.left, c.right] : [c.right, c.left];
  return [c.left, c.right];
}

/**
 * Stable element token: the pipeline's `elementKey` (externalId, else
 * `<modelFile>:<objectId>`), else externalId, else "?".
 */
export function elementToken(el: ElementFacts): string {
  return (typeof el.elementKey === "string" ? el.elementKey : undefined) ?? el.externalId ?? "?";
}
