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
  ClashGroup,
  Decision,
  DecisionChange,
  DecisionField,
  DecisionKind,
  Discipline,
  IssueDraft,
  Priority,
  Proposal,
  ProposedAction,
  ReasonCode,
  TriagePayload,
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

export interface Row {
  key: string; // "g:G-0001" | "c:C-…"
  kind: RowKind;
  id: string;
  /** For clash rows: parent group id ("" in manual mode). */
  groupId: string;
  /** Clash rows inside an expanded group (indented). */
  nested: boolean;
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
  | { type: "send" };

interface UndoEntry {
  label: string;
  decisions: Decision[];
}

export interface TriageState {
  ready: boolean;
  payload: TriagePayload | null;
  manual: boolean;
  groups: Map<string, ClashGroup>;
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
export function parseKey(key: string): { kind: RowKind; id: string } {
  return { kind: key.startsWith("g:") ? "group" : "clash", id: key.slice(2) };
}

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

  load(p: TriagePayload) {
    const groups = new Map(p.groups.map((g) => [g.id, g]));
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
    const first = this.state.rows[0]?.key ?? null;
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

  /** All items of the current view mode, evaluated (used for facets). */
  allEvaluated(): Evaluated[] {
    const s = this.state;
    const ids = s.query.view === "groups" && !s.manual ? [...s.groups.keys()] : [...s.clashes.keys()];
    const kind: RowKind = s.query.view === "groups" && !s.manual ? "group" : "clash";
    return ids.map((id) => this.evaluate(kind, id)).filter((e): e is Evaluated => !!e);
  }

  /** Re-run filter + sort. Rows in `keep` stay even if they no longer match. */
  recompute(keep: string[] = []) {
    const s = this.state;
    const keepSet = new Set(keep.map((k) => parseKey(k)).filter((k) => k.kind === (s.query.view === "groups" && !s.manual ? "group" : "clash")).map((k) => k.id));
    const items = this.allEvaluated().filter((e) => keepSet.has(e.s.id) || passes(e, s.query));
    const sorted = sortItems(items, s.query.sort);
    const rows: Row[] = [];
    for (const e of sorted) {
      if (e.s.kind === "group") {
        rows.push({ key: rowKey("group", e.s.id), kind: "group", id: e.s.id, groupId: e.s.id, nested: false });
        if (s.expanded.has(e.s.id))
          for (const c of s.clashesByGroup.get(e.s.id) ?? []) rows.push({ key: rowKey("clash", c.id), kind: "clash", id: c.id, groupId: e.s.id, nested: true });
      } else {
        rows.push({ key: rowKey("clash", e.s.id), kind: "clash", id: e.s.id, groupId: e.s.clash?.groupId ?? "", nested: false });
      }
    }
    // Keep nested clash cursor visible.
    this.set({ rows, dirty: false });
  }

  setQuery(query: ListQuery) {
    const viewChanged = query.view !== this.state.query.view;
    this.set({ query, checked: viewChanged ? new Set() : this.state.checked });
    this.recompute();
    const rows = this.state.rows;
    if (!rows.some((r) => r.key === this.state.cursorKey)) this.setCursor(rows[0]?.key ?? null);
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
    this.set({ cursorKey: key, editing: false, guard: null, hint: null, rationaleOpen: null });
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
    if (row?.kind === "group") this.toggleExpand(row.id, true);
  }

  collapseCurrent() {
    const row = this.currentRow();
    if (!row) return;
    if (row.kind === "group") this.toggleExpand(row.id, false);
    else if (row.nested) {
      this.setCursor(rowKey("group", row.groupId));
      this.toggleExpand(row.groupId, false);
    }
  }

  /** J/K: next/previous clash inside the current group (expands it). */
  moveWithinGroup(delta: number) {
    const row = this.currentRow();
    if (!row || this.state.query.view === "clashes") return;
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
      if (r.nested) continue;
      const e = this.evaluate(r.kind, r.id);
      if (e && (e.d.state === "pending" || e.d.state === "inherited")) return r.key;
    }
    return null;
  }

  // ── checks ───────────────────────────────────────────────────────

  toggleCheck(key: string) {
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
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (!rows[i].nested) c.add(rows[i].key);
    this.set({ checked: c, lastCheckedKey: key });
  }

  /** Ctrl+A: check all filtered rows; second press clears. */
  checkAll(): number {
    const top = this.state.rows.filter((r) => !r.nested);
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

/** Subscribe to a slice of the store. Selectors must return stable values. */
export function useTriage<T>(store: TriageStore, selector: (s: TriageState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.state));
}
