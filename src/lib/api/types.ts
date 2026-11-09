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
  SessionInfo,
  Severity,
  TestDocument,
  TestRun,
  TriageChanges,
  TriagePayload,
  UserInfo,
  Validity,
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
