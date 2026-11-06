/**
 * Deterministic issue draft from a group (docs/domain/issue-writing-guide.md).
 * The engine fills the structured fields, the title and a description
 * skeleton with facts; the agent rewrites the prose before a coordinator
 * approves it.
 */
import type { ClassifiedClash } from "../classified";
import { fixedOf, moverOf, moverSideOf, sideA, sideB } from "../classified";
import type { ElementFacts } from "../enrich/element";
import { categoryLabel, classLabel, ruleNameEs, sizeHint, type ClashGroup } from "../group";
import type { CompiledRuleSet } from "../rules/load";
import type { BandName, RootCause } from "../rules/schemas";
import { capitalize, cmpStr, sanitize } from "../util/text";
import {
  addBusinessDays, formatEs, formatEsShort, lastBusinessDayBefore, maxIso, nextWeekdayOnOrAfter, parseIsoDate,
} from "./calendar";

export * from "./calendar";

export interface Assignee {
  type: "company" | "role" | "user";
  name?: string;
  email?: string;
}

export interface IssueOptions {
  /** Day the issue is approved/published (YYYY-MM-DD). */
  publishDate: string;
  /** Coordination meeting weekday (0 = Sunday … 6 = Saturday). Default 3 (Wednesday). */
  meetingWeekday?: number;
  /** Model publication cut-off weekday. Default: meeting day − 2 (methodology D-2). */
  publicationCutoffWeekday?: number;
  /** Extra non-working days (project closures), merged with the rule set holidays. */
  holidays?: Iterable<string>;
  /** Grid bay, room or zone name for the title ("Eje B-E/2-3"). */
  location?: string;
  /** `.coordinator/project.yaml` assignees by discipline. */
  assignees?: Readonly<Record<string, Assignee>>;
  testId?: string;
  modelSetVersion?: number;
}

export interface IssueDraft {
  groupId: string;
  /** ≤ 100 characters. */
  title: string;
  /** Spanish markdown per the description template. */
  description: string;
  band: Exclude<BandName, "NONE">;
  responsibleDiscipline: string;
  secondaryDiscipline?: string;
  /** Disciplines to add as watchers (secondary + approver), never the assignee. */
  watchers: string[];
  assignee?: Assignee;
  /** YYYY-MM-DD */
  dueDate: string;
  /** e.g. "P1 · 3 días hábiles, ajustado a reunión del 18-11" */
  dueRule: string;
  rootCause: RootCause;
  ruleIds: string[];
  /** MC clash ids covered. */
  clashIds: string[];
  /** Member used for the viewpoint/pushpin (worst member). */
  viewpointClashKey: string;
  placement: { externalId?: string; documentName?: string };
  issueType: string;
  customFields: Record<string, string>;
  draftedBy: "engine";
}

const TITLE_MAX = 100;

const ACTION_ES: Record<RootCause, string> = {
  routing_conflict: "Desviar el trazado fuera del elemento interferido.",
  missing_opening: "Confirmar medida y ubicación de la pasada y modelarla en el elemento atravesado.",
  design_coordination: "Revisar la solución con la especialidad consultada y proponer una alternativa de trazado o de diseño.",
  modeling_error: "Corregir la geometría del modelo (nivel de referencia, offset o espesores).",
  duplicate_model: "Eliminar el contenido duplicado, vincular el modelo de origen y publicar antes del próximo corte.",
  model_hygiene: "Corregir el modelo o el set de búsqueda para excluir estos elementos.",
  lod_mismatch: "Declarar la función del elemento o recategorizarlo con la categoría Revit correcta.",
  outdated_model: "Republicar el modelo y confirmar si la interferencia persiste.",
  not_applicable: "Sin acción de diseño: confirmar el cierre.",
};

function bandFor(g: ClashGroup): Exclude<BandName, "NONE"> {
  if (g.band !== "NONE") return g.band;
  // Non-issue clashes can still need a hygiene issue (issue guide example 5).
  return g.strategy === "hygiene" ? "P3" : "P4";
}

function levelText(levels: readonly string[]): string {
  if (levels.length === 0) return "";
  if (levels.length === 1) return levels[0]!;
  const nums = levels.map((l) => /^piso\s+(-?\d+)$/i.exec(l.trim())?.[1]);
  if (nums.every((n) => n !== undefined)) {
    const ns = nums.map(Number).sort((a, b) => a - b);
    return `Pisos ${ns[0]}-${ns[ns.length - 1]}`;
  }
  return `${levels[0]} a ${levels[levels.length - 1]}`;
}

function describeElement(rs: CompiledRuleSet, el: ElementFacts, withType = false): string {
  const parts = [capitalize(categoryLabel(rs, el.category))];
  const sys = sanitize(el.systemName, 30);
  if (sys) parts.push(sys);
  else if (withType && el.type) parts.push(sanitize(el.type, 30));
  const size = sizeHint(el);
  if (size && !/ mm$/.test(size)) parts.push(size);
  return parts.join(" ");
}

function verbFor(rs: CompiledRuleSet, g: ClashGroup, counterpart: ElementFacts, plural: boolean): string {
  if (g.nature === "duplicate") return plural ? "duplican" : "duplica";
  if (g.nature === "clearance") return plural ? "invaden" : "invade";
  const structural = rs.classSets.get("STRUCTURE")?.has(counterpart.elementClass) ?? false;
  const crossable = ["arch_wall", "arch_floor", "curtain_wall", "roof"].includes(counterpart.elementClass);
  if (structural || crossable) return plural ? "atraviesan" : "atraviesa";
  return plural ? "interfieren" : "interfiere";
}

function worstMember(ms: readonly ClassifiedClash[]): ClassifiedClash {
  return [...ms].sort((x, y) => y.priority.score - x.priority.score || y.facts.penetrationMm - x.facts.penetrationMm || cmpStr(x.key, y.key))[0]!;
}

/** "{qué} {verbo} {qué}" for the title. */
function whatPhrase(rs: CompiledRuleSet, g: ClashGroup, ms: readonly ClassifiedClash[], rep: ClassifiedClash): string {
  const n = ms.length;
  const a = sideA(rep);
  const b = sideB(rep);
  if (g.strategy === "hygiene") {
    const file = sanitize((a.discipline === g.responsibleDiscipline ? a : b).documentName ?? a.documentName, 40);
    return `Higiene · ${file} · ${ruleNameEs(g.ruleIds[0]!, rep.classification.ruleName)} (${n})`;
  }
  if (g.validity === "needs_info") {
    return a.family ? `¿Qué representa '${sanitize(a.family, 40)}'? (${categoryLabel(rs, a.category)}, ${n} interf.)` : `${ruleNameEs(g.ruleIds[0]!)} (${n})`;
  }
  if (g.ruleIds[0] === "INC-001") {
    const cnt = new Set(ms.map((m) => sideA(m).elementKey)).size;
    return `${cnt > 1 ? `${cnt} rociadores obstruidos` : "Rociador obstruido"} por ${describeElement(rs, b)}`;
  }
  if (g.ruleIds[0] === "AE-002") {
    return `${describeElement(rs, b, true)} queda bajo ${categoryLabel(rs, a.category)} ${sanitize(a.type, 30)}`.trim();
  }
  if (g.strategy === "hub-fixed" && g.hubElement) {
    const hubTok = g.canonicalKey.split("|")[1];
    const crossing = ms.map((m) => (m.left.elementKey === hubTok ? m.right : m.left));
    const hub = ms.map((m) => (m.left.elementKey === hubTok ? m.left : m.right))[0]!;
    const cls = new Set(crossing.map((e) => e.elementClass));
    const what = cls.size === 1 ? classLabel([...cls][0]).many : "elementos";
    return `${n} ${what} de ${[...new Set(crossing.map((e) => e.discipline))].sort(cmpStr).join("/")} ${verbFor(rs, g, hub, true)} ${categoryLabel(rs, hub.category)} ${sanitize(hub.type, 30)}`.trim();
  }
  const [mv, other] = moverSideOf(rep);
  const subject = g.strategy === "hub-mover" ? (moverOf(rep) ?? mv) : mv;
  const counterpart = g.strategy === "hub-mover" ? (fixedOf(rep) ?? other) : other;
  if (n === 1) return `${describeElement(rs, subject)} ${verbFor(rs, g, counterpart, false)} ${categoryLabel(rs, counterpart.category)} ${sanitize(counterpart.type, 30)}`.trim();
  const counterparts = ms.map((m) => (g.strategy === "hub-mover" ? fixedOf(m) : moverSideOf(m)[1]) ?? counterpart);
  const cls = new Set(counterparts.map((e) => e.elementClass));
  const what = cls.size === 1 ? classLabel([...cls][0]).many : "elementos";
  return `${describeElement(rs, subject)} ${verbFor(rs, g, counterpart, false)} ${n} ${what}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Due date per the issue guide §4. Returns the date and the rule text. */
export function computeDueDate(
  rs: CompiledRuleSet,
  g: Pick<ClashGroup, "validity" | "severity" | "rootCause" | "secondaryDiscipline" | "suggestedAction">,
  band: Exclude<BandName, "NONE">,
  opts: IssueOptions,
): { dueDate: string; dueRule: string } {
  parseIsoDate(opts.publishDate);
  const holidays = new Set<string>([...rs.holidays, ...(opts.holidays ?? [])]);
  const meetingWd = opts.meetingWeekday ?? 3;
  const cutoffWd = opts.publicationCutoffWeekday ?? (meetingWd + 5) % 7;
  const target = rs.scoring.bands.find((b) => b.band === band)?.targetBusinessDays ?? 14;
  const bd = (d: string, n: number) => addBusinessDays(d, n, holidays);

  let due = bd(opts.publishDate, target);
  let rule = `${band} · ${target} días hábiles`;
  if (g.secondaryDiscipline === "EST" && (g.rootCause === "missing_opening" || g.rootCause === "design_coordination") && g.severity !== "critical") {
    due = bd(due, 5);
    rule += " + 5 por aprobación del calculista";
  }
  if (g.validity === "needs_info") {
    due = bd(opts.publishDate, 5);
    rule = "solicitud de información · 5 días hábiles";
  }
  const hygiene = g.suggestedAction === "hygiene_issue";
  if (hygiene) {
    due = nextWeekdayOnOrAfter(bd(opts.publishDate, 3), cutoffWd);
    rule = "higiene · próximo corte de publicación";
  } else {
    const meeting = nextWeekdayOnOrAfter(due, meetingWd);
    due = lastBusinessDayBefore(meeting, holidays);
    rule += `, ajustado a reunión del ${formatEsShort(meeting)}`;
  }
  const floor = bd(opts.publishDate, 2);
  if (due < floor) {
    due = maxIso(due, floor);
    rule += " (mínimo 2 días hábiles)";
  }
  return { dueDate: due, dueRule: rule };
}

/** Build the issue draft for a group. `clashes` may be the full classified list. */
export function buildIssueDraft(rs: CompiledRuleSet, group: ClashGroup, clashes: readonly ClassifiedClash[], opts: IssueOptions): IssueDraft {
  const keys = new Set(group.memberKeys);
  const ms = clashes.filter((c) => keys.has(c.key));
  if (ms.length === 0) throw new Error(`group ${group.id}: no member clashes supplied`);
  const rep = worstMember(ms);
  const band = bandFor(group);
  const resp = group.responsibleDiscipline;
  const [mvSide, otherSide] = moverSideOf(rep);
  const otherDisc = group.secondaryDiscipline ?? (otherSide.discipline !== resp ? otherSide.discipline : mvSide.discipline !== resp ? mvSide.discipline : undefined);
  const pair = group.strategy === "hygiene" || !otherDisc || otherDisc === resp ? `[${resp}]` : `[${resp}×${otherDisc}]`;
  const levels = levelText(group.levels);
  const head = [levels || undefined, opts.location ? sanitize(opts.location, 30) : undefined].filter(Boolean).join(" · ");
  const what = whatPhrase(rs, group, ms, rep);
  const title = truncate(`[${band}]${pair} ${head ? `${head} · ` : ""}${what}`, TITLE_MAX);

  const { dueDate, dueRule } = computeDueDate(rs, group, band, opts);
  const assignee = opts.assignees?.[resp];
  const watchers = [...new Set([group.secondaryDiscipline, rep.classification.approver].filter((x): x is string => !!x && x !== resp))].sort(cmpStr);

  const a = sideA(rep);
  const b = sideB(rep);
  const elLine = (el: ElementFacts) =>
    [capitalize(categoryLabel(rs, el.category)), sanitize(el.type, 40), el.systemName ? `sistema ${sanitize(el.systemName, 30)}` : "", sizeHint(el)]
      .filter(Boolean).join(" ") + (el.documentName ? ` (${sanitize(el.documentName, 60)})` : "");
  const maxPen = Math.round(group.stats.maxPenetrationMm);
  const problem = ms.length === 1
    ? `${capitalize(rep.classification.rationale.split(". ")[0]!.replace(/\.$/, ""))}. Penetración ${Math.round(rep.facts.penetrationMm)} mm.`
    : `${ms.length} interferencias del mismo patrón (${ruleNameEs(group.ruleIds[0]!, rep.classification.ruleName)}). Penetración máxima ${maxPen} mm.`;
  const actions: string[] = [];
  if (group.tags.includes("posible_error_de_cota")) actions.push("Verificar el nivel de referencia y el offset: el patrón sugiere un error de cota.");
  actions.push(ACTION_ES[group.rootCause]);
  if (group.secondaryDiscipline === "EST" || group.tags.includes("requiere_calculista")) actions.push("Toda pasada en estructura queda sujeta a aprobación del calculista.");
  const approve = group.secondaryDiscipline ? `${group.secondaryDiscipline}${group.secondaryDiscipline === "EST" ? " (calculista)" : ""}` : "—";
  const respText = assignee?.name ? `${resp} (${assignee.name})` : resp;
  const files = [...new Set(ms.flatMap((m) => [m.left.documentName, m.right.documentName]).filter((x): x is string => !!x))].sort(cmpStr);
  const testRef = opts.testId ? ` · Prueba MC ${opts.testId}${opts.modelSetVersion !== undefined ? `, conjunto v${opts.modelSetVersion}` : ""}` : "";

  const description = [
    "**Problema**",
    problem,
    "",
    "**Ubicación**",
    [levels || "Nivel no informado", opts.location ? sanitize(opts.location, 40) : undefined].filter(Boolean).join(" · "),
    `Elementos: ${elLine(a)} / ${elLine(b)}`,
    "",
    "**Por qué importa**",
    rep.classification.rationale,
    "",
    "**Acción solicitada**",
    ...actions.map((x, i) => `${i + 1}. ${x}`),
    "",
    `**Responsable:** ${respText}`,
    `**Aprueba / consultar:** ${approve}`,
    `**Fecha compromiso:** ${formatEs(dueDate)} (${dueRule})`,
    "",
    "**Referencias**",
    `Grupo ${group.id} · ${ms.length} interferencia${ms.length === 1 ? "" : "s"} · Regla${group.ruleIds.length > 1 ? "s" : ""} ${group.ruleIds.join(", ")}${testRef}`,
    ...(files.length ? [`Modelos: ${files.map((f) => sanitize(f, 60)).join(", ")}`] : []),
  ].join("\n");

  const placementEl = group.hubElement ? (ms.flatMap((m) => [m.left, m.right]).find((e) => e.externalId === group.hubElement!.externalId) ?? mvSide) : mvSide;
  return {
    groupId: group.id,
    title,
    description,
    band,
    responsibleDiscipline: resp,
    ...(group.secondaryDiscipline ? { secondaryDiscipline: group.secondaryDiscipline } : {}),
    watchers,
    ...(assignee ? { assignee } : {}),
    dueDate,
    dueRule,
    rootCause: group.rootCause,
    ruleIds: group.ruleIds,
    clashIds: group.mcClashIds,
    viewpointClashKey: rep.key,
    placement: {
      ...(placementEl.externalId ? { externalId: placementEl.externalId } : {}),
      ...(placementEl.documentName ? { documentName: placementEl.documentName } : {}),
    },
    issueType: "Coordinación / Interferencia",
    customFields: { Prioridad: band, "Disciplina responsable": resp, "ID de grupo": group.id, Regla: group.ruleIds.join(", ") },
    draftedBy: "engine",
  };
}
