/**
 * Flow runner (web server process). Runs queued flow runs one at a time per project with the
 * `coordinador-flujos` agent, headless, exactly like the chat (server/chat/bridge.ts: same binary
 * resolution, child env, MCP config, caps and SIGINT → SIGTERM), streams progress to SSE listeners,
 * persists the run + event log (server/flows/store.ts) and audits flow.started / finished / cancelled.
 *
 * Runs are created by requestFlowRun (human route or the chat's start_flow); queued runs written by
 * the chat's MCP process are picked up by {@link FlowService.pickup} (called by the chat service as
 * soon as start_flow returns, and by a slow poll).
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type * as C from "../api/contract";
import { ensureAgentRuntime } from "../agent-runtime";
import { agentEnv, authStatus, ChatRunError, childEnv, createdId, headlessArgs, mcpConfigJson, resolveClaudeBin, runClaude, type ResolvedBin } from "../chat/bridge";
import { CHAT_AGENT_ACTOR, FLOW_AGENT_ACTOR, type Coordinator } from "../coordinator";
import { sanitizeModelText, sanitizeMultilineText } from "../sanitize";
import type { Actor } from "../store/types";
import { CoordError, log, nowIso } from "../util";
import { FLOW_AGENT, FLOW_AGENT_MISSING, flowAllowedTools, flowBuiltins, flowDisallowed, flowPrompt, loadFlowAgent, skillBody } from "./agent";
import { FLOWS, flowDef } from "./catalog";
import { requestFlowRun } from "./request";
import { FlowRunStore, isRunId, runView, type FlowRunRecord } from "./store";

type Listener = (e: C.FlowEvent, last: boolean) => void;

/** Tool calls / created items per flow run (higher than the chat: subagents work in batches). */
export const FLOW_TOOL_CAP = 400;
export const FLOW_PROPOSAL_CAP = 200;
const KEEP_FINISHED_MS = 10 * 60_000;
const POLL_MS = 4_000;

interface LiveRun {
  runId: string;
  events: C.FlowEvent[];
  listeners: Set<Listener>;
  finished: boolean;
  cancelled?: boolean;
  stop?: () => void;
}

export interface FlowServiceOptions {
  resolveBin?: () => ResolvedBin | undefined;
  /** App folder holding agent-runtime/ (tests). Default coord.root. */
  agentRoot?: string;
  /** Where the runtime is materialised (tests; default: server/agent-runtime.ts runtimeBaseFor). */
  runtimeBase?: string;
  /** Override every flow's timeout (tests). */
  timeoutMs?: number;
  model?: string;
}

const TOOL_LABEL: Record<string, string> = {
  ingest_clash_test: "Descargando la prueba de ACC",
  run_classification: "Clasificando con el motor",
  summarize_clashes: "Resumiendo interferencias",
  list_groups: "Listando ubicaciones",
  list_families: "Listando grupos",
  get_group: "Revisando una ubicación",
  get_family: "Revisando un grupo",
  diff_test_versions: "Comparando versiones",
  get_model_hygiene_stats: "Calculando higiene",
  list_issue_checks: "Verificando incidencias",
  list_meeting_notes: "Leyendo notas de reunión",
  get_rule_insights: "Buscando condiciones sin regla",
  propose_classification: "Creando propuesta",
  propose_family_decision: "Creando propuesta de grupo",
  propose_status_change: "Creando propuesta",
  propose_group_action: "Creando propuesta de reagrupación",
  draft_issue: "Redactando incidencia",
  ask_coordinator: "Preguntando al coordinador",
  propose_rule_change: "Creando sugerencia de regla",
  generate_report: "Generando informe",
  Agent: "Delegando a un subagente",
};

export class FlowService {
  readonly runs: FlowRunStore;
  private readonly live = new Map<string, LiveRun>();
  private readonly projectsRunning = new Set<string>();
  private poll?: NodeJS.Timeout;

  constructor(
    private readonly coord: Coordinator,
    private readonly opts: FlowServiceOptions = {},
  ) {
    this.runs = new FlowRunStore(coord.store);
    void this.markInterrupted();
  }

  private get root(): string {
    return this.opts.agentRoot ?? this.coord.root;
  }

  /** Runs left "running" by another (dead) server process. */
  private async markInterrupted(): Promise<void> {
    try {
      for (const r of await this.runs.list()) {
        if (r.state === "running" && r.pid !== process.pid) {
          await this.runs.update(r.runId, (x) => {
            x.state = "failed";
            x.finishedAt = nowIso(this.coord.now());
            x.error = { code: "interrupted", message: "El servidor se cerró mientras el flujo corría." };
          });
        }
      }
    } catch (err) {
      log.warn("flows.mark_interrupted", { message: (err as Error).message });
    }
  }

  /** Slow poll for runs queued by the chat's MCP process (unref: never keeps the process alive). */
  startPolling(ms = POLL_MS): void {
    if (this.poll) return;
    this.poll = setInterval(() => void this.pickup().catch(() => undefined), ms);
    this.poll.unref?.();
  }

  stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** The materialised in-app agent runtime folder (server/agent-runtime.ts), or undefined. */
  runtimeDir(): string | undefined {
    try {
      return ensureAgentRuntime(this.coord, { appRoot: this.root, ...(this.opts.runtimeBase ? { base: this.opts.runtimeBase } : {}) })?.dir;
    } catch (err) {
      log.warn("flows.runtime", { message: (err as Error).message });
      return undefined;
    }
  }

  /** Runtime materialised + flow agent present (always true after start in a normal install). */
  available(): { available: boolean; reason?: string } {
    return loadFlowAgent(this.runtimeDir()) ? { available: true } : { available: false, reason: FLOW_AGENT_MISSING };
  }

  /** GET /flows/runs */
  async overview(projectId?: string): Promise<C.FlowRunsPayload> {
    const a = this.available();
    return {
      catalog: [...FLOWS],
      available: a.available,
      ...(a.reason ? { unavailableReason: a.reason } : {}),
      agentRunsToday: await this.runs.agentRunsToday(this.coord.now()),
      dailyAgentCap: this.coord.config.flows.dailyAgentCap,
      runs: (await this.runs.list(projectId ? { projectId } : {})).slice(0, 50).map(runView),
    };
  }

  async get(runId: string): Promise<C.FlowRunView> {
    const r = await this.runs.get(runId);
    if (!r) throw new CoordError("not_found", `Flujo ${runId} no existe`);
    return runView(r);
  }

  /** POST /flows/:flowId/run (human). */
  async start(flowId: string, req: C.FlowRunRequest, user: { id: string; name: string }): Promise<C.FlowRunView> {
    const rec = await requestFlowRun(this.coord, { flowId, projectId: req.projectId, ...(req.testKey ? { testKey: req.testKey } : {}), ...(req.reason ? { reason: req.reason } : {}), startedBy: "human" }, { agentRoot: this.root });
    this.launch(rec, { type: "user", id: user.id, name: "Coordinador" });
    return runView(rec);
  }

  /** Start queued runs (all, or one id). Returns the ids launched. */
  async pickup(runId?: string): Promise<string[]> {
    const queued = runId ? [await this.runs.get(runId)].filter((r): r is FlowRunRecord => !!r) : await this.runs.list();
    const out: string[] = [];
    const now = this.coord.now();
    for (const r of queued) {
      if (r.state !== "queued" || this.live.has(r.runId)) continue;
      if (!this.runs.isActive(r, now)) {
        await this.runs.update(r.runId, (x) => {
          x.state = "failed";
          x.finishedAt = nowIso(now);
          x.error = { code: "expired", message: "El flujo quedó en cola sin servidor que lo ejecutara." };
        });
        continue;
      }
      this.launch(r, r.startedBy === "agent:chat" ? CHAT_AGENT_ACTOR : { type: "user", id: "ui", name: "Coordinador" });
      out.push(r.runId);
    }
    return out;
  }

  /** POST /flows/runs/:id/cancel. A queued run is cancelled at once; a running one gets SIGINT then SIGTERM. */
  async cancel(runId: string, by: Actor): Promise<{ cancelled: boolean }> {
    if (!isRunId(runId)) throw new CoordError("validation_error", "runId inválido.");
    const live = this.live.get(runId);
    if (live && !live.finished) {
      live.cancelled = true;
      live.stop?.();
      return { cancelled: true };
    }
    const r = await this.runs.get(runId);
    if (!r) throw new CoordError("not_found", `Flujo ${runId} no existe`);
    if (r.state !== "queued") return { cancelled: false };
    const done = await this.runs.update(runId, (x) => {
      x.state = "cancelled";
      x.finishedAt = nowIso(this.coord.now());
    });
    await this.audit(done, "flow.cancelled", by);
    return { cancelled: true };
  }

  /** SSE: replays what was emitted, then streams. A finished run replays its stored event log. */
  async subscribe(runId: string, listener: Listener): Promise<() => void> {
    const live = this.live.get(runId);
    if (live) {
      live.events.forEach((e, i) => listener(e, live.finished && i === live.events.length - 1));
      if (live.finished) return () => undefined;
      live.listeners.add(listener);
      return () => live.listeners.delete(listener);
    }
    const r = await this.runs.get(runId);
    if (!r) throw new CoordError("not_found", `Flujo ${runId} no existe`);
    const events = await this.runs.events(runId);
    const terminal = r.state !== "queued" && r.state !== "running";
    const all: C.FlowEvent[] = terminal && !events.some((e) => e.type === "done" || e.type === "error") ? [...events, { type: "done", run: runView(r) }] : events;
    all.forEach((e, i) => listener(e, terminal && i === all.length - 1));
    if (!terminal) {
      // Queued by another process and not picked yet: report the state; the client polls GET /flows/runs/:id.
      listener({ type: "status", state: r.state }, false);
    }
    return () => undefined;
  }

  private emit(live: LiveRun, e: C.FlowEvent): void {
    if (live.finished) return;
    const last = e.type === "done" || e.type === "error";
    live.events.push(e);
    if (last) live.finished = true;
    void this.runs.appendEvent(live.runId, e).catch(() => undefined);
    for (const l of live.listeners) {
      try {
        l(e, last);
      } catch {
        // a broken SSE connection must not stop the run
      }
    }
    if (last) {
      live.listeners.clear();
      setTimeout(() => this.live.delete(live.runId), KEEP_FINISHED_MS).unref?.();
    }
  }

  private async audit(r: FlowRunRecord, action: "flow.started" | "flow.finished" | "flow.cancelled", actor: Actor): Promise<void> {
    await this.coord.store
      .audit({
        actor,
        action,
        projectId: r.projectId,
        ...(r.modelSetId ? { modelSetId: r.modelSetId } : {}),
        ...(r.testKey ? { testId: r.testKey } : {}),
        targetIds: [r.runId, ...r.proposalIds.slice(0, 10), ...r.questionIds.slice(0, 5)],
        details: {
          flow: r.flowId,
          startedBy: r.startedBy,
          state: r.state,
          proposals: r.outcome.proposals,
          questions: r.outcome.questions,
          reports: r.outcome.reports.length,
          costUsd: r.costUsd ?? null,
          error: r.error?.code ?? null,
        },
      })
      .catch(() => undefined);
  }

  private launch(rec: FlowRunRecord, actor: Actor): void {
    const live: LiveRun = { runId: rec.runId, events: [], listeners: new Set(), finished: false };
    this.live.set(rec.runId, live);
    void this.execute(rec, live, actor).catch((err) => log.warn("flows.unhandled", { message: (err as Error).message }));
  }

  private async execute(rec: FlowRunRecord, live: LiveRun, starter: Actor): Promise<void> {
    const def = flowDef(rec.flowId)!;
    const key = rec.projectId;
    const run: FlowRunRecord = { ...rec };
    const line = (kind: C.FlowLogLine["kind"], text: string) => {
      const l: C.FlowLogLine = { at: nowIso(this.coord.now()), kind, text: sanitizeModelText(text, 300) };
      run.log.push(l);
      if (run.log.length > 200) run.log = run.log.slice(-200);
      this.emit(live, { type: "log", line: l });
    };
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = async () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      const snap = { ...run };
      await this.runs.update(run.runId, (x) => Object.assign(x, snap)).catch(() => undefined);
    };
    const flushSoon = () => {
      flushTimer ??= setTimeout(() => void flush(), 500);
    };

    // One running flow per project in this process (the store check covers other processes' queues).
    if (this.projectsRunning.has(key)) {
      run.state = "failed";
      run.finishedAt = nowIso(this.coord.now());
      run.error = { code: "conflict", message: "Ya hay un flujo en curso en este proyecto." };
      await flush();
      this.emit(live, { type: "error", code: "conflict", message: run.error.message, run: runView(run) });
      return;
    }
    this.projectsRunning.add(key);
    let text = "";
    let paragraph = "";
    const pending: Array<Promise<void>> = [];
    try {
      run.state = "running";
      run.startedAt = nowIso(this.coord.now());
      run.pid = process.pid;
      await flush();
      this.emit(live, { type: "status", state: "running" });
      await this.audit(run, "flow.started", starter);
      line("status", `Iniciando «${def.label}»${run.testKey ? ` sobre ${run.testKey}` : ""}.`);
      if (live.cancelled) throw new ChatRunError("cancelled", "Cancelado.");

      const bin = (this.opts.resolveBin ?? (() => resolveClaudeBin()))();
      if (!bin) throw new ChatRunError("claude_not_found", "Claude Code no está instalado (https://code.claude.com).");
      const auth = await authStatus(bin, childEnv());
      if (!auth.installed) throw new ChatRunError("claude_not_found", "Claude Code no está instalado (https://code.claude.com).");
      if (!auth.loggedIn) throw new ChatRunError("not_logged_in", "Claude Code no tiene sesión iniciada. Abre una terminal y ejecuta `claude`, luego `/login`.");
      const runtimeDir = this.runtimeDir();
      const agent = loadFlowAgent(runtimeDir);
      if (!runtimeDir || !agent) throw new FlowError("agent_missing", FLOW_AGENT_MISSING);
      const skill = skillBody(runtimeDir, def.skill);
      if (!skill) throw new FlowError("skill_missing", `Falta el procedimiento «${def.skill}» en agent-runtime/skills de la aplicación.`);
      const allowed = flowAllowedTools(agent, def);
      const mcpConfig = mcpConfigJson({ root: this.coord.root, dataSource: this.coord.source.kind === "fixtures" ? "fixtures" : "live", ...(this.coord.homeOverride ? { homeOverride: this.coord.homeOverride } : {}), mode: "flow" });
      const args = headlessArgs({
        agentName: FLOW_AGENT,
        agent,
        mcpConfig,
        sessionId: randomUUID(),
        resume: false,
        builtinTools: flowBuiltins(allowed),
        allowedTools: allowed,
        disallowedTools: flowDisallowed(agent),
        budgetUsd: def.costCapUsd,
        ...(this.opts.model ? { model: this.opts.model } : {}),
      });
      const prompt = flowPrompt(def, run, skill);

      const onToolResult = (tool: string, raw: string) => {
        if (tool === "generate_report") {
          try {
            const env = JSON.parse(raw) as { ok?: boolean; data?: { path?: string } };
            const p = env.ok !== false ? env.data?.path : undefined;
            if (typeof p === "string") {
              const name = basename(p.replace(/\\/g, "/"));
              if (!run.outcome.reports.includes(name)) {
                run.outcome.reports.push(name);
                line("created", `Informe: ${name}`);
                this.emit(live, { type: "created", id: name, kind: "report" });
                flushSoon();
              }
            }
          } catch {
            // not JSON: ignore
          }
          return;
        }
        const id = createdId(`mcp__coord__${tool}`, raw);
        if (!id) return;
        pending.push(
          (async () => {
            // Verify against the store before counting (ids come from tool results, never from model text).
            if (tool === "ask_coordinator") {
              if (!(await this.coord.questions.get(id)) || run.questionIds.includes(id)) return;
              run.questionIds.push(id);
              run.outcome.questions++;
              line("created", `Pregunta ${id}`);
              this.emit(live, { type: "created", id, kind: "question" });
            } else {
              const p = await this.coord.store.getProposal(id).catch(() => undefined);
              if (!p || run.proposalIds.includes(id)) return;
              run.proposalIds.push(id);
              run.outcome.proposals++;
              if (p.kind === "issue_draft") run.outcome.issueDrafts++;
              if (p.kind === "rule_change") run.outcome.ruleChanges++;
              line("created", `Propuesta ${id}`);
              this.emit(live, { type: "created", id, kind: "proposal" });
            }
            flushSoon();
          })().catch(() => undefined),
        );
      };
      const result = await runClaude({
        bin,
        args,
        cwd: runtimeDir,
        prompt,
        env: agentEnv({ appRoot: this.coord.root, auditDir: this.coord.store.path("audit") }),
        timeoutMs: this.opts.timeoutMs ?? def.timeoutMs,
        toolCap: FLOW_TOOL_CAP,
        proposalCap: FLOW_PROPOSAL_CAP,
        onChild: (_c, stop) => {
          live.stop = stop;
          if (live.cancelled) stop();
        },
        onToolResult,
        onEvent: (e) => {
          if (e.type === "tool") {
            line("tool", `${TOOL_LABEL[e.name] ?? `Consultando ${e.name}`}${e.target ? ` · ${e.target}` : ""}`);
            flushSoon();
          } else if (e.type === "delta") {
            // Text already passed the chat's narration filter (no English / pre-tool preambles).
            text += e.text;
            paragraph += e.text;
            let i: number;
            while ((i = paragraph.indexOf("\n\n")) >= 0) {
              const p = paragraph.slice(0, i).trim();
              paragraph = paragraph.slice(i + 2);
              if (p) line("text", p);
            }
          } else if (e.type === "status" && (e.phase === "retrying" || e.phase === "rate_limited")) {
            line("status", e.phase === "retrying" ? "Reintentando…" : "Límite de uso alcanzado: esperando.");
          }
        },
      });
      if (paragraph.trim()) line("text", paragraph.trim());
      await Promise.all(pending);
      run.costUsd = result.costUsd;
      if (result.stoppedBy) run.stoppedBy = result.stoppedBy;
      run.summary = sanitizeMultilineText(text || result.text, 4000);
      run.state = "finished";
      line("status", result.stoppedBy ? `Detenido por límite (${result.stoppedBy}); se conserva lo producido.` : "Terminado.");
    } catch (err) {
      await Promise.all(pending);
      if (paragraph.trim()) line("text", paragraph.trim());
      const cancelled = live.cancelled || (err instanceof ChatRunError && err.code === "cancelled");
      run.state = cancelled ? "cancelled" : "failed";
      const code = cancelled ? "cancelled" : err instanceof ChatRunError || err instanceof FlowError ? err.code : "failed";
      const message = cancelled ? "Cancelado." : err instanceof ChatRunError || err instanceof FlowError || err instanceof CoordError ? err.message : "El flujo falló.";
      if (!(err instanceof ChatRunError || err instanceof FlowError)) log.warn("flows.failed", { message: (err as Error).message });
      run.error = { code, message };
      if (text) run.summary = sanitizeMultilineText(text, 4000);
      line(cancelled ? "status" : "error", message);
    } finally {
      this.projectsRunning.delete(key);
    }
    run.finishedAt = nowIso(this.coord.now());
    await flush();
    await this.audit(run, run.state === "cancelled" ? "flow.cancelled" : "flow.finished", run.startedBy === "agent:chat" ? CHAT_AGENT_ACTOR : starter.type === "user" ? starter : FLOW_AGENT_ACTOR);
    const view = runView(run);
    if (run.state === "finished") this.emit(live, { type: "done", run: view });
    else this.emit(live, { type: "error", code: run.error?.code ?? "failed", message: run.error?.message ?? "El flujo falló.", run: view });
  }
}

export class FlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
