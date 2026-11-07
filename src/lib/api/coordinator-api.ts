/**
 * CoordinatorApi — everything the web UI reads from / writes to the local
 * coordinator server. Two implementations:
 *   - MockCoordinatorApi (./mock): in-memory, realistic Spanish data.
 *   - HttpCoordinatorApi (./http): calls /api/coord/* on the local server.
 *
 * The UI never talks to ACC directly; writes reach ACC only through
 * approveBatch → server apply.
 */
import type {
  AgentStatus,
  ApplyRequest,
  ApplyResponse,
  AuthStatus,
  LoginStartResponse,
  SessionInfo,
  ApplyStatus,
  ApproveRequest,
  Assignee,
  AuditEvent,
  AuditQuery,
  Batch,
  BatchState,
  BatchSummary,
  Calibration,
  Clash,
  ClashGroup,
  CorrectionRow,
  Decision,
  ElementProperties,
  FeedbackInput,
  GroupDetail,
  GroupQuery,
  HomeSummary,
  Hub,
  IssueDraft,
  ModelSetSummary,
  Page,
  PreflightResult,
  ProjectSummary,
  Proposal,
  ReportData,
  ReportScope,
  RuleDetail,
  RuleSuggestion,
  RuleSummary,
  TestRun,
  TriageChanges,
  TriagePayload,
  UserInfo,
} from "./types";

export type ApiMode = "mock" | "http";

export interface CoordinatorApi {
  readonly mode: ApiMode;

  // Auth / session (server-side PKCE; the browser never holds the APS secret)
  getAuthStatus(): Promise<AuthStatus>;
  login(): Promise<LoginStartResponse>;
  logout(): Promise<{ ok: true }>;
  getSession(): Promise<SessionInfo>;
  getCurrentUser(): Promise<UserInfo>;
  getAgentStatus(): Promise<AgentStatus>;
  getHomeSummary(): Promise<HomeSummary>;

  // Projects, model sets, tests
  listHubs(): Promise<Hub[]>;
  listProjects(params?: { hubId?: string; q?: string }): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectSummary>;
  listModelSets(projectId: string): Promise<ModelSetSummary[]>;
  /** Cached tests (id = test key) plus not-yet-ingested ACC tests (`cached: false`). */
  listTests(projectId: string, modelSetId: string): Promise<TestRun[]>;
  /** Download + cache + classify an ACC clash test. Long-running. */
  ingestTest(projectId: string, modelSetId: string, accTestId: string, opts?: { refresh?: boolean }): Promise<{ testKey: string }>;

  // Triage
  /** Whole workspace payload for one test (default: latest). */
  getTriage(projectId: string, modelSetId: string, testId?: string): Promise<TriagePayload>;
  /** Proposals added/updated since `cursor` (polled every 10 s). */
  getTriageChanges(projectId: string, modelSetId: string, testId: string, cursor: string): Promise<TriageChanges>;
  listGroups(query: GroupQuery): Promise<Page<ClashGroup>>;
  getGroup(testId: string, groupId: string): Promise<GroupDetail>;
  listGroupClashes(testId: string, groupId: string, params?: { limit?: number; cursor?: string }): Promise<Page<Clash>>;
  getElementProperties(testId: string, refs: string[]): Promise<ElementProperties[]>;
  listProposals(params: { testId: string; ids?: string[]; limit?: number; cursor?: string }): Promise<Page<Proposal>>;
  listAssignees(projectId: string): Promise<Assignee[]>;

  // Decisions (idempotent by Decision.id)
  saveDecisions(decisions: Decision[]): Promise<{ saved: string[] }>;
  listDecisions(params: { testId?: string; projectId?: string; limit?: number; cursor?: string }): Promise<Page<Decision>>;
  /** Moves decided, unbatched items of this test into a `ready` batch. */
  sendToApproval(params: { projectId: string; modelSetId: string; testId: string }): Promise<Batch>;

  // Batches
  listBatches(params?: { state?: BatchState[]; projectId?: string }): Promise<BatchSummary[]>;
  getBatch(batchId: string): Promise<Batch>;
  preflightBatch(batchId: string): Promise<PreflightResult>;
  setBatchItemsExcluded(batchId: string, itemIds: string[], excluded: boolean): Promise<Batch>;
  updateBatchIssue(batchId: string, itemId: string, issue: Partial<IssueDraft>): Promise<Batch>;
  returnBatchToReview(batchId: string): Promise<Batch>;
  discardBatch(batchId: string): Promise<Batch>;
  /** Signs the HMAC approval; the batch moves to `approved`. Does not write to ACC. */
  approveBatch(batchId: string, req: ApproveRequest): Promise<ApplyStatus>;
  /** dryRun (default true) returns the exact ACC request bodies; dryRun:false writes to ACC. */
  applyBatch(batchId: string, req: ApplyRequest): Promise<ApplyResponse>;
  getApplyStatus(batchId: string): Promise<ApplyStatus>;

  // Learning / rules
  submitFeedback(input: FeedbackInput): Promise<{ feedbackId: string }>;
  listRules(): Promise<RuleSummary[]>;
  getRule(ruleId: string): Promise<RuleDetail>;
  listRuleSuggestions(): Promise<RuleSuggestion[]>;
  decideRuleSuggestion(id: string, decision: "approve" | "reject"): Promise<RuleSuggestion>;
  listCorrections(params?: { projectId?: string; limit?: number; cursor?: string }): Promise<Page<CorrectionRow>>;
  getCalibration(): Promise<Calibration>;

  // Reports / audit
  getReport(scope: ReportScope): Promise<ReportData>;
  listAudit(query: AuditQuery): Promise<Page<AuditEvent>>;
}

/** Error with an HTTP-ish status and a stable code for the UI to translate. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "not_found" | "forbidden" | "not_authenticated" | "server" | "network" | "validation" | "conflict" | "csrf" = "server",
    /** Server error code (e.g. not_ingested, invalid_state, approval_invalid). */
    readonly serverCode?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
