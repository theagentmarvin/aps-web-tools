/**
 * ACC issue types + assignee candidates of a project (G4/G5), read once per project per page
 * load and shared by every issue card (a batch can hold dozens of issues).
 */
import { useEffect, useState } from "react";
import type { CoordinatorApi } from "~/lib/api/coordinator-api";
import type { AccIssueType, Assignee } from "~/lib/api/types";

export interface IssueOptions {
  types: AccIssueType[];
  assignees: Assignee[];
  /** true when ACC could not be read (lists empty). */
  failed: boolean;
}

const cache = new Map<string, Promise<IssueOptions>>();

export function loadIssueOptions(api: CoordinatorApi, projectId: string): Promise<IssueOptions> {
  let p = cache.get(projectId);
  if (!p) {
    p = Promise.all([api.listIssueTypes(projectId).catch(() => null), api.listAssignees(projectId).catch(() => null)]).then(([types, assignees]) => ({
      types: types ?? [],
      assignees: assignees ?? [],
      failed: types === null || assignees === null,
    }));
    cache.set(projectId, p);
    // Retry on the next mount after a failure.
    p.then((o) => o.failed && cache.delete(projectId), () => cache.delete(projectId));
  }
  return p;
}

export function useIssueOptions(api: CoordinatorApi, projectId: string | undefined): IssueOptions | undefined {
  const [opts, setOpts] = useState<IssueOptions>();
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void loadIssueOptions(api, projectId).then((o) => alive && setOpts(o));
    return () => {
      alive = false;
    };
  }, [api, projectId]);
  return opts;
}

/** Flat "type / subtype" choices. */
export function typeChoices(types: readonly AccIssueType[]): Array<{ typeId: string; subtypeId: string; label: string }> {
  return types.flatMap((t) => t.subtypes.map((s) => ({ typeId: t.id, subtypeId: s.id, label: `${t.title} / ${s.title}` })));
}
