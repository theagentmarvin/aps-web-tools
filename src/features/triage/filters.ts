/**
 * Triage list query: URL (de)serialisation, per-item filter facts, filtering,
 * sorting, facet counts (spec §3.6).
 *
 * Query keys are English; filter VALUES in the URL are the Spanish tokens from
 * the spec (`?decision=pendiente&pair=CLI:EST`). Facts are computed in that
 * same vocabulary so filtering and facet counting are generic.
 */
import type { TKey } from "~/i18n";
import { band, decisionState, effectiveValues, minConfidence, pairKey, type Thresholds } from "~/lib/api/decision-utils";
import type { AccStatus, Clash, ClashGroup, Decision, DecisionState, Delta, FieldSource, IssueState, Nature, Priority, Proposal, Validity } from "~/lib/api/types";
import { NATURE_KEY, VALIDITY_KEY } from "~/lib/labels";

export const FILTER_KEYS = ["decision", "pair", "validity", "nature", "priority", "confidence", "level", "accStatus", "delta", "source", "owner", "issue"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string[]>>;

export const SORT_KEYS = ["priority", "confidence_asc", "count_desc", "distance", "level", "pair", "delta", "updated"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type ViewMode = "groups" | "clashes";

export interface ListQuery {
  filters: Filters;
  sort: SortKey;
  q: string;
  view: ViewMode;
  /** Document pair "a,b" (from the clash grid): only clashes between those two models. Filtered client-side. */
  docs?: string;
}

export const DEFAULT_FILTERS: Filters = { decision: ["pendiente"] };

// ── Vocabulary maps (domain value → URL token) ─────────────────────

export const DECISION_TOKEN: Record<DecisionState, string> = {
  pending: "pendiente",
  accepted: "aceptada",
  corrected: "corregida",
  rejected: "rechazada",
  postponed: "pospuesta",
  inherited: "heredada",
};
export const VALIDITY_TOKEN: Record<Validity, string> = {
  real: "valida",
  false_positive: "falso_positivo",
  tolerated: "tolerable",
  needs_info: "requiere_info",
};
export const NATURE_TOKEN: Record<Nature, string> = { hard: "fisica", clearance: "holgura", duplicate: "duplicada", workflow: "secuencia" };
export const STATUS_TOKEN: Record<AccStatus, string> = { active: "activa", reviewed: "revisada", resolved: "resuelta", closed: "cerrada" };
export const DELTA_TOKEN: Record<Delta, string> = { new: "nueva", persisting: "persistente", reappeared: "reaparecida", modified: "modificada", resolved: "resuelta" };
export const SOURCE_TOKEN: Record<FieldSource, string> = { rule: "regla", llm: "ia", "rule+llm": "regla_ia", manual: "manual" };
export const ISSUE_TOKEN: Record<IssueState, string> = { draft: "borrador", existing: "existente", none: "ninguna" };

const invert = <K extends string>(m: Record<K, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<string, K>;
const DECISION_FROM = invert(DECISION_TOKEN);
const VALIDITY_FROM = invert(VALIDITY_TOKEN);
const STATUS_FROM = invert(STATUS_TOKEN);
const DELTA_FROM = invert(DELTA_TOKEN);
const NATURE_FROM = invert(NATURE_TOKEN);

/** i18n label for a filter token; null = show the raw token (codes, levels). */
export function tokenLabelKey(key: FilterKey, token: string): TKey | null {
  switch (key) {
    case "decision":
      return `decision.${DECISION_FROM[token]}` as TKey;
    case "validity": {
      const v = VALIDITY_FROM[token] as Validity | undefined;
      return v ? VALIDITY_KEY[v] : null;
    }
    case "nature": {
      const n = NATURE_FROM[token] as Nature | undefined;
      return n ? NATURE_KEY[n] : null;
    }
    case "priority":
      return `priority.p${token}` as TKey;
    case "confidence":
      return token === "alta" ? "confidence.high" : token === "media" ? "confidence.medium" : "confidence.low";
    case "accStatus":
      return STATUS_FROM[token] ? (`accStatus.${STATUS_FROM[token]}` as TKey) : null;
    case "delta":
      return DELTA_FROM[token] ? (`delta.${DELTA_FROM[token]}` as TKey) : null;
    case "source":
      return token === "regla" ? "source.ruleGeneric" : token === "ia" ? "source.llm" : token === "regla_ia" ? "source.ruleLlm" : "source.manual";
    case "issue":
      return token === "borrador" ? "filters.issueDraft" : token === "existente" ? "filters.issueExisting" : "filters.issueNone";
    default:
      return null;
  }
}

/** Fixed value lists for enumerable filters (others come from data). */
export const FIXED_VALUES: Partial<Record<FilterKey, string[]>> = {
  decision: Object.values(DECISION_TOKEN),
  validity: Object.values(VALIDITY_TOKEN),
  nature: Object.values(NATURE_TOKEN),
  priority: ["1", "2", "3", "4"],
  confidence: ["alta", "media", "baja"],
  accStatus: Object.values(STATUS_TOKEN),
  delta: ["nueva", "persistente", "reaparecida", "modificada"],
  source: Object.values(SOURCE_TOKEN),
  issue: Object.values(ISSUE_TOKEN),
};

// ── URL ────────────────────────────────────────────────────────────

export function parseQuery(sp: URLSearchParams): ListQuery {
  const filters: Filters = {};
  for (const k of FILTER_KEYS) {
    if (!sp.has(k)) continue;
    const raw = sp.get(k) ?? "";
    filters[k] = raw ? raw.split(",").filter(Boolean) : [];
  }
  if (!sp.has("decision")) filters.decision = DEFAULT_FILTERS.decision;
  const sortRaw = sp.get("sort") as SortKey | null;
  return {
    filters,
    sort: sortRaw && (SORT_KEYS as readonly string[]).includes(sortRaw) ? sortRaw : "priority",
    q: sp.get("q") ?? "",
    view: sp.get("view") === "clashes" ? "clashes" : "groups",
    ...(sp.get("docs") ? { docs: sp.get("docs")! } : {}),
  };
}

/** Write the list query into `sp` (mutates and returns it). */
export function writeQuery(sp: URLSearchParams, q: ListQuery): URLSearchParams {
  for (const k of FILTER_KEYS) sp.delete(k);
  for (const k of FILTER_KEYS) {
    const v = q.filters[k];
    if (v === undefined) continue;
    if (k === "decision" && v.length === 1 && v[0] === "pendiente") continue; // default
    sp.set(k, v.join(","));
  }
  if (!q.filters.decision) sp.set("decision", "");
  q.sort === "priority" ? sp.delete("sort") : sp.set("sort", q.sort);
  q.q ? sp.set("q", q.q) : sp.delete("q");
  q.view === "groups" ? sp.delete("view") : sp.set("view", q.view);
  q.docs ? sp.set("docs", q.docs) : sp.delete("docs");
  return sp;
}

export function isDefaultQuery(q: ListQuery): boolean {
  const active = FILTER_KEYS.filter((k) => q.filters[k] !== undefined);
  const onlyDefault = active.length === 1 && active[0] === "decision" && q.filters.decision?.length === 1 && q.filters.decision[0] === "pendiente";
  return onlyDefault && !q.q && !q.docs;
}

// ── Facts ──────────────────────────────────────────────────────────

export interface ItemRef {
  kind: "group" | "clash";
  id: string;
}

export interface StaticFacts {
  kind: "group" | "clash";
  id: string;
  group?: ClashGroup;
  clash?: Clash;
  proposal?: Proposal;
  pair: string;
  levels: string[];
  accStatus: string[];
  delta: string[];
  source: string[];
  issue: string;
  count: number;
  penetration: number;
  updatedAt: string;
  search: string;
  level: string;
  deltaRank: number;
  nature?: Nature;
  /** Unordered document pairs "min:max" of the member clashes. */
  docPairs: string[];
}

const DELTA_RANK: Record<Delta, number> = { new: 0, reappeared: 1, modified: 2, persisting: 3, resolved: 4 };

export function groupFacts(g: ClashGroup, members: Clash[], p: Proposal | undefined): StaticFacts {
  const names = new Set<string>();
  for (const c of members) {
    names.add(c.a.name);
    names.add(c.b.name);
  }
  const sources = p ? [...new Set(Object.values(p.fields).map((f) => SOURCE_TOKEN[f.source]))] : [];
  return {
    kind: "group",
    id: g.id,
    group: g,
    proposal: p,
    pair: pairKey(g.pair[0], g.pair[1]),
    levels: g.location?.level ? [g.location.level] : [],
    level: g.location?.level ?? "",
    accStatus: [...new Set(members.map((c) => STATUS_TOKEN[c.status]))],
    delta: [...new Set(members.map((c) => DELTA_TOKEN[c.delta]))],
    source: sources,
    issue: ISSUE_TOKEN[g.issue],
    count: g.clashIds.length,
    penetration: g.penetrationMaxMm,
    updatedAt: p?.updatedAt ?? g.updatedAt,
    search: [g.id, g.title, ...names, ...g.clashIds, ...(p?.ruleIds ?? []), p?.issueDraft?.title ?? ""].join(" ").toLowerCase(),
    deltaRank: DELTA_RANK[g.delta],
    nature: g.nature,
    docPairs: [...new Set(members.map(docPair))],
  };
}

export function clashFacts(c: Clash, g: ClashGroup | undefined, p: Proposal | undefined): StaticFacts {
  return {
    kind: "clash",
    id: c.id,
    clash: c,
    group: g,
    proposal: p,
    pair: g ? pairKey(g.pair[0], g.pair[1]) : pairKey(c.a.discipline, c.b.discipline),
    levels: c.level ? [c.level] : [],
    level: c.level ?? "",
    accStatus: [STATUS_TOKEN[c.status]],
    delta: [DELTA_TOKEN[c.delta]],
    source: p ? [...new Set(Object.values(p.fields).map((f) => SOURCE_TOKEN[f.source]))] : [],
    issue: g ? ISSUE_TOKEN[g.issue] : "ninguna",
    count: 1,
    penetration: -c.distanceMm,
    updatedAt: p?.updatedAt ?? g?.updatedAt ?? "",
    search: [c.id, c.a.name, c.b.name, c.a.dbId, c.b.dbId, g?.title ?? ""].join(" ").toLowerCase(),
    deltaRank: DELTA_RANK[c.delta],
    nature: c.nature,
    docPairs: [docPair(c)],
  };
}

export interface DynamicFacts {
  state: DecisionState;
  validity?: Validity;
  priority?: Priority;
  owner?: string;
  confidence: number | null;
  edited: boolean;
}

export function dynamicFacts(s: StaticFacts, decision: Decision | undefined): DynamicFacts {
  const eff = effectiveValues(s.proposal, decision);
  return {
    state: decisionState(decision, s.proposal),
    validity: eff.validity,
    priority: eff.priority,
    owner: eff.owner,
    confidence: s.proposal ? minConfidence(s.proposal) : null,
    edited: decision?.kind === "correct",
  };
}

export function filterValues(s: StaticFacts, d: DynamicFacts, t: Thresholds): Record<FilterKey, string[]> {
  return {
    decision: [DECISION_TOKEN[d.state]],
    pair: [s.pair],
    validity: d.validity ? [VALIDITY_TOKEN[d.validity]] : [],
    nature: s.nature ? [NATURE_TOKEN[s.nature]] : [],
    priority: d.priority ? [String(d.priority)] : [],
    confidence: d.confidence === null ? [] : [band(d.confidence, t)],
    level: s.levels,
    accStatus: s.accStatus,
    delta: s.delta,
    source: s.source,
    owner: d.owner ? [d.owner] : [],
    issue: [s.issue],
  };
}

function matches(values: Record<FilterKey, string[]>, filters: Filters, skip?: FilterKey): boolean {
  for (const k of FILTER_KEYS) {
    if (k === skip) continue;
    const want = filters[k];
    if (!want || want.length === 0) continue;
    if (!values[k].some((v) => want.includes(v))) return false;
  }
  return true;
}

export interface Evaluated {
  s: StaticFacts;
  d: DynamicFacts;
  values: Record<FilterKey, string[]>;
}

export function docPair(c: Clash): string {
  const a = c.a.documentId;
  const b = c.b.documentId;
  return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

/** "3,1" → "1:3" */
export function docsKey(docs: string): string {
  const [a, b] = docs.split(",").map(Number);
  const x = b === undefined || Number.isNaN(b) ? a : b;
  return a <= x ? `${a}:${x}` : `${x}:${a}`;
}

export function passes(e: Evaluated, q: ListQuery): boolean {
  if (q.docs && !e.s.docPairs.includes(docsKey(q.docs))) return false;
  if (q.q && !e.s.search.includes(q.q.toLowerCase())) return false;
  return matches(e.values, q.filters);
}

export function facetCounts(items: Evaluated[], q: ListQuery, key: FilterKey): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of items) {
    if (q.docs && !e.s.docPairs.includes(docsKey(q.docs))) continue;
    if (q.q && !e.s.search.includes(q.q.toLowerCase())) continue;
    if (!matches(e.values, q.filters, key)) continue;
    for (const v of e.values[key]) out.set(v, (out.get(v) ?? 0) + 1);
  }
  return out;
}

const collator = new Intl.Collator("es", { numeric: true });

export function sortItems(items: Evaluated[], sort: SortKey): Evaluated[] {
  const byPriority = (a: Evaluated, b: Evaluated) => (a.d.priority ?? 5) - (b.d.priority ?? 5) || b.s.count - a.s.count;
  const cmp: Record<SortKey, (a: Evaluated, b: Evaluated) => number> = {
    priority: byPriority,
    confidence_asc: (a, b) => (a.d.confidence ?? 1) - (b.d.confidence ?? 1) || byPriority(a, b),
    count_desc: (a, b) => b.s.count - a.s.count,
    distance: (a, b) => b.s.penetration - a.s.penetration,
    level: (a, b) => collator.compare(a.s.level, b.s.level) || byPriority(a, b),
    pair: (a, b) => a.s.pair.localeCompare(b.s.pair) || byPriority(a, b),
    delta: (a, b) => a.s.deltaRank - b.s.deltaRank || byPriority(a, b),
    updated: (a, b) => b.s.updatedAt.localeCompare(a.s.updatedAt),
  };
  return [...items].sort(cmp[sort]);
}
