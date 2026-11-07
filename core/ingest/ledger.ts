/**
 * Per-model-set clash-id ledger (engine review P0-3: reappeared clashes were
 * reported as new because only the previous cached test was read).
 *
 * Pure and isomorphic: the server persists the JSON (e.g.
 * `.coordinator/state/clash-ledger/<modelSetId>.json`) and calls
 * `diffWithLedger` on every ingest. One entry per MC clash id records the
 * versions it was seen in and its diff state per version. pairKeys are kept so
 * a clash that comes back with a new MC id (document replaced) is still
 * recognised as a regression.
 *
 * Contract:
 *   let ledger = emptyLedger(modelSetId)              // or the persisted JSON
 *   const { diff, ledger: next } = diffWithLedger(ledger, { version: 41, clashes: prev }, { version: 42, clashes: next }, { nextElementKeys })
 *   persist(next)                                     // idempotent: re-running the same versions gives the same ledger
 *   tag diff.reappeared ids with `regresion` (runCoordination options.extraTags)
 */
import type { ClashDiff, DiffState } from "../types";
import { diffStateIndex, diffTestVersions, type DiffableClash, type DiffOptions } from "./diff";

export const LEDGER_SCHEMA = 1 as const;

export interface LedgerEntry {
  id: string;
  /** Last known pairKey (element-pair identity). */
  pairKey?: string;
  firstSeen: number;
  lastSeen: number;
  /** Model set versions in which the clash id was present (ascending). */
  seenIn: number[];
  /** Diff state per version (ascending by version). Absent versions before firstSeen have no state. */
  states: Array<{ version: number; state: DiffState }>;
  /** Earlier MC ids of the same clash, when matched by pairKey. */
  previousIds?: string[];
}

export interface ClashLedger {
  schema: typeof LEDGER_SCHEMA;
  modelSetId: string;
  /** Versions recorded (ascending). */
  versions: number[];
  entries: Record<string, LedgerEntry>;
}

export interface LedgerVersion<T extends DiffableClash = DiffableClash> {
  version: number;
  clashes: readonly T[];
}

export function emptyLedger(modelSetId: string): ClashLedger {
  return { schema: LEDGER_SCHEMA, modelSetId, versions: [], entries: {} };
}

/** Validate/upgrade a persisted ledger (throws on an unknown schema). */
export function parseLedger(json: unknown): ClashLedger {
  const l = json as Partial<ClashLedger> | null;
  if (!l || l.schema !== LEDGER_SCHEMA || typeof l.modelSetId !== "string" || !Array.isArray(l.versions) || typeof l.entries !== "object" || l.entries === null) {
    throw new Error("invalid clash ledger");
  }
  return l as ClashLedger;
}

/**
 * Clash ids AND pairKeys seen in any recorded version strictly older than
 * `beforeVersion`. This is `DiffOptions.history` for the diff prev -> next
 * with `beforeVersion = prev`.
 */
export function historyBefore(ledger: ClashLedger, beforeVersion: number): Set<string> {
  const out = new Set<string>();
  for (const e of Object.values(ledger.entries)) {
    if (!e.seenIn.some((v) => v < beforeVersion)) continue;
    out.add(e.id);
    if (e.pairKey) out.add(e.pairKey);
    for (const p of e.previousIds ?? []) out.add(p);
  }
  return out;
}

function clone(l: ClashLedger): ClashLedger {
  const entries: Record<string, LedgerEntry> = {};
  for (const [k, e] of Object.entries(l.entries)) {
    entries[k] = { ...e, seenIn: [...e.seenIn], states: e.states.map((s) => ({ ...s })), ...(e.previousIds ? { previousIds: [...e.previousIds] } : {}) };
  }
  return { schema: LEDGER_SCHEMA, modelSetId: l.modelSetId, versions: [...l.versions], entries };
}

/** Remove everything recorded for `version` (makes updates idempotent). */
function stripVersion(l: ClashLedger, version: number): void {
  if (!l.versions.includes(version)) return;
  l.versions = l.versions.filter((v) => v !== version);
  for (const [k, e] of Object.entries(l.entries)) {
    e.seenIn = e.seenIn.filter((v) => v !== version);
    e.states = e.states.filter((s) => s.version !== version);
    if (e.seenIn.length === 0) delete l.entries[k];
    else {
      e.firstSeen = e.seenIn[0]!;
      e.lastSeen = e.seenIn[e.seenIn.length - 1]!;
    }
  }
}

/**
 * Record one version. With `diff` (prev -> this version) the states come from
 * the diff (also resolved / element_deleted for prev clashes); without it a
 * clash is `new` when unseen before and `persisting` otherwise.
 * Returns a NEW ledger (pure).
 */
export function updateLedger(ledger: ClashLedger, current: LedgerVersion, diff?: ClashDiff): ClashLedger {
  const l = clone(ledger);
  stripVersion(l, current.version);
  const v = current.version;
  const idx = diff ? diffStateIndex(diff) : undefined;
  const renamed = new Map((diff?.matchedByPairKey ?? []).map((m) => [m.nextId, m.prevId]));
  for (const c of current.clashes) {
    let e = l.entries[c.id];
    if (!e) {
      const prevId = renamed.get(c.id);
      const prev = prevId ? l.entries[prevId] : undefined;
      e = {
        id: c.id,
        firstSeen: prev?.firstSeen ?? v,
        lastSeen: v,
        seenIn: [],
        states: [],
        ...(prev ? { previousIds: [...(prev.previousIds ?? []), prev.id] } : {}),
      };
      l.entries[c.id] = e;
    }
    if (c.pairKey) e.pairKey = c.pairKey;
    if (!e.seenIn.includes(v)) e.seenIn = [...e.seenIn, v].sort((x, y) => x - y);
    e.firstSeen = Math.min(e.firstSeen, e.seenIn[0]!);
    e.lastSeen = e.seenIn[e.seenIn.length - 1]!;
    const state: DiffState = idx?.get(c.id) ?? (e.seenIn.length > 1 || e.previousIds ? "persisting" : "new");
    e.states = [...e.states.filter((s) => s.version !== v), { version: v, state }].sort((x, y) => x.version - y.version);
  }
  if (diff) {
    for (const s of ["resolved", "element_deleted"] as const) {
      for (const id of diff[s]) {
        const e = l.entries[id];
        if (e) e.states = [...e.states.filter((x) => x.version !== v), { version: v, state: s }].sort((x, y) => x.version - y.version);
      }
    }
  }
  l.versions = [...l.versions, v].sort((x, y) => x - y);
  return l;
}

/**
 * Diff prev -> next using the ledger as history (reappeared detection), then
 * record both versions. `prev` is recorded first if the ledger does not have it
 * yet (first use on an existing model set).
 */
export function diffWithLedger<T extends DiffableClash>(
  ledger: ClashLedger,
  prev: LedgerVersion<T>,
  next: LedgerVersion<T>,
  options: Omit<DiffOptions, "history"> = {},
): { diff: ClashDiff; ledger: ClashLedger } {
  if (next.version <= prev.version) throw new Error(`next version ${next.version} must be newer than prev ${prev.version}`);
  let l = ledger.versions.includes(prev.version) ? ledger : updateLedger(ledger, prev);
  const diff = diffTestVersions(prev.clashes, next.clashes, { ...options, history: historyBefore(l, prev.version) });
  l = updateLedger(l, next, diff);
  return { diff, ledger: l };
}

/** Ids that reappeared in `version` according to the recorded states. */
export function reappearedIn(ledger: ClashLedger, version: number): string[] {
  return Object.values(ledger.entries)
    .filter((e) => e.states.some((s) => s.version === version && s.state === "reappeared"))
    .map((e) => e.id)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Ids present in `version` that were absent from the previous recorded
 * version but seen in an older one (independent of stored states).
 */
export function detectReappeared(ledger: ClashLedger, version: number): string[] {
  const vs = ledger.versions.filter((v) => v < version);
  const prev = vs[vs.length - 1];
  if (prev === undefined) return [];
  return Object.values(ledger.entries)
    .filter((e) => e.seenIn.includes(version) && !e.seenIn.includes(prev) && !(e.previousIds?.length && hasPrevAlias(ledger, e, prev)) && e.seenIn.some((v) => v < prev))
    .map((e) => e.id)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

function hasPrevAlias(ledger: ClashLedger, e: LedgerEntry, prev: number): boolean {
  return (e.previousIds ?? []).some((id) => ledger.entries[id]?.seenIn.includes(prev));
}
