/**
 * Eval scenarios (docs/domain/eval-scenarios.md): parse the YAML block(s) of
 * the markdown file and run each scenario through the engine. Pure; the
 * caller reads the file.
 */
import YAML from "yaml";
import type { ClassifiedClash } from "../classified";
import type { ElementInput } from "../enrich/element";
import { evaluatePair } from "../pipeline";
import type { CompiledRuleSet } from "../rules/load";

export interface Scenario {
  id: string;
  title: string;
  /** Metres, as in the MC clash resource (negative = penetration). */
  dist: number;
  left: ElementInput;
  right: ElementInput;
  expected: Record<string, unknown>;
  notes?: string;
  groupCount?: number;
  daysToInstall?: number;
}

/** Fields the deterministic engine must match exactly (eval-scenarios.md §1). */
export const ASSERTED_FIELDS = [
  "ruleId", "validity", "nature", "rootCause", "responsibleDiscipline", "secondaryDiscipline", "severity", "band",
] as const;
export type AssertedField = (typeof ASSERTED_FIELDS)[number];

export function parseScenarioMarkdown(md: string): Scenario[] {
  const blocks = [...md.replace(/\r\n/g, "\n").matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const doc = YAML.parse(blocks.join("\n")) as { scenarios?: Scenario[] };
  if (!doc?.scenarios?.length) throw new Error("no scenarios found in markdown");
  return doc.scenarios;
}

export interface ScenarioResult {
  scenario: Scenario;
  clash: ClassifiedClash;
  actual: Record<AssertedField, unknown>;
  /** Fields present in `expected` that differ. */
  diffs: Array<{ field: AssertedField; expected: unknown; actual: unknown }>;
}

export function runScenario(rs: CompiledRuleSet, s: Scenario): ScenarioResult {
  const clash = evaluatePair(rs, { distanceMm: s.dist * 1000, status: 1 }, s.left, s.right, {
    count: s.groupCount ?? 1,
    ...(s.daysToInstall !== undefined ? { daysToInstall: s.daysToInstall } : {}),
    id: s.id,
  });
  const c = clash.classification;
  const actual: Record<AssertedField, unknown> = {
    ruleId: c.ruleId,
    validity: c.validity,
    nature: c.nature,
    rootCause: c.rootCause,
    responsibleDiscipline: c.responsibleDiscipline,
    secondaryDiscipline: c.secondaryDiscipline,
    severity: c.severity,
    band: clash.priority.band,
  };
  const diffs: ScenarioResult["diffs"] = [];
  for (const f of ASSERTED_FIELDS) {
    if (!(f in s.expected)) continue;
    if (s.expected[f] !== actual[f]) diffs.push({ field: f, expected: s.expected[f], actual: actual[f] });
  }
  return { scenario: s, clash, actual, diffs };
}

export interface EvalReport {
  total: number;
  passed: number;
  /** Per field: correct / asserted. */
  fieldAccuracy: Record<AssertedField, { correct: number; asserted: number }>;
  /** expected validity -> actual validity -> count. */
  validityConfusion: Record<string, Record<string, number>>;
  /** Expected real, classified false_positive or tolerated. Must be 0. */
  unsafeClosures: Array<{ id: string; actual: string }>;
  results: ScenarioResult[];
}

export function evaluateScenarios(rs: CompiledRuleSet, scenarios: readonly Scenario[]): EvalReport {
  const results = scenarios.map((s) => runScenario(rs, s));
  const fieldAccuracy = Object.fromEntries(ASSERTED_FIELDS.map((f) => [f, { correct: 0, asserted: 0 }])) as EvalReport["fieldAccuracy"];
  const validityConfusion: EvalReport["validityConfusion"] = {};
  const unsafeClosures: EvalReport["unsafeClosures"] = [];
  for (const r of results) {
    for (const f of ASSERTED_FIELDS) {
      if (!(f in r.scenario.expected)) continue;
      fieldAccuracy[f].asserted++;
      if (r.scenario.expected[f] === r.actual[f]) fieldAccuracy[f].correct++;
    }
    const ev = String(r.scenario.expected.validity ?? "?");
    const av = String(r.actual.validity);
    (validityConfusion[ev] ??= {})[av] = (validityConfusion[ev]![av] ?? 0) + 1;
    if (ev === "real" && (av === "false_positive" || av === "tolerated")) unsafeClosures.push({ id: r.scenario.id, actual: av });
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.diffs.length === 0).length,
    fieldAccuracy,
    validityConfusion,
    unsafeClosures,
    results,
  };
}
