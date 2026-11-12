/**
 * Mock M1 data (docs/PLAN-core-features-simplified.md): change word per group,
 * ACC state of assigned/closed groups (X1), scope changes (X6) and the
 * "Qué cambió" summary. Deterministic, derived from the generated test.
 */
import type { AccState, ChangeCounts, ChangeKind, ChangeSummary, Clash, FamilyGroup, ScopeChange, TestRun, TriageFamily } from "../types";
import type { AccSyncSummary } from "../types";

function changeOf(g: FamilyGroup): ChangeKind {
  const ds = g.deltaSummary;
  if (ds.reappeared > 0) return "reappeared";
  if (ds.new > 0 && ds.persisting === 0 && ds.modified === 0) return "new";
  if (ds.new + ds.modified > 0) return "changed";
  return "unchanged";
}

const zero = (): ChangeCounts => ({ new: 0, changed: 0, reappeared: 0, unchanged: 0 });

export interface M1Data {
  changeSummary?: ChangeSummary;
  scopeChanges: ScopeChange[];
  accSync: AccSyncSummary | null;
}

/** Mutates the groups (change, acc) and returns the payload-level M1 fields. */
export function applyM1(test: TestRun, groups: FamilyGroup[], clashes: Clash[], firstTest: boolean): M1Data {
  const byGroup = new Map<string, Clash[]>();
  for (const c of clashes) byGroup.set(c.groupId, [...(byGroup.get(c.groupId) ?? []), c]);
  let assigned = 0;
  let closed = 0;
  const issues = new Set<string>();
  groups.forEach((g, i) => {
    g.change = firstTest ? "new" : changeOf(g);
    // Make sure the lens has regressions to sort first.
    if (!firstTest && g.change === "unchanged" && i % 23 === 7) g.change = "reappeared";
    if (g.existingIssueId || g.issue === "existing") {
      const id = g.existingIssueId ?? `ISS-${String(1200 + i)}`;
      const resolved = Math.min(g.clashIds.length - 1, i % 4);
      g.acc = { status: "assigned", issueIds: [id], existing: g.clashIds.length - Math.max(0, resolved), resolved: Math.max(0, resolved) };
      assigned++;
      issues.add(id);
    } else if (!firstTest && g.validity === "real" && i % 29 === 3) {
      // D8 vs invariant 1: closed in ACC while the engine says real → shown once for confirmation.
      g.acc = { status: "closed", issueIds: [], existing: g.clashIds.length, resolved: 0, closedReason: "VALID_INTERFACE" };
      g.closedInAccWhileReal = true;
      closed++;
    } else if (!firstTest && g.validity === "false_positive" && i % 5 === 0) {
      g.acc = { status: "closed", issueIds: [], existing: g.clashIds.length, resolved: 0, closedReason: "NOT_AN_ISSUE" };
      closed++;
    }
  });
  if (firstTest) return { scopeChanges: [], accSync: null };

  const groupCounts = zero();
  for (const g of groups) groupCounts[g.change ?? "unchanged"]++;
  const clashCounts = zero();
  for (const c of clashes) clashCounts[c.delta === "new" ? "new" : c.delta === "modified" ? "changed" : c.delta === "reappeared" ? "reappeared" : "unchanged"]++;
  const prev = test.modelSetVersion - 1;
  const lastDoc = test.documents[test.documents.length - 1];
  const addedClashes = clashes.filter((c) => c.a.documentId === lastDoc?.documentId || c.b.documentId === lastDoc?.documentId).length;
  return {
    changeSummary: { previousVersion: prev, groups: groupCounts, clashes: clashCounts, resolved: test.delta?.resolved ?? 0, outOfScope: 14 },
    scopeChanges: lastDoc
      ? [
          { documentId: lastDoc.documentId, fileName: lastDoc.name, kind: "document_added", message: `Documento agregado en v${test.modelSetVersion}: ${addedClashes} interferencias nuevas vienen de él.` },
          { fileName: "ARQ_TorreB_old.rvt", kind: "document_removed", message: `Documento quitado del conjunto: 14 interferencias quedan fuera de alcance (no se cuentan como resueltas).` },
        ]
      : [],
    accSync: { at: new Date(Date.now() - 2 * 3600_000).toISOString(), assignedGroups: assigned, closedGroups: closed, issues: issues.size },
  };
}

/** changeCounts and aggregated ACC state of a family from its groups. */
export function familyM1(f: TriageFamily, groups: Map<string, FamilyGroup>): void {
  const counts = zero();
  let acc: AccState | undefined;
  for (const id of f.groupIds) {
    const g = groups.get(id);
    if (!g) continue;
    counts[g.change ?? "unchanged"]++;
    if (g.acc) {
      if (!acc) acc = { status: g.acc.status, issueIds: [], existing: 0, resolved: 0, closedReason: g.acc.closedReason };
      else if (acc.status !== g.acc.status) acc.status = "mixed";
      acc.issueIds = [...new Set([...acc.issueIds, ...g.acc.issueIds])];
      acc.existing += g.acc.existing;
      acc.resolved += g.acc.resolved;
    }
  }
  f.changeCounts = counts;
  f.acc = acc;
  for (const inst of f.instances) {
    const g = groups.get(inst.groupId);
    inst.change = g?.change;
    inst.acc = g?.acc;
  }
}
