/**
 * TriageStore — one per workspace (spec §7.4). Plain class + useSyncExternalStore.
 *
 * Holds normalised payload data, the decision log (append-only, with undo),
 * the list query and flattened row model, cursor/expansion/check state,
 * viewer controls, dwell tracking for the anti-rubber-stamping guards, and
 * the decision save queue (micro-batched, mirrored to localStorage).
 *
 * Components subscribe with narrow selectors so a cursor move re-renders only
 * the two affected rows and the detail pane.
 */
import { useSyncExternalStore } from "react";
import type { CoordinatorApi } from "~/lib/api";
import { DEFAULT_THRESHOLDS, latestDecisions, newId, type Thresholds } from "~/lib/api/decision-utils";
import type {
  Clash,
  Decision,
  DecisionChange,
  DecisionField,
  DecisionKind,
  Discipline,
  FamilyAction,
  FamiliesPayload,
  FamilyGroup,
  IssueDraft,
  ProblemTypeInfo,
  TriageFamily,
  TriagePayloadWithFamilies,
  Priority,
  Proposal,
  ProposedAction,
  ReasonCode,
  UserInfo,
  Validity,
} from "~/lib/api/types";
import { readJson, writeJson } from "~/lib/storage";
import {
  clashFacts,
  dynamicFacts,
  filterValues,
  groupFacts,
  passes,
  sortItems,
  type Evaluated,
  type ListQuery,
  type StaticFacts,
} from "./filters";

export type RowKind = "group" | "clash";
/** List rows also include the family tree's levels (not decision targets). */
export type ListKind = RowKind | "family" | "node";

export interface Row {
  key: string; // "g:G-0001" | "c:C-…" | "f:F-…" | "n:pair:CAL×EST" | "n:pair:CAL×EST|PT02"
  kind: ListKind;
  id: string;
  /** For clash rows: parent group id ("" in manual mode). */
  groupId: string;
  /** Clash rows inside an expanded group (indented). */
  nested: boolean;
  /** Tree depth in the families view (0 = discipline pair). */
  depth?: number;
  /** Parent row key in the families view (h / ← jumps to it). */
  parent?: string;
}

/** Level-1 (pair / bucket) or level-2 (problem type) node of the family tree. */
export interface TreeNode {
  id: string;
  depth: 0 | 1;
  bucket: TriageFamily["bucket"] | "loose";
  pair?: [string, string];
  problemType?: string;
  familyIds: string[];
  instanceCount: number;
  /** ACC (raw) clashes under the active filters: always the sum of the children. */
  clashCount: number;
  worst: Priority | null;
  needsReview: number;
}

/** A family (grupo) under the active filters. */
export interface FamilyStats {
  instanceCount: number;
  clashCount: number;
  worst: Priority | null;
  needsReview: number;
  levels: number;
}

/** Totals shown above the list; identical in both views for the same query. */
export interface ListSummary {
  groups: number;
  locations: number;
  clashes: number;
}

/** Family decision as edited in the family panel ("Cambiar"). */
export interface FamilyDraft {
  validity: Validity;
  action: FamilyAction;
  responsibleDiscipline: string;
  solutionOption?: string;
  typicalNote?: string;
}

export type ViewerStatus = "placeholder" | "init" | "loading" | "ready" | "failed";
export type ViewerMode = "isolate" | "xray" | "context";

export interface ViewerState {
  status: ViewerStatus;
  mode: ViewerMode;
  side: "a" | "b" | "both";
  markers: boolean;
  section: boolean;
  fitNonce: number;
  loaded: number;
  total: number;
  failedDocs: number[];
}

export type SaveStatus = "idle" | "saving" | "saved" | "failed";

/** Unsaved field edits of a target (inline editor, `i` issue draft). */
export interface PendingEdits {
  /** Target group id for merge/split corrections (R07). */
  group?: string;
  validity?: Validity;
  priority?: Priority;
  owner?: string;
  action?: ProposedAction;
  issue?: Partial<IssueDraft>;
}

export type Dialog =
  | null
  | { type: "reason"; mode: "correct" | "reject"; keys: string[]; edits: PendingEdits; field: DecisionField | "reject"; suggested?: ReasonCode }
  | { type: "validity" }
  | { type: "bulkAccept"; keys: string[] }
  | { type: "shortcuts" }
  | { type: "note"; key: string }
  | { type: "compare"; key: string }
  | { type: "rule"; ruleId: string }
  | { type: "send" }
  | { type: "familyApprove"; familyId: string }
  | { type: "familyReject"; familyId: string };

interface UndoEntry {
  label: string;
  decisions: Decision[];
}

export interface TriageState {
  ready: boolean;
  payload: TriagePayloadWithFamilies | null;
  manual: boolean;
  groups: Map<string, FamilyGroup>;
  families: Map<string, TriageFamily>;
  problemTypes: ProblemTypeInfo[];
  familyOf: Map<string, string>;
  nodes: Map<string, TreeNode>;
  familyStats: Map<string, FamilyStats>;
  /** Tree view: clashes of each ubicación that pass the filters (clash-level filtering). */
  visibleByGroup: Map<string, Clash[]>;
  summary: ListSummary;
  collapsedNodes: Set<string>;
  /** Instances (group ids) opened this session, per family: the spot-check record. */
  familyVisits: Map<string, Set<string>>;
  /** Pending exceptions per family: groupId → reason. */
  familyExceptions: Map<string, Map<string, string>>;
  familyDrafts: Map<string, Partial<FamilyDraft>>;
  /** Families whose issue preview is split per instance. */
  familySplit: Set<string>;
  clashes: Map<string, Clash>;
  clashesByGroup: Map<string, Clash[]>;
  proposals: Map<string, Proposal>; // by targetId
  disciplines: Discipline[];
  log: Decision[];
  latest: Map<string, Decision>;
  query: ListQuery;
  rows: Row[];
  cursorKey: string | null;
  expanded: Set<string>;
  checked: Set<string>;
  lastCheckedKey: string | null;
  dirty: boolean;
  viewer: ViewerState;
  dialog: Dialog;
  editing: boolean;
  edits: Map<string, PendingEdits>;
  rationaleOpen: boolean | null;
  detailCollapsed: boolean;
  save: { status: SaveStatus; failed: number };
  guard: { targetId: string; at: number } | null;
  hint: string | null;
  paceNudge: boolean;
  paceNudgeShown: boolean;
  pendingProposals: Proposal[];
  agentUpdated: Set<string>;
  session: { at: number; kind: DecisionKind; dwellMs: number }[];
  undoDepth: number;
  redoDepth: number;
  thresholds: Thresholds;
}

const initialViewer: ViewerState = { status: "init", mode: "xray", side: "both", markers: true, section: false, fitNonce: 0, loaded: 0, total: 0, failedDocs: [] };

export function rowKey(kind: RowKind, id: string) {
  return `${kind === "group" ? "g" : "c"}:${id}`;
}
/** Decision-target key (g:/c:). Tree keys (f:/n:) must be checked with isDecisionKey first. */
export function parseKey(key: string): { kind: RowKind; id: string } {
  return { kind: key.startsWith("g:") ? "group" : "clash", id: key.slice(2) };
}
export function isDecisionKey(key: string | null | undefined): key is string {
  return !!key && (key.startsWith("g:") || key.startsWith("c:"));
}
export function keyKind(key: string): ListKind {
  return key.startsWith("g:") ? "group" : key.startsWith("c:") ? "clash" : key.startsWith("f:") ? "family" : "node";
}
const PRIORITY_ORDER = (p: Priority | null) => p ?? 9;

export class TriageStore {
  state: TriageState;
  private listeners = new Set<() => void>();
  private staticFacts = new Map<string, StaticFacts>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private saveQueue: Decision[] = [];
  private saveTimer: number | null = null;
  private dwell = new Map<string, number>();
  private focusTarget: string | null = null;
  private focusStart = 0;
  private user: UserInfo = { id: "local", name: "Coordinador", initials: "CO" };

  constructor(
    private api: CoordinatorApi,
    query: ListQuery,
  ) {
    this.state = {
      ready: false,
      payload: null,
      manual: false,
      groups: new Map(),
      families: new Map(),
      problemTypes: [],
      familyOf: new Map(),
      nodes: new Map(),
      familyStats: new Map(),
      visibleByGroup: new Map(),
      summary: { groups: 0, locations: 0, clashes: 0 },
      collapsedNodes: new Set(),
      familyVisits: new Map(),
      familyExceptions: new Map(),
      familyDrafts: new Map(),
      familySplit: new Set(),
      clashes: new Map(),
      clashesByGroup: new Map(),
      proposals: new Map(),
      disciplines: [],
      log: [],
      latest: new Map(),
      query,
      rows: [],
      cursorKey: null,
      expanded: new Set(),
      checked: new Set(),
      lastCheckedKey: null,
      dirty: false,
      viewer: initialViewer,
      dialog: null,
      editing: false,
      edits: new Map(),
      rationaleOpen: null,
      detailCollapsed: readJson<{ detailCollapsed?: boolean }>("coord.layout", {}).detailCollapsed ?? false,
      save: { status: "idle", failed: 0 },
      guard: null,
      hint: null,
      paceNudge: false,
      paceNudgeShown: false,
      pendingProposals: [],
      agentUpdated: new Set(),
      session: [],
      undoDepth: 0,
      redoDepth: 0,
      thresholds: DEFAULT_THRESHOLDS,
    };
  }

  // ── subscription ─────────────────────────────────────────────────

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private set(patch: Partial<TriageState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  setUser(u: UserInfo) {
    this.user = u;
  }

  setThresholds(t: Thresholds) {
    if (t.high === this.state.thresholds.high && t.medium === this.state.thresholds.medium) return;
    this.set({ thresholds: t });
    this.recompute();
  }

  // ── loading ──────────────────────────────────────────────────────

  load(p: TriagePayloadWithFamilies) {
    const groups = new Map(p.groups.map((g) => [g.id, g]));
    const families = new Map((p.families ?? []).map((f) => [f.id, f]));
    const familyOf = new Map<string, string>();
    for (const f of families.values()) for (const gid of f.groupIds) familyOf.set(gid, f.id);
    for (const g of p.groups) if (g.familyId && families.has(g.familyId)) familyOf.set(g.id, g.familyId);
    const clashes = new Map(p.clashes.map((c) => [c.id, c]));
    const byGroup = new Map<string, Clash[]>();
    for (const c of p.clashes) {
      const list = byGroup.get(c.groupId) ?? [];
      list.push(c);
      byGroup.set(c.groupId, list);
    }
    const proposals = new Map(p.proposals.map((x) => [x.targetId, x]));
    const manual = p.groups.length === 0;
    const log = [...p.decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    this.staticFacts.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.dwell.clear();

    // Re-send decisions that were not confirmed before a reload (§3.9 save failure).
    const mirrored = readJson<Decision[]>(this.mirrorKey(p.modelSet.id), []).filter((d) => d.testId === p.test.id);
    const known = new Set(log.map((d) => d.id));
    const unsent = mirrored.filter((d) => !known.has(d.id));
    log.push(...unsent);
    this.saveQueue = unsent;

    this.state = {
      ...this.state,
      ready: true,
      payload: p,
      manual,
      groups,
      families,
      problemTypes: p.problemTypes ?? [],
      familyOf,
      collapsedNodes: new Set(),
      familyVisits: new Map(),
      familyExceptions: new Map(familyExceptionsFrom(families)),
      familyDrafts: new Map(),
      familySplit: new Set([...families.values()].filter((f) => f.issue?.mode === "per_instance" || f.decision?.issueMode === "per_instance").map((f) => f.id)),
      clashes,
      clashesByGroup: byGroup,
      proposals,
      disciplines: p.disciplines,
      log,
      latest: latestDecisions(log),
      expanded: new Set(),
      checked: new Set(),
      cursorKey: null,
      pendingProposals: [],
      agentUpdated: new Set(),
      undoDepth: 0,
      redoDepth: 0,
      query: manual ? { ...this.state.query, view: "clashes" } : this.state.query,
    };
    this.recompute();
    const first = this.firstKey();
    this.set({ cursorKey: first });
    this.startFocus(first);
    if (unsent.length) this.scheduleSave(0);
  }

  // ── facts / rows ─────────────────────────────────────────────────

  private facts(kind: RowKind, id: string): StaticFacts | undefined {
    const key = rowKey(kind, id);
    let f = this.staticFacts.get(key);
    if (f) return f;
    const s = this.state;
    if (kind === "group") {
      const g = s.groups.get(id);
      if (!g) return undefined;
      f = groupFacts(g, s.clashesByGroup.get(id) ?? [], s.proposals.get(id));
    } else {
      const c = s.clashes.get(id);
      if (!c) return undefined;
      const g = s.groups.get(c.groupId);
      f = clashFacts(c, g, s.proposals.get(id) ?? s.proposals.get(c.groupId));
    }
    this.staticFacts.set(key, f);
    return f;
  }

  /** Effective decision of a target: own, else (for clashes) the group's. */
  decisionFor(kind: RowKind, id: string): Decision | undefined {
    const own = this.state.latest.get(id);
    if (own || kind === "group") return own;
    const c = this.state.clashes.get(id);
    return c ? this.state.latest.get(c.groupId) : undefined;
  }

  proposalFor(kind: RowKind, id: string): Proposal | undefined {
    if (kind === "group") return this.state.proposals.get(id);
    const c = this.state.clashes.get(id);
    return this.state.proposals.get(id) ?? (c ? this.state.proposals.get(c.groupId) : undefined);
  }

  evaluate(kind: RowKind, id: string): Evaluated | undefined {
    const s = this.facts(kind, id);
    if (!s) return undefined;
    const d = dynamicFacts(s, this.decisionFor(kind, id));
    return { s, d, values: filterValues(s, d, this.state.thresholds) };
  }

  /**
   * All items of the current view mode, evaluated (used for facets and rows).
   * The tree ("Grupos") and "Interferencias" both filter at CLASH level, so the
   * same query gives the same clashes in both views; only the grouping differs.
   */
  allEvaluated(): Evaluated[] {
    const s = this.state;
    const kind: RowKind = this.clashLevel() ? "clash" : "group";
    const ids = kind === "clash" ? [...s.clashes.keys()] : [...s.groups.keys()];
    return ids.map((id) => this.evaluate(kind, id)).filter((e): e is Evaluated => !!e);
  }

  /** Items are clashes: the Interferencias view, the tree, and manual mode. */
  clashLevel(): boolean {
    return this.state.query.view === "clashes" || this.state.manual || this.familiesMode();
  }

  /** Groups are the list items (groups or families view). */
  groupsMode(): boolean {
    return this.state.query.view !== "clashes" && !this.state.manual;
  }

  /** The family tree is shown (families view and the server sent families). */
  familiesMode(): boolean {
    return this.state.query.view !== "clashes" && !this.state.manual && this.state.families.size > 0;
  }

  /** Level-1 node id of a family. */
  static l1Of(f: TriageFamily): string {
    return f.bucket === "pair" && f.pair ? `pair:${f.pair[0]}×${f.pair[1]}` : f.bucket;
  }
  static l2Of(f: TriageFamily): string {
    return `${TriageStore.l1Of(f)}|${f.parts.problemType}`;
  }

  familyOfGroup(groupId: string): TriageFamily | undefined {
    const id = this.state.familyOf.get(groupId);
    return id ? this.state.families.get(id) : undefined;
  }

  /** Worst (lowest number) effective priority among a family's instances. */
  familyWorst(f: TriageFamily): Priority | null {
    const st = this.state.familyStats.get(f.id);
    if (st) return st.worst;
    let w: Priority | null = null;
    for (const gid of f.groupIds) {
      const p = this.evaluate("group", gid)?.d.priority ?? null;
      if (p && (!w || p < w)) w = p;
    }
    return w;
  }

  /** Ubicaciones (group ids) under a tree row, as shown with the active filters. */
  subtreeGroups(key: string): string[] {
    const s = this.state;
    const visible = (gid: string) => !this.familiesMode() || s.visibleByGroup.has(gid);
    if (key.startsWith("g:")) return [key.slice(2)];
    if (key.startsWith("c:")) return [];
    if (key.startsWith("f:")) return (s.families.get(key.slice(2))?.groupIds ?? []).filter(visible);
    const node = s.nodes.get(key.slice(2));
    if (!node) return [];
    if (node.bucket === "loose") return [...s.visibleByGroup.keys()].filter((g) => !s.familyOf.has(g));
    return node.familyIds.flatMap((fid) => (s.families.get(fid)?.groupIds ?? []).filter(visible));
  }

  /** Clashes the viewer shows for a row: the whole subtree (visible under the filters), or the focused clash. */
  selectionMembers(key: string | null): { focus: Clash | undefined; members: Clash[] } {
    const s = this.state;
    if (!key) return { focus: undefined, members: [] };
    const membersOf = (gid: string) => (this.familiesMode() ? s.visibleByGroup.get(gid) : undefined) ?? s.clashesByGroup.get(gid) ?? [];
    if (key.startsWith("c:")) {
      const c = s.clashes.get(key.slice(2));
      return { focus: c, members: c ? membersOf(c.groupId) : [] };
    }
    return { focus: undefined, members: this.subtreeGroups(key).flatMap(membersOf) };
  }

  /** @deprecated tree rows now select their whole subtree (selectionMembers). */
  viewKey(key: string | null): string | null {
    return key;
  }

  private buildTree(sortedGroups: Evaluated[], rows: Row[]) {
    const s = this.state;
    const nodes = new Map<string, TreeNode>();
    const familyStats = new Map<string, FamilyStats>();
    const byFamily = new Map<string, Evaluated[]>();
    const loose: Evaluated[] = [];
    for (const e of sortedGroups) {
      const fid = s.familyOf.get(e.s.id);
      if (fid && s.families.has(fid)) byFamily.set(fid, [...(byFamily.get(fid) ?? []), e]);
      else loose.push(e);
    }
    const count = (e: Evaluated) => s.visibleByGroup.get(e.s.id)?.length ?? 0;
    const worstOf = (items: Evaluated[]) => items.reduce<Priority | null>((w, e) => (e.d.priority && (!w || e.d.priority < w) ? e.d.priority : w), null);
    const reviewOf = (items: Evaluated[]) => items.filter((e) => e.s.group?.reviewState === "needs_review").length;
    const clashesOf = (items: Evaluated[]) => items.reduce((n, e) => n + count(e), 0);
    const famInfo = [...byFamily].map(([fid, items]) => {
      const st: FamilyStats = {
        instanceCount: items.length,
        clashCount: clashesOf(items),
        worst: worstOf(items),
        needsReview: reviewOf(items),
        levels: levelsOf(s.families.get(fid)!, items),
      };
      familyStats.set(fid, st);
      return { f: s.families.get(fid)!, items, st };
    });
    type FamInfo = (typeof famInfo)[number];
    const add = (id: string, depth: 0 | 1, init: Pick<TreeNode, "bucket" | "pair" | "problemType">, fi: FamInfo) => {
      const n = nodes.get(id) ?? { id, depth, ...init, familyIds: [], instanceCount: 0, clashCount: 0, worst: null, needsReview: 0 };
      n.familyIds.push(fi.f.id);
      n.instanceCount += fi.st.instanceCount;
      n.clashCount += fi.st.clashCount;
      n.needsReview += fi.st.needsReview;
      if (fi.st.worst && (!n.worst || fi.st.worst < n.worst)) n.worst = fi.st.worst;
      nodes.set(id, n);
    };
    for (const fi of famInfo) {
      add(TriageStore.l1Of(fi.f), 0, { bucket: fi.f.bucket, pair: fi.f.pair }, fi);
      add(TriageStore.l2Of(fi.f), 1, { bucket: fi.f.bucket, pair: fi.f.pair, problemType: fi.f.parts.problemType }, fi);
    }
    if (loose.length) {
      nodes.set("loose", { id: "loose", depth: 0, bucket: "loose", familyIds: [], instanceCount: loose.length, clashCount: clashesOf(loose), worst: worstOf(loose), needsReview: reviewOf(loose) });
    }
    // Importance at every level, across buckets: worst priority, then needs-review, then clash count.
    type Rank = { worst: Priority | null; needsReview: number; clashCount: number };
    const important = (a: Rank, b: Rank) => PRIORITY_ORDER(a.worst) - PRIORITY_ORDER(b.worst) || b.needsReview - a.needsReview || b.clashCount - a.clashCount;
    const l1 = [...nodes.values()].filter((n) => n.depth === 0).sort((a, b) => important(a, b) || a.id.localeCompare(b.id));
    const pushInstances = (items: Evaluated[], depth: number, parent: string) => {
      for (const e of items) {
        const key = rowKey("group", e.s.id);
        rows.push({ key, kind: "group", id: e.s.id, groupId: e.s.id, nested: false, depth, parent });
        if (s.expanded.has(e.s.id)) for (const c of s.visibleByGroup.get(e.s.id) ?? []) rows.push({ key: rowKey("clash", c.id), kind: "clash", id: c.id, groupId: e.s.id, nested: true, depth: depth + 1, parent: key });
      }
    };
    for (const n1 of l1) {
      const k1 = `n:${n1.id}`;
      rows.push({ key: k1, kind: "node", id: n1.id, groupId: "", nested: false, depth: 0 });
      if (s.collapsedNodes.has(n1.id)) continue;
      if (n1.bucket === "loose") {
        pushInstances(loose, 1, k1);
        continue;
      }
      const l2 = [...nodes.values()].filter((n) => n.depth === 1 && n.id.startsWith(`${n1.id}|`)).sort((a, b) => important(a, b) || a.id.localeCompare(b.id));
      for (const n2 of l2) {
        const k2 = `n:${n2.id}`;
        rows.push({ key: k2, kind: "node", id: n2.id, groupId: "", nested: false, depth: 1, parent: k1 });
        if (s.collapsedNodes.has(n2.id)) continue;
        const fams = famInfo.filter((x) => TriageStore.l2Of(x.f) === n2.id).sort((a, b) => important(a.st, b.st) || b.st.instanceCount - a.st.instanceCount || a.f.id.localeCompare(b.f.id));
        for (const fi of fams) {
          const kf = `f:${fi.f.id}`;
          rows.push({ key: kf, kind: "family", id: fi.f.id, groupId: "", nested: false, depth: 2, parent: k2 });
          if (s.expanded.has(fi.f.id)) pushInstances(fi.items, 3, kf);
        }
      }
    }
    return { nodes, familyStats };
  }

  /** Re-run filter + sort. Rows in `keep` stay even if they no longer match. */
  recompute(keep: string[] = []) {
    const s = this.state;
    const clashLevel = this.clashLevel();
    const keepIds = new Set<string>();
    for (const k of keep.filter(isDecisionKey)) {
      const { kind, id } = parseKey(k);
      if (clashLevel && kind === "group") for (const c of s.clashesByGroup.get(id) ?? []) keepIds.add(c.id);
      else keepIds.add(id);
    }
    const items = this.allEvaluated().filter((e) => keepIds.has(e.s.id) || passes(e, s.query));
    const rows: Row[] = [];
    if (this.familiesMode()) {
      // Clash-level filter, then group the passing clashes into ubicaciones → grupos → tipo → par.
      const visibleByGroup = new Map<string, Clash[]>();
      for (const e of items) {
        const c = e.s.clash;
        if (!c) continue;
        const list = visibleByGroup.get(c.groupId);
        if (list) list.push(c);
        else visibleByGroup.set(c.groupId, [c]);
      }
      this.state = { ...this.state, visibleByGroup };
      const groups = [...visibleByGroup.keys()].map((gid) => this.evaluate("group", gid)).filter((e): e is Evaluated => !!e);
      const { nodes, familyStats } = this.buildTree(sortItems(groups, s.query.sort), rows);
      const fams = new Set([...visibleByGroup.keys()].map((g) => s.familyOf.get(g) ?? g));
      this.set({ rows, nodes, familyStats, visibleByGroup, summary: { groups: fams.size, locations: visibleByGroup.size, clashes: items.length }, dirty: false });
      return;
    }
    const sorted = sortItems(items, s.query.sort);
    for (const e of sorted) {
      if (e.s.kind === "group") {
        rows.push({ key: rowKey("group", e.s.id), kind: "group", id: e.s.id, groupId: e.s.id, nested: false });
        if (s.expanded.has(e.s.id))
          for (const c of s.clashesByGroup.get(e.s.id) ?? []) rows.push({ key: rowKey("clash", c.id), kind: "clash", id: c.id, groupId: e.s.id, nested: true });
      } else {
        rows.push({ key: rowKey("clash", e.s.id), kind: "clash", id: e.s.id, groupId: e.s.clash?.groupId ?? "", nested: false });
      }
    }
    // Same totals line as the tree: grupos (families) · ubicaciones · interferencias.
    let summary: ListSummary;
    if (clashLevel) {
      const locs = new Set(items.map((e) => e.s.clash?.groupId ?? ""));
      const fams = new Set([...locs].map((g) => s.familyOf.get(g) ?? g));
      summary = { groups: fams.size, locations: locs.size, clashes: items.length };
    } else {
      summary = { groups: items.length, locations: items.length, clashes: items.reduce((n, e) => n + (e.s.group?.clashIds.length ?? 0), 0) };
    }
    this.set({ rows, summary, dirty: false });
  }

  // ── checks on tree nodes ─────────────────────────────────────────

  /** "all" | "some" | "none" of a row's ubicaciones are checked (tri-state checkbox). */
  checkState(key: string): "all" | "some" | "none" {
    if (isDecisionKey(key)) return this.state.checked.has(key) ? "all" : "none";
    const keys = this.subtreeGroups(key).map((g) => rowKey("group", g));
    const n = keys.filter((k) => this.state.checked.has(k)).length;
    return n === 0 ? "none" : n === keys.length ? "all" : "some";
  }

  /** Check / uncheck every ubicación under a tree row (decision rows toggle themselves). */
  toggleCheckSubtree(key: string) {
    if (isDecisionKey(key)) return this.toggleCheck(key);
    const keys = this.subtreeGroups(key).map((g) => rowKey("group", g));
    const c = new Set(this.state.checked);
    const all = keys.length > 0 && keys.every((k) => c.has(k));
    for (const k of keys) {
      if (all) c.delete(k);
      else c.add(k);
    }
    this.set({ checked: c, lastCheckedKey: key });
  }

  setQuery(query: ListQuery) {
    const viewChanged = query.view !== this.state.query.view;
    this.set({ query, checked: viewChanged ? new Set() : this.state.checked });
    this.recompute();
    const rows = this.state.rows;
    if (!rows.some((r) => r.key === this.state.cursorKey)) this.setCursor(this.firstKey());
  }

  // ── cursor / navigation ──────────────────────────────────────────

  private startFocus(key: string | null) {
    this.flushDwell();
    this.focusTarget = key ? parseKey(key).id : null;
    this.focusStart = performance.now();
  }

  private flushDwell() {
    if (!this.focusTarget) return;
    const st = this.state.viewer.status;
    if (st === "ready" || st === "placeholder") {
      const add = performance.now() - this.focusStart;
      this.dwell.set(this.focusTarget, (this.dwell.get(this.focusTarget) ?? 0) + add);
    }
    this.focusStart = performance.now();
  }

  /** Dwell in a ready viewer (or the mock placeholder) for a target, ms. */
  dwellFor(id: string): number {
    let d = this.dwell.get(id) ?? 0;
    const st = this.state.viewer.status;
    if (this.focusTarget === id && (st === "ready" || st === "placeholder")) d += performance.now() - this.focusStart;
    return d;
  }

  setCursor(key: string | null) {
    if (key === this.state.cursorKey) return;
    const prev = this.state.cursorKey;
    if (this.state.dirty) {
      // Filtered-out rows disappear only when the cursor leaves them (§3.4).
      this.recompute(key ? [key] : []);
    }
    void prev;
    this.startFocus(key);
    let familyVisits = this.state.familyVisits;
    if (isDecisionKey(key)) {
      const { kind, id } = parseKey(key);
      const gid = kind === "group" ? id : (this.state.clashes.get(id)?.groupId ?? "");
      const fid = this.state.familyOf.get(gid);
      if (fid && !familyVisits.get(fid)?.has(gid)) {
        familyVisits = new Map(familyVisits);
        familyVisits.set(fid, new Set([...(familyVisits.get(fid) ?? []), gid]));
      }
    }
    this.set({ cursorKey: key, editing: false, guard: null, hint: null, rationaleOpen: null, familyVisits });
  }

  /** Make a row visible in the tree (open its family and nodes) and put the cursor on it. */
  reveal(key: string) {
    if (this.familiesMode()) {
      const s = this.state;
      let fid: string | undefined;
      let gid = "";
      if (key.startsWith("f:")) fid = key.slice(2);
      else if (isDecisionKey(key)) {
        const { kind, id } = parseKey(key);
        gid = kind === "group" ? id : (s.clashes.get(id)?.groupId ?? "");
        fid = s.familyOf.get(gid);
      }
      const f = fid ? s.families.get(fid) : undefined;
      if (f) {
        const collapsed = new Set(s.collapsedNodes);
        collapsed.delete(TriageStore.l1Of(f));
        collapsed.delete(TriageStore.l2Of(f));
        const expanded = new Set(s.expanded);
        if (gid) expanded.add(f.id);
        if (key.startsWith("c:") && gid) expanded.add(gid);
        this.set({ collapsedNodes: collapsed, expanded });
      }
    }
    this.recompute([key]);
    this.setCursor(key);
  }

  toggleNode(id: string, open?: boolean) {
    const c = new Set(this.state.collapsedNodes);
    const willOpen = open ?? c.has(id);
    if (willOpen) c.delete(id);
    else c.add(id);
    this.set({ collapsedNodes: c });
    this.recompute(this.state.cursorKey ? [this.state.cursorKey] : []);
  }

  // ── families ─────────────────────────────────────────────────────

  familyDraft(fid: string): FamilyDraft | undefined {
    const f = this.state.families.get(fid);
    if (!f) return undefined;
    const base: FamilyDraft = f.decision?.status === "approved"
      ? { validity: f.decision.validity, action: f.decision.action, responsibleDiscipline: f.decision.responsibleDiscipline, solutionOption: f.decision.solutionOption, typicalNote: f.decision.typicalDetail?.note }
      : { validity: f.proposed.validity, action: f.proposed.action, responsibleDiscipline: f.proposed.responsibleDiscipline, solutionOption: f.proposed.solutionOption };
    return { ...base, ...this.state.familyDrafts.get(fid) };
  }

  setFamilyDraft(fid: string, patch: Partial<FamilyDraft> | null) {
    const m = new Map(this.state.familyDrafts);
    if (patch === null) m.delete(fid);
    else m.set(fid, { ...m.get(fid), ...patch });
    this.set({ familyDrafts: m });
  }

  setFamilyException(fid: string, groupId: string, reason: string | null) {
    const all = new Map(this.state.familyExceptions);
    const m = new Map(all.get(fid) ?? []);
    if (reason === null) m.delete(groupId);
    else m.set(groupId, reason);
    all.set(fid, m);
    this.set({ familyExceptions: all });
  }

  setFamilySplit(fid: string, split: boolean) {
    const s = new Set(this.state.familySplit);
    if (split) s.add(fid);
    else s.delete(fid);
    this.set({ familySplit: s });
  }

  /** Replace the families with a fresh GET /tests/:testId/families (after a decision); syncs instance inheritance onto groups. */
  applyFamilies(payload: FamiliesPayload, clearDraftOf?: string) {
    const families = new Map(payload.families.map((f) => [f.id, f]));
    const groups = new Map(this.state.groups);
    const familyOf = new Map(this.state.familyOf);
    for (const f of payload.families) {
      for (const gid of f.groupIds) familyOf.set(gid, f.id);
      for (const i of f.instances) {
        const g = groups.get(i.groupId);
        if (!g) continue;
        groups.set(i.groupId, { ...g, inheritance: i.inheritance, familyId: f.id });
        this.staticFacts.delete(rowKey("group", i.groupId));
      }
    }
    const drafts = new Map(this.state.familyDrafts);
    if (clearDraftOf) drafts.delete(clearDraftOf);
    this.set({
      families,
      groups,
      familyOf,
      problemTypes: payload.problemTypes.length ? payload.problemTypes : this.state.problemTypes,
      familyExceptions: new Map(familyExceptionsFrom(families)),
      familyDrafts: drafts,
      dialog: null,
      editing: false,
    });
    this.recompute(this.state.cursorKey ? [this.state.cursorKey] : []);
  }


  /** First row worth landing on: in the tree, the first family (not a pair/type header). */
  firstKey(): string | null {
    const rows = this.state.rows;
    return (rows.find((r) => r.kind !== "node") ?? rows[0])?.key ?? null;
  }

  cursorIndex(): number {
    return this.state.rows.findIndex((r) => r.key === this.state.cursorKey);
  }

  move(delta: number) {
    const rows = this.state.rows;
    if (!rows.length) return;
    const i = this.cursorIndex();
    const next = Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + delta));
    this.setCursor(rows[next].key);
  }

  first() {
    this.setCursor(this.state.rows[0]?.key ?? null);
  }
  last() {
    const r = this.state.rows;
    this.setCursor(r[r.length - 1]?.key ?? null);
  }

  toggleExpand(groupId: string, open?: boolean) {
    const ex = new Set(this.state.expanded);
    const willOpen = open ?? !ex.has(groupId);
    if (willOpen) ex.add(groupId);
    else ex.delete(groupId);
    this.set({ expanded: ex });
    this.recompute(this.state.cursorKey ? [this.state.cursorKey] : []);
  }

  expandCurrent() {
    const row = this.currentRow();
    if (!row) return;
    if (row.kind === "node") {
      if (this.state.collapsedNodes.has(row.id)) this.toggleNode(row.id, true);
      else this.move(1);
    } else if (row.kind === "family") {
      if (!this.state.expanded.has(row.id)) this.toggleExpand(row.id, true);
      else this.move(1);
    } else if (row.kind === "group") this.toggleExpand(row.id, true);
  }

  collapseCurrent() {
    const row = this.currentRow();
    if (!row) return;
    const toParent = () => {
      if (row.parent) this.setCursor(row.parent);
    };
    if (row.kind === "node") {
      if (!this.state.collapsedNodes.has(row.id)) this.toggleNode(row.id, false);
      else toParent();
    } else if (row.kind === "family") {
      if (this.state.expanded.has(row.id)) this.toggleExpand(row.id, false);
      else toParent();
    } else if (row.kind === "group") {
      if (this.state.expanded.has(row.id)) this.toggleExpand(row.id, false);
      else toParent();
    } else if (row.nested) {
      this.setCursor(rowKey("group", row.groupId));
      this.toggleExpand(row.groupId, false);
    }
  }

  /** J/K: next/previous clash inside the current group (expands it). */
  moveWithinGroup(delta: number) {
    const row = this.currentRow();
    if (!row || !isDecisionKey(row.key) || this.state.query.view === "clashes") return;
    const groupId = row.groupId;
    if (!this.state.expanded.has(groupId)) this.toggleExpand(groupId, true);
    const members = this.state.clashesByGroup.get(groupId) ?? [];
    if (!members.length) return;
    const idx = row.kind === "clash" ? members.findIndex((c) => c.id === row.id) : -1;
    const next = Math.max(0, Math.min(members.length - 1, idx + delta));
    this.setCursor(rowKey("clash", members[next].id));
  }

  currentRow(): Row | undefined {
    return this.state.rows.find((r) => r.key === this.state.cursorKey);
  }

  /** Next row after the cursor whose item is still pending/inherited (auto-advance). */
  nextPendingKey(fromKey: string | null): string | null {
    const rows = this.state.rows;
    const start = rows.findIndex((r) => r.key === fromKey);
    for (let i = start + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.nested || (r.kind !== "group" && r.kind !== "clash")) continue;
      const e = this.evaluate(r.kind, r.id);
      if (e && (e.d.state === "pending" || e.d.state === "inherited")) return r.key;
    }
    return null;
  }

  // ── checks ───────────────────────────────────────────────────────

  toggleCheck(key: string) {
    if (!isDecisionKey(key)) return;
    const c = new Set(this.state.checked);
    if (c.has(key)) c.delete(key);
    else c.add(key);
    this.set({ checked: c, lastCheckedKey: key });
  }

  rangeCheck(key: string) {
    const rows = this.state.rows;
    const from = rows.findIndex((r) => r.key === (this.state.lastCheckedKey ?? key));
    const to = rows.findIndex((r) => r.key === key);
    if (from < 0 || to < 0) return this.toggleCheck(key);
    const c = new Set(this.state.checked);
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (!rows[i].nested && isDecisionKey(rows[i].key)) c.add(rows[i].key);
    this.set({ checked: c, lastCheckedKey: key });
  }

  /** Ctrl+A: check all filtered rows; second press clears. */
  checkAll(): number {
    const top = this.familiesMode()
      ? [...this.state.visibleByGroup.keys()].map((g) => ({ key: rowKey("group", g) }))
      : this.state.rows.filter((r) => !r.nested && isDecisionKey(r.key));
    if (this.state.checked.size >= top.length && top.length) {
      this.set({ checked: new Set() });
      return 0;
    }
    this.set({ checked: new Set(top.map((r) => r.key)) });
    return top.length;
  }

  clearChecks() {
    this.set({ checked: new Set(), lastCheckedKey: null });
  }

  // ── decisions ────────────────────────────────────────────────────

  private mirrorKey(modelSetId: string) {
    return `coord.pending.${modelSetId}`;
  }

  private buildDecision(key: string, kind: DecisionKind, changes: DecisionChange[], extra: Partial<Decision> = {}): Decision | null {
    const p = this.state.payload;
    if (!p) return null;
    const { kind: rk, id } = parseKey(key);
    const proposal = this.proposalFor(rk, id);
    return {
      id: newId(),
      proposalId: proposal?.id ?? "",
      targetType: rk,
      targetId: id,
      testId: p.test.id,
      modelSetId: p.modelSet.id,
      projectId: p.project.id,
      kind,
      changes,
      viewedInViewerMs: Math.round(this.dwellFor(id)),
      decidedAt: new Date().toISOString(),
      userId: this.user.id,
      userName: this.user.name,
      ...extra,
    };
  }

  /**
   * Record decisions for `keys` (one undo step). Returns the created decisions.
   * Auto-advances the cursor when `advance` is set.
   */
  decide(
    keys: string[],
    kind: DecisionKind,
    changesFor: (key: string) => DecisionChange[],
    opts: { reasonCode?: ReasonCode; note?: string; suggestRule?: boolean; label: string; advance?: boolean } = { label: "" },
  ): Decision[] {
    const bulk = keys.length > 1 ? { size: keys.length } : undefined;
    const created: Decision[] = [];
    for (const key of keys) {
      const d = this.buildDecision(key, kind, changesFor(key), { reasonCode: opts.reasonCode, note: opts.note, suggestRule: opts.suggestRule, bulk });
      if (d) created.push(d);
    }
    if (!created.length) return created;
    this.commit(created);
    this.undoStack.push({ label: opts.label, decisions: created });
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    const edits = new Map(this.state.edits);
    for (const k of keys) edits.delete(parseKey(k).id);
    const session = [...this.state.session, ...created.map((d) => ({ at: Date.now(), kind: d.kind, dwellMs: d.viewedInViewerMs }))];
    this.set({ undoDepth: this.undoStack.length, redoDepth: 0, edits, session, editing: false, guard: null, hint: null });
    this.checkPace();
    if (opts.advance) {
      const next = this.nextPendingKey(this.state.cursorKey);
      if (next) this.setCursor(next);
    }
    return created;
  }

  /** Append decisions to the log, refresh latest, queue for save. */
  private commit(decisions: Decision[]) {
    const log = [...this.state.log, ...decisions];
    this.set({ log, latest: latestDecisions(log), dirty: true });
    this.saveQueue.push(...decisions);
    this.mirror();
    this.scheduleSave(this.saveQueue.length >= 20 ? 0 : 500);
  }

  note(key: string, text: string) {
    const d = this.buildDecision(key, "note", [], { note: text });
    if (d) this.commit([d]);
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const undos = entry.decisions
      .map((d) => this.buildDecision(rowKey(d.targetType, d.targetId), "undo", [], { undoes: d.id }))
      .filter((d): d is Decision => !!d);
    this.commit(undos);
    this.redoStack.push(entry);
    this.set({ undoDepth: this.undoStack.length, redoDepth: this.redoStack.length });
    const first = entry.decisions[0];
    if (first) {
      const key = rowKey(first.targetType, first.targetId);
      this.recompute([key]);
      this.setCursor(key);
    }
    return entry.label;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const again = entry.decisions.map((d) => ({ ...d, id: newId(), decidedAt: new Date().toISOString() }));
    this.commit(again);
    this.undoStack.push({ label: entry.label, decisions: again });
    this.set({ undoDepth: this.undoStack.length, redoDepth: this.redoStack.length });
    return entry.label;
  }

  private checkPace() {
    const s = this.state;
    if (s.paceNudgeShown) return;
    const last = s.session.filter((x) => x.kind !== "note" && x.kind !== "undo").slice(-30);
    if (last.length < 30) return;
    const acceptRate = last.filter((x) => x.kind === "accept").length / last.length;
    const dwells = last.map((x) => x.dwellMs).sort((a, b) => a - b);
    const median = dwells[Math.floor(dwells.length / 2)];
    if (acceptRate >= 0.95 && median < 1500) this.set({ paceNudge: true, paceNudgeShown: true });
  }

  dismissPace() {
    this.set({ paceNudge: false });
  }

  // ── save queue ───────────────────────────────────────────────────

  private mirror() {
    const p = this.state.payload;
    if (p) writeJson(this.mirrorKey(p.modelSet.id), this.saveQueue);
  }

  private scheduleSave(ms: number) {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(), ms);
  }

  async flushSave() {
    this.saveTimer = null;
    if (!this.saveQueue.length) return;
    const batch = this.saveQueue.slice(0, 20);
    this.set({ save: { status: "saving", failed: 0 } });
    try {
      const res = await this.api.saveDecisions(batch);
      const saved = new Set(res.saved);
      this.saveQueue = this.saveQueue.filter((d) => !saved.has(d.id));
      this.mirror();
      this.set({ save: { status: this.saveQueue.length ? "saving" : "saved", failed: 0 } });
      if (this.saveQueue.length) this.scheduleSave(0);
    } catch {
      this.set({ save: { status: "failed", failed: this.saveQueue.length } });
    }
  }

  retrySave() {
    this.scheduleSave(0);
  }

  dispose() {
    this.flushDwell();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      void this.flushSave();
    }
  }

  // ── live proposal updates ────────────────────────────────────────

  queueProposalUpdates(list: Proposal[]) {
    if (!list.length) return;
    const byId = new Map(this.state.pendingProposals.map((p) => [p.id, p]));
    for (const p of list) byId.set(p.id, p);
    this.set({ pendingProposals: [...byId.values()] });
  }

  /** Shift+R: apply queued proposal updates without losing human decisions. */
  applyProposalUpdates() {
    const pending = this.state.pendingProposals;
    if (!pending.length) return;
    const proposals = new Map(this.state.proposals);
    const updated = new Set(this.state.agentUpdated);
    for (const p of pending) {
      proposals.set(p.targetId, p);
      if (this.state.latest.has(p.targetId)) updated.add(p.targetId);
      this.staticFacts.delete(rowKey("group", p.targetId));
      for (const c of this.state.clashesByGroup.get(p.targetId) ?? []) this.staticFacts.delete(rowKey("clash", c.id));
    }
    this.set({ proposals, pendingProposals: [], agentUpdated: updated });
    this.recompute(this.state.cursorKey ? [this.state.cursorKey] : []);
  }

  // ── UI state ─────────────────────────────────────────────────────

  setDialog(dialog: Dialog) {
    this.set({ dialog });
  }

  setEditing(editing: boolean) {
    this.set({ editing });
  }

  setEdits(targetId: string, patch: PendingEdits) {
    const edits = new Map(this.state.edits);
    edits.set(targetId, { ...edits.get(targetId), ...patch });
    this.set({ edits });
  }

  clearEdits(targetId: string) {
    const edits = new Map(this.state.edits);
    edits.delete(targetId);
    this.set({ edits });
  }

  setGuard(targetId: string | null, hint: string | null) {
    this.set({ guard: targetId ? { targetId, at: Date.now() } : null, hint });
  }

  setHint(hint: string | null) {
    this.set({ hint });
  }

  toggleRationale(defaultOpen: boolean) {
    const cur = this.state.rationaleOpen ?? defaultOpen;
    this.set({ rationaleOpen: !cur });
  }

  toggleDetail() {
    const v = !this.state.detailCollapsed;
    writeJson("coord.layout", { ...readJson<object>("coord.layout", {}), detailCollapsed: v });
    this.set({ detailCollapsed: v });
  }

  setViewer(patch: Partial<ViewerState>) {
    if (patch.status && patch.status !== this.state.viewer.status) this.flushDwell();
    this.set({ viewer: { ...this.state.viewer, ...patch } });
  }

  cycleViewerMode() {
    const order: ViewerMode[] = ["isolate", "xray", "context"];
    const i = order.indexOf(this.state.viewer.mode);
    this.setViewer({ mode: order[(i + 1) % order.length] });
  }
}

/** Levels covered by the visible ubicaciones of a grupo (server instance levels, else the group location). */
function levelsOf(f: TriageFamily, items: Evaluated[]): number {
  const byId = new Map((f.instances ?? []).map((i) => [i.groupId, i.levels]));
  const set = new Set<string>();
  for (const e of items) for (const l of byId.get(e.s.id) ?? [e.s.group?.location?.level ?? ""]) if (l) set.add(l);
  return set.size;
}

function familyExceptionsFrom(families: Map<string, TriageFamily>): [string, Map<string, string>][] {
  return [...families.values()].filter((f) => f.exceptions.length).map((f) => [f.id, new Map(f.exceptions.map((e) => [e.groupId, e.reason]))]);
}

/** Subscribe to a slice of the store. Selectors must return stable values. */
export function useTriage<T>(store: TriageStore, selector: (s: TriageState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.state));
}
