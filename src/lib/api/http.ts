/**
 * HttpCoordinatorApi — talks to the local coordinator server (server/api).
 * All endpoints live under /api/coord and exchange JSON. Errors are returned
 * as `{ error: { code, message } }` with a matching HTTP status.
 *
 * Endpoints expected from the server:
 *
 *   GET    /api/coord/me                                         → UserInfo
 *   GET    /api/coord/agent/status                               → AgentStatus
 *   GET    /api/coord/home                                       → HomeSummary
 *   GET    /api/coord/hubs                                       → Hub[]
 *   GET    /api/coord/projects?hubId=&q=                         → ProjectSummary[]
 *   GET    /api/coord/projects/:projectId                        → ProjectSummary
 *   GET    /api/coord/projects/:projectId/model-sets             → ModelSetSummary[]
 *   GET    /api/coord/projects/:projectId/model-sets/:modelSetId/tests → TestRun[]
 *   GET    /api/coord/triage/:projectId/:modelSetId?test=        → TriagePayload
 *   GET    /api/coord/triage/:projectId/:modelSetId/changes?test=&since= → TriageChanges
 *   GET    /api/coord/tests/:testId/groups?pair=&priority=&validity=&level=&accStatus=&delta=&sort=&limit=&cursor= → Page<ClashGroup>
 *   GET    /api/coord/tests/:testId/groups/:groupId              → GroupDetail
 *   GET    /api/coord/tests/:testId/groups/:groupId/clashes?limit=&cursor= → Page<Clash>
 *   POST   /api/coord/tests/:testId/elements/properties  {refs}  → ElementProperties[]
 *   GET    /api/coord/tests/:testId/proposals?ids=&limit=&cursor= → Page<Proposal>
 *   GET    /api/coord/projects/:projectId/assignees              → Assignee[]
 *   POST   /api/coord/triage/decisions        body Decision[]    → { saved: string[] }   (idempotent by id)
 *   GET    /api/coord/decisions?testId=&projectId=&limit=&cursor= → Page<Decision>
 *   POST   /api/coord/batches  {projectId, modelSetId, testId}   → Batch   (send to approval)
 *   GET    /api/coord/batches?state=&projectId=                  → BatchSummary[]
 *   GET    /api/coord/batches/:batchId                           → Batch
 *   POST   /api/coord/batches/:batchId/preflight                 → PreflightResult
 *   PATCH  /api/coord/batches/:batchId/items  {itemIds, excluded} → Batch
 *   PATCH  /api/coord/batches/:batchId/items/:itemId/issue  Partial<IssueDraft> → Batch
 *   POST   /api/coord/batches/:batchId/return                    → Batch
 *   POST   /api/coord/batches/:batchId/discard                   → Batch
 *   POST   /api/coord/batches/:batchId/approve  ApproveRequest   → ApplyStatus
 *   GET    /api/coord/batches/:batchId/apply-status              → ApplyStatus
 *   POST   /api/coord/feedback  FeedbackInput                    → { feedbackId }
 *   GET    /api/coord/rules                                      → RuleSummary[]
 *   GET    /api/coord/rules/:ruleId                              → RuleDetail
 *   GET    /api/coord/rule-suggestions                           → RuleSuggestion[]
 *   POST   /api/coord/rule-suggestions/:id/decision {decision}   → RuleSuggestion
 *   GET    /api/coord/learning/corrections?projectId=&limit=&cursor= → Page<CorrectionRow>
 *   GET    /api/coord/learning/calibration                       → Calibration
 *   GET    /api/coord/reports?projectId=&modelSetId=&from=&to=   → ReportData
 *   GET    /api/coord/audit?project=&user=&action=&from=&to=&batch=&limit=&cursor= → Page<AuditEvent>
 */
import { ApiError, type CoordinatorApi } from "./coordinator-api";
import type * as T from "./types";

const BASE = "/api/coord";

type Query = Record<string, string | number | string[] | number[] | undefined>;

function qs(params?: Query): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

export class HttpCoordinatorApi implements CoordinatorApi {
  readonly mode = "http" as const;

  private async req<R>(method: string, path: string, body?: unknown): Promise<R> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch (err) {
      throw new ApiError(String(err), 0, "network");
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) message = j.error.message;
      } catch {
        /* non-JSON error body */
      }
      const code =
        res.status === 404 ? "not_found" : res.status === 403 ? "forbidden" : res.status === 401 ? "not_authenticated" : res.status === 400 ? "validation" : "server";
      throw new ApiError(message, res.status, code);
    }
    return (await res.json()) as R;
  }

  private get<R>(path: string, q?: Query) {
    return this.req<R>("GET", `${path}${qs(q)}`);
  }

  getCurrentUser() { return this.get<T.UserInfo>("/me"); }
  getAgentStatus() { return this.get<T.AgentStatus>("/agent/status"); }
  getHomeSummary() { return this.get<T.HomeSummary>("/home"); }

  listHubs() { return this.get<T.Hub[]>("/hubs"); }
  listProjects(p?: { hubId?: string; q?: string }) { return this.get<T.ProjectSummary[]>("/projects", p); }
  getProject(projectId: string) { return this.get<T.ProjectSummary>(`/projects/${enc(projectId)}`); }
  listModelSets(projectId: string) { return this.get<T.ModelSetSummary[]>(`/projects/${enc(projectId)}/model-sets`); }
  listTests(projectId: string, modelSetId: string) {
    return this.get<T.TestRun[]>(`/projects/${enc(projectId)}/model-sets/${enc(modelSetId)}/tests`);
  }

  getTriage(projectId: string, modelSetId: string, testId?: string) {
    return this.get<T.TriagePayload>(`/triage/${enc(projectId)}/${enc(modelSetId)}`, { test: testId });
  }
  getTriageChanges(projectId: string, modelSetId: string, testId: string, cursor: string) {
    return this.get<T.TriageChanges>(`/triage/${enc(projectId)}/${enc(modelSetId)}/changes`, { test: testId, since: cursor });
  }
  listGroups(q: T.GroupQuery) {
    return this.get<T.Page<T.ClashGroup>>(`/tests/${enc(q.testId)}/groups`, {
      ...q.filter,
      sort: q.sort,
      limit: q.limit,
      cursor: q.cursor,
    });
  }
  getGroup(testId: string, groupId: string) {
    return this.get<T.GroupDetail>(`/tests/${enc(testId)}/groups/${enc(groupId)}`);
  }
  listGroupClashes(testId: string, groupId: string, p?: { limit?: number; cursor?: string }) {
    return this.get<T.Page<T.Clash>>(`/tests/${enc(testId)}/groups/${enc(groupId)}/clashes`, p);
  }
  getElementProperties(testId: string, refs: string[]) {
    return this.req<T.ElementProperties[]>("POST", `/tests/${enc(testId)}/elements/properties`, { refs });
  }
  listProposals(p: { testId: string; ids?: string[]; limit?: number; cursor?: string }) {
    return this.get<T.Page<T.Proposal>>(`/tests/${enc(p.testId)}/proposals`, { ids: p.ids, limit: p.limit, cursor: p.cursor });
  }
  listAssignees(projectId: string) { return this.get<T.Assignee[]>(`/projects/${enc(projectId)}/assignees`); }

  saveDecisions(decisions: T.Decision[]) { return this.req<{ saved: string[] }>("POST", "/triage/decisions", decisions); }
  listDecisions(p: { testId?: string; projectId?: string; limit?: number; cursor?: string }) {
    return this.get<T.Page<T.Decision>>("/decisions", p);
  }
  sendToApproval(p: { projectId: string; modelSetId: string; testId: string }) {
    return this.req<T.Batch>("POST", "/batches", p);
  }

  listBatches(p?: { state?: T.BatchState[]; projectId?: string }) { return this.get<T.BatchSummary[]>("/batches", p); }
  getBatch(id: string) { return this.get<T.Batch>(`/batches/${enc(id)}`); }
  preflightBatch(id: string) { return this.req<T.PreflightResult>("POST", `/batches/${enc(id)}/preflight`); }
  setBatchItemsExcluded(id: string, itemIds: string[], excluded: boolean) {
    return this.req<T.Batch>("PATCH", `/batches/${enc(id)}/items`, { itemIds, excluded });
  }
  updateBatchIssue(id: string, itemId: string, issue: Partial<T.IssueDraft>) {
    return this.req<T.Batch>("PATCH", `/batches/${enc(id)}/items/${enc(itemId)}/issue`, issue);
  }
  returnBatchToReview(id: string) { return this.req<T.Batch>("POST", `/batches/${enc(id)}/return`); }
  discardBatch(id: string) { return this.req<T.Batch>("POST", `/batches/${enc(id)}/discard`); }
  approveBatch(id: string, r: T.ApproveRequest) { return this.req<T.ApplyStatus>("POST", `/batches/${enc(id)}/approve`, r); }
  getApplyStatus(id: string) { return this.get<T.ApplyStatus>(`/batches/${enc(id)}/apply-status`); }

  submitFeedback(input: T.FeedbackInput) { return this.req<{ feedbackId: string }>("POST", "/feedback", input); }
  listRules() { return this.get<T.RuleSummary[]>("/rules"); }
  getRule(id: string) { return this.get<T.RuleDetail>(`/rules/${enc(id)}`); }
  listRuleSuggestions() { return this.get<T.RuleSuggestion[]>("/rule-suggestions"); }
  decideRuleSuggestion(id: string, decision: "approve" | "reject") {
    return this.req<T.RuleSuggestion>("POST", `/rule-suggestions/${enc(id)}/decision`, { decision });
  }
  listCorrections(p?: { projectId?: string; limit?: number; cursor?: string }) {
    return this.get<T.Page<T.CorrectionRow>>("/learning/corrections", p);
  }
  getCalibration() { return this.get<T.Calibration>("/learning/calibration"); }

  getReport(scope: T.ReportScope) { return this.get<T.ReportData>("/reports", { ...scope }); }
  listAudit(q: T.AuditQuery) { return this.get<T.Page<T.AuditEvent>>("/audit", { ...q }); }
}
