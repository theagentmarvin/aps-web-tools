/**
 * HTTP API contract for the web UI: every endpoint under `/api/coord/*` with
 * its request and response types. TYPES ONLY (no runtime code, no Node
 * imports), so `src/` can `import type` from here.
 *
 * Shapes follow docs/ux/coordinator-ux-spec.md (**[contract]** items) and the
 * UI coder's `src/lib/api/types.ts`, with these binding differences:
 * - Vocabulary is the engine's (orchestrator ruling): Validity = real |
 *   false_positive | tolerated | needs_info; duplicates are false_positive with
 *   `nature: "duplicate"`. Group ids are `G-<10 hex>`; test ids are test keys `T-xxxxxxxx`.
 * - Human-only endpoints (approve, apply, decisions, corrections, notes,
 *   auth) require the `X-Coord-CSRF` header (token from GET /api/coord/csrf)
 *   and a same-origin request (Origin/Referer = the server's own origin).
 *
 * Errors: `{ error: { code, message, hint? } }` with HTTP 400/401/403/404/409/429/500.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export type DisciplineCode = string;
export interface Discipline { code: DisciplineCode; es: string; en: string }
export type AccStatus = "active" | "reviewed" | "resolved" | "closed";
export type Validity = "real" | "false_positive" | "tolerated" | "needs_info";
export type Nature = "hard" | "clearance" | "duplicate" | "workflow";
export type Severity = "critical" | "high" | "medium" | "low" | "none";
export type Priority = 1 | 2 | 3 | 4;
export type ConfidenceBandName = "alta" | "media" | "baja";
export type FieldSource = "rule" | "llm" | "rule+llm" | "manual";
export type Delta = "new" | "persisting" | "reappeared" | "modified" | "resolved";
export type IssueState = "draft" | "existing" | "none";

export interface Page<T> { items: T[]; total: number; nextCursor?: string }
export interface ApiErrorBody { error: { code: string; message: string; hint?: string } }

export interface UserInfo { id: string; name: string; initials: string }

export interface AuthStatus {
  loggedIn: boolean;
  dataSource: "live" | "fixtures";
  user?: UserInfo;
  expiresAt?: number;
  scopes?: string[];
  /** The stored session predates a now-required scope (e.g. user-profile:read): sign in again. */
  needsReauth?: boolean;
  /** True while a server-side PKCE login is waiting for the browser callback. */
  loginInProgress: boolean;
}
/** `returnTo`: app path to return to after the Autodesk sign-in (same-site relative path). */
export interface LoginStartRequest { returnTo?: string }
export interface LoginStartResponse { authorizeUrl?: string; alreadyLoggedIn: boolean }

export interface AgentStatus { lastActivityAt: string | null; lastRunId: string | null; running: boolean; currentTask?: string }

export interface SessionInfo {
  autonomy: { level: number; effectiveLevel: number; source: string };
  dataSource: "live" | "fixtures";
  active?: { projectId: string; projectName: string; modelSetId?: string; modelSetName?: string; testKey?: string };
  pending: { proposals: number; approvedNotApplied: number; feedbackSinceLastCuration: number };
  versions: { server: string; ruleset: string; engine: string };
  confidenceBands: { high: number; medium: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects, model sets, tests
// ─────────────────────────────────────────────────────────────────────────────

export interface Hub { id: string; name: string }
export interface ProjectSummary { id: string; name: string; hubId: string; hubName: string; modelSetCount: number; pendingDecisions: number }
export interface ModelSetSummary {
  id: string;
  projectId: string;
  name: string;
  latestVersion: number;
  analyzedVersion?: number;
  lastTest?: { id: string; completedOn: string; clashCount: number; modelSetVersion: number };
  groupsReviewed: number;
  groupsTotal: number;
  readyToApprove: number;
  agentCommand: string;
}
export interface TestDocument { documentId: number; urn: string; name: string; discipline?: DisciplineCode }
/** GET /projects/:p/model-sets/:m/clash-grid?test=<testKey|accTestId> */
export interface ClashGridDocument {
  documentId: number;
  lineageUrn: string;
  fileName: string;
  viewName: string;
  /** Discipline code; "SIN" = Sin asignar. */
  discipline: string;
  disciplineSource: "assignment" | "rule" | "matrix" | "elements" | "unassigned";
  /** Share (0..1) of the dominant element discipline when computed. */
  disciplineShare?: number;
  /** Rule that decided it (source = rule). */
  ruleId?: string;
  /** Token to pre-fill "aplicar a archivos que contengan …" (ISO role code or first word). */
  suggestedToken?: string;
  /** ACC folder of the file; filled when two documents share a file name (disambiguation). */
  folderPath?: string;
  clashes: number;
  groups: number;
}
export interface ClashGridCell {
  /** Unordered pair: a <= b; a === b is a model clashing with itself. */
  a: number;
  b: number;
  clashes: number;
  /** Distinct groups (0 until classified). */
  groups: number;
  /** Clashes with validity real (0 until classified). */
  real: number;
  /** Clashes in P1 groups (0 until classified). */
  p1: number;
  /** Clashes in groups that need review (0 until classified). */
  needsReview: number;
  /** New or reappeared since the previous cached version (ledger). */
  newSinceLast: number;
}
export interface ClashGrid {
  testKey?: string;
  accTestId: string;
  modelSetVersion: number;
  state: "none" | "counts" | "classified";
  documents: ClashGridDocument[];
  cells: ClashGridCell[];
}
/** GET /projects/:p/model-sets/:m/views */
export interface ModelSetView { name: string; documents: string[] }
export interface DisciplineRule {
  id: string;
  match: "contains" | "startsWith" | "regex";
  value: string;
  field: "fileName" | "folder" | "viewName";
  discipline: string;
  createdBy: string;
  createdAt: string;
}
/** GET /projects/:p/disciplines */
export interface DisciplineConfig {
  version: number;
  /** lineageUrn → code. */
  assignments: Record<string, string>;
  /** Ordered; first match wins. */
  rules: DisciplineRule[];
  codes: Array<{ code: string; label: string }>;
  fileNameDetection: "off" | "matrix";
  /** Agent suggestions waiting for a human decision. */
  pendingProposals: Array<{ id: string; summary: string; rationale: string; createdAt: string; payload: Record<string, unknown> }>;
}
/** POST /projects/:p/disciplines/preview */
export interface DisciplinePreview {
  rules: Array<{ index: number; id?: string; matches: Array<{ lineageUrn: string; fileName: string; viewName: string; modelSetId: string }>; effective: number }>;
}
/** GET /ingest-jobs/:jobId */
export interface IngestJob {
  jobId: string;
  phase: "downloading" | "clash_grid_ready" | "properties" | "classifying" | "done" | "failed";
  progress: number;
  message: string;
  testKey?: string;
  accTestId: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  timings: Record<string, number>;
}

export interface TestRun {
  /** Test key T-xxxxxxxx (cached tests). For not-yet-ingested tests: the ACC test id and `cached: false`. */
  id: string;
  accTestId: string;
  cached: boolean;
  modelSetId: string;
  modelSetVersion: number;
  completedOn: string;
  clashCount: number;
  analyzed: boolean;
  documents: TestDocument[];
  documentCount?: number;
  state: "none" | "counts" | "classified";
  /** vs the previous cached version (ledger): new includes reappeared, resolved includes element-deleted. */
  delta?: { new: number; resolved: number; persisting: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clashes, groups, elements
// ─────────────────────────────────────────────────────────────────────────────

export interface ElementInfo {
  ref: string;
  documentId: number;
  dbId: number;
  externalId?: string;
  discipline: DisciplineCode;
  /** Untrusted model text, sanitised. */
  name: string;
  category: string;
  family?: string;
  type?: string;
  system?: string;
  level?: string;
  sizeHint?: string;
  modelName: string;
}

export interface PreviousDecision { testId: string; decidedAt: string; userName: string; kind: DecisionKind; reasonCode?: string }

export interface Clash {
  id: string;
  groupId: string;
  status: AccStatus;
  distanceMm: number;
  a: ElementInfo;
  b: ElementInfo;
  level?: string;
  validity: Validity;
  nature: Nature;
  delta: Delta;
  persistingSince?: string;
  persistingCount?: number;
  previousDistanceMm?: number;
  previousDecision?: PreviousDecision;
  elementMissing?: boolean;
}

export interface ClashGroup {
  id: string;
  testId: string;
  strategy: "by_element" | "by_system_run" | "by_level_zone" | "by_root_cause";
  engineStrategy: string;
  /** Engine label; may contain model-derived names (render as text, never HTML). */
  title: string;
  clashIds: string[];
  pair: [DisciplineCode, DisciplineCode];
  location?: { level?: string; elevation?: number; grid?: string };
  penetrationMaxMm: number;
  penetrationMinMm: number;
  deltaSummary: { new: number; persisting: number; reappeared: number; modified: number };
  delta: Delta;
  accStatus: AccStatus;
  issue: IssueState;
  existingIssueId?: string;
  updatedAt: string;
  elementMissing?: boolean;
  validity: Validity;
  nature: Nature;
  severity: Severity;
  priority: Priority;
  confidence: number;
  reviewState: "auto_ok" | "needs_review" | "proposed" | "decided";
  /** Dominant engine rule of the group (most member clashes). */
  ruleId: string | null;
  ruleIds: string[];
  /** Solution family (one group = one family). Absent on classifications made before families existed. */
  familyId?: string;
  problemType?: ProblemTypeCode;
  /** Human-readable signature (debug + tooltip; contains model type names). */
  signature?: string;
  /** Unique physical conflicts (after G0 by element pair); raw ids stay in clashIds. */
  uniqueClashCount?: number;
  /** "Entretecho P1 (viga nivel 201)". */
  hostLevelLabel?: string;
  inheritance?: InstanceInheritance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Solution families (docs/domain/solution-families-proposal.md §5.3)
// ─────────────────────────────────────────────────────────────────────────────

export type ProblemTypeCode = "PT00" | "PT01" | "PT02" | "PT03" | "PT04" | "PT05" | "PT06" | "PT07" | "PT08" | "PT09" | "PT10" | "PT11" | "PT12" | "PT13" | "PT14";
export type FamilyAction = "create_issue" | "close" | "mark_reviewed" | "hygiene_issue" | "escalate";
export type FamilyTag = "tipico" | "validez_mixta" | "orientacion_por_confirmar" | "sin_sistema";
export interface ProblemTypeInfo { code: ProblemTypeCode; nameEs: string; responsibility: string; options: string[] }

export interface FamilyDecisionFields {
  validity: Validity;
  action: FamilyAction;
  responsibleDiscipline: string;
  secondaryDiscipline?: string;
  solutionOption?: string;
  typicalDetail?: { name: string; note?: string };
  issueMode: "family" | "per_instance";
}
/** Versioned human decision (§4.1). */
export interface FamilyDecision extends FamilyDecisionFields {
  familyId: string;
  version: number;
  status: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
  /** Instances the coordinator opened (≥1; ≥3 when the family has > 50 unique conflicts). */
  spotChecked: string[];
  /** Instances present when this version was decided. */
  coveredGroupIds: string[];
  testKey: string;
  note?: string;
  acknowledgedValidityChanges?: string[];
}
export interface FamilyException {
  groupId: string;
  fields: Partial<FamilyDecisionFields>;
  reason: string;
  by: string;
  at: string;
  decisionVersion?: number;
}
export interface InstanceInheritance {
  state: "none" | "inherited" | "inherited_pending" | "exception" | "detached";
  decisionVersion?: number;
  exceptionReason?: string;
  /** Exception made under an older decision version ("familia cambió"). */
  familyChanged?: boolean;
}
/** Instance = today's group (group ∩ family). */
export interface FamilyInstance {
  groupId: string;
  title: string;
  levels: string[];
  hostLevelLabel?: string;
  validity: Validity;
  band: Priority;
  uniqueClashCount: number;
  rawClashCount: number;
  delta: Delta;
  inheritance: InstanceInheritance;
}
export interface TriageFamily {
  /** F-xxxxxxxxxx (merge aliases resolved server-side). */
  id: string;
  signature: string;
  parts: { problemType: ProblemTypeCode; hostClass: string; hostType?: string; moverClass: string; systemClass: string; sizeBand: string; relation: string };
  /** Spanish, generated. */
  title: string;
  problemTypeName: string;
  bucket: "pair" | "model_set" | "non_issue";
  /** responsible × other (bucket "pair"). */
  pair?: [string, string];
  groupIds: string[];
  instanceCount: number;
  uniqueClashCount: number;
  rawClashCount: number;
  levels: string[];
  /** Unique conflicts per current validity. */
  validityMix: Partial<Record<Validity, number>>;
  proposed: { validity: Validity; action: FamilyAction; responsibleDiscipline: string; secondaryDiscipline?: string; solutionOption?: string; band: Priority };
  decision?: FamilyDecision;
  exceptions: FamilyException[];
  tags: FamilyTag[];
  issue?: { mode: "family" | "per_instance"; draftId?: string; accIssueIds?: string[] };
  state: "sin_decidir" | "decidida" | "rechazada";
  counts: { exceptions: number; pendingInherited: number; inherited: number };
  /** Mixed-validity guard: instances whose current validity differs from the decision. */
  validityConflicts: Array<{ groupId: string; title: string; from: Validity; to: Validity }>;
  /** Family ids merged into this one. */
  mergedFrom: string[];
  evidence: { moverSizeMm?: { min: number; max: number }; penetrationMm: { min: number; max: number }; hostDepthMm?: number; sizeHistogram: Array<{ size: string; count: number }> };
  instances: FamilyInstance[];
  /** Agent suggestions (propose_family_decision) waiting for a human. */
  pendingProposals: Array<{ id: string; createdAt: string; rationale: string; payload: Record<string, unknown> }>;
}
/** GET /tests/:testId/families */
export interface FamiliesPayload { testId: string; families: TriageFamily[]; problemTypes: ProblemTypeInfo[] }
/** POST /families/:familyId/decision */
export interface FamilyDecisionRequest {
  testId: string;
  decision: "approve" | "reject";
  validity?: Validity;
  action?: FamilyAction;
  responsibleDiscipline?: string;
  secondaryDiscipline?: string;
  solutionOption?: string;
  typicalDetail?: { name: string; note?: string };
  issueMode?: "family" | "per_instance";
  spotChecked?: string[];
  /** Required (true) when the requested validity differs from some instances' current validity. */
  acknowledgeValidityChanges?: boolean;
  note?: string;
  /** Agent proposal this decision answers (marked applied / rejected). */
  proposalId?: string;
}
/** POST /families/:familyId/decision-preview */
export interface FamilyDecisionPreview {
  familyId: string;
  instances: number;
  uniqueClashCount: number;
  rawClashCount: number;
  exceptions: number;
  pendingInherited: number;
  spotCheckRequired: number;
  /** Instances whose validity would change: they must be acknowledged. */
  validityChanges: Array<{ groupId: string; title: string; from: Validity; to: Validity }>;
  /** ACC issues a batch would create (family mode: ceil(clashes / 1000); per_instance: one per instance). */
  issues: number;
}


export interface ElementProperties { ref: string; found: boolean; props: Record<string, string | number | boolean | null> }

// ─────────────────────────────────────────────────────────────────────────────
// Proposals and decisions
// ─────────────────────────────────────────────────────────────────────────────

export interface ProposalField<T> { value: T; confidence: number; source: FieldSource; ruleIds?: string[] }
export interface ProposedAction { createIssue: boolean; setStatus: AccStatus | null }

export interface IssueDraft {
  title: string;
  description: string;
  ownerDiscipline: DisciplineCode;
  assigneeRole?: string;
  assigneeId?: string;
  assigneeType?: "user" | "role" | "company";
  dueDate: string;
  issueType?: string;
  issueSubtype?: string;
  location?: string;
  includeView: boolean;
  linkClashIds: string[];
  pinnedView?: unknown;
}

/**
 * One proposal view per GROUP: the engine classification merged with any agent
 * proposals for the group. `id` is the real proposal id that a decision refers
 * to (agent proposal, else engine batch proposal, else `E-<testKey>-<groupId>`
 * for engine-only results).
 */
export interface Proposal {
  id: string;
  /** Real store proposal ids merged into this view. */
  sourceProposalIds: string[];
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
  rationale: string;
  signals: { label: string; value: string }[];
  ruleIds: string[];
  spotCheck: boolean;
  /** Agent text contained instruction-like content (UI marks it). */
  flagged?: boolean;
  issueDraft?: IssueDraft;
  inherited?: PreviousDecision;
}

export type DecisionKind = "accept" | "correct" | "reject" | "postpone" | "note" | "undo";
export type DecisionField = "validity" | "priority" | "owner" | "action" | "group" | "issueDraft";
export interface DecisionChange { field: DecisionField; aiValue: unknown; humanValue: unknown; aiConfidence?: number; aiSource?: string; ruleIds?: string[] }
export const REASON_CODES = ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R99"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** POST /api/coord/triage/decisions — idempotent by `id`. `userId`/`userName` are overwritten by the server with the session user. */
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
  batchId?: string;
}

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
  changesCursor: string;
  families?: TriageFamily[];
  problemTypes?: ProblemTypeInfo[];
}
export interface TriageChanges { cursor: string; proposals: Proposal[] }

export interface GroupQuery {
  testId: string;
  filter?: { pair?: string[]; priority?: Priority[]; validity?: Validity[]; level?: string[]; accStatus?: AccStatus[]; delta?: Delta[] };
  sort?: "priority" | "confidence_asc" | "count_desc" | "distance" | "level";
  limit?: number;
  cursor?: string;
}

export interface HistoryEntry { at: string; kind: "agent" | "decision" | "note" | "previous" | "acc"; text: string; actor?: string }
export interface GroupDetail { group: ClashGroup; proposal?: Proposal; clashes: Clash[]; decisions: Decision[]; history: HistoryEntry[]; reviewReasons: string[] }

// ─────────────────────────────────────────────────────────────────────────────
// Batches (approval queue)
// ─────────────────────────────────────────────────────────────────────────────

export type BatchState = "draft" | "ready" | "approved" | "applied" | "partial" | "discarded";
export type BatchOperation = "clash.setStatus" | "issue.create" | "issue.update" | "issue.comment";

export interface BatchItem {
  id: string;
  decisionIds: string[];
  proposalIds: string[];
  targetType: "clash" | "group" | "issue";
  targetIds: string[];
  label: string;
  groupId?: string;
  operation: BatchOperation;
  /** ACC write that carries it; "none" = cannot be written by MC v3 (excluded, see conflict). */
  mcOperation: "clash.close" | "clash.assign" | "none";
  fields: { field: string; accCurrent: unknown; accNew: unknown }[];
  accCurrent?: unknown;
  /** Exact element of the ACC request body. */
  accNew: unknown;
  origin: "ai_accepted" | "ai_corrected" | "manual";
  reasonCode?: ReasonCode;
  reviewer: string;
  aiConfidence?: number;
  lowConfidence?: boolean;
  viewedInViewer?: boolean;
  excluded?: boolean;
  conflict?: { reason: string; accValueNow: unknown };
  issue?: IssueDraft & { priorityLabel?: string };
  result?: { status: "applied" | "failed" | "skipped"; at: string; accRefs?: string[]; message?: string };
  /** Family item: one assign (issue) or one close for the whole family. */
  familyId?: string;
  familyDecisionVersion?: number;
  groupIds?: string[];
  /** Approval preview: instances whose current validity differs from the family decision. */
  validityChanges?: Array<{ groupId: string; title: string; from: Validity; to: Validity }>;
}

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
  /** humanReviewedPct is a PERCENTAGE in 0..100 (not a 0..1 ratio). */
  review: { humanReviewedPct: number; lowConfidence: number; lowConfidenceViewed: number };
  /**
   * Status changes written with clashes:close, in clashes. Sum of counts === counts.statusChanges.
   * Issue creation is NOT a status change: see issueEffects.
   */
  statusTransitions: { from: AccStatus; to: AccStatus; count: number }[];
  /** clashes:assign effects: issues created and clashes linked to them (counts.issuesCreate === issues). */
  issueEffects: { issues: number; clashesLinked: number };
  issuesByDiscipline: Record<DisciplineCode, number>;
  lastPreflightAt?: string;
  /** Approval record summary (no signature). */
  approval?: { approvedBy: string; approvedAt: string; expiresAt: string; channel: "web-ui" | "cli"; valid: boolean; reason?: string };
  items: BatchItem[];
}
export type BatchSummary = Omit<Batch, "items">;
export interface PreflightResult { at: string; conflicts: number; batch: Batch }

/**
 * POST /batches/:id/approve. Requires X-Coord-CSRF. `confirmWord` must be APLICAR or APPLY when the batch
 * creates issues or has ≥ 50 changes. NEVER applies: apply is always a separate POST /batches/:id/apply.
 * Live mode: `webauthn` is REQUIRED (assertion for the options of GET /webauthn/approve-options; the
 * same `excludedItemIds` must be used in both calls). Fixtures mode: `demo: true` instead.
 */
export interface ApproveRequest {
  confirmWord: string;
  note?: string;
  excludedItemIds: string[];
  webauthn?: { nonce: string; origin: string; response: AuthenticationResponseJSON };
  demo?: boolean;
}

/** Output of `navigator.credentials.get()` serialised as by @simplewebauthn/browser `startAuthentication()`. */
export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: { authenticatorData: string; clientDataJSON: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
}

/** Output of `navigator.credentials.create()` serialised as by @simplewebauthn/browser `startRegistration()`. */
export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports?: string[]; [k: string]: unknown };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
}

/** GET /webauthn/approve-options?batch=&exclude= */
export interface ApproveOptionsResponse {
  batchId: string;
  nonce: string;
  payloadHash: string;
  testVersion: number;
  items: number;
  /** PublicKeyCredentialRequestOptionsJSON: pass to startAuthentication({ optionsJSON }). */
  options: Record<string, unknown>;
}

/** GET /webauthn/register-options */
export interface RegisterOptionsResponse {
  requires: "enroll_code" | "step_up";
  /** PublicKeyCredentialCreationOptionsJSON: pass to startRegistration({ optionsJSON }). */
  registration: Record<string, unknown>;
  /** When requires = step_up: confirm with an existing passkey first (startAuthentication). */
  stepUp?: Record<string, unknown>;
}

/** POST /webauthn/register */
export interface RegisterRequest {
  response: RegistrationResponseJSON;
  label?: string;
  /** First passkey only: the one-time code printed by `npm run coordinator -- passkey-enroll`. */
  enrollCode?: string;
  /** Further passkeys: assertion of an existing passkey over `stepUp` options. */
  stepUp?: AuthenticationResponseJSON;
}

export interface ApplyRequest { dryRun?: boolean }

export interface ApplyStatus {
  batchId: string;
  state: BatchState;
  issues: { done: number; total: number };
  statuses: { done: number; total: number };
  log: { at: string; text: string; ok: boolean }[];
  failures: { itemId: string; label: string; message: string }[];
}

/** POST /batches/:id/apply response. */
export interface ApplyResponse {
  dryRun: boolean;
  ok: boolean;
  refused?: { reason: string; message: string };
  requests: Array<{ idempotencyKey: string; operation: string; path: string; groups: number; clashes: number; outcome: string; jobId?: string; createdIssueIds?: string[]; message?: string; body?: unknown }>;
  status: ApplyStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning, rules, reports, audit, notes
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedbackInput {
  target: { proposalId: string } | { groupId: string; testId?: string };
  verdict: "correct" | "incorrect" | "partially_correct";
  corrected?: { validity?: Validity; severity?: Severity; responsibleDiscipline?: string; rootCause?: string; grouping?: "ok" | "should_merge" | "should_split" };
  coordinatorStatement: string;
  generalizable: "yes" | "no" | "unsure";
  scope: "this_group" | "project" | "company";
}

export type RuleEffect = "validity" | "priority" | "owner" | "grouping";
export type RuleState = "active" | "draft" | "disabled";
export interface RuleSummary { id: string; name: string; scope: string; effect: RuleEffect; state: RuleState; hits7d: number; acceptance: number | null; corrections: number; updatedAt: string; file: string }
export interface RuleDetail extends RuleSummary {
  description: string;
  conditions: string[];
  yaml: string;
  recentHits: { groupId: string; projectId: string; modelSetId: string; title: string; decision: string; at: string }[];
  reasonDistribution: { code: ReasonCode; count: number }[];
}
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
  /** Real-data evaluation backing the proposal (shown on the Reglas page). */
  evidence?: {
    kind: "real_data_evaluation";
    testKey: string;
    summary: string;
    metrics: {
      changedUnique: number;
      changedMc: number;
      validityBefore: Partial<Record<Validity, number>>;
      validityAfter: Partial<Record<Validity, number>>;
      groupsBefore: number;
      groupsAfter: number;
      needsReviewBefore: number;
      needsReviewAfter: number;
      unsafeClosures: number;
      scenariosPassed: number;
      scenariosTotal: number;
    };
  };
  /** Number of coordinator feedback records backing the proposal (0 when backed by evidence only). */
  feedbackCount?: number;
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
export interface CalibrationBand { band: ConfidenceBandName; proposals: number; acceptedUnchanged: number }
export interface Calibration {
  thresholds: { high: number; medium: number };
  minDecisions: number;
  bands: CalibrationBand[];
  byField: { field: "validity" | "priority" | "owner"; source: "rule" | "llm"; bands: CalibrationBand[] }[];
  spotCheck: { reviewed: number; corrected: number };
}
export interface ReportScope { projectId?: string; modelSetId?: string; from?: string; to?: string }
export interface ReportData {
  scope: ReportScope;
  kpis: {
    activeClashes: number; activeClashesPrev: number | null; groups: number; rawClashes: number; groupsReviewed: number;
    /** Issues created by applied batches (audit). issuesClosed was removed: no ACC issue-status source in v1. */
    issuesCreated: number; aiAccepted: number; aiCorrected: number; aiRejected: number;
    rawClashesReviewed: number; actualReviewSeconds: number;
  };
  burndown: { label: string; active: number; reviewed: number; resolved: number; closed: number; valid: number }[];
  disciplines: DisciplineCode[];
  matrix: Record<DisciplineCode, Record<DisciplineCode, number>>;
  byStatusPair: { pair: string; active: number; reviewed: number; resolved: number; closed: number }[];
  newVsResolved: { label: string; new: number; resolved: number }[];
  reasons: { code: ReasonCode; count: number }[];
  calibration: CalibrationBand[];
  p1Aging: { lt1w: number; w1to2: number; w2to4: number; gt4w: number };
}
export interface AuditEvent {
  id: string;
  at: string;
  actor: { type: "agent" | "engine" | "user" | "server"; id: string; name: string };
  action: string;
  projectId: string;
  modelSetId?: string;
  /** Test key (T-xxxxxxxx). */
  testId?: string;
  /** ACC clash test id. */
  accTestId?: string;
  batchId?: string;
  targetIds: string[];
  details: Record<string, string | number | boolean | null>;
  accResponseId?: string;
  hash: string;
}
export interface AuditQuery { project?: string; user?: string; action?: string; from?: string; to?: string; batch?: string; limit?: number; cursor?: string }
export interface HomeSummary {
  user: UserInfo;
  queue: { projectId: string; projectName: string; modelSetId: string; modelSetName: string; pending: number }[];
  batches: BatchSummary[];
  activity: { at: string; text: string }[];
  kpis: ReportData["kpis"];
}
export interface Assignee { id: string; name: string; kind: "user" | "role" | "company" }
export interface ProjectNotes { projectId: string; path: string; text: string; lines: number }

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint map (method + path → request / response). `:x` = path params.
// ─────────────────────────────────────────────────────────────────────────────

export interface Endpoints {
  "GET /api/coord/csrf": { req: void; res: { token: string } };
  "GET /api/coord/auth/status": { req: void; res: AuthStatus };
  /** Human-only. Starts the server-side PKCE login (loopback callback) or reuses the cached token. */
  "POST /api/coord/auth/login": { req: LoginStartRequest; res: LoginStartResponse };
  "POST /api/coord/auth/logout": { req: void; res: { ok: true } };
  "GET /api/coord/me": { req: void; res: UserInfo };
  "GET /api/coord/session": { req: void; res: SessionInfo };
  "GET /api/coord/agent/status": { req: void; res: AgentStatus };
  "GET /api/coord/home": { req: void; res: HomeSummary };
  "GET /api/coord/hubs": { req: void; res: Hub[] };
  "GET /api/coord/projects?hubId&q": { req: void; res: ProjectSummary[] };
  "GET /api/coord/projects/:projectId": { req: void; res: ProjectSummary };
  "GET /api/coord/projects/:projectId/model-sets": { req: void; res: ModelSetSummary[] };
  "GET /api/coord/projects/:projectId/model-sets/:modelSetId/tests": { req: void; res: TestRun[] };
  "GET /api/coord/projects/:projectId/assignees": { req: void; res: Assignee[] };
  "GET /api/coord/projects/:projectId/notes": { req: void; res: ProjectNotes };
  /** Human-only. */
  "POST /api/coord/projects/:projectId/notes": { req: { text: string; kind?: string }; res: ProjectNotes };
  /** Ingest (download + cache) a test from ACC, then classify. Long-running. */
  "POST /api/coord/projects/:projectId/model-sets/:modelSetId/tests/:accTestId/ingest": { req: { refresh?: boolean; classify?: boolean }; res: { testKey: string } };
  "GET /api/coord/triage/:projectId/:modelSetId?test": { req: void; res: TriagePayload };
  "GET /api/coord/triage/:projectId/:modelSetId/changes?test&since": { req: void; res: TriageChanges };
  "GET /api/coord/tests/:testId/groups?pair&priority&validity&level&accStatus&delta&sort&limit&cursor": { req: void; res: Page<ClashGroup> };
  "GET /api/coord/tests/:testId/groups/:groupId": { req: void; res: GroupDetail };
  "GET /api/coord/tests/:testId/groups/:groupId/clashes?limit&cursor": { req: void; res: Page<Clash> };
  "POST /api/coord/tests/:testId/elements/properties": { req: { refs: string[] }; res: ElementProperties[] };
  "GET /api/coord/tests/:testId/proposals?ids&limit&cursor": { req: void; res: Page<Proposal> };
  /** Human-only. */
  "POST /api/coord/triage/decisions": { req: Decision[]; res: { saved: string[] } };
  "GET /api/coord/decisions?testId&projectId&limit&cursor": { req: void; res: Page<Decision> };
  /** Human-only ("Enviar a aprobación"). */
  "POST /api/coord/batches": { req: { projectId: string; modelSetId: string; testId: string }; res: Batch };
  "GET /api/coord/batches?state&projectId": { req: void; res: BatchSummary[] };
  "GET /api/coord/batches/:batchId": { req: void; res: Batch };
  "POST /api/coord/batches/:batchId/preflight": { req: void; res: PreflightResult };
  "PATCH /api/coord/batches/:batchId/items": { req: { itemIds: string[]; excluded: boolean }; res: Batch };
  "PATCH /api/coord/batches/:batchId/items/:itemId/issue": { req: Partial<IssueDraft>; res: Batch };
  "POST /api/coord/batches/:batchId/return": { req: void; res: Batch };
  "POST /api/coord/batches/:batchId/discard": { req: void; res: Batch };
  /** Human-only. Step 1 of approval: WebAuthn options with a challenge derived from the batch payload. */
  "GET /api/coord/webauthn/approve-options?batch&exclude": { req: void; res: ApproveOptionsResponse };
  /** Human-only. Step 2: live = WebAuthn assertion required; fixtures = `demo: true`. Never applies. */
  "POST /api/coord/batches/:batchId/approve": { req: ApproveRequest; res: ApplyStatus };
  /** Human-only. Passkey registration options (first passkey: enrol code; more: step-up). */
  "GET /api/coord/webauthn/register-options": { req: void; res: RegisterOptionsResponse };
  /** Human-only. */
  "POST /api/coord/webauthn/register": { req: RegisterRequest; res: { credentialId: string; label: string; enrolledVia: "enroll-code" | "step-up" } };
  /** Human-only: dryRun defaults to TRUE. */
  "POST /api/coord/batches/:batchId/apply": { req: ApplyRequest; res: ApplyResponse };
  "GET /api/coord/batches/:batchId/apply-status": { req: void; res: ApplyStatus };
  /** Human-only. */
  "POST /api/coord/feedback": { req: FeedbackInput; res: { feedbackId: string } };
  "GET /api/coord/rules": { req: void; res: RuleSummary[] };
  "GET /api/coord/rules/:ruleId": { req: void; res: RuleDetail };
  "GET /api/coord/rule-suggestions": { req: void; res: RuleSuggestion[] };
  /** Human-only. Records the decision; the patch is merged with git by a human. */
  "POST /api/coord/rule-suggestions/:id/decision": { req: { decision: "approve" | "reject" }; res: RuleSuggestion };
  "GET /api/coord/learning/corrections?projectId&limit&cursor": { req: void; res: Page<CorrectionRow> };
  "GET /api/coord/learning/calibration": { req: void; res: Calibration };
  "GET /api/coord/reports?projectId&modelSetId&from&to": { req: void; res: ReportData };
  "GET /api/coord/audit?project&user&action&from&to&batch&limit&cursor": { req: void; res: Page<AuditEvent> };
}

export type EndpointKey = keyof Endpoints;
