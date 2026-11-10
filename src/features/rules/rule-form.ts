/**
 * Guided "Editar condiciones" form ↔ rule (pure, unit-tested).
 *
 * The form covers the common shapes of rules/classification-rules.yaml: per side discipline,
 * element class (or class set), category, system type contains, orientation and size range;
 * common conditions penetration ≥, distance < and same level; the whole outcome. A rule that
 * uses anything else (anyOf / not, refs, other fields or ops) returns null from ruleToForm and
 * opens in the advanced YAML editor, validated by the same server loader.
 */
import type { RuleDefinition } from "~/lib/api/types";

export interface SideForm {
  disciplines: string[];
  classes: string[];
  /** elementClass: { inSet: NAME } (exclusive with classes). */
  classSet: string;
  categories: string[];
  /** systemType: { matches: … } (regex on the normalised text). */
  systemMatches: string;
  orientation: string[];
  sizeMin: number | null;
  sizeMax: number | null;
  /** gte (≥, default) or gt (>). */
  sizeMinOp?: "gte" | "gt";
  /** lte (≤, default) or lt (<). */
  sizeMaxOp?: "lte" | "lt";
}

export interface RuleForm {
  id: string;
  name: string;
  nameEs: string;
  /** Same conditions on both sides (`both`). */
  symmetric: boolean;
  a: SideForm;
  b: SideForm;
  penetrationMinMm: number | null;
  distanceMaxMm: number | null;
  sameLevel: boolean | null;
  then: RuleDefinition["then"];
}

export const emptySide = (): SideForm => ({ disciplines: [], classes: [], classSet: "", categories: [], systemMatches: "", orientation: [], sizeMin: null, sizeMax: null });

const SIDE_KEYS = new Set(["discipline", "elementClass", "category", "systemType", "orientation", "sizeMm"]);
const CLASH_KEYS = new Set(["penetrationMm", "distanceMm", "sameLevel"]);

const strList = (v: unknown): string[] | null => (typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

function sideToForm(m: unknown): SideForm | null {
  const f = emptySide();
  if (m === undefined) return f;
  if (!isObj(m)) return null;
  for (const [k, v] of Object.entries(m)) {
    if (!SIDE_KEYS.has(k)) return null;
    if (k === "discipline" || k === "category" || k === "orientation") {
      const l = strList(v);
      if (!l) return null;
      if (k === "discipline") f.disciplines = l;
      else if (k === "category") f.categories = l;
      else f.orientation = l;
    } else if (k === "elementClass") {
      if (isObj(v)) {
        if (!onlyKeys(v, ["inSet"]) || typeof v.inSet !== "string") return null;
        f.classSet = v.inSet;
      } else {
        const l = strList(v);
        if (!l) return null;
        f.classes = l;
      }
    } else if (k === "systemType") {
      if (!isObj(v) || !onlyKeys(v, ["matches"]) || typeof v.matches !== "string") return null;
      f.systemMatches = v.matches;
    } else if (k === "sizeMm") {
      if (!isObj(v) || !onlyKeys(v, ["gte", "gt", "lte", "lt"])) return null;
      if (Object.values(v).some((x) => typeof x !== "number")) return null;
      if ((v.gte !== undefined && v.gt !== undefined) || (v.lte !== undefined && v.lt !== undefined)) return null;
      f.sizeMin = ((v.gte ?? v.gt) as number | undefined) ?? null;
      f.sizeMax = ((v.lte ?? v.lt) as number | undefined) ?? null;
      if (v.gt !== undefined) f.sizeMinOp = "gt";
      if (v.lt !== undefined) f.sizeMaxOp = "lt";
    }
  }
  return f;
}

const one = (l: string[]): string | string[] => (l.length === 1 ? l[0]! : l);

function sideToMatcher(f: SideForm): Record<string, unknown> | undefined {
  const m: Record<string, unknown> = {};
  if (f.disciplines.length) m.discipline = one(f.disciplines);
  if (f.classSet) m.elementClass = { inSet: f.classSet };
  else if (f.classes.length) m.elementClass = one(f.classes);
  if (f.categories.length) m.category = one(f.categories);
  if (f.systemMatches.trim()) m.systemType = { matches: f.systemMatches.trim() };
  if (f.orientation.length) m.orientation = one(f.orientation);
  if (f.sizeMin !== null || f.sizeMax !== null) m.sizeMm = { ...(f.sizeMin !== null ? { [f.sizeMinOp ?? "gte"]: f.sizeMin } : {}), ...(f.sizeMax !== null ? { [f.sizeMaxOp ?? "lte"]: f.sizeMax } : {}) };
  return Object.keys(m).length ? m : undefined;
}

/** The form of a rule, or null when the rule needs the advanced editor. */
export function ruleToForm(r: RuleDefinition): RuleForm | null {
  const w = (r.when ?? {}) as Record<string, unknown>;
  if (!onlyKeys(w, ["clash", "a", "b", "both"])) return null;
  if (w.both !== undefined && (w.a !== undefined || w.b !== undefined)) return null;
  const symmetric = w.both !== undefined;
  const a = sideToForm(symmetric ? w.both : w.a);
  const b = symmetric ? emptySide() : sideToForm(w.b);
  if (!a || !b) return null;
  let penetrationMinMm: number | null = null;
  let distanceMaxMm: number | null = null;
  let sameLevel: boolean | null = null;
  if (w.clash !== undefined) {
    if (!isObj(w.clash)) return null;
    for (const [k, v] of Object.entries(w.clash)) {
      if (!CLASH_KEYS.has(k)) return null;
      if (k === "sameLevel") {
        if (typeof v !== "boolean") return null;
        sameLevel = v;
      } else if (k === "penetrationMm") {
        if (!isObj(v) || !onlyKeys(v, ["gte"]) || typeof v.gte !== "number") return null;
        penetrationMinMm = v.gte;
      } else {
        if (!isObj(v) || !onlyKeys(v, ["lt"]) || typeof v.lt !== "number") return null;
        distanceMaxMm = v.lt;
      }
    }
  }
  return { id: r.id, name: r.name, nameEs: r.nameEs ?? "", symmetric, a, b, penetrationMinMm, distanceMaxMm, sameLevel, then: { ...r.then } };
}

export function formToRule(f: RuleForm): RuleDefinition {
  const when: Record<string, unknown> = {};
  const clash: Record<string, unknown> = {};
  if (f.penetrationMinMm !== null) clash.penetrationMm = { gte: f.penetrationMinMm };
  if (f.distanceMaxMm !== null) clash.distanceMm = { lt: f.distanceMaxMm };
  if (f.sameLevel !== null) clash.sameLevel = f.sameLevel;
  if (Object.keys(clash).length) when.clash = clash;
  const a = sideToMatcher(f.a);
  if (f.symmetric) {
    if (a) when.both = a;
  } else {
    const b = sideToMatcher(f.b);
    if (a) when.a = a;
    if (b) when.b = b;
  }
  const then = { ...f.then };
  if (!then.humanReview) delete then.humanReview;
  return { id: f.id, name: f.name || f.nameEs, ...(f.nameEs.trim() ? { nameEs: f.nameEs.trim() } : {}), when, then };
}

/** Normalises one-element lists to scalars (the engine treats both the same) for comparisons. */
export function normalizeRule(r: RuleDefinition): RuleDefinition {
  const norm = (v: unknown): unknown => (Array.isArray(v) ? (v.length === 1 && typeof v[0] !== "object" ? v[0] : v.map(norm)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v);
  const then = { ...r.then };
  if (!then.humanReview) delete then.humanReview;
  return { ...r, when: norm(r.when) as Record<string, unknown>, then };
}
