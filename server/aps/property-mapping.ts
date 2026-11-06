/**
 * Index v2 rows → {@link ElementProps} using the `/fields` dictionary.
 *
 * research §4 / §4.1:
 * - Field keys (`p5eddc473`) look like hashes but are UNVERIFIED as stable,
 *   so they are resolved at runtime from the fields NDJSON, never hard-coded.
 * - Revit pseudo-fields: `__category__/_RC` (category), `_RFN` (family),
 *   `_RFT` (type), `__name__/name`; `__category__/Category` ("Revit Pipes").
 * - Level and system are ordinary Revit parameters whose names vary by
 *   category and language, so they are found through a configurable,
 *   precedence-ordered alias list (English + Revit es-ES names).
 *
 * Pure module (no I/O) so it is easy to test and reuse.
 */
import type { ElementProps, PropValue } from "../../core/types";
import type { IndexField, IndexRow } from "./types";

export type LengthUnit = "mm" | "cm" | "m" | "ft" | "in";

/** Precedence-ordered parameter names per canonical property. First non-empty value wins. */
export interface PropertyAliases {
  level: string[];
  systemClassification: string[];
  systemType: string[];
  systemName: string[];
  size: string[];
  diameter: string[];
  outsideDiameter: string[];
  width: string[];
  height: string[];
  thickness: string[];
  insulationThickness: string[];
  material: string[];
  workset: string[];
  phaseCreated: string[];
  phaseDemolished: string[];
  fireRating: string[];
  structural: string[];
  comments: string[];
  mark: string[];
}

export const PROPERTY_ALIAS_KEYS = [
  "level",
  "systemClassification",
  "systemType",
  "systemName",
  "size",
  "diameter",
  "outsideDiameter",
  "width",
  "height",
  "thickness",
  "insulationThickness",
  "material",
  "workset",
  "phaseCreated",
  "phaseDemolished",
  "fireRating",
  "structural",
  "comments",
  "mark",
] as const satisfies readonly (keyof PropertyAliases)[];

/**
 * Mapping configuration. The alias lists are DATA, loaded from
 * rules/property-aliases.yaml by `loadPropertyAliases()` in ./index-properties.ts.
 */
export interface PropertyMappingConfig {
  aliases: PropertyAliases;
  /** Unit for numeric length fields whose `uom` is null (UNVERIFIED). */
  lengthUnitWhenMissing: LengthUnit;
  /** Unit of Index bboxMin/bboxMax (model units, UNVERIFIED). */
  bboxUnit: LengthUnit;
}

/** Lowercase, strip accents, trim, collapse whitespace (rules/discipline-matrix.yaml convention 1). */
export function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Map a `uom` string (e.g. "mm", "ft", "autodesk.unit.unit:millimeters-1.0.1") to a length unit. */
export function parseLengthUom(uom: string | null | undefined): LengthUnit | undefined {
  if (!uom) return undefined;
  const u = normalizeName(uom);
  if (u === "mm" || u.includes("millimet")) return "mm";
  if (u === "cm" || u.includes("centimet")) return "cm";
  if (u === "m" || u.includes("meter") || u.includes("metre")) return "m";
  if (u === "ft" || u.includes("feet") || u.includes("foot")) return "ft";
  if (u === "in" || u === '"' || u.includes("inch")) return "in";
  return undefined;
}

const MM: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, ft: 304.8, in: 25.4 };

/**
 * Value → millimetres. Numbers use the field `uom` (or `assumeUnit` when the
 * uom is missing); strings like "110 mm", "0,984 ft", "Ø110" carry their own unit.
 */
export function toMillimetres(value: PropValue, uom: string | null | undefined, assumeUnit: LengthUnit): number | undefined {
  let n: number | undefined;
  let unit = parseLengthUom(uom) ?? assumeUnit;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const m = /(-?\d+(?:[.,]\d+)?)\s*(mm|cm|m|ft|in|")?/i.exec(value);
    if (!m) return undefined;
    n = Number(m[1].replace(",", "."));
    if (m[2]) unit = parseLengthUom(m[2]) ?? unit;
  }
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return Math.round(n * MM[unit] * 100) / 100;
}

function isEmpty(v: PropValue | undefined): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Lookup over the `/fields` NDJSON. */
export class FieldDictionary {
  private readonly byKeyMap = new Map<string, IndexField>();
  private readonly byName = new Map<string, string[]>();
  private readonly byCatName = new Map<string, string>();

  constructor(fields: readonly IndexField[]) {
    for (const f of fields) {
      this.byKeyMap.set(f.key, f);
      const n = normalizeName(f.name);
      const list = this.byName.get(n);
      if (list) list.push(f.key);
      else this.byName.set(n, [f.key]);
      this.byCatName.set(`${f.category}\u0000${f.name}`, f.key);
    }
  }

  field(key: string): IndexField | undefined {
    return this.byKeyMap.get(key);
  }

  /** Exact (category, name) lookup, e.g. ("__category__", "_RC"). */
  key(category: string, name: string): string | undefined {
    return this.byCatName.get(`${category}\u0000${name}`);
  }

  /** Field keys for a precedence-ordered alias list (accent/case-insensitive; pseudo-fields excluded). */
  keysFor(aliases: readonly string[]): string[] {
    const out: string[] = [];
    for (const a of aliases) {
      for (const k of this.byName.get(normalizeName(a)) ?? []) {
        if (!this.byKeyMap.get(k)!.category.startsWith("__")) out.push(k);
      }
    }
    return out;
  }
}

/** Document context stamped on every mapped row. */
export interface MapRowContext {
  documentId?: number;
  /** Seed lineage URN. */
  modelFile?: string;
  documentName?: string;
}

/** Pre-resolved alias → keys table; build once per index with {@link compileMapper}. */
export type RowMapper = (row: IndexRow) => ElementProps;

function bboxToMetres(row: IndexRow, unit: LengthUnit): ElementProps["bbox"] {
  if (!row.bboxMin || !row.bboxMax) return undefined;
  const f = MM[unit] / 1000;
  const r = (v: number): number => Math.round(v * f * 1e6) / 1e6;
  const conv = (p: { x: number; y: number; z: number }) => ({ x: r(p.x), y: r(p.y), z: r(p.z) });
  return { min: conv(row.bboxMin), max: conv(row.bboxMax) };
}

export function compileMapper(dict: FieldDictionary, config: PropertyMappingConfig, context: MapRowContext = {}): RowMapper {
  const assume = config.lengthUnitWhenMissing;
  const keys = Object.fromEntries(
    PROPERTY_ALIAS_KEYS.map((k) => [k, dict.keysFor(config.aliases[k] ?? [])]),
  ) as Record<keyof PropertyAliases, string[]>;
  const kRC = dict.key("__category__", "_RC");
  const kCategory = dict.key("__category__", "Category");
  const kRFN = dict.key("__category__", "_RFN");
  const kRFT = dict.key("__category__", "_RFT");
  const kName = dict.key("__name__", "name");

  return (row) => {
    const props = row.props ?? {};
    const first = (ks: readonly string[]): { value: PropValue; key: string } | undefined => {
      for (const k of ks) if (!isEmpty(props[k])) return { value: props[k], key: k };
      return undefined;
    };
    const str = (ks: readonly string[]): string | undefined => {
      const f = first(ks);
      return f ? String(f.value).trim() : undefined;
    };
    const len = (ks: readonly string[]): number | undefined => {
      const f = first(ks);
      return f ? toMillimetres(f.value, dict.field(f.key)?.uom, assume) : undefined;
    };
    const one = (k: string | undefined): string | undefined => (k && !isEmpty(props[k]) ? String(props[k]).trim() : undefined);

    const raw: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(props)) {
      const f = dict.field(k);
      raw[f ? `${f.category}/${f.name}` : k] = v;
    }

    const name = one(kName);
    const category = one(kRC) ?? one(kCategory)?.replace(/^Revit\s+/i, "");
    const systemClassification = str(keys.systemClassification);
    const systemType = str(keys.systemType);
    const systemName = str(keys.systemName);
    const structuralRaw = first(keys.structural)?.value;

    const out: ElementProps = {
      documentId: context.documentId,
      modelFile: context.modelFile,
      documentName: context.documentName,
      lmvId: row.lmvId,
      svf2Id: row.svf2Id,
      externalId: row.externalId,
      elementId: name ? /\[(\d+)\]\s*$/.exec(name)?.[1] : undefined,
      name,
      category,
      family: one(kRFN),
      type: one(kRFT),
      level: str(keys.level),
      system: systemName ?? systemType ?? systemClassification,
      systemClassification,
      systemType,
      systemName,
      size: str(keys.size),
      diameterMm: len(keys.diameter),
      outsideDiameterMm: len(keys.outsideDiameter),
      widthMm: len(keys.width),
      heightMm: len(keys.height),
      thicknessMm: len(keys.thickness),
      insulationThicknessMm: len(keys.insulationThickness),
      material: str(keys.material),
      workset: str(keys.workset),
      phaseCreated: str(keys.phaseCreated),
      phaseDemolished: str(keys.phaseDemolished),
      fireRating: str(keys.fireRating),
      structural:
        structuralRaw === undefined
          ? undefined
          : structuralRaw === true || structuralRaw === 1 || /^(yes|si|sí|true|1)$/i.test(String(structuralRaw)),
      comments: str(keys.comments),
      mark: str(keys.mark),
      bbox: bboxToMetres(row, config.bboxUnit),
      views: row.views ?? [],
      raw,
    };
    // Drop undefined keys so cached JSON stays compact.
    for (const k of Object.keys(out) as (keyof ElementProps)[]) if (out[k] === undefined) delete out[k];
    return out;
  };
}

/** Convenience one-shot mapping. Prefer {@link compileMapper} for many rows. */
export function mapIndexRow(
  row: IndexRow,
  dict: FieldDictionary,
  config: PropertyMappingConfig,
  context: MapRowContext = {},
): ElementProps {
  return compileMapper(dict, config, context)(row);
}
