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
  /** Winning engine rule of this clash (Reglas → workspace filter ?regla=). */
  ruleId?: string;
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
  /**
   * Engine review gate: true = this group must reach a human (confidence below the bar, needs_info,
   * critical, structural opening, seguridad_personas, DEF-999, bulk closure…). Not changed by agent
   * proposals; reviewState stays "needs_review" until a human decides. Always sent by the server.
   */
  humanReview?: boolean;
  /** Spanish reasons of the gate (empty when humanReview is false). Always sent by the server. */
  reviewReasons?: string[];
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
  /** ACC-decided state of the group's clashes (X1, D8: ACC wins). Absent when ACC has no group for them. */
  acc?: AccState;
  /** "Qué cambió" vs the baseline (changeSummary.baseVersion: last version the coordinator reviewed). */
  change?: ChangeKind;
  /**
   * M2 F1: a decision taken on an earlier version, inherited because every clash is unchanged
   * (|Δpenetration| ≤ 10 mm, same element types). Inherited groups count as decided (reviewState
   * "decided"); a closure is never inherited by a `real` clash.
   */
  inherited?: InheritedDecision;
  /** M2 X3: open coordinator questions about this group. */
  questionIds?: string[];
  /** Closed in ACC (D8: ACC wins) while the engine says `real`: shown once for confirmation, never re-proposed. */
  closedInAccWhileReal?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// M2: decision memory (F1), coordinator questions (X3), capture codes
// ─────────────────────────────────────────────────────────────────────────────

export interface InheritedDecision {
  fromVersion: number;
  fromTestKey?: string;
  /** human = a coordinator decision; family = an approved family decision; acc = ACC assigned/closed (D8). */
  source: "human" | "family" | "acc";
  /** human: accept | correct | reject | postpone; family: the family action; acc: assigned | closed. */
  decision: string;
  /** Validity the decision set, when it set one. */
  validity?: Validity;
  /** What it does in ACC: an issue, a closure, or nothing. */
  effect: "issue" | "close" | "none";
  decidedAt: string;
  decidedBy?: string;
  /** Decision id, family id + version, or ACC group id. */
  ref: string;
  /** true = listed by "Aceptar heredadas" for an explicit confirmation (family instance pending). */
  needsConfirmation?: boolean;
  /**
   * G7: why a confirmation is needed. "changed" (clashes, membership or the engine proposal changed:
   * one by one) or policy reasons on an unchanged item (bulk "Confirmar heredadas sin cambio").
   */
  confirmReasons?: InheritConfirmReason[];
}

// ─────────────────────────────────────────────────────────────────────────────
// M3: issue verification (F2) and follow-up (F5). READ-ONLY against ACC (no status write until M5).
// ─────────────────────────────────────────────────────────────────────────────

export type IssueVerdict = "resuelta" | "avance" | "sigue_abierta" | "dice_resuelta" | "no_verificable";

/** GET /tests/:testId/issue-checks — one row per ACC issue linked to an assigned group (X1). */
export interface IssueCheck {
  issueId: string;
  displayId?: number;
  /** ACC issue title (untrusted text: render as text). */
  title: string;
  /** ACC status as read (open, pending, in_review, closed, …). */
  accStatus: string;
  dueDate?: string;
  overdue: boolean;
  /** user | company | role (never a person's name). */
  assignedToType?: string;
  familyId?: string;
  /** Our groups that hold the issue's still-existing clashes (resolved-only issues: the previous version's groups). */
  groupIds: string[];
  /** ACC assigned group ids. */
  accGroupIds: string[];
  /** Responsible discipline (dominant of the groups). */
  discipline: string;
  /** Raw (MC) clashes of the assigned groups still present / resolved in this run. */
  existing: number;
  resolved: number;
  verdict: IssueVerdict;
  /** Spanish, one line (why this verdict; for no_verificable: which check). */
  reason: string;
  /** Spanish, ≤ 400 characters, from a template (no LLM). */
  evidence: string;
  checks: {
    /** blocked = an element of the resolved set clashes again in this run (the problem may have moved). */
    displacement: "ok" | "blocked";
    /** ok = the responsible discipline's model has a newer version than when the issue was created. */
    modelAge: "ok" | "stale" | "unknown";
    scope: "ok" | "out_of_scope";
  };
  /** Consecutive versions this issue has been "sigue_abierta" (this one included). */
  stuckCycles: number;
  /** P1 and stuckCycles ≥ 2: goes on the meeting agenda (M4). */
  stuck: boolean;
  priority?: Priority;
  /** The coordinator's decision on this verdict, if any (this version). */
  decision?: { kind: "accept" | "reject"; reasonCode?: ReasonCode; note?: string; decidedBy: string; decidedAt: string };
  /** G11: ACC Build deep link (absent when the ids are not ACC ids, e.g. fixtures). */
  accUrl?: string;
}
export interface IssueChecksPayload {
  testId: string;
  version: number;
  counts: Record<IssueVerdict, number>;
  checks: IssueCheck[];
  /** When the ACC issues were read. */
  readAt?: string;
}
/** GET /tests/:testId/reminders — one Spanish text per responsible discipline (template; no names). */
export interface IssueReminder {
  discipline: string;
  text: string;
  issueIds: string[];
  counts: { total: number; overdue: number; diceResuelta: number; sigueAbierta: number; avance: number };
}
/** POST /tests/:testId/issue-checks/:issueId/decision */
export interface IssueVerdictDecisionRequest {
  /** accept = resuelta: "listo para mover en ACC"; dice_resuelta / sigue_abierta: "a la reunión". */
  decision: "accept" | "reject";
  /** Required on reject: V01–V05 (or R99 + note). */
  reasonCode?: ReasonCode;
  note?: string;
}
/** GET /issue-checks/gate?projectId&modelSetId — the M5 evidence gate (2 cycles, ≥ 90 % accepted unchanged). */
export interface IssueGate {
  cycles: number;
  /** Accepted-unchanged share of decided "resuelta" verdicts over the counted cycles; null without any. */
  acceptedUnchangedPct: number | null;
  perCycle: Array<{ version: number; testKey: string; resuelta: number; accepted: number; rejected: number }>;
  /** cycles ≥ 2 and every counted cycle ≥ 90 %. */
  ready: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// M4: the meeting (F4). Agenda = a server table (no LLM); notes per grupo / ubicación;
// saved viewer views (local only). No screenshots to ACC, no HTML/PNG pack.
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed order inside a discipline: incidencia (follow-ups, never capped) → regresion → p1_pendiente → nuevo → confirmar_resuelta. */
export type AgendaKind = "regresion" | "p1_pendiente" | "incidencia" | "nuevo" | "confirmar_resuelta";
export interface AgendaItem {
  kind: AgendaKind;
  familyId?: string;
  groupIds?: string[];
  issueId?: string;
  /** ACC issue number (#nnn) for issue items. */
  displayId?: number;
  /** Spanish (family title, or the ACC issue title: render as text). */
  title: string;
  priority: Priority;
  /** Spanish, short. */
  reason: string;
  counts: { instances?: number; clashes: number; existing?: number; resolved?: number };
}
export interface AgendaDiscipline {
  discipline: string;
  items: AgendaItem[];
  /** Items beyond the cap ("+N más"). Issue follow-ups ("incidencia") come first and never count towards the cap. */
  more: number;
  /** Spanish, one line, from a template. */
  summary: string;
}
/** GET /tests/:testId/agenda */
export interface AgendaPayload {
  testId: string;
  version: number;
  baseVersion?: number;
  /** Items per discipline before "+N más". */
  cap: number;
  disciplines: AgendaDiscipline[];
}

/** A meeting note on a grupo (family) or an ubicación (group). Human text: render as text. */
export interface MeetingNote {
  testKey: string;
  version: number;
  targetType: "family" | "group";
  targetId: string;
  /** ≤ 2000 characters. */
  text: string;
  /** User id of the author (no names are stored). */
  author: string;
  updatedAt: string;
  /** 1, 2, … (every save is a new revision; earlier ones are kept in history). */
  revision: number;
  history?: Array<{ revision: number; text: string; author: string; at: string }>;
}
/** PUT /tests/:testId/notes/:targetType/:targetId */
export interface MeetingNoteRequest { text: string }

/** PUT /tests/:testId/families/:familyId/view — the viewer camera state (≤ 20 KB JSON, local only). */
export interface SavedViewerView {
  testKey: string;
  familyId: string;
  camera: unknown;
  savedBy: string;
  savedAt: string;
}

/** X3: a question the agent asks the coordinator (answered in the UI). */
export interface CoordinatorQuestion {
  id: string;
  testKey: string;
  version: number;
  familyId?: string;
  groupIds: string[];
  clashIds: string[];
  /** Spanish, ≤ 300 characters. Agent text: render as text. */
  question: string;
  /**
   * ≤ 5 structured options (the UI shows them as buttons). Only a chosen option's validity / action
   * becomes a decision; free text is stored as the answer and decides nothing.
   */
  options?: QuestionOption[];
  /** Groups an option would decide (≤ 20); > 3 requires confirmCount on the answer. */
  affectedGroups: number;
  kind: "validity" | "action" | "other";
  state: "open" | "answered" | "stale";
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
  createdBy: "agent";
  createdAt: string;
  /** Decisions created from the answer (validity / action questions). */
  decisionIds?: string[];
  /** Why it went stale (clashes changed in a newer version). */
  staleReason?: string;
}
export interface QuestionOption {
  /** Spanish label shown on the button. */
  label: string;
  /** validity questions: what choosing it sets. */
  validity?: Validity;
  /** action questions: what choosing it does. */
  action?: "create_issue" | "close" | "mark_reviewed" | "postpone";
}
/** POST /questions/:id/answer */
export interface QuestionAnswerRequest {
  /** Index of the chosen option: the ONLY way an answer becomes a decision. */
  optionIndex?: number;
  /** Free text (≤ 1000): stored for the next agent run; decides nothing. Required when no option is chosen. */
  answer?: string;
  /** Required for close / validity changes (R01–R13, V01–V05, R99 + note). */
  reasonCode?: ReasonCode;
  /** Required when the option decides more than 3 groups: must equal affectedGroups. */
  confirmCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// M1: ACC sync (X1), scope guard (X6), "Qué cambió" (F1 support)
// ─────────────────────────────────────────────────────────────────────────────

/** ACC assigned/closed groups touching these clashes. Counts are RAW (MC) clashes. */
export interface AccState {
  /** "mixed" when some clashes are in assigned groups and others in closed groups. */
  status: "assigned" | "closed" | "mixed";
  /** ACC issue ids of the assigned groups (deduplicated). */
  issueIds: string[];
  /** Clashes of this item that are in an ACC assigned/closed group (still present in the test). */
  existing: number;
  /** Clashes of those ACC groups that ACC reports as resolved in this test. */
  resolved: number;
  /** Close reason when all closed groups share one. */
  closedReason?: string;
}
/**
 * One change word per item (raw-clash based, vs the previous cached version):
 * new = every clash is new; reappeared = at least one clash reappeared (ledger);
 * changed = at least one clash is new or changed (|Δpenetration| > 10 mm or different element types);
 * unchanged = otherwise.
 */
export type ChangeKind = "new" | "changed" | "reappeared" | "unchanged";
export type ChangeCounts = Record<ChangeKind, number>;
export interface ScopeChange {
  documentId?: number;
  fileName?: string;
  kind: "document_added" | "document_removed" | "model_replaced" | "test_config_changed" | "mass_resolution";
  /** Spanish, one line. */
  message: string;
}
export interface AccSyncSummary { at: string; assignedGroups: number; closedGroups: number; issues: number }
export interface ChangeSummary {
  previousVersion?: number;
  previousTestKey?: string;
  /** Groups per change word. */
  groups: ChangeCounts;
  /** Raw clashes per change word. */
  clashes: ChangeCounts;
  /** M2: the baseline "Qué cambió" compares against. */
  baseVersion?: number;
  baseTestKey?: string;
  /** last_reviewed = newest older version with ≥ 1 human decision or approved batch; previous = fallback. */
  baseReason?: "last_reviewed" | "previous";
  /** Groups whose decision is inherited from an earlier version (counted as decided). */
  inherited?: number;
  /** Raw clashes of the previous version that are resolved (excluding out-of-scope). */
  resolved: number;
  /** Raw clashes that would be resolved but belong to a document with a scope change: never counted as resolved, never proposed. */
  outOfScope: number;
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
  acc?: AccState;
  change?: ChangeKind;
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
  /** Agent instance-exception suggestions (propose_family_exception) waiting for a human; absent when none. */
  pendingExceptions?: Array<{ id: string; createdAt: string; groupId: string; reason: string; rationale: string; fields: Partial<FamilyDecisionFields> }>;
  /** Aggregated ACC state of the family's instances. */
  acc?: AccState;
  /** Instances per change word. */
  changeCounts?: ChangeCounts;
  /**
   * Inherited instances of an approved (non-escalate) decision not yet in a batch: what
   * "Enviar a aprobación" would send for this family (0 = nothing pending).
   */
  pendingSend?: number;
  /** G16: decisions of older family ids (previous signature) that disagree here — a human reviews them. */
  legacyDecisions?: Array<{ familyId: string; version: number; validity: Validity; action: FamilyAction; responsibleDiscipline: string; decidedAt: string }>;
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
  /** G4: "Coordinación / Clash" (display; ids in issueType / issueSubtype). */
  issueTypeLabel?: string;
  /** G5: company / role / user name of assigneeId (UI only, never in issue text). */
  assigneeLabel?: string;
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
  /** M2: who proposed it: the deterministic engine or the agent (any agent proposal merged in). */
  origin?: "engine" | "agent";
}

export type DecisionKind = "accept" | "correct" | "reject" | "postpone" | "note" | "undo";
export type DecisionField = "validity" | "priority" | "owner" | "action" | "group" | "issueDraft";
export interface DecisionChange { field: DecisionField; aiValue: unknown; humanValue: unknown; aiConfidence?: number; aiSource?: string; ruleIds?: string[] }
/**
 * R01–R13 / R99: triage reasons. V01–V05 (M2 capture, verification of resolved issues):
 * V01 problem moved · V02 model too old · V03 fix not approved by the responsible party ·
 * V04 deletion accepted as fix · V05 partial fix enough.
 */
export const REASON_CODES = ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R99", "V01", "V02", "V03", "V04", "V05"] as const;
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
  /** Last ACC sync of this test; absent when it was never synced. */
  accSync?: AccSyncSummary;
  /** Scope changes vs the previous cached version (X6). Always sent by the server ([] when none). */
  scopeChanges?: ScopeChange[];
  /** "Qué cambió" summary. Always sent by the server. */
  changeSummary?: ChangeSummary;
  /** M2 X3: questions for this test (open ones carried from older versions included). */
  questions?: CoordinatorQuestion[];
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
  /** G3, only when stale: can "Llevar decisiones a vN" run (vN analysed, batch not applied)? */
  rebase?: { available: boolean; targetVersion: number; reason?: string };
  /** G3: this batch was discarded and replaced by the given one (re-based to a newer version). */
  supersededBy?: string;
  /** G3: this batch was re-based from an older one; items that were not carried need a review. */
  rebasedFrom?: BatchRebaseNote;
}
export interface BatchRebaseNote {
  batchId: string;
  fromVersion: number;
  carried: number;
  needsReview: Array<{ label: string; groupId?: string; familyId?: string; reason: string }>;
}
/** POST /batches/:id/rebase (human only). The new batch is ready and UNAPPROVED. */
export interface BatchRebaseResult { batch: Batch; previous: string; needsReview: BatchRebaseNote["needsReview"] }
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
export interface RuleSummary { id: string; name: string; /** Spanish name (YAML nameEs, label table or derived). */ nameEs?: string; /** Plain-language outcome ("CLI×EST viga → Conflicto"). */ outcomeEs?: string; scope: string; effect: RuleEffect; state: RuleState; hits7d: number; acceptance: number | null; corrections: number; updatedAt: string; file: string }
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
  /** propuesta → aprobada (pendiente de publicar) → publicada (→ revertida). */
  state: "pending" | "approved" | "rejected" | "published" | "reverted";
  createdAt: string;
  /** Plain-language effect sentences (G15), shown before the technical detail. */
  effect?: string[];
  /** Impact on the current cached test with the candidate rules. */
  impact?: RuleImpact;
  /** Latest publication (published or reverted). */
  publication?: RulePublicationView;
  /** Who proposed it: the agent (propose_rule_change) or a coordinator in the UI. Same flow for both. */
  origin: "agente" | "coordinador";
  changeKind?: RuleChangeKind;
  ruleIds?: string[];
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
  /** G4/G5: ACC issue types (GET only) and the project issue settings (type default + discipline → assignee). */
  "GET /api/coord/projects/:projectId/issue-types": { req: void; res: AccIssueType[] };
  "GET /api/coord/projects/:projectId/issue-settings": { req: void; res: IssueSettings };
  /** Human-only. */
  "PUT /api/coord/projects/:projectId/issue-settings/issue-type": { req: { typeId: string; subtypeId: string; label: string } | { clear: true }; res: IssueSettings };
  /** Human-only. assignee null = remove the mapping. */
  "PUT /api/coord/projects/:projectId/issue-settings/assignees/:discipline": { req: { assignee: { id: string; type: "user" | "role" | "company"; label: string } | null }; res: IssueSettings };
  /** Human-only. Decision on an agent issue_settings proposal. */
  "POST /api/coord/projects/:projectId/issue-settings/proposals/:proposalId/decision": { req: { decision: "accept" | "reject" }; res: IssueSettings };
}

export type EndpointKey = keyof Endpoints;

// ─────────────────────────────────────────────────────────────────────────────
// Chat panel (docs/ai/chat-agent-design.md): domain agent `coordinador-chat`, propose-only,
// run as a local headless Claude Code (`claude -p`) with the coordinator's own login.
// ─────────────────────────────────────────────────────────────────────────────

/** Structured UI state; the server turns it into the <contexto_ui> block (free text never pasted in). */
export interface ChatContext {
  /** Active lens (cambios | todo | incidencias | reunion …). */
  lens?: string;
  /** Selected family / ubicaciones / clashes in the tree. */
  focus?: { familyId?: string; groupIds?: string[]; clashIds?: string[] };
  /** Viewer selection (≤ 50 elements are resolved; more are counted only). */
  selection?: Array<{ documentId: number; dbId: number }>;
}
/** POST /chat/messages (human-only, CSRF) → ChatMessageAccepted. */
export interface ChatMessageRequest {
  testKey: string;
  /** ≤ 4000 characters. */
  message: string;
  context?: ChatContext;
  /** true = "Nueva conversación" (new Claude session for this test). */
  newSession?: boolean;
}
export interface ChatMessageAccepted {
  messageId: string;
  /** (user, project, model set, test) session. */
  sessionId: string;
}
/**
 * GET /chat/:messageId/events → `text/event-stream`. Each event: `event: <type>\ndata: <JSON>\n\n`.
 * Events emitted before the client connects are replayed. Always ends with one `done` or `error`.
 */
export type ChatEvent =
  | { type: "status"; phase: "starting" | "thinking" | "retrying" | "rate_limited"; detail?: string }
  /** Token text of the main agent (append to the bubble). */
  | { type: "delta"; text: string }
  /** The agent is calling a tool (chip "consultando G-…"). */
  | { type: "tool"; name: string; target?: string }
  /** A proposal the agent created, extracted by the server from the tool result. */
  | { type: "proposal"; id: string; kind: string; summary: string; card?: ChatCard }
  /** A question the agent asked (ask_coordinator). */
  | { type: "question"; id: string; question: string; card?: ChatCard }
  /** A flow the agent started (start_flow), read back from the flow store. */
  | { type: "flow"; run: FlowRunView }
  /** Suggested next steps (get_next_steps), computed by the server, never from the model's text. */
  | { type: "next_steps"; steps: NextStep[] }
  | { type: "done"; messageId: string; costUsd?: number; durationMs: number; stoppedBy?: "timeout" | "tool_cap" | "proposal_cap" | "budget" }
  | { type: "error"; code: "claude_not_found" | "not_logged_in" | "busy" | "cancelled" | "timeout" | "mcp_unavailable" | "rate_limited" | "failed"; message: string };
/** GET /chat/status: pre-flight (cached 5 min). Never contains the account email. */
export interface ChatStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  /** The in-app agent runtime (agent-runtime/, materialised by the server) has the chat agent, or none. */
  agentSource: "runtime" | "none";
  /** A message is running for this user. */
  running: boolean;
}
export interface ChatHistoryMessage {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  context?: ChatContext;
  proposalIds?: string[];
  questionIds?: string[];
  /** Cards of proposalIds / questionIds, resolved from the store when the history is read (G12). */
  cards?: ChatCard[];
  /** Flow runs the agent started in this turn (start_flow); resolved from the flow store on read. */
  flowRunIds?: string[];
  flows?: FlowRunView[];
  /** Next steps the server computed when the agent asked (get_next_steps). */
  nextSteps?: NextStep[];
  costUsd?: number;
  durationMs?: number;
  error?: { code: string; message: string };
}
/** GET /chat/history?testKey */
export interface ChatHistory {
  sessionId: string;
  testKey: string;
  messages: ChatHistoryMessage[];
  running?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// G4/G5: project ACC issue settings
// ─────────────────────────────────────────────────────────────────────────────

/** ACC issue type with its active subtypes. */
export interface AccIssueType { id: string; title: string; subtypes: Array<{ id: string; title: string }> }
export interface IssueAssigneeMapping { discipline: string; id: string; type: "user" | "role" | "company"; label: string }
/** GET /projects/:projectId/issue-settings */
export interface IssueSettings {
  projectId: string;
  version: number;
  /** Configured default (null = none: auto-detected or chosen at approval). */
  issueType: { typeId: string; subtypeId: string; label: string } | null;
  /** What a new batch would use now and where it came from. */
  effectiveIssueType: { typeId: string; subtypeId: string; label?: string; source: "project" | "config" | "auto" | "fixtures" } | null;
  assignees: IssueAssigneeMapping[];
  codes: Array<{ code: string; label: string }>;
  updatedAt?: string;
  updatedBy?: string;
  /** Agent suggestions waiting for a human decision. */
  pendingProposals: Array<{ id: string; summary: string; rationale: string; createdAt: string; payload: Record<string, unknown> }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// G15 rule publication (human-only; agents read the stage through list_proposals).
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleImpact {
  testKey: string;
  version: number;
  /** Grupos (families) / ubicaciones (groups) / interferencias whose validity changes. */
  families: number;
  groups: number;
  clashes: number;
}
export interface RulePublicationView {
  id: string;
  at: string;
  by: string;
  proof: "webauthn" | "demo";
  files: string[];
  reverted?: { at: string; by: string };
}
/** GET /rule-suggestions/:id/publish-options?op=publish|revert → WebAuthn options bound to the files written. */
export interface RulePublishOptions {
  nonce: string;
  payloadHash: string;
  options: unknown;
}
/** POST /rule-suggestions/:id/publish | /revert (human, CSRF): passkey assertion, or demo in fixtures mode. */
export interface RulePublishRequest {
  webauthn?: { nonce: string; origin: string; response: unknown };
  demo?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reglas (simplified page): active rules by pair + use + acierto, Biblioteca, alerts,
// and human rule changes (calibrate · edit · retire · restore) as suggestions.
// ─────────────────────────────────────────────────────────────────────────────

export type RuleChangeKind = "new" | "calibrate" | "edit" | "retire" | "restore";
/** One rule exactly as in the YAML (render text fields as text). */
export interface RuleDefinition {
  id: string;
  name: string;
  nameEs?: string;
  when: Record<string, unknown>;
  then: Record<string, unknown> & { validity: string; severity: string; suggestedAction: string; responsibleDiscipline: string; confidence: number; rationale: string; humanReview?: boolean };
}
/** A number of the rule's conditions a coordinator can calibrate (mm, ratio, days…). */
export interface RuleThreshold { path: string; block: string; field: string; op: string; value: number }
export interface RuleRow {
  id: string;
  name: string;
  nameEs: string;
  /** Id prefix (HYG, DUP, FP… MM, DEF). */
  section: string;
  /** Discipline / group token per side ("EST", "MEP", "CLI"…); null = any. */
  sides: [string | null, string | null];
  validity: string;
  responsible: string;
  severity: string;
  action: string;
  confidence: number;
  humanReview: boolean;
  /** Clashes / ubicaciones whose winning rule is this one in the selected test (null = no test). */
  usage: { clashes: number; groups: number } | null;
  /** Winning clashes over every classified test. */
  totalUse: number;
  /** Human decisions on its ubicaciones that kept its outcome; rate null = too few (n < minAccuracyN). */
  accuracy: { agree: number; n: number; rate: number | null; topCorrection?: string };
  thresholds: RuleThreshold[];
  raw: RuleDefinition;
  /** DEF-999: fallback (human review); never retired. */
  fallback: boolean;
}
export interface RuleLibraryRow { id: string; nameEs: string; section: string; sides: [string | null, string | null]; validity: string; retiredAt: string; reason?: string }
export interface RulesOverview {
  tests: Array<{ testKey: string; projectId: string; modelSetId: string; version: number; label: string; classifiedTests: number }>;
  selectedTestKey?: string;
  rules: RuleRow[];
  library: RuleLibraryRow[];
  archiveError?: string;
  /** Automatic alerts (tags such as seguridad_personas, requiere_calculista): read-only. */
  annotations: Array<{ id: string; tags: string[]; note?: string }>;
  minAccuracyN: number;
}
/** Human rule change (POST /rule-suggestions and /rule-suggestions/preview). */
export type RuleChangeRequest =
  | { kind: "calibrate"; ruleId: string; then?: { validity?: string; responsibleDiscipline?: string; secondaryDiscipline?: string | null; severity?: string; suggestedAction?: string; humanReview?: boolean; confidence?: number }; thresholds?: Array<{ path: string; value: number }>; nameEs?: string }
  | { kind: "edit"; ruleId: string; rule: RuleDefinition | string }
  | { kind: "retire"; ruleIds: string[]; reason?: string }
  | { kind: "restore"; ruleIds: string[] };
export interface RuleShadow { ruleId: string; nameEs: string; clashes: number }
export interface RuleChangePreview {
  kind: RuleChangeKind;
  title: string;
  ruleIds: string[];
  patch: string;
  effect: string[];
  /** Blocking (safety, validation): the suggestion is refused. */
  errors: string[];
  warnings: string[];
  impact?: { testKey: string; version: number; families: number; groups: number; clashes: number; ruleChanged: number; toFallback: number; newlyClosing: number; policyUnsafe: number };
  focus?: { ruleId: string; matches: number; wins: number; shadowedBy: RuleShadow[]; shadows: RuleShadow[] };
}
export interface RuleInsights {
  testKeys: string[];
  uncovered: Array<{ disciplinePair: string; categoryPair: string; ruleIds: string[]; clashes: number; groups: number; topSystems: string[]; topLevels: string[]; exampleClashIds: string[]; exampleGroupIds: string[]; testKeys: string[] }>;
  corrected: Array<{ ruleId: string; nameEs: string; n: number; agree: number; rate: number; reliable: boolean; topCorrection: string }>;
  zeroUse: Array<{ ruleId: string; nameEs: string }>;
  reactivation: Array<{ ruleId: string; nameEs: string; clashes: number; testKey: string }>;
  library: Array<{ ruleId: string; nameEs: string; retiredAt: string }>;
  note: string;
}
export interface Endpoints {
  "GET /api/coord/rules/overview?testKey": { req: void; res: RulesOverview };
  /** Human-only (CSRF). Impact, shadowing and safety of a change; writes nothing. */
  "POST /api/coord/rule-suggestions/preview": { req: { change: RuleChangeRequest; testKey?: string }; res: RuleChangePreview };
  /** Human-only (CSRF). Creates a rule suggestion (origin coordinador) at stage "propuesta". */
  "POST /api/coord/rule-suggestions": { req: { change: RuleChangeRequest; rationale: string; title?: string; testKey?: string }; res: RuleSuggestion };
}

// ─────────────────────────────────────────────────────────────────────────────
// G12 chat cards: what a proposal / question card shows (server data, never model text).
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatCard {
  id: string;
  /** Proposal kind (classification, family_decision, status_change, issue_draft, group_action…) or "question". */
  kind: string;
  /** Engine action: create_issue | close | close_not_issue | mark_reviewed | hygiene_issue | escalate | reopen | regroup | issue … */
  action?: string;
  validity?: Validity;
  /** Issue title / regroup summary / question text (sanitised). */
  title?: string;
  /** Proposal state or question state. */
  state?: string;
  /** What the card acts on: grupo (family) or ubicación (group), with its clash count. */
  target?: { kind: "family" | "group" | "clash"; id: string; label: string; clashCount: number; groupCount?: number };
  /** Questions: the full question so the card can be answered in place. */
  question?: CoordinatorQuestion;
}

// ─────────────────────────────────────────────────────────────────────────────
// G7 (ws-C): bulk confirmation of inherited decisions
/** G7: policy reasons that force a human look at an inherited decision, plus "changed". */
export type InheritConfirmReason = "changed" | "critical" | "structural_opening" | "life_safety";

/** G7: one row of "Confirmar heredadas sin cambio". */
export interface InheritedConfirmItem {
  groupId: string;
  title: string;
  familyId?: string;
  source: "human" | "family";
  ref: string;
  fromVersion: number;
  decision: string;
  validity?: Validity;
  effect: "issue" | "close" | "none";
  reasons: Array<Exclude<InheritConfirmReason, "changed">>;
}

export interface InheritedConfirmList {
  testId: string;
  items: InheritedConfirmItem[];
  /** Pending confirmations that cannot be bulk-confirmed (changed since the decision): one by one. */
  changedCount: number;
  /** Agent proposals (propose_group_action confirm_inherited) waiting for a human. */
  proposals: Array<{ id: string; groupIds: string[]; rationale: string; createdAt: string }>;
}

export interface InheritedConfirmRequest {
  testId: string;
  groupIds: string[];
  /** Typed by the coordinator: must equal groupIds.length. */
  typedCount: number;
  /** Separate acknowledgements: required when any item is a structural opening / life safety. */
  acknowledgeStructural?: boolean;
  acknowledgeLifeSafety?: boolean;
  /** The agent proposal this confirms (optional). */
  proposalId?: string;
}

export interface InheritedConfirmResult {
  confirmed: string[];
  list: InheritedConfirmList;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-side parity (docs/ai/agent-human-parity.md #10, #62, #68): read-only views of what
// the agent sees (hygiene stats, generate_report files, record_feedback). No personal data.
// ─────────────────────────────────────────────────────────────────────────────

export type HygieneCheck =
  | "self_clashes_same_document" | "duplicate_elements" | "missing_level" | "missing_system"
  | "generic_or_placeholder_types" | "unassigned_discipline_documents" | "insulation_hosted_clashes"
  | "linked_model_misplacement" | "category_mismatch_by_name";
/** Same numbers as the MCP tool get_model_hygiene_stats. `doc` is model text (untrusted, render as text). */
export interface TestHygiene {
  testId: string;
  byDocument: { doc: string; discipline: string; elementsInClashes: number; selfClashes: number; duplicates: number; missingLevel: number; missingSystem: number; genericTypes: number }[];
  findings: { check: HygieneCheck; doc: string; count: number; examples: string[]; clashesAffected: number }[];
}
/** A file written by generate_report under .coordinator/reports/<projectId>/. */
export interface ReportFile { name: string; format: "md" | "html"; kind?: string; testKey?: string; date?: string; size: number; modifiedAt: string }
export interface ReportFileContent { name: string; format: "md" | "html"; content: string }
/** Origin of a feedback record: the web UI, the agent (record_feedback) or a triage decision. */
export type FeedbackSource = "ui" | "agent" | "decision";
export interface FeedbackRow {
  feedbackId: string;
  at: string;
  source: FeedbackSource;
  verdict: "correct" | "incorrect" | "partially_correct";
  testKey?: string;
  groupId?: string;
  proposalId?: string;
  engineValidity?: string;
  correctedValidity?: string;
  disciplinePair?: string;
  ruleIds: string[];
  /** Free text written by the coordinator (or relayed by the agent): render as text. */
  statement: string;
  generalizable: "yes" | "no" | "unsure";
  scope: "this_group" | "project" | "company";
  reasonCode?: string;
  curated: boolean;
}

export interface Endpoints {
  "GET /api/coord/tests/:testId/hygiene": { req: void; res: TestHygiene };
  "GET /api/coord/reports/files?projectId": { req: void; res: ReportFile[] };
  "GET /api/coord/reports/files/:name?projectId": { req: void; res: ReportFileContent };
  "GET /api/coord/learning/feedback?projectId&source&limit&cursor": { req: void; res: Page<FeedbackRow> };
}

// ─────────────────────────────────────────────────────────────────────────────
// WS-N: next steps ("Qué sigue") and domain flows (docs/domain/next-steps-and-flows.md)
// ─────────────────────────────────────────────────────────────────────────────

/** Domain flows (server/flows/catalog.ts), each mapped to an existing skill procedure. */
export type FlowId = "preparar-ciclo" | "triage" | "acta" | "redactar-issues" | "informe-semanal" | "auditar-modelo" | "curar-reglas";

export type NextStepKind =
  | "new_version"
  | "not_classified"
  | "batch_approved"
  | "batch_stale"
  | "batch_ready"
  | "open_questions"
  | "decisions_to_send"
  | "meeting_notes"
  | "ai_review"
  | "issue_drafts"
  | "issue_checks"
  | "hygiene_unassigned"
  | "hygiene_duplicates"
  | "rule_suggestions"
  | "rule_insights"
  | "weekly_report";

/** UI locations a human step opens (the client builds the URL). */
export type NextStepRoute = "triage" | "batch" | "approvals" | "rules" | "disciplines" | "hygiene" | "reports";

export type NextStepAction =
  | { type: "flow"; flow: FlowId; args: { projectId: string; testKey?: string } }
  | { type: "open"; route: NextStepRoute; params: Record<string, string> };

/** One suggestion, built ONLY from server state (no LLM). */
export interface NextStep {
  /** Stable per kind + target (e.g. "batch_ready:L-2026-11-05-01"). */
  id: string;
  kind: NextStepKind;
  /** Lower = more urgent. */
  priority: number;
  /** Spanish, short. */
  title: string;
  /** Spanish: why the app suggests it now (with the numbers). */
  reason: string;
  counts: Record<string, number>;
  action: NextStepAction;
}

/** GET /next-steps?projectId&testKey */
export interface NextStepsPayload {
  projectId?: string;
  modelSetId?: string;
  testKey?: string;
  version?: number;
  computedAt: string;
  steps: NextStep[];
  /** The app ships the flow agent (agent-runtime/; always true in a normal install). */
  flowsAvailable: boolean;
  /** A flow already running / queued for this project. */
  runningFlow?: FlowRunView;
}

export interface FlowDef {
  id: FlowId;
  /** Spanish label and one-line description (what it will do). */
  label: string;
  description: string;
  /** Skill whose procedure the flow agent follows. */
  skill: string;
  requires: Array<"projectId" | "testKey">;
  costCapUsd: number;
  timeoutMs: number;
  /** coord MCP tools the flow (and its subagents) may use; never apply/approve/publish. */
  tools: string[];
  /** Subagents it may delegate to (Agent tool). */
  subagents: string[];
  /** What it produces (Spanish, for the confirm dialog). */
  produces: string;
}

export type FlowRunState = "queued" | "running" | "finished" | "failed" | "cancelled";
export type FlowStarter = "human" | "agent:chat";

export interface FlowLogLine {
  at: string;
  kind: "status" | "tool" | "text" | "created" | "error";
  /** Spanish, sanitized (never raw model preambles; tool names only). */
  text: string;
}

export interface FlowOutcome {
  proposals: number;
  questions: number;
  issueDrafts: number;
  ruleChanges: number;
  /** Report file names written by generate_report (reports/<projectId>/…). */
  reports: string[];
}

/** One run (persisted in <data home>/flows/<runId>.json). No personal data. */
export interface FlowRunView {
  runId: string;
  flowId: FlowId;
  label: string;
  projectId: string;
  modelSetId?: string;
  testKey?: string;
  state: FlowRunState;
  startedBy: FlowStarter;
  /** Why it was started (chat: the agent's reason; human: the next-step reason). Sanitized. */
  reason?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd?: number;
  costCapUsd: number;
  stoppedBy?: "timeout" | "tool_cap" | "proposal_cap" | "budget";
  error?: { code: string; message: string };
  outcome: FlowOutcome;
  proposalIds: string[];
  questionIds: string[];
  /** The agent's final summary (Spanish, sanitized). */
  summary?: string;
  /** Progress log (last 200 lines). */
  log: FlowLogLine[];
}

/** GET /flows/runs?projectId */
export interface FlowRunsPayload {
  catalog: FlowDef[];
  /** Runtime materialised and the flow agent present. */
  available: boolean;
  unavailableReason?: string;
  /** Agent-started runs today / cap per day. */
  agentRunsToday: number;
  dailyAgentCap: number;
  runs: FlowRunView[];
}

/** POST /flows/:flowId/run */
export interface FlowRunRequest {
  projectId: string;
  testKey?: string;
  reason?: string;
}

/** SSE events of GET /flows/runs/:id/events. */
export type FlowEvent =
  | { type: "status"; state: FlowRunState; detail?: string }
  | { type: "log"; line: FlowLogLine }
  | { type: "created"; id: string; kind: "proposal" | "question" | "report" }
  | { type: "done"; run: FlowRunView }
  | { type: "error"; code: string; message: string; run?: FlowRunView };

export interface Endpoints {
  "GET /api/coord/next-steps?projectId&testKey": { req: void; res: NextStepsPayload };
  "GET /api/coord/flows/runs?projectId": { req: void; res: FlowRunsPayload };
  "GET /api/coord/flows/runs/:id": { req: void; res: FlowRunView };
  "GET /api/coord/flows/runs/:id/events": { req: void; res: FlowEvent };
  "POST /api/coord/flows/:flowId/run": { req: FlowRunRequest; res: FlowRunView };
  "POST /api/coord/flows/runs/:id/cancel": { req: void; res: { cancelled: boolean } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Datos y respaldos (server/data-admin.ts). HUMAN-ONLY: every route needs the CSRF header;
// restore also needs a passkey bound to the uploaded file. There is NO MCP tool for these.
// ─────────────────────────────────────────────────────────────────────────────

export type DataHomeMode = "override" | "fixtures" | "default" | "legacy";
export type BackupKind = "scheduled" | "manual" | "pre-restore";

export interface BackupInfo { name: string; bytes: number; createdAt: string; kind: BackupKind }
export interface BackupSettings {
  /** Absolute path of an external (synced corporate) folder; "" = none. */
  targetDir: string;
  /** Backups kept per kind (daily / others). Default 14. */
  keep: number;
}
export interface DataStatus {
  /** Folder in use. */
  home: string;
  mode: DataHomeMode;
  defaultHome: string;
  legacyHome: string;
  backupsDir: string;
  migration: {
    migratedAt?: string;
    from?: string;
    fileCount?: number;
    /** The old repo folder is still in use (migration pending or failed). */
    pending: boolean;
    error?: { at: string; message: string };
    bothExistWarning?: string;
  };
  settings: BackupSettings;
  backups: BackupInfo[];
  lastBackup?: BackupInfo & { fileCount: number; external?: { ok: boolean; error?: string } };
  lastError?: { at: string; message: string };
  scheduleActive: boolean;
}
export interface DataSettingsRequest { targetDir?: string; keep?: number }
/** POST /data/import (body: the .zip, Content-Type application/zip) → staged, validated, not yet applied. */
export interface DataImportStage {
  id: string;
  payloadHash: string;
  createdAt: string;
  kind: BackupKind | "export";
  fileCount: number;
  bytes: number;
  projects: number;
  warnings: string[];
}
export interface DataRestoreOptions { nonce: string; options: unknown; payloadHash: string }
export interface DataRestoreRequest {
  webauthn?: { nonce: string; origin: string; response: unknown };
  /** Fixtures mode only. */
  demo?: boolean;
}
export interface DataRestoreResult { restoredFiles: number; preRestoreBackup: string; proof: "webauthn" | "demo"; restartRecommended: true }

export interface DataEndpoints {
  "GET /api/coord/data/status": { req: void; res: DataStatus };
  "POST /api/coord/data/backups": { req: void; res: BackupInfo };
  "PUT /api/coord/data/settings": { req: DataSettingsRequest; res: BackupSettings };
  /** application/zip attachment; `projectId` limits it to one project (not restorable). */
  "GET /api/coord/data/export?projectId": { req: void; res: Blob };
  "POST /api/coord/data/import": { req: Blob; res: DataImportStage };
  "GET /api/coord/data/import/:id/restore-options": { req: void; res: DataRestoreOptions };
  "POST /api/coord/data/import/:id/restore": { req: DataRestoreRequest; res: DataRestoreResult };
  "DELETE /api/coord/data/import/:id": { req: void; res: { ok: true } };
}
