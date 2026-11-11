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
  AccIssueType,
  IssueSettings,
  AgentStatus,
  InheritedConfirmList,
  InheritedConfirmRequest,
  InheritedConfirmResult,
  ApplyRequest,
  ClashGrid,
  DisciplineConfig,
  DisciplinePreview,
  DisciplineRuleInput,
  SetDisciplineRequest,
  SetDisciplineResult,
  IngestJob,
  IngestStart,
  TestsOverview,
  ApproveOptionsResponse,
  RegisterOptionsResponse,
  RegisterRequest,
  ApplyResponse,
  AuthStatus,
  LoginStartResponse,
  SessionInfo,
  ApplyStatus,
  ApproveRequest,
  Assignee,
  Batch,
  BatchState,
  BatchSummary,
  BatchRebaseResult,
  Calibration,
  Clash,
  ClashGroup,
  CorrectionRow,
  Decision,
  ElementProperties,
  FeedbackInput,
  GroupDetail,
  GroupQuery,
  Hub,
  IssueDraft,
  ModelSetSummary,
  Page,
  PreflightResult,
  ProjectSummary,
  Proposal,
  RuleDetail,
  RuleSuggestion,
  RuleSummary,
  TestRun,
  TriageChanges,
  TriagePayloadWithFamilies,
  AgentQuestion,
  ChatEvent,
  ChatHistory,
  ChatStatus,
  ChatRequest,
  AgendaPayload,
  MeetingNote,
  NoteTargetType,
  NotesPayload,
  SavedView,
  IssueChecksPayload,
  IssueCheck,
  IssueVerdictDecisionRequest,
  RemindersPayload,
  QuestionAnswerRequest,
  FamiliesPayload,
  FamilyDecisionPreview,
  FamilyDecisionRequest,
  FamilyExceptionRequest,
  UserInfo,
} from "./types";
import type * as P from "./types";

export type ApiMode = "mock" | "http";

export interface CoordinatorApi {
  readonly mode: ApiMode;

  // Auth / session (server-side PKCE; the browser never holds the APS secret)
  getAuthStatus(): Promise<AuthStatus>;
  /** Starts the server-side Autodesk login; `returnTo` = app path to come back to. */
  login(returnTo?: string): Promise<LoginStartResponse>;
  logout(): Promise<{ ok: true }>;
  getSession(): Promise<SessionInfo>;
  getCurrentUser(): Promise<UserInfo>;
  getAgentStatus(): Promise<AgentStatus>;

  // Projects, model sets, tests
  listHubs(): Promise<Hub[]>;
  listProjects(params?: { hubId?: string; q?: string }): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectSummary>;
  listModelSets(projectId: string): Promise<ModelSetSummary[]>;
  /** Cached tests (id = test key) plus not-yet-ingested ACC tests (`cached: false`). */
  listTests(projectId: string, modelSetId: string): Promise<TestRun[]>;
  /** Tests with grid state / delta, plus the model set views ("¿Qué se está comparando?"). */
  getTestsOverview(projectId: string, modelSetId: string): Promise<TestsOverview>;
  /** Start downloading + classifying an ACC clash test. Returns a job to poll (or, from older servers, the test key). */
  ingestTest(projectId: string, modelSetId: string, accTestId: string, opts?: { refresh?: boolean }): Promise<IngestStart>;
  getIngestJob(jobId: string): Promise<IngestJob>;
  /** Clash grid of a test (test key or ACC test id; default: latest analysed). */
  getClashGrid(projectId: string, modelSetId: string, test?: string): Promise<ClashGrid>;
  /** Assign a document discipline (human-only), optionally saving a naming rule. Returns the grid or a reclassification job. */
  setDocumentDiscipline(projectId: string, modelSetId: string, lineageUrn: string, req: SetDisciplineRequest, test?: string): Promise<SetDisciplineResult>;
  /** Discipline codes + the project naming rules (ordered) + agent discipline_mapping suggestions. */
  getProjectDisciplines(projectId: string): Promise<DisciplineConfig>;
  /** What the given rules (in order) match among the project documents. */
  previewDisciplineRules(projectId: string, req: { modelSetId?: string; rules: DisciplineRuleInput[] }): Promise<DisciplinePreview>;
  saveDisciplineRules(projectId: string, rules: DisciplineRuleInput[], version?: number): Promise<unknown>;
  /** Record the decision on an agent discipline_mapping proposal (accepting also sends the PUT …/discipline). */
  decideDisciplineSuggestion(projectId: string, proposalId: string, decision: "approve" | "reject"): Promise<unknown>;

  // Triage
  /** Whole workspace payload for one test (default: latest). */
  getTriage(projectId: string, modelSetId: string, testId?: string): Promise<TriagePayloadWithFamilies>;
  /** Solution families of a test (GET /tests/:testId/families). */
  getFamilies(testId: string): Promise<FamiliesPayload>;
  /** What a family decision would touch (validity changes to acknowledge, issues, spot-check need). */
  previewFamilyDecision(familyId: string, req: FamilyDecisionRequest): Promise<FamilyDecisionPreview>;
  /** Approve or reject one family decision (human-only, CSRF). Nothing reaches ACC until an approved batch. */
  decideFamily(familyId: string, req: FamilyDecisionRequest): Promise<unknown>;
  /** M3 (read-only): ACC issues checked against a test, with a verdict each. */
  getIssueChecks(testId: string): Promise<IssueChecksPayload>;
  /** M3: copy-ready follow-up reminder per responsible discipline. */
  getReminders(testId: string): Promise<RemindersPayload>;
  /** M3: accept / reject a verdict (V01–V05 on reject). READ-ONLY against ACC. */
  decideIssueVerdict(testId: string, issueId: string, req: IssueVerdictDecisionRequest): Promise<IssueCheck>;
  /** M4: meeting agenda (server order) per responsible discipline. */
  getAgenda(testId: string): Promise<AgendaPayload>;
  getNotes(testId: string): Promise<NotesPayload>;
  /** Save (autosave) a meeting note; empty text clears it. */
  putNote(testId: string, targetType: NoteTargetType, targetId: string, text: string): Promise<MeetingNote>;
  getFamilyView(testId: string, familyId: string): Promise<SavedView | null>;
  /** Stores the viewer camera for the meeting (local only, never sent to ACC). */
  putFamilyView(testId: string, familyId: string, camera: unknown): Promise<SavedView>;
  /**
   * Agent chat (propose-only): POST /chat streams SSE events (status / delta /
   * proposal / done / error). Resolves when the stream ends; abort with `signal`.
   */
  chat(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
  /** History of a conversation (one per test, chatId kept by the UI). */
  getChat(testId: string, chatId?: string): Promise<ChatHistory>;
  /** Cancel the running agent turn. */
  cancelChat(chatId: string): Promise<void>;
  /** Claude Code installed / signed in (checked before the first message; no email). */
  getChatStatus(): Promise<ChatStatus>;
  /** Human-only: apply (default) or reject a regroup proposal after an explicit confirmation. POST /proposals/:id/regroup. */
  applyRegroup(proposalId: string, testId: string, decision?: "apply" | "reject"): Promise<unknown>;
  /** X3: answer a coordinator question; validity/action answers create the decision server-side. */
  answerQuestion(questionId: string, req: QuestionAnswerRequest): Promise<AgentQuestion>;
  /** Instance exception (mandatory reason) or its removal. PROVISIONAL route (§5.3). */
  setFamilyException(familyId: string, req: FamilyExceptionRequest): Promise<unknown>;
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
  /** G3 "Llevar decisiones a vN": new ready, unapproved batch on the latest analysed version; the old one is superseded. */
  rebaseBatch(batchId: string): Promise<BatchRebaseResult>;
  /** Signs the HMAC approval; the batch moves to `approved`. Does not write to ACC. */
  approveBatch(batchId: string, req: ApproveRequest): Promise<ApplyStatus>;
  /** WebAuthn step 1: options whose challenge is derived from the exact batch payload (2-minute nonce). */
  getApproveOptions(batchId: string, excludedItemIds: string[]): Promise<ApproveOptionsResponse>;
  /** Passkey enrolment options: first passkey needs the CLI code; more need a step-up assertion. */
  getRegisterOptions(): Promise<RegisterOptionsResponse>;
  registerPasskey(req: RegisterRequest): Promise<{ credentialId: string; label: string; enrolledVia: "enroll-code" | "step-up" }>;
  /** dryRun (default true) returns the exact ACC request bodies; dryRun:false writes to ACC. */
  applyBatch(batchId: string, req: ApplyRequest): Promise<ApplyResponse>;
  getApplyStatus(batchId: string): Promise<ApplyStatus>;

  // Learning / rules
  submitFeedback(input: FeedbackInput): Promise<{ feedbackId: string }>;
  listRules(): Promise<RuleSummary[]>;
  getRule(ruleId: string): Promise<RuleDetail>;
  listRuleSuggestions(): Promise<RuleSuggestion[]>;
  decideRuleSuggestion(id: string, decision: "approve" | "reject"): Promise<RuleSuggestion>;
  /** G15: WebAuthn options for Publicar / Revertir (challenge bound to the files written). */
  getRulePublishOptions(id: string, op: "publish" | "revert"): Promise<import("./types").RulePublishOptions>;
  /** G15: human-only; passkey assertion (live) or demo (fixtures). Re-runs the evaluation, writes the rules. */
  publishRuleSuggestion(id: string, op: "publish" | "revert", req: import("./types").RulePublishRequest): Promise<RuleSuggestion>;
  listCorrections(params?: { projectId?: string; limit?: number; cursor?: string }): Promise<Page<CorrectionRow>>;
  getCalibration(): Promise<Calibration>;

  // Agent harness update (human-only; passkey). No agent tool reaches these.
  /** harness-staging/ vs the installed .claude/ + CLAUDE.md. */
  getHarnessStatus(): Promise<import("./types").HarnessStatus>;
  /** Unified diff installed → staged of one staged file. */
  getHarnessDiff(path: string): Promise<import("./types").HarnessDiff>;
  /** WebAuthn options bound to the exact files the install writes. */
  getHarnessInstallOptions(): Promise<import("./types").HarnessInstallOptions>;
  /** Installs harness-staging/ into .claude/ (backup + audit). Requires a fresh passkey assertion. */
  installHarness(req: import("./types").HarnessInstallRequest): Promise<import("./types").HarnessInstallResult>;

  // G4/G5: project ACC issue settings (GET-only toward ACC; local writes, human-only)
  listIssueTypes(projectId: string): Promise<AccIssueType[]>;
  getIssueSettings(projectId: string): Promise<IssueSettings>;
  setIssueType(projectId: string, req: { typeId: string; subtypeId: string; label: string } | { clear: true }): Promise<IssueSettings>;
  setIssueAssignee(projectId: string, discipline: string, assignee: { id: string; type: "user" | "role" | "company"; label: string } | null): Promise<IssueSettings>;
  decideIssueSettingsSuggestion(projectId: string, proposalId: string, decision: "accept" | "reject"): Promise<IssueSettings>;

  // G7 (ws-C): "Confirmar heredadas sin cambio" (optional: the mock may not implement it)
  getInheritedConfirmations?(testId: string): Promise<InheritedConfirmList>;
  confirmInheritedBulk?(testId: string, req: Omit<InheritedConfirmRequest, "testId">): Promise<InheritedConfirmResult>;
  // ── Human-side parity (docs/ai/agent-human-parity.md #10, #31, #32, #62, #68, #70, #71) ──
  /** Model hygiene stats of a test (same numbers as the agent's get_model_hygiene_stats). */
  getTestHygiene(testId: string): Promise<P.TestHygiene>;
  /** Cycle KPIs (GET /reports), the base of the "Informe del ciclo". */
  getReport(scope: P.ReportScope): Promise<P.ReportData>;
  /** Report files the agent wrote with generate_report (newest first). */
  listReportFiles(projectId: string): Promise<P.ReportFile[]>;
  getReportFile(projectId: string, name: string): Promise<P.ReportFileContent>;
  /** Project conventions (.coordinator/projects/<id>/notes.md). */
  getProjectNotes(projectId: string): Promise<P.ProjectNotes>;
  /** Human-only: append one dated, confirmed line to notes.md. */
  appendProjectNote(projectId: string, text: string, kind?: string): Promise<P.ProjectNotes>;
  /** Feedback recorded by the UI and by the agent (record_feedback), with its origin. No user names. */
  listFeedback(params?: { projectId?: string; source?: P.FeedbackSource[]; limit?: number; cursor?: string }): Promise<Page<P.FeedbackRow>>;
  /** Reglas: active rules (by pair, use and acierto in a classified test), Biblioteca, alerts. */
  getRulesOverview(testKey?: string): Promise<P.RulesOverview>;
  /** Human-only: impact / shadowing / safety of a calibrate · edit · retire · restore (writes nothing). */
  previewRuleChange(change: P.RuleChangeRequest, testKey?: string): Promise<P.RuleChangePreview>;
  /** Human-only: the change becomes a rule suggestion (origin coordinador) at stage propuesta. */
  createRuleSuggestion(req: { change: P.RuleChangeRequest; rationale: string; title?: string; testKey?: string }): Promise<P.RuleSuggestion>;
  /** Human-only: move one location (group) out of a family into its own family. Local only. */
  detachFamilyInstance(familyId: string, req: { testId: string; groupId: string }): Promise<FamiliesPayload>;
  /** Human-only: merge family `from` into `into`. Local only. */
  mergeFamilies(req: { testId: string; from: string; into: string }): Promise<FamiliesPayload>;

  // ── WS-N: "Qué sigue" and domain flows (docs/domain/next-steps-and-flows.md) ──
  /** Ordered next steps of a project / test, computed by the server (no LLM). */
  getNextSteps(params: { projectId?: string; testKey?: string }): Promise<import("./types").NextStepsPayload>;
  /** Flow catalog, availability (installed flow agent), daily agent cap and recent runs. */
  listFlowRuns(projectId?: string): Promise<import("./types").FlowRunsPayload>;
  getFlowRun(runId: string): Promise<import("./types").FlowRunView>;
  /** Human-only: queue a catalog flow (one per project); it produces proposals / questions / drafts / reports only. */
  runFlow(flowId: import("./types").FlowId, req: import("./types").FlowRunRequest): Promise<import("./types").FlowRunView>;
  /** Human-only: cancel a queued or running flow. */
  cancelFlowRun(runId: string): Promise<{ cancelled: boolean }>;
  /** Progress events of a run (SSE; replayed from the start). Resolves when the stream ends. */
  watchFlowRun(runId: string, onEvent: (e: import("./types").FlowEvent) => void, signal?: AbortSignal): Promise<void>;
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
