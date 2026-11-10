/**
 * DataSource: everything the coordinator reads from (and, through the approval
 * module only, writes to) ACC. Two implementations:
 *   - live (server/source/live.ts): APS clients in server/aps.
 *   - fixtures (server/source/fixtures.ts): tests/fixtures served as if it were ACC;
 *     writes are recorded locally and never sent anywhere.
 */
import type { AccSnapshot } from "../../core/ingest/ledger";

/** ACC issue fields M3 reads (never comments, never person names). */
export interface SourceIssue {
  id: string;
  displayId?: number;
  title: string;
  status: string;
  dueDate?: string;
  assignedToType?: string;
  createdAt?: string;
}
import type { ElementProps, ModelDocument, NormalizedClash } from "../../core/types";
import type { ApprovedWriteToken } from "../aps/write-guard";
import type { AssignedGroupCreate, ClashGroupJob, ClosedGroupCreate } from "../aps/types";

export interface SourceProject {
  /** DM project id with `b.` prefix. */
  id: string;
  name: string;
  hubId: string;
  hubName: string;
}

export interface SourceModelSet {
  id: string;
  name: string;
  latestVersion: number;
  latestVersionAt?: string;
  documentCount: number;
}

export interface SourceModelSetVersion {
  version: number;
  createdAt?: string;
  status: string;
  documentCount: number;
}

export interface SourceClashTest {
  id: string;
  modelSetId: string;
  modelSetVersion: number;
  status: string;
  completedOn?: string;
  viewName: string;
}

export interface SourceUser {
  id: string;
  name: string;
  email?: string;
}

/** A downloaded + normalized test (core/ingest output plus element props). */
export type SourceClashData = Omit<SourceTestData, "elements" | "propertiesStatus" | "allElementKeys">;

export interface SourceProperties {
  /** Clashes with pairKeys attached. */
  clashes: SourceTestData["clashes"];
  elements: SourceTestData["elements"];
  propertiesStatus: SourceTestData["propertiesStatus"];
  allElementKeys?: string[];
  warnings: string[];
  /** Documents whose rows came from the per-version property cache. */
  cachedDocuments?: number;
}

export interface SourceTestData {
  test: SourceClashTest;
  modelSet: SourceModelSet;
  project: SourceProject;
  clashes: NormalizedClash[];
  documents: ModelDocument[];
  elements: ElementProps[];
  propertiesStatus: "ready" | "pending" | "partial" | "skipped";
  warnings: string[];
  /** Every element token (externalId) in the model set version, for element_deleted detection. */
  allElementKeys?: string[];
}

export interface IngestProgress {
  (step: string, done: number, total: number): void;
}

export interface ClashWriter {
  /** `clashes:assign`: creates one ACC issue per group. */
  assign(token: ApprovedWriteToken<"clash.assign">, projectId: string, testId: string, groups: AssignedGroupCreate[]): Promise<ClashGroupJob>;
  /** `clashes:close`: closes groups as "not an issue". */
  close(token: ApprovedWriteToken<"clash.close">, projectId: string, testId: string, groups: ClosedGroupCreate[]): Promise<ClashGroupJob>;
  waitJob(projectId: string, jobId: string, timeoutMs: number): Promise<ClashGroupJob>;
}

export interface DataSource {
  readonly kind: "live" | "fixtures";
  authStatus(): Promise<{ loggedIn: boolean; expiresAt?: number; scopes?: string[]; needsReauth?: boolean }>;
  currentUser(): Promise<SourceUser | undefined>;
  listHubs(): Promise<Array<{ id: string; name: string }>>;
  listProjects(opts?: { hubId?: string; nameContains?: string }): Promise<SourceProject[]>;
  getProject(projectId: string): Promise<SourceProject | undefined>;
  listModelSets(projectId: string): Promise<SourceModelSet[]>;
  /** Folder name of a document (Data Management parent of its lineage item); undefined if unknown. */
  folderOf?(projectId: string, lineageUrn: string): Promise<string | undefined>;
  listModelSetVersions(projectId: string, modelSetId: string): Promise<SourceModelSetVersion[]>;
  listClashTests(projectId: string, modelSetId: string, version?: number): Promise<SourceClashTest[]>;
  /** Latest model set version number (approval freshness check). */
  latestVersion(projectId: string, modelSetId: string): Promise<number>;
  /** Download, normalize and (optionally) fetch element props. */
  fetchTest(projectId: string, modelSetId: string, testId: string, opts: { fetchProperties: boolean; progress?: IngestProgress }): Promise<SourceTestData>;
  /** Phase 1 (seconds): clash resources only, no element properties. */
  fetchClashes(projectId: string, modelSetId: string, testId: string): Promise<SourceClashData>;
  /** Phase 2: element properties for the clashed elements (+ pairKeys). */
  fetchProperties(projectId: string, data: SourceClashData, progress?: IngestProgress): Promise<SourceProperties>;
  /** Saved model set views ("what is being clashed"): name + lineage/viewable entries. */
  listModelSetViews(projectId: string, modelSetId: string): Promise<Array<{ name: string; definition: Array<{ lineageUrn: string; viewableName?: string }> }>>;
  /**
   * X1: ACC assigned/closed groups intersected with a test (existing / resolved clash ids),
   * with issueId / close reason from the model-set group lists. Read-only.
   */
  accState(projectId: string, modelSetId: string, testId: string, version: number): Promise<AccSnapshot>;
  /** M3: ACC issues by id (Issues v1, read-only). Missing ids are simply absent. */
  getIssues(projectId: string, issueIds: readonly string[]): Promise<SourceIssue[]>;
  /** Clash ids currently in assigned / closed groups for a test (preflight). */
  triageState(projectId: string, testId: string): Promise<{ assigned: Set<string>; closed: Set<string> }>;
  listAssignees(projectId: string): Promise<Array<{ id: string; name: string; kind: "user" | "role" | "company" }>>;
  /** G4: ACC issue types with subtypes (Issues v1, GET only). Optional for test doubles. */
  listIssueTypes?(projectId: string): Promise<Array<{ id: string; title: string; subtypes: Array<{ id: string; title: string }> }>>;
  readonly writer: ClashWriter;
}
