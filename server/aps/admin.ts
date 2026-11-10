/**
 * ACC Admin API v1 — project members, READ-ONLY (G5: discipline → ACC assignee).
 * `GET /construction/admin/v1/projects/{projectId}/users` (projectId without `b.`), limit/offset.
 * Each member carries its company and project roles, so one call yields the three ACC Issues
 * assignee kinds: user (autodeskId), company (companyId) and role (role id).
 *
 * UNVERIFIED on a live project: the endpoint documents the `account:read` scope, which the
 * coordinator session does not request today (APS_SCOPES); callers treat a failure as "no list"
 * and the UI falls back to entering the ACC id by hand.
 */
import { collect, paginateOffset, seg, toContainerId, type ApsCtx } from "./http";

export interface ProjectUser {
  id: string;
  autodeskId?: string;
  name?: string;
  companyId?: string | null;
  companyName?: string | null;
  roles?: Array<{ id: string; name: string }>;
  status?: string;
}

export async function listProjectUsers(ctx: ApsCtx, projectId: string): Promise<ProjectUser[]> {
  return collect(paginateOffset<ProjectUser>(ctx, `/construction/admin/v1/projects/${seg(toContainerId(projectId))}/users`, {}, 200));
}

/** Members → distinct assignees (companies, roles, then active users), sorted by name. */
export function assigneesFromUsers(users: readonly ProjectUser[]): Array<{ id: string; name: string; kind: "user" | "role" | "company" }> {
  const out = new Map<string, { id: string; name: string; kind: "user" | "role" | "company" }>();
  for (const u of users) {
    if (u.companyId && u.companyName) out.set(`company:${u.companyId}`, { id: u.companyId, name: u.companyName, kind: "company" });
    for (const r of u.roles ?? []) if (r.id && r.name) out.set(`role:${r.id}`, { id: r.id, name: r.name, kind: "role" });
    if (u.autodeskId && u.name && (u.status === undefined || u.status === "active")) out.set(`user:${u.autodeskId}`, { id: u.autodeskId, name: u.name, kind: "user" });
  }
  const order = { company: 0, role: 1, user: 2 } as const;
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, "es"));
}
