/**
 * Enum → i18n key maps, so components never hardcode user-facing labels.
 */
import type { TKey } from "~/i18n";
import type { AccStatus, BatchOperation, BatchState, DecisionField, DecisionState, Delta, Priority, Validity } from "./api/types";

export const VALIDITY_KEY: Record<Validity, TKey> = {
  real: "validity.valid",
  false_positive: "validity.falsePositive",
  tolerance: "validity.tolerable",
  duplicate: "validity.duplicate",
  unknown: "validity.toConfirm",
  by_design: "validity.byDesign",
  model_error: "validity.modelError",
};

/** Order of the `v` validity menu (digits 1..7). */
export const VALIDITY_ORDER: Validity[] = ["real", "false_positive", "tolerance", "duplicate", "unknown", "by_design", "model_error"];

export const STATUS_KEY: Record<AccStatus, TKey> = {
  active: "accStatus.active",
  reviewed: "accStatus.reviewed",
  resolved: "accStatus.resolved",
  closed: "accStatus.closed",
};

export const DECISION_KEY: Record<DecisionState, TKey> = {
  pending: "decision.pending",
  accepted: "decision.accepted",
  corrected: "decision.corrected",
  rejected: "decision.rejected",
  postponed: "decision.postponed",
  inherited: "decision.inherited",
};

export const DELTA_KEY: Record<Delta, TKey> = {
  new: "delta.new",
  persisting: "delta.persisting",
  reappeared: "delta.reappeared",
  modified: "delta.modified",
  resolved: "delta.resolved",
};

export const PRIORITY_KEY: Record<Priority, TKey> = { 1: "priority.p1", 2: "priority.p2", 3: "priority.p3", 4: "priority.p4" };
export const PRIORITY_SHORT_KEY: Record<Priority, TKey> = { 1: "priority.short1", 2: "priority.short2", 3: "priority.short3", 4: "priority.short4" };

export const FIELD_KEY: Record<DecisionField, TKey> = {
  validity: "detail.field.validity",
  priority: "detail.field.priority",
  owner: "detail.field.owner",
  action: "detail.field.action",
  group: "detail.field.group",
  issueDraft: "detail.issueDraft",
};

export const BATCH_STATE_KEY: Record<BatchState, TKey> = {
  draft: "approvals.state.draft",
  ready: "approvals.state.ready",
  approved: "approvals.state.approved",
  applied: "approvals.state.applied",
  partial: "approvals.state.partial",
  discarded: "approvals.state.discarded",
};

export const OPERATION_KEY: Record<BatchOperation, TKey> = {
  "clash.setStatus": "batch.op.clashSetStatus",
  "issue.create": "batch.op.issueCreate",
  "issue.update": "batch.op.issueUpdate",
  "issue.comment": "batch.op.issueComment",
};
