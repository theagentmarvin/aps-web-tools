/**
 * Clash Service v3 reads and resource downloads (research §3.1–§3.3).
 * Writes live in ./clash-writes.ts behind the approval guard.
 */
import type {
  RawClashDocumentFile,
  RawClashFile,
  RawClashInstanceFile,
} from "../../core/ingest/raw";
import { ApsError } from "./errors";
import { downloadBytes, parseJsonBytes, type DownloadOptions } from "./download";
import { apsRequest, collect, paginateContinuation, retryDeps, seg, toContainerId, type ApsCtx } from "./http";
import type {
  AssignedGroup,
  ClashResource,
  ClashTest,
  ClosedGroup,
  CloseReason,
  GroupIntersectionPage,
} from "./types";

export const CLASH_BASE = "/bim360/clash/v3";

export function containerPath(containerId: string): string {
  return `${CLASH_BASE}/containers/${seg(toContainerId(containerId))}`;
}

export type ClashTestStatusFilter = "Pending" | "Processing" | "Success" | "Failed";

/** Tests of a model set, or of one model set version when `version` is given. */
export async function listClashTests(
  ctx: ApsCtx,
  containerId: string,
  modelSetId: string,
  version?: number,
  status?: ClashTestStatusFilter,
): Promise<ClashTest[]> {
  const base = `${containerPath(containerId)}/modelsets/${seg(modelSetId)}`;
  const path = version === undefined ? `${base}/tests` : `${base}/versions/${seg(version)}/tests`;
  return collect(paginateContinuation<ClashTest>(ctx, path, "tests", { status }));
}

export async function getClashTest(ctx: ApsCtx, containerId: string, testId: string): Promise<ClashTest> {
  return apsRequest<ClashTest>(ctx, "GET", `${containerPath(containerId)}/tests/${seg(testId)}`);
}

/**
 * Latest successful test (by `completedOn`), research §3.1: normally one per
 * version, but if several exist pick `Success` with the latest `completedOn`.
 */
export function pickLatestSuccessfulTest(tests: readonly ClashTest[]): ClashTest | undefined {
  return tests
    .filter((t) => t.status === "Success")
    .sort((a, b) => (b.completedOn ?? "").localeCompare(a.completedOn ?? "") || b.modelSetVersion - a.modelSetVersion)[0];
}

export async function getClashResources(ctx: ApsCtx, containerId: string, testId: string): Promise<ClashResource[]> {
  return collect(paginateContinuation<ClashResource>(ctx, `${containerPath(containerId)}/tests/${seg(testId)}/resources`, "resources"));
}

export const RESOURCE_PREFIX = {
  clashes: "scope-version-clash.",
  instances: "scope-version-clash-instance.",
  documents: "scope-version-document.",
} as const;
export type ResourceKind = keyof typeof RESOURCE_PREFIX;

/** Select a JSON resource by type prefix (research §3.1: match the prefix, ignore sqlite). */
export function findResource(resources: readonly ClashResource[], kind: ResourceKind): ClashResource | undefined {
  const prefix = RESOURCE_PREFIX[kind];
  return resources.find(
    (r) =>
      r.type.startsWith(prefix) &&
      // "scope-version-clash." must not swallow "scope-version-clash-instance."
      !(kind === "clashes" && r.type.startsWith(RESOURCE_PREFIX.instances)) &&
      r.extension !== "sqlite",
  );
}

/** True when the lease is gone or expires within `skewMs` (research §3.1: re-lease at validUntil − 60 s). */
export function isLeaseExpired(resource: ClashResource, now: number = Date.now(), skewMs = 60_000): boolean {
  if (!resource.validUntil) return false;
  const t = Date.parse(resource.validUntil);
  return Number.isFinite(t) && now > t - skewMs;
}

export interface ClashResults {
  clashes: RawClashFile;
  instances: RawClashInstanceFile;
  documents: RawClashDocumentFile;
  /** Resource `type` strings actually used (log the schema version, research §3.1). */
  resourceTypes: Record<ResourceKind, string>;
}

export interface FetchClashResultsOptions {
  allowedHostSuffixes?: DownloadOptions["allowedHostSuffixes"];
  maxBytes?: number;
  now?: () => number;
}

/**
 * Download and parse the three clash resource files of a test.
 * Sends the presigned `headers` (never the APS token), re-leases URLs when
 * expired or on a 403, and gunzips by magic bytes (research §3.1, fixes §8.6).
 */
export async function fetchClashResults(
  ctx: ApsCtx,
  containerId: string,
  testId: string,
  opts: FetchClashResultsOptions = {},
): Promise<ClashResults> {
  const now = opts.now ?? Date.now;
  const deps = retryDeps(ctx);
  let resources = await getClashResources(ctx, containerId, testId);

  const fetchOne = async <T>(kind: ResourceKind): Promise<{ data: T; type: string }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res = findResource(resources, kind);
      if (!res) {
        throw new ApsError({ code: "not_found", detail: `resource ${RESOURCE_PREFIX[kind]}* missing for test ${testId}` });
      }
      if (isLeaseExpired(res, now())) {
        ctx.log?.info("aps.clash.resource.lease_expired", { kind });
        resources = await getClashResources(ctx, containerId, testId);
        res = findResource(resources, kind) ?? res;
      }
      try {
        const bytes = await downloadBytes(res.url, deps, {
          headers: res.headers ?? {},
          allowedHostSuffixes: opts.allowedHostSuffixes,
          maxBytes: opts.maxBytes,
        });
        ctx.log?.info("aps.clash.resource", { kind, type: res.type, bytes: bytes.byteLength });
        return { data: parseJsonBytes<T>(bytes), type: res.type };
      } catch (err) {
        // An expired presigned URL answers 403 (research §3.1: re-call /resources on 403).
        const expired = err instanceof ApsError && err.status === 403;
        if (!expired || attempt > 0) throw err;
        ctx.log?.warn("aps.clash.resource.release_on_403", { kind });
        resources = await getClashResources(ctx, containerId, testId);
      }
    }
    /* c8 ignore next */
    throw new ApsError({ code: "invalid_response", detail: "unreachable" });
  };

  const clashes = await fetchOne<RawClashFile>("clashes");
  const instances = await fetchOne<RawClashInstanceFile>("instances");
  const documents = await fetchOne<RawClashDocumentFile>("documents");
  return {
    clashes: clashes.data,
    instances: instances.data,
    documents: documents.data,
    resourceTypes: { clashes: clashes.type, instances: instances.type, documents: documents.type },
  };
}

// ── Clash groups (read) — research §3.3 ────────────────────────────────────

/** Every clash id in any assigned or closed group of the model set. */
export async function listGroupedClashIds(ctx: ApsCtx, containerId: string, modelSetId: string): Promise<number[]> {
  const data = await apsRequest<{ clashes?: number[] }>(
    ctx,
    "GET",
    `${containerPath(containerId)}/modelsets/${seg(modelSetId)}/clashes/grouped`,
  );
  return data?.clashes ?? [];
}

export async function listAssignedGroups(
  ctx: ApsCtx,
  containerId: string,
  modelSetId: string,
  filter: { clashTestId?: string; issueId?: string; after?: string } = {},
): Promise<AssignedGroup[]> {
  return collect(
    paginateContinuation<AssignedGroup>(ctx, `${containerPath(containerId)}/modelsets/${seg(modelSetId)}/clashes/assigned`, "groups", filter),
  );
}

export async function listClosedGroups(
  ctx: ApsCtx,
  containerId: string,
  modelSetId: string,
  filter: { clashTestId?: string; reason?: CloseReason; after?: string } = {},
): Promise<ClosedGroup[]> {
  return collect(
    paginateContinuation<ClosedGroup>(ctx, `${containerPath(containerId)}/modelsets/${seg(modelSetId)}/clashes/closed`, "groups", filter),
  );
}

/** Assigned groups intersected with a test: `existing` / `resolved` clash ids per group. */
export async function intersectAssignedGroups(ctx: ApsCtx, containerId: string, testId: string): Promise<GroupIntersectionPage["groups"]> {
  return collect(
    paginateContinuation<GroupIntersectionPage["groups"][number]>(
      ctx,
      `${containerPath(containerId)}/tests/${seg(testId)}/clashes/assigned`,
      "groups",
    ),
  );
}

export async function intersectClosedGroups(ctx: ApsCtx, containerId: string, testId: string): Promise<GroupIntersectionPage["groups"]> {
  return collect(
    paginateContinuation<GroupIntersectionPage["groups"][number]>(
      ctx,
      `${containerPath(containerId)}/tests/${seg(testId)}/clashes/closed`,
      "groups",
    ),
  );
}
