/**
 * Rule set loader: validates the three rule files (+ optional holidays) and
 * compiles them ONCE into a `CompiledRuleSet`. Pure and isomorphic: callers
 * pass already-parsed objects or YAML strings (see server/rules-loader.ts for
 * the Node file loader). Fails closed: any issue throws `RulesLoadError`.
 */
import YAML from "yaml";
import type { z } from "zod";
import { sha1 } from "../util/sha1";
import { norm } from "../util/text";
import { compileScoring, type ScoringModel } from "../score/model";
import { formatPath, joinPath, RulesLoadError, type LoadIssue, type RuleFile } from "./errors";
import { CLASH_FIELDS, ELEMENT_DERIVED_FIELDS, ELEMENT_RAW_FIELDS } from "./fields";
import { compileMatcher, type MatcherEnv, type Predicate } from "./matcher";
import {
  ClassificationRulesSchema, DisciplineMatrixSchema, HolidaysSchema, PriorityScoringSchema,
  type ClassificationRules, type DisciplineMatrix, type Holidays, type PriorityScoring, type RuleThen,
} from "./schemas";

export interface RuleSources {
  /** rules/discipline-matrix.yaml (parsed object or YAML text). */
  matrix: unknown;
  /** rules/classification-rules.yaml. */
  classification: unknown;
  /** rules/priority-scoring.yaml. */
  scoring: unknown;
  /** rules/holidays-cl.yaml (optional). */
  holidays?: unknown;
}

export interface DisciplineInfo {
  code: string;
  group: string;
  criticality: number;
  es: string;
}

/** Class token: class name, '@SET' or '*'. */
export type ClassTest = (cls: string | undefined) => boolean;
/** Discipline token: code, '@GROUP' or '*'. */
export type DisciplineTest = (discipline: string | undefined, group: string | undefined) => boolean;

export type DisciplineRef =
  | { kind: "literal"; code: string }
  | { kind: "a" }
  | { kind: "b" }
  | { kind: "mover" }
  | { kind: "other" };

export type TemplatePart = string | { side: "a" | "b" | "clash" | "mover" | "other"; field: string };

export interface CompiledWhen {
  clash?: Predicate;
  a?: Predicate;
  b?: Predicate;
  both?: Predicate;
  /** True when `a` or `b` is present: both orientations are tried. */
  symmetric: boolean;
}

export interface CompiledRule {
  id: string;
  name: string;
  index: number;
  when: CompiledWhen;
  then: RuleThen;
  responsible: DisciplineRef;
  secondary?: DisciplineRef;
  rationale: TemplatePart[];
}

export interface CompiledAnnotation {
  id: string;
  when: CompiledWhen;
  tags: string[];
  note?: TemplatePart[];
}

export interface CompiledRuleSet {
  versions: { matrix: number; rules: number; scoring: number; holidays?: number };
  /** sha1 over the canonical JSON of the sources. Same rules -> same hash. */
  hash: string;
  source: { matrix: DisciplineMatrix; classification: ClassificationRules; scoring: PriorityScoring; holidays?: Holidays };

  disciplines: ReadonlyMap<string, DisciplineInfo>;
  groups: ReadonlySet<string>;
  categoryPrefixStrip: readonly string[];
  /** normalized alias -> canonical category. */
  categoryCanon: ReadonlyMap<string, string>;
  categoryLabelsEs: ReadonlyMap<string, string>;
  /** canonical category -> discipline code. */
  categoryDefaults: ReadonlyMap<string, string>;
  systemAliases: ReadonlyArray<{ canonical: string; regexes: RegExp[] }>;
  iso: { modelTypes: ReadonlySet<string>; roleCodes: ReadonlyMap<string, string> };
  /** normalized discipline alias -> code. */
  disciplineAliases: ReadonlyMap<string, string>;
  fileNamePatterns: ReadonlyArray<{ discipline: string; tokens: ReadonlySet<string>; regex?: RegExp }>;
  refinableFrom: ReadonlySet<string>;
  systemRefinement: ReadonlyArray<{ discipline: string; when: Predicate }>;
  derivedFlags: ReadonlyArray<{ flag: string; when: Predicate }>;
  foreignExempt: ReadonlySet<string>;
  elementClasses: ReadonlyArray<{ cls: string; moveRank: number | null | "inherit"; when: Predicate }>;
  classSets: ReadonlyMap<string, ReadonlySet<string>>;
  categorySets: ReadonlyMap<string, ReadonlySet<string>>;
  whoMoves: {
    tieThreshold: number;
    overrides: ReadonlyArray<{ x: ClassTest; y: ClassTest; mover: "other" | ClassTest; approver?: string; index: number }>;
  };
  tolerances: {
    default: { hardMm: number; clearanceMm: number };
    entries: ReadonlyArray<{ classes?: [ClassTest, ClassTest]; disciplines?: [DisciplineTest, DisciplineTest]; hardMm: number; clearanceMm: number; index: number }>;
  };
  rules: readonly CompiledRule[];
  annotations: readonly CompiledAnnotation[];
  scoring: ScoringModel;
  /** ISO dates (YYYY-MM-DD). */
  holidays: ReadonlySet<string>;
  /** Every element field the DSL knows (raw + derived + flags). */
  elementFields: ReadonlySet<string>;
}

/** Internal field used for the engine-native foreign check. */
export const FOREIGN_FIELD = "__foreign";

function parseSource(file: RuleFile, src: unknown, issues: LoadIssue[]): unknown {
  if (typeof src !== "string") return src;
  try {
    return YAML.parse(src);
  } catch (e) {
    issues.push({ file, path: "", message: `YAML parse error: ${(e as Error).message}` });
    return undefined;
  }
}

function validate<T>(file: RuleFile, schema: z.ZodType<T>, data: unknown, issues: LoadIssue[]): T | undefined {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  for (const i of r.error.issues) {
    let message = i.message;
    if (i.code === "unrecognized_keys") message = `unknown field(s): ${i.keys.join(", ")}`;
    issues.push({ file, path: formatPath(i.path), message });
  }
  return undefined;
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Validate and compile the rule files. Throws `RulesLoadError` listing every
 * issue with its file and path.
 */
export function loadRuleSet(sources: RuleSources): CompiledRuleSet {
  const issues: LoadIssue[] = [];
  const mRaw = parseSource("discipline-matrix", sources.matrix, issues);
  const cRaw = parseSource("classification-rules", sources.classification, issues);
  const sRaw = parseSource("priority-scoring", sources.scoring, issues);
  const hRaw = sources.holidays === undefined ? undefined : parseSource("holidays", sources.holidays, issues);

  const matrix = validate("discipline-matrix", DisciplineMatrixSchema, mRaw, issues);
  const classification = validate("classification-rules", ClassificationRulesSchema, cRaw, issues);
  const scoring = validate("priority-scoring", PriorityScoringSchema, sRaw, issues);
  const holidays = hRaw === undefined ? undefined : validate("holidays", HolidaysSchema, hRaw, issues);
  if (!matrix || !classification || !scoring || issues.length) throw new RulesLoadError(issues);

  const compiled = compile(matrix, classification, scoring, holidays, issues);
  if (issues.length) throw new RulesLoadError(issues);
  return compiled;
}

function compile(
  matrix: DisciplineMatrix,
  classification: ClassificationRules,
  scoring: PriorityScoring,
  holidays: Holidays | undefined,
  issues: LoadIssue[],
): CompiledRuleSet {
  const MF = "discipline-matrix" as const;
  const CF = "classification-rules" as const;

  // ── disciplines and groups
  const groups = new Set(matrix.groups);
  const disciplines = new Map<string, DisciplineInfo>();
  const disciplineAliases = new Map<string, string>();
  matrix.disciplines.forEach((d, i) => {
    if (disciplines.has(d.code)) issues.push({ file: MF, path: `disciplines[${i}].code`, message: `duplicate discipline code '${d.code}'` });
    if (!groups.has(d.group)) issues.push({ file: MF, path: `disciplines[${i}].group`, message: `unknown group '${d.group}'` });
    disciplines.set(d.code, { code: d.code, group: d.group, criticality: d.criticality, es: d.es });
    for (const a of d.aliases) if (!disciplineAliases.has(norm(a))) disciplineAliases.set(norm(a), d.code);
  });
  const codes = new Set(disciplines.keys());
  const checkCode = (file: RuleFile, path: string, code: string) => {
    if (!codes.has(code)) issues.push({ file, path, message: `unknown discipline code '${code}'` });
  };

  // ── categories
  const categoryCanon = new Map<string, string>();
  for (const [canon, aliases] of Object.entries(matrix.categoryAliases)) {
    categoryCanon.set(norm(canon), canon);
    for (const a of aliases) categoryCanon.set(norm(a), canon);
  }
  const categoryLabelsEs = new Map(Object.entries(matrix.categoryLabelsEs));
  const categorySets = new Map<string, Set<string>>();
  for (const [name, cats] of Object.entries(matrix.categorySets)) categorySets.set(name, new Set(cats.map(norm)));
  const categoryDefaults = new Map<string, string>();
  for (const [code, cats] of Object.entries(matrix.detection.categoryDefaults)) {
    checkCode(MF, `detection.categoryDefaults.${code}`, code);
    for (const c of cats) if (!categoryDefaults.has(c)) categoryDefaults.set(c, code);
  }

  // ── system classification aliases
  const systemAliases: Array<{ canonical: string; regexes: RegExp[] }> = [];
  for (const [canonical, res] of Object.entries(matrix.systemClassificationAliases)) {
    const regexes: RegExp[] = [];
    res.forEach((r, i) => {
      try {
        regexes.push(new RegExp(r, "i"));
      } catch (e) {
        issues.push({ file: MF, path: `systemClassificationAliases.${canonical}[${i}]`, message: `invalid regex: ${(e as Error).message}` });
      }
    });
    systemAliases.push({ canonical, regexes });
  }

  // ── classes (needed by the matcher env)
  const classNames = new Set<string>();
  matrix.elementClasses.forEach((c, i) => {
    if (classNames.has(c.class)) issues.push({ file: MF, path: `elementClasses[${i}].class`, message: `duplicate class '${c.class}'` });
    classNames.add(c.class);
  });
  const classSets = new Map<string, Set<string>>();
  for (const [name, members] of Object.entries(matrix.classSets)) {
    members.forEach((m, i) => {
      if (!classNames.has(m)) issues.push({ file: MF, path: `classSets.${name}[${i}]`, message: `unknown element class '${m}'` });
    });
    classSets.set(name, new Set(members.map(norm)));
  }

  // ── matcher env
  const flagNames = matrix.derivedFlags.map((f) => f.flag);
  const elementFields = new Set<string>([...ELEMENT_RAW_FIELDS, ...ELEMENT_DERIVED_FIELDS, ...flagNames]);
  const env: MatcherEnv = {
    elementFields,
    clashFields: new Set(CLASH_FIELDS),
    categorySets,
    classSets,
    disciplineCodes: codes,
    groups,
    foreignField: FOREIGN_FIELD,
  };
  const el = (spec: unknown, file: RuleFile, path: string) => compileMatcher(spec, "element", env, file, path, issues);

  // ── detection
  const roleCodes = new Map<string, string>();
  for (const [role, code] of Object.entries(matrix.detection.iso19650.roleCodes)) {
    checkCode(MF, `detection.iso19650.roleCodes.${role}`, code);
    roleCodes.set(norm(role), code);
  }
  const fileNamePatterns = matrix.detection.fileNamePatterns.map((p, i) => {
    checkCode(MF, `detection.fileNamePatterns[${i}].discipline`, p.discipline);
    let regex: RegExp | undefined;
    if (p.regex !== undefined) {
      try {
        regex = new RegExp(p.regex, "i");
      } catch (e) {
        issues.push({ file: MF, path: `detection.fileNamePatterns[${i}].regex`, message: `invalid regex: ${(e as Error).message}` });
      }
    }
    return { discipline: p.discipline, tokens: new Set((p.tokens ?? []).map(norm)), ...(regex ? { regex } : {}) };
  });
  matrix.detection.refinableFrom.forEach((c, i) => checkCode(MF, `detection.refinableFrom[${i}]`, c));
  const systemRefinement = matrix.detection.systemRefinement.map((r, i) => {
    checkCode(MF, `detection.systemRefinement[${i}].discipline`, r.discipline);
    return { discipline: r.discipline, when: el(r.when, MF, `detection.systemRefinement[${i}].when`) };
  });

  // ── flags and classes
  const seenFlags = new Set<string>();
  const derivedFlags = matrix.derivedFlags.map((f, i) => {
    if (seenFlags.has(f.flag)) issues.push({ file: MF, path: `derivedFlags[${i}].flag`, message: `duplicate flag '${f.flag}'` });
    seenFlags.add(f.flag);
    return { flag: f.flag, when: el(f.when, MF, `derivedFlags[${i}].when`) };
  });
  const elementClasses = matrix.elementClasses.map((c, i) => ({
    cls: c.class,
    moveRank: c.moveRank,
    when: el(c.when, MF, `elementClasses[${i}].when`),
  }));

  const classTest = (file: RuleFile, path: string, tok: string): ClassTest => {
    if (tok === "*") return () => true;
    if (tok.startsWith("@")) {
      const set = classSets.get(tok.slice(1));
      if (!set) {
        issues.push({ file, path, message: `unknown class set '${tok}'` });
        return () => false;
      }
      return (c) => c !== undefined && set.has(c);
    }
    if (!classNames.has(tok)) issues.push({ file, path, message: `unknown element class '${tok}'` });
    return (c) => c === tok;
  };
  const discTest = (file: RuleFile, path: string, tok: string): DisciplineTest => {
    if (tok === "*") return () => true;
    if (tok.startsWith("@")) {
      const g = tok.slice(1);
      if (!groups.has(g)) issues.push({ file, path, message: `unknown discipline group '${tok}'` });
      return (_d, grp) => grp === g;
    }
    checkCode(file, path, tok);
    return (d) => d === tok;
  };

  const whoMoves = {
    tieThreshold: matrix.whoMoves.tieThreshold,
    overrides: matrix.whoMoves.overrides.map((o, i) => {
      const p = `whoMoves.overrides[${i}]`;
      if (o.approver !== undefined) checkCode(MF, `${p}.approver`, o.approver);
      return {
        x: classTest(MF, `${p}.classes[0]`, o.classes[0]),
        y: classTest(MF, `${p}.classes[1]`, o.classes[1]),
        mover: o.mover === "other" ? ("other" as const) : classTest(MF, `${p}.mover`, o.mover),
        ...(o.approver ? { approver: o.approver } : {}),
        index: i,
      };
    }),
  };

  const tolerances = {
    default: matrix.tolerances.default,
    entries: matrix.tolerances.entries.map((e, i) => {
      const p = `tolerances.entries[${i}]`;
      return {
        ...(e.classes ? { classes: [classTest(MF, `${p}.classes[0]`, e.classes[0]), classTest(MF, `${p}.classes[1]`, e.classes[1])] as [ClassTest, ClassTest] } : {}),
        ...(e.disciplines ? { disciplines: [discTest(MF, `${p}.disciplines[0]`, e.disciplines[0]), discTest(MF, `${p}.disciplines[1]`, e.disciplines[1])] as [DisciplineTest, DisciplineTest] } : {}),
        hardMm: e.hardMm,
        clearanceMm: e.clearanceMm,
        index: i,
      };
    }),
  };

  // ── rules
  const compileWhen = (w: ClassificationRules["rules"][number]["when"], path: string): CompiledWhen => ({
    ...(w.clash ? { clash: compileMatcher(w.clash, "clash", env, CF, joinPath(path, "clash"), issues) } : {}),
    ...(w.a ? { a: el(w.a, CF, joinPath(path, "a")) } : {}),
    ...(w.b ? { b: el(w.b, CF, joinPath(path, "b")) } : {}),
    ...(w.both ? { both: el(w.both, CF, joinPath(path, "both")) } : {}),
    symmetric: w.a !== undefined || w.b !== undefined,
  });
  const compileTemplate = (text: string, path: string): TemplatePart[] => {
    const parts: TemplatePart[] = [];
    const re = /\{([^{}]*)\}/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      last = m.index + m[0].length;
      const pm = /^(a|b|clash|mover|other)\.([A-Za-z]+)$/.exec(m[1]!);
      if (!pm) {
        issues.push({ file: CF, path, message: `bad placeholder '{${m[1]}}' (expected {a|b|clash|mover|other.<field>})` });
        continue;
      }
      const side = pm[1] as "a" | "b" | "clash" | "mover" | "other";
      const field = pm[2]!;
      const known = side === "clash" ? env.clashFields : elementFields;
      if (!known.has(field)) issues.push({ file: CF, path, message: `unknown field '${field}' in placeholder '{${m[1]}}'` });
      parts.push({ side, field });
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
  const compileRef = (ref: string, path: string): DisciplineRef => {
    if (ref === "$a") return { kind: "a" };
    if (ref === "$b") return { kind: "b" };
    if (ref === "@mover") return { kind: "mover" };
    if (ref === "@other") return { kind: "other" };
    checkCode(CF, path, ref);
    return { kind: "literal", code: ref };
  };

  const ids = new Set<string>();
  const rules: CompiledRule[] = classification.rules.map((r, i) => {
    const p = `rules[${i}]`;
    if (ids.has(r.id)) issues.push({ file: CF, path: `${p}.id`, message: `duplicate rule id '${r.id}'` });
    ids.add(r.id);
    return {
      id: r.id,
      name: r.name,
      index: i,
      when: compileWhen(r.when, `${p}.when`),
      then: r.then,
      responsible: compileRef(r.then.responsibleDiscipline, `${p}.then.responsibleDiscipline`),
      ...(r.then.secondaryDiscipline !== undefined ? { secondary: compileRef(r.then.secondaryDiscipline, `${p}.then.secondaryDiscipline`) } : {}),
      rationale: compileTemplate(r.then.rationale, `${p}.then.rationale`),
    };
  });
  const annIds = new Set<string>();
  const annotations: CompiledAnnotation[] = classification.annotations.map((a, i) => {
    const p = `annotations[${i}]`;
    if (annIds.has(a.id)) issues.push({ file: CF, path: `${p}.id`, message: `duplicate annotation id '${a.id}'` });
    annIds.add(a.id);
    return {
      id: a.id,
      when: compileWhen(a.when, `${p}.when`),
      tags: a.then.tags,
      ...(a.then.note !== undefined ? { note: compileTemplate(a.then.note, `${p}.then.note`) } : {}),
    };
  });

  const scoringModel = compileScoring(scoring, issues);

  const hash = sha1(canonicalJson({ matrix, classification, scoring }));
  return {
    versions: { matrix: matrix.version, rules: classification.version, scoring: scoring.version, ...(holidays ? { holidays: holidays.version } : {}) },
    hash,
    source: { matrix, classification, scoring, ...(holidays ? { holidays } : {}) },
    disciplines,
    groups,
    categoryPrefixStrip: matrix.categoryPrefixStrip.map((s) => s.toLowerCase()),
    categoryCanon,
    categoryLabelsEs,
    categoryDefaults,
    systemAliases,
    iso: { modelTypes: new Set(matrix.detection.iso19650.modelTypes.map(norm)), roleCodes },
    disciplineAliases,
    fileNamePatterns,
    refinableFrom: new Set(matrix.detection.refinableFrom),
    systemRefinement,
    derivedFlags,
    foreignExempt: new Set(matrix.foreignExemptCategories),
    elementClasses,
    classSets,
    categorySets,
    whoMoves,
    tolerances,
    rules,
    annotations,
    scoring: scoringModel,
    holidays: new Set((holidays?.holidays ?? []).map((h) => h.date)),
    elementFields,
  };
}
