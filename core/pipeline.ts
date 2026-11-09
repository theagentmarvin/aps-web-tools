/**
 * Deterministic coordination pipeline:
 *   G0 dedupe -> enrich -> classify -> score -> group (G1–G7) -> stats.
 * Pure and isomorphic. Same input (in any order) -> same classified list,
 * same groups, same group ids, same order.
 */
import type { ClassifiedClash } from "./classified";
import { moverSideOf, sideA } from "./classified";
import { classifyPair } from "./classify";
import { computeClashFacts, type ClashFactsInput } from "./enrich/clash";
import { enrichElement, type ElementFacts, type ElementInput } from "./enrich/element";
import { buildLevelCanon } from "./enrich/level";
import { invalidateNorm } from "./rules/matcher";
import { groupClashes, type ClashGroup, type GroupingOptions } from "./group";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "./group/review";
import type { ElementLookup } from "./ingest/pair-key";
import { pairKeyOf } from "./ingest/pair-key";
import type { CompiledRuleSet } from "./rules/load";
import type { BandName } from "./rules/schemas";
import { elementSizeInput, scoreClash, type ScoreOptions } from "./score";
import type { ElementProps, ModelDocument, NormalizedClash } from "./types";
import { cmpStr, sortedPair } from "./util/text";

export interface CoordinationOptions {
  /** Days since each document version was published (by clash document id). */
  modelAgeDays?: Readonly<Record<string, number>> | ((documentId: number) => number | undefined);
  /** Instance-tree nesting between the two sides (FP-013). Missing -> false. */
  nestedRelation?: (clash: NormalizedClash) => boolean;
  /** Days until installation for the clash (schedule factor). */
  daysToInstall?: (clash: ClassifiedClash) => number | undefined;
  /** Extra tags per MC clash id, e.g. `regresion` from the re-test diff. */
  extraTags?: (clash: NormalizedClash) => readonly string[] | undefined;
  /** Project level map (raw name -> canonical), evaluated before the automatic normalization. */
  levelMap?: Readonly<Record<string, string>>;
  /** Orientation override per element (e.g. from viewer fragments). */
  orientation?: (documentId: number, viewerDbId: number) => ElementInput["orientation"] | undefined;
  /**
   * Model discipline per clash document decided by the caller (project mapping).
   * Return a code to force it, `null` for "none" (no file-name detection), or
   * `undefined` to keep the default file-name detection. Omit the option to keep
   * the default for every document.
   */
  modelDiscipline?: (documentId: number) => string | null | undefined;
  /** See ElementInput.strictCategoryDiscipline. */
  strictCategoryDiscipline?: boolean;
  score?: ScoreOptions;
  grouping?: Omit<GroupingOptions, "reviewPolicy">;
  review?: ReviewPolicy;
  /** Clock for timings (default performance.now / Date.now). */
  now?: () => number;
}

export interface CoordinationInput {
  clashes: readonly NormalizedClash[];
  /** Element lookup (documentId, viewerDbId), an ElementProps list, or a map keyed by elementKey(). */
  elements: ElementLookup | readonly ElementProps[] | ReadonlyMap<string, ElementProps>;
  documents: readonly ModelDocument[];
  rules: CompiledRuleSet;
  options?: CoordinationOptions;
}

export interface CoordinationStats {
  ruleset: { hash: string; versions: CompiledRuleSet["versions"]; rules: number };
  clashes: { input: number; unique: number; duplicatesMerged: number; missingElements: number };
  byValidity: Record<string, number>;
  byNature: Record<string, number>;
  /** "A×B" alphabetical -> clashes. */
  byDisciplinePair: Record<string, number>;
  /** Clash-level bands. */
  byBand: Record<string, number>;
  groups: {
    total: number;
    byStrategy: Record<string, number>;
    byBand: Record<string, number>;
    byValidity: Record<string, number>;
    confidence: { alta: number; media: number; baja: number };
  };
  needsReview: { groups: number; clashes: number };
  humanReview: { clashes: number };
  unmatchedClashes: number;
  topRules: Array<{ ruleId: string; hits: number }>;
  timings: { dedupeMs: number; enrichMs: number; classifyMs: number; groupMs: number; totalMs: number };
}

export interface CoordinationResult {
  classified: ClassifiedClash[];
  groups: ClashGroup[];
  stats: CoordinationStats;
}

/** Key used to index element props: `${documentId}:${viewerDbId}`. */
export function elementKey(documentId: number | string, viewerDbId: number | string): string {
  return `${documentId}:${viewerDbId}`;
}

function defaultNow(): () => number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? () => p.now() : () => Date.now();
}

function toLookup(elements: CoordinationInput["elements"]): ElementLookup {
  if (typeof elements === "function") return elements;
  if (elements instanceof Map) return (d, v) => elements.get(elementKey(d, v));
  const m = new Map<string, ElementProps>();
  for (const e of elements as readonly ElementProps[]) {
    if (e.documentId === undefined) continue;
    m.set(elementKey(e.documentId, e.lmvId), e);
  }
  return (d, v) => m.get(elementKey(d, v));
}

/** Numeric-aware id comparison ("9" < "10"). */
function cmpId(a: string, b: string): number {
  return a.length - b.length || cmpStr(a, b);
}

const inc = (r: Record<string, number>, k: string, n = 1) => {
  r[k] = (r[k] ?? 0) + n;
};

export function runCoordination(input: CoordinationInput): CoordinationResult {
  const { rules: rs } = input;
  const opts = input.options ?? {};
  const now = opts.now ?? defaultNow();
  const t0 = now();
  const lookup = toLookup(input.elements);
  const docs = new Map(input.documents.map((d) => [d.id, d]));

  // ── G0 dedupe (before classification).
  type Side = NormalizedClash["left"];
  const sideToken = (s: Side): string => {
    const el = lookup(s.documentId, s.viewerDbId);
    if (el?.externalId) return el.externalId;
    const file = el?.modelFile ?? docs.get(s.documentId)?.lineageUrn;
    return file ? `${file}:${s.objectId}` : `doc${s.documentId}:${s.objectId}`;
  };
  const unique = new Map<string, { rep: NormalizedClash; ids: string[]; all: NormalizedClash[] }>();
  for (const c of input.clashes) {
    const l = sideToken(c.left);
    const r = sideToken(c.right);
    // Same element on both sides is evidence for DUP-001/002: keep it, keyed by document pair.
    const key = l === r ? sortedPair(`${l}@${c.left.documentId}`, `${r}@${c.right.documentId}`) : pairKeyOf(l, r);
    const e = unique.get(key);
    if (!e) unique.set(key, { rep: c, ids: [c.id], all: [c] });
    else {
      e.ids.push(c.id);
      e.all.push(c);
      if (c.distanceMm < e.rep.distanceMm || (c.distanceMm === e.rep.distanceMm && cmpId(c.id, e.rep.id) < 0)) e.rep = c;
    }
  }
  const entries = [...unique.entries()].sort((x, y) => cmpStr(x[0], y[0]));
  const t1 = now();

  // ── Enrich (cached per element).
  const cache = new Map<string, ElementFacts>();
  let missingElements = 0;
  const ageOf = (docId: number) =>
    typeof opts.modelAgeDays === "function" ? opts.modelAgeDays(docId) : opts.modelAgeDays?.[String(docId)];
  const enrichSide = (s: Side): ElementFacts => {
    const k = elementKey(s.documentId, s.viewerDbId);
    let el = cache.get(k);
    if (el) return el;
    const props = lookup(s.documentId, s.viewerDbId);
    if (!props) missingElements++;
    const doc = docs.get(s.documentId);
    const age = ageOf(s.documentId);
    const orientation = opts.orientation?.(s.documentId, s.viewerDbId);
    const elInput: ElementInput = {
      ...(props ?? {}),
      documentId: props?.documentId ?? s.documentId,
      ...(props?.modelFile ?? doc?.lineageUrn ?? doc?.urn ? { modelFile: props?.modelFile ?? doc?.lineageUrn ?? doc?.urn } : {}),
      ...(props?.documentName ?? doc?.displayName ? { documentName: props?.documentName ?? doc?.displayName } : {}),
      ...(age !== undefined ? { modelAgeDays: age } : {}),
      ...(orientation ? { orientation } : {}),
      ...(opts.modelDiscipline && opts.modelDiscipline(s.documentId) !== undefined ? { modelDisciplineOverride: opts.modelDiscipline(s.documentId) } : {}),
      ...(opts.strictCategoryDiscipline ? { strictCategoryDiscipline: true } : {}),
    };
    el = enrichElement(rs, elInput);
    el.elementKey = sideToken(s);
    cache.set(k, el);
    return el;
  };
  const pairs = entries.map(([key, e]) => ({ key, e, left: enrichSide(e.rep.left), right: enrichSide(e.rep.right) }));

  // ── Level normalization: one display name per storey across models.
  const levelCanon = buildLevelCanon(pairs.flatMap((p) => [p.left.level, p.right.level]), opts.levelMap);
  for (const el of cache.values()) {
    if (el.level === undefined) continue;
    const canon = levelCanon(el.level);
    if (canon !== el.level) {
      el.levelRaw = el.level;
      el.level = canon;
      invalidateNorm(el, "level");
    }
  }

  // ── Cross-clash fact: MEP crossing inside a modeled sleeve of the same host.
  const sleevesByHost = new Map<string, ElementFacts[]>();
  for (const { left, right } of pairs) {
    for (const [s, host] of [[left, right], [right, left]] as const) {
      if (s.isSleeveOrOpening !== true || host.isSleeveOrOpening === true) continue;
      const k = String(host.elementKey);
      const list = sleevesByHost.get(k);
      if (!list) sleevesByHost.set(k, [s]);
      else if (!list.includes(s)) list.push(s);
    }
  }
  const t2 = now();

  // ── Classify + score.
  const classified: ClassifiedClash[] = pairs.map(({ key, e, left, right }) => {
    const rep = e.rep;
    const factsIn: ClashFactsInput = {
      distanceMm: rep.distanceMm,
      status: rep.status,
      nestedRelation: opts.nestedRelation?.(rep) ?? false,
      coveredBySleeve: coveredBySleeve(left, right, sleevesByHost) || coveredBySleeve(right, left, sleevesByHost),
    };
    const extra = new Set<string>();
    if (opts.extraTags) for (const c of e.all) for (const t of opts.extraTags(c) ?? []) extra.add(t);
    return classifyOne(rs, key, rep, e.ids, left, right, factsIn, [...extra].sort(cmpStr), opts);
  });
  const t3 = now();

  // ── Group.
  const groups = groupClashes(rs, classified, { ...(opts.grouping ?? {}), reviewPolicy: opts.review ?? DEFAULT_REVIEW_POLICY });
  const t4 = now();

  // ── Stats.
  const stats = buildStats(rs, input.clashes.length, classified, groups, missingElements);
  stats.timings = {
    dedupeMs: round1(t1 - t0),
    enrichMs: round1(t2 - t1),
    classifyMs: round1(t3 - t2),
    groupMs: round1(t4 - t3),
    totalMs: round1(now() - t0),
  };
  return { classified, groups, stats };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function classifyOne(
  rs: CompiledRuleSet,
  key: string,
  rep: NormalizedClash | undefined,
  ids: string[],
  left: ElementFacts,
  right: ElementFacts,
  factsIn: ClashFactsInput,
  extraTags: readonly string[],
  opts: Pick<CoordinationOptions, "daysToInstall" | "score"> & { count?: number; days?: number },
): ClassifiedClash {
  const facts = computeClashFacts(rs, factsIn, left, right);
  const res = classifyPair(rs, facts, left, right, extraTags);
  const cl = res.classification;
  const partial: ClassifiedClash = {
    key,
    id: rep?.id ?? key,
    mcClashIds: [...ids].sort(cmpId),
    ...(rep ? { clash: rep } : {}),
    left,
    right,
    facts,
    classification: cl,
    priority: undefined as never,
  };
  const [mv, other] = moverSideOf(partial);
  const level = mv.level ?? sideA(partial).level ?? other.level;
  if (level !== undefined) partial.level = level;
  const days = opts.days ?? opts.daysToInstall?.(partial);
  partial.priority = scoreClash(rs, {
    subject: cl,
    disciplines: [res.a.discipline, res.b.discipline],
    distanceMm: facts.distanceMm,
    penetrationMm: facts.penetrationMm,
    ...(elementSizeInput(res.a, res.b, res.mover) !== undefined ? { sizeMm: elementSizeInput(res.a, res.b, res.mover)! } : {}),
    levels: [res.a.level, res.b.level],
    count: opts.count ?? 1,
    ...(days !== undefined ? { daysToInstall: days } : {}),
  }, opts.score);
  return partial;
}

/**
 * Classify and score a single pair outside the pipeline (eval scenarios, MCP
 * what-if). `count` and `daysToInstall` feed the scoring factors.
 */
export function evaluatePair(
  rs: CompiledRuleSet,
  clash: ClashFactsInput,
  leftInput: ElementInput,
  rightInput: ElementInput,
  extra: { count?: number; daysToInstall?: number; extraTags?: readonly string[]; score?: ScoreOptions; id?: string } = {},
): ClassifiedClash {
  const left = enrichElement(rs, leftInput);
  const right = enrichElement(rs, rightInput);
  const tok = (e: ElementFacts, s: string) => e.externalId ?? `${e.modelFile ?? "?"}:${s}`;
  left.elementKey = tok(left, "L");
  right.elementKey = tok(right, "R");
  const key = extra.id ?? pairKeyOf(left.elementKey as string, right.elementKey as string);
  return classifyOne(rs, key, undefined, [extra.id ?? key], left, right, clash, extra.extraTags ?? [], {
    ...(extra.score ? { score: extra.score } : {}),
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.daysToInstall !== undefined ? { days: extra.daysToInstall } : {}),
  });
}

function buildStats(
  rs: CompiledRuleSet,
  inputCount: number,
  classified: readonly ClassifiedClash[],
  groups: readonly ClashGroup[],
  missingElements: number,
): CoordinationStats {
  const byValidity: Record<string, number> = { real: 0, false_positive: 0, tolerated: 0, needs_info: 0 };
  const byNature: Record<string, number> = {};
  const byDisciplinePair: Record<string, number> = {};
  const byBand: Record<BandName, number> = { P1: 0, P2: 0, P3: 0, P4: 0, NONE: 0 };
  const rules: Record<string, number> = {};
  let humanReview = 0;
  let unmatched = 0;
  for (const c of classified) {
    const cl = c.classification;
    inc(byValidity, cl.validity);
    inc(byNature, cl.nature);
    inc(byDisciplinePair, sortedPair(c.left.discipline, c.right.discipline, "×"));
    inc(byBand, c.priority.band);
    inc(rules, cl.ruleId);
    if (cl.humanReview) humanReview++;
    if (cl.ruleId === "DEF-999" || cl.ruleId === "NONE") unmatched++;
  }
  const gStrategy: Record<string, number> = {};
  const gBand: Record<BandName, number> = { P1: 0, P2: 0, P3: 0, P4: 0, NONE: 0 };
  const gValidity: Record<string, number> = { real: 0, false_positive: 0, tolerated: 0, needs_info: 0 };
  const conf = { alta: 0, media: 0, baja: 0 };
  let nrGroups = 0;
  let nrClashes = 0;
  for (const g of groups) {
    inc(gStrategy, g.strategy);
    inc(gBand, g.band);
    inc(gValidity, g.validity);
    conf[g.confidenceBand]++;
    if (g.needsReview) {
      nrGroups++;
      nrClashes += g.stats.count;
    }
  }
  return {
    ruleset: { hash: rs.hash, versions: rs.versions, rules: rs.rules.length },
    clashes: { input: inputCount, unique: classified.length, duplicatesMerged: inputCount - classified.length, missingElements },
    byValidity,
    byNature,
    byDisciplinePair,
    byBand,
    groups: { total: groups.length, byStrategy: gStrategy, byBand: gBand, byValidity: gValidity, confidence: conf },
    needsReview: { groups: nrGroups, clashes: nrClashes },
    humanReview: { clashes: humanReview },
    unmatchedClashes: unmatched,
    topRules: Object.entries(rules).sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0])).slice(0, 10).map(([ruleId, hits]) => ({ ruleId, hits })),
    timings: { dedupeMs: 0, enrichMs: 0, classifyMs: 0, groupMs: 0, totalMs: 0 },
  };
}

/** Plan tolerance (m) when testing whether a crossing lies inside a sleeve. */
const SLEEVE_PLAN_TOLERANCE_M = 0.025;

type Box = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/**
 * `coveredBySleeve` (engine review §1.3): true when `mep` (not itself a
 * sleeve) crosses `host`, and another clash of the same test pairs a modeled
 * sleeve/opening with that host whose bbox contains the crossing point in plan.
 * The crossing point is the centre of the intersection of the two bboxes.
 * Without bboxes it is false (conservative: the clash stays real).
 */
export function coveredBySleeve(mep: ElementFacts, host: ElementFacts, sleevesByHost: ReadonlyMap<string, readonly ElementFacts[]>): boolean {
  if (mep.isSleeveOrOpening === true || !mep.bbox || !host.bbox) return false;
  const sleeves = sleevesByHost.get(String(host.elementKey));
  if (!sleeves?.length) return false;
  const a = mep.bbox as Box;
  const b = host.bbox as Box;
  const lo = (k: "x" | "y") => Math.max(a.min[k], b.min[k]);
  const hi = (k: "x" | "y") => Math.min(a.max[k], b.max[k]);
  // Centre of the plan intersection; if the boxes do not overlap in plan, use the MEP centre.
  const cx = lo("x") <= hi("x") ? (lo("x") + hi("x")) / 2 : (a.min.x + a.max.x) / 2;
  const cy = lo("y") <= hi("y") ? (lo("y") + hi("y")) / 2 : (a.min.y + a.max.y) / 2;
  const t = SLEEVE_PLAN_TOLERANCE_M;
  return sleeves.some((s) => {
    if (s === mep || !s.bbox) return false;
    const sb = s.bbox as Box;
    return cx >= sb.min.x - t && cx <= sb.max.x + t && cy >= sb.min.y - t && cy <= sb.max.y + t;
  });
}
