/**
 * Clash facts (classification-rules.yaml §4 "ClashFacts") and the per-pair
 * tolerance resolution (discipline-matrix.yaml `tolerances`, first match wins,
 * unordered pairs).
 */
import { withNormCache } from "../rules/matcher";
import type { CompiledRuleSet } from "../rules/load";
import { normAny } from "../util/text";
import type { ElementFacts } from "./element";

export interface ClashFactsInput {
  /** Signed distance in mm (negative = penetration). */
  distanceMm: number;
  /** MC numeric status 1..4, or the mapped string status. */
  status?: number | string;
  /** One element nests in the other (instance tree). Missing -> false. */
  nestedRelation?: boolean;
  /** Another clash of the test pairs a modeled sleeve with the same host around this crossing. */
  coveredBySleeve?: boolean;
}

export interface ClashFacts {
  [field: string]: unknown;
  distanceMm: number;
  penetrationMm: number;
  penetrationRatio?: number;
  status?: number;
  toleranceHardMm: number;
  clearanceMm: number;
  /** Index of the tolerance entry used, -1 for the default. */
  toleranceEntry: number;
  withinTolerance: boolean;
  clearanceViolation: boolean;
  sameDocument: boolean;
  sameModelFile: boolean;
  sameExternalId: boolean;
  sameSystemName: boolean;
  sameFamily: boolean;
  sameType: boolean;
  sameCategory: boolean;
  sameDiscipline: boolean;
  sameLevel: boolean;
  nestedRelation: boolean;
  coveredBySleeve: boolean;
}

const STATUS_CODES: Record<string, number> = { active: 1, reviewed: 2, resolved: 3, closed: 4 };

export function statusCode(s: number | string | undefined): number | undefined {
  if (typeof s === "number") return Number.isFinite(s) ? s : undefined;
  if (typeof s === "string") return STATUS_CODES[s.toLowerCase()] ?? (/^\d+$/.test(s) ? Number(s) : undefined);
  return undefined;
}

/** Tolerance entry for an unordered element pair. */
export function resolveTolerance(rs: CompiledRuleSet, a: ElementFacts, b: ElementFacts): { hardMm: number; clearanceMm: number; index: number } {
  for (const e of rs.tolerances.entries) {
    let ok = true;
    if (e.classes) {
      const [x, y] = e.classes;
      ok = (x(a.elementClass) && y(b.elementClass)) || (x(b.elementClass) && y(a.elementClass));
    }
    if (ok && e.disciplines) {
      const [x, y] = e.disciplines;
      ok = (x(a.discipline, a.disciplineGroup) && y(b.discipline, b.disciplineGroup)) ||
        (x(b.discipline, b.disciplineGroup) && y(a.discipline, a.disciplineGroup));
    }
    if (ok) return { hardMm: e.hardMm, clearanceMm: e.clearanceMm, index: e.index };
  }
  return { ...rs.tolerances.default, index: -1 };
}

function same(a: ElementFacts, b: ElementFacts, f: string): boolean {
  const x = a[f];
  const y = b[f];
  if (x === undefined || x === null || y === undefined || y === null) return false;
  return normAny(x) === normAny(y);
}

export function computeClashFacts(rs: CompiledRuleSet, input: ClashFactsInput, left: ElementFacts, right: ElementFacts): ClashFacts {
  const distanceMm = input.distanceMm;
  const penetrationMm = Math.max(0, -distanceMm);
  const tol = resolveTolerance(rs, left, right);
  const minSize = left.sizeMm !== undefined && right.sizeMm !== undefined ? Math.min(left.sizeMm, right.sizeMm) : undefined;
  const status = statusCode(input.status);
  const facts: ClashFacts = {
    distanceMm,
    penetrationMm,
    ...(distanceMm < 0 && minSize ? { penetrationRatio: penetrationMm / minSize } : {}),
    ...(status !== undefined ? { status } : {}),
    toleranceHardMm: tol.hardMm,
    clearanceMm: tol.clearanceMm,
    toleranceEntry: tol.index,
    withinTolerance: distanceMm < 0 && penetrationMm <= tol.hardMm,
    clearanceViolation: distanceMm >= 0 && distanceMm < tol.clearanceMm,
    sameDocument: same(left, right, "documentId"),
    sameModelFile: same(left, right, "modelFile"),
    sameExternalId: same(left, right, "externalId"),
    sameSystemName: same(left, right, "systemName"),
    sameFamily: same(left, right, "family"),
    sameType: same(left, right, "type"),
    sameCategory: same(left, right, "category"),
    sameDiscipline: same(left, right, "discipline"),
    sameLevel: same(left, right, "level"),
    nestedRelation: input.nestedRelation === true,
    coveredBySleeve: input.coveredBySleeve === true,
  };
  return withNormCache(facts);
}
