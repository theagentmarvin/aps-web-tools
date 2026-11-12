/**
 * Proposal and batch lifecycles.
 *
 * Proposal: draft → pending_review → approved | rejected | withdrawn;
 *           approved → applied | failed; failed → applied (retry) | approved (re-approval);
 *           approved → pending_review (batch returned to review before apply).
 * Batch:    draft → ready → approved → applied | partial; ready → draft (returned);
 *           draft|ready → discarded; partial → applied (retry of failed items).
 */
import { CoordError } from "../util";
import type { BatchState, ProposalState } from "./types";

const PROPOSAL_TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  draft: ["pending_review", "withdrawn"],
  pending_review: ["approved", "rejected", "withdrawn"],
  approved: ["applied", "failed", "pending_review"],
  rejected: [],
  withdrawn: [],
  applied: [],
  failed: ["applied", "approved"],
};

const BATCH_TRANSITIONS: Record<BatchState, readonly BatchState[]> = {
  draft: ["ready", "discarded"],
  ready: ["approved", "draft", "discarded"],
  approved: ["applied", "partial", "draft"],
  partial: ["applied", "partial"],
  applied: [],
  discarded: [],
};

export function canTransitionProposal(from: ProposalState, to: ProposalState): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

export function assertProposalTransition(id: string, from: ProposalState, to: ProposalState): void {
  if (!canTransitionProposal(from, to)) {
    throw new CoordError("invalid_state", `La propuesta ${id} no puede pasar de ${from} a ${to}`);
  }
}

export function canTransitionBatch(from: BatchState, to: BatchState): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

export function assertBatchTransition(id: string, from: BatchState, to: BatchState): void {
  if (!canTransitionBatch(from, to)) throw new CoordError("invalid_state", `El lote ${id} no puede pasar de ${from} a ${to}`);
}

/** Terminal proposal states. */
export function isFinalProposalState(s: ProposalState): boolean {
  return PROPOSAL_TRANSITIONS[s].length === 0;
}
