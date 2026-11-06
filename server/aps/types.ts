/**
 * APS response/request shapes used by server/aps. Field lists follow
 * docs/research/aps-model-coordination-api.md (§2 model sets, §3 clash,
 * §4 Index v2, §5 Issues) and fix the type gaps listed in §8.9.
 */
import type { RawModelSetVersion, RawViewDefinition } from "../../core/ingest/raw";

export type { RawModelSetVersion as ModelSetVersion };

// ── Model Set v3 (research §2) ──────────────────────────────────────────────

export interface ModelSet {
  modelSetId: string;
  containerId?: string;
  name: string;
  description?: string;
  createdBy?: string;
  createdTime?: string;
  modifiedBy?: string;
  modifiedTime?: string;
  isDisabled?: boolean;
  isDeleted?: boolean;
  includedFolderCount?: number;
  rootFolder?: string;
  hasContentFilters?: boolean;
  clashEngineVersion?: number;
  isDocumentLimitReached?: boolean;
}

export interface ModelSetVersionSummary {
  version: number;
  createTime?: string;
  status: string;
}

export interface ModelSetView {
  viewId: string;
  name: string;
  description?: string;
  isPrivate?: boolean;
  screenshotId?: string;
  definition: RawViewDefinition[];
  createdBy?: string;
  createdTime?: string;
  modifiedBy?: string;
  modifiedTime?: string;
}

// ── Clash v3 (research §3) ──────────────────────────────────────────────────

export interface ClashTest {
  id: string;
  modelSetId: string;
  modelSetVersion: number;
  status: "Pending" | "Processing" | "Success" | "Failed" | (string & {});
  completedOn?: string;
  /** Undocumented (research §3.1); optional. */
  backendType?: string;
}

export interface ClashResource {
  /** e.g. `scope-version-clash.2.0.0`; match on the prefix. */
  type: string;
  extension?: "json.gz" | "sqlite" | (string & {});
  url: string;
  /** Headers that MUST be sent with the presigned GET. */
  headers?: Record<string, string>;
  /** ISO date; re-lease via /resources after it. */
  validUntil?: string;
}

export type CloseReason =
  | "OTHER"
  | "VALID_INTERFACE"
  | "VALID_PENETRATION"
  | "MINIMAL_OVERLAP"
  | "ITEM_CAN_FLEX"
  | "MODEL_INACCURACY"
  | "FIELD_FIX";

export interface ClosedGroupCreate {
  id?: string;
  /** required, max 128 */
  title: string;
  /** max 1024 */
  description?: string;
  reason: CloseReason;
  /** max 5 */
  screenShots?: string[];
  /** 1..1000 stable clash ids */
  clashes: number[];
}

export interface AssignedGroupCreate {
  id?: string;
  /** Keep ≤ 100 (ACC issue title limit). */
  title: string;
  /** Keep ≤ 1000 (ACC issue description limit). */
  description?: string;
  assignedTo?: string;
  /** Capitalised here; the Issues API uses lowercase (research §6). */
  assignedToType?: "User" | "Role" | "Company";
  dueDate?: string;
  locationId?: string;
  locationDescription?: string;
  owner?: string;
  status?: "Open" | "Draft";
  pushpin: {
    location: { x: number; y: number; z: number };
    objectId: number;
    externalId?: string;
    attributesVersion?: number;
    type?: "TwoDVectorPushpin";
    viewerState?: object;
  };
  /** 1..1000 */
  clashes: number[];
  issueTypeId: string;
  /** Capital T here (research §3.3). */
  issueSubTypeId: string;
  rootCauseId?: string;
  customAttributes?: { id: string; value: string }[];
  screenShots?: string[];
  /** 1..80 chars */
  documentVersionUrn: string;
  viewableName?: string;
  viewContext?: { urn: string; viewableName: string }[];
}

export interface ClashGroupJob {
  jobId: string;
  groups: string[];
  createdIssueIds?: string[];
  status: "Failed" | "Running" | "Succeeded" | "Archived" | (string & {});
  job?: { operation?: string; seed?: object };
}

export interface AssignedGroup {
  id: string;
  clashTestId: string;
  issueId: string;
  createdBy?: string;
  createdOn?: string;
  clashes: number[];
}

export interface ClosedGroup {
  id: string;
  clashTestId: string;
  title?: string;
  description?: string;
  reason?: CloseReason;
  screenShots?: string[];
  createdBy?: string;
  createdOn?: string;
  clashes: number[];
}

export interface GroupIntersectionPage {
  modelSetId?: string;
  modelSetVersion?: number;
  groups: Array<{
    id: string;
    originalClashTestId?: string;
    createdAtVersion?: number;
    existing: number[];
    resolved: number[];
  }>;
}

// ── Index v2 (research §4) ─────────────────────────────────────────────────

export type IndexState = "PROCESSING" | "FINISHED" | "FAILED" | (string & {});

export interface IndexStatus {
  projectId: string;
  indexId: string;
  type?: string;
  state: IndexState;
  selfUrl?: string;
  versionUrns?: string[];
  updatedAt?: string;
  retryAt?: string;
  stats?: { objects?: number };
  manifestUrl?: string;
  fieldsUrl?: string;
  propertiesUrl?: string;
  errors?: unknown[];
}

export interface IndexQueryStatus {
  projectId?: string;
  indexId: string;
  queryId: string;
  state: IndexState;
  retryAt?: string;
  queryResultsUrl?: string;
  errors?: unknown[];
}

/** One NDJSON line of `/fields` (research §4). */
export interface IndexField {
  key: string;
  category: string;
  type: string;
  name: string;
  uom: string | null;
}

/** One NDJSON line of `/properties` or query results (research §4). */
export interface IndexRow {
  svf2Id?: number;
  lineageId?: string;
  externalId?: string;
  lmvId: number;
  databaseId?: string;
  props?: Record<string, string | number | boolean | null>;
  propsHash?: string;
  propsIgnored?: Record<string, unknown>;
  geomHash?: string;
  bboxMin?: { x: number; y: number; z: number };
  bboxMax?: { x: number; y: number; z: number };
  views?: string[] | null;
}

export interface IndexManifest {
  schema?: string;
  projectId?: string;
  status?: string;
  seedFiles: Array<{
    lineageId?: string;
    lineageUrn?: string;
    versionUrn: string;
    databases?: unknown[];
    views?: Array<{ id: string; urn?: string; is3d?: boolean; viewableName?: string; viewableId?: string; viewableGuid?: string }>;
  }>;
  errors?: unknown[];
  stats?: { objects?: number; contentLength?: number };
}

// ── ACC Issues v1 (research §5) ────────────────────────────────────────────

export interface IssueSubtype {
  id: string;
  issueTypeId: string;
  title: string;
  code?: string;
  isActive?: boolean;
}

export interface IssueType {
  id: string;
  title: string;
  isActive?: boolean;
  subtypes?: IssueSubtype[];
}

export interface RootCause {
  id: string;
  title: string;
  isActive?: boolean;
}

export interface RootCauseCategory {
  id: string;
  title: string;
  isActive?: boolean;
  rootCauses?: RootCause[];
}

export interface Issue {
  id: string;
  displayId?: number;
  title: string;
  description?: string | null;
  status: string;
  issueTypeId?: string;
  issueSubtypeId?: string;
  assignedTo?: string | null;
  assignedToType?: "user" | "company" | "role" | null;
  dueDate?: string | null;
  rootCauseId?: string | null;
  published?: boolean;
  linkedDocuments?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  [extra: string]: unknown;
}

export interface IssuesUserMe {
  id?: string;
  issue?: { new?: { permittedStatuses?: string[] } } & Record<string, unknown>;
  [extra: string]: unknown;
}
