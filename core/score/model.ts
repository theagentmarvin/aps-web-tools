/**
 * Compiled priority-scoring model (rules/priority-scoring.yaml).
 */
import type { LoadIssue } from "../rules/errors";
import {
  FACTOR_NAMES, SEVERITIES, VALIDITIES, NATURES, ROOT_CAUSES, SUGGESTED_ACTIONS,
  type BandName, type FactorName, type PriorityScoring,
} from "../rules/schemas";

/** Fields an override `when` may test (classification output fields + tags). */
export interface OverrideSubject {
  ruleId?: string;
  validity?: string;
  nature?: string;
  rootCause?: string;
  responsibleDiscipline?: string;
  secondaryDiscipline?: string;
  severity?: string;
  suggestedAction?: string;
  humanReview?: boolean;
  tags: readonly string[];
}

const OVERRIDE_FIELDS: Record<string, readonly string[] | null> = {
  ruleId: null,
  validity: VALIDITIES,
  nature: NATURES,
  rootCause: ROOT_CAUSES,
  responsibleDiscipline: null,
  secondaryDiscipline: null,
  severity: SEVERITIES,
  suggestedAction: SUGGESTED_ACTIONS,
  humanReview: null,
  tags: null,
};

export interface CompiledOverride {
  id: string;
  test: (s: OverrideSubject) => boolean;
  set?: { score: number; band: BandName };
  add?: number;
  floor?: number;
  cap?: number;
}

export interface ScoringModel {
  version: number;
  weights: Record<FactorName, number>;
  raw: PriorityScoring;
  zonePatterns: Array<{ re: RegExp; value: number }>;
  overrides: CompiledOverride[];
  bands: Array<{ band: Exclude<BandName, "NONE">; minScore: number; es: string; targetBusinessDays: number }>;
}

export function compileScoring(raw: PriorityScoring, issues: LoadIssue[]): ScoringModel {
  const file = "priority-scoring" as const;
  const sum = FACTOR_NAMES.reduce((s, k) => s + raw.weights[k], 0);
  if (Math.abs(sum - 1) > 0.001) issues.push({ file, path: "weights", message: `weights must sum to 1.00 (got ${sum.toFixed(4)})` });

  const zonePatterns: ScoringModel["zonePatterns"] = [];
  raw.factors.zoneCriticality.patterns.forEach((p, i) => {
    try {
      zonePatterns.push({ re: new RegExp(p.match, "i"), value: p.value });
    } catch (e) {
      issues.push({ file, path: `factors.zoneCriticality.patterns[${i}].match`, message: `invalid regex: ${(e as Error).message}` });
    }
  });

  const overrides: CompiledOverride[] = raw.overrides.map((o, i) => {
    const tests: Array<(s: OverrideSubject) => boolean> = [];
    for (const [k, v] of Object.entries(o.when)) {
      const path = `overrides[${i}].when.${k}`;
      if (!(k in OVERRIDE_FIELDS)) {
        issues.push({ file, path, message: `unknown field '${k}' (allowed: ${Object.keys(OVERRIDE_FIELDS).join(", ")})` });
        continue;
      }
      const values = Array.isArray(v) ? v : [v];
      if (!values.every((x) => typeof x === "string" || typeof x === "boolean")) {
        issues.push({ file, path, message: "value must be a scalar or a list of scalars" });
        continue;
      }
      const allowed = OVERRIDE_FIELDS[k];
      for (const x of values) {
        if (allowed && !allowed.includes(String(x))) issues.push({ file, path, message: `unknown ${k} value '${String(x)}'` });
      }
      if (k === "tags") tests.push((s) => values.some((t) => s.tags.includes(String(t))));
      else tests.push((s) => values.some((x) => (s as unknown as Record<string, unknown>)[k] === x));
    }
    if (o.set === undefined && o.add === undefined && o.floor === undefined && o.cap === undefined) {
      issues.push({ file, path: `overrides[${i}]`, message: "override needs one of set, add, floor, cap" });
    }
    return {
      id: o.id,
      test: (s) => tests.every((t) => t(s)),
      ...(o.set ? { set: o.set } : {}),
      ...(o.add !== undefined ? { add: o.add } : {}),
      ...(o.floor !== undefined ? { floor: o.floor } : {}),
      ...(o.cap !== undefined ? { cap: o.cap } : {}),
    };
  });

  const bands = [...raw.bands];
  for (let i = 1; i < bands.length; i++) {
    if (bands[i]!.minScore >= bands[i - 1]!.minScore) issues.push({ file, path: `bands[${i}].minScore`, message: "bands must be listed top-down with strictly decreasing minScore" });
  }
  if (bands.length && bands[bands.length - 1]!.minScore !== 0) issues.push({ file, path: `bands[${bands.length - 1}].minScore`, message: "the last band must have minScore 0" });

  return { version: raw.version, weights: { ...raw.weights }, raw, zonePatterns, overrides, bands };
}
