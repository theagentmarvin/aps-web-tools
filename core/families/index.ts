/**
 * F1 "familias" (docs/domain/solution-families-proposal.md, signature v6).
 *
 * A signature is computed PER UNIQUE CLASH (after G0) from the physical
 * configuration only: problem type | host | mover class | system class |
 * host-relative size band | relation. Validity is NOT part of it (it is the
 * decision, not an input). Location is deliberately left out.
 *
 *   familyId = "F-" + sha1(signature)[0..10]
 *   instance = (groupId, familyId)
 *
 * Non-real fallback: a false-positive / tolerated clash joins a physical family
 * only if that family also has real members; otherwise it goes to a rule batch
 * family `PT14 | ruleId | validity | con estructura|entre instalaciones`.
 * Hygiene (PT13) is keyed `ruleId | offending file`; duplicates / superposed
 * structure (PT12) by the ORIGIN-file pair.
 *
 * Pure and deterministic: no I/O, no clock, no randomness.
 */
import type { ClassifiedClash } from "../classified";
import type { ElementFacts } from "../enrich/element";
import { sha1 } from "../util/sha1";

export type ProblemTypeCode = "PT00" | "PT01" | "PT02" | "PT03" | "PT04" | "PT05" | "PT06" | "PT07" | "PT08" | "PT09" | "PT10" | "PT11" | "PT12" | "PT13" | "PT14";
export type FamilyBucket = "pair" | "model_set" | "non_issue";
export type FamilyTag = "tipico" | "validez_mixta" | "orientacion_por_confirmar" | "sin_sistema";

export interface ProblemType {
  code: ProblemTypeCode;
  nameEs: string;
  /** Default responsible → consulted (Spanish, informative). */
  responsibility: string;
  /** Typical solution options, in preference order (Spanish). */
  options: string[];
}

/** Closed list (§3). PT00 is the catch-all. */
export const PROBLEM_TYPES: readonly ProblemType[] = [
  { code: "PT01", nameEs: "Pasada de instalación en viga", responsibility: "instalación → EST", options: ["Desviar bajo la viga", "Pasada en el tercio central, Ø ≤ h/3, sujeta al calculista", "Dividir o aplanar el ducto"] },
  { code: "PT02", nameEs: "Instalación invade franja de viga (altura insuficiente)", responsibility: "instalación → ARQ (cielo), EST", options: ["Bajar penetración + 25 mm verificando altura de cielo", "Aplanar el ducto (misma área)", "Pasada típica si Ø ≤ h/3"] },
  { code: "PT03", nameEs: "Instalación atraviesa pilar", responsibility: "instalación → EST", options: ["Desviar (obligatorio: los pilares no admiten pasadas)"] },
  { code: "PT04", nameEs: "Montante cruza losa sin pasada", responsibility: "EST → instalación", options: ["EST modela la pasada según el listado de la especialidad", "Sello cortafuego", "Losa postensada: coordinar con los cables antes de hormigonar"] },
  { code: "PT05", nameEs: "Tramo horizontal o en pendiente embebido en losa", responsibility: "instalación → EST", options: ["Bajar al entretecho (corregir nivel/pendiente)", "Gravitacional sin pendiente disponible: rebaje de losa o shaft (calculista)"] },
  { code: "PT06", nameEs: "Instalación atraviesa muro estructural o cortafuego", responsibility: "instalación → EST / ARQ", options: ["Pasada aprobada por el calculista y modelada por EST", "Sello cortafuego certificado", "Desviar"] },
  { code: "PT07", nameEs: "Red enterrada o pasada en fundación", responsibility: "instalación → EST", options: ["Verificar cotas de la red enterrada (bajo sello de fundación)", "Camisa en viga de fundación (decidir antes de excavar)"] },
  { code: "PT08", nameEs: "Cruce entre redes de instalaciones", responsibility: "la de menor jerarquía se mueve", options: ["Mover la red de menor jerarquía", "Gas vs eléctrico: separación normativa", "Gravitacional vs gravitacional: estudio conjunto de cotas (COORD)"] },
  { code: "PT09", nameEs: "Red contra equipo o artefacto", responsibility: "red → dueño del equipo", options: ["Si es la conexión propia de la red: falso positivo (regla nueva)", "Desviar la red", "Reubicar el equipo (layout)"] },
  { code: "PT10", nameEs: "Holgura insuficiente (mantención, aislación, cielo, rociadores)", responsibility: "instalación → ARQ / INC", options: ["Mover para recuperar la holgura", "Ajustar la zona de acceso", "Bajar el cielo (decisión ARQ)"] },
  { code: "PT11", nameEs: "Arquitectura, vanos y zonas restringidas", responsibility: "ARQ o instalación → EST", options: ["Ajustar vano, muro o elemento", "Desviar fuera de escalera, shaft o junta sísmica (junta flexible si debe cruzar)"] },
  { code: "PT12", nameEs: "Modelos superpuestos o duplicados", responsibility: "COORD / dueño del archivo", options: ["Limpiar el conjunto de modelos (una vista por archivo, quitar copias ajenas o antiguas)", "Una incidencia de higiene por par de archivos"] },
  { code: "PT13", nameEs: "Higiene / información faltante", responsibility: "COORD / dueño del archivo", options: ["Excluir del test", "Pedir LOD / categoría"] },
  { code: "PT14", nameEs: "No es problema (falso positivo / tolerado)", responsibility: "—", options: ["Cerrar o marcar revisado con el motivo", "Ajustar el test para que no vuelva"] },
  { code: "PT00", nameEs: "Sin tipificar", responsibility: "COORD", options: ["Revisión humana; el resultado alimenta al curador de reglas"] },
];
const PT_BY_CODE = new Map(PROBLEM_TYPES.map((p) => [p.code, p]));
/**
 * Current wording of a chosen solution option for ACC issue text (pilot review "terms" table):
 * a number instead of a formula, and never "aprobada" about a structural opening. Decisions
 * store the option text verbatim, so older wordings are rewritten here.
 */
export function solutionText(option: string, evidence?: { penetrationMm?: { max: number } }): string {
  const o = option.trim().replace(/\.$/, "");
  if (/^Bajar penetraci[oó]n \+ 25 mm/i.test(o)) {
    const max = evidence?.penetrationMm?.max;
    return max !== undefined && max > 0 ? `Bajar el ducto ~${Math.round(max + 25)} mm (verificar altura de cielo)` : "Bajar el ducto bajo la viga (verificar altura de cielo)";
  }
  if (/^Pasada aprobada por el calculista/i.test(o)) return "Pasada sujeta a aprobación del calculista, modelada por EST";
  return o;
}

export function problemTypeOf(code: ProblemTypeCode): ProblemType {
  return PT_BY_CODE.get(code)!;
}

export function bucketOf(pt: ProblemTypeCode): FamilyBucket {
  return pt === "PT12" || pt === "PT13" ? "model_set" : pt === "PT14" ? "non_issue" : "pair";
}

export interface SignatureParts {
  problemType: ProblemTypeCode;
  hostClass: string;
  hostType?: string;
  moverClass: string;
  systemClass: string;
  sizeBand: string;
  relation: string;
}

export interface ClashFamily {
  familyId: string;
  signature: string;
  parts: SignatureParts;
  /** Data that was missing when the signature was computed. */
  flags: { orientationUnknown?: boolean; noSystem?: boolean; noSize?: boolean };
  /** Mover size (Ø or max side, mm) and host depth (mm) when known: evidence for the family pane. */
  moverSizeMm?: number;
  hostDepthMm?: number;
  /** "Entretecho {moverLevel} ({host} nivel {hostLevel})" when host and mover levels differ (beams, slabs). */
  hostLevelLabel?: string;
}

export interface FamilyContext {
  /** Origin file of an element (document whose copy is not a linked copy). */
  originFile(side: ElementFacts): string;
  /** Group of a unique clash (by ClassifiedClash.key). */
  groupOf(key: string): string | undefined;
}

export function familyIdOf(signature: string): string {
  return `F-${sha1(signature).slice(0, 10)}`;
}

// ── element roles ───────────────────────────────────────────────────────────

const STRUCT = new Set(["structure_column", "structure_framing", "structure_foundation", "structure_wall", "structure_floor", "structure_other"]);
const EQUIP = new Set(["mep_equipment", "furniture"]);
const PIPE_PRES = new Set(["pipe", "pipe_large", "fire_main", "fire_branch", "flexible", "sprinkler"]);
const DUCT = new Set(["duct", "duct_large"]);
const ELEC = new Set(["cable_tray", "conduit"]);
const ARCH = new Set(["arch_wall", "arch_floor", "door_window", "curtain_wall", "stairs", "roof", "railing", "ceiling", "elevator"]);
const MEP = new Set(["gravity_pipe", ...PIPE_PRES, ...DUCT, ...ELEC, "mep_terminal", "insulation"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Effective class: structural floors/walls in the EST model count as structure even without the flag. */
export function effectiveClass(e: ElementFacts): string {
  const cls = e.elementClass;
  if (cls === "arch_floor" && e.discipline === "EST") return "structure_floor";
  if (cls === "arch_wall" && e.discipline === "EST") return "structure_wall";
  if (cls === "other" && e.category === "Plumbing Fixtures") return "mep_equipment";
  // Slab edges (thickened edges) are structure; so is an unclassified element of the EST discipline.
  if ((cls === "other" || cls === "generic") && (/slab edge|borde de losa/i.test(String(e.category ?? "")) || e.discipline === "EST")) return "structure_other";
  return cls;
}

/** §2.1: structure 100 > equipment/fixture 95 > gravity pipe 90 > ARQ 85 > duct 60 > pressure pipe 40 > conduit/tray 30. */
export function roleRank(e: ElementFacts): number {
  const c = effectiveClass(e);
  if (STRUCT.has(c) || c === "site") return 100;
  if (EQUIP.has(c)) return 95;
  if (c === "gravity_pipe") return 90;
  if (ARCH.has(c)) return 85;
  if (DUCT.has(c)) return 60;
  if (PIPE_PRES.has(c)) return 40;
  if (ELEC.has(c)) return 30;
  return 50;
}

export function moverClassOf(e: ElementFacts): string {
  const c = effectiveClass(e);
  if (c === "gravity_pipe") return "tub_grav";
  if (PIPE_PRES.has(c)) return "tub_pres";
  if (DUCT.has(c)) return "ducto";
  if (ELEC.has(c)) return "elec";
  if (c === "insulation") return e.category === "Pipe Insulation" ? "tub_pres" : "ducto";
  return c;
}

/** System class (not the Revit system instance name). */
export function systemClassOf(e: ElementFacts): string | undefined {
  const sc = str(e.systemClassification);
  const name = `${str(e.systemName) ?? ""} ${str(e.systemType) ?? ""}`.toLowerCase();
  switch (sc) {
    case "Sanitary":
      return /vent/.test(name) ? "ALC-ventilación" : "ALC-servidas";
    case "Vent":
      return "ALC-ventilación";
    case "Storm":
      return "ALL-aguas lluvia";
    case "DomesticColdWater":
    case "DomesticHotWater":
      return "AP-agua potable";
    case "HydronicSupply":
    case "HydronicReturn":
      return "CAL-hidrónica";
    case "FireProtectionWet":
    case "FireProtectionDry":
    case "FireProtectionPreAction":
    case "FireProtectionOther":
      return "INC";
    case "SupplyAir":
      return "CLI-inyección";
    case "ReturnAir":
      return "CLI-retorno";
    case "ExhaustAir":
      return "CLI-extracción";
  }
  const d = e.discipline;
  if (d === "ALC") return /vent/.test(name) ? "ALC-ventilación" : "ALC-servidas";
  if (d === "ALL") return "ALL-aguas lluvia";
  if (d === "AP") return "AP-agua potable";
  if (d === "CAL") return "CAL-hidrónica";
  if (d === "INC") return "INC";
  if (d === "ELE" || d === "CORR" || d === "GAS") return d;
  if (d === "CLI" && (sc || name.trim())) {
    if (/extrac|exhaust|escape/.test(name)) return "CLI-extracción";
    if (/retorno|return/.test(name)) return "CLI-retorno";
    if (/inyec|supply|impuls|suministro/.test(name)) return "CLI-inyección";
  }
  return undefined;
}

/** Ø or max side of an MEP element, mm. */
export function moverSizeOf(e: ElementFacts): number | undefined {
  const d = num(e.outsideDiameterMm) ?? num(e.diameterMm);
  if (d) return d;
  const w = num(e.widthMm);
  const h = num(e.heightMm);
  if (w || h) return Math.max(w ?? 0, h ?? 0);
  return num(e.sizeMm) ?? sizeFromText(str(e.size));
}

/** Largest Ø in a size string such as `3"ø-3"ø-2"ø` or `110 mmø` (fittings carry only this). */
export function sizeFromText(s: string | undefined): number | undefined {
  if (!s) return undefined;
  let best: number | undefined;
  for (const m of s.matchAll(/(d+(?:[.,]d+)?)s*("|''|”|in|mm)?s*[øØ]/g)) {
    const v = Number(m[1]!.replace(",", "."));
    const mm = m[2] && m[2] !== "mm" ? v * 25.4 : v;
    if (mm > 0 && (best === undefined || mm > best)) best = mm;
  }
  return best;
}

const DIM = /(\d+(?:[.,]\d+)?)\s*("|''|in\b|”)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*("|''|in\b|”)?/;

/** Beam depth h (mm): element height, else parsed from the type name ("12\" x 18\"", "300x600"), else sizeMm. */
export function beamDepthOf(e: ElementFacts): number | undefined {
  const h = num(e.heightMm);
  if (h) return h;
  for (const t of [str(e.type), str(e.family)]) {
    const m = t ? DIM.exec(t) : null;
    if (m) {
      const inches = !!(m[2] || m[4]);
      const v = Number(m[3]!.replace(",", "."));
      if (v > 0) return Math.round(inches ? v * 25.4 : v);
    }
  }
  return num(e.sizeMm);
}

function isRound(e: ElementFacts): boolean {
  return !!(num(e.outsideDiameterMm) ?? num(e.diameterMm));
}

function isFoundationSlab(e: ElementFacts): boolean {
  return /slab|losa|platea|radier/i.test(`${str(e.type) ?? ""} ${str(e.family) ?? ""}`);
}

type HostKind = "beam" | "slab" | "foundation_slab" | "footing" | "column" | "struct_wall" | "struct_other" | "equipment" | "mep" | "arch_wall" | "arch" | "other";

function hostKindOf(e: ElementFacts): HostKind {
  const c = effectiveClass(e);
  if (c === "structure_framing") return "beam";
  if (c === "structure_floor" || (c === "roof" && e.discipline === "EST")) return "slab";
  if (c === "structure_foundation") return isFoundationSlab(e) ? "foundation_slab" : "footing";
  if (c === "structure_column") return "column";
  if (c === "structure_wall") return "struct_wall";
  if (c === "structure_other") return "struct_other";
  if (EQUIP.has(c)) return "equipment";
  if (MEP.has(c)) return "mep";
  if (c === "arch_wall") return "arch_wall";
  if (ARCH.has(c)) return "arch";
  return "other";
}

const HOST_KEY_NAME: Record<HostKind, string> = {
  beam: "viga",
  slab: "losa",
  foundation_slab: "losa_fundación",
  footing: "fundación",
  column: "pilar",
  struct_wall: "muro_hormigón",
  struct_other: "estructura",
  equipment: "equipo",
  mep: "instalación",
  arch_wall: "muro",
  arch: "arquitectura",
  other: "otro",
};

// ── problem type ────────────────────────────────────────────────────────────

const RULE_PT: Record<string, ProblemTypeCode> = {
  "EST-001": "PT03",
  "EST-007": "PT06",
  "MA-006": "PT06",
  "MA-007": "PT06",
  "MA-013": "PT06",
  "EST-008": "PT07",
  "MM-001": "PT08",
  "MM-003": "PT08",
  "MM-004": "PT08",
  "MM-008": "PT08",
  "MM-010": "PT08",
  "MM-005": "PT09",
  "MM-006": "PT09",
  "MM-009": "PT09",
  "MM-007": "PT10",
  "TOL-002": "PT10",
  "INC-001": "PT10",
  "MA-005": "PT10",
  "AE-002": "PT02",
  "ELV-001": "PT11",
  "SEI-001": "PT11",
};
for (const r of ["AE-001", "AE-003", "AE-004", "AE-005", "AE-006", "MA-001", "MA-002", "MA-003", "MA-004", "MA-008", "MA-009", "MA-010", "MA-011", "MA-012"]) RULE_PT[r] = "PT11";

const SLAB_VERTICAL_RULES = new Set(["EST-009", "EST-003"]);
const SLAB_HORIZONTAL_RULES = new Set(["EST-002", "EST-010"]);

function isNonIssueRule(ruleId: string): boolean {
  return (/^FP-/.test(ruleId) || /^TOL-/.test(ruleId)) && ruleId !== "TOL-002";
}

function bandAbs(size: number | undefined, duct: boolean): string {
  if (size === undefined) return duct ? "ducto?" : "Ø?";
  if (duct) return size <= 300 ? "≤300" : size <= 600 ? "301–600" : ">600";
  return size <= 50 ? "≤Ø50" : size <= 110 ? "Ø51–110" : size <= 160 ? "Ø111–160" : ">Ø160";
}

function displacement(pen: number): string {
  return pen <= 100 ? "desplazar≤100" : pen <= 250 ? "desplazar101–250" : "desplazar>250";
}

/** Host and mover per §2.1 (higher rank = host; ties: larger element, then key order). */
export function rolesOf(c: ClassifiedClash): { host: ElementFacts; mover: ElementFacts } {
  const rl = roleRank(c.left);
  const rr = roleRank(c.right);
  if (rl !== rr) return rl > rr ? { host: c.left, mover: c.right } : { host: c.right, mover: c.left };
  const sl = moverSizeOf(c.left) ?? 0;
  const sr = moverSizeOf(c.right) ?? 0;
  if (sl !== sr) return sl > sr ? { host: c.left, mover: c.right } : { host: c.right, mover: c.left };
  return String(c.left.externalId ?? "") <= String(c.right.externalId ?? "") ? { host: c.left, mover: c.right } : { host: c.right, mover: c.left };
}

function levelLabel(kind: HostKind, host: ElementFacts, mover: ElementFacts): string | undefined {
  const hl = str(host.level);
  const ml = str(mover.level);
  if (!hl || !ml || hl === ml) return undefined;
  if (kind === "beam") return `Entretecho ${ml} (viga nivel ${hl})`;
  if (kind === "slab") return `Entretecho ${ml} (losa nivel ${hl})`;
  return undefined;
}

/**
 * Physical signature of ONE unique clash (no validity, no location). Exported
 * for tests; {@link assignFamilies} applies the non-real fallback and the
 * group-dominant system fallback on top.
 */
export function physicalSignature(c: ClassifiedClash, ctx: Pick<FamilyContext, "originFile">, systemOverride?: string, sizeOverride?: number): ClashFamily {
  const ruleId = c.classification.ruleId;
  const validity = c.classification.validity;
  const { host, mover } = rolesOf(c);
  const kind = hostKindOf(host);
  const mClass = moverClassOf(mover);
  const pen = Math.max(0, c.facts.penetrationMm ?? 0);
  const ownSize = moverSizeOf(mover);
  const moverSize = ownSize ?? sizeOverride;
  const flags: ClashFamily["flags"] = {};
  if (ownSize === undefined) flags.noSize = true;
  const ruleHint = isNonIssueRule(ruleId) ? undefined : ruleId;

  const done = (parts: SignatureParts, extra: Partial<ClashFamily> = {}): ClashFamily => {
    const signature = [parts.problemType, parts.hostType ? `${parts.hostClass}:${parts.hostType}` : parts.hostClass, parts.moverClass, parts.systemClass, parts.sizeBand, parts.relation].join(" | ");
    return { familyId: familyIdOf(signature), signature, parts, flags, ...(moverSize !== undefined ? { moverSizeMm: Math.round(moverSize) } : {}), ...extra };
  };

  // PT13 hygiene / missing information (keyed rule | offending file).
  if (/^(HYG|NI)-/.test(ruleId) || validity === "needs_info") {
    const offending = [c.left, c.right].find((e) => !e.category || ["non_physical", "generic", "site", "other"].includes(effectiveClass(e)) || e.discipline === "UNK") ?? c.left;
    return done({ problemType: "PT13", hostClass: "archivo", hostType: ctx.originFile(offending), moverClass: "-", systemClass: "-", sizeBand: "-", relation: ruleId });
  }
  // PT12 duplicates and superposed structure (keyed by the origin-file pair).
  const bothStruct = STRUCT.has(effectiveClass(c.left)) && STRUCT.has(effectiveClass(c.right));
  if (/^DUP-/.test(ruleId) || bothStruct) {
    const files = [ctx.originFile(c.left), ctx.originFile(c.right)].sort();
    if (files[0] !== files[1] || /^DUP-/.test(ruleId)) {
      return done({ problemType: "PT12", hostClass: "archivos", hostType: files.join(" + "), moverClass: "-", systemClass: "-", sizeBand: "-", relation: files[0] === files[1] ? ruleId : "superpuestos" });
    }
    // Same origin file: a joint seen through a linked copy → not a problem.
    return done({ problemType: "PT14", hostClass: "estructura", moverClass: "estructura", systemClass: "-", sizeBand: "-", relation: "mismo_archivo_origen" });
  }

  const moverIsMep = MEP.has(effectiveClass(mover));
  const sys = systemOverride ?? (moverIsMep ? systemClassOf(mover) : mover.discipline === "UNK" ? "SIN" : mover.discipline);
  if (!sys) flags.noSystem = true;
  const moverDuct = mClass === "ducto";
  let pt: ProblemTypeCode = (ruleHint && RULE_PT[ruleHint]) || "PT00";
  let hostClass: string = HOST_KEY_NAME[kind];
  let hostType: string | undefined;
  let sizeBand: string;
  let relation: string;
  let hostDepth: number | undefined;
  let systemClass = sys ?? `${mover.discipline === "UNK" ? "SIN" : mover.discipline}-?`;

  switch (kind) {
    case "beam": {
      hostType = str(host.type);
      hostDepth = beamDepthOf(host);
      if (pt === "PT00" || pt === "PT02") pt = hostDepth && pen >= hostDepth / 2 ? "PT01" : "PT02";
      sizeBand = hostDepth && moverSize ? (moverSize <= hostDepth / 3 ? "≤h/3" : ">h/3") : "h?";
      relation = hostDepth && pen >= hostDepth / 2 ? "atraviesa_alma" : displacement(pen);
      break;
    }
    case "slab":
    case "foundation_slab": {
      hostType = str(host.type);
      sizeBand = moverDuct || (!isRound(mover) && moverSize !== undefined && mClass !== "tub_grav" && mClass !== "tub_pres") ? "rect" : moverSize === undefined ? "Ø?" : moverSize <= 110 ? "≤Ø110" : moverSize <= 160 ? "Ø111–160" : ">Ø160";
      if (kind === "foundation_slab") {
        pt = pt === "PT00" || SLAB_VERTICAL_RULES.has(ruleId) || SLAB_HORIZONTAL_RULES.has(ruleId) || ruleId === "EST-011" ? "PT07" : pt;
        relation = "fundación";
        break;
      }
      const o = mover.orientation;
      const vertical = o === "vertical" || (!o && SLAB_VERTICAL_RULES.has(ruleId));
      const horizontal = o === "horizontal" || o === "sloped" || (!o && SLAB_HORIZONTAL_RULES.has(ruleId));
      if (vertical) {
        pt = "PT04";
        relation = "vertical";
      } else if (horizontal) {
        pt = "PT05";
        relation = `horiz_pend·${pen <= 100 ? "desplazar≤100" : "desplazar>100"}`;
      } else {
        pt = "PT04";
        relation = "orient_desc";
        flags.orientationUnknown = true;
      }
      break;
    }
    case "footing": {
      if (pt === "PT00") pt = "PT07";
      sizeBand = bandAbs(moverSize, moverDuct);
      relation = "fundación";
      break;
    }
    case "column": {
      if (pt === "PT00") pt = "PT03";
      sizeBand = bandAbs(moverSize, moverDuct);
      relation = "atraviesa";
      break;
    }
    case "struct_wall": {
      hostType = str(host.type);
      if (pt === "PT00") pt = "PT06";
      sizeBand = bandAbs(moverSize, moverDuct);
      relation = "atraviesa";
      break;
    }
    case "equipment": {
      hostType = str(host.family) ?? str(host.type);
      if (pt === "PT00" || pt === "PT08") pt = "PT09";
      // PT09: discipline only (the connection is what matters, not the system).
      systemClass = mover.discipline === "UNK" ? "SIN" : mover.discipline;
      sizeBand = moverDuct ? "ducto" : mClass === "elec" ? "elec" : "tubería";
      relation = "contacto_equipo";
      break;
    }
    case "mep": {
      hostType = systemClassOf(host) ?? (host.discipline === "UNK" ? "SIN" : host.discipline);
      hostClass = moverClassOf(host);
      if (pt === "PT00") pt = "PT08";
      sizeBand = moverDuct ? "ducto" : mClass === "elec" ? "elec" : "tubería";
      relation = "cruce";
      break;
    }
    case "arch_wall": {
      hostType = str(host.type);
      if (pt === "PT00") pt = "PT11";
      sizeBand = bandAbs(moverSize, moverDuct);
      relation = "atraviesa";
      break;
    }
    case "arch": {
      if (pt === "PT00") pt = "PT11";
      sizeBand = bandAbs(moverSize, moverDuct);
      relation = "contacto";
      break;
    }
    default: {
      sizeBand = bandAbs(moverSize, moverDuct);
      relation = "contacto";
    }
  }
  return done(
    { problemType: pt, hostClass, ...(hostType ? { hostType } : {}), moverClass: mClass, systemClass, sizeBand, relation },
    { ...(hostDepth ? { hostDepthMm: Math.round(hostDepth) } : {}), ...(levelLabel(kind, host, mover) ? { hostLevelLabel: levelLabel(kind, host, mover) } : {}) },
  );
}

function involvesStructure(c: ClassifiedClash): boolean {
  return STRUCT.has(effectiveClass(c.left)) || STRUCT.has(effectiveClass(c.right));
}

/**
 * Families for every unique clash. Deterministic: iterates in key order.
 * 1. physical signature; 2. a mover without a system class inherits its group's
 * dominant system class; 3. non-real clashes join a physical family only when
 * that family has real members, else a PT14 rule batch.
 */
export function assignFamilies(clashes: readonly ClassifiedClash[], ctx: FamilyContext): Map<string, ClashFamily> {
  const sorted = [...clashes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const first = new Map<string, ClashFamily>();
  for (const c of sorted) first.set(c.key, physicalSignature(c, ctx));

  // 2. group-dominant system class for movers without one.
  const sysByGroup = new Map<string, Map<string, number>>();
  for (const c of sorted) {
    const f = first.get(c.key)!;
    const g = ctx.groupOf(c.key);
    if (!g || f.flags.noSystem || ["PT12", "PT13", "PT14"].includes(f.parts.problemType)) continue;
    const sys = systemClassOf(rolesOf(c).mover);
    if (!sys) continue;
    const m = sysByGroup.get(g) ?? new Map<string, number>();
    m.set(sys, (m.get(sys) ?? 0) + 1);
    sysByGroup.set(g, m);
  }
  // Mover size unknown (fittings without a numeric size): the group's median size of the same mover class.
  const sizesByGroup = new Map<string, number[]>();
  for (const c of sorted) {
    const g = ctx.groupOf(c.key);
    const mover = rolesOf(c).mover;
    const s = moverSizeOf(mover);
    if (!g || s === undefined) continue;
    const k = `${g}|${moverClassOf(mover)}`;
    sizesByGroup.set(k, [...(sizesByGroup.get(k) ?? []), s]);
  }
  const fam = new Map<string, ClashFamily>();
  for (const c of sorted) {
    let f = first.get(c.key)!;
    if (f.flags.noSystem || f.flags.noSize) {
      const g = ctx.groupOf(c.key);
      const m = g && f.flags.noSystem ? sysByGroup.get(g) : undefined;
      const sys = m ? [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] : undefined;
      const sizes = g && f.flags.noSize ? sizesByGroup.get(`${g}|${moverClassOf(rolesOf(c).mover)}`) : undefined;
      const size = sizes?.length ? [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : undefined;
      if (sys || size !== undefined) {
        const re = physicalSignature(c, ctx, sys, size);
        f = { ...re, flags: { ...re.flags, ...(f.flags.noSystem ? { noSystem: !sys } : {}), ...(f.flags.noSize ? { noSize: true } : {}) } };
        if (sys) f.flags.noSystem = false;
      }
    }
    fam.set(c.key, f);
  }

  // 3. non-real fallback.
  const hasReal = new Set<string>();
  for (const c of sorted) if (c.classification.validity === "real") hasReal.add(fam.get(c.key)!.familyId);
  for (const c of sorted) {
    const f = fam.get(c.key)!;
    const v = c.classification.validity;
    if ((v !== "false_positive" && v !== "tolerated") || ["PT12", "PT13", "PT14"].includes(f.parts.problemType) || hasReal.has(f.familyId)) continue;
    const parts: SignatureParts = {
      problemType: "PT14",
      hostClass: "regla",
      hostType: c.classification.ruleId,
      moverClass: "-",
      systemClass: "-",
      sizeBand: v,
      relation: involvesStructure(c) ? "con estructura" : "entre instalaciones",
    };
    const signature = [parts.problemType, `${parts.hostClass}:${parts.hostType}`, parts.moverClass, parts.systemClass, parts.sizeBand, parts.relation].join(" | ");
    fam.set(c.key, { familyId: familyIdOf(signature), signature, parts, flags: {}, ...(f.moverSizeMm !== undefined ? { moverSizeMm: f.moverSizeMm } : {}) });
  }
  return fam;
}

// ── Spanish family title ────────────────────────────────────────────────────

const MOVER_ES: Record<string, string> = {
  tub_grav: "Tuberías gravitacionales",
  tub_pres: "Tuberías",
  ducto: "Ductos",
  elec: "Canalizaciones eléctricas",
  arch_wall: "Muros",
  arch_floor: "Pisos",
  curtain_wall: "Muros cortina",
  door_window: "Puertas/ventanas",
  ceiling: "Cielos",
  stairs: "Escaleras",
  roof: "Cubiertas",
  railing: "Barandas",
  mep_equipment: "Equipos",
  mep_terminal: "Terminales",
  furniture: "Mobiliario",
  generic: "Modelos genéricos",
  other: "Elementos",
};
const HOST_ES: Record<string, string> = {
  viga: "vigas",
  losa: "losas",
  losa_fundación: "losa de fundación",
  fundación: "fundaciones",
  pilar: "pilares",
  muro_hormigón: "muros de hormigón",
  estructura: "estructura",
  equipo: "equipo/artefacto",
  muro: "muros",
  arquitectura: "arquitectura",
  otro: "elementos",
};
const VERB: Partial<Record<ProblemTypeCode, string>> = {
  PT01: "atraviesan el alma de",
  PT02: "invaden el fondo de",
  PT03: "atraviesan",
  PT04: "cruzan sin pasada",
  PT05: "embebidas en",
  PT06: "atraviesan",
  PT07: "en",
  PT08: "cruzan",
  PT09: "contra",
  PT10: "sin holgura con",
  PT11: "contra",
  PT00: "contra",
};

function hint(p: SignatureParts): string | undefined {
  if (p.problemType === "PT02") return p.relation.replace("desplazar", "bajar ") + " mm";
  if (p.problemType === "PT01") return "pasada en alma (calculista)";
  if (p.problemType === "PT03") return "desviar (pilar sin pasadas)";
  if (p.problemType === "PT04") return p.relation === "orient_desc" ? "orientación por confirmar" : "pasada en losa";
  if (p.problemType === "PT05") return "bajar al entretecho";
  if (p.problemType === "PT07") return "revisar cotas / camisa";
  return undefined;
}

export function familyTitle(p: SignatureParts, sizes: readonly number[]): string {
  if (p.problemType === "PT12") return `Modelos superpuestos: ${p.hostType ?? "?"}`;
  if (p.problemType === "PT13") return `Higiene ${p.relation} · ${p.hostType ?? "?"}`;
  if (p.problemType === "PT14") {
    if (p.relation === "mismo_archivo_origen") return "Uniones de estructura del mismo archivo (vistas por copia vinculada)";
    const v = p.sizeBand === "false_positive" ? "falso positivo" : "tolerado";
    return `No es problema · ${p.hostType ?? "?"} · ${v} · ${p.relation}`;
  }
  const mover = MOVER_ES[p.moverClass] ?? p.moverClass;
  const range = sizes.length ? (() => {
    const lo = Math.round(Math.min(...sizes));
    const hi = Math.round(Math.max(...sizes));
    return p.moverClass === "tub_grav" || p.moverClass === "tub_pres" ? (lo === hi ? `Ø${lo}` : `Ø${lo}–${hi}`) : lo === hi ? `${lo} mm` : `${lo}–${hi} mm`;
  })() : "";
  const host = p.hostClass in HOST_ES ? HOST_ES[p.hostClass]! : `${MOVER_ES[p.hostClass]?.toLowerCase() ?? p.hostClass}`;
  const hostType = p.hostType ? ` ${p.hostType}` : "";
  const h = hint(p);
  return `${mover} ${p.systemClass}${range ? ` ${range}` : ""} ${VERB[p.problemType] ?? "contra"} ${host}${hostType}${h ? ` · ${h}` : ""}`.replace(/\s+/g, " ").trim();
}
