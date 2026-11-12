/**
 * ACC Issues API v1 — READ-ONLY for now (research §5).
 * Base `/construction/issues/v1/projects/{projectId}` (projectId without `b.`).
 * Not BIM 360 compatible. Pagination is limit/offset (`pagination.totalResults`).
 * Clash-linked issues are created through MC `clashes:assign` (research §5,
 * placement issues are read-only in the Issues API).
 */
import { apsRequest, collect, paginateOffset, seg, toContainerId, type ApsCtx, type QueryValue } from "./http";
import type { Issue, IssuesUserMe, IssueType, RootCauseCategory } from "./types";

function base(projectId: string): string {
  return `/construction/issues/v1/projects/${seg(toContainerId(projectId))}`;
}

/** Current user's issue permissions (`issue.new.permittedStatuses`). */
export async function getIssuesMe(ctx: ApsCtx, projectId: string): Promise<IssuesUserMe> {
  return apsRequest<IssuesUserMe>(ctx, "GET", `${base(projectId)}/users/me`);
}

/** Active issue types with their subtypes. */
export async function listIssueTypes(ctx: ApsCtx, projectId: string, opts: { includeInactive?: boolean } = {}): Promise<IssueType[]> {
  return collect(
    paginateOffset<IssueType>(ctx, `${base(projectId)}/issue-types`, {
      include: "subtypes",
      "filter[isActive]": opts.includeInactive ? undefined : true,
    }),
  );
}

/** Root cause categories with root causes (`include=rootcauses` UNVERIFIED, research §5). */
export async function listRootCauses(ctx: ApsCtx, projectId: string): Promise<RootCauseCategory[]> {
  return collect(
    paginateOffset<RootCauseCategory>(ctx, `${base(projectId)}/issue-root-cause-categories`, { include: "rootcauses" }),
  );
}

export interface IssueFilter {
  id?: string[];
  issueTypeId?: string[];
  issueSubtypeId?: string[];
  status?: string[];
  linkedDocumentUrn?: string[];
  rootCauseId?: string[];
  search?: string;
  displayId?: number[];
  updatedAt?: string;
}

/** List issues. Filters map to `filter[<name>]=a,b` (research §5). */
export async function listIssues(ctx: ApsCtx, projectId: string, filter: IssueFilter = {}): Promise<Issue[]> {
  const query: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    query[`filter[${k}]`] = Array.isArray(v) ? v.join(",") : (v as string);
  }
  return collect(paginateOffset<Issue>(ctx, `${base(projectId)}/issues`, query));
}

export async function getIssue(ctx: ApsCtx, projectId: string, issueId: string): Promise<Issue> {
  return apsRequest<Issue>(ctx, "GET", `${base(projectId)}/issues/${seg(issueId)}`);
}
