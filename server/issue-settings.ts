/**
 * Per-project ACC issue settings (G4, G5):
 *  - the default ACC issue type / subtype used by clashes:assign (e.g. Coordinación / Clash);
 *  - discipline → ACC assignee (company / role / user = Issues `assignedTo` + `assignedToType`).
 *
 * Stored per project, versioned and audited:
 *   .coordinator/projects/<projectId>/issue-settings.json
 *
 * Invariant 7: the assignee is ACC METADATA only (assignedTo id + type in the request body). Its
 * label never goes into an issue title or description. Agents read the mapping (user labels are
 * masked) and can only PROPOSE changes; a human accepts them in the UI.
 */
import type { Store } from "./store";
import { pathSegment } from "./store";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import { bareProjectId, nowIso, sha256 } from "./util";

export type AssigneeKind = "user" | "role" | "company";

export interface MappedAssignee {
  /** ACC id sent as `assignedTo` (Autodesk user id, role id or company id). */
  id: string;
  type: AssigneeKind;
  /** Display label (company / role / user name): UI only, never in issue text. */
  label: string;
}

export interface IssueTypeChoice {
  typeId: string;
  subtypeId: string;
  /** "Coordinación / Clash" */
  label: string;
}

export interface ProjectIssueSettings {
  version: number;
  issueType?: IssueTypeChoice;
  /** Discipline code → assignee. */
  assignees: Record<string, MappedAssignee>;
  updatedAt?: string;
  updatedBy?: string;
}

/** ACC issue type with its subtypes (Issues v1 GET issue-types?include=subtypes). */
export interface AccIssueTypeInfo {
  id: string;
  title: string;
  subtypes: Array<{ id: string; title: string }>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IssueSettingsStore {
  constructor(private readonly store: Store) {}

  path(projectId: string): string {
    return this.store.path("projects", pathSegment(bareProjectId(projectId), "projectId"), "issue-settings.json");
  }

  async load(projectId: string): Promise<ProjectIssueSettings> {
    return (await readJsonFile<ProjectIssueSettings>(this.path(projectId))) ?? { version: 0, assignees: {} };
  }

  /** Versioned update + audit (before/after hashes, no labels in the audit details). */
  async update(projectId: string, by: { id: string; name: string }, mutate: (s: ProjectIssueSettings) => void, action: string, details: Record<string, string | number | boolean | null> = {}): Promise<ProjectIssueSettings> {
    return this.store.withLock(async () => {
      const cur = await this.load(projectId);
      const hash = (s: ProjectIssueSettings) => sha256(JSON.stringify({ t: s.issueType ?? null, a: s.assignees })).slice(0, 16);
      const next: ProjectIssueSettings = JSON.parse(JSON.stringify(cur));
      mutate(next);
      next.version = cur.version + 1;
      next.updatedAt = nowIso(this.store.now());
      next.updatedBy = by.name;
      await writeJsonAtomic(this.path(projectId), next);
      await this.store.audit({ actor: { type: "user", id: by.id, name: by.name }, action, projectId, details: { ...details, version: next.version, before: hash(cur), after: hash(next) } });
      return next;
    });
  }
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Default issue type from the project's ACC list when none is configured: a type named
 * "Coordinación" / "Coordination" with a subtype "Clash" / "Interferencia" / "Choque".
 * Undefined when there is no unambiguous match (the human chooses at approval).
 */
export function pickDefaultIssueType(types: readonly AccIssueTypeInfo[]): IssueTypeChoice | undefined {
  const sub = /^(clash|clashes|interferencia|interferencias|choque|colision)\b/;
  const candidates = types.filter((t) => /^coordina(cion|tion)/.test(fold(t.title)));
  const hits = candidates.flatMap((t) => t.subtypes.filter((s) => sub.test(fold(s.title))).map((s) => ({ t, s })));
  if (hits.length !== 1) return undefined;
  const { t, s } = hits[0]!;
  return { typeId: t.id, subtypeId: s.id, label: `${t.title} / ${s.title}` };
}

/** ACC `assignedToType` from our kind. */
export function accAssigneeType(kind: AssigneeKind): "User" | "Role" | "Company" {
  return kind === "company" ? "Company" : kind === "role" ? "Role" : "User";
}
