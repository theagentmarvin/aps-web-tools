/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  APPROVAL + APPLY — the only module that may mint ApprovedWriteTokens    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * - {@link approveBatch}: records a HUMAN approval of a `ready` batch, signed
 *   with HMAC-SHA256 (approver, proposal ids, item ids, payload hash, expiry,
 *   test version). Callers: HTTP approve endpoint (same-origin + CSRF) and the
 *   interactive CLI. MCP tools never call it.
 * - {@link verifyBatchApproval}: re-checks signature, payload hash, expiry and
 *   that the test's model set version is still the latest. Read-only.
 * - {@link applyApproved}: re-verifies, builds the minimal batched ACC
 *   requests (one clashes:close / clashes:assign POST per test carrying many
 *   groups, chunked), respects a local jobs/hour budget, mints single-use
 *   tokens via `issueApprovedWriteToken`, executes, polls jobs, records results
 *   and audit. `dryRun` (default) returns the exact bodies without calling ACC.
 *   Idempotency keys (hash of batch + operation + body) prevent double application.
 *
 * tests/import-guard.test.ts fails if any other non-test file imports
 * `issueApprovedWriteToken`.
 */
import { randomBytes } from "node:crypto";
import { issueApprovedWriteToken } from "../aps/write-guard";
import { CLASH_BASE } from "../aps/clash";
import type { AssignedGroupCreate, ClosedGroupCreate } from "../aps/types";
import type { CoordinatorConfig } from "../config";
import type { DataSource } from "../source/types";
import type { Store } from "../store";
import { withFileLock } from "../store/fs";
import type { Actor, ApprovalRecord, BatchItemRecord, BatchRecord } from "../store/types";
import { bareProjectId, canonicalJson, CoordError, hashOf, nowIso, sha256 } from "../util";
import { loadOrCreateApprovalKey, readApprovalKey, signApproval, verifyApprovalSignature } from "./hmac";

export { approvalKeyPath } from "./hmac";

export type RefusalReason =
  | "not_approved"
  | "approval_signature_invalid"
  | "payload_changed_since_approval"
  | "approval_expired"
  | "autonomy_level_forbids"
  | "stale_test_version"
  | "aps_error"
  | "rate_limited"
  | "unsupported_operation";

export interface ApprovalDeps {
  store: Store;
  source: DataSource;
  config: CoordinatorConfig;
  effectiveLevel: number;
}

/** Items that will be written: included, carrying an MC operation, not yet applied. */
export function includedItems(batch: BatchRecord): BatchItemRecord[] {
  return batch.items.filter((i) => !i.excluded && i.mcOperation !== "none");
}

/** Hash of exactly what the human approves: per item the operation, targets and ACC body. */
export function batchPayloadHash(batch: BatchRecord): string {
  return hashOf({
    batchId: batch.id,
    projectId: bareProjectId(batch.projectId),
    testId: batch.testId,
    modelSetVersion: batch.modelSetVersion,
    items: includedItems(batch)
      .map((i) => ({ id: i.id, op: i.mcOperation, targets: [...i.targetIds].sort(), body: i.accNew }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  });
}

export function batchProposalIds(batch: BatchRecord): string[] {
  return [...new Set(includedItems(batch).flatMap((i) => i.proposalIds))].sort();
}

// ── approve ─────────────────────────────────────────────────────────────────

export interface Approver {
  id: string;
  name: string;
  channel: "web-ui" | "cli";
}

export async function approveBatch(
  deps: ApprovalDeps,
  batchId: string,
  approver: Approver,
  opts: { note?: string; excludedItemIds?: readonly string[] } = {},
): Promise<{ batch: BatchRecord; approval: ApprovalRecord }> {
  const { store, source, config } = deps;
  if (deps.effectiveLevel < 1) throw new CoordError("autonomy_level_forbids", "Nivel de autonomía L0: no se pueden aprobar cambios para ACC.");
  if (!approver.id || !approver.name) throw new CoordError("validation_error", "Se requiere la identidad del aprobador.");
  let batch = await store.getBatch(batchId);
  if (!batch) throw new CoordError("not_found", `Lote ${batchId} no existe`);
  if (batch.state !== "ready") throw new CoordError("invalid_state", `El lote ${batchId} está en estado ${batch.state}; solo se aprueban lotes 'ready'.`);
  if (opts.excludedItemIds?.length) {
    const ex = new Set(opts.excludedItemIds);
    for (const i of batch.items) if (ex.has(i.id)) i.excluded = true;
    await store.putBatch(batch);
  }
  if (includedItems(batch).length === 0) throw new CoordError("validation_error", "El lote no tiene cambios aplicables en ACC.");
  const latest = await source.latestVersion(batch.projectId, batch.modelSetId);
  if (latest !== batch.modelSetVersion) {
    throw new CoordError("stale_cache", `La prueba es de la versión v${batch.modelSetVersion} pero el conjunto ya está en v${latest}. Re-analiza la versión nueva.`);
  }
  const key = await loadOrCreateApprovalKey(store.home);
  const now = store.now();
  const unsigned: Omit<ApprovalRecord, "hmac"> = {
    batchId,
    projectId: batch.projectId,
    modelSetId: batch.modelSetId,
    testId: batch.testId,
    testKey: batch.testKey,
    testVersion: batch.modelSetVersion,
    proposalIds: batchProposalIds(batch),
    itemIds: includedItems(batch).map((i) => i.id).sort(),
    payloadHash: batchPayloadHash(batch),
    approvedBy: { id: approver.id, name: approver.name, channel: approver.channel },
    approvedAt: nowIso(now),
    expiresAt: nowIso(now + config.autonomy.approvalExpiryDays * 86_400_000),
    nonce: randomBytes(12).toString("hex"),
    ...(opts.note ? { note: opts.note } : {}),
  };
  const approval: ApprovalRecord = { ...unsigned, hmac: signApproval(key, unsigned) };
  await store.putApproval(approval);
  batch = await store.transitionBatch(batchId, "approved", (b) => {
    b.approvedBy = approver.name;
    b.approvedAt = approval.approvedAt;
  });
  for (const pid of approval.proposalIds) {
    const p = await store.getProposal(pid);
    if (p && p.state === "pending_review") await store.transitionProposal(pid, "approved", approver.name, `lote ${batchId}`);
  }
  await store.audit({
    actor: { type: "user", id: approver.id, name: approver.name },
    action: "batch.approved",
    projectId: batch.projectId,
    modelSetId: batch.modelSetId,
    testId: batch.testId,
    batchId,
    targetIds: approval.proposalIds,
    details: { channel: approver.channel, items: approval.itemIds.length, payloadHash: approval.payloadHash, expiresAt: approval.expiresAt },
  });
  return { batch, approval };
}

// ── verify ──────────────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true; approval: ApprovalRecord; batch: BatchRecord }
  | { ok: false; reason: RefusalReason; message: string; approval?: ApprovalRecord; batch?: BatchRecord };

/** Read-only full verification of a batch approval. Never creates anything (not even the key). */
export async function verifyBatchApproval(deps: Pick<ApprovalDeps, "store" | "source">, batchId: string): Promise<VerifyResult> {
  const { store, source } = deps;
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false, reason: "not_approved", message: `Lote ${batchId} no existe` };
  const approval = await store.getApproval(batchId);
  if (!approval) return { ok: false, reason: "not_approved", message: "Sin aprobación humana registrada", batch };
  if (batch.state !== "approved" && batch.state !== "partial" && batch.state !== "applied") {
    return { ok: false, reason: "not_approved", message: `Lote en estado ${batch.state}`, approval, batch };
  }
  const key = await readApprovalKey(store.home);
  if (!key || !verifyApprovalSignature(key, approval) || approval.batchId !== batchId) {
    return { ok: false, reason: "approval_signature_invalid", message: "Firma de aprobación inválida", approval, batch };
  }
  if (approval.payloadHash !== batchPayloadHash(batch)) {
    return { ok: false, reason: "payload_changed_since_approval", message: "El lote cambió después de aprobarse", approval, batch };
  }
  if (Date.parse(approval.expiresAt) <= store.now()) {
    return { ok: false, reason: "approval_expired", message: `Aprobación vencida (${approval.expiresAt})`, approval, batch };
  }
  let latest: number;
  try {
    latest = await source.latestVersion(batch.projectId, batch.modelSetId);
  } catch (err) {
    return { ok: false, reason: "aps_error", message: `No se pudo verificar la versión vigente: ${(err as Error).message}`, approval, batch };
  }
  if (approval.testVersion !== batch.modelSetVersion || latest !== approval.testVersion) {
    return { ok: false, reason: "stale_test_version", message: `Versión aprobada v${approval.testVersion}, vigente v${latest}`, approval, batch };
  }
  return { ok: true, approval, batch };
}

// ── requests ────────────────────────────────────────────────────────────────

export interface PlannedRequest {
  idempotencyKey: string;
  operation: "clash.close" | "clash.assign";
  method: "POST";
  path: string;
  body: Array<ClosedGroupCreate | AssignedGroupCreate>;
  itemIds: string[];
  proposalIds: string[];
  groups: number;
  clashes: number;
}

/**
 * Minimal batched requests: one POST per (operation, test) holding many
 * groups, chunked at `maxGroupsPerRequest` (ACC bodies are arrays; the quota
 * counts jobs, not groups).
 */
export function planRequests(batch: BatchRecord, items: readonly BatchItemRecord[], maxGroupsPerRequest: number): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  const container = bareProjectId(batch.projectId);
  for (const op of ["clash.close", "clash.assign"] as const) {
    const opItems = items.filter((i) => i.mcOperation === op).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = 0; i < opItems.length; i += maxGroupsPerRequest) {
      const chunk = opItems.slice(i, i + maxGroupsPerRequest);
      const body = chunk.map((it) => it.accNew as ClosedGroupCreate | AssignedGroupCreate);
      out.push({
        idempotencyKey: sha256(`${batch.id}|${op}|${batch.testId}|${canonicalJson(body)}`).slice(0, 40),
        operation: op,
        method: "POST",
        path: `${CLASH_BASE}/containers/${container}/tests/${batch.testId}/clashes:${op === "clash.close" ? "close" : "assign"}`,
        body,
        itemIds: chunk.map((c) => c.id),
        proposalIds: [...new Set(chunk.flatMap((c) => c.proposalIds))].sort(),
        groups: chunk.length,
        clashes: body.reduce((n, g) => n + g.clashes.length, 0),
      });
    }
  }
  return out;
}

/** Proposal ids for the write token; engine-only items (no proposal) are referenced by the batch id. */
function tokenRefs(r: PlannedRequest, batchId: string): string[] {
  return r.proposalIds.length ? r.proposalIds : [`batch:${batchId}`];
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface ApplyResult {
  batchId: string;
  dryRun: boolean;
  ok: boolean;
  refused?: { reason: RefusalReason; message: string };
  requests: Array<{
    idempotencyKey: string;
    operation: string;
    path: string;
    groups: number;
    clashes: number;
    outcome: "would_apply" | "applied" | "already_applied" | "failed" | "refused";
    jobId?: string;
    createdIssueIds?: string[];
    message?: string;
    body?: unknown;
  }>;
  items: Array<{ itemId: string; proposalIds: string[]; outcome: "would_apply" | "applied" | "failed" | "refused" | "skipped"; reason?: RefusalReason; accRefs?: string[] }>;
  batchState: BatchRecord["state"];
  auditId?: string;
}

interface AppliedRecord {
  key: string;
  batchId: string;
  operation: string;
  status: "in_progress" | "succeeded" | "failed";
  at: string;
  jobId?: string;
  groups?: string[];
  createdIssueIds?: string[];
  message?: string;
}

export async function applyApproved(
  deps: ApprovalDeps,
  batchId: string,
  opts: { dryRun?: boolean; onlyProposalIds?: readonly string[]; actor: Actor; includeBodies?: boolean },
): Promise<ApplyResult> {
  const dryRun = opts.dryRun !== false;
  const { store, source, config } = deps;
  const refuse = async (reason: RefusalReason, message: string, batch?: BatchRecord): Promise<ApplyResult> => {
    const ev = await store.audit({
      actor: opts.actor,
      action: "apply.refused",
      projectId: batch?.projectId,
      batchId,
      details: { reason, dryRun, message },
    });
    return {
      batchId,
      dryRun,
      ok: false,
      refused: { reason, message },
      requests: [],
      items: (batch ? includedItems(batch) : []).map((i) => ({ itemId: i.id, proposalIds: i.proposalIds, outcome: "refused" as const, reason })),
      batchState: batch?.state ?? "draft",
      auditId: ev.id,
    };
  };

  if (deps.effectiveLevel < 1) return refuse("autonomy_level_forbids", "Nivel de autonomía L0: no se aplican cambios en ACC.");
  const v = await verifyBatchApproval(deps, batchId);
  if (!v.ok) return refuse(v.reason, v.message, v.batch);

  return withFileLock(
    store.path("state", "apply.lock"),
    async () => {
      // Re-read under the apply lock (another process may have applied meanwhile).
      const batch = (await store.getBatch(batchId))!;
      const only = opts.onlyProposalIds ? new Set(opts.onlyProposalIds) : undefined;
      const pending = includedItems(batch).filter(
        (i) => i.result?.status !== "applied" && (!only || i.proposalIds.some((p) => only.has(p))),
      );
      const plan = planRequests(batch, pending, config.apply.maxGroupsPerRequest);
      const result: ApplyResult = { batchId, dryRun, ok: true, requests: [], items: [], batchState: batch.state };

      if (dryRun) {
        for (const r of plan) {
          const prior = await store.getAppliedRecord<AppliedRecord>(r.idempotencyKey);
          result.requests.push({
            idempotencyKey: r.idempotencyKey,
            operation: r.operation,
            path: r.path,
            groups: r.groups,
            clashes: r.clashes,
            outcome: prior?.status === "succeeded" ? "already_applied" : "would_apply",
            ...(opts.includeBodies !== false ? { body: r.body } : {}),
          });
        }
        result.items = pending.map((i) => ({ itemId: i.id, proposalIds: i.proposalIds, outcome: "would_apply" as const }));
        const ev = await store.audit({
          actor: opts.actor,
          action: "apply.dry_run",
          projectId: batch.projectId,
          modelSetId: batch.modelSetId,
          testId: batch.testId,
          batchId,
          details: { requests: plan.length, items: pending.length },
        });
        result.auditId = ev.id;
        return result;
      }

      const log = (text: string, ok: boolean) => {
        batch.apply ??= { log: [], requests: [] };
        batch.apply.log.push({ at: nowIso(store.now()), text, ok });
      };
      const itemById = new Map(batch.items.map((i) => [i.id, i]));
      const approvedBy = v.approval.approvedBy.name;
      const budgetExhausted = new Set<string>();

      for (const r of plan) {
        const prior = await store.getAppliedRecord<AppliedRecord>(r.idempotencyKey);
        if (prior?.status === "succeeded" || prior?.status === "in_progress") {
          // Never send the same body twice. An in_progress record means a crash mid-request:
          // a human must check ACC before retrying (delete the record to force).
          result.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, path: r.path, groups: r.groups, clashes: r.clashes, outcome: prior.status === "succeeded" ? "already_applied" : "failed", jobId: prior.jobId, createdIssueIds: prior.createdIssueIds, message: prior.status === "in_progress" ? "Solicitud previa sin confirmar; revisar ACC" : undefined });
          if (prior.status === "succeeded") markItems(r, prior.createdIssueIds, "applied");
          continue;
        }
        if (budgetExhausted.has(r.operation) || !(await store.reserveJob(bareProjectId(batch.projectId), r.operation, config.apply.jobsPerHourPerOperation))) {
          budgetExhausted.add(r.operation);
          result.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, path: r.path, groups: r.groups, clashes: r.clashes, outcome: "refused", message: "Cupo local de trabajos/hora agotado" });
          for (const id of r.itemIds) result.items.push({ itemId: id, proposalIds: itemById.get(id)!.proposalIds, outcome: "refused", reason: "rate_limited" });
          continue;
        }
        await store.putAppliedRecord(r.idempotencyKey, { key: r.idempotencyKey, batchId, operation: r.operation, status: "in_progress", at: nowIso(store.now()) } satisfies AppliedRecord);
        try {
          const job =
            r.operation === "clash.close"
              ? await source.writer.close(
                  issueApprovedWriteToken({ operation: "clash.close", proposalIds: tokenRefs(r, batchId), approvedBy, body: r.body }),
                  batch.projectId,
                  batch.testId,
                  r.body as ClosedGroupCreate[],
                )
              : await source.writer.assign(
                  issueApprovedWriteToken({ operation: "clash.assign", proposalIds: tokenRefs(r, batchId), approvedBy, body: r.body }),
                  batch.projectId,
                  batch.testId,
                  r.body as AssignedGroupCreate[],
                );
          const done = await source.writer.waitJob(batch.projectId, job.jobId, config.apply.jobTimeoutMs);
          if (done.status !== "Succeeded" && done.status !== "Archived") throw new Error(`job ${job.jobId} ${done.status}`);
          await store.putAppliedRecord(r.idempotencyKey, { key: r.idempotencyKey, batchId, operation: r.operation, status: "succeeded", at: nowIso(store.now()), jobId: done.jobId, groups: done.groups, createdIssueIds: done.createdIssueIds } satisfies AppliedRecord);
          result.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, path: r.path, groups: r.groups, clashes: r.clashes, outcome: "applied", jobId: done.jobId, createdIssueIds: done.createdIssueIds });
          batch.apply ??= { log: [], requests: [] };
          batch.apply.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, status: "succeeded", jobId: done.jobId, createdIssueIds: done.createdIssueIds });
          log(`${r.operation === "clash.close" ? "Cerrados" : "Incidencias creadas para"} ${r.groups} grupos (${r.clashes} interferencias)`, true);
          markItems(r, done.createdIssueIds, "applied");
          await store.audit({
            actor: { type: "server", id: "apply", name: `aprobado por ${approvedBy}` },
            action: r.operation === "clash.close" ? "acc.clash.statusChanged" : "acc.issue.created",
            projectId: batch.projectId,
            modelSetId: batch.modelSetId,
            testId: batch.testId,
            batchId,
            targetIds: r.proposalIds,
            details: { groups: r.groups, clashes: r.clashes, idempotencyKey: r.idempotencyKey, source: source.kind },
            accResponseId: done.jobId,
          });
        } catch (err) {
          const message = (err as Error).message;
          await store.putAppliedRecord(r.idempotencyKey, { key: r.idempotencyKey, batchId, operation: r.operation, status: "failed", at: nowIso(store.now()), message } satisfies AppliedRecord);
          result.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, path: r.path, groups: r.groups, clashes: r.clashes, outcome: "failed", message });
          batch.apply ??= { log: [], requests: [] };
          batch.apply.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, status: "failed", message });
          log(`Error en ${r.operation}: ${message}`, false);
          markItems(r, undefined, "failed", message);
          await store.audit({ actor: { type: "server", id: "apply", name: "apply" }, action: "acc.error", projectId: batch.projectId, batchId, targetIds: r.proposalIds, details: { operation: r.operation, message } });
        }
      }

      function markItems(r: PlannedRequest, issueIds: string[] | undefined, status: "applied" | "failed", message?: string) {
        r.itemIds.forEach((id, idx) => {
          const it = itemById.get(id)!;
          it.result = { status, at: nowIso(store.now()), ...(issueIds?.[idx] ? { accRefs: [issueIds[idx]] } : {}), ...(message ? { message } : {}) };
          result.items.push({ itemId: id, proposalIds: it.proposalIds, outcome: status, ...(status === "failed" ? { reason: "aps_error" as const } : {}), ...(it.result.accRefs ? { accRefs: it.result.accRefs } : {}) });
        });
      }

      // Batch + proposal states.
      const all = includedItems(batch);
      const allApplied = all.every((i) => i.result?.status === "applied");
      const anyAttempted = all.some((i) => i.result);
      const nextState = allApplied ? "applied" : anyAttempted ? "partial" : batch.state;
      if (nextState !== batch.state) batch.state = nextState;
      if (allApplied) batch.appliedAt = nowIso(store.now());
      await store.putBatch(batch);
      result.batchState = batch.state;
      result.ok = result.items.every((i) => i.outcome === "applied");

      for (const pid of batchProposalIds(batch)) {
        const its = all.filter((i) => i.proposalIds.includes(pid));
        const p = await store.getProposal(pid);
        if (!p) continue;
        if (its.every((i) => i.result?.status === "applied") && (p.state === "approved" || p.state === "failed")) {
          await store.transitionProposal(pid, "applied", "apply", batchId);
        } else if (its.some((i) => i.result?.status === "failed") && p.state === "approved") {
          await store.transitionProposal(pid, "failed", "apply", batchId);
        }
      }
      const ev = await store.audit({
        actor: opts.actor,
        action: "apply.executed",
        projectId: batch.projectId,
        modelSetId: batch.modelSetId,
        testId: batch.testId,
        batchId,
        details: { requests: plan.length, applied: result.items.filter((i) => i.outcome === "applied").length, failed: result.items.filter((i) => i.outcome === "failed").length, state: batch.state },
      });
      result.auditId = ev.id;
      return result;
    },
    { staleMs: 15 * 60_000, timeoutMs: 60_000 },
  );
}
