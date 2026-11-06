/**
 * Raw clash resources → {@link NormalizedClash}[] + {@link ModelDocument}[].
 *
 * Replaces legacy `processClashes` (research §8):
 * - keeps EVERY instance and resolves BOTH `ldid` and `rdid` (§8.3);
 * - stable ids (`loid`/`roid`) and viewer ids (`lvid`/`rvid`) are both kept (§8.2);
 * - model set view filtering is OPTIONAL and never required for ingest (§8.4);
 * - `dist` unit/sign are parameters with the documented defaults (§3.2, UNVERIFIED);
 * - document matching is exact on the version URN (§8.8).
 */
import type { ClashSide, ModelDocument, NormalizedClash } from "../types";
import { buildModelDocuments } from "./documents";
import type {
  RawClash,
  RawClashDocument,
  RawClashDocumentFile,
  RawClashFile,
  RawClashInstance,
  RawClashInstanceFile,
  RawDocumentVersion,
  RawViewDefinition,
} from "./raw";
import { mapClashStatus } from "./status";
import {
  convertDist,
  DEFAULT_DIST_SIGN,
  DEFAULT_DIST_UNIT,
  type DistanceUnit,
  type DistSignConvention,
} from "./units";

/** The three resource files of one clash test, either as files or as bare row arrays. */
export interface RawClashResources {
  clashes: RawClashFile | readonly RawClash[];
  instances: RawClashInstanceFile | readonly RawClashInstance[];
  documents: RawClashDocumentFile | readonly RawClashDocument[];
}

export interface ViewFilterOption {
  /** `modelSetViews[].definition` (research §2). */
  definition: readonly RawViewDefinition[];
  /** Keep a clash when both sides (default) or at least one side is in the view. */
  match?: "both" | "either";
}

export interface IngestOptions {
  /** Unit of raw `dist`. Default "m" (documented assumption, UNVERIFIED, research §3.2). */
  distUnit?: DistanceUnit;
  /** Default "negative_is_penetration" (documented assumption, UNVERIFIED). */
  distSign?: DistSignConvention;
  /** Model set version `documentVersions[]`: names, lineage, viewer URN, view filtering. */
  documentVersions?: readonly RawDocumentVersion[];
  /** Optional UI-style filter by a model set view. Requires `documentVersions`. */
  viewFilter?: ViewFilterOption;
}

export type IngestWarningCode =
  | "missing_instance"
  | "multiple_instances"
  | "orphan_instance"
  | "unknown_document"
  | "object_id_mismatch"
  | "unmatched_document_version"
  | "view_filter_without_document_versions"
  | "duplicate_clash_id";

export interface IngestWarning {
  code: IngestWarningCode;
  count: number;
  /** Up to 10 example ids (clash ids or document ids). */
  examples: string[];
}

export interface IngestResult {
  clashes: NormalizedClash[];
  documents: ModelDocument[];
  warnings: IngestWarning[];
  stats: {
    rawClashes: number;
    rawInstances: number;
    documents: number;
    kept: number;
    droppedNoInstance: number;
    droppedByViewFilter: number;
  };
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

function rowsOf<T>(v: unknown, key: string): readonly T[] {
  if (Array.isArray(v)) return v as T[];
  const arr = (v as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(arr) ? (arr as T[]) : [];
}

class WarningBag {
  private readonly map = new Map<IngestWarningCode, IngestWarning>();
  add(code: IngestWarningCode, example: string | number): void {
    const w = this.map.get(code) ?? { code, count: 0, examples: [] };
    w.count++;
    if (w.examples.length < 10) w.examples.push(String(example));
    this.map.set(code, w);
  }
  list(): IngestWarning[] {
    return [...this.map.values()];
  }
}

/** Document ids that belong to a model set view (lineage + viewableName). */
function documentsInView(documents: readonly ModelDocument[], filter: ViewFilterOption): Set<number> {
  const keys = new Set(filter.definition.map((d) => `${d.lineageUrn}\u0000${d.viewableName}`));
  return new Set(
    documents
      .filter((d) => d.lineageUrn !== undefined && keys.has(`${d.lineageUrn}\u0000${d.viewableName}`))
      .map((d) => d.id),
  );
}

/**
 * Normalise the three clash resource files of one clash test.
 *
 * @throws IngestError when a clash id is not a safe integer (research §3.2:
 *   switch to a lossless JSON parser if this ever fires).
 */
export function normalizeClashTest(raw: RawClashResources, options: IngestOptions = {}): IngestResult {
  const unit = options.distUnit ?? DEFAULT_DIST_UNIT;
  const sign = options.distSign ?? DEFAULT_DIST_SIGN;
  const warnings = new WarningBag();

  const rawClashes = rowsOf<RawClash>(raw.clashes, "clashes");
  const rawInstances = rowsOf<RawClashInstance>(raw.instances, "instances");
  const rawDocs = rowsOf<RawClashDocument>(raw.documents, "documents");

  const documents = buildModelDocuments(rawDocs, options.documentVersions ?? []);
  const docIds = new Set(documents.map((d) => d.id));
  if (options.documentVersions) {
    for (const d of documents) if (!d.matchedModelSet) warnings.add("unmatched_document_version", d.id);
  }

  let inView: Set<number> | undefined;
  if (options.viewFilter) {
    if (!options.documentVersions) warnings.add("view_filter_without_document_versions", "viewFilter");
    else inView = documentsInView(documents, options.viewFilter);
  }

  const instancesByCid = new Map<number, RawClashInstance[]>();
  for (const inst of rawInstances) {
    const list = instancesByCid.get(inst.cid);
    if (list) list.push(inst);
    else instancesByCid.set(inst.cid, [inst]);
  }

  const out: NormalizedClash[] = [];
  const seen = new Set<number>();
  let droppedNoInstance = 0;
  let droppedByViewFilter = 0;

  for (const c of rawClashes) {
    if (!Number.isSafeInteger(c.id)) {
      throw new IngestError(
        `Clash id ${String(c.id)} is not a safe integer; use a lossless JSON parser (research §3.2).`,
      );
    }
    if (seen.has(c.id)) {
      warnings.add("duplicate_clash_id", c.id);
      continue;
    }
    seen.add(c.id);

    const insts = instancesByCid.get(c.id);
    if (!insts || insts.length === 0) {
      warnings.add("missing_instance", c.id);
      droppedNoInstance++;
      continue;
    }
    if (insts.length > 1) warnings.add("multiple_instances", c.id);
    const inst = insts[0];

    if (!docIds.has(inst.ldid)) warnings.add("unknown_document", inst.ldid);
    if (!docIds.has(inst.rdid)) warnings.add("unknown_document", inst.rdid);
    if (Array.isArray(c.clash) && c.clash.length === 2 && (c.clash[0] !== inst.loid || c.clash[1] !== inst.roid)) {
      warnings.add("object_id_mismatch", c.id);
    }

    if (inView) {
      const l = inView.has(inst.ldid);
      const r = inView.has(inst.rdid);
      const keep = (options.viewFilter?.match ?? "both") === "both" ? l && r : l || r;
      if (!keep) {
        droppedByViewFilter++;
        continue;
      }
    }

    const left: ClashSide = { documentId: inst.ldid, objectId: inst.loid, viewerDbId: inst.lvid };
    const right: ClashSide = { documentId: inst.rdid, objectId: inst.roid, viewerDbId: inst.rvid };
    const d = convertDist(c.dist, unit, sign);
    out.push({
      id: String(c.id),
      left,
      right,
      distanceMm: d.distanceMm,
      penetrationMm: d.penetrationMm,
      kind: d.kind,
      rawDist: typeof c.dist === "number" ? c.dist : null,
      rawStatus: c.status ?? null,
      status: mapClashStatus(c.status),
      instanceCount: insts.length,
    });
  }

  for (const cid of instancesByCid.keys()) if (!seen.has(cid)) warnings.add("orphan_instance", cid);

  out.sort((a, b) => Number(a.id) - Number(b.id));
  return {
    clashes: out,
    documents,
    warnings: warnings.list(),
    stats: {
      rawClashes: rawClashes.length,
      rawInstances: rawInstances.length,
      documents: documents.length,
      kept: out.length,
      droppedNoInstance,
      droppedByViewFilter,
    },
  };
}
