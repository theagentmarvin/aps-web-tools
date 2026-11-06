/**
 * Element enrichment: raw properties -> ElementFacts (classification-rules.yaml
 * §4, discipline-matrix.yaml convention 4).
 *
 * Order: normalize category and system classification -> modelDiscipline
 * (file name) -> discipline (system refinement / category fallback) ->
 * sizeMm -> derived flags (in listed order) -> elementClass + moveRank.
 * sizeMm is computed before the flags (it depends only on raw fields and the
 * canonical category), so flags may also use it.
 */
import { invalidateNorm, withNormCache } from "../rules/matcher";
import { ELEMENT_NUMERIC_FIELDS, ELEMENT_RAW_FIELDS } from "../rules/fields";
import { FOREIGN_FIELD, type CompiledRuleSet } from "../rules/load";
import { norm } from "../util/text";

export type Orientation = "vertical" | "horizontal" | "sloped";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Engine input for one element. `ElementProps` from core/types.ts is
 * assignable to it; `orientation` and `modelAgeDays` may be supplied by the
 * caller (geometry / document metadata).
 */
export interface ElementInput {
  externalId?: string;
  elementId?: string;
  documentId?: number | string;
  modelFile?: string;
  documentName?: string;
  category?: string;
  family?: string;
  type?: string;
  name?: string;
  level?: string;
  systemClassification?: string;
  systemType?: string;
  systemName?: string;
  diameterMm?: number;
  outsideDiameterMm?: number;
  widthMm?: number;
  heightMm?: number;
  thicknessMm?: number;
  insulationThicknessMm?: number;
  material?: string;
  workset?: string;
  phaseCreated?: string;
  phaseDemolished?: string;
  fireRating?: string;
  structural?: boolean;
  orientation?: Orientation;
  modelAgeDays?: number;
  /** Bounding box in metres (used to derive `orientation`). */
  bbox?: { min: Vec3Like; max: Vec3Like };
}

/** Enriched element: raw fields + derived fields + one boolean per derived flag. */
export interface ElementFacts {
  [field: string]: unknown;
  externalId?: string;
  documentId?: number | string;
  modelFile?: string;
  documentName?: string;
  /** Canonical category (English Revit name) or the normalized raw value. */
  category?: string;
  /** Category as received. */
  categoryRaw?: string;
  family?: string;
  type?: string;
  level?: string;
  /** Canonical system classification (e.g. `DomesticColdWater`) or the raw value. */
  systemClassification?: string;
  systemClassificationRaw?: string;
  systemType?: string;
  systemName?: string;
  orientation?: Orientation;
  modelDiscipline?: string;
  discipline: string;
  disciplineGroup: string;
  categoryDiscipline?: string;
  sizeMm?: number;
  elementClass: string;
  moveRank?: number;
}

const INSULATION_HOST: Record<string, string> = {
  "Pipe Insulation": "Pipes",
  "Duct Insulation": "Ducts",
  "Duct Linings": "Ducts",
};
const SLAB_LIKE = new Set(["Floors", "Ceilings", "Roofs"]);
const ORIENTABLE = new Set(["Pipes", "Ducts", "Cable Tray", "Conduits", "Flex Pipes", "Flex Ducts", "Pipe Insulation", "Duct Insulation"]);
/** Rank used for `moveRank: inherit` when the host class is unknown (matrix comment). */
const INHERIT_FALLBACK_RANK = 40;

export function canonicalCategory(rs: CompiledRuleSet, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let n = norm(raw);
  for (const p of rs.categoryPrefixStrip) if (n.startsWith(p)) n = n.slice(p.length);
  return rs.categoryCanon.get(n) ?? n;
}

export function canonicalSystemClassification(rs: CompiledRuleSet, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = norm(raw);
  for (const a of rs.systemAliases) if (a.regexes.some((r) => r.test(n))) return a.canonical;
  return raw;
}

/** modelDiscipline from the file name (ISO 19650 role, then token patterns). */
export function fileDiscipline(rs: CompiledRuleSet, documentName: string | undefined): string | undefined {
  if (!documentName) return undefined;
  const base = norm(documentName).replace(/\.[a-z0-9]+$/, "");
  const fields = base.split("-");
  if (fields.length >= 7 && rs.iso.modelTypes.has(fields[4]!)) {
    const role = fields[5]!;
    const code = rs.iso.roleCodes.get(role) ?? rs.disciplineAliases.get(role);
    if (code) return code;
  }
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  for (const p of rs.fileNamePatterns) {
    if (tokens.some((t) => p.tokens.has(t)) || (p.regex && p.regex.test(base))) return p.discipline;
  }
  return undefined;
}

/** Orientation from an axis-aligned bounding box (metres). Undefined when not elongated. */
export function orientationFromBbox(bbox: { min: Vec3Like; max: Vec3Like }): Orientation | undefined {
  const dx = Math.abs(bbox.max.x - bbox.min.x);
  const dy = Math.abs(bbox.max.y - bbox.min.y);
  const dz = Math.abs(bbox.max.z - bbox.min.z);
  const plan = Math.max(dx, dy);
  if (!(plan > 0 || dz > 0)) return undefined;
  if (dz > 3 * plan) return "vertical";
  if (plan > 3 * dz) return "horizontal";
  const longest = Math.max(dx, dy, dz);
  const shortest = Math.min(dx, dy, dz);
  return longest >= 3 * shortest ? "sloped" : undefined;
}

const maxWH = (w: number | undefined, h: number | undefined) =>
  w === undefined && h === undefined ? undefined : Math.max(w ?? -Infinity, h ?? -Infinity);

function sizeOf(el: ElementFacts): number | undefined {
  const n = (k: string) => (typeof el[k] === "number" ? (el[k] as number) : undefined);
  const cat = el.category ?? "";
  const od = n("outsideDiameterMm"), d = n("diameterMm"), w = n("widthMm"), h = n("heightMm"), t = n("thicknessMm");
  if (INSULATION_HOST[cat]) {
    const host = od ?? d ?? maxWH(w, h);
    const it = n("insulationThicknessMm");
    if (host !== undefined && it !== undefined) return host + 2 * it;
    return it ?? host;
  }
  if (cat === "Walls") return w ?? t;
  if (SLAB_LIKE.has(cat)) return t;
  if (cat === "Structural Framing") return h ?? maxWH(w, h);
  if (cat === "Structural Columns") return maxWH(w, h) ?? d ?? od;
  return od ?? d ?? maxWH(w, h) ?? t;
}

function setField(el: ElementFacts, field: string, value: unknown): void {
  if (value === undefined) delete el[field];
  else el[field] = value;
  invalidateNorm(el, field);
}

/** Enrich one element. Pure; the result is safe to cache per element. */
export function enrichElement(rs: CompiledRuleSet, input: ElementInput, depth = 0): ElementFacts {
  const el = withNormCache({ discipline: "UNK", disciplineGroup: "UNK", elementClass: "other" } as ElementFacts);
  const src = input as Record<string, unknown>;
  for (const f of ELEMENT_RAW_FIELDS) {
    let v = src[f];
    if (v === undefined || v === null || v === "") continue;
    if (ELEMENT_NUMERIC_FIELDS.has(f) && typeof v === "string") {
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      v = num;
    }
    (el as Record<string, unknown>)[f] = v;
  }
  if (input.category !== undefined && input.category !== "") el.categoryRaw = input.category;
  setField(el, "category", canonicalCategory(rs, input.category));
  if (input.systemClassification) el.systemClassificationRaw = input.systemClassification;
  setField(el, "systemClassification", canonicalSystemClassification(rs, input.systemClassification));
  if (el.orientation === undefined && input.bbox && el.category && ORIENTABLE.has(el.category)) {
    setField(el, "orientation", orientationFromBbox(input.bbox));
  }

  // Discipline.
  const modelDiscipline = fileDiscipline(rs, input.documentName);
  setField(el, "modelDiscipline", modelDiscipline);
  const categoryDiscipline = el.category ? rs.categoryDefaults.get(el.category) : undefined;
  setField(el, "categoryDiscipline", categoryDiscipline);
  let d = modelDiscipline && modelDiscipline !== "UNK" ? modelDiscipline : undefined;
  if (!d || rs.refinableFrom.has(d)) {
    for (const r of rs.systemRefinement) {
      if (r.when(el, {})) {
        d = r.discipline;
        break;
      }
    }
  }
  setField(el, "discipline", d ?? categoryDiscipline ?? "UNK");
  setField(el, "disciplineGroup", rs.disciplines.get(el.discipline)?.group ?? "UNK");

  const mg = modelDiscipline ? rs.disciplines.get(modelDiscipline)?.group : undefined;
  const cg = categoryDiscipline ? rs.disciplines.get(categoryDiscipline)?.group : undefined;
  const ignored = (g: string | undefined) => g === undefined || g === "COORD" || g === "UNK";
  el[FOREIGN_FIELD] = !(el.category && rs.foreignExempt.has(el.category)) && !ignored(mg) && !ignored(cg) && mg !== cg;
  Object.defineProperty(el, FOREIGN_FIELD, { enumerable: false });

  setField(el, "sizeMm", sizeOf(el));

  // Flags: default false, then evaluated in listed order.
  for (const f of rs.derivedFlags) el[f.flag] = false;
  for (const f of rs.derivedFlags) setField(el, f.flag, f.when(el, {}));

  // Element class (first match wins) + move rank.
  for (const c of rs.elementClasses) {
    if (!c.when(el, {})) continue;
    setField(el, "elementClass", c.cls);
    let rank: number | undefined;
    if (c.moveRank === "inherit") {
      const host = el.category ? INSULATION_HOST[el.category] : undefined;
      if (host && depth === 0) {
        const hostEl = enrichElement(rs, { ...input, category: host, insulationThicknessMm: undefined }, depth + 1);
        rank = hostEl.moveRank ?? INHERIT_FALLBACK_RANK;
      } else rank = INHERIT_FALLBACK_RANK;
    } else rank = c.moveRank ?? undefined;
    setField(el, "moveRank", rank);
    break;
  }
  return el;
}
