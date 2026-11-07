/**
 * HttpCoordinatorApi — talks to the local coordinator server (server/api).
 * All endpoints live under /api/coord and exchange JSON. Errors are returned
 * as `{ error: { code, message } }` with a matching HTTP status.
 *
 * Endpoints expected from the server:
 *
 *   GET    /api/coord/csrf                                       → {token} + coord_csrf cookie
 *   GET    /api/coord/auth/status                                → AuthStatus
 *   POST   /api/coord/auth/login   (H)                           → LoginStartResponse
 *   POST   /api/coord/auth/logout  (H)                           → {ok}
 *   GET    /api/coord/session                                    → SessionInfo
 *   POST   /api/coord/projects/:p/model-sets/:m/tests/:accTestId/ingest (H) {refresh?,classify?} → {testKey}
 *   POST   /api/coord/batches/:batchId/apply (H) {dryRun?=true}  → ApplyResponse
 *   (H) = human-only: X-Coord-CSRF header + same origin. The client sends the header on every non-GET call.
 *   Types: server/api/contract.ts. Full table: docs/api.md.
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

/**
 * Model-derived text can arrive wrapped as `{untrusted, flagged?}` (MCP
 * convention). The UI only ever renders text, so unwrap to the plain string at
 * the boundary; flagged agent content is surfaced via `Proposal.flagged`.
 */
export function unwrapUntrusted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapUntrusted);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if ("untrusted" in o && keys.every((k) => k === "untrusted" || k === "flagged")) return String(o.untrusted ?? "");
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = unwrapUntrusted(o[k]);
    return out;
  }
  return v;
}

export class HttpCoordinatorApi implements CoordinatorApi {
  readonly mode = "http" as const;
  private csrf: Promise<string> | null = null;

  /** CSRF token for human-only calls (double submit with the coord_csrf cookie). */
  private token(refresh = false): Promise<string> {
    if (!this.csrf || refresh) {
      this.csrf = fetch(`${BASE}/csrf`, { credentials: "same-origin" })
        .then((r) => r.json() as Promise<{ token: string }>)
        .then((j) => j.token)
        .catch((err) => {
          this.csrf = null;
          throw new ApiError(String(err), 0, "network");
        });
    }
    return this.csrf;
  }

  private async req<R>(method: string, path: string, body?: unknown, retried = false): Promise<R> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Every mutating call carries the CSRF header (required on human-only endpoints, harmless elsewhere).
    if (method !== "GET") headers["X-Coord-CSRF"] = await this.token();
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch (err) {
      throw new ApiError(String(err), 0, "network");
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let serverCode: string | undefined;
      let hint: string | undefined;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string; hint?: string } };
        if (j.error?.message) message = j.error.message;
        serverCode = j.error?.code;
        hint = j.error?.hint;
      } catch {
        /* non-JSON error body */
      }
      const isCsrf = res.status === 403 && /csrf/i.test(message);
      // Token may be stale (server restarted): refresh once and retry.
      if (isCsrf && !retried && method !== "GET") {
        await this.token(true);
        return this.req<R>(method, path, body, true);
      }
      const code =
        isCsrf ? "csrf"
        : res.status === 404 ? "not_found"
        : res.status === 403 ? "forbidden"
        : res.status === 401 ? "not_authenticated"
        : res.status === 409 ? "conflict"
        : res.status === 400 ? "validation"
        : "server";
      throw new ApiError(message, res.status, code, serverCode, hint);
    }
    return unwrapUntrusted(await res.json()) as R;
  }

  private get<R>(path: string, q?: Query) {
    return this.req<R>("GET", `${path}${qs(q)}`);
  }

  getAuthStatus() { return this.get<T.AuthStatus>("/auth/status"); }
  login() { return this.req<T.LoginStartResponse>("POST", "/auth/login"); }
  logout() { return this.req<{ ok: true }>("POST", "/auth/logout"); }
  getSession() { return this.get<T.SessionInfo>("/session"); }
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

  ingestTest(projectId: string, modelSetId: string, accTestId: string, opts?: { refresh?: boolean }) {
    return this.req<{ testKey: string }>("POST", `/projects/${enc(projectId)}/model-sets/${enc(modelSetId)}/tests/${enc(accTestId)}/ingest`, { refresh: opts?.refresh ?? false, classify: true });
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
  applyBatch(id: string, r: T.ApplyRequest) { return this.req<T.ApplyResponse>("POST", `/batches/${enc(id)}/apply`, { dryRun: r.dryRun ?? true }); }
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
