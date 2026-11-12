/**
 * Priority scoring (rules/priority-scoring.yaml): weighted factors -> 0..100,
 * overrides, clamp, band. Every result carries a per-factor breakdown so the
 * UI can explain the number.
 *
 * Resolved ambiguity: an override with `set` is terminal (later overrides are
 * not applied), so a non-issue always stays at 0 / NONE even if it is also
 * tagged `regresion`.
 */
import type { CompiledRuleSet } from "../rules/load";
import { FACTOR_NAMES, type BandName, type FactorName } from "../rules/schemas";
import { norm } from "../util/text";
import type { OverrideSubject } from "./model";

export type { OverrideSubject, ScoringModel } from "./model";
export { compileScoring } from "./model";

export interface FactorDetail {
  /** Input used (mm, days, count, level, discipline pair…) or null when missing. */
  input: number | string | null;
  /** Factor value in [0, 1]. */
  value: number;
  weight: number;
  /** weight * value * 100 (points). */
  points: number;
}

export interface PriorityResult {
  score: number;
  band: BandName;
  /** round(100 * weighted sum), before overrides. */
  rawScore: number;
  factors: Record<FactorName, FactorDetail>;
  /** Override ids applied, in order. */
  overrides: string[];
}

export interface ScoreInput {
  subject: OverrideSubject;
  disciplines: readonly [string | undefined, string | undefined];
  distanceMm?: number;
  penetrationMm?: number;
  /** Size of the moving element (see elementSizeInput). */
  sizeMm?: number;
  levels: readonly (string | undefined)[];
  /** Clashes represented (1 for a single clash). */
  count?: number;
  /** Days until installation (schedule); missing -> neutral. */
  daysToInstall?: number;
}

export interface ScoreOptions {
  /** Project zone patterns (`.coordinator/project.yaml`), evaluated BEFORE the defaults. */
  zonePatterns?: ReadonlyArray<{ match: string | RegExp; value: number }>;
}

export type FactorValues = Record<FactorName, { input: number | string | null; value: number }>;

/** Piecewise-linear curve: x <= x0 -> y0; x >= xn -> yn; linear in between. */
export function curve(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = points[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    if (x <= x1) {
      const [x0, y0] = points[i - 1]!;
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1]![1];
}

function compileZones(opts: ScoreOptions | undefined): Array<{ re: RegExp; value: number }> {
  return (opts?.zonePatterns ?? []).map((p) => ({ re: typeof p.match === "string" ? new RegExp(p.match, "i") : p.match, value: p.value }));
}

const zoneCache = new WeakMap<object, Array<{ re: RegExp; value: number }>>();
function projectZones(opts: ScoreOptions | undefined): Array<{ re: RegExp; value: number }> {
  if (!opts) return [];
  let z = zoneCache.get(opts);
  if (!z) {
    z = compileZones(opts);
    zoneCache.set(opts, z);
  }
  return z;
}

/** Zone factor of one level name, or undefined when the level is missing. */
export function zoneValue(rs: CompiledRuleSet, level: string | undefined, opts?: ScoreOptions): number | undefined {
  if (level === undefined || level === null || level === "") return undefined;
  const n = norm(level);
  for (const p of projectZones(opts)) if (p.re.test(n)) return p.value;
  for (const p of rs.scoring.zonePatterns) if (p.re.test(n)) return p.value;
  return rs.scoring.raw.factors.zoneCriticality.missing;
}

/** Compute the raw factor values of one clash (or one group's representative). */
export function computeFactors(rs: CompiledRuleSet, input: ScoreInput, opts?: ScoreOptions): FactorValues {
  const F = rs.scoring.raw.factors;
  const sev = input.subject.severity;
  const severity = sev !== undefined && sev in F.severity.map
    ? { input: sev, value: F.severity.map[sev as keyof typeof F.severity.map] }
    : { input: null, value: F.severity.missing };

  const [da, db] = input.disciplines;
  const ca = da ? rs.disciplines.get(da)?.criticality : undefined;
  const cb = db ? rs.disciplines.get(db)?.criticality : undefined;
  let disciplineCriticality: FactorValues["disciplineCriticality"];
  if (ca === undefined && cb === undefined) disciplineCriticality = { input: null, value: F.disciplineCriticality.missing };
  else {
    const x = ca ?? F.disciplineCriticality.missing;
    const y = cb ?? F.disciplineCriticality.missing;
    disciplineCriticality = {
      input: [da, db].filter(Boolean).join("×"),
      value: F.disciplineCriticality.combine.maxWeight * Math.max(x, y) + F.disciplineCriticality.combine.minWeight * Math.min(x, y),
    };
  }

  let penetration: FactorValues["penetration"];
  if (input.distanceMm === undefined || input.distanceMm === null || Number.isNaN(input.distanceMm)) {
    penetration = { input: null, value: F.penetration.missing };
  } else if (input.distanceMm >= 0 || input.subject.nature === "clearance") {
    penetration = { input: input.penetrationMm ?? 0, value: F.penetration.clearanceValue };
  } else {
    const p = input.penetrationMm ?? Math.max(0, -input.distanceMm);
    penetration = { input: p, value: curve(F.penetration.points, p) };
  }

  const elementSize = input.sizeMm !== undefined
    ? { input: input.sizeMm, value: curve(F.elementSize.points, input.sizeMm) }
    : { input: null, value: F.elementSize.missing };

  let zoneBest: number | undefined;
  let zoneLevel: string | null = null;
  for (const lvl of input.levels) {
    const v = zoneValue(rs, lvl, opts) ?? F.zoneCriticality.missing;
    if (zoneBest === undefined || v > zoneBest) {
      zoneBest = v;
      zoneLevel = lvl ?? null;
    }
  }
  const zoneCriticality = { input: zoneLevel, value: zoneBest ?? F.zoneCriticality.missing };

  const groupCount = input.count === undefined
    ? { input: null, value: F.groupCount.missing }
    : { input: input.count, value: input.count <= 1 ? 0 : Math.min(1, Math.log10(input.count) / Math.log10(F.groupCount.saturation)) };

  const scheduleProximity = input.daysToInstall === undefined
    ? { input: null, value: F.scheduleProximity.missing }
    : { input: input.daysToInstall, value: curve(F.scheduleProximity.points, input.daysToInstall) };

  return { severity, disciplineCriticality, penetration, elementSize, zoneCriticality, groupCount, scheduleProximity };
}

/** Weighted sum + overrides + clamp + band. */
export function scoreFromFactors(rs: CompiledRuleSet, values: FactorValues, subject: OverrideSubject): PriorityResult {
  const factors = {} as Record<FactorName, FactorDetail>;
  let sum = 0;
  for (const k of FACTOR_NAMES) {
    const w = rs.scoring.weights[k];
    const v = values[k];
    sum += w * v.value;
    factors[k] = { input: v.input, value: round4(v.value), weight: w, points: round4(100 * w * v.value) };
  }
  const rawScore = Math.round(100 * sum);
  let score = rawScore;
  let band: BandName | undefined;
  const applied: string[] = [];
  for (const o of rs.scoring.overrides) {
    if (!o.test(subject)) continue;
    applied.push(o.id);
    if (o.set) {
      score = o.set.score;
      band = o.set.band;
      break;
    }
    if (o.add !== undefined) score += o.add;
    if (o.floor !== undefined) score = Math.max(score, o.floor);
    if (o.cap !== undefined) score = Math.min(score, o.cap);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  band ??= bandOf(rs, score);
  return { score, band, rawScore, factors, overrides: applied };
}

export function bandOf(rs: CompiledRuleSet, score: number): BandName {
  for (const b of rs.scoring.bands) if (score >= b.minScore) return b.band;
  return rs.scoring.bands[rs.scoring.bands.length - 1]!.band;
}

export function scoreClash(rs: CompiledRuleSet, input: ScoreInput, opts?: ScoreOptions): PriorityResult {
  return scoreFromFactors(rs, computeFactors(rs, input, opts), input.subject);
}

/**
 * Element-size input: the moving element's size; without a mover, the max
 * size of the MEP side(s); else the max of both. Undefined when unknown.
 */
export function elementSizeInput(
  a: { sizeMm?: number; disciplineGroup?: string },
  b: { sizeMm?: number; disciplineGroup?: string },
  mover?: { sizeMm?: number },
): number | undefined {
  if (mover?.sizeMm !== undefined) return mover.sizeMm;
  const sizes = (els: Array<{ sizeMm?: number }>) => {
    const s = els.map((e) => e.sizeMm).filter((x): x is number => x !== undefined);
    return s.length ? Math.max(...s) : undefined;
  };
  const mep = [a, b].filter((e) => e.disciplineGroup === "MEP");
  return sizes(mep) ?? sizes([a, b]);
}

/** Band metadata (Spanish label, target business days). */
export function bandInfo(rs: CompiledRuleSet, band: BandName): { es: string; targetBusinessDays?: number } {
  const b = rs.scoring.bands.find((x) => x.band === band);
  return b ? { es: b.es, targetBusinessDays: b.targetBusinessDays } : { es: "Sin prioridad (no es problema)" };
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
