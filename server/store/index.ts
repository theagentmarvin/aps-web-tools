/**
 * File-based store under `.coordinator/` (git-ignored).
 *
 *   secret/approval.key             HMAC key (server/approval only)
 *   cache/…                         normalized clash tests (server/cache/clash-cache.ts)
 *   state/context.json              active context (project / model set / test)
 *   state/counters.json             id sequences
 *   state/store.lock                single-writer lock
 *   tests/<testKey>/test.json       ingested run metadata
 *   tests/<testKey>/classification.json   groups + per-clash results
 *   proposals/<P-…>.json            proposals
 *   rule-proposals/<P-…>.patch      rule patches (a human merges with git)
 *   batches/<L-…>.json              approval batches
 *   approvals/<L-…>.json            signed human approvals
 *   decisions/decisions.jsonl       human triage decisions (append-only)
 *   feedback/feedback.jsonl         feedback with feature snapshots
 *   audit/audit.jsonl               hash-chained audit log
 *   applied/<key>.json              idempotency records of ACC writes
 *   budget/jobs.json                local ACC job counter (250 jobs/h/project)
 *   projects/<projectId>/notes.md   project memory
 *   reports/<projectId>/…           generated reports
 *
 * Every mutation runs under {@link Store.withLock}; every file write is atomic.
 */
import { createHmac } from "node:crypto";
import { join, resolve } from "node:path";
import { appendJsonl, listFiles, readJsonFile, readJsonl, readTextFile, withFileLock, writeFileAtomic, writeJsonAtomic } from "./fs";
import { assertBatchTransition, assertProposalTransition } from "./state-machine";
import type {
  ActiveContext,
  Actor,
  ApprovalRecord,
  AuditEventRecord,
  BatchRecord,
  BatchState,
  ClassificationRecord,
  DecisionRecord,
  FeedbackRecord,
  ProposalRecord,
  ProposalState,
  TestRecord,
} from "./types";
import { CoordError, nowIso, sha256, ymd } from "../util";

export * from "./types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safe(id: string, what: string): string {
  if (!SAFE_ID.test(id) || id.includes("..")) throw new CoordError("validation_error", `${what} inválido: ${JSON.stringify(id)}`);
  return id;
}

export const GENESIS_HASH = "0".repeat(64);

export interface StoreOptions {
  /** Absolute or cwd-relative path of `.coordinator`. */
  home?: string;
  now?: () => number;
  /**
   * Out-of-repo key for the audit hash chain (HMAC-SHA256). Without it the
   * chain is a plain SHA-256 chain (tamper-evident only against careless edits).
   */
  auditKey?: () => Promise<Buffer | undefined>;
  /** Read-only variant used by verifyAudit (never creates the key). */
  auditKeyRead?: () => Promise<Buffer | undefined>;
}

export class Store {
  readonly home: string;
  readonly now: () => number;
  private readonly auditKey?: () => Promise<Buffer | undefined>;
  private readonly auditKeyRead?: () => Promise<Buffer | undefined>;

  constructor(opts: StoreOptions = {}) {
    this.home = resolve(opts.home ?? process.env.COORDINATOR_HOME ?? ".coordinator");
    this.now = opts.now ?? Date.now;
    this.auditKey = opts.auditKey;
    this.auditKeyRead = opts.auditKeyRead ?? opts.auditKey;
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts);
  }

  get cacheRoot(): string {
    return this.path("cache");
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.path("state", "store.lock"), fn);
  }

  // ── ids ──────────────────────────────────────────────────────────────────

  /** Next value of a named daily sequence (under lock). */
  async nextSeq(name: string): Promise<number> {
    return this.withLock(async () => {
      const file = this.path("state", "counters.json");
      const counters = (await readJsonFile<Record<string, number>>(file)) ?? {};
      const n = (counters[name] ?? 0) + 1;
      counters[name] = n;
      await writeJsonAtomic(file, counters);
      return n;
    });
  }

  async newProposalId(): Promise<string> {
    const day = ymd(this.now());
    const n = await this.nextSeq(`P-${day}`);
    return `P-${day}-${String(n).padStart(4, "0")}`;
  }

  async newBatchId(): Promise<string> {
    const day = ymd(this.now());
    const n = await this.nextSeq(`L-${day}`);
    return `L-${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}-${String(n).padStart(2, "0")}`;
  }

  async newFeedbackId(): Promise<string> {
    const day = ymd(this.now());
    const n = await this.nextSeq(`F-${day}`);
    return `F-${day}-${String(n).padStart(4, "0")}`;
  }

  // ── active context ───────────────────────────────────────────────────────

  async getContext(): Promise<ActiveContext | undefined> {
    return readJsonFile<ActiveContext>(this.path("state", "context.json"));
  }

  async setContext(ctx: Omit<ActiveContext, "updatedAt">): Promise<ActiveContext> {
    const value: ActiveContext = { ...ctx, updatedAt: nowIso(this.now()) };
    await this.withLock(() => writeJsonAtomic(this.path("state", "context.json"), value));
    return value;
  }

  // ── tests and classification ─────────────────────────────────────────────

  async putTest(rec: TestRecord): Promise<void> {
    await this.withLock(() => writeJsonAtomic(this.path("tests", safe(rec.testKey, "testKey"), "test.json"), rec));
  }

  async getTest(testKey: string): Promise<TestRecord | undefined> {
    return readJsonFile<TestRecord>(this.path("tests", safe(testKey, "testKey"), "test.json"));
  }

  async listTests(): Promise<TestRecord[]> {
    const { readdir } = await import("node:fs/promises");
    let dirs: string[] = [];
    try {
      dirs = await readdir(this.path("tests"));
    } catch {
      return [];
    }
    const out: TestRecord[] = [];
    for (const d of dirs.sort()) {
      if (!SAFE_ID.test(d)) continue;
      const t = await this.getTest(d);
      if (t) out.push(t);
    }
    return out;
  }

  async putClassification(rec: ClassificationRecord): Promise<void> {
    await this.withLock(() => writeJsonAtomic(this.path("tests", safe(rec.testKey, "testKey"), "classification.json"), rec));
  }

  async getClassification(testKey: string): Promise<ClassificationRecord | undefined> {
    return readJsonFile<ClassificationRecord>(this.path("tests", safe(testKey, "testKey"), "classification.json"));
  }

  // ── proposals ────────────────────────────────────────────────────────────

  async getProposal(id: string): Promise<ProposalRecord | undefined> {
    return readJsonFile<ProposalRecord>(this.path("proposals", `${safe(id, "proposalId")}.json`));
  }

  async listProposals(filter: (p: ProposalRecord) => boolean = () => true): Promise<ProposalRecord[]> {
    const files = await listFiles(this.path("proposals"));
    const out: ProposalRecord[] = [];
    for (const f of files) {
      const p = await readJsonFile<ProposalRecord>(this.path("proposals", f));
      if (p && filter(p)) out.push(p);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Create a proposal (id assigned here) in `pending_review` (or `draft`). */
  async createProposal(
    p: Omit<ProposalRecord, "id" | "createdAt" | "updatedAt" | "history" | "batchIds" | "state"> & { state?: "draft" | "pending_review" },
  ): Promise<ProposalRecord> {
    const id = await this.newProposalId();
    const at = nowIso(this.now());
    const state = p.state ?? "pending_review";
    const rec: ProposalRecord = {
      ...p,
      id,
      state,
      createdAt: at,
      updatedAt: at,
      batchIds: [],
      history: [{ at, from: null, to: state, by: p.createdBy.name }],
    };
    await this.withLock(() => writeJsonAtomic(this.path("proposals", `${id}.json`), rec));
    return rec;
  }

  /** Transition a proposal (validated by the state machine) under lock. */
  async transitionProposal(id: string, to: ProposalState, by: string, reason?: string): Promise<ProposalRecord> {
    return this.withLock(async () => {
      const p = await this.getProposal(id);
      if (!p) throw new CoordError("not_found", `Propuesta ${id} no existe`);
      if (p.state === to) return p;
      assertProposalTransition(id, p.state, to);
      const at = nowIso(this.now());
      p.history.push({ at, from: p.state, to, by, reason });
      p.state = to;
      p.updatedAt = at;
      await writeJsonAtomic(this.path("proposals", `${id}.json`), p);
      return p;
    });
  }

  async updateProposal(id: string, mutate: (p: ProposalRecord) => void): Promise<ProposalRecord> {
    return this.withLock(async () => {
      const p = await this.getProposal(id);
      if (!p) throw new CoordError("not_found", `Propuesta ${id} no existe`);
      const before = p.state;
      mutate(p);
      if (p.state !== before) throw new CoordError("internal", "updateProposal no puede cambiar el estado; usa transitionProposal");
      p.updatedAt = nowIso(this.now());
      await writeJsonAtomic(this.path("proposals", `${id}.json`), p);
      return p;
    });
  }

  async writeRulePatch(id: string, patch: string): Promise<string> {
    const file = this.path("rule-proposals", `${safe(id, "proposalId")}.patch`);
    await this.withLock(() => writeFileAtomic(file, patch));
    return file;
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async listDecisions(): Promise<DecisionRecord[]> {
    return readJsonl<DecisionRecord>(this.path("decisions", "decisions.jsonl"));
  }

  /** Append decisions not seen before (idempotent by id). Returns the ids now stored. */
  async appendDecisions(decisions: DecisionRecord[]): Promise<{ saved: string[]; added: DecisionRecord[] }> {
    return this.withLock(async () => {
      const existing = new Set((await this.listDecisions()).map((d) => d.id));
      const added: DecisionRecord[] = [];
      for (const d of decisions) {
        if (existing.has(d.id)) continue;
        existing.add(d.id);
        await appendJsonl(this.path("decisions", "decisions.jsonl"), d);
        added.push(d);
      }
      return { saved: decisions.map((d) => d.id), added };
    });
  }

  /** Mark decisions as batched (rewrites the jsonl atomically, preserving order). */
  async markDecisionsBatched(ids: readonly string[], batchId: string | undefined): Promise<void> {
    const set = new Set(ids);
    await this.withLock(async () => {
      const all = await this.listDecisions();
      for (const d of all) if (set.has(d.id)) d.batchId = batchId;
      await writeFileAtomic(this.path("decisions", "decisions.jsonl"), all.map((d) => JSON.stringify(d)).join("\n") + (all.length ? "\n" : ""));
    });
  }

  // ── batches and approvals ────────────────────────────────────────────────

  async getBatch(id: string): Promise<BatchRecord | undefined> {
    return readJsonFile<BatchRecord>(this.path("batches", `${safe(id, "batchId")}.json`));
  }

  async listBatches(): Promise<BatchRecord[]> {
    const out: BatchRecord[] = [];
    for (const f of await listFiles(this.path("batches"))) {
      const b = await readJsonFile<BatchRecord>(this.path("batches", f));
      if (b) out.push(b);
    }
    return out;
  }

  async putBatch(b: BatchRecord): Promise<void> {
    b.updatedAt = nowIso(this.now());
    await this.withLock(() => writeJsonAtomic(this.path("batches", `${safe(b.id, "batchId")}.json`), b));
  }

  async transitionBatch(id: string, to: BatchState, mutate?: (b: BatchRecord) => void): Promise<BatchRecord> {
    return this.withLock(async () => {
      const b = await this.getBatch(id);
      if (!b) throw new CoordError("not_found", `Lote ${id} no existe`);
      if (b.state !== to) assertBatchTransition(id, b.state, to);
      b.state = to;
      mutate?.(b);
      await this.putBatch(b);
      return b;
    });
  }

  async getApproval(batchId: string): Promise<ApprovalRecord | undefined> {
    return readJsonFile<ApprovalRecord>(this.path("approvals", `${safe(batchId, "batchId")}.json`));
  }

  async putApproval(rec: ApprovalRecord): Promise<void> {
    await this.withLock(() => writeJsonAtomic(this.path("approvals", `${safe(rec.batchId, "batchId")}.json`), rec));
  }

  async deleteApproval(batchId: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await this.withLock(() => rm(this.path("approvals", `${safe(batchId, "batchId")}.json`), { force: true }));
  }

  // ── idempotency + job budget ─────────────────────────────────────────────

  async getAppliedRecord<T>(key: string): Promise<T | undefined> {
    return readJsonFile<T>(this.path("applied", `${safe(key, "idempotencyKey")}.json`));
  }

  async putAppliedRecord(key: string, value: unknown): Promise<void> {
    await this.withLock(() => writeJsonAtomic(this.path("applied", `${safe(key, "idempotencyKey")}.json`), value));
  }

  /**
   * Reserve one ACC job for (project, operation) if fewer than `limit` were
   * reserved in the last hour. Returns false when the budget is exhausted.
   */
  async reserveJob(projectId: string, operation: string, limit: number): Promise<boolean> {
    return this.withLock(async () => {
      const file = this.path("budget", "jobs.json");
      const all = (await readJsonFile<Record<string, number[]>>(file)) ?? {};
      const key = `${projectId}|${operation}`;
      const cutoff = this.now() - 3_600_000;
      const recent = (all[key] ?? []).filter((t) => t > cutoff);
      if (recent.length >= limit) {
        all[key] = recent;
        await writeJsonAtomic(file, all);
        return false;
      }
      recent.push(this.now());
      all[key] = recent;
      await writeJsonAtomic(file, all);
      return true;
    });
  }

  async jobsUsed(projectId: string, operation: string): Promise<number> {
    const all = (await readJsonFile<Record<string, number[]>>(this.path("budget", "jobs.json"))) ?? {};
    const cutoff = this.now() - 3_600_000;
    return (all[`${projectId}|${operation}`] ?? []).filter((t) => t > cutoff).length;
  }

  // ── feedback ─────────────────────────────────────────────────────────────

  async appendFeedback(rec: FeedbackRecord): Promise<void> {
    await this.withLock(() => appendJsonl(this.path("feedback", "feedback.jsonl"), rec));
  }

  async listFeedback(): Promise<FeedbackRecord[]> {
    return readJsonl<FeedbackRecord>(this.path("feedback", "feedback.jsonl"));
  }

  // ── audit (hash-chained) ─────────────────────────────────────────────────

  /**
   * Append an audit event. `hash = sha256(prevHash + canonical event without
   * hash)`; editing or deleting any line breaks {@link verifyAudit}.
   */
  async audit(e: {
    actor: Actor;
    action: string;
    projectId?: string;
    modelSetId?: string;
    /** The cached test KEY (T-xxxxxxxx). */
    testId?: string;
    /** The ACC clash test id, when relevant. */
    accTestId?: string;
    batchId?: string;
    targetIds?: string[];
    details?: Record<string, string | number | boolean | null>;
    accResponseId?: string;
  }): Promise<AuditEventRecord> {
    return this.withLock(async () => {
      const file = this.path("audit", "audit.jsonl");
      const tail = await this.lastAudit();
      const seq = (tail?.seq ?? 0) + 1;
      const body = {
        id: `A-${String(seq).padStart(7, "0")}`,
        seq,
        at: nowIso(this.now()),
        actor: e.actor,
        action: e.action,
        projectId: e.projectId ?? "",
        modelSetId: e.modelSetId,
        testId: e.testId,
        accTestId: e.accTestId,
        batchId: e.batchId,
        targetIds: e.targetIds ?? [],
        details: e.details ?? {},
        accResponseId: e.accResponseId,
        prevHash: tail?.hash ?? GENESIS_HASH,
      };
      const rec: AuditEventRecord = { ...body, hash: auditHash(body, await this.auditKey?.()) };
      await appendJsonl(file, rec);
      return rec;
    });
  }

  private async lastAudit(): Promise<AuditEventRecord | undefined> {
    const text = await readTextFile(this.path("audit", "audit.jsonl"));
    if (!text) return undefined;
    const lines = text.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]) as AuditEventRecord;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async listAudit(): Promise<AuditEventRecord[]> {
    return readJsonl<AuditEventRecord>(this.path("audit", "audit.jsonl"));
  }

  /** Verify the whole chain. Returns the first broken seq, if any. */
  async verifyAudit(): Promise<{ ok: boolean; events: number; brokenAt?: number }> {
    const events = await this.listAudit();
    const key = await this.auditKeyRead?.();
    let prev = GENESIS_HASH;
    for (const ev of events) {
      const { hash, ...body } = ev;
      if (ev.prevHash !== prev || auditHash(body, key) !== hash) return { ok: false, events: events.length, brokenAt: ev.seq };
      prev = hash;
    }
    return { ok: true, events: events.length };
  }

  // ── project notes ────────────────────────────────────────────────────────

  notesPath(projectId: string): string {
    return this.path("projects", safe(projectId.replace(/^b\./, ""), "projectId"), "notes.md");
  }

  async readNotes(projectId: string): Promise<string | undefined> {
    return readTextFile(this.notesPath(projectId));
  }

  async appendNote(projectId: string, line: string): Promise<string> {
    const file = this.notesPath(projectId);
    return this.withLock(async () => {
      const prev = (await readTextFile(file)) ?? `# Notas del proyecto ${projectId}\n\n`;
      const next = prev.endsWith("\n") ? prev + line + "\n" : `${prev}\n${line}\n`;
      await writeFileAtomic(file, next);
      return next;
    });
  }

  async writeReport(projectId: string, name: string, content: string | Uint8Array): Promise<string> {
    const file = this.path("reports", safe(projectId.replace(/^b\./, ""), "projectId"), safe(name, "report"));
    await this.withLock(() => writeFileAtomic(file, content));
    return file;
  }
}

function auditHash(body: Omit<AuditEventRecord, "hash">, key?: Buffer): string {
  const { prevHash, ...rest } = body;
  const msg = prevHash + JSON.stringify(sortKeys(rest));
  return key ? createHmac("sha256", key).update(msg).digest("hex") : sha256(msg);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}
