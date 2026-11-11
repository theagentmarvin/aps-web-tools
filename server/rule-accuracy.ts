/**
 * Rule accuracy ("acierto") — ONE implementation shared by the Reglas page (RuleAuthoring.accuracy),
 * the decision previews / receipts (learning deltas) and the cycle dashboard. The UI never recomputes
 * it: every number of a receipt is the difference of two tallies made by this module.
 *
 * Semantics (docs/ux/agent-human-loop-proposal.md §2 P2):
 *  - an individual decision (accept / correct / reject) counts once, against the dominant rule of the
 *    ubicación (`ruleIds[0]`); `carriedFrom` decisions are not counted;
 *  - a group ("familia") decision counts once per covered ubicación WITHOUT its own decision, on the
 *    version it was taken on; same validity and responsible = agreement (correcting only the action
 *    is still a hit); "Decidir una por una" (rejected family) is not counted.
 */
import type { DecisionRecord, GroupRecord } from "./store/types";
import { VALIDITY_ES } from "./rule-effect";
import { round } from "./util";

export const MIN_ACCURACY_N = 5;
/** Below this rate (with n ≥ MIN_ACCURACY_N) a rule is "por calibrar" on the Reglas page. */
export const CALIBRATE_RATE = 0.7;

export interface RuleTally {
  agree: number;
  n: number;
  corrections: Map<string, number>;
}
export type AccuracyMap = Map<string, RuleTally>;

/** Minimal family decision shape the tally needs. */
export interface TallyFamilyDecision {
  status: string;
  testKey: string;
  validity: string;
  responsibleDiscipline: string;
  coveredGroupIds: string[];
}

const val = (v: unknown) => VALIDITY_ES[String(v).replace(/"/g, "")] ?? String(v);

function bump(out: AccuracyMap, rule: string, agree: boolean, label?: string) {
  const s = out.get(rule) ?? { agree: 0, n: 0, corrections: new Map<string, number>() };
  s.n++;
  if (agree) s.agree++;
  else if (label) s.corrections.set(label, (s.corrections.get(label) ?? 0) + 1);
  out.set(rule, s);
}

/** Tally of ONE classified test. */
export function tallyTest(input: {
  testKey: string;
  groups: readonly Pick<GroupRecord, "id" | "ruleIds" | "validity" | "responsibleDiscipline">[];
  decided: ReadonlyMap<string, Pick<DecisionRecord, "kind" | "changes" | "carriedFrom">>;
  familyDecisions: ReadonlyArray<TallyFamilyDecision | undefined>;
}): AccuracyMap {
  const out: AccuracyMap = new Map();
  const gById = new Map(input.groups.map((g) => [g.id, g]));
  for (const [gid, d] of input.decided) {
    const r = gById.get(gid)?.ruleIds[0];
    if (!r || (d.kind !== "accept" && d.kind !== "correct" && d.kind !== "reject") || d.carriedFrom) continue;
    const vc = d.changes.find((c) => c.field === "validity");
    const oc = d.changes.find((c) => c.field === "owner");
    const agree = d.kind === "accept" || (d.kind === "correct" && !vc && !oc);
    const label = agree ? undefined : d.kind === "reject" ? "propuesta rechazada" : vc ? `${val(vc.aiValue)} → ${val(vc.humanValue)}` : `responsable ${String(oc!.aiValue)} → ${String(oc!.humanValue)}`;
    bump(out, r, agree, label);
  }
  for (const dec of input.familyDecisions) {
    if (!dec || dec.status !== "approved" || dec.testKey !== input.testKey) continue;
    for (const gid of dec.coveredGroupIds) {
      if (input.decided.has(gid)) continue;
      const g = gById.get(gid);
      const r = g?.ruleIds[0];
      if (!g || !r) continue;
      const sameValidity = dec.validity === g.validity;
      const sameOwner = dec.responsibleDiscipline === g.responsibleDiscipline;
      bump(out, r, sameValidity && sameOwner, !sameValidity ? `${val(g.validity)} → ${val(dec.validity)}` : `responsable ${g.responsibleDiscipline} → ${dec.responsibleDiscipline}`);
    }
  }
  return out;
}

export function mergeInto(into: AccuracyMap, add: AccuracyMap): AccuracyMap {
  for (const [r, s] of add) {
    const e = into.get(r) ?? { agree: 0, n: 0, corrections: new Map<string, number>() };
    e.agree += s.agree;
    e.n += s.n;
    for (const [k, c] of s.corrections) e.corrections.set(k, (e.corrections.get(k) ?? 0) + c);
    into.set(r, e);
  }
  return into;
}

export function rateOf(s: { agree: number; n: number } | undefined): number | null {
  return s && s.n >= MIN_ACCURACY_N ? round(s.agree / s.n, 3) : null;
}

export function topCorrection(s: RuleTally | undefined): string | undefined {
  return s ? [...s.corrections.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] : undefined;
}

/** What one decision taught a rule (contract: LearningEntry). */
export interface LearningDelta {
  ruleId: string;
  hits: number;
  corrections: Array<{ label: string; count: number; total: number }>;
  /** Rate and n after the decision (global, all classified tests). */
  after: { rate: number | null; n: number };
  /** The rule fell below CALIBRATE_RATE with this decision. */
  thresholdCrossed?: { rate: number; n: number };
}

/**
 * Per-rule difference between two tallies of the SAME test (before / after a decision), plus the
 * global accuracy after it (`globalBefore` + delta). Rules with no change are omitted.
 */
export function learningDelta(before: AccuracyMap, after: AccuracyMap, globalBefore: AccuracyMap): LearningDelta[] {
  const out: LearningDelta[] = [];
  for (const r of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(r) ?? { agree: 0, n: 0, corrections: new Map<string, number>() };
    const a = after.get(r) ?? { agree: 0, n: 0, corrections: new Map<string, number>() };
    const hits = a.agree - b.agree;
    const corrections: LearningDelta["corrections"] = [];
    const g = globalBefore.get(r);
    for (const k of new Set([...a.corrections.keys(), ...b.corrections.keys()])) {
      const d = (a.corrections.get(k) ?? 0) - (b.corrections.get(k) ?? 0);
      if (d !== 0) corrections.push({ label: k, count: d, total: Math.max(0, (g?.corrections.get(k) ?? 0) + d) });
    }
    if (hits === 0 && !corrections.length && a.n === b.n) continue;
    const gAfter = { agree: (g?.agree ?? 0) + hits, n: (g?.n ?? 0) + (a.n - b.n) };
    const rateBefore = rateOf(g);
    const rateAfter = rateOf(gAfter);
    const crossed = rateAfter !== null && rateAfter < CALIBRATE_RATE && (rateBefore === null || rateBefore >= CALIBRATE_RATE);
    out.push({ ruleId: r, hits, corrections: corrections.sort((x, y) => y.count - x.count), after: { rate: rateAfter, n: gAfter.n }, ...(crossed ? { thresholdCrossed: { rate: rateAfter!, n: gAfter.n } } : {}) });
  }
  return out.sort((x, y) => y.hits + y.corrections.reduce((n, c) => n + c.count, 0) - (x.hits + x.corrections.reduce((n, c) => n + c.count, 0)) || x.ruleId.localeCompare(y.ruleId));
}
