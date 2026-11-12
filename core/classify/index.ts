/**
 * Rule evaluation (classification-rules.yaml §1–3, §6): first match wins,
 * symmetric side binding, annotations, discipline refs, Spanish rationale and
 * the mandatory post-processing.
 */
import type { ElementFacts } from "../enrich/element";
import type { ClashFacts } from "../enrich/clash";
import type { CompiledRuleSet, CompiledWhen, DisciplineRef, TemplatePart } from "../rules/load";
import type { Nature, RootCause, Severity, SuggestedAction, Validity } from "../rules/schemas";
import { STRUCTURAL_OPENING_TAG } from "../group/review";
import { capitalize, cmpStr } from "../util/text";
import { whoMoves } from "./who-moves";

export { whoMoves } from "./who-moves";

export type Side = "left" | "right";
export type ClassificationSource = "rule" | "llm" | "rule+llm";

/** Human-review threshold from the rules header (post-processing). */
export const HUMAN_REVIEW_CONFIDENCE = 0.7;
/** ruleId used when no rule matched (only possible without a catch-all rule). */
export const UNMATCHED_RULE_ID = "NONE";

export interface Classification {
  ruleId: string;
  ruleName: string;
  /** Spanish rule name from the rule YAML (`nameEs`), when present. */
  ruleNameEs?: string;
  /** `version` of classification-rules.yaml. */
  ruleVersion: number;
  validity: Validity;
  nature: Nature;
  rootCause: RootCause;
  responsibleDiscipline: string;
  secondaryDiscipline?: string;
  /** Raw side that moves per whoMoves (undefined = no mover / tie). */
  mover?: Side;
  moverDiscipline?: string;
  /** Approver from the who-moves override, when any. */
  approver?: string;
  severity: Severity;
  confidence: number;
  suggestedAction: SuggestedAction;
  humanReview: boolean;
  /** Why humanReview is true (rule, critical, low confidence, needs_info). */
  humanReviewReasons: string[];
  tags: string[];
  /** Annotation notes (Spanish). */
  notes: string[];
  /** Spanish rationale with placeholders resolved. */
  rationale: string;
  source: ClassificationSource;
  /** Which raw side was bound to `a` (auditability). */
  binding: { a: Side };
}

export interface ClassifyResult {
  classification: Classification;
  /** Bound sides. */
  a: ElementFacts;
  b: ElementFacts;
  mover?: ElementFacts;
}

export interface Binding {
  a: ElementFacts;
  b: ElementFacts;
  aSide: Side;
}

/**
 * Try a `when` in orientation 1 (a = first) then 2 (a = second) when symmetric.
 * `first`/`second` is the preferred orientation (see preferredOrder), so the
 * binding never depends on ACC's arbitrary left/right. `left` is only used to
 * report which raw side was bound to `a`.
 */
export function bindWhen(w: CompiledWhen, first: ElementFacts, second: ElementFacts, clash: ClashFacts, left: ElementFacts = first): Binding | null {
  const n = w.symmetric ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? first : second;
    const b = i === 0 ? second : first;
    const ctx = { a, b, clash };
    if (w.clash && !w.clash(clash, ctx)) continue;
    if (w.a && !w.a(a, ctx)) continue;
    if (w.b && !w.b(b, ctx)) continue;
    if (w.both && !(w.both(a, ctx) && w.both(b, ctx))) continue;
    return { a, b, aSide: a === left ? "left" : "right" };
  }
  return null;
}

const tokenOf = (e: ElementFacts) => String(e.elementKey ?? e.externalId ?? "");

/**
 * Preferred orientation (engine review resolution 12): the mover side first;
 * without a mover, the side whose discipline sorts first; then the element
 * token; only then ACC's left/right.
 */
export function preferredOrder(rs: CompiledRuleSet, left: ElementFacts, right: ElementFacts): [ElementFacts, ElementFacts] {
  const m = whoMoves(rs, left, right).mover;
  if (m) return m === left ? [left, right] : [right, left];
  const s = (e: ElementFacts, k: string) => String(e[k] ?? "");
  const d = cmpStr(left.discipline, right.discipline) || cmpStr(tokenOf(left), tokenOf(right)) ||
    cmpStr(s(left, "modelFile"), s(right, "modelFile")) || cmpStr(s(left, "documentName"), s(right, "documentName")) ||
    cmpStr(s(left, "documentId"), s(right, "documentId"));
  return d <= 0 ? [left, right] : [right, left];
}

/** Sentinel rendered for {mover.discipline}/{other.discipline} when nobody moves. */
const NO_MOVER = "\u0000NOMOVER\u0000";
const NO_MOVER_TEXT = "coordinación define quién desvía (sin jerarquía clara)";

/** Never render "mueve COORD": rewrite the mover phrase when there is no mover. */
export function rewriteNoMover(text: string): string {
  if (!text.includes(NO_MOVER)) return text;
  return text
    .replace(/(Según jerarquía de desplazamiento\s+)?(mueve|desplaza|debe desplazarse)\s+\u0000NOMOVER\u0000/gi, (_m, _p, _v, offset: number, all: string) => {
      const before = all.slice(0, offset).trimEnd();
      const sentenceStart = before === "" || /[.:!?]$/.test(before);
      return sentenceStart ? NO_MOVER_TEXT[0]!.toUpperCase() + NO_MOVER_TEXT.slice(1) : NO_MOVER_TEXT;
    })
    .replace(/\u0000NOMOVER\u0000/g, "coordinación");
}

/** Engine-native structural opening test (hard-coded; mirrors proposed ANN-007). */
function isStructuralPenetration(rs: CompiledRuleSet, l: ElementFacts, r: ElementFacts, clash: ClashFacts): boolean {
  if (!(clash.penetrationMm > 0) || clash.withinTolerance) return false;
  const structure = rs.classSets.get("STRUCTURE");
  const mep = rs.classSets.get("MEP_ANY");
  const isStruct = (e: ElementFacts) => structure?.has(e.elementClass) ?? false;
  const crosses = (e: ElementFacts) => (mep?.has(e.elementClass) ?? false) || e.isSleeveOrOpening === true;
  return (isStruct(l) && crosses(r)) || (isStruct(r) && crosses(l));
}

function resolveRef(ref: DisciplineRef, a: ElementFacts, b: ElementFacts, mover: ElementFacts | undefined): string {
  switch (ref.kind) {
    case "literal": return ref.code;
    case "a": return a.discipline;
    case "b": return b.discipline;
    case "mover": return mover ? mover.discipline : "COORD";
    case "other": return mover ? (mover === a ? b : a).discipline : "COORD";
  }
}

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v)) : "—";
  if (typeof v === "boolean") return v ? "sí" : "no";
  return String(v);
}

/** Render a compiled template (rationale or note). */
export function renderTemplate(
  rs: CompiledRuleSet,
  parts: readonly TemplatePart[],
  a: ElementFacts,
  b: ElementFacts,
  clash: ClashFacts,
  mover: ElementFacts | undefined,
): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") {
      out += p;
      continue;
    }
    if (p.side === "clash") {
      out += fmt(clash[p.field]);
      continue;
    }
    const el = p.side === "a" ? a : p.side === "b" ? b : p.side === "mover" ? mover : mover ? (mover === a ? b : a) : undefined;
    if (!el) {
      // No mover (tie): rewritten by rewriteNoMover, never "mueve COORD".
      out += p.field === "discipline" ? NO_MOVER : "—";
      continue;
    }
    if (p.field === "category") out += fmt(el.category ? rs.categoryLabelsEs.get(el.category) ?? el.category : undefined);
    else if (p.field === "systemClassification") out += fmt(el.systemClassificationRaw ?? el.systemClassification);
    else out += fmt(el[p.field]);
  }
  return out;
}

/**
 * Classify one clash. `extraTags` (e.g. `regresion` from the re-test diff) are
 * merged into the tags before post-processing.
 */
export function classifyPair(
  rs: CompiledRuleSet,
  clash: ClashFacts,
  left: ElementFacts,
  right: ElementFacts,
  extraTags: readonly string[] = [],
): ClassifyResult {
  let bound: Binding | null = null;
  let ruleIdx = -1;
  const [first, second] = preferredOrder(rs, left, right);
  for (let i = 0; i < rs.rules.length; i++) {
    bound = bindWhen(rs.rules[i]!.when, first, second, clash, left);
    if (bound) {
      ruleIdx = i;
      break;
    }
  }
  const { a, b, aSide } = bound ?? { a: first, b: second, aSide: (first === left ? "left" : "right") as Side };
  const mv = whoMoves(rs, a, b);
  const mover = mv.mover;
  const moverSide: Side | undefined = mover ? (mover === left ? "left" : "right") : undefined;

  const tags: string[] = [];
  const notes: string[] = [];
  const addTag = (t: string) => {
    if (!tags.includes(t)) tags.push(t);
  };

  let c: Classification;
  if (ruleIdx >= 0) {
    const rule = rs.rules[ruleIdx]!;
    const t = rule.then;
    const nonIssue = t.validity === "false_positive" || t.validity === "tolerated";
    c = {
      ruleId: rule.id,
      ruleName: rule.name,
      ...(rule.nameEs ? { ruleNameEs: rule.nameEs } : {}),
      ruleVersion: rs.versions.rules,
      validity: t.validity,
      nature: t.nature,
      rootCause: t.rootCause,
      responsibleDiscipline: resolveRef(rule.responsible, a, b, mover),
      ...(rule.secondary ? { secondaryDiscipline: resolveRef(rule.secondary, a, b, mover) } : {}),
      ...(moverSide ? { mover: moverSide, moverDiscipline: mover!.discipline } : {}),
      ...(mv.approver ? { approver: mv.approver } : {}),
      severity: nonIssue ? "none" : t.severity,
      confidence: t.confidence,
      suggestedAction: t.suggestedAction,
      humanReview: false,
      humanReviewReasons: t.humanReview ? ["rule"] : [],
      tags,
      notes,
      rationale: capitalize(rewriteNoMover(renderTemplate(rs, rule.rationale, a, b, clash, mover))),
      source: "rule",
      binding: { a: aSide },
    };
    for (const tag of t.tags ?? []) addTag(tag);
  } else {
    c = {
      ruleId: UNMATCHED_RULE_ID,
      ruleName: "unmatched",
      ruleVersion: rs.versions.rules,
      validity: "needs_info",
      nature: "hard",
      rootCause: "design_coordination",
      responsibleDiscipline: "COORD",
      ...(moverSide ? { mover: moverSide, moverDiscipline: mover!.discipline } : {}),
      severity: "medium",
      confidence: 0,
      suggestedAction: "request_info",
      humanReview: false,
      humanReviewReasons: ["unmatched"],
      tags,
      notes,
      rationale: "Ninguna regla aplica a esta interferencia. Requiere revisión del coordinador.",
      source: "rule",
      binding: { a: aSide },
    };
  }

  // Annotations: all matching apply; they only add tags and notes.
  for (const an of rs.annotations) {
    const ab = bindWhen(an.when, first, second, clash, left);
    if (!ab) continue;
    for (const tag of an.tags) addTag(tag);
    if (an.note) notes.push(rewriteNoMover(renderTemplate(rs, an.note, ab.a, ab.b, clash, mover)));
  }
  // Hard-coded safety tag: a penetration/embedment in structure feeds the
  // non-configurable structural-opening review trigger (core/group/review.ts).
  if (isStructuralPenetration(rs, left, right, clash)) addTag(STRUCTURAL_OPENING_TAG);
  for (const tag of extraTags) addTag(tag);

  // Post-processing (mandatory).
  if (c.severity === "critical") c.humanReviewReasons.push("critical");
  if (c.confidence < HUMAN_REVIEW_CONFIDENCE) c.humanReviewReasons.push("low_confidence");
  if (c.validity === "needs_info") c.humanReviewReasons.push("needs_info");
  c.humanReview = c.humanReviewReasons.length > 0;

  return { classification: c, a, b, ...(mover ? { mover } : {}) };
}
