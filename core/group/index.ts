/**
 * Grouping pipeline G1–G7 (docs/domain/grouping-strategies.md). G0 (dedupe)
 * runs before classification in core/pipeline.ts.
 *
 * Invariants: one validity and one responsible discipline per group; group
 * severity = max member severity; max 60 clashes for G3–G6 (split by level,
 * then model-file pair, then chunks by clash key); each clash in exactly one
 * group; id = "G-" + sha1(strategy|canonicalKey)[0..10]; deterministic order.
 *
 * Resolved ambiguities (see the report / tests):
 * - G1 excludes `hygiene_issue` clashes so G2 can batch them (otherwise the
 *   false-positive DUP-* rules would never reach G2).
 * - G1 appends `|responsibleDiscipline` to its key, and hub keys append the
 *   responsible discipline, to keep invariant 2 (e.g. a riser hub mixes
 *   EST-009 owned by EST and EST-005 owned by AP).
 * - Group confidence = min member confidence (closing a real clash is the
 *   costly error, so the weakest member governs).
 */
import type { ClassifiedClash } from "../classified";
import { elementToken, fixedOf, moverOf, moverSideOf, sideA, sideB } from "../classified";
import type { ElementFacts } from "../enrich/element";
import type { CompiledRuleSet } from "../rules/load";
import type { Nature, RootCause, Severity, SuggestedAction, Validity, BandName, FactorName } from "../rules/schemas";
import { FACTOR_NAMES } from "../rules/schemas";
import { scoreFromFactors, type FactorValues, type PriorityResult } from "../score";
import { sha1 } from "../util/sha1";
import { byFrequency, capitalize, cmpStr, dominant, norm, sanitize, sortedPair } from "../util/text";
import { classLabel, ruleNameEs } from "./labels";
import { autoAcceptThreshold, confidenceBand, DEFAULT_REVIEW_POLICY, type ConfidenceBand, type ReviewPolicy } from "./review";

export * from "./review";
export * from "./labels";

export type GroupStrategy = "nonissue" | "hygiene" | "needsinfo" | "hub-mover" | "hub-fixed" | "run" | "zone" | "single";

export const STRATEGY_ORDER: readonly GroupStrategy[] = ["nonissue", "hygiene", "needsinfo", "hub-mover", "hub-fixed", "run", "zone", "single"];

export interface HubElement {
  externalId?: string;
  category?: string;
  family?: string;
  type?: string;
  systemName?: string;
  level?: string;
  discipline: string;
  elementClass: string;
}

export interface ClashGroup {
  /** G-xxxxxxxxxx, stable across cycles for the same strategy + key. */
  id: string;
  strategy: GroupStrategy;
  canonicalKey: string;
  /** Spanish, engine-generated. */
  title: string;
  validity: Validity;
  nature: Nature;
  rootCause: RootCause;
  responsibleDiscipline: string;
  secondaryDiscipline?: string;
  suggestedAction: SuggestedAction;
  /** Max member severity. */
  severity: Severity;
  priorityScore: number;
  band: BandName;
  priority: PriorityResult;
  /** Distinct, sorted by count desc. */
  ruleIds: string[];
  /** Clash identity keys, sorted. */
  memberKeys: string[];
  /** All MC clash ids covered (sorted). */
  mcClashIds: string[];
  /** Distinct clash levels, sorted. */
  levels: string[];
  hubElement?: HubElement;
  /** Member keys for spot checks: largest penetrations + one seeded random member. */
  sample: string[];
  tags: string[];
  /** OR of members. */
  humanReview: boolean;
  /** min member confidence. */
  confidence: number;
  confidenceBand: ConfidenceBand;
  /** Engine review gate (harness-design §3.1). */
  needsReview: boolean;
  reviewState: "auto_ok" | "needs_review";
  /** Spanish reasons, e.g. "confianza 0.60 < 0.80". */
  reviewReasons: string[];
  /** confidence < reviewFloor or unmatched: escalate bias. */
  escalate: boolean;
  /** Dominant discipline pair, alphabetical, "A×B". */
  disciplinePair: string;
  /** Dominant canonical category pair, alphabetical, "A×B". */
  categoryPair: string;
  stats: { count: number; maxPenetrationMm: number; disciplines: string[] };
}

export interface GroupingOptions {
  /** Minimum degree of a hub element (default 3). */
  hubMin?: number;
  /** Max clashes per group for G3–G6 (default 60). */
  maxGroupSize?: number;
  /** G3: merge needs-info requests by family when more than this many elements share it (default 5). */
  needsInfoFamilyMerge?: number;
  /** Grid bay of a clash (e.g. "C-D/4-5"); enables coordinate-based zones. */
  bayOf?: (c: ClassifiedClash) => string | undefined;
  reviewPolicy?: ReviewPolicy;
}

const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Draft {
  strategy: GroupStrategy;
  key: string;
  members: ClassifiedClash[];
  hub?: ElementFacts;
}

const lvl = (c: ClassifiedClash) => c.level ?? "";
const fileOf = (el: ElementFacts) => String(el.modelFile ?? el.documentId ?? "?");
const filePair = (c: ClassifiedClash) => sortedPair(fileOf(c.left), fileOf(c.right), "~");
const discPair = (c: ClassifiedClash) => sortedPair(c.left.discipline, c.right.discipline, "×");

/** Group id: "G-" + first 10 hex chars of sha1(strategy|key). */
export function groupId(strategy: GroupStrategy, canonicalKey: string): string {
  return `G-${sha1(`${strategy}|${canonicalKey}`).slice(0, 10)}`;
}

function bucket(clashes: readonly ClassifiedClash[], keyOf: (c: ClassifiedClash) => string): Map<string, ClassifiedClash[]> {
  const m = new Map<string, ClassifiedClash[]>();
  for (const c of clashes) {
    const k = keyOf(c);
    const list = m.get(k);
    if (list) list.push(c);
    else m.set(k, [c]);
  }
  return m;
}

/** Invariant 4: split oversized groups by level, then model-file pair, then chunks. */
function capSplit(strategy: GroupStrategy, key: string, members: ClassifiedClash[], max: number, hub?: ElementFacts): Draft[] {
  if (members.length <= max) return [{ strategy, key, members, ...(hub ? { hub } : {}) }];
  const out: Draft[] = [];
  const byLevel = [...bucket(members, lvl).entries()].sort((x, y) => cmpStr(x[0], y[0]));
  for (const [level, ms] of byLevel) {
    const k1 = `${key}|lvl:${level}`;
    if (ms.length <= max) {
      out.push({ strategy, key: k1, members: ms, ...(hub ? { hub } : {}) });
      continue;
    }
    for (const [fp, ms2] of [...bucket(ms, filePair).entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
      const k2 = `${k1}|files:${fp}`;
      if (ms2.length <= max) {
        out.push({ strategy, key: k2, members: ms2, ...(hub ? { hub } : {}) });
        continue;
      }
      const sorted = [...ms2].sort((x, y) => cmpStr(x.key, y.key));
      for (let i = 0; i < sorted.length; i += max) {
        out.push({ strategy, key: `${k2}|part:${i / max + 1}`, members: sorted.slice(i, i + max), ...(hub ? { hub } : {}) });
      }
    }
  }
  return out;
}

/** The side owned by the responsible discipline (a first), else undefined. */
function responsibleSide(c: ClassifiedClash): ElementFacts | undefined {
  const r = c.classification.responsibleDiscipline;
  const a = sideA(c);
  const b = sideB(c);
  if (a.discipline === r) return a;
  if (b.discipline === r) return b;
  return undefined;
}

/** Run G1–G7 over classified clashes. Pure and deterministic. */
export function groupClashes(rs: CompiledRuleSet, clashes: readonly ClassifiedClash[], options: GroupingOptions = {}): ClashGroup[] {
  const hubMin = options.hubMin ?? 3;
  const max = options.maxGroupSize ?? 60;
  const famMerge = options.needsInfoFamilyMerge ?? 5;
  const policy = options.reviewPolicy ?? DEFAULT_REVIEW_POLICY;

  const all = [...clashes].sort((x, y) => cmpStr(x.key, y.key));
  const drafts: Draft[] = [];
  const assigned = new Set<ClassifiedClash>();
  const take = (d: Draft) => {
    for (const m of d.members) assigned.add(m);
    drafts.push(d);
  };
  const free = () => all.filter((c) => !assigned.has(c));
  const sortedBuckets = (m: Map<string, ClassifiedClash[]>) => [...m.entries()].sort((x, y) => cmpStr(x[0], y[0]));

  // G1 — non-issue batches (no size cap).
  const g1 = all.filter((c) => (c.classification.validity === "false_positive" || c.classification.validity === "tolerated") && c.classification.suggestedAction !== "hygiene_issue");
  for (const [k, ms] of sortedBuckets(bucket(g1, (c) => [c.classification.ruleId, c.classification.validity, discPair(c), filePair(c), c.classification.responsibleDiscipline].join("|")))) {
    take({ strategy: "nonissue", key: k, members: ms });
  }

  // G2 — hygiene batches (no size cap): one per rule, responsible discipline and file.
  const g2 = free().filter((c) => c.classification.suggestedAction === "hygiene_issue");
  for (const [k, ms] of sortedBuckets(bucket(g2, (c) => {
    const side = responsibleSide(c);
    const file = side ? fileOf(side) : filePair(c);
    return [c.classification.ruleId, c.classification.responsibleDiscipline, file].join("|");
  }))) take({ strategy: "hygiene", key: k, members: ms });

  // G3 — needs-info: one request per unknown element, merged by family when frequent.
  const g3 = free().filter((c) => c.classification.validity === "needs_info");
  const perElement = bucket(g3, (c) => [c.classification.ruleId, c.classification.responsibleDiscipline, elementToken(sideA(c))].join("|"));
  const famElements = new Map<string, Set<string>>();
  const famKey = (c: ClassifiedClash) => [c.classification.ruleId, c.classification.responsibleDiscipline, `fam:${norm(String(sideA(c).family ?? ""))}`].join("|");
  for (const c of g3) {
    const fk = famKey(c);
    if (!sideA(c).family) continue;
    let s = famElements.get(fk);
    if (!s) famElements.set(fk, (s = new Set()));
    s.add(elementToken(sideA(c)));
  }
  const g3Final = new Map<string, ClassifiedClash[]>();
  for (const [k, ms] of perElement) {
    const fk = famKey(ms[0]!);
    const merged = (famElements.get(fk)?.size ?? 0) > famMerge;
    const key = merged ? fk : k;
    const list = g3Final.get(key);
    if (list) list.push(...ms);
    else g3Final.set(key, [...ms]);
  }
  for (const [k, ms] of sortedBuckets(g3Final)) for (const d of capSplit("needsinfo", k, ms, max)) take(d);

  // G4 — hub elements (real only). Mover hubs first.
  const realFree = () => free().filter((c) => c.classification.validity === "real");
  {
    const byMover = new Map<string, { el: ElementFacts; resp: string; ms: ClassifiedClash[] }>();
    for (const c of realFree()) {
      const m = moverOf(c);
      if (!m) continue;
      const resp = c.classification.responsibleDiscipline;
      const k = `${elementToken(m)}|${resp}`;
      const e = byMover.get(k);
      if (e) e.ms.push(c);
      else byMover.set(k, { el: m, resp, ms: [c] });
    }
    // A clash has exactly one mover, so mover degrees never change as hubs are taken.
    const hubs = [...byMover.values()]
      .filter((h) => h.ms.length >= hubMin)
      .sort((x, y) => y.ms.length - x.ms.length || (y.el.sizeMm ?? -1) - (x.el.sizeMm ?? -1) || cmpStr(elementToken(x.el), elementToken(y.el)) || cmpStr(x.resp, y.resp));
    for (const h of hubs) {
      for (const d of capSplit("hub-mover", `hub-mover|${elementToken(h.el)}|${h.resp}`, h.ms, max, h.el)) take(d);
    }
  }
  {
    // Fixed hubs: element f, responsible d; clashes without a mover count for both sides.
    type Cand = { el: ElementFacts; resp: string; key: string; count: number };
    const fixedSides = (c: ClassifiedClash): ElementFacts[] => {
      const f = fixedOf(c);
      if (f) return [f];
      return elementToken(c.left) === elementToken(c.right) ? [c.left] : [c.left, c.right];
    };
    const build = () => {
      const m = new Map<string, Cand & { ms: ClassifiedClash[] }>();
      for (const c of realFree()) {
        const resp = c.classification.responsibleDiscipline;
        for (const f of fixedSides(c)) {
          const k = `${elementToken(f)}|${resp}`;
          const e = m.get(k);
          if (e) e.ms.push(c);
          else m.set(k, { el: f, resp, key: k, count: 0, ms: [c] });
        }
      }
      return m;
    };
    const cands = [...build().values()].map((x) => ({ ...x, count: x.ms.length })).filter((x) => x.count >= hubMin);
    const order = (x: Cand, y: Cand) => y.count - x.count || (y.el.sizeMm ?? -1) - (x.el.sizeMm ?? -1) || cmpStr(x.key, y.key);
    cands.sort(order);
    // Lazy re-evaluation: counts only decrease (a no-mover clash may be taken by its other side).
    while (cands.length) {
      const top = cands.shift()!;
      const ms = top.ms.filter((c) => !assigned.has(c));
      if (ms.length !== top.count) {
        if (ms.length >= hubMin) {
          const upd = { ...top, ms, count: ms.length };
          let i = 0;
          while (i < cands.length && order(cands[i]!, upd) <= 0) i++;
          cands.splice(i, 0, upd);
        }
        continue;
      }
      for (const d of capSplit("hub-fixed", `hub-fixed|${elementToken(top.el)}|${top.resp}`, ms, max, top.el)) take(d);
    }
  }

  // G5 — system runs.
  {
    const runs = bucket(realFree(), (c) => {
      const [mv, other] = moverSideOf(c);
      const sys = mv.systemName ?? mv.systemType ?? mv.family ?? "";
      return ["run", c.classification.responsibleDiscipline, norm(String(sys)), mv.level ?? "", other.elementClass, c.classification.ruleId].join("|");
    });
    for (const [k, ms] of sortedBuckets(runs)) if (ms.length >= 2) for (const d of capSplit("run", k, ms, max)) take(d);
  }

  // G6 — zones (grid bay when available, else level + rule).
  {
    const zones = bucket(realFree(), (c) => {
      const [, other] = moverSideOf(c);
      const bay = options.bayOf?.(c);
      return bay
        ? ["zone", lvl(c), bay, c.classification.responsibleDiscipline, other.discipline].join("|")
        : ["zone", lvl(c), c.classification.responsibleDiscipline, other.discipline, c.classification.ruleId].join("|");
    });
    for (const [k, ms] of sortedBuckets(zones)) if (ms.length >= 2) for (const d of capSplit("zone", k, ms, max)) take(d);
  }

  // G7 — singletons (everything left, whatever its validity).
  for (const c of free()) take({ strategy: "single", key: `single|${c.key}`, members: [c] });

  const groups = drafts.map((d) => buildGroup(rs, d, policy, options));
  const sIdx = (s: GroupStrategy) => STRATEGY_ORDER.indexOf(s);
  groups.sort((x, y) => y.priorityScore - x.priorityScore || sIdx(x.strategy) - sIdx(y.strategy) || cmpStr(x.canonicalKey, y.canonicalKey));
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group record
// ─────────────────────────────────────────────────────────────────────────────

/** Group-mode scoring: worst-member factors, worst member's zone/schedule, groupCount = N. */
export function scoreGroup(rs: CompiledRuleSet, members: readonly ClassifiedClash[], subject: Parameters<typeof scoreFromFactors>[2]): PriorityResult {
  let worst = members[0]!;
  for (const m of members) {
    if (m.priority.score > worst.priority.score || (m.priority.score === worst.priority.score && m.key < worst.key)) worst = m;
  }
  const values = {} as FactorValues;
  const maxOf: FactorName[] = ["severity", "disciplineCriticality", "penetration", "elementSize"];
  for (const k of FACTOR_NAMES) {
    if (maxOf.includes(k)) {
      let best = members[0]!.priority.factors[k];
      for (const m of members) if (m.priority.factors[k].value > best.value) best = m.priority.factors[k];
      values[k] = { input: best.input, value: best.value };
    } else if (k === "groupCount") {
      const n = members.length;
      const sat = rs.scoring.raw.factors.groupCount.saturation;
      values[k] = { input: n, value: n <= 1 ? 0 : Math.min(1, Math.log10(n) / Math.log10(sat)) };
    } else {
      const f = worst.priority.factors[k];
      values[k] = { input: f.input, value: f.value };
    }
  }
  return scoreFromFactors(rs, values, subject);
}

function seededIndex(seed: string, n: number): number {
  return n <= 0 ? 0 : parseInt(sha1(seed).slice(0, 8), 16) % n;
}

function sampleOf(id: string, members: readonly ClassifiedClash[]): string[] {
  const n = members.length > 100 ? 5 : 3;
  if (members.length <= n) return members.map((m) => m.key);
  const byPen = [...members].sort((x, y) => y.facts.penetrationMm - x.facts.penetrationMm || cmpStr(x.key, y.key));
  const top = byPen.slice(0, n - 1);
  const rest = byPen.slice(n - 1);
  return [...top.map((m) => m.key), rest[seededIndex(id, rest.length)]!.key];
}

const SEVERITY_ES: Record<Severity, string> = { critical: "crítica", high: "alta", medium: "media", low: "baja", none: "ninguna" };

const HUMAN_REASON_ES: Record<string, string> = {
  rule: "la regla exige revisión humana",
  critical: "severidad crítica",
  low_confidence: "confianza de la regla < 0,70",
  needs_info: "requiere información",
  unmatched: "ninguna regla aplica",
};

function buildGroup(rs: CompiledRuleSet, d: Draft, policy: ReviewPolicy, options: GroupingOptions): ClashGroup {
  const ms = d.members;
  const id = groupId(d.strategy, d.key);
  const cls = ms.map((m) => m.classification);
  const first = cls[0]!;
  let severity: Severity = "none";
  for (const c of cls) if (SEVERITY_RANK[c.severity] > SEVERITY_RANK[severity]) severity = c.severity;
  const nature = dominant(cls.map((c) => c.nature))!;
  const rootCause = dominant(cls.map((c) => c.rootCause))!;
  const suggestedAction = dominant(cls.map((c) => c.suggestedAction))!;
  const secondary = dominant(cls.map((c) => c.secondaryDiscipline).filter((x): x is string => x !== undefined));
  const ruleIds = byFrequency(cls.map((c) => c.ruleId));
  const tags = new Set<string>();
  for (const c of cls) for (const t of c.tags) tags.add(t);
  if (d.strategy === "hub-mover") {
    const big = ms.filter((m) => m.classification.tags.includes("penetracion_mayor")).length;
    if (ms.length > 10 || big * 2 > ms.length) tags.add("posible_error_de_cota");
  }
  const tagList = [...tags].sort(cmpStr);
  const humanReview = cls.some((c) => c.humanReview);
  const confidence = Math.min(...cls.map((c) => c.confidence));

  const priority = scoreGroup(rs, ms, {
    ruleId: ruleIds[0],
    validity: first.validity,
    nature,
    rootCause,
    responsibleDiscipline: first.responsibleDiscipline,
    ...(secondary ? { secondaryDiscipline: secondary } : {}),
    severity,
    suggestedAction,
    humanReview,
    tags: tagList,
  });

  // Review gate.
  const reasons: string[] = [];
  const threshold = autoAcceptThreshold(policy, first.validity, nature);
  if (threshold === undefined) reasons.push("requiere información (needs_info)");
  else if (confidence < threshold) reasons.push(`confianza ${confidence.toFixed(2)} < ${threshold.toFixed(2)}`);
  if (policy.alwaysReview.severity.includes(severity)) reasons.push(`severidad ${SEVERITY_ES[severity]}`);
  if (ms.length >= policy.alwaysReview.minClashCount) reasons.push(`grupo de ${ms.length} interferencias (≥ ${policy.alwaysReview.minClashCount})`);
  const unmatched = ruleIds.some((r) => r === "DEF-999" || r === "NONE");
  if (policy.alwaysReview.unmatched && unmatched) reasons.push("sin regla específica");
  if (policy.alwaysReview.rulesConflict && (new Set(cls.map((c) => c.nature)).size > 1 || new Set(cls.map((c) => c.rootCause)).size > 1)) {
    reasons.push("reglas en conflicto (naturaleza o causa raíz distintas)");
  }
  const closable = first.validity === "false_positive" || first.validity === "tolerated";
  if (closable && ms.length > policy.bulkClosureMax) reasons.push(`cierre masivo de ${ms.length} interferencias (> ${policy.bulkClosureMax})`);
  if (closable && tags.has("seguridad_personas")) reasons.push("cierre de grupo con seguridad_personas");
  for (const r of new Set(cls.flatMap((c) => c.humanReviewReasons))) {
    if (r === "low_confidence" && reasons.some((x) => x.startsWith("confianza "))) continue;
    const es = HUMAN_REASON_ES[r] ?? r;
    if (!reasons.some((x) => x.includes(es))) reasons.push(es);
  }
  const needsReview = reasons.length > 0;

  const levels = [...new Set(ms.map((m) => m.level).filter((x): x is string => !!x))].sort(cmpStr);
  const hub = d.hub;
  const disciplines = [...new Set(ms.flatMap((m) => [m.left.discipline, m.right.discipline]))].sort(cmpStr);
  const group: ClashGroup = {
    id,
    strategy: d.strategy,
    canonicalKey: d.key,
    title: "",
    validity: first.validity,
    nature,
    rootCause,
    responsibleDiscipline: first.responsibleDiscipline,
    ...(secondary ? { secondaryDiscipline: secondary } : {}),
    suggestedAction,
    severity,
    priorityScore: priority.score,
    band: priority.band,
    priority,
    ruleIds,
    memberKeys: ms.map((m) => m.key).sort(cmpStr),
    mcClashIds: [...new Set(ms.flatMap((m) => m.mcClashIds))].sort(cmpStr),
    levels,
    ...(hub ? {
      hubElement: {
        ...(hub.externalId ? { externalId: hub.externalId } : {}),
        ...(hub.category ? { category: hub.category } : {}),
        ...(hub.family ? { family: hub.family } : {}),
        ...(hub.type ? { type: hub.type } : {}),
        ...(hub.systemName ? { systemName: hub.systemName } : {}),
        ...(hub.level ? { level: hub.level } : {}),
        discipline: hub.discipline,
        elementClass: hub.elementClass,
      },
    } : {}),
    sample: sampleOf(id, ms),
    tags: tagList,
    humanReview,
    confidence,
    confidenceBand: confidenceBand(policy, first.validity, nature, confidence),
    needsReview,
    reviewState: needsReview ? "needs_review" : "auto_ok",
    reviewReasons: reasons,
    escalate: confidence < policy.reviewFloor || unmatched,
    disciplinePair: dominant(ms.map(discPair))!,
    categoryPair: dominant(ms.map((m) => sortedPair(String(m.left.category ?? "?"), String(m.right.category ?? "?"), "×")))!,
    stats: { count: ms.length, maxPenetrationMm: Math.max(...ms.map((m) => m.facts.penetrationMm)), disciplines },
  };
  group.title = groupTitle(rs, group, ms, options, hub);
  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spanish titles (grouping-strategies.md "Generated title patterns")
// ─────────────────────────────────────────────────────────────────────────────

export function categoryLabel(rs: CompiledRuleSet, cat: string | undefined): string {
  if (!cat) return "elemento";
  return rs.categoryLabelsEs.get(cat) ?? cat;
}

/** "Ø110", "600x400" or "" from element dimensions. */
export function sizeHint(el: ElementFacts): string {
  const n = (k: string) => (typeof el[k] === "number" ? Math.round(el[k] as number) : undefined);
  const dia = n("outsideDiameterMm") ?? n("diameterMm");
  if (dia !== undefined) return `Ø${dia}`;
  const w = n("widthMm");
  const h = n("heightMm");
  if (w !== undefined && h !== undefined) return `${w}x${h}`;
  const s = n("sizeMm");
  return s !== undefined ? `${s} mm` : "";
}

const join = (...parts: Array<string | undefined>) => parts.filter((p) => p !== undefined && p !== "").join(" ");

function commonClass(els: readonly ElementFacts[]): string | undefined {
  const s = new Set(els.map((e) => e.elementClass));
  return s.size === 1 ? [...s][0] : undefined;
}

function groupTitle(rs: CompiledRuleSet, g: ClashGroup, ms: readonly ClassifiedClash[], options: GroupingOptions, hubEl?: ElementFacts): string {
  const n = ms.length;
  const level = g.levels.length === 1 ? g.levels[0]! : g.levels.length > 1 ? `${g.levels[0]} a ${g.levels[g.levels.length - 1]}` : "sin nivel";
  const first = ms[0]!;
  switch (g.strategy) {
    case "nonissue": {
      const discs = [...new Set([first.left.discipline, first.right.discipline])].sort(cmpStr).join("×");
      return `${n} × ${ruleNameEs(g.ruleIds[0]!, first.classification.ruleName)} (${discs})`;
    }
    case "hygiene": {
      const side = responsibleSide(first) ?? sideA(first);
      return `Higiene: ${ruleNameEs(g.ruleIds[0]!, first.classification.ruleName)} en ${sanitize(side.documentName ?? side.modelFile ?? "archivo desconocido")}`;
    }
    case "needsinfo": {
      const a = sideA(first);
      const fam = sanitize(a.family);
      if (g.canonicalKey.includes("|fam:")) {
        const elements = new Set(ms.map((m) => elementToken(sideA(m)))).size;
        return `¿Qué representa la familia '${fam}' (${elements} instancias, ${g.responsibleDiscipline})?`;
      }
      if (fam) return `¿Qué representa '${fam}' (${categoryLabel(rs, a.category)}, ${g.responsibleDiscipline})? — ${level}`;
      return `${ruleNameEs(g.ruleIds[0]!, first.classification.ruleName)}: ${sanitize(a.documentName ?? a.modelFile ?? "?")} (${g.responsibleDiscipline})`;
    }
    case "hub-mover": {
      const hub = hubEl ?? moverOf(first) ?? first.left;
      const cc = commonClass(ms.map((m) => fixedOf(m) ?? m.right));
      return join(
        capitalize(categoryLabel(rs, hub.category)), sanitize(hub.systemName ?? hub.type, 30), sizeHint(hub),
        "vs", String(n), cc ? classLabel(cc).many : "elementos", "—", sanitize(hub.level) || level,
      );
    }
    case "hub-fixed": {
      const hub = hubEl ?? fixedOf(first) ?? first.left;
      const tok = elementToken(hub);
      const crossing = ms.map((m) => (elementToken(m.left) === tok ? m.right : m.left));
      const cc = commonClass(crossing);
      const discs = [...new Set(crossing.map((e) => e.discipline))].sort(cmpStr).join("/");
      const part = classLabel(hub.elementClass).g === "f" ? "atravesada" : "atravesado";
      const label = categoryLabel(rs, hub.category);
      const type = sanitize(hub.type, 30);
      return join(
        capitalize(label), norm(type).startsWith(norm(label)) ? type.slice(label.length).trim() : type, part, "por", String(n),
        cc ? classLabel(cc).many : "elementos", "de", discs, "—", sanitize(hub.level) || level,
      );
    }
    case "run": {
      const [mv, other] = moverSideOf(first);
      return `${g.responsibleDiscipline} ${sanitize(mv.systemName ?? mv.systemType ?? mv.family, 30)} vs ${classLabel(other.elementClass).many} — ${level} (${n})`.replace(/\s+/g, " ");
    }
    case "zone": {
      const [, other] = moverSideOf(first);
      const bay = options.bayOf?.(first);
      return `${capitalize(level)}${bay ? ` eje ${bay}` : ""}: ${n} ${g.responsibleDiscipline} vs ${other.discipline}`;
    }
    case "single": {
      const a = sideA(first);
      const b = sideB(first);
      return `${capitalize(categoryLabel(rs, a.category))} vs ${categoryLabel(rs, b.category)} — ${level}`;
    }
  }
}
