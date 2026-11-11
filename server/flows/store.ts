/**
 * Flow runs on disk (shared by the web server and the chat's MCP process):
 *
 *   <data home>/flows/<runId>.json          FlowRunView + server fields (no personal data)
 *   <data home>/flows/<runId>.events.jsonl  event log (status, log lines, created ids, done)
 *
 * Creating a run checks, under the store lock, the two limits that hold for every starter:
 * one active (queued / running) run per project, and the per-day cap of agent-started runs.
 */
import { randomBytes } from "node:crypto";
import type * as C from "../api/contract";
import type { Store } from "../store";
import { appendJsonl, listFiles, readJsonFile, readJsonl, writeJsonAtomic } from "../store/fs";
import { bareProjectId, CoordError, nowIso } from "../util";

export interface FlowRunRecord extends C.FlowRunView {
  /** Process that runs it (a running record of another, dead process is "interrupted"). */
  pid?: number;
  /** Optional skill arguments chosen by the server (never free model text). */
  args?: string;
}

export const FLOW_LOG_MAX = 200;
/** A queued run nobody picked up within this time is expired (the server was not running). */
export const QUEUED_TTL_MS = 10 * 60_000;
const RUN_ID = /^FR-\d{8}-[0-9a-f]{6}$/;

export function isRunId(id: string): boolean {
  return RUN_ID.test(id);
}

export function emptyOutcome(): C.FlowOutcome {
  return { proposals: 0, questions: 0, issueDrafts: 0, ruleChanges: 0, reports: [] };
}

/** Public view (server fields dropped). */
export function runView(r: FlowRunRecord): C.FlowRunView {
  const { pid: _pid, args: _args, ...view } = r;
  void _pid;
  void _args;
  return view;
}

export class FlowRunStore {
  constructor(private readonly store: Store) {}

  private file(id: string): string {
    if (!isRunId(id)) throw new CoordError("validation_error", `runId inválido: ${JSON.stringify(id)}`);
    return this.store.path("flows", `${id}.json`);
  }

  private eventsFile(id: string): string {
    if (!isRunId(id)) throw new CoordError("validation_error", `runId inválido: ${JSON.stringify(id)}`);
    return this.store.path("flows", `${id}.events.jsonl`);
  }

  newId(now: number): string {
    return `FR-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  }

  async get(id: string): Promise<FlowRunRecord | undefined> {
    if (!isRunId(id)) return undefined;
    return readJsonFile<FlowRunRecord>(this.file(id));
  }

  async list(filter: { projectId?: string } = {}): Promise<FlowRunRecord[]> {
    const ids = (await listFiles(this.store.path("flows"), ".json")).map((n) => n.replace(/\.json$/, "")).filter(isRunId);
    const out: FlowRunRecord[] = [];
    for (const id of ids) {
      const r = await readJsonFile<FlowRunRecord>(this.file(id)).catch(() => undefined);
      if (r && (!filter.projectId || bareProjectId(r.projectId) === bareProjectId(filter.projectId))) out.push(r);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** Active = queued (and not expired) or running. */
  isActive(r: FlowRunRecord, now: number): boolean {
    if (r.state === "running") return true;
    return r.state === "queued" && now - Date.parse(r.createdAt) < QUEUED_TTL_MS;
  }

  async active(projectId: string, now: number): Promise<FlowRunRecord | undefined> {
    return (await this.list({ projectId })).find((r) => this.isActive(r, now));
  }

  async agentRunsToday(now: number): Promise<number> {
    const day = nowIso(now).slice(0, 10);
    return (await this.list()).filter((r) => r.startedBy === "agent:chat" && r.createdAt.slice(0, 10) === day).length;
  }

  /** Create a run after checking one-active-per-project and (agent starters) the daily cap, atomically. */
  async create(rec: Omit<FlowRunRecord, "runId" | "createdAt" | "outcome" | "proposalIds" | "questionIds" | "log" | "state">, opts: { now: number; dailyAgentCap: number }): Promise<FlowRunRecord> {
    return this.store.withLock(async () => {
      const active = await this.active(rec.projectId, opts.now);
      if (active) throw new CoordError("conflict", `Ya hay un flujo en curso en este proyecto (${active.label}, ${active.runId}): espera a que termine o cancélalo.`, "Un solo flujo por proyecto a la vez.");
      if (rec.startedBy === "agent:chat") {
        const used = await this.agentRunsToday(opts.now);
        if (used >= opts.dailyAgentCap) throw new CoordError("conflict", `El agente ya inició ${used} flujos hoy (máximo ${opts.dailyAgentCap}). Ejecútalo desde la UI si lo necesitas.`, "Límite diario de flujos iniciados por el agente.");
      }
      const created: FlowRunRecord = { ...rec, runId: this.newId(opts.now), createdAt: nowIso(opts.now), state: "queued", outcome: emptyOutcome(), proposalIds: [], questionIds: [], log: [] };
      await writeJsonAtomic(this.file(created.runId), created);
      return created;
    });
  }

  async update(id: string, fn: (r: FlowRunRecord) => void): Promise<FlowRunRecord> {
    return this.store.withLock(async () => {
      const r = await readJsonFile<FlowRunRecord>(this.file(id));
      if (!r) throw new CoordError("not_found", `Flujo ${id} no existe`);
      fn(r);
      if (r.log.length > FLOW_LOG_MAX) r.log = r.log.slice(-FLOW_LOG_MAX);
      await writeJsonAtomic(this.file(id), r);
      return r;
    });
  }

  async appendEvent(id: string, e: C.FlowEvent): Promise<void> {
    await appendJsonl(this.eventsFile(id), { at: new Date().toISOString(), ...e });
  }

  async events(id: string): Promise<C.FlowEvent[]> {
    return (await readJsonl<C.FlowEvent & { at?: string }>(this.eventsFile(id))).map(({ at: _at, ...e }) => {
      void _at;
      return e as C.FlowEvent;
    });
  }
}
