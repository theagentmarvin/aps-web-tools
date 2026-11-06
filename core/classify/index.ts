/**
 * Rule evaluation (classification-rules.yaml §1–3, §6): first match wins,
 * symmetric side binding, annotations, discipline refs, Spanish rationale and
 * the mandatory post-processing.
 */
import type { ElementFacts } from "../enrich/element";
import type { ClashFacts } from "../enrich/clash";
import type { CompiledRuleSet, CompiledWhen, DisciplineRef, TemplatePart } from "../rules/load";
import type { Nature, RootCause, Severity, SuggestedAction, Validity } from "../rules/schemas";
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

/** Try a `when` in orientation 1 (a=left) then 2 (a=right) when symmetric. */
export function bindWhen(w: CompiledWhen, left: ElementFacts, right: ElementFacts, clash: ClashFacts): Binding | null {
  const n = w.symmetric ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? left : right;
    const b = i === 0 ? right : left;
    const ctx = { a, b, clash };
    if (w.clash && !w.clash(clash, ctx)) continue;
    if (w.a && !w.a(a, ctx)) continue;
    if (w.b && !w.b(b, ctx)) continue;
    if (w.both && !(w.both(a, ctx) && w.both(b, ctx))) continue;
    return { a, b, aSide: i === 0 ? "left" : "right" };
  }
  return null;
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
      // No mover (tie): the responsible party is COORD, render it the same way.
      out += p.field === "discipline" ? "COORD" : "—";
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
  for (let i = 0; i < rs.rules.length; i++) {
    bound = bindWhen(rs.rules[i]!.when, left, right, clash);
    if (bound) {
      ruleIdx = i;
      break;
    }
  }
  const { a, b, aSide } = bound ?? { a: left, b: right, aSide: "left" as Side };
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
      rationale: renderTemplate(rs, rule.rationale, a, b, clash, mover),
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
      binding: { a: "left" },
    };
  }

  // Annotations: all matching apply; they only add tags and notes.
  for (const an of rs.annotations) {
    const ab = bindWhen(an.when, left, right, clash);
    if (!ab) continue;
    for (const tag of an.tags) addTag(tag);
    if (an.note) notes.push(renderTemplate(rs, an.note, ab.a, ab.b, clash, mover));
  }
  for (const tag of extraTags) addTag(tag);

  // Post-processing (mandatory).
  if (c.severity === "critical") c.humanReviewReasons.push("critical");
  if (c.confidence < HUMAN_REVIEW_CONFIDENCE) c.humanReviewReasons.push("low_confidence");
  if (c.validity === "needs_info") c.humanReviewReasons.push("needs_info");
  c.humanReview = c.humanReviewReasons.length > 0;

  return { classification: c, a, b, ...(mover ? { mover } : {}) };
}
