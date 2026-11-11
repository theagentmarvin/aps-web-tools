/**
 * Coordinator web API types used by the UI.
 *
 * The wire contract is owned by the server: `server/api/contract.ts` (types
 * only). This module re-exports it so `src/` has a single source of truth,
 * and adds the few UI-only types and runtime constants the UI needs.
 *
 * Vocabulary is the engine's (docs/domain/clash-taxonomy.md):
 *   Validity = real | false_positive | tolerated | needs_info
 *   Nature   = hard | clearance | duplicate | workflow   (duplicates live here)
 *   Severity = critical | high | medium | low | none
 *   Priority = 1..4 (P1–P4 bands computed by the server)
 */
export type {
  AccStatus,
  AgentStatus,
  ApplyRequest,
  ApplyResponse,
  ApplyStatus,
  ApproveRequest,
  ApproveOptionsResponse,
  AuthenticationResponseJSON,
  RegisterOptionsResponse,
  RegisterRequest,
  RegistrationResponseJSON,
  Assignee,
  AuditEvent,
  AuditQuery,
  AuthStatus,
  Batch,
  BatchItem,
  BatchOperation,
  BatchState,
  BatchSummary,
  BatchRebaseResult,
  Calibration,
  CalibrationBand,
  Clash,
  ClashGroup,
  ConfidenceBandName,
  CorrectionRow,
  Decision,
  DecisionChange,
  DecisionField,
  DecisionKind,
  Delta,
  Discipline,
  DisciplineCode,
  ElementInfo,
  ElementProperties,
  FeedbackInput,
  FieldSource,
  GroupDetail,
  GroupQuery,
  HistoryEntry,
  HomeSummary,
  Hub,
  IssueDraft,
  IssueState,
  LoginStartResponse,
  ModelSetSummary,
  Nature,
  Page,
  PreflightResult,
  PreviousDecision,
  Priority,
  ProjectNotes,
  ProjectSummary,
  Proposal,
  ProposalField,
  ProposedAction,
  ReasonCode,
  ReportData,
  ReportScope,
  RuleDetail,
  RuleEffect,
  RuleState,
  RuleSuggestion,
  RuleSummary,
  RuleImpact,
  RulePublicationView,
  RulePublishOptions,
  RulePublishRequest,
  RuleChangeKind,
  RuleChangePreview,
  RuleChangeRequest,
  RuleDefinition,
  RuleInsights,
  RuleLibraryRow,
  RuleRow,
  RuleShadow,
  RulesOverview,
  RuleThreshold,
  ChatCard,
  SessionInfo,
  Severity,
  TestDocument,
  TestRun,
  TriageChanges,
  TriagePayload,
  UserInfo,
  Validity,
} from "../../../server/api/contract";
export type { AccIssueType, IssueAssigneeMapping, IssueSettings } from "../../../server/api/contract";
export type {
  BackupInfo,
  BackupSettings,
  DataImportStage,
  DataRestoreOptions,
  DataRestoreRequest,
  DataRestoreResult,
  DataSettingsRequest,
  DataStatus,
} from "../../../server/api/contract";

import type { ReasonCode, Validity, Nature, Severity } from "../../../server/api/contract";

/** Runtime list of reason codes (the contract's const is not imported at runtime). */
export const REASON_CODES: readonly ReasonCode[] = ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R99"];

export const VALIDITIES: readonly Validity[] = ["real", "false_positive", "tolerated", "needs_info"];
export const NATURES: readonly Nature[] = ["hard", "clearance", "duplicate", "workflow"];
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "none"];

/** UI decision state of a row (spec §3.3). */
export type DecisionState = "pending" | "accepted" | "corrected" | "rejected" | "postponed" | "inherited";

/**
 * Model-derived text may arrive wrapped as `{ untrusted, flagged? }` (MCP
 * convention). The UI renders it as plain text only (never HTML).
 */
export type MaybeUntrusted = string | { untrusted: string; flagged?: string } | null | undefined;

export function plain(v: MaybeUntrusted | unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "untrusted" in (v as object)) return String((v as { untrusted: unknown }).untrusted ?? "");
  return String(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clash grid, ingest jobs, project disciplines — wire types from the server
// contract; UI-only view models below.
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ClashGridCell as GridCell,
  DisciplineConfig,
  DisciplinePreview,
  DisciplineRule,
  IngestJob,
  ModelSetView,
} from "../../../server/api/contract";
import type { ClashGrid as WireClashGrid, ClashGridDocument as WireGridDocument, Discipline as WireDiscipline, DisciplineRule as WireRule, IngestJob as WireJob, TestRun as WireTestRun } from "../../../server/api/contract";

/**
 * Grid document as the UI uses it. `folderPath` is not in the server contract
 * yet (requested): it tells apart two files with the same name.
 */
export type GridDocument = WireGridDocument & { folderPath?: string };
export type ClashGrid = Omit<WireClashGrid, "documents"> & { documents: GridDocument[] };

export type GridState = ClashGrid["state"];
export type IngestPhase = WireJob["phase"];

/** Discipline code for "not assigned yet". */
export const UNASSIGNED = "SIN";

/** Test as listed on the model set page (TestRun carries state/delta/documentCount). */
export type TestRunInfo = WireTestRun;

export interface TestsOverview {
  tests: TestRunInfo[];
  views: import("../../../server/api/contract").ModelSetView[];
}

/** POST …/ingest: new servers return a job id; older ones returned the test key directly. */
export interface IngestStart {
  jobId?: string;
  testKey?: string;
}

/** A rule as edited in the UI (server fills id/createdBy/createdAt). */
export type DisciplineRuleInput = Pick<WireRule, "match" | "value" | "field" | "discipline"> & { id?: string };

export interface SetDisciplineRequest {
  discipline: string;
  /** Also save a project naming rule (applies to other matching files). */
  createRule?: DisciplineRuleInput;
}

/** PUT …/discipline returns the regrouped grid, or a job when reclassification runs in the background. */
export type SetDisciplineResult = ClashGrid | { jobId: string };

/** Agent discipline_mapping proposal, parsed from DisciplineConfig.pendingProposals. */
export interface DisciplineSuggestion {
  id: string;
  summary: string;
  rationale: string;
  discipline: string;
  lineageUrns: string[];
  fileNames: string[];
  rule?: DisciplineRuleInput;
  confidence?: number;
}

/** Normalised DisciplineConfig for the UI. */
export interface ProjectDisciplines {
  version?: number;
  disciplines: WireDiscipline[];
  rules: DisciplineRuleInput[];
  suggestions: DisciplineSuggestion[];
  /** True when the server has no /disciplines endpoint yet (read-only fallback). */
  unsupported?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Solution families (docs/domain/solution-families-proposal.md §4–§5): wire
// types from the server contract. Every family field is optional on groups and
// on the triage payload, so older classifications (no families) still load.
// ─────────────────────────────────────────────────────────────────────────────

export type {
  FamiliesPayload,
  FamilyAction,
  FamilyDecision,
  FamilyDecisionFields,
  FamilyDecisionPreview,
  FamilyDecisionRequest,
  FamilyException,
  FamilyInstance,
  FamilyTag,
  InstanceInheritance,
  ProblemTypeCode,
  ProblemTypeInfo,
  TriageFamily,
} from "../../../server/api/contract";
import type { ClashGroup as WireGroup, FamilyDecisionFields as WireDecisionFields, TriageFamily as WireFamily, TriagePayload as WirePayload } from "../../../server/api/contract";

/** A group as an instance of its family (the contract carries the optional family, change and ACC fields). */
export type FamilyGroup = WireGroup;
export type TriagePayloadWithFamilies = WirePayload;

// M2 (F1 decision memory + X3 coordinator questions): wire types from the server contract.
export type { CoordinatorQuestion, InheritedDecision, QuestionAnswerRequest, QuestionOption } from "../../../server/api/contract";
export type { InheritConfirmReason, InheritedConfirmItem, InheritedConfirmList, InheritedConfirmRequest, InheritedConfirmResult } from "../../../server/api/contract";
export type AgentQuestion = import("../../../server/api/contract").CoordinatorQuestion;

/** Verification reject reasons (M3, F2). Labels in i18n reasons.V01… */
export const VERIFICATION_REASON_CODES = ["V01", "V02", "V03", "V04", "V05"] as const;
export type VerificationReasonCode = (typeof VERIFICATION_REASON_CODES)[number];


/** A family (grupo), including the M1 changeCounts / acc. */
export type FamilyView = WireFamily;

// M1 (docs/PLAN-core-features-simplified.md): change since the previous version (F1),
// ACC state of assigned/closed groups (X1), scope guard (X6).
export type { AccState, AccSyncSummary, ChangeCounts, ChangeKind, ChangeSummary, ScopeChange } from "../../../server/api/contract";
export type AccGroupState = import("../../../server/api/contract").AccState;

/** A clash delta may become "out_of_scope" (X6): never shown as resolved. Today the server only sends the count (changeSummary.outOfScope). */
export function isOutOfScope(c: { delta: string }): boolean {
  return c.delta === "out_of_scope";
}

export type IssueMode = "family" | "per_instance";

/**
 * POST /families/:familyId/exceptions ({testId, groupId, fields, reason}) or,
 * with `remove`, DELETE /families/:familyId/exceptions/:groupId?testId=.
 * The router validates the body; the contract has no named type for it yet.
 */
export interface FamilyExceptionRequest {
  testId: string;
  groupId: string;
  reason: string;
  fields?: Partial<WireDecisionFields>;
  /** true = remove the exception. */
  remove?: boolean;
  /** Agent proposal (propose_family_exception) this exception accepts. */
  proposalId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// M3 (F2 verification, F5 follow-up): READ-ONLY issue checks — wire types from the contract.
// ─────────────────────────────────────────────────────────────────────────────
export type { IssueCheck, IssueChecksPayload, IssueGate, IssueReminder, IssueVerdict, IssueVerdictDecisionRequest } from "../../../server/api/contract";
export type DisciplineReminder = import("../../../server/api/contract").IssueReminder;
/** GET /tests/:t/reminders (normalised by the client: the server may send the array or an envelope). */
export interface RemindersPayload {
  testId: string;
  reminders: DisciplineReminder[];
}

// ─────────────────────────────────────────────────────────────────────────────
// M4 (F4 meeting): agenda, meeting notes, saved viewer views — wire types from the contract.
// ─────────────────────────────────────────────────────────────────────────────
export type { AgendaDiscipline, AgendaItem, AgendaKind, AgendaPayload, MeetingNote, MeetingNoteRequest, SavedViewerView } from "../../../server/api/contract";
export type NoteTargetType = import("../../../server/api/contract").MeetingNote["targetType"];
export type SavedView = import("../../../server/api/contract").SavedViewerView;
/** GET /tests/:t/notes (normalised by the client: the server may send the array or an envelope). */
export interface NotesPayload {
  testId: string;
  notes: import("../../../server/api/contract").MeetingNote[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent chat (owner decision 2026-11-10): propose-only domain agent spawned by
// the server as a local Claude Code sub-agent. PROVISIONAL — built from the
// orchestrator brief while Coder C writes server/api/contract.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** An element selected in the viewer, resolved to a model-set document. */
export interface ChatSelectedElement {
  documentId: number;
  dbId: number;
}
/** What is sent with a message (auto-filled from the workspace; the user can drop chips). */
export interface ChatContext {
  lens?: string;
  view?: string;
  /** Focused row: grupo (family), ubicación (group), clash, issue or tree node. */
  focus?: { kind: "family" | "group" | "clash" | "issue" | "node"; id: string; label?: string };
  /** Viewer selection, capped at 200. */
  selection?: ChatSelectedElement[];
  selectionTruncated?: boolean;
}
export interface ChatRequest {
  projectId: string;
  modelSetId: string;
  testId: string;
  /** Continue an existing conversation (history per test). */
  chatId?: string;
  message: string;
  context: ChatContext;
  /** "Nueva conversación": start a new Claude session for this test. */
  newSession?: boolean;
}
export type ChatErrorCode = "claude_not_found" | "not_logged_in" | "timeout" | "busy" | "failed" | "cancelled" | "mcp_unavailable" | "rate_limited";
export const CHAT_ERROR_CODES: readonly ChatErrorCode[] = ["claude_not_found", "not_logged_in", "timeout", "busy", "failed", "cancelled", "mcp_unavailable", "rate_limited"];
/** A proposal the agent created (propose-only): applied by a human through the existing paths. */
export interface ChatProposal {
  id: string;
  kind: "decision" | "family_decision" | "regroup" | "question" | (string & {});
  summary: string;
  /** G12: server-built card (action, validity, target name and clash count; questions in full). */
  card?: import("../../../server/api/contract").ChatCard;
  targetCount?: number;
  familyId?: string;
  groupIds?: string[];
  clashIds?: string[];
  questionId?: string;
}
/** SSE events of POST /chat. */
export type ChatEvent =
  | { type: "status"; text: string; chatId?: string }
  | { type: "delta"; text: string }
  | { type: "proposal"; proposal: ChatProposal }
  /** WS-N: a flow the agent started (server card from the flow store). */
  | { type: "flow"; run: FlowRunView }
  /** WS-N: next steps the server computed when the agent asked. */
  | { type: "next_steps"; steps: NextStep[] }
  | { type: "done"; chatId?: string; cost?: number; durationMs?: number }
  | { type: "error"; code: ChatErrorCode; message: string };
export interface ChatMessage {
  role: "user" | "agent";
  text: string;
  at: string;
  proposals?: ChatProposal[];
  /** WS-N: flow runs started in this turn and suggested next steps (server data). */
  flows?: FlowRunView[];
  nextSteps?: NextStep[];
  context?: ChatContext;
  /** Agent turns: USD cost and duration (shown small and muted). */
  cost?: number;
  durationMs?: number;
}
/** GET /chat/status: is Claude Code installed and signed in (no email). */
export interface ChatStatus {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
}
/** GET /chat/:chatId */
export interface ChatHistory {
  chatId: string;
  testId: string;
  messages: ChatMessage[];
}

// Human-side parity (docs/ai/agent-human-parity.md): hygiene, report files, agent/UI feedback.
export type { FeedbackRow, FeedbackSource, HygieneCheck, ReportFile, ReportFileContent, TestHygiene } from "../../../server/api/contract";

// WS-N: "Qué sigue" and domain flows (docs/domain/next-steps-and-flows.md).
export type {
  FlowDef,
  FlowEvent,
  FlowId,
  FlowLogLine,
  FlowOutcome,
  FlowRunRequest,
  FlowRunsPayload,
  FlowRunState,
  FlowRunView,
  NextStep,
  NextStepAction,
  NextStepKind,
  NextStepRoute,
  NextStepsPayload,
} from "../../../server/api/contract";
import type { FlowRunView, NextStep } from "../../../server/api/contract";
