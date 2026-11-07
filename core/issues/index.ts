/**
 * Deterministic issue draft from a group (docs/domain/issue-writing-guide.md,
 * compact template from docs/domain/engine-review-2026-11.md §5).
 *
 * ACC limits: title ≤ 100, description ≤ 1000. The engine caps the description
 * at 950 (margin for agent edits), writes PLAIN TEXT with uppercase labels (ACC
 * shows markdown literally) and trims, in order: "Modelos", the second element
 * of the worst case, alternative 3. It never trims the action, owner or date.
 * Drafts are built for real, needs-info and hygiene groups.
 */
import type { ClassifiedClash } from "../classified";
import { fixedOf, moverOf, sideA, sideB } from "../classified";
import { crossSectionMm2 } from "../classify/who-moves";
import type { ElementFacts } from "../enrich/element";
import { categoryLabel, classLabel, ownSides, ruleNameEs, sizeHint, titleName, type ClashGroup } from "../group";
import type { CompiledRuleSet } from "../rules/load";
import type { BandName, RootCause } from "../rules/schemas";
import { capitalize, cmpStr, norm, sanitize } from "../util/text";
import { ROOT_CAUSE_TEXT_ES, RULE_TEXT_ES } from "./actions";
import {
  addBusinessDays, formatEs, formatEsShort, lastBusinessDayBefore, maxIso, nextWeekdayOnOrAfter, parseIsoDate,
} from "./calendar";

export * from "./calendar";
export { RULE_TEXT_ES, ROOT_CAUSE_TEXT_ES } from "./actions";

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
  /** Plain text (no markdown), ≤ 950 characters. */
  description: string;
  format: "text";
  band: Exclude<BandName, "NONE">;
  responsibleDiscipline: string;
  secondaryDiscipline?: string;
  /** Disciplines to add as watchers (secondary + approver), never the assignee. */
  watchers: string[];
  assignee?: Assignee;
  /** YYYY-MM-DD */
  dueDate: string;
  /** e.g. "P1 · 3 días hábiles, antes de la reunión del 18-11" */
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

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 950;

function bandFor(g: ClashGroup): Exclude<BandName, "NONE"> {
  if (g.band !== "NONE") return g.band;
  // Non-issue clashes can still need a hygiene issue (issue guide example 5).
  return g.strategy === "hygiene" ? "P3" : "P4";
}

function levelText(levels: readonly string[]): string {
  if (levels.length === 0) return "";
  if (levels.length === 1) return levels[0]!;
  const m = levels.map((l) => /^(piso|nivel|level)\s+(-?\d+)$/i.exec(l.trim()));
  if (m.every((x) => x !== null)) {
    const ns = m.map((x) => Number(x![2])).sort((a, b) => a - b);
    const word = m[0]![1]!.toLowerCase() === "piso" ? "Pisos" : "Niveles";
    return `${word} ${ns[0]}-${ns[ns.length - 1]}`;
  }
  return `${levels[0]} a ${levels[levels.length - 1]}`;
}

function distinct(els: readonly ElementFacts[]): ElementFacts[] {
  const m = new Map<string, ElementFacts>();
  for (const e of els) m.set(String(e.elementKey ?? e.externalId ?? m.size), e);
  return [...m.values()];
}

function classPhrase(els: readonly ElementFacts[], n?: number): string {
  const cls = new Set(els.map((e) => e.elementClass));
  const lab = cls.size === 1 ? classLabel([...cls][0]) : { one: "elemento", many: "elementos" };
  return n === undefined ? lab.many : `${n} ${n === 1 ? lab.one : lab.many}`;
}

/** "RET, IMP, EXT; 300x250 a 800x400" for a set of elements. */
function systemsAndRange(els: readonly ElementFacts[]): string {
  const systems = [...new Set(els.map((e) => titleName(e)).filter(Boolean))].sort(cmpStr);
  const sys = systems.length === 0 ? "" : systems.length <= 3 ? systems.join(", ") : `${systems.slice(0, 3).join(", ")}…`;
  const sized = els
    .map((e) => ({ e, a: crossSectionMm2(e) ?? (e.sizeMm !== undefined ? e.sizeMm * e.sizeMm : undefined), h: sizeHint(e) }))
    .filter((x) => x.a !== undefined && x.h && !/ mm$/.test(x.h))
    .sort((x, y) => x.a! - y.a! || cmpStr(x.h, y.h));
  const range = sized.length === 0 ? "" : sized[0]!.h === sized[sized.length - 1]!.h ? sized[0]!.h : `${sized[0]!.h} a ${sized[sized.length - 1]!.h}`;
  return [sys, range].filter(Boolean).join("; ");
}

function describeOne(rs: CompiledRuleSet, el: ElementFacts): string {
  const label = categoryLabel(rs, el.category);
  const name = titleName(el);
  // Avoid "Losa Losa H.A. e=200": drop the label when the name already starts with it.
  const head = name && norm(name).startsWith(norm(label)) ? name : [label, name].filter(Boolean).join(" ");
  const size = sizeHint(el);
  return [head, size && !/ mm$/.test(size) && !containsSize(head, size) ? size : ""].filter(Boolean).join(" ");
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

interface What {
  /** Full phrase with names. */
  full: string;
  /** Same phrase without system/type names (title fallback). */
  short: string;
  /** Problem sentence for the description. */
  problem: string;
}

/** "{qué} {verbo} {qué}" + the PROBLEMA sentence. */
function whatOf(rs: CompiledRuleSet, g: ClashGroup, ms: readonly ClassifiedClash[], rep: ClassifiedClash): What {
  const n = ms.length;
  const pen = `Penetración máx. ${Math.round(g.stats.maxPenetrationMm)} mm.`;
  const a = sideA(rep);
  const b = sideB(rep);
  if (g.strategy === "hygiene") {
    const t = g.title.replace(/^Higiene:\s*/, "");
    return {
      full: `Higiene · ${t} (${n})`,
      short: `Higiene · ${ruleNameEs(g.ruleIds[0]!, rep.classification.ruleName, rs)} (${n})`,
      problem: `${capitalize(t)}: ${n} interferencia${n === 1 ? "" : "s"} (${ruleNameEs(g.ruleIds[0]!, rep.classification.ruleName, rs)}).`,
    };
  }
  if (g.validity === "needs_info") {
    const els = distinct(ms.map(sideA));
    const q = a.family ? `¿Qué representa '${sanitize(a.family, 40)}'?` : ruleNameEs(g.ruleIds[0]!, undefined, rs);
    return {
      full: `${q} (${els.length} ${categoryLabel(rs, a.category)}, ${n} interf.)`,
      short: `${q} (${n} interf.)`,
      problem: `${els.length} elemento${els.length === 1 ? "" : "s"} ${categoryLabel(rs, a.category)} de ${g.responsibleDiscipline} sin función declarada generan ${n} interferencia${n === 1 ? "" : "s"}.`,
    };
  }
  if (g.ruleIds[0] === "INC-001") {
    const heads = distinct(ms.map(sideA));
    const obs = distinct(ms.map(sideB));
    const subj = heads.length > 1 ? `${heads.length} rociadores obstruidos` : "Rociador obstruido";
    const objFull = obs.length === 1 ? describeOne(rs, b) : `${classPhrase(obs, obs.length)} de ${[...new Set(obs.map((e) => e.discipline))].sort(cmpStr).join("/")}`;
    return { full: `${subj} por ${objFull}`, short: `${subj} por ${obs.length === 1 ? categoryLabel(rs, b.category) : classPhrase(obs)}`, problem: `${subj} por ${objFull}. ${pen}` };
  }
  if (g.ruleIds[0] === "AE-002") {
    const beams = distinct(ms.map(sideB));
    const s = beams.length === 1 ? `${describeOne(rs, b)} queda bajo el cielo` : `${classPhrase(beams, beams.length)} quedan bajo el cielo`;
    return { full: s, short: s, problem: `${s} ${sanitize(titleName(a, false))}`.trim() + `. ${pen}` };
  }

  const sides = ms.map(ownSides);
  const own = distinct(sides.map((s) => s[0]));
  const other = distinct(sides.map((s) => s[1]));
  const otherDiscs = [...new Set(other.map((e) => e.discipline))].sort(cmpStr).join("/");
  const ownIsFixed = ms.every((m) => ownSides(m)[0] === fixedOf(m));
  if (ownIsFixed && g.rootCause === "missing_opening") {
    // EST-009: the owner models the openings in its own elements.
    const s = `Faltan ${n} pasada${n === 1 ? "" : "s"} de ${classPhrase(other)} ${otherDiscs} en ${classPhrase(own)}`;
    return { full: s, short: s, problem: `${n} cruce${n === 1 ? "" : "s"} de ${classPhrase(other)} de ${otherDiscs} (${systemsAndRange(other) || "sin datos"}) sin pasada modelada en ${classPhrase(own)} de ${g.responsibleDiscipline}. ${pen}` };
  }
  const repOwn = ownSides(rep)[0];
  const repOther = ownSides(rep)[1];
  const hubOwn = g.strategy === "hub-mover" ? (moverOf(rep) ?? repOwn) : repOwn;
  const objMany = `${classPhrase(other)} ${otherDiscs}`;
  if (own.length === 1) {
    const subjFull = capitalize(describeOne(rs, hubOwn));
    const subjShort = capitalize(categoryLabel(rs, hubOwn.category));
    const verb = verbFor(rs, g, repOther, false);
    const obj = other.length === 1 ? `${categoryLabel(rs, repOther.category)} ${titleName(repOther, false)}`.trim() : `${other.length} ${objMany}`;
    const objShort = other.length === 1 ? categoryLabel(rs, repOther.category) : `${other.length} ${classPhrase(other)}`;
    return {
      full: `${subjFull} ${verb} ${obj}`,
      short: `${subjShort} ${verb} ${objShort}`,
      problem: `${subjFull} de ${g.responsibleDiscipline} ${verb} ${other.length === 1 ? obj : `${other.length} ${classPhrase(other)}`} de ${otherDiscs}. ${pen}`,
    };
  }
  const verb = verbFor(rs, g, repOther, true);
  const sysList = systemsAndRange(own);
  const obj = other.length === 1 ? `${categoryLabel(rs, repOther.category)} ${titleName(repOther, false)}`.trim() : objMany;
  return {
    full: `${own.length} ${classPhrase(own)} ${g.responsibleDiscipline} ${verb} ${obj}`,
    short: `${own.length} ${classPhrase(own)} ${g.responsibleDiscipline} ${verb} ${other.length === 1 ? categoryLabel(rs, repOther.category) : classPhrase(other)}`,
    problem: `${own.length} ${classPhrase(own)} de ${g.responsibleDiscipline}${sysList ? ` (${sysList})` : ""} ${verb} ${other.length === 1 ? obj : `${classPhrase(other)}`} de ${otherDiscs}. ${pen}`,
  };
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
    rule += `, antes de la reunión del ${formatEsShort(meeting)}`;
  }
  const floor = bd(opts.publishDate, 2);
  if (due < floor) {
    due = maxIso(due, floor);
    rule += " (mínimo 2 días hábiles)";
  }
  return { dueDate: due, dueRule: rule };
}

function fitTitle(prefix: string, head: string, location: string | undefined, what: What, max: string): string {
  const build = (loc: boolean, names: boolean, withMax: boolean) =>
    `${prefix} ${[head, loc && location ? location : undefined].filter(Boolean).join(" · ")}${head || (loc && location) ? " · " : ""}${names ? what.full : what.short}${withMax && max ? ` ${max}` : ""}`;
  // Drop order when long: location -> system/type names -> "(máx. …)". Never band, pair or count.
  for (const [loc, names, withMax] of [[true, true, true], [false, true, true], [false, false, true], [false, false, false]] as const) {
    const t = build(loc, names, withMax);
    if (t.length <= TITLE_MAX) return t;
  }
  const t = build(false, false, false);
  return `${t.slice(0, TITLE_MAX - 1)}…`;
}

/** Build the issue draft for a group. `clashes` may be the full classified list. */
export function buildIssueDraft(rs: CompiledRuleSet, group: ClashGroup, clashes: readonly ClassifiedClash[], opts: IssueOptions): IssueDraft {
  const keys = new Set(group.memberKeys);
  const ms = clashes.filter((c) => keys.has(c.key));
  if (ms.length === 0) throw new Error(`group ${group.id}: no member clashes supplied`);
  const rep = worstMember(ms);
  const band = bandFor(group);
  const resp = group.responsibleDiscipline;
  const [ownRep, otherRep] = ownSides(rep);
  const otherDisc = group.secondaryDiscipline ?? (otherRep.discipline !== resp ? otherRep.discipline : ownRep.discipline !== resp ? ownRep.discipline : undefined);
  const pair = group.strategy === "hygiene" || !otherDisc || otherDisc === resp ? `[${resp}]` : `[${resp}×${otherDisc}]`;
  const levels = levelText(group.levels);
  const what = whatOf(rs, group, ms, rep);
  const maxPen = Math.round(group.stats.maxPenetrationMm);
  const real = group.validity === "real" && group.strategy !== "hygiene";
  const title = fitTitle(`[${band}]${pair}`, levels, opts.location ? sanitize(opts.location, 30) : undefined, what, real && maxPen > 0 ? `(máx. ${maxPen} mm)` : "");

  const { dueDate, dueRule } = computeDueDate(rs, group, band, opts);
  const assignee = opts.assignees?.[resp];
  const watchers = [...new Set([group.secondaryDiscipline, rep.classification.approver].filter((x): x is string => !!x && x !== resp))].sort(cmpStr);

  // ── Description (plain text, section budgets from the review §5).
  const ruleText = RULE_TEXT_ES[group.ruleIds[0]!] ?? ROOT_CAUSE_TEXT_ES[group.rootCause];
  const respGroup = rs.disciplines.get(resp)?.group ?? "UNK";
  const actions = [...ruleText.actions({ resp, respGroup, ...(group.secondaryDiscipline ? { other: group.secondaryDiscipline } : {}) })];
  if (group.tags.includes("posible_error_de_cota") && !actions.some((x) => /cota/.test(x))) actions.unshift("Verificar cota y offset: el patrón sugiere un error de nivel de referencia.");
  const calculista = group.secondaryDiscipline === "EST" || group.tags.includes("requiere_calculista") || group.tags.includes("pasada_estructural");
  const tail = calculista ? " Toda pasada en estructura queda sujeta a aprobación del calculista." : "";
  const consult = group.secondaryDiscipline
    ? `${group.secondaryDiscipline}${group.secondaryDiscipline === "EST" ? " (calculista)" : ""}`
    : watchers.join(", ") || "—";
  const respText = assignee?.name ? `${resp} (${sanitize(assignee.name, 40)})` : resp;
  const files = [...new Set([ownRep.documentName, otherRep.documentName].filter((x): x is string => !!x).map((f) => sanitize(f, 50)))];
  const worstA = describeOne(rs, ownRep);
  const worstBName = [categoryLabel(rs, otherRep.category), titleName(otherRep, false)].filter(Boolean).join(" ");
  const worstBSize = sizeHint(otherRep);
  const worstB = [worstBName, worstBSize && !containsSize(worstBName, worstBSize) ? worstBSize : ""].filter(Boolean).join(" ");
  const loc = [levels || "Nivel no informado", opts.location ? sanitize(opts.location, 30) : undefined].filter(Boolean).join(" · ");
  const ref = `REF: ${group.id} · ${ms.length} interf. · ${group.ruleIds.join(", ")}${opts.modelSetVersion !== undefined ? ` · conjunto v${opts.modelSetVersion}` : ""}${opts.testId ? ` · prueba ${sanitize(opts.testId, 40)}` : ""}`;

  const render = (withModels: boolean, withSecond: boolean, nActions: number, whyMax: number, problemMax: number) => {
    const ubic = `UBICACIÓN: ${loc}. Peor caso: ${worstA}${withSecond ? ` / ${worstB}` : ""}.${withModels && files.length ? ` Modelos: ${files.join(" / ")}.` : ""}`;
    const acts = actions.slice(0, nActions).map((x, i) => `${i + 1}. ${x}`).join(" ");
    return [
      `PROBLEMA: ${clip(what.problem, problemMax)}`,
      ubic,
      `POR QUÉ: ${clip(ruleText.why, whyMax)}`,
      `ACCIÓN (${respText}): ${acts}${tail}`,
      `CONSULTAR: ${consult}.`,
      `PLAZO: ${formatEs(dueDate)} (${dueRule}).`,
      ref,
    ].join("\n");
  };
  const attempts: Array<[boolean, boolean, number, number, number]> = [
    [true, true, 3, 160, 220],
    [false, true, 3, 160, 220],
    [false, false, 3, 160, 220],
    [false, false, 2, 160, 220],
    [false, false, 2, 120, 160],
    [false, false, 2, 80, 120],
  ];
  let description = "";
  for (const a of attempts) {
    description = render(...a);
    if (description.length <= DESCRIPTION_MAX) break;
  }
  if (description.length > DESCRIPTION_MAX) description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;

  const placementEl = group.hubElement
    ? (ms.flatMap((m) => [m.left, m.right]).find((e) => e.externalId === group.hubElement!.externalId) ?? ownRep)
    : ownRep;
  return {
    groupId: group.id,
    title,
    description,
    format: "text",
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

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** True when a name already spells the size ("V300x700" vs "300x700"). */
function containsSize(name: string, size: string): boolean {
  return norm(name).replace(/\s+/g, "").includes(norm(size).replace(/\s+/g, ""));
}
