/**
 * M1 cycle helpers (docs/PLAN-core-features-simplified.md §3): ACC state per item (X1),
 * scope guard (X6) and the "Qué cambió" change word (F1 support). Pure functions.
 */
import type { ClashLedger, LedgerAccState } from "../core/ingest/ledger";
import type { ClashDiff, ModelDocument, NormalizedClash } from "../core/types";
import type * as C from "./api/contract";
import type { ClashRecord } from "./store/types";

// ── X6 scope guard ──────────────────────────────────────────────────────────

/**
 * Minimum clashes of a document in the previous version for the mass-resolution check: below it a
 * normal cycle (e.g. 13 of 40 fixed) would trip the 30 % rule, so small documents are not checked.
 */
export const MASS_RESOLUTION_MIN = 50;
export const MASS_RESOLUTION_SHARE = 0.3;

export interface ScopeResult {
  changes: C.ScopeChange[];
  /** Previous-version document ids whose resolved clashes are out of scope. */
  affectedPrevDocs: Set<number>;
}

/**
 * Compare two versions of a model set. Documents are matched by lineage (MC renumbers
 * documentId between versions). `prelim` is a plain diff prev → next (for mass resolution).
 */
export function detectScopeChanges(
  prev: { viewName: string; documents: readonly ModelDocument[]; clashes: readonly NormalizedClash[] },
  next: { viewName: string; documents: readonly ModelDocument[] },
  prelim: Pick<ClashDiff, "resolved" | "element_deleted">,
): ScopeResult {
  const changes: C.ScopeChange[] = [];
  const affected = new Set<number>();
  const lin = (d: ModelDocument) => d.lineageUrn ?? d.urn;
  const prevLins = new Set(prev.documents.map(lin));
  const nextLins = new Set(next.documents.map(lin));
  const name = (d: ModelDocument) => `${d.displayName}${d.viewableName ? ` · ${d.viewableName}` : ""}`;
  const replacing = new Set<string>();
  for (const d of prev.documents) {
    if (nextLins.has(lin(d))) {
      const n = next.documents.find((x) => lin(x) === lin(d) && x.viewableName === d.viewableName) ?? next.documents.find((x) => lin(x) === lin(d))!;
      if ((n.viewableName ?? "") !== (d.viewableName ?? "") && !next.documents.some((x) => lin(x) === lin(d) && x.viewableName === d.viewableName)) {
        changes.push({ documentId: n.id, fileName: n.displayName, kind: "test_config_changed", message: `${d.displayName}: la vista usada cambió ("${d.viewableName ?? "?"}" → "${n.viewableName ?? "?"}"); sus resueltas no se cuentan.` });
        affected.add(d.id);
      }
      continue;
    }
    const repl = next.documents.find((x) => !prevLins.has(lin(x)) && x.displayName === d.displayName && !replacing.has(lin(x)));
    if (repl) {
      replacing.add(lin(repl));
      changes.push({ documentId: repl.id, fileName: repl.displayName, kind: "model_replaced", message: `Modelo reemplazado: ${name(repl)} (mismo nombre, otro linaje); sus interferencias anteriores no se cuentan como resueltas.` });
    } else {
      changes.push({ documentId: d.id, fileName: d.displayName, kind: "document_removed", message: `Documento quitado del conjunto: ${name(d)}; sus interferencias no se cuentan como resueltas.` });
    }
    affected.add(d.id);
  }
  for (const d of next.documents) {
    if (prevLins.has(lin(d)) || replacing.has(lin(d))) continue;
    changes.push({ documentId: d.id, fileName: d.displayName, kind: "document_added", message: `Documento agregado al conjunto: ${name(d)}; sus interferencias aparecen como nuevas.` });
  }
  if ((prev.viewName ?? "") !== (next.viewName ?? "")) {
    changes.push({ kind: "test_config_changed", message: `La prueba usa otra vista del conjunto ("${prev.viewName}" → "${next.viewName}"); las resueltas no se cuentan.` });
    for (const d of prev.documents) affected.add(d.id);
  }
  // Mass resolution: > 30 % of one document's clashes gone at once.
  const gone = new Set([...prelim.resolved, ...prelim.element_deleted]);
  const per = new Map<number, { total: number; gone: number }>();
  for (const c of prev.clashes) {
    // Clashes of documents already out of scope do not count towards another document.
    if (affected.has(c.left.documentId) || affected.has(c.right.documentId)) continue;
    for (const doc of new Set([c.left.documentId, c.right.documentId])) {
      const x = per.get(doc) ?? { total: 0, gone: 0 };
      x.total++;
      if (gone.has(c.id)) x.gone++;
      per.set(doc, x);
    }
  }
  for (const [docId, x] of [...per].sort((a, b) => a[0] - b[0])) {
    if (affected.has(docId) || x.total < MASS_RESOLUTION_MIN || x.gone / x.total <= MASS_RESOLUTION_SHARE) continue;
    const d = prev.documents.find((y) => y.id === docId);
    const nd = d ? next.documents.find((y) => lin(y) === lin(d) && y.viewableName === d.viewableName) ?? next.documents.find((y) => lin(y) === lin(d)) : undefined;
    changes.push({
      ...(nd ? { documentId: nd.id } : {}),
      ...(d ? { fileName: d.displayName } : {}),
      kind: "mass_resolution",
      message: `${Math.round((100 * x.gone) / x.total)} % de las interferencias de ${d ? name(d) : `doc ${docId}`} desaparecieron de una vez (${x.gone} de ${x.total}); se tratan como fuera de alcance hasta confirmar.`,
    });
    affected.add(docId);
  }
  return { changes, affectedPrevDocs: affected };
}

/** X6 predicate for core/ingest/diff.ts: a prev clash touching an affected document. */
export function outOfScopePredicate(affectedPrevDocs: ReadonlySet<number>): (c: { id: string }) => boolean {
  return (c) => {
    const n = c as unknown as NormalizedClash;
    return affectedPrevDocs.has(n.left?.documentId) || affectedPrevDocs.has(n.right?.documentId);
  };
}

// ── X1 ACC state per item ───────────────────────────────────────────────────

export type AccIndex = ReadonlyMap<string, LedgerAccState>;

export function accIndexOf(ledger: ClashLedger | undefined, clashIds: Iterable<string>): Map<string, LedgerAccState> {
  const out = new Map<string, LedgerAccState>();
  if (!ledger) return out;
  for (const id of clashIds) {
    const a = ledger.entries[id]?.acc;
    if (a && !a.resolved) out.set(id, a);
  }
  return out;
}

/** Resolved clash count per ACC group id (from the ledger). */
export function accResolvedByGroup(ledger: ClashLedger | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of Object.values(ledger?.entries ?? {})) if (e.acc?.resolved) out.set(e.acc.groupId, (out.get(e.acc.groupId) ?? 0) + 1);
  return out;
}

export function aggregateAcc(clashIds: readonly string[], idx: AccIndex, resolvedByGroup: ReadonlyMap<string, number>): C.AccState | undefined {
  const hit = clashIds.map((id) => idx.get(id)).filter((a): a is LedgerAccState => !!a);
  if (!hit.length) return undefined;
  const kinds = new Set(hit.map((a) => a.status));
  const groups = new Set(hit.map((a) => a.groupId));
  const reasons = new Set(hit.filter((a) => a.status === "closed").map((a) => a.reason ?? ""));
  return {
    status: kinds.size > 1 ? "mixed" : hit[0]!.status,
    issueIds: [...new Set(hit.map((a) => a.issueId).filter((x): x is string => !!x))].sort(),
    existing: hit.length,
    resolved: [...groups].reduce((n, g) => n + (resolvedByGroup.get(g) ?? 0), 0),
    ...(reasons.size === 1 && [...reasons][0] ? { closedReason: [...reasons][0] } : {}),
  };
}

/** Sum of item states (families). */
export function mergeAcc(items: ReadonlyArray<C.AccState | undefined>): C.AccState | undefined {
  const xs = items.filter((x): x is C.AccState => !!x);
  if (!xs.length) return undefined;
  const st = new Set(xs.map((x) => x.status));
  const reasons = new Set(xs.map((x) => x.closedReason).filter(Boolean));
  return {
    status: st.size > 1 || st.has("mixed") ? "mixed" : xs[0]!.status,
    issueIds: [...new Set(xs.flatMap((x) => x.issueIds))].sort(),
    existing: xs.reduce((n, x) => n + x.existing, 0),
    resolved: xs.reduce((n, x) => n + x.resolved, 0),
    ...(reasons.size === 1 ? { closedReason: [...reasons][0] } : {}),
  };
}

// ── "Qué cambió" ────────────────────────────────────────────────────────────

/** Penetration threshold for "changed" (plan F1: inherit when |Δpenetration| ≤ 10 mm). */
export const CHANGE_PENETRATION_MM = 10;

const types = (c: Pick<ClashRecord, "a" | "b">) => [c.a.type ?? c.a.category, c.b.type ?? c.b.category].sort().join("|");

/**
 * Change word per raw clash of the current version. Without a previous version
 * every clash is "new".
 */
export function clashChanges(
  current: readonly ClashRecord[],
  diff: ClashDiff | undefined,
  prevById: ReadonlyMap<string, Pick<ClashRecord, "penetrationMm" | "a" | "b">>,
): Map<string, C.ChangeKind> {
  const out = new Map<string, C.ChangeKind>();
  if (!diff) {
    for (const c of current) out.set(c.id, "new");
    return out;
  }
  const isNew = new Set(diff.new);
  const reapp = new Set(diff.reappeared);
  const renamed = new Map(diff.matchedByPairKey.map((m) => [m.nextId, m.prevId]));
  for (const c of current) {
    if (reapp.has(c.id)) out.set(c.id, "reappeared");
    else if (isNew.has(c.id)) out.set(c.id, "new");
    else {
      const p = prevById.get(renamed.get(c.id) ?? c.id);
      const knownTypes = !!p && !!(p.a.type || p.a.category);
      const changed = !!p && (Math.abs(p.penetrationMm - c.penetrationMm) > CHANGE_PENETRATION_MM || (knownTypes && types(p) !== types(c)));
      out.set(c.id, changed ? "changed" : "unchanged");
    }
  }
  return out;
}

/** One word per item: reappeared > new (all new) > changed (any new/changed) > unchanged. */
export function itemChange(clashIds: readonly string[], idx: ReadonlyMap<string, C.ChangeKind>): C.ChangeKind {
  const ks = clashIds.map((id) => idx.get(id) ?? "unchanged");
  if (ks.includes("reappeared")) return "reappeared";
  if (ks.length && ks.every((k) => k === "new")) return "new";
  if (ks.some((k) => k === "new" || k === "changed")) return "changed";
  return "unchanged";
}

export function emptyCounts(): C.ChangeCounts {
  return { new: 0, changed: 0, reappeared: 0, unchanged: 0 };
}
