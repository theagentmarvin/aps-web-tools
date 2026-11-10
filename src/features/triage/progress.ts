/**
 * Workspace progress (toolbar "N/M", "Enviar N a aprobación"): pure counting so it can be unit
 * tested. Group decisions live in the decision log; "Aprobar grupo" (family) decisions live in the
 * family store and decide every inherited instance (G2, coordinator journey 2026-11).
 */
import type { DecisionKind, TriageFamily } from "~/lib/api/types";

export interface ProgressDecision {
  kind: DecisionKind;
  batchId?: string;
}

export type ProgressFamily = Pick<TriageFamily, "id" | "decision" | "instances" | "pendingSend">;

export interface Progress {
  /** Groups (or clashes in manual mode) with a human decision: own or inherited from an approved family. */
  done: number;
  total: number;
  /** Decisions "Enviar a aprobación" would send: unbatched group decisions + families with work pending. */
  ready: number;
  breakdown: { accepted: number; corrected: number; rejected: number; postponed: number; family: number };
}

const approved = (f: ProgressFamily) => f.decision?.status === "approved";
/** Same rule as the server batch: an escalated family produces no ACC write, so it covers nothing. */
const sends = (f: ProgressFamily) => approved(f) && f.decision?.action !== "escalate";

export function computeProgress(input: {
  /** Groups, or clashes in manual mode. */
  ids: readonly string[];
  latest: ReadonlyMap<string, ProgressDecision>;
  families: Iterable<ProgressFamily>;
  manual?: boolean;
}): Progress {
  const breakdown = { accepted: 0, corrected: 0, rejected: 0, postponed: 0, family: 0 };
  const fams = input.manual ? [] : [...input.families];
  const inheritedApproved = new Set<string>();
  const covered = new Set<string>();
  for (const f of fams) {
    for (const i of f.instances) {
      if (i.inheritance.state !== "inherited") continue;
      if (approved(f)) inheritedApproved.add(i.groupId);
      if (sends(f)) covered.add(i.groupId);
    }
  }
  let ready = 0;
  for (const id of input.ids) {
    const d = input.latest.get(id);
    if (d) {
      if (d.kind === "accept") breakdown.accepted++;
      if (d.kind === "correct") breakdown.corrected++;
      if (d.kind === "reject") breakdown.rejected++;
      if (d.kind === "postpone") breakdown.postponed++;
      // Only accept / correct produce batch items; the family item replaces a covered group's own.
      if ((d.kind === "accept" || d.kind === "correct") && !d.batchId && !covered.has(id)) ready++;
      // The group's own decision wins (a postponed group is not done, even if a family covers it).
      continue;
    }
    if (inheritedApproved.has(id)) breakdown.family++;
  }
  for (const f of fams) if (sends(f) && (f.pendingSend ?? 0) > 0) ready++;
  const done = breakdown.accepted + breakdown.corrected + breakdown.rejected + breakdown.family;
  return { done, total: input.ids.length, ready, breakdown };
}
