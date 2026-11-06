/**
 * Coordinator web API — data shapes the UI depends on.
 *
 * Sources:
 *  - docs/ux/coordinator-ux-spec.md, every shape marked **[contract]**.
 *  - docs/ai/mcp-tool-contracts.ts (output types; naming follows the server
 *    where it differs from the UX spec, e.g. `Validity` values, ids `G-0042`).
 *
 * Conventions: ids are opaque strings; dates are ISO-8601 strings; distances
 * are millimetres where negative = penetration (MC convention, converted from
 * metres by the server).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Project-configurable discipline code from rules/discipline-matrix.yaml (EST, ARQ, CLI, SAN, ELE, INC…). */
export type DisciplineCode = string;

export interface Discipline {
  code: DisciplineCode;
  es: string;
  en: string;
}

/** MC numeric clash status 1..4, normalised. */
export type AccStatus = "active" | "reviewed" | "resolved" | "closed";

/** Validity taxonomy — same enum as mcp-tool-contracts.ts `Validity`. */
export type Validity = "real" | "false_positive" | "duplicate" | "tolerance" | "by_design" | "model_error" | "unknown";

/** UI priority P1..P4 (server maps from `Severity` critical/high/medium/low). */
export type Priority = 1 | 2 | 3 | 4;

export type ConfidenceBandName = "alta" | "media" | "baja";

/** Origin of a proposed field value (spec §4.2). */
export type FieldSource = "rule" | "llm" | "rule+llm" | "manual";

/** Change versus the previous test run (spec §4.3). */
export type Delta = "new" | "persisting" | "reappeared" | "modified" | "resolved";

export type IssueState = "draft" | "existing" | "none";

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

export interface UserInfo {
  id: string;
  name: string;
  initials: string;
}

/** [contract] GET /api/agent/status */
export interface AgentStatus {
  lastActivityAt: string | null;
  lastRunId: string | null;
  running: boolean;
  currentTask?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects, model sets, tests
// ─────────────────────────────────────────────────────────────────────────────

export interface Hub {
  id: string;
  name: string;
}

export interface ProjectSummary {
  /** ACC project GUID without the `b.` prefix (= MC container id). */
  id: string;
  name: string;
  hubId: string;
  hubName: string;
  modelSetCount: number;
  pendingDecisions: number;
}

/** [contract] ModelSetSummary (spec §2.4). */
export interface ModelSetSummary {
  id: string;
  projectId: string;
  name: string;
  latestVersion: number;
  /** Version the agent's proposals were generated on; undefined = not analysed. */
  analyzedVersion?: number;
  lastTest?: { id: string; completedOn: string; clashCount: number; modelSetVersion: number };
  groupsReviewed: number;
  groupsTotal: number;
  readyToApprove: number;
  /** Claude Code prompt to (re)analyse this model set, written by the server. */
  agentCommand: string;
}

/** [contract] TestRun.documents (spec §3.8). */
export interface TestDocument {
  /** Numeric clash document id (`ldid` / `rdid`). */
  documentId: number;
  /** Version URN (raw, not base64). ForgeViewer base64-encodes it. */
  urn: string;
  name: string;
  discipline?: DisciplineCode;
}

export interface TestRun {
  /** Test key, e.g. T-3f9a21c0. */
  id: string;
  modelSetId: string;
  modelSetVersion: number;
  completedOn: string;
  clashCount: number;
  /** True when the agent has proposals for this test. */
  analyzed: boolean;
  documents: TestDocument[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Clashes, groups, elements
// ─────────────────────────────────────────────────────────────────────────────

/** Element involved in a clash, pre-resolved by the server (no per-row viewer lookups). */
export interface ElementInfo {
  /** `E-<docIndex>:<dbId>` */
  ref: string;
  documentId: number;
  /** Viewer dbId inside that document's model. */
  dbId: number;
  externalId?: string;
  discipline: DisciplineCode;
  /** Display name, e.g. "Viga V-203". Untrusted model text, sanitised by the server. */
  name: string;
  category: string;
  family?: string;
  type?: string;
  system?: string;
  level?: string;
  sizeHint?: string;
  /** Source model file name. */
  modelName: string;
}

/** Summary of a decision on an earlier test (heredada). */
export interface PreviousDecision {
  testId: string;
  decidedAt: string;
  userName: string;
  kind: DecisionKind;
  reasonCode?: string;
}

/** [contract] Clash (spec §3.3, §4.3). */
export interface Clash {
  /** e.g. C-41299469560661 */
  id: string;
  groupId: string;
  status: AccStatus;
  /** mm, negative = penetration. */
  distanceMm: number;
  a: ElementInfo;
  b: ElementInfo;
  level?: string;
  delta: Delta;
  persistingSince?: string;
  persistingCount?: number;
  previousDistanceMm?: number;
  previousDecision?: PreviousDecision;
  /** Element no longer exists in the latest model set version. */
  elementMissing?: boolean;
}

/** [contract] ClashGroup (spec §3.3, §3.7). */
export interface ClashGroup {
  /** e.g. G-0042 */
  id: string;
  testId: string;
  strategy: "by_element" | "by_system_run" | "by_level_zone" | "by_root_cause";
  /** Spanish label generated by the engine/agent (content, not UI text). */
  title: string;
  clashIds: string[];
  /** Unordered discipline pair, A first. */
  pair: [DisciplineCode, DisciplineCode];
  location?: { level?: string; elevation?: number; grid?: string };
  /** Penetration depth range in mm (positive numbers, max ≥ min). */
  penetrationMaxMm: number;
  penetrationMinMm: number;
  deltaSummary: { new: number; persisting: number; reappeared: number; modified: number };
  /** Dominant delta used for the row badge. */
  delta: Delta;
  /** Dominant ACC status of member clashes. */
  accStatus: AccStatus;
  issue: IssueState;
  existingIssueId?: string;
  updatedAt: string;
  elementMissing?: boolean;
}

/** Property bag for the compare modal. Values are untrusted model text. */
export interface ElementProperties {
  ref: string;
  found: boolean;
  props: Record<string, string | number | boolean | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposals and decisions
// ─────────────────────────────────────────────────────────────────────────────

/** [contract] ProposalField — numeric confidence per field (spec §4.1). */
export interface ProposalField<T> {
  value: T;
  /** 0..1 */
  confidence: number;
  source: FieldSource;
  ruleIds?: string[];
}

export interface ProposedAction {
  createIssue: boolean;
  /** Status the clashes move to on apply; null = no status change. */
  setStatus: AccStatus | null;
}

export interface IssueDraft {
  title: string;
  description: string;
  ownerDiscipline: DisciplineCode;
  /** Role or company suggested by the agent; the human picks the ACC assignee. */
  assigneeRole?: string;
  assigneeId?: string;
  dueDate: string;
  issueType?: string;
  issueSubtype?: string;
  location?: string;
  includeView: boolean;
  linkClashIds: string[];
  /** Camera pinned in triage ("Fijar vista actual"). */
  pinnedView?: unknown;
}

/** [contract] Proposal (spec §4.2). */
export interface Proposal {
  /** e.g. P-20261106-0007 */
  id: string;
  targetType: "group" | "clash";
  targetId: string;
  testId: string;
  runId: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  fields: {
    validity: ProposalField<Validity>;
    priority: ProposalField<Priority>;
    owner: ProposalField<DisciplineCode>;
    action: ProposalField<ProposedAction>;
  };
  /** Spanish rationale written by the agent. */
  rationale: string;
  signals: { label: string; value: string }[];
  ruleIds: string[];
  /** ~5 % of Alta proposals flagged for random review (spec §4.5). */
  spotCheck: boolean;
  issueDraft?: IssueDraft;
  /** Pre-filled from a human decision on an earlier test. */
  inherited?: PreviousDecision;
}

export type DecisionKind = "accept" | "correct" | "reject" | "postpone" | "note" | "undo";
export type DecisionField = "validity" | "priority" | "owner" | "action" | "group" | "issueDraft";

export interface DecisionChange {
  field: DecisionField;
  aiValue: unknown;
  humanValue: unknown;
  aiConfidence?: number;
  aiSource?: string;
  ruleIds?: string[];
}

/**
 * [contract] Decision — POST /api/triage/decisions, idempotent by `id`.
 * Extension to the UX spec: kind `undo` with `undoes` = id of the decision it
 * reverts (the store keeps an append-only log).
 */
export interface Decision {
  id: string;
  proposalId: string;
  targetType: "group" | "clash";
  targetId: string;
  testId: string;
  modelSetId: string;
  projectId: string;
  kind: DecisionKind;
  changes: DecisionChange[];
  reasonCode?: ReasonCode;
  note?: string;
  suggestRule?: boolean;
  viewedInViewerMs: number;
  decidedAt: string;
  userId: string;
  userName: string;
  bulk?: { size: number };
  undoes?: string;
  /** Set by the server once the decision is included in a batch. */
  batchId?: string;
}

export const REASON_CODES = [
  "R01", "R02", "R03", "R04", "R05", "R06", "R07",
  "R08", "R09", "R10", "R11", "R12", "R13", "R99",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** UI decision state of a row (spec §3.3). */
export type DecisionState = "pending" | "accepted" | "corrected" | "rejected" | "postponed" | "inherited";

/** One request for the whole triage workspace (spec §9.2). */
export interface TriagePayload {
  project: ProjectSummary;
  modelSet: ModelSetSummary;
  test: TestRun;
  tests: TestRun[];
  disciplines: Discipline[];
  groups: ClashGroup[];
  clashes: Clash[];
  proposals: Proposal[];
  decisions: Decision[];
  /** Opaque cursor for GET …/changes. */
  changesCursor: string;
}

export interface TriageChanges {
  cursor: string;
  proposals: Proposal[];
}

export interface GroupQuery {
  testId: string;
  filter?: {
    pair?: string[];
    priority?: Priority[];
    validity?: Validity[];
    level?: string[];
    accStatus?: AccStatus[];
    delta?: Delta[];
  };
  sort?: "priority" | "confidence_asc" | "count_desc" | "distance" | "level";
  limit?: number;
  cursor?: string;
}

export interface GroupDetail {
  group: ClashGroup;
  proposal?: Proposal;
  clashes: Clash[];
  decisions: Decision[];
  history: HistoryEntry[];
}

export interface HistoryEntry {
  at: string;
  kind: "agent" | "decision" | "note" | "previous" | "acc";
  text: string;
  actor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batches (approval queue)
// ─────────────────────────────────────────────────────────────────────────────

export type BatchState = "draft" | "ready" | "approved" | "applied" | "partial" | "discarded";

export type BatchOperation = "clash.setStatus" | "issue.create" | "issue.update" | "issue.comment";

/** [contract] BatchItem (spec §5.1). */
export interface BatchItem {
  id: string;
  decisionIds: string[];
  targetType: "clash" | "group" | "issue";
  targetIds: string[];
  /** Display label of the object (clash id or group title). */
  label: string;
  groupId?: string;
  operation: BatchOperation;
  /** Field-level diff: one entry per changed field (git-like). */
  fields: { field: string; accCurrent: unknown; accNew: unknown }[];
  accCurrent?: unknown;
  accNew: unknown;
  origin: "ai_accepted" | "ai_corrected" | "manual";
  reasonCode?: ReasonCode;
  reviewer: string;
  aiConfidence?: number;
  lowConfidence?: boolean;
  viewedInViewer?: boolean;
  excluded?: boolean;
  conflict?: { reason: string; accValueNow: unknown };
  /** Present for issue.create / issue.update. */
  issue?: IssueDraft & { priorityLabel?: string };
}

/** [contract] Batch (spec §5.1). */
export interface Batch {
  id: string;
  projectId: string;
  projectName: string;
  modelSetId: string;
  modelSetName: string;
  testId: string;
  testDate: string;
  modelSetVersion: number;
  latestVersion: number;
  state: BatchState;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  appliedAt?: string;
  stale: boolean;
  counts: { issuesCreate: number; statusChanges: number; assignments: number; comments: number };
  origin: { accepted: number; corrected: number; manual: number };
  review: { humanReviewedPct: number; lowConfidence: number; lowConfidenceViewed: number };
  statusTransitions: { from: AccStatus; to: AccStatus; count: number }[];
  issuesByDiscipline: Record<DisciplineCode, number>;
  lastPreflightAt?: string;
  items: BatchItem[];
}

export type BatchSummary = Omit<Batch, "items">;

export interface PreflightResult {
  at: string;
  conflicts: number;
  batch: Batch;
}

export interface ApproveRequest {
  confirmWord: string;
  staleOverride?: boolean;
  note?: string;
  /** Item ids excluded by the reviewer (return to triage as pending approval). */
  excludedItemIds: string[];
}

export interface ApplyStatus {
  batchId: string;
  state: BatchState;
  issues: { done: number; total: number };
  statuses: { done: number; total: number };
  log: { at: string; text: string; ok: boolean }[];
  failures: { itemId: string; label: string; message: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning, rules, reports, audit
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors mcp-tool-contracts RecordFeedbackInput, as sent from the UI. */
export interface FeedbackInput {
  target: { proposalId: string } | { groupId: string; testId?: string };
  verdict: "correct" | "incorrect" | "partially_correct";
  coordinatorStatement: string;
  generalizable: "yes" | "no" | "unsure";
  scope: "this_group" | "project" | "company";
}

export type RuleEffect = "validity" | "priority" | "owner" | "grouping";
export type RuleState = "active" | "draft" | "disabled";

export interface RuleSummary {
  id: string;
  name: string;
  scope: string;
  effect: RuleEffect;
  state: RuleState;
  hits7d: number;
  /** Share of this rule's proposals accepted unchanged (0..1); null = no data. */
  acceptance: number | null;
  corrections: number;
  updatedAt: string;
  file: string;
}

export interface RuleDetail extends RuleSummary {
  description: string;
  conditions: string[];
  yaml: string;
  recentHits: { groupId: string; projectId: string; modelSetId: string; title: string; decision: DecisionState; at: string }[];
  reasonDistribution: { code: ReasonCode; count: number }[];
}

/** A rule-change proposal drafted by the agent (kind rule_change). */
export interface RuleSuggestion {
  id: string;
  title: string;
  count: number;
  reasonCode: ReasonCode;
  pair: string;
  summary: string;
  patch: string;
  affected: number;
  evaluation?: { baselineMacroF1: number; candidateMacroF1: number; unsafeClosureRate: number };
  state: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface CorrectionRow {
  decisionId: string;
  at: string;
  userName: string;
  targetId: string;
  targetLabel: string;
  field: DecisionField | "reject";
  aiValue: string;
  humanValue: string;
  reasonCode?: ReasonCode;
  note?: string;
  ruleIds: string[];
  confidence?: number;
}

export interface CalibrationBand {
  band: ConfidenceBandName;
  proposals: number;
  acceptedUnchanged: number;
}

/** [contract] GET /api/learning/calibration */
export interface Calibration {
  thresholds: { high: number; medium: number };
  minDecisions: number;
  bands: CalibrationBand[];
  byField: { field: "validity" | "priority" | "owner"; source: "rule" | "llm"; bands: CalibrationBand[] }[];
  spotCheck: { reviewed: number; corrected: number };
}

export interface ReportScope {
  projectId?: string;
  modelSetId?: string;
  from?: string;
  to?: string;
}

export interface ReportData {
  scope: ReportScope;
  kpis: {
    activeClashes: number;
    activeClashesPrev: number | null;
    groups: number;
    rawClashes: number;
    groupsReviewed: number;
    issuesCreated: number;
    issuesClosed: number;
    aiAccepted: number;
    aiCorrected: number;
    aiRejected: number;
    rawClashesReviewed: number;
    actualReviewSeconds: number;
  };
  burndown: { label: string; active: number; reviewed: number; resolved: number; closed: number; valid: number }[];
  disciplines: DisciplineCode[];
  /** matrix[a][b] = active valid clashes (symmetric). */
  matrix: Record<DisciplineCode, Record<DisciplineCode, number>>;
  byStatusPair: { pair: string; active: number; reviewed: number; resolved: number; closed: number }[];
  newVsResolved: { label: string; new: number; resolved: number }[];
  reasons: { code: ReasonCode; count: number }[];
  calibration: CalibrationBand[];
  p1Aging: { lt1w: number; w1to2: number; w2to4: number; gt4w: number };
}

export type AuditActorType = "agent" | "user" | "server";

/** [contract] AuditEvent (spec §5.6). */
export interface AuditEvent {
  id: string;
  at: string;
  actor: { type: AuditActorType; id: string; name: string };
  action: string;
  projectId: string;
  modelSetId?: string;
  testId?: string;
  batchId?: string;
  targetIds: string[];
  details: Record<string, string | number | boolean | null>;
  accResponseId?: string;
}

export interface AuditQuery {
  project?: string;
  user?: string;
  action?: string;
  from?: string;
  to?: string;
  batch?: string;
  limit?: number;
  cursor?: string;
}

export interface HomeSummary {
  user: UserInfo;
  queue: { projectId: string; projectName: string; modelSetId: string; modelSetName: string; pending: number }[];
  batches: BatchSummary[];
  activity: { at: string; text: string }[];
  kpis: ReportData["kpis"];
}

export interface Assignee {
  id: string;
  name: string;
  kind: "user" | "role" | "company";
}
