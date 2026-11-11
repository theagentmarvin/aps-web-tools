/**
 * Creating a flow run (queued) — the single entry point for both starters:
 *  - a human, through POST /flows/:flowId/run (CSRF + same-origin; server/api/router.ts);
 *  - the chat agent, through the MCP tool start_flow (chat mode only; server/mcp/server.ts).
 * Checks: the flow is in the catalog, the installed harness has the flow agent, the project / test
 * exist, one active run per project and (agent) the daily cap. The web server then runs it.
 */
import type * as C from "../api/contract";
import type { Coordinator } from "../coordinator";
import { sanitizeModelText } from "../sanitize";
import { bareProjectId, CoordError } from "../util";
import { FLOW_AGENT_MISSING, loadFlowAgent } from "./agent";
import { flowDef } from "./catalog";
import { FlowRunStore, runView, type FlowRunRecord } from "./store";

export interface FlowRequest {
  flowId: string;
  projectId?: string;
  testKey?: string;
  reason?: string;
  startedBy: C.FlowStarter;
}

/** Latest classified test of a project (the active context's when it is the newest of its model set). */
async function defaultTest(coord: Coordinator, projectId: string): Promise<string | undefined> {
  const tests = (await coord.store.listTests()).filter((t) => bareProjectId(t.projectId) === projectId).sort((a, b) => b.modelSetVersion - a.modelSetVersion || (a.ingestedAt < b.ingestedAt ? 1 : -1));
  const ctx = await coord.store.getContext();
  if (ctx?.testKey && tests.some((t) => t.testKey === ctx.testKey) && (await coord.store.hasClassification(ctx.testKey))) {
    const t = tests.find((x) => x.testKey === ctx.testKey)!;
    if (!tests.some((x) => x.modelSetId === t.modelSetId && x.modelSetVersion > t.modelSetVersion)) return t.testKey;
  }
  for (const t of tests) if (await coord.store.hasClassification(t.testKey)) return t.testKey;
  return undefined;
}

export async function requestFlowRun(coord: Coordinator, req: FlowRequest, opts: { agentRoot?: string } = {}): Promise<FlowRunRecord> {
  const def = flowDef(req.flowId);
  if (!def) throw new CoordError("validation_error", `El flujo «${req.flowId}» no está en el catálogo.`, "Flujos: preparar-ciclo, triage, acta, redactar-issues, informe-semanal, auditar-modelo, curar-reglas.");
  if (!loadFlowAgent(opts.agentRoot ?? coord.root)) throw new CoordError("invalid_state", FLOW_AGENT_MISSING, "Instala la actualización del agente desde el aviso de la app (passkey).");
  let projectId = req.projectId ? bareProjectId(req.projectId) : undefined;
  let testKey = req.testKey;
  let modelSetId: string | undefined;
  if (testKey) {
    const t = await coord.store.getTest(testKey);
    if (!t) throw new CoordError("not_found", `El test ${testKey} no está en caché.`);
    if (projectId && bareProjectId(t.projectId) !== projectId) throw new CoordError("validation_error", "El test no pertenece a ese proyecto.");
    projectId = bareProjectId(t.projectId);
    modelSetId = t.modelSetId;
  }
  if (!projectId) {
    const ctx = await coord.store.getContext();
    if (ctx?.projectId) projectId = bareProjectId(ctx.projectId);
  }
  if (!projectId) throw new CoordError("validation_error", "Indica el proyecto del flujo.");
  if (def.requires.includes("testKey") && !testKey) {
    testKey = await defaultTest(coord, projectId);
    if (!testKey) throw new CoordError("not_classified", `«${def.label}» necesita una versión clasificada del proyecto.`, "Primero «Preparar el ciclo».");
    modelSetId = (await coord.store.getTest(testKey))?.modelSetId;
  }
  if (testKey && def.requires.includes("testKey") && !(await coord.store.hasClassification(testKey))) {
    throw new CoordError("not_classified", `El test ${testKey} no está clasificado.`, "Primero «Preparar el ciclo».");
  }
  return new FlowRunStore(coord.store).create(
    {
      flowId: def.id,
      label: def.label,
      projectId,
      ...(modelSetId ? { modelSetId } : {}),
      ...(testKey ? { testKey } : {}),
      startedBy: req.startedBy,
      ...(req.reason ? { reason: sanitizeModelText(req.reason, 300) } : {}),
      costCapUsd: def.costCapUsd,
    },
    { now: coord.now(), dailyAgentCap: coord.config.flows.dailyAgentCap },
  );
}

/** MCP get_flow_status / start_flow output (compact, no log lines from other runs). */
export function flowStatusForAgent(r: FlowRunRecord) {
  const v = runView(r);
  return {
    runId: v.runId,
    flowId: v.flowId,
    label: v.label,
    state: v.state,
    projectId: v.projectId,
    ...(v.testKey ? { testKey: v.testKey } : {}),
    startedBy: v.startedBy,
    createdAt: v.createdAt,
    ...(v.startedAt ? { startedAt: v.startedAt } : {}),
    ...(v.finishedAt ? { finishedAt: v.finishedAt } : {}),
    outcome: v.outcome,
    proposalIds: v.proposalIds.slice(0, 50),
    questionIds: v.questionIds.slice(0, 20),
    ...(v.error ? { error: v.error } : {}),
    ...(v.stoppedBy ? { stoppedBy: v.stoppedBy } : {}),
    ...(v.costUsd !== undefined ? { costUsd: v.costUsd } : {}),
    note:
      v.state === "queued" || v.state === "running"
        ? "El flujo corre en el servidor de la app; el coordinador ve el avance en Flujos. No esperes en un bucle: consulta de nuevo solo si te lo piden."
        : "Resultado: solo propuestas, preguntas, borradores o informes; nada se aplicó en ACC. El coordinador decide en la UI.",
  };
}
