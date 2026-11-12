/**
 * Model Set Service v3 reads (research §2). All list endpoints are paginated
 * by `page.continuationToken` with at most 20 items per page (fixes §8.5).
 */
import { apsRequest, collect, paginateContinuation, seg, toContainerId, type ApsCtx } from "./http";
import type { ModelSet, ModelSetVersion, ModelSetVersionSummary, ModelSetView } from "./types";

const BASE = "/bim360/modelset/v3";

function msPath(containerId: string, modelSetId?: string): string {
  const c = `${BASE}/containers/${seg(toContainerId(containerId))}/modelsets`;
  return modelSetId ? `${c}/${seg(modelSetId)}` : c;
}

export async function listModelSets(
  ctx: ApsCtx,
  containerId: string,
  opts: { includeDisabled?: boolean; name?: string } = {},
): Promise<ModelSet[]> {
  return collect(
    paginateContinuation<ModelSet>(ctx, msPath(containerId), "modelSets", {
      pageLimit: 20,
      includeDisabled: opts.includeDisabled,
      name: opts.name,
    }),
  );
}

export async function getModelSet(ctx: ApsCtx, containerId: string, modelSetId: string): Promise<ModelSet> {
  return apsRequest<ModelSet>(ctx, "GET", msPath(containerId, modelSetId));
}

export type ModelSetVersionStatusFilter = "Pending" | "Processing" | "Successful" | "Partial" | "Failed";

export async function listModelSetVersions(
  ctx: ApsCtx,
  containerId: string,
  modelSetId: string,
  status?: ModelSetVersionStatusFilter[],
): Promise<ModelSetVersionSummary[]> {
  return collect(
    paginateContinuation<ModelSetVersionSummary>(ctx, `${msPath(containerId, modelSetId)}/versions`, "modelSetVersions", {
      pageLimit: 20,
      "status[]": status,
    }),
  );
}

/** Full version object with `documentVersions` (research §2). */
export async function getModelSetVersion(
  ctx: ApsCtx,
  containerId: string,
  modelSetId: string,
  version: number | "latest",
): Promise<ModelSetVersion> {
  return apsRequest<ModelSetVersion>(ctx, "GET", `${msPath(containerId, modelSetId)}/versions/${seg(version)}`);
}

/** Saved viewer subsets, NOT clash tests (research §2, §8.4). */
export async function listModelSetViews(ctx: ApsCtx, containerId: string, modelSetId: string): Promise<ModelSetView[]> {
  return collect(
    paginateContinuation<ModelSetView>(ctx, `${msPath(containerId, modelSetId)}/views`, "modelSetViews", { pageLimit: 20 }),
  );
}
