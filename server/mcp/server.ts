/**
 * Builds the `coord` MCP server over a {@link Coordinator}. Handlers only
 * adapt arguments and format envelopes; every rule lives in the service.
 *
 * There is NO approve tool: approving happens only in the web UI (same-origin
 * + CSRF) or the interactive CLI. `apply_approved_proposals` defaults to
 * dryRun and is refused without a valid HMAC-signed human approval.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyApproved, type ApplyResult } from "../approval";
import { AGENT_ACTOR, SERVER_VERSION, type Coordinator } from "../coordinator";
import { hashOf, CoordError } from "../util";
import { TOOLS, type ToolSpec } from "./contracts";
import { capResponse, errorEnvelope, okEnvelope } from "./format";

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Extra = { _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };

const ctx = { actor: AGENT_ACTOR };

export function toolHandlers(coord: Coordinator): Record<string, (a: Args, extra: Extra) => Promise<unknown>> {
  return {
    get_session_status: async () => coord.sessionStatus(),
    set_active_context: async (a) => coord.setActiveContext(a as { projectId: string; modelSetId?: string; testKey?: string }),
    list_projects: async (a) => coord.listProjects(a as never),
    list_model_sets: async (a) => coord.listModelSets(a),
    list_model_set_versions: async (a) => coord.listModelSetVersions(a as never),
    list_clash_tests: async (a) => coord.listClashTests(a),
    ingest_clash_test: async (a, extra) => {
      const token = extra?._meta?.progressToken;
      const progress =
        token !== undefined && extra.sendNotification
          ? (step: string, done: number, total: number) => {
              void extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message: step } }).catch(() => undefined);
            }
          : undefined;
      return coord.ingest(a as never, ctx, progress);
    },
    summarize_clashes: async (a) => coord.summarize(a as never),
    run_classification: async (a) => coord.classify(a, ctx),
    list_groups: async (a) => coord.listGroups(a as never),
    get_group: async (a) => coord.getGroup(a as never),
    list_clashes: async (a) => coord.listClashes(a as never),
    get_element_properties: async (a) => coord.getElementProperties(a as never),
    diff_test_versions: async (a) => coord.diffVersions(a as never),
    get_model_hygiene_stats: async (a) => coord.hygieneStats(a as never),
    propose_classification: async (a) => coord.proposeClassification(a as never, ctx),
    propose_group_action: async (a) => coord.proposeGroupAction(a as never, ctx),
    draft_issue: async (a) => coord.draftIssue(a as never, ctx),
    propose_status_change: async (a) => coord.proposeStatusChange(a as never, ctx),
    list_proposals: async (a) => coord.listProposals(a as never),
    withdraw_proposal: async (a) => coord.withdrawProposal(a as never, ctx),
    record_feedback: async (a) => coord.recordFeedback(a as never, ctx, "agent"),
    list_feedback: async (a) => coord.listFeedback(a as never),
    evaluate_ruleset: async (a) => coord.evaluateRuleset(a as never),
    propose_rule_change: async (a) => coord.proposeRuleChange(a as never, ctx),
    list_disciplines: async (a) => coord.listDisciplines(a as never),
    list_families: async (a) => coord.listFamilies(a as never),
    ask_coordinator: async (a) => coord.askCoordinator(a as never, ctx),
    list_issue_checks: async (a) => coord.listIssueChecks(a as never),
    list_meeting_notes: async (a) => coord.listMeetingNotes(a as never),
    list_questions: async (a) => coord.listQuestions(a as never),
    get_family: async (a) => coord.getFamily(a as never),
    propose_family_decision: async (a) => coord.proposeFamilyDecision(a as never, ctx),
    propose_discipline_mapping: async (a) => coord.proposeDisciplineMapping(a as never, ctx),
    generate_report: async (a) => coord.generateReport(a as never, ctx),
    apply_approved_proposals: async (a) => applyTool(coord, a as { batchId: string; dryRun?: boolean }),
  };
}

/** Apply ONE human-approved batch (dryRun by default). Never approves anything. */
async function applyTool(coord: Coordinator, a: { batchId: string; dryRun?: boolean }) {
  coord.requireLevel(1, "apply_approved_proposals");
  const dryRun = a.dryRun !== false;
  if (!(await coord.store.getBatch(a.batchId))) throw new CoordError("not_found", `Lote ${a.batchId} no existe`, "Usa el id del lote (L-…) que aprobó el coordinador en la UI web.");
  const deps = coord.approvalDeps();
  const r: ApplyResult = await applyApproved(deps, a.batchId, { dryRun, actor: AGENT_ACTOR, includeBodies: dryRun });
  const outcome = r.refused
    ? "refused"
    : dryRun
      ? "would_apply"
      : r.requests.some((q) => q.outcome === "failed" || q.outcome === "refused")
        ? r.requests.some((q) => q.outcome === "applied" || q.outcome === "already_applied")
          ? "partial"
          : "failed"
        : "applied";
  return {
    batchId: a.batchId,
    outcome,
    ...(r.refused ? { refusedReason: r.refused.reason, message: r.refused.message } : {}),
    operations: r.requests.map((q) => ({
      op: q.operation,
      groups: q.groups,
      clashes: q.clashes,
      ...(q.jobId ? { jobId: q.jobId, jobStatus: q.outcome === "applied" || q.outcome === "already_applied" ? "Succeeded" : "Failed" } : {}),
      ...(q.createdIssueIds?.length ? { createdIssueIds: q.createdIssueIds } : {}),
      ...(q.message ? { error: q.message } : {}),
      ...(q.outcome === "already_applied" ? { alreadyApplied: true } : {}),
      ...(dryRun ? { method: "POST", path: q.path, body: q.body } : {}),
    })),
    batchState: r.batchState,
    auditId: r.auditId ?? "",
  };
}

export interface CreateServerOptions {
  /** Audit every tool call (default true). */
  audit?: boolean;
}

export function createCoordServer(coord: Coordinator, opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "coord", version: SERVER_VERSION }, { capabilities: { logging: {} } });
  const handlers = toolHandlers(coord);
  for (const spec of TOOLS) registerOne(server, coord, spec, handlers[spec.name]!, opts.audit !== false);
  return server;
}

function registerOne(server: McpServer, coord: Coordinator, spec: ToolSpec, handler: (a: Args, extra: Extra) => Promise<unknown>, audit: boolean): void {
  server.registerTool(
    spec.name,
    { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
    (async (args: Args, extra: Extra) => {
      let env;
      if (coord.effectiveLevel < spec.minLevel) {
        env = errorEnvelope(new CoordError("autonomy_level_forbids", `${spec.name} requiere nivel L${spec.minLevel}; el nivel efectivo es L${coord.effectiveLevel}.`));
      } else {
        try {
          const parsed = spec.input.parse(args ?? {});
          env = okEnvelope(await handler(parsed, extra));
        } catch (err) {
          env = errorEnvelope(err);
        }
      }
      const text = capResponse(env, coord.config.agent.maxResponseTokens);
      if (audit) {
        await coord.store
          .audit({
            actor: AGENT_ACTOR,
            action: "tool.call",
            details: { tool: spec.name, inputHash: hashOf(args ?? {}).slice(0, 16), ok: env.ok, error: env.ok ? null : env.error?.code ?? null, bytes: text.length, truncated: text.includes("\"truncated\":true") },
          })
          .catch(() => undefined);
      }
      return { content: [{ type: "text" as const, text }], ...(env.ok ? {} : { isError: true }) };
    }) as never,
  );
}
