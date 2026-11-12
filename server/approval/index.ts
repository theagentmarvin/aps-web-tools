/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  APPROVAL + APPLY — the only module that may mint ApprovedWriteTokens    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * - {@link approveBatch}: records a HUMAN approval of a `ready` batch. Live
 *   mode REQUIRES a user-verified WebAuthn assertion over a challenge derived
 *   from the batch payload hash; fixtures mode allows a labelled demo approval.
 *   The record is signed with HMAC-SHA256 (out-of-repo key) and a
 *   `batch.approved` audit event (HMAC-chained log) is appended.
 * - {@link verifyBatchApproval}: read-only; re-checks HMAC, payload hash,
 *   expiry, latest model set version, RE-VERIFIES the WebAuthn signature
 *   against the current payload, and requires the matching audit event.
 * - {@link applyApproved}: under the batch lock, re-reads and re-verifies the
 *   batch, requires a prior dry run of the same payload (config), builds the
 *   minimal batched requests, mints single-use tokens, executes, polls jobs.
 *   Idempotency keys prevent resends; a request whose outcome is unknown
 *   (timeout / network error after the POST) is RECONCILED against ACC
 *   (job status, then assigned/closed clash groups) before anything is resent.
 *
 * All batch mutations (approve, return, exclusions, issue edits, preflight,
 * apply) run under {@link withBatchLock}. tests/server/import-guard.test.ts
 * fails if any other non-test file imports `issueApprovedWriteToken`.
 */
import { randomBytes } from "node:crypto";
import { CLASH_BASE } from "../aps/clash";
import type { AssignedGroupCreate, ClosedGroupCreate } from "../aps/types";
import { issueApprovedWriteToken } from "../aps/write-guard";
import type { CoordinatorConfig } from "../config";
import type { DataSource } from "../source/types";
import type { Store } from "../store";
import { withFileLock } from "../store/fs";
import type { Actor, ApprovalRecord, BatchItemRecord, BatchRecord } from "../store/types";
import { bareProjectId, canonicalJson, CoordError, hashOf, nowIso, sha256 } from "../util";
import { loadOrCreateApprovalKey, readApprovalKey, signApproval, verifyApprovalSignature } from "./hmac";
import type { StoredAssertion, WebAuthnService } from "./webauthn";

export type RefusalReason =
  | "not_approved"
  | "approval_signature_invalid"
  | "webauthn_invalid"
  | "demo_approval_not_allowed"
  | "audit_missing"
  | "payload_changed_since_approval"
  | "approval_expired"
  | "autonomy_level_forbids"
  | "stale_test_version"
  | "dry_run_required"
  | "aps_error"
  | "rate_limited"
  | "reconcile_required"
  | "unsupported_operation";

export interface ApprovalDeps {
  store: Store;
  source: DataSource;
  config: CoordinatorConfig;
  effectiveLevel: number;
  /** Out-of-repo directory holding the approval key and WebAuthn credentials. */
  secureDir: string;
  webauthn: WebAuthnService;
}

/** Single lock for every batch mutation and for apply. Heartbeated; stale after 60 s without heartbeat. */
export function withBatchLock<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  return withFileLock(store.path("state", "apply.lock"), fn, { staleMs: 60_000, timeoutMs: 120_000 });
}

/** Items that will be written: included and carrying an MC operation. */
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

/** Copy of the batch with the given item ids excluded (no mutation). */
export function withExclusions(batch: BatchRecord, excluded: readonly string[] = []): BatchRecord {
  if (!excluded.length) return batch;
  const ex = new Set(excluded);
  return { ...batch, items: batch.items.map((i) => (ex.has(i.id) ? { ...i, excluded: true } : i)) };
}

// ── approve ─────────────────────────────────────────────────────────────────

export interface Approver {
  id: string;
  name: string;
  channel: "web-ui" | "cli";
}

export interface ApprovalProof {
  /** Live: verified WebAuthn assertion data from the approve request. */
  webauthn?: { nonce: string; origin: string; response: StoredAssertion["response"] };
  /** Fixtures only: labelled demo approval without WebAuthn. */
  demo?: boolean;
}

/** Options for the WebAuthn approval ceremony (challenge derived from the payload). */
export async function approvalOptions(deps: ApprovalDeps, batchId: string, excludedItemIds: readonly string[] = []) {
  const batch = await deps.store.getBatch(batchId);
  if (!batch) throw new CoordError("not_found", `Lote ${batchId} no existe`);
  if (batch.state !== "ready") throw new CoordError("invalid_state", `El lote está ${batch.state}; solo se aprueban lotes 'ready'.`);
  const latest = await deps.source.latestVersion(batch.projectId, batch.modelSetId);
  if (latest !== batch.modelSetVersion) throw new CoordError("stale_cache", `La prueba es v${batch.modelSetVersion} y el conjunto ya está en v${latest}. Usa «Llevar decisiones a v${latest}» en el lote.`);
  const effective = withExclusions(batch, excludedItemIds);
  const payloadHash = batchPayloadHash(effective);
  const { nonce, options } = await deps.webauthn.approvalOptions(batchId, payloadHash, batch.modelSetVersion);
  return { batchId, payloadHash, testVersion: batch.modelSetVersion, nonce, options, items: includedItems(effective).length };
}

export async function approveBatch(
  deps: ApprovalDeps,
  batchId: string,
  approver: Approver,
  opts: { note?: string; excludedItemIds?: readonly string[] } & ApprovalProof = {},
): Promise<{ batch: BatchRecord; approval: ApprovalRecord }> {
  const { store, source, config } = deps;
  if (deps.effectiveLevel < 1) throw new CoordError("autonomy_level_forbids", "Nivel de autonomía L0: no se pueden aprobar cambios para ACC.");
  if (!approver.id || !approver.name) throw new CoordError("validation_error", "Se requiere la identidad del aprobador.");
  return withBatchLock(store, async () => {
    const stored = await store.getBatch(batchId);
    if (!stored) throw new CoordError("not_found", `Lote ${batchId} no existe`);
    if (stored.state !== "ready") throw new CoordError("invalid_state", `El lote ${batchId} está en estado ${stored.state}; solo se aprueban lotes 'ready'.`);
    // Stale-version check BEFORE touching anything.
    const latest = await source.latestVersion(stored.projectId, stored.modelSetId);
    if (latest !== stored.modelSetVersion) {
      throw new CoordError("stale_cache", `La prueba es de la versión v${stored.modelSetVersion} pero el conjunto ya está en v${latest}. Usa «Llevar decisiones a v${latest}» en el lote (requiere v${latest} analizada).`);
    }
    const batch = withExclusions(stored, opts.excludedItemIds);
    if (includedItems(batch).length === 0) throw new CoordError("validation_error", "El lote no tiene cambios aplicables en ACC.");
    const payloadHash = batchPayloadHash(batch);

    let webauthn: ApprovalRecord["webauthn"];
    let demo: true | undefined;
    if (opts.webauthn) {
      const a = await deps.webauthn.verifyApproval({ batchId, payloadHash, testVersion: batch.modelSetVersion, nonce: opts.webauthn.nonce, origin: opts.webauthn.origin, response: opts.webauthn.response });
      webauthn = { credentialId: a.credentialId, nonce: a.nonce, origin: a.origin, rpID: a.rpID, response: a.response as NonNullable<ApprovalRecord["webauthn"]>["response"] };
    } else if (opts.demo && source.kind === "fixtures") {
      demo = true;
    } else if (source.kind === "fixtures") {
      throw new CoordError("approval_missing", "Modo fixtures: indica demo=true (aprobación de demostración) o firma con passkey.");
    } else {
      throw new CoordError("approval_missing", "La aprobación requiere confirmar con tu passkey (Windows Hello).");
    }

    const key = await loadOrCreateApprovalKey(deps.secureDir);
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
      payloadHash,
      approvedBy: { id: approver.id, name: approver.name, channel: approver.channel },
      approvedAt: nowIso(now),
      expiresAt: nowIso(now + config.autonomy.approvalExpiryDays * 86_400_000),
      nonce: randomBytes(12).toString("hex"),
      ...(opts.note ? { note: opts.note } : {}),
      dataSource: source.kind,
      ...(demo ? { demo } : {}),
      ...(webauthn ? { webauthn } : {}),
    };
    const approval: ApprovalRecord = { ...unsigned, hmac: signApproval(key, unsigned) };
    // Persist exclusions and state only after every check passed.
    const updated = await store.transitionBatch(batchId, "approved", (b) => {
      b.items = batch.items;
      b.approvedBy = approver.name;
      b.approvedAt = approval.approvedAt;
    });
    await store.putApproval(approval);
    for (const pid of approval.proposalIds) {
      const p = await store.getProposal(pid);
      if (p && p.state === "pending_review") await store.transitionProposal(pid, "approved", approver.name, `lote ${batchId}`);
    }
    await store.audit({
      actor: { type: "user", id: approver.id, name: approver.name },
      action: "batch.approved",
      projectId: batch.projectId,
      modelSetId: batch.modelSetId,
      testId: batch.testKey,
      accTestId: batch.testId,
      batchId,
      targetIds: approval.proposalIds,
      details: {
        channel: approver.channel,
        items: approval.itemIds.length,
        payloadHash,
        expiresAt: approval.expiresAt,
        proof: webauthn ? "webauthn" : "demo",
        credentialId: webauthn?.credentialId ?? null,
      },
    });
    return { batch: updated, approval };
  });
}

// ── verify ──────────────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true; approval: ApprovalRecord; batch: BatchRecord }
  | { ok: false; reason: RefusalReason; message: string; approval?: ApprovalRecord; batch?: BatchRecord };

/** Read-only full verification of a batch approval. Never creates anything (not even the key). */
export async function verifyBatchApproval(deps: Pick<ApprovalDeps, "store" | "source" | "secureDir" | "webauthn">, batchId: string): Promise<VerifyResult> {
  const { store, source } = deps;
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false, reason: "not_approved", message: `Lote ${batchId} no existe` };
  const approval = await store.getApproval(batchId);
  if (!approval) return { ok: false, reason: "not_approved", message: "Sin aprobación humana registrada", batch };
  if (batch.state !== "approved" && batch.state !== "partial" && batch.state !== "applied") {
    return { ok: false, reason: "not_approved", message: `Lote en estado ${batch.state}`, approval, batch };
  }
  const key = await readApprovalKey(deps.secureDir);
  if (!key || !verifyApprovalSignature(key, approval) || approval.batchId !== batchId) {
    return { ok: false, reason: "approval_signature_invalid", message: "Firma de aprobación inválida", approval, batch };
  }
  const payloadHash = batchPayloadHash(batch);
  if (approval.payloadHash !== payloadHash) {
    return { ok: false, reason: "payload_changed_since_approval", message: "El lote cambió después de aprobarse", approval, batch };
  }
  if (Date.parse(approval.expiresAt) <= store.now()) {
    return { ok: false, reason: "approval_expired", message: `Aprobación vencida (${approval.expiresAt})`, approval, batch };
  }
  // Proof of human presence.
  if (approval.webauthn) {
    const ok = await deps.webauthn.reverify(approval.webauthn as StoredAssertion, payloadHash, batchId, approval.testVersion);
    if (!ok) return { ok: false, reason: "webauthn_invalid", message: "La firma WebAuthn no corresponde a este lote", approval, batch };
  } else if (!(approval.demo && approval.dataSource === "fixtures" && source.kind === "fixtures")) {
    return { ok: false, reason: "demo_approval_not_allowed", message: "Aprobación sin passkey: solo válida en modo fixtures", approval, batch };
  }
  // Matching audit event in an intact (HMAC-chained) audit log.
  const chain = await store.verifyAudit();
  const events = await store.listAudit();
  const ev = events.find((e) => e.action === "batch.approved" && e.batchId === batchId && e.details.payloadHash === approval.payloadHash);
  if (!chain.ok || !ev) return { ok: false, reason: "audit_missing", message: chain.ok ? "Falta el evento batch.approved en la auditoría" : `Auditoría alterada (evento ${chain.brokenAt})`, approval, batch };
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
    outcome: "would_apply" | "applied" | "already_applied" | "reconciled" | "failed" | "refused" | "unknown";
    jobId?: string;
    createdIssueIds?: string[];
    message?: string;
    body?: unknown;
  }>;
  items: Array<{ itemId: string; proposalIds: string[]; outcome: "would_apply" | "applied" | "failed" | "refused" | "skipped" | "unknown"; reason?: RefusalReason; accRefs?: string[] }>;
  batchState: BatchRecord["state"];
  auditId?: string;
}

/**
 * - in_progress: written just before the POST; a crash leaves it → reconcile.
 * - unknown: the POST may or may not have reached ACC (timeout / network) → reconcile.
 */
interface AppliedRecord {
  key: string;
  batchId: string;
  operation: string;
  status: "in_progress" | "unknown" | "succeeded" | "failed";
  at: string;
  jobId?: string;
  groups?: string[];
  createdIssueIds?: string[];
  message?: string;
}

/** Errors that prove ACC rejected the request (safe to retry later). Anything else = unknown outcome. */
function isDefiniteRejection(err: unknown): boolean {
  const e = err as { name?: string; status?: number; code?: string };
  if (e?.name === "ApsError" && typeof e.status === "number") return e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
  return e?.code === "config" || e?.code === "bad_request";
}

/**
 * Decide whether a request whose outcome is uncertain reached ACC.
 * 1. If we have a job id: ask the job. 2. Else compare every clash of the body
 * with the assigned/closed groups of the test: all present → it was applied;
 * none present → safe to send; partial → a human must check.
 */
async function reconcile(deps: ApprovalDeps, batch: BatchRecord, r: PlannedRequest, prior: AppliedRecord): Promise<"applied" | "not_applied" | "partial"> {
  if (prior.jobId) {
    try {
      const job = await deps.source.writer.waitJob(batch.projectId, prior.jobId, 15_000);
      if (job.status === "Succeeded" || job.status === "Archived") return "applied";
      if (job.status === "Failed") return "not_applied";
    } catch {
      // fall through to the clash-group check
    }
  }
  const st = await deps.source.triageState(batch.projectId, batch.testId);
  const ids = r.body.flatMap((g) => g.clashes.map(String));
  const set = r.operation === "clash.close" ? st.closed : st.assigned;
  const present = ids.filter((id) => set.has(id)).length;
  if (present === ids.length && ids.length > 0) return "applied";
  if (present === 0) return "not_applied";
  return "partial";
}

export async function applyApproved(
  deps: ApprovalDeps,
  batchId: string,
  opts: { dryRun?: boolean; onlyProposalIds?: readonly string[]; actor: Actor; includeBodies?: boolean },
): Promise<ApplyResult> {
  const dryRun = opts.dryRun !== false;
  const { store, source, config } = deps;
  const refuse = async (reason: RefusalReason, message: string, batch?: BatchRecord): Promise<ApplyResult> => {
    const ev = await store.audit({ actor: opts.actor, action: "apply.refused", projectId: batch?.projectId, batchId, details: { reason, dryRun, message } });
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

  return withBatchLock(store, async () => {
    // Verify INSIDE the lock, on the batch as it is now (fixes check-then-act).
    const v = await verifyBatchApproval(deps, batchId);
    if (!v.ok) return refuse(v.reason, v.message, v.batch);
    const batch = v.batch;
    if (batch.state !== "approved" && batch.state !== "partial") return refuse("not_approved", `Lote en estado ${batch.state}`, batch);
    if (batchPayloadHash(batch) !== v.approval.payloadHash) return refuse("payload_changed_since_approval", "El lote cambió después de aprobarse", batch);

    const only = opts.onlyProposalIds ? new Set(opts.onlyProposalIds) : undefined;
    const pending = includedItems(batch).filter((i) => i.result?.status !== "applied" && (!only || i.proposalIds.some((p) => only.has(p))));
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
        testId: batch.testKey,
        accTestId: batch.testId,
        batchId,
        details: { requests: plan.length, items: pending.length, payloadHash: v.approval.payloadHash },
      });
      result.auditId = ev.id;
      return result;
    }

    if (config.autonomy.requireDryRunBeforeApply) {
      const dry = (await store.listAudit()).some((e) => e.action === "apply.dry_run" && e.batchId === batchId && e.details.payloadHash === v.approval.payloadHash);
      if (!dry) return refuse("dry_run_required", "Ejecuta primero un dryRun de este mismo lote (requireDryRunBeforeApply).", batch);
    }

    const log = (text: string, ok: boolean) => {
      batch.apply ??= { log: [], requests: [] };
      batch.apply.log.push({ at: nowIso(store.now()), text, ok });
    };
    const itemById = new Map(batch.items.map((i) => [i.id, i]));
    const approvedBy = v.approval.approvedBy.name;
    const budgetExhausted = new Set<string>();

    const markItems = (r: PlannedRequest, issueIds: string[] | undefined, status: "applied" | "failed" | "unknown", message?: string) => {
      r.itemIds.forEach((id, idx) => {
        const it = itemById.get(id)!;
        if (status !== "unknown") it.result = { status, at: nowIso(store.now()), ...(issueIds?.[idx] ? { accRefs: [issueIds[idx]] } : {}), ...(message ? { message } : {}) };
        result.items.push({ itemId: id, proposalIds: it.proposalIds, outcome: status, ...(status === "failed" ? { reason: "aps_error" as const } : status === "unknown" ? { reason: "reconcile_required" as const } : {}), ...(it.result?.accRefs ? { accRefs: it.result.accRefs } : {}) });
      });
    };
    const req = (r: PlannedRequest, outcome: ApplyResult["requests"][number]["outcome"], extra: Partial<ApplyResult["requests"][number]> = {}) =>
      result.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, path: r.path, groups: r.groups, clashes: r.clashes, outcome, ...extra });
    const saveRecord = (r: PlannedRequest, rec: Omit<AppliedRecord, "key" | "batchId" | "operation" | "at">) =>
      store.putAppliedRecord(r.idempotencyKey, { key: r.idempotencyKey, batchId, operation: r.operation, at: nowIso(store.now()), ...rec } satisfies AppliedRecord);

    for (const r of plan) {
      const prior = await store.getAppliedRecord<AppliedRecord>(r.idempotencyKey);
      if (prior?.status === "succeeded") {
        req(r, "already_applied", { jobId: prior.jobId, createdIssueIds: prior.createdIssueIds });
        markItems(r, prior.createdIssueIds, "applied");
        continue;
      }
      if (prior?.status === "in_progress" || prior?.status === "unknown") {
        // Never resend blindly: find out whether the earlier POST reached ACC.
        const rec = await reconcile(deps, batch, r, prior);
        if (rec === "applied") {
          await saveRecord(r, { status: "succeeded", jobId: prior.jobId, message: "reconciliado con ACC" });
          req(r, "reconciled", { jobId: prior.jobId });
          markItems(r, prior.createdIssueIds, "applied");
          await store.audit({ actor: { type: "server", id: "apply", name: "apply" }, action: "acc.reconciled", projectId: batch.projectId, batchId, details: { idempotencyKey: r.idempotencyKey, outcome: "applied" } });
          continue;
        }
        if (rec === "partial") {
          req(r, "unknown", { message: "ACC tiene parte de las interferencias de esta solicitud; revisar manualmente antes de reintentar" });
          markItems(r, undefined, "unknown");
          continue;
        }
        // not_applied → safe to send below
      }
      if (budgetExhausted.has(r.operation) || !(await store.reserveJob(bareProjectId(batch.projectId), r.operation, config.apply.jobsPerHourPerOperation))) {
        budgetExhausted.add(r.operation);
        req(r, "refused", { message: "Cupo local de trabajos/hora agotado" });
        for (const id of r.itemIds) result.items.push({ itemId: id, proposalIds: itemById.get(id)!.proposalIds, outcome: "refused", reason: "rate_limited" });
        continue;
      }
      await saveRecord(r, { status: "in_progress" });
      let jobId: string | undefined;
      try {
        const job =
          r.operation === "clash.close"
            ? await source.writer.close(issueApprovedWriteToken({ operation: "clash.close", proposalIds: tokenRefs(r, batchId), approvedBy, body: r.body }), batch.projectId, batch.testId, r.body as ClosedGroupCreate[])
            : await source.writer.assign(issueApprovedWriteToken({ operation: "clash.assign", proposalIds: tokenRefs(r, batchId), approvedBy, body: r.body }), batch.projectId, batch.testId, r.body as AssignedGroupCreate[]);
        jobId = job.jobId;
        await saveRecord(r, { status: "unknown", jobId }); // POST accepted; outcome pending until the job settles
        const done = await source.writer.waitJob(batch.projectId, job.jobId, config.apply.jobTimeoutMs);
        if (done.status !== "Succeeded" && done.status !== "Archived") throw Object.assign(new Error(`job ${job.jobId} ${done.status}`), { definite: done.status === "Failed" });
        await saveRecord(r, { status: "succeeded", jobId: done.jobId, groups: done.groups, createdIssueIds: done.createdIssueIds });
        req(r, "applied", { jobId: done.jobId, createdIssueIds: done.createdIssueIds });
        batch.apply ??= { log: [], requests: [] };
        batch.apply.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, status: "succeeded", jobId: done.jobId, createdIssueIds: done.createdIssueIds });
        log(`${r.operation === "clash.close" ? "Cerrados" : "Incidencias creadas para"} ${r.groups} grupos (${r.clashes} interferencias)`, true);
        markItems(r, done.createdIssueIds, "applied");
        await store.audit({
          actor: { type: "server", id: "apply", name: `aprobado por ${approvedBy}` },
          action: r.operation === "clash.close" ? "acc.clash.statusChanged" : "acc.issue.created",
          projectId: batch.projectId,
          modelSetId: batch.modelSetId,
          testId: batch.testKey,
          accTestId: batch.testId,
          batchId,
          targetIds: r.proposalIds,
          details: { groups: r.groups, clashes: r.clashes, idempotencyKey: r.idempotencyKey, source: source.kind },
          accResponseId: done.jobId,
        });
      } catch (err) {
        const message = (err as Error).message;
        const definite = (err as { definite?: boolean }).definite === true || (!jobId && isDefiniteRejection(err));
        if (definite) {
          await saveRecord(r, { status: "failed", ...(jobId ? { jobId } : {}), message });
          req(r, "failed", { message, ...(jobId ? { jobId } : {}) });
          markItems(r, undefined, "failed", message);
        } else {
          // Timeout / network error after (or during) the POST: outcome unknown → reconcile before any resend.
          await saveRecord(r, { status: "unknown", ...(jobId ? { jobId } : {}), message });
          req(r, "unknown", { message: `Resultado incierto (${message}); se reconciliará con ACC antes de reintentar`, ...(jobId ? { jobId } : {}) });
          markItems(r, undefined, "unknown");
        }
        batch.apply ??= { log: [], requests: [] };
        batch.apply.requests.push({ idempotencyKey: r.idempotencyKey, operation: r.operation, status: "failed", message });
        log(`Error en ${r.operation}: ${message}`, false);
        await store.audit({ actor: { type: "server", id: "apply", name: "apply" }, action: "acc.error", projectId: batch.projectId, batchId, targetIds: r.proposalIds, details: { operation: r.operation, message, definite } });
      }
    }

    const all = includedItems(batch);
    const allApplied = all.every((i) => i.result?.status === "applied");
    const anyAttempted = all.some((i) => i.result) || result.items.some((i) => i.outcome === "unknown");
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
      if (its.every((i) => i.result?.status === "applied") && (p.state === "approved" || p.state === "failed")) await store.transitionProposal(pid, "applied", "apply", batchId);
      else if (its.some((i) => i.result?.status === "failed") && p.state === "approved") await store.transitionProposal(pid, "failed", "apply", batchId);
    }
    const ev = await store.audit({
      actor: opts.actor,
      action: "apply.executed",
      projectId: batch.projectId,
      modelSetId: batch.modelSetId,
      testId: batch.testKey,
      accTestId: batch.testId,
      batchId,
      details: { requests: plan.length, applied: result.items.filter((i) => i.outcome === "applied").length, failed: result.items.filter((i) => i.outcome === "failed").length, state: batch.state },
    });
    result.auditId = ev.id;
    return result;
  });
}
