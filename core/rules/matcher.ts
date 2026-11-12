/**
 * Matcher DSL compiler (classification-rules.yaml §5). A matcher is compiled
 * ONCE into a predicate; evaluation does no parsing, no regex construction and
 * no set lookups by name.
 *
 * Semantics:
 * - all keys must hold (AND);
 * - `field: scalar` = equals, `field: [..]` = in, `field: {op: v}` = all ops;
 * - strings compare normalized (lowercase, no accents, trimmed);
 * - missing fields: positive ops are false, negative ops (ne, notIn,
 *   notMatches, exists:false) are true;
 * - numeric args may be refs `{ ref: 'b.sizeMm', factor: 0.333 }`; a missing
 *   ref makes the comparison false.
 */
import { isMissing, norm } from "../util/text";
import { joinPath, type LoadIssue, type RuleFile } from "./errors";

/** Any fact bag (element facts or clash facts). `__n` caches normalized strings. */
export interface Facts {
  [field: string]: unknown;
}

export interface MatchContext {
  a?: Facts;
  b?: Facts;
  clash?: Facts;
}

export type Predicate = (facts: Facts, ctx: MatchContext) => boolean;

export type MatcherKind = "element" | "clash";

export interface MatcherEnv {
  elementFields: ReadonlySet<string>;
  clashFields: ReadonlySet<string>;
  /** Normalized members per category set name. */
  categorySets: ReadonlyMap<string, ReadonlySet<string>>;
  /** Normalized members per class set name. */
  classSets: ReadonlyMap<string, ReadonlySet<string>>;
  disciplineCodes: ReadonlySet<string>;
  groups: ReadonlySet<string>;
  /** Field holding the engine-native foreign check (`foreignCheck: true`). */
  foreignField: string;
}

const NORM_CACHE = "__n";

/** Normalized string value of a field, cached on the facts object when possible. */
export function normField(f: Facts, field: string): string {
  const cache = f[NORM_CACHE] as Record<string, string> | undefined;
  const hit = cache?.[field];
  if (hit !== undefined) return hit;
  const v = f[field];
  const s = typeof v === "string" ? norm(v) : v === undefined || v === null ? "" : norm(String(v));
  if (cache) cache[field] = s;
  return s;
}

/** Attach a (non-enumerable) normalized-string cache to a facts object. */
export function withNormCache<T extends object>(obj: T): T {
  Object.defineProperty(obj, NORM_CACHE, { value: {}, enumerable: false, writable: true, configurable: true });
  return obj;
}

/** Drop a cached normalized value after a field is (re)assigned. */
export function invalidateNorm(f: Facts, field: string): void {
  const cache = f[NORM_CACHE] as Record<string, string> | undefined;
  if (cache) delete cache[field];
}

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

interface CompiledScalar {
  raw: Scalar;
  str: string;
}
const cs = (raw: Scalar): CompiledScalar => ({ raw, str: norm(String(raw)) });

function eqScalar(f: Facts, field: string, v: unknown, s: CompiledScalar): boolean {
  if (typeof v === "string" || typeof s.raw === "string") return normField(f, field) === s.str;
  return v === s.raw;
}

type NumArg = (ctx: MatchContext) => number | undefined;

interface CompileState {
  env: MatcherEnv;
  file: RuleFile;
  issues: LoadIssue[];
}

const OPS = new Set(["eq", "ne", "in", "notIn", "matches", "notMatches", "gt", "gte", "lt", "lte", "between", "exists", "inSet"]);

function err(st: CompileState, path: string, message: string): Predicate {
  st.issues.push({ file: st.file, path, message });
  return () => false;
}

function compileRegex(st: CompileState, path: string, src: unknown): RegExp | undefined {
  if (typeof src !== "string") {
    st.issues.push({ file: st.file, path, message: "regex must be a string" });
    return undefined;
  }
  try {
    return new RegExp(src, "i");
  } catch (e) {
    st.issues.push({ file: st.file, path, message: `invalid regex: ${(e as Error).message}` });
    return undefined;
  }
}

function compileNumArg(st: CompileState, path: string, raw: unknown): NumArg | undefined {
  if (typeof raw === "number") return () => raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k !== "ref" && k !== "factor") {
        st.issues.push({ file: st.file, path: joinPath(path, k), message: `unknown key in ref (allowed: ref, factor)` });
        return undefined;
      }
    }
    if (typeof o.ref !== "string") {
      st.issues.push({ file: st.file, path: joinPath(path, "ref"), message: "ref must be a string like 'b.sizeMm'" });
      return undefined;
    }
    const m = /^(a|b|clash)\.([A-Za-z]+)$/.exec(o.ref);
    if (!m) {
      st.issues.push({ file: st.file, path: joinPath(path, "ref"), message: `bad ref '${o.ref}' (expected a.<field>, b.<field> or clash.<field>)` });
      return undefined;
    }
    const side = m[1] as "a" | "b" | "clash";
    const field = m[2]!;
    const known = side === "clash" ? st.env.clashFields : st.env.elementFields;
    if (!known.has(field)) {
      st.issues.push({ file: st.file, path: joinPath(path, "ref"), message: `unknown ${side === "clash" ? "clash" : "element"} field '${field}' in ref` });
      return undefined;
    }
    let factor = 1;
    if (o.factor !== undefined) {
      if (typeof o.factor !== "number") {
        st.issues.push({ file: st.file, path: joinPath(path, "factor"), message: "factor must be a number" });
        return undefined;
      }
      factor = o.factor;
    }
    return (ctx) => {
      const v = ctx[side]?.[field];
      return typeof v === "number" ? v * factor : undefined;
    };
  }
  st.issues.push({ file: st.file, path, message: "expected a number or { ref, factor }" });
  return undefined;
}

function compileOps(st: CompileState, kind: MatcherKind, field: string, spec: Record<string, unknown>, path: string): Predicate {
  const parts: Predicate[] = [];
  const keys = Object.keys(spec);
  if (keys.length === 0) return err(st, path, "empty operator map");
  for (const op of keys) {
    const p = joinPath(path, op);
    const arg = spec[op];
    if (!OPS.has(op)) {
      parts.push(err(st, p, `unknown operator '${op}' (allowed: ${[...OPS].join(", ")})`));
      continue;
    }
    switch (op) {
      case "eq":
      case "ne": {
        if (!isScalar(arg)) { parts.push(err(st, p, `${op} expects a scalar`)); break; }
        const s = cs(arg);
        parts.push(op === "eq"
          ? (f) => { const v = f[field]; return !isMissing(v) && eqScalar(f, field, v, s); }
          : (f) => { const v = f[field]; return isMissing(v) || !eqScalar(f, field, v, s); });
        break;
      }
      case "in":
      case "notIn": {
        if (!Array.isArray(arg) || !arg.every(isScalar)) { parts.push(err(st, p, `${op} expects a list of scalars`)); break; }
        const list = (arg as Scalar[]).map(cs);
        const any = (f: Facts, v: unknown) => list.some((s) => eqScalar(f, field, v, s));
        parts.push(op === "in"
          ? (f) => { const v = f[field]; return !isMissing(v) && any(f, v); }
          : (f) => { const v = f[field]; return isMissing(v) || !any(f, v); });
        break;
      }
      case "matches":
      case "notMatches": {
        const re = compileRegex(st, p, arg);
        if (!re) { parts.push(() => false); break; }
        parts.push(op === "matches"
          ? (f) => !isMissing(f[field]) && re.test(normField(f, field))
          : (f) => isMissing(f[field]) || !re.test(normField(f, field)));
        break;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const n = compileNumArg(st, p, arg);
        if (!n) { parts.push(() => false); break; }
        const cmp = op === "gt" ? (x: number, y: number) => x > y
          : op === "gte" ? (x: number, y: number) => x >= y
          : op === "lt" ? (x: number, y: number) => x < y
          : (x: number, y: number) => x <= y;
        parts.push((f, ctx) => {
          const v = f[field];
          if (typeof v !== "number") return false;
          const y = n(ctx);
          return y !== undefined && cmp(v, y);
        });
        break;
      }
      case "between": {
        if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== "number" || typeof arg[1] !== "number") {
          parts.push(err(st, p, "between expects [lo, hi] numbers")); break;
        }
        const [lo, hi] = arg as [number, number];
        if (lo > hi) { parts.push(err(st, p, "between: lo > hi")); break; }
        parts.push((f) => { const v = f[field]; return typeof v === "number" && v >= lo && v <= hi; });
        break;
      }
      case "exists": {
        if (typeof arg !== "boolean") { parts.push(err(st, p, "exists expects true or false")); break; }
        parts.push(arg ? (f) => !isMissing(f[field]) : (f) => isMissing(f[field]));
        break;
      }
      case "inSet": {
        if (kind !== "element" || (field !== "category" && field !== "elementClass")) {
          parts.push(err(st, p, "inSet is only valid on element fields 'category' (categorySets) or 'elementClass' (classSets)"));
          break;
        }
        if (typeof arg !== "string") { parts.push(err(st, p, "inSet expects a set name")); break; }
        const sets = field === "category" ? st.env.categorySets : st.env.classSets;
        const set = sets.get(arg);
        if (!set) {
          parts.push(err(st, p, `unknown ${field === "category" ? "categorySets" : "classSets"} name '${arg}' (known: ${[...sets.keys()].join(", ")})`));
          break;
        }
        parts.push((f) => !isMissing(f[field]) && set.has(normField(f, field)));
        break;
      }
    }
  }
  return parts.length === 1 ? parts[0]! : (f, ctx) => parts.every((q) => q(f, ctx));
}

function compileDisciplinePair(st: CompileState, spec: unknown, path: string): Predicate {
  const pairs: Array<[string, string]> = [];
  const isPair = (x: unknown): x is [string, string] =>
    Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string";
  if (isPair(spec)) pairs.push(spec);
  else if (Array.isArray(spec) && spec.length > 0 && spec.every(isPair)) pairs.push(...(spec as Array<[string, string]>));
  else return err(st, path, "disciplinePair expects [X, Y] or [[X, Y], ...]");
  for (const [i, pair] of pairs.entries()) {
    for (const [j, tok] of pair.entries()) {
      const ok = tok === "*" || (tok.startsWith("@") ? st.env.groups.has(tok.slice(1)) : st.env.disciplineCodes.has(tok));
      if (!ok) st.issues.push({ file: st.file, path: joinPath(joinPath(path, i), j), message: `unknown discipline token '${tok}'` });
    }
  }
  const tokOk = (el: Facts | undefined, tok: string) =>
    el !== undefined && (tok === "*" || (tok.startsWith("@") ? el.disciplineGroup === tok.slice(1) : el.discipline === tok));
  return (_f, ctx) =>
    pairs.some(([x, y]) => (tokOk(ctx.a, x) && tokOk(ctx.b, y)) || (tokOk(ctx.b, x) && tokOk(ctx.a, y)));
}

/** Compile a matcher map. Issues are appended to `issues`; a failed part never matches. */
export function compileMatcher(
  spec: unknown,
  kind: MatcherKind,
  env: MatcherEnv,
  file: RuleFile,
  path: string,
  issues: LoadIssue[],
): Predicate {
  const st: CompileState = { env, file, issues };
  return compileMap(st, spec, kind, path);
}

function compileMap(st: CompileState, spec: unknown, kind: MatcherKind, path: string): Predicate {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return err(st, path, "matcher must be a map");
  const parts: Predicate[] = [];
  const fields = kind === "element" ? st.env.elementFields : st.env.clashFields;
  for (const [key, value] of Object.entries(spec as Record<string, unknown>)) {
    const p = joinPath(path, key);
    if (key === "anyOf") {
      if (!Array.isArray(value) || value.length === 0) { parts.push(err(st, p, "anyOf expects a non-empty list of matchers")); continue; }
      const subs = value.map((v, i) => compileMap(st, v, kind, joinPath(p, i)));
      parts.push((f, ctx) => subs.some((s) => s(f, ctx)));
      continue;
    }
    if (key === "not") {
      const sub = compileMap(st, value, kind, p);
      parts.push((f, ctx) => !sub(f, ctx));
      continue;
    }
    if (key === "foreignCheck") {
      if (kind !== "element") { parts.push(err(st, p, "foreignCheck is only valid in element matchers")); continue; }
      if (typeof value !== "boolean") { parts.push(err(st, p, "foreignCheck expects true or false")); continue; }
      const ff = st.env.foreignField;
      parts.push(value ? (f) => f[ff] === true : (f) => f[ff] !== true);
      continue;
    }
    if (key === "disciplinePair") {
      if (kind !== "clash") { parts.push(err(st, p, "disciplinePair is only valid in clash matchers")); continue; }
      parts.push(compileDisciplinePair(st, value, p));
      continue;
    }
    if (!fields.has(key)) {
      parts.push(err(st, p, `unknown ${kind} field '${key}'`));
      continue;
    }
    if (isScalar(value)) {
      const s = cs(value);
      parts.push((f) => { const v = f[key]; return !isMissing(v) && eqScalar(f, key, v, s); });
    } else if (Array.isArray(value)) {
      if (!value.every(isScalar)) { parts.push(err(st, p, "list values must be scalars")); continue; }
      const list = (value as Scalar[]).map(cs);
      parts.push((f) => { const v = f[key]; return !isMissing(v) && list.some((s) => eqScalar(f, key, v, s)); });
    } else if (value && typeof value === "object") {
      parts.push(compileOps(st, kind, key, value as Record<string, unknown>, p));
    } else {
      parts.push(err(st, p, "value must be a scalar, a list or an operator map"));
    }
  }
  if (parts.length === 0) return () => true;
  if (parts.length === 1) return parts[0]!;
  return (f, ctx) => {
    for (const q of parts) if (!q(f, ctx)) return false;
    return true;
  };
}
