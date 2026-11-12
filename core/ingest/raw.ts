/**
 * Raw APS payload shapes consumed by ingest. Pure types, shared with server/aps.
 *
 * Source: docs/research/aps-model-coordination-api.md §2 (model set version)
 * and §3.2 (clash resource files). Envelope fields `scope` / `version` are
 * UNVERIFIED (legacy observation), so they are optional here.
 */

/** `scope-version-clash.*` row (research §3.2). */
export interface RawClash {
  /** Stable clash id across model set versions. */
  id: number;
  /** The two stable object ids (= loid, roid). */
  clash: [number, number] | number[];
  /** Units and sign UNVERIFIED (research §3.2): legacy says metres, negative = penetration. */
  dist: number;
  /** Raw type UNVERIFIED: numbers 1–4 in legacy, `"New"` in grouped data. */
  status: string | number;
}

/** `scope-version-clash-instance.*` row (research §3.2). */
export interface RawClashInstance {
  /** FK to RawClash.id */
  cid: number;
  ldid: number;
  rdid: number;
  /** Stable object ids (NOT viewer ids). */
  loid: number;
  roid: number;
  /** Viewer object ids (dbId) for this document version; join to Index `lmvId`. */
  lvid: number;
  rvid: number;
}

/** `scope-version-document.*` row (research §3.2). */
export interface RawClashDocument {
  id: number;
  /** Equals model set `documentVersions[].versionUrn` exactly. */
  urn: string;
  viewableName: string;
}

export interface RawClashFile {
  scope?: string;
  version?: number;
  clashes: RawClash[];
}
export interface RawClashInstanceFile {
  scope?: string;
  version?: number;
  instances: RawClashInstance[];
}
export interface RawClashDocumentFile {
  scope?: string;
  version?: number;
  documents: RawClashDocument[];
}

/** Model set version `documentVersions[]` entry (research §2). */
export interface RawDocumentVersion {
  stableDocumentId?: string;
  unstableDocumentId?: string;
  documentLineage: {
    lineageUrn: string;
    parentFolderUrn?: string;
    isAligned?: boolean;
    tipVersionUrn?: string;
  };
  alignment?: {
    transform?: number[];
    checksum?: string;
    upAxis?: number[];
    distanceUnit?: string;
  };
  isTipVersion?: boolean;
  documentStatus?: "Succeeded" | "Failed" | "Running" | "Skipped" | (string & {});
  forgeType?: string;
  versionUrn: string;
  displayName?: string;
  revision?: number;
  viewableName: string;
  createUserId?: string;
  createTime?: string;
  viewableGuid?: string;
  viewableId?: string;
  viewableMime?: string;
  bubbleUrn?: string;
  isSvf2Supported?: boolean;
  originalSeedFileVersionSize?: number;
  originalSeedFileVersionUrn?: string;
  originalSeedFileVersionName?: string;
}

export type ModelSetVersionStatus = "Pending" | "Processing" | "Successful" | "Partial" | "Failed";

/** Full model set version (research §2). */
export interface RawModelSetVersion {
  modelSetId: string;
  version: number;
  createTime?: string;
  status: ModelSetVersionStatus | (string & {});
  documentVersions: RawDocumentVersion[];
}

/** Model set view definition entry: a saved viewer subset, NOT a clash test (research §2, §8.4). */
export interface RawViewDefinition {
  lineageUrn: string;
  viewableName: string;
}
