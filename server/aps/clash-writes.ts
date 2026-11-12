/**
 * Clash group WRITES (research §3.3), callable only with an
 * {@link ApprovedWriteToken} from ./write-guard.ts.
 *
 * Fixes legacy §8.1: POST (not GET), path WITHOUT the `modelsets` segment for
 * assign/close, JSON array bodies, 202 + job that must be polled.
 * Quotas (research §7): 250 jobs/h per project for each operation, so batch
 * many groups per POST.
 */
import { ApsError } from "./errors";
import { apsRequest, realSleep, seg, type ApsCtx } from "./http";
import { containerPath } from "./clash";
import { consumeApprovedWriteToken, type ApprovedWriteToken } from "./write-guard";
import type { AssignedGroupCreate, ClashGroupJob, ClosedGroupCreate } from "./types";

const CLOSE_REASONS = new Set([
  "OTHER",
  "VALID_INTERFACE",
  "VALID_PENETRATION",
  "MINIMAL_OVERLAP",
  "ITEM_CAN_FLEX",
  "MODEL_INACCURACY",
  "FIELD_FIX",
]);

function invalid(detail: string): never {
  throw new ApsError({ code: "bad_request", detail });
}

function checkClashIds(ids: readonly number[], where: string): void {
  if (ids.length < 1 || ids.length > 1000) invalid(`${where}: clashes debe tener entre 1 y 1000 ids`);
  for (const id of ids) if (!Number.isSafeInteger(id)) invalid(`${where}: id de clash inválido ${String(id)}`);
}

/** Validate `ClosedGroupCreate[]` against research §3.3 limits. */
export function validateClosedGroups(groups: readonly ClosedGroupCreate[]): void {
  if (groups.length === 0) invalid("se requiere al menos un grupo");
  groups.forEach((g, i) => {
    const w = `grupo ${i}`;
    if (!g.title || g.title.length > 128) invalid(`${w}: title requerido (máx. 128)`);
    if (g.description && g.description.length > 1024) invalid(`${w}: description máx. 1024`);
    if (!CLOSE_REASONS.has(g.reason)) invalid(`${w}: reason inválido`);
    if (g.screenShots && g.screenShots.length > 5) invalid(`${w}: máx. 5 screenShots`);
    checkClashIds(g.clashes, w);
  });
}

/**
 * Validate `AssignedGroupCreate[]` (research §3.3). Title/description use the
 * stricter ACC issue limits (100 / 1000) as the research doc recommends.
 */
export function validateAssignedGroups(groups: readonly AssignedGroupCreate[]): void {
  if (groups.length === 0) invalid("se requiere al menos un grupo");
  groups.forEach((g, i) => {
    const w = `grupo ${i}`;
    if (!g.title || g.title.length > 100) invalid(`${w}: title requerido (máx. 100)`);
    if (g.description && g.description.length > 1000) invalid(`${w}: description máx. 1000`);
    if (!g.issueTypeId || !g.issueSubTypeId) invalid(`${w}: issueTypeId e issueSubTypeId son obligatorios`);
    if (!g.documentVersionUrn || g.documentVersionUrn.length > 80) invalid(`${w}: documentVersionUrn requerido (1..80)`);
    if (!g.pushpin || !Number.isFinite(g.pushpin.objectId)) invalid(`${w}: pushpin.objectId requerido`);
    const loc = g.pushpin.location;
    if (!loc || ![loc.x, loc.y, loc.z].every(Number.isFinite)) invalid(`${w}: pushpin.location inválida`);
    if (g.customAttributes && g.customAttributes.length > 64) invalid(`${w}: máx. 64 customAttributes`);
    if (g.screenShots && g.screenShots.length > 5) invalid(`${w}: máx. 5 screenShots`);
    if (g.viewContext && (g.viewContext.length < 1 || g.viewContext.length > 50)) invalid(`${w}: viewContext 1..50`);
    checkClashIds(g.clashes, w);
  });
}

/** POST `tests/{testId}/clashes:assign` — creates an ACC issue per group. */
export async function assignClashes(
  ctx: ApsCtx,
  approval: ApprovedWriteToken<"clash.assign">,
  containerId: string,
  testId: string,
  groups: AssignedGroupCreate[],
): Promise<ClashGroupJob> {
  validateAssignedGroups(groups);
  consumeApprovedWriteToken(approval, "clash.assign", groups);
  return apsRequest<ClashGroupJob>(ctx, "POST", `${containerPath(containerId)}/tests/${seg(testId)}/clashes:assign`, {
    body: groups,
  });
}

/** POST `tests/{testId}/clashes:close` — "not an issue" groups. */
export async function closeClashes(
  ctx: ApsCtx,
  approval: ApprovedWriteToken<"clash.close">,
  containerId: string,
  testId: string,
  groups: ClosedGroupCreate[],
): Promise<ClashGroupJob> {
  validateClosedGroups(groups);
  consumeApprovedWriteToken(approval, "clash.close", groups);
  return apsRequest<ClashGroupJob>(ctx, "POST", `${containerPath(containerId)}/tests/${seg(testId)}/clashes:close`, {
    body: groups,
  });
}

/** POST `modelsets/{m}/clashes:reopen` — deletes closed groups; cannot be undone. Body: 1..20 group ids. */
export async function reopenClashes(
  ctx: ApsCtx,
  approval: ApprovedWriteToken<"clash.reopen">,
  containerId: string,
  modelSetId: string,
  closedGroupIds: string[],
): Promise<ClashGroupJob> {
  if (closedGroupIds.length < 1 || closedGroupIds.length > 20) invalid("reopen: entre 1 y 20 ids de grupo");
  consumeApprovedWriteToken(approval, "clash.reopen", closedGroupIds);
  return apsRequest<ClashGroupJob>(
    ctx,
    "POST",
    `${containerPath(containerId)}/modelsets/${seg(modelSetId)}/clashes:reopen`,
    { body: closedGroupIds },
  );
}

/** GET `clashes/jobs/{jobId}` (read-only). */
export async function getClashJob(ctx: ApsCtx, containerId: string, jobId: string): Promise<ClashGroupJob> {
  return apsRequest<ClashGroupJob>(ctx, "GET", `${containerPath(containerId)}/clashes/jobs/${seg(jobId)}`);
}

/**
 * Poll a clash group job until `Succeeded` (returned) or `Failed` (throws
 * `job_failed`). `createdIssueIds` arrive on success (research §3.3 apply flow).
 */
export async function waitClashJob(
  ctx: ApsCtx,
  containerId: string,
  jobId: string,
  opts: { timeoutMs?: number; intervalMs?: number; now?: () => number } = {},
): Promise<ClashGroupJob> {
  const sleep = ctx.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 5 * 60_000);
  let interval = opts.intervalMs ?? 2000;
  for (;;) {
    const job = await getClashJob(ctx, containerId, jobId);
    if (job.status === "Succeeded" || job.status === "Archived") return job;
    if (job.status === "Failed") throw new ApsError({ code: "job_failed", detail: `job ${jobId}` });
    if (now() >= deadline) throw new ApsError({ code: "timeout", detail: `job ${jobId} sigue en ${job.status}` });
    await sleep(interval);
    interval = Math.min(interval * 1.5, 15_000);
  }
}
