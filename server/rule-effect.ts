/**
 * Plain-language effect of a rule change (G15): which rules a candidate rule set adds, changes or
 * removes, phrased for a coordinator ("Las interferencias CLI×EST (Ducto atraviesa viga) pasan a
 * Conflicto"), and how many grupos / ubicaciones / interferencias of a cached test would change.
 * Pure helpers + one engine run; never writes anything.
 */
import { classLabel, ruleNameEs } from "../core/group/labels";
import type { CompiledRuleSet } from "../core/rules/load";

type RawRule = CompiledRuleSet["source"]["classification"]["rules"][number];
type Matcher = Record<string, unknown> | undefined;

/** Validity labels exactly as the UI shows them. */
export const VALIDITY_ES: Record<string, string> = {
  real: "Conflicto",
  false_positive: "No es problema",
  tolerated: "Dentro de tolerancia",
  needs_info: "Falta información",
};

const SEVERITY_ES: Record<string, string> = { critical: "crítica", high: "alta", medium: "media", low: "baja", none: "sin severidad" };

const ACTION_ES: Record<string, string> = {
  create_issue: "crear incidencia",
  close_not_issue: "cerrar (no es incidencia)",
  mark_reviewed: "marcar revisada",
  hygiene_issue: "incidencia de higiene",
  request_info: "pedir información",
  escalate: "escalar",
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

/** One side of a rule ("CLI", "EST viga", "tubería") from its raw matcher; undefined when unconstrained. */
export function sideLabel(m: Matcher, rs?: CompiledRuleSet): string | undefined {
  if (!m) return undefined;
  const disc = [...list(m.discipline), ...list(m.disciplineGroup)];
  const cls = list(m.elementClass);
  const cat = list(m.category).map((c) => rs?.categoryLabelsEs.get(c) ?? c);
  const parts: string[] = [];
  if (disc.length) parts.push(disc.join("/"));
  if (cls.length) parts.push(cls.map((c) => classLabel(c).one).join("/"));
  else if (cat.length) parts.push(cat.join("/").toLowerCase());
  return parts.length ? parts.join(" ") : undefined;
}

/** "CLI×EST viga" (or "EST×EST" for `both`, or "todas" when the rule constrains no side). */
export function pairLabel(r: RawRule, rs?: CompiledRuleSet): string {
  const w = r.when as Record<string, Matcher>;
  const both = sideLabel(w.both, rs);
  const a = sideLabel(w.a, rs) ?? both;
  const b = sideLabel(w.b, rs) ?? both;
  if (!a && !b) return "todas las disciplinas";
  return `${a ?? "cualquiera"}×${b ?? "cualquiera"}`;
}

/** Spanish rule name: `nameEs`, the label table, else a label derived from the pair and the outcome. */
export function ruleLabelEs(r: RawRule, rs?: CompiledRuleSet): string {
  const named = ruleNameEs(r.id, "", rs as never);
  if (named) return named;
  return `${pairLabel(r, rs)} → ${VALIDITY_ES[r.then.validity] ?? r.then.validity}`;
}

const thenLine = (t: RawRule["then"]) =>
  [VALIDITY_ES[t.validity] ?? t.validity, t.validity === "real" || t.validity === "needs_info" ? `severidad ${SEVERITY_ES[t.severity] ?? t.severity}` : "", ACTION_ES[t.suggestedAction] ?? t.suggestedAction]
    .filter(Boolean)
    .join(", ");

/** Effect sentences of base → candidate (≤ 6). */
export function describeRuleChange(base: CompiledRuleSet, cand: CompiledRuleSet): string[] {
  const before = new Map(base.source.classification.rules.map((r) => [r.id, r]));
  const after = new Map(cand.source.classification.rules.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const [id, r] of after) {
    const old = before.get(id);
    const name = ruleLabelEs(r, cand);
    const pair = pairLabel(r, cand);
    if (!old) {
      out.push(`Regla nueva «${name}»: las interferencias ${pair} pasan a ${thenLine(r.then)}.`);
      continue;
    }
    if (JSON.stringify(old) === JSON.stringify(r)) continue;
    if (old.then.validity !== r.then.validity) {
      out.push(`Las interferencias ${pair} («${name}») pasan de ${VALIDITY_ES[old.then.validity] ?? old.then.validity} a ${thenLine(r.then)}.`);
    } else if (JSON.stringify(old.when) !== JSON.stringify(r.when)) {
      out.push(`«${name}» cambia sus condiciones (${pair}); sigue en ${thenLine(r.then)}.`);
    } else {
      const changed: string[] = [];
      if (old.then.severity !== r.then.severity) changed.push(`severidad ${SEVERITY_ES[old.then.severity]} → ${SEVERITY_ES[r.then.severity]}`);
      if (old.then.confidence !== r.then.confidence) changed.push(`confianza ${old.then.confidence} → ${r.then.confidence}`);
      if (old.then.suggestedAction !== r.then.suggestedAction) changed.push(`acción ${ACTION_ES[old.then.suggestedAction]} → ${ACTION_ES[r.then.suggestedAction]}`);
      if (old.then.responsibleDiscipline !== r.then.responsibleDiscipline) changed.push(`responsable ${old.then.responsibleDiscipline} → ${r.then.responsibleDiscipline}`);
      if (!!old.then.humanReview !== !!r.then.humanReview) changed.push(r.then.humanReview ? "pasa a revisión humana" : "deja de pedir revisión humana");
      out.push(`Las interferencias ${pair} («${name}»): ${changed.length ? changed.join(", ") : "cambia el texto o las etiquetas"}.`);
    }
  }
  for (const [id, r] of before) if (!after.has(id)) out.push(`Se elimina «${ruleLabelEs(r, base)}»: sus interferencias ${pairLabel(r, base)} pasan a la regla siguiente.`);
  const order = (rs: CompiledRuleSet) => rs.source.classification.rules.map((r) => r.id).filter((id) => before.has(id) && after.has(id)).join(",");
  if (!out.length && order(base) !== order(cand)) out.push("Cambia el orden de las reglas (la primera que coincide gana).");
  return out.slice(0, 6);
}

/** Groups / ubicaciones / clashes of a classified test whose validity changes with the candidate rules. */
export function affectedCounts(
  cls: { clashes: Array<{ id: string; groupId: string; validity: string }>; families?: Array<{ groupIds: string[] }> },
  candidate: { clashes: Array<{ id: string; validity: string }> },
): { families: number; groups: number; clashes: number } {
  const next = new Map(candidate.clashes.map((c) => [c.id, c.validity]));
  const groups = new Set<string>();
  let clashes = 0;
  for (const c of cls.clashes) {
    const v = next.get(c.id);
    if (v !== undefined && v !== c.validity) {
      clashes++;
      groups.add(c.groupId);
    }
  }
  const families = (cls.families ?? []).filter((f) => f.groupIds.some((g) => groups.has(g))).length;
  return { families, groups: groups.size, clashes };
}
