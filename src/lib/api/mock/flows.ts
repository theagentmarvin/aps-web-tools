/**
 * Mock "Qué sigue" + flows (WS-N): a fixed, plausible cycle state and simulated flow runs that log
 * progress for a few seconds and finish with proposals / questions / a report. Same shapes as the
 * server (server/next-steps.ts, server/flows/). Nothing here writes anywhere.
 */
import { FLOWS } from "../../../../server/flows/catalog";
import { ApiError } from "../coordinator-api";
import type { FlowEvent, FlowId, FlowLogLine, FlowRunRequest, FlowRunsPayload, FlowRunView, NextStep, NextStepRoute, NextStepsPayload } from "../types";

const STEPS: Array<Omit<NextStep, "action"> & { flow?: FlowId; open?: { route: NextStepRoute; params?: Record<string, string> } }> = [
  { id: "ai_review", kind: "ai_review", priority: 35, title: "Revisión IA de 12 ubicaciones", reason: "El motor marcó 12 ubicaciones para revisión humana y 12 aún no tienen propuesta del agente: la IA las revisa primero y deja propuestas o preguntas.", counts: { pending: 12, needsReview: 12 }, flow: "triage" },
  { id: "open_questions", kind: "open_questions", priority: 25, title: "Responder 2 preguntas del agente", reason: "El agente no pudo decidir 2 casos con los datos y te pregunta; tu respuesta se vuelve decisión.", counts: { questions: 2 }, open: { route: "triage", params: { lente: "cambios" } } },
  { id: "issue_drafts", kind: "issue_drafts", priority: 40, title: "Redactar 7 incidencias P1–P2", reason: "7 ubicaciones reales P1–P2 sin borrador de incidencia ni incidencia en ACC.", counts: { groups: 7, p1: 3 }, flow: "redactar-issues" },
  { id: "weekly_report", kind: "weekly_report", priority: 70, title: "Generar el informe semanal", reason: "El ciclo ya tiene 1 lote y aún no tiene informe semanal.", counts: { batches: 1, pendingReview: 0 }, flow: "informe-semanal" },
];

const LOG: string[] = ["Fijé el contexto del proyecto.", "Clasifiqué la versión: 12 ubicaciones requieren revisión.", "Delegué 12 ubicaciones al revisor en un lote.", "Dejé 5 propuestas y 1 pregunta para tu revisión."];

export class MockFlows {
  private runs: FlowRunView[] = [];
  private listeners = new Map<string, Set<(e: FlowEvent) => void>>();
  private timers = new Map<string, number[]>();

  nextSteps(params: { projectId?: string; testKey?: string }): NextStepsPayload {
    const projectId = params.projectId ?? "demo";
    const testKey = params.testKey ?? "T-demo0001";
    const running = this.runs.find((r) => r.projectId === projectId && (r.state === "queued" || r.state === "running"));
    const done = new Set(this.runs.filter((r) => r.projectId === projectId && r.state === "finished").map((r) => r.flowId));
    const steps: NextStep[] = STEPS.filter((s) => !s.flow || !done.has(s.flow))
      .map(({ flow, open, ...s }) => ({
        ...s,
        id: `${s.id}:${testKey}`,
        action: flow ? { type: "flow" as const, flow, args: { projectId, testKey } } : { type: "open" as const, route: open!.route, params: { projectId, modelSetId: "ms-1", testKey, ...(open!.params ?? {}) } },
      }))
      .sort((a, b) => a.priority - b.priority);
    return { projectId, testKey, version: 42, computedAt: new Date().toISOString(), steps, flowsAvailable: true, ...(running ? { runningFlow: structuredClone(running) } : {}) };
  }

  list(projectId?: string): FlowRunsPayload {
    return {
      catalog: [...FLOWS],
      available: true,
      agentRunsToday: this.runs.filter((r) => r.startedBy === "agent:chat").length,
      dailyAgentCap: 10,
      runs: structuredClone(this.runs.filter((r) => !projectId || r.projectId === projectId)),
    };
  }

  get(runId: string): FlowRunView {
    const r = this.runs.find((x) => x.runId === runId);
    if (!r) throw new ApiError(`Flujo ${runId} no existe`, 404, "not_found");
    return structuredClone(r);
  }

  start(flowId: FlowId, req: FlowRunRequest, startedBy: FlowRunView["startedBy"] = "human"): FlowRunView {
    const def = FLOWS.find((f) => f.id === flowId);
    if (!def) throw new ApiError(`El flujo «${flowId}» no está en el catálogo.`, 400, "validation");
    if (this.runs.some((r) => r.projectId === req.projectId && (r.state === "queued" || r.state === "running"))) throw new ApiError("Ya hay un flujo en curso en este proyecto: espera a que termine o cancélalo.", 409, "conflict");
    const now = new Date().toISOString();
    const run: FlowRunView = {
      runId: `FR-${now.slice(0, 10).replace(/-/g, "")}-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`,
      flowId,
      label: def.label,
      projectId: req.projectId,
      ...(req.testKey ? { testKey: req.testKey } : {}),
      state: "running",
      startedBy,
      ...(req.reason ? { reason: req.reason } : {}),
      createdAt: now,
      startedAt: now,
      costCapUsd: def.costCapUsd,
      outcome: { proposals: 0, questions: 0, issueDrafts: 0, ruleChanges: 0, reports: [] },
      proposalIds: [],
      questionIds: [],
      log: [],
    };
    this.runs.unshift(run);
    const timers: number[] = [];
    LOG.forEach((text, i) =>
      timers.push(
        window.setTimeout(() => {
          const line: FlowLogLine = { at: new Date().toISOString(), kind: "text", text };
          run.log.push(line);
          this.emit(run.runId, { type: "log", line });
        }, 900 * (i + 1)),
      ),
    );
    timers.push(
      window.setTimeout(() => {
        run.state = "finished";
        run.finishedAt = new Date().toISOString();
        run.costUsd = 0.37;
        run.outcome = { proposals: 5, questions: 1, issueDrafts: flowId === "redactar-issues" ? 5 : 0, ruleChanges: 0, reports: flowId === "informe-semanal" ? ["2026-11-11-weekly-T-demo0001.html"] : [] };
        run.proposalIds = ["P-20261111-0101", "P-20261111-0102", "P-20261111-0103", "P-20261111-0104", "P-20261111-0105"];
        run.questionIds = ["Q-demo00001"];
        run.summary = "Revisé las ubicaciones pendientes: dejé 5 propuestas y 1 pregunta. Revísalas en el espacio de coordinación y envía lo aceptado a aprobación.";
        this.emit(run.runId, { type: "done", run: structuredClone(run) });
      }, 900 * (LOG.length + 1)),
    );
    this.timers.set(run.runId, timers);
    return structuredClone(run);
  }

  cancel(runId: string): { cancelled: boolean } {
    const r = this.runs.find((x) => x.runId === runId);
    if (!r || (r.state !== "running" && r.state !== "queued")) return { cancelled: false };
    for (const t of this.timers.get(runId) ?? []) window.clearTimeout(t);
    r.state = "cancelled";
    r.finishedAt = new Date().toISOString();
    r.error = { code: "cancelled", message: "Cancelado." };
    this.emit(runId, { type: "error", code: "cancelled", message: "Cancelado.", run: structuredClone(r) });
    return { cancelled: true };
  }

  async watch(runId: string, onEvent: (e: FlowEvent) => void, signal?: AbortSignal): Promise<void> {
    const r = this.get(runId);
    for (const line of r.log) onEvent({ type: "log", line });
    if (r.state === "finished") return onEvent({ type: "done", run: r });
    if (r.state === "failed" || r.state === "cancelled") return onEvent({ type: "error", code: r.error?.code ?? r.state, message: r.error?.message ?? "", run: r });
    await new Promise<void>((resolve) => {
      const set = this.listeners.get(runId) ?? new Set();
      const l = (e: FlowEvent) => {
        onEvent(e);
        if (e.type === "done" || e.type === "error") {
          set.delete(l);
          resolve();
        }
      };
      set.add(l);
      this.listeners.set(runId, set);
      signal?.addEventListener("abort", () => {
        set.delete(l);
        resolve();
      });
    });
  }

  private emit(runId: string, e: FlowEvent) {
    for (const l of [...(this.listeners.get(runId) ?? [])]) l(e);
  }
}
