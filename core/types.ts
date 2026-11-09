/**
 * Canonical, isomorphic domain types for clash ingestion.
 *
 * Rules for this file (docs/PLAN.md "core/"): pure TypeScript, no Node or DOM
 * APIs, string-literal unions instead of enums. Field semantics follow
 * docs/research/aps-model-coordination-api.md (cited below as "research §x").
 *
 * Classification fields are deliberately left as `classification?: unknown`.
 * A later step (core/classify) narrows them once the BIM taxonomy is final.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Clash tests
// ─────────────────────────────────────────────────────────────────────────────

/** Clash test status as returned by Clash v3 (research §3.1). */
export type ClashTestStatus = "Pending" | "Processing" | "Success" | "Failed";

/** Identity of one clash test run (one per model set version, research §3.1). */
export interface ClashTestRef {
  /** Data Management project id WITHOUT the `b.` prefix (research §1.4). */
  containerId: string;
  modelSetId: string;
  modelSetVersion: number;
  testId: string;
  status: ClashTestStatus | (string & {});
  completedOn?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

/** Where a document's discipline came from. `unassigned` until core/classify runs. */
export type DisciplineSource = "unassigned" | "rule" | "manual";

/**
 * One clash document (a 3D viewable of a seed file in a model set version).
 * One RVT seed can produce several documents (research §2).
 */
export interface ModelDocument {
  /** Numeric id from `scope-version-document` (`ldid` / `rdid` point here). */
  id: number;
  /** Version URN; equals model set `documentVersions[].versionUrn` exactly (research §2, §8.8). */
  urn: string;
  viewableName: string;
  /** `documentLineage.lineageUrn`, when the model set version was supplied. */
  lineageUrn?: string;
  /** Seed file version URN to index with Model Properties (research §4 "What to index"). */
  seedVersionUrn?: string;
  /** Human file name, e.g. `PRJ-EST-MOD-001.rvt` (`originalSeedFileVersionName` or `displayName`). */
  displayName: string;
  viewableGuid?: string;
  /** Viewer derivative URN = base64url(bubbleUrn) without padding (research §2, S:clashview). */
  viewerUrn?: string;
  /** Model set `documentStatus` (Succeeded, Failed, ...). */
  documentStatus?: string;
  /** False when no `documentVersions[]` entry matched this document's URN. */
  matchedModelSet: boolean;
  /** Discipline code from rules/discipline-matrix.yaml; null until classified. */
  discipline: string | null;
  disciplineSource: DisciplineSource;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clashes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapped clash status. The raw numeric codes 1–4 come from the legacy client and
 * are UNVERIFIED (research §3.2, §8.7); `unknown` covers anything else.
 * The real triage state is derived from clash groups, see {@link TriageState}.
 */
export type ClashStatus = "active" | "reviewed" | "resolved" | "closed" | "unknown";

/** Triage state derived from assigned/closed groups (research §3.3). */
export type TriageState = "open" | "assigned" | "closed";

/**
 * Hard = geometric penetration; clearance = no penetration (distance ≥ 0).
 * `unknown` when the distance is missing. Depends on the UNVERIFIED sign
 * convention of `dist` (research §3.2).
 */
export type ClashKind = "hard" | "clearance" | "unknown";

/** One side of a clash. */
export interface ClashSide {
  /** Clash document id (`ldid` / `rdid`), key into {@link ModelDocument.id}. */
  documentId: number;
  /** Stable object id (`loid` / `roid`), stable per seed-file lineage. NOT a viewer id. */
  objectId: number;
  /** Viewer dbId (`lvid` / `rvid`) for this document version; joins to Index `lmvId` (research §4.1). */
  viewerDbId: number;
}

/** raw[] key that marks an element as a linked copy (value = original linked externalId). */
export const LINKED_EXTERNAL_ID_KEY = "__coord/linkedExternalId";

export interface NormalizedClash {
  /** Stable clash id across model set versions, as a decimal string (research §3.2). */
  id: string;
  left: ClashSide;
  right: ClashSide;
  /** Signed distance in millimetres. Negative = penetration under the default sign convention. */
  distanceMm: number;
  /** max(0, penetration depth) in millimetres. */
  penetrationMm: number;
  kind: ClashKind;
  /** The raw `dist` value, untouched, for audits and unit re-validation. */
  rawDist: number | null;
  /** The raw `status` value as found in the resource file. */
  rawStatus: string | number | null;
  status: ClashStatus;
  /** Filled in from clash groups when available (research §3.3). */
  triage?: TriageState;
  /** Number of clash-instance rows found for this clash id (normally 1). */
  instanceCount: number;
  /**
   * Cross-version identity fallback: sorted `[left, right]` side tokens joined by
   * `|`, where a token is the element externalId (Revit UniqueId) or, when it is
   * missing, `<modelFile lineage>:<objectId>`. Filled once element props are
   * joined (core/ingest/pair-key.ts); undefined before that.
   */
  pairKey?: string;
  classification?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Elements (Model Properties / Index v2, research §4)
// ─────────────────────────────────────────────────────────────────────────────

export type PropValue = string | number | boolean | null;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Element metadata for one viewer object. Size fields are in millimetres.
 * Field names mirror the ElementFacts list in rules/classification-rules.yaml §4.
 */
export interface ElementProps {
  /** Clash document id this row was resolved for. */
  documentId?: number;
  /** Lineage URN of the seed file (same file across viewables and versions). */
  modelFile?: string;
  /** File name of the seed, e.g. `PRJ-EST-MOD-001.rvt`. */
  documentName?: string;
  /** SVF1 viewer id; the join key with clash `lvid`/`rvid` (research §4.1). */
  lmvId: number;
  svf2Id?: number;
  /** Revit UniqueId. */
  externalId?: string;
  /** Revit ElementId parsed from the `[123456]` suffix of the name, when present. */
  elementId?: string;
  name?: string;
  /** Revit category (`__category__/_RC`), e.g. "Tuberías" / "Pipes". Not yet normalized. */
  category?: string;
  family?: string;
  type?: string;
  level?: string;
  /** Best single system label: systemName ?? systemType ?? systemClassification. */
  system?: string;
  systemClassification?: string;
  systemType?: string;
  systemName?: string;
  /** Raw "Size"/"Tamaño" string, e.g. "110 mmø" or "600x400". */
  size?: string;
  diameterMm?: number;
  outsideDiameterMm?: number;
  widthMm?: number;
  heightMm?: number;
  thicknessMm?: number;
  insulationThicknessMm?: number;
  material?: string;
  workset?: string;
  phaseCreated?: string;
  phaseDemolished?: string;
  fireRating?: string;
  structural?: boolean;
  comments?: string;
  mark?: string;
  /**
   * Bounding box in METRES. Index v2 gives it in model units (research §4.1);
   * the source unit is a mapper option (UNVERIFIED, default ft).
   */
  bbox?: { min: Vec3; max: Vec3 };
  /** Index view ids the row is visible in; empty means not viewable (research §4). */
  views?: string[];
  /** Every property keyed by `"<field category>/<field name>"`. Untrusted model text. */
  raw: Record<string, PropValue>;
  classification?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff across versions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - new: never seen before (neither id nor pairKey).
 * - persisting: matched in prev by clash id, or by pairKey as a fallback.
 * - resolved: in prev, gone from next, both elements still exist.
 * - element_deleted: in prev, gone from next, and at least one side's element
 *   (externalId) no longer exists in next ("resolved by deletion", flag for review).
 * - reappeared: absent from prev but seen in an older version (regression).
 */
export type DiffState = "new" | "persisting" | "resolved" | "element_deleted" | "reappeared" | "out_of_scope";

export interface ClashDiff {
  /** Ids of `next` clashes. */
  new: string[];
  /** Ids of `next` clashes. */
  persisting: string[];
  /** Ids of `prev` clashes. */
  resolved: string[];
  /** Ids of `prev` clashes. */
  element_deleted: string[];
  /** Ids of `next` clashes. */
  reappeared: string[];
  /**
   * Ids of `prev` clashes that would be resolved but belong to a document with a scope change
   * (X6: document removed/replaced, test config changed, mass resolution). Never counted as resolved.
   */
  out_of_scope: string[];
  /** Persisting clashes whose id changed and were matched by pairKey. */
  matchedByPairKey: Array<{ prevId: string; nextId: string; pairKey: string }>;
  counts: Record<DiffState, number>;
}
