/**
 * APS Model Coordination API client.
 *
 * MC API v3 uses FLAT response wrappers (e.g. { modelSets: [...] }),
 * NOT the HATEOAS { data: [...] } wrapper used by the Data Management API v1.
 *
 * Base: https://developer.api.autodesk.com/bim360/
 * Proxied through Vite dev server at /api/aps/
 */
// ── Types ────────────────────────────────────────────────────────────

/** Raw APS response from GET /modelsets */
export interface ModelSet {
  modelSetId: string;
  name: string;
  containerId?: string;
  createdBy?: string;
  createdTime?: string;
}

/** Raw APS response from GET /modelsets/{id}/versions/latest.
 *  NOTE: does NOT include modelSetViews — those are a separate endpoint. */
export interface ModelSetLatest {
  modelSetId: string;
  /** Sequential version number (1, 2, 3…) */
  version: number;
  status: string;
  createTime: string;
  documentVersions: DocumentVersion[];
}

export interface DocumentVersion {
  versionUrn: string;
  viewableName: string;
  documentLineage: { lineageUrn: string };
  stableDocumentId: string;
  displayName?: string;
}

/** Clash view — from GET /modelsets/{id}/views.
 *  APS returns `viewId`; `id` is our normalized alias. */
export interface ClashView {
  /** APS `viewId` field */
  viewId: string;
  /** Alias for viewId */
  id: string;
  name: string;
  definition: { lineageUrn: string; viewableName: string }[];
}

/** Clash test — from GET /clash/v3/…/versions/{n}/tests */
export interface ClashTest {
  id: string;
  status: string;
  completedOn: string;
  backendType: string;
  modelSetVersion: number;
  modelSetId: string;
}

/** Clash resource — from GET /clash/v3/…/tests/{id}/resources.
 *  Reference URL pattern: /containers/{containerId}/tests/{testId}/resources
 *  (no modelsets/versions path segments) */
export interface ClashResource {
  /** e.g. "scope-version-clash.2.0.0" */
  type: string;
  /** S3 presigned URL — fetch directly, no APS auth needed */
  url: string;
}

// ── Raw clash data from S3 ───────────────────────────────────────────

/** APS clash data from S3 — observed schema (OtgClashPipeline backend, v3) */
export interface ClashDataRaw {
  scope: string;
  version: number;
  clashes: {
    /** Numeric clash ID (e.g. 41299469560661) */
    id: number;
    /** Array of 2 element indices [left, right] */
    clash: number[];
    /** Distance in METERS. Negative = penetration. */
    dist: number;
    /** Numeric status: 1=active, etc. */
    status: number;
  }[];
}

export interface ClashInstanceRaw {
  scope: string;
  version: number;
  instances: {
    /** Numeric clash ID → links to ClashDataRaw.clashes[].id */
    cid: number;
    /** Left document ID (number, not string) */
    ldid: number;
    /** Right document ID */
    rdid: number;
    /** Left object dbId in viewer */
    loid: number;
    lvid: number;
    /** Right object dbId in viewer */
    roid: number;
    rvid: number;
  }[];
}

export interface ClashDocumentRaw {
  scope: string;
  version: number;
  documents: {
    /** Numeric document ID (0, 1, 2…) */
    id: number;
    urn: string;
    viewableName: string;
    lineage?: string;
    name?: string;
  }[];
}

// ── Processed clash for UI ───────────────────────────────────────────

export interface ProcessedClash {
  id: string;
  status: string;
  distance: number;
  penetration: number;
  entity1: string;
  entity2: string;
  leftDbId: number;
  rightDbId: number;
  documentId: string;
}

// ── Clash status codes ───────────────────────────────────────────────

/** Numeric APS clash status → human-readable label */
export const CLASH_STATUS_LABELS: Record<number, string> = {
  1: "Active",
  2: "Reviewed",
  3: "Resolved",
  4: "Closed",
};

export function clashStatusLabel(status: string | number): string {
  const n = typeof status === "string" ? Number(status) : status;
  return CLASH_STATUS_LABELS[n] || `Unknown (${status})`;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip "b." prefix from project ID → MC API containerId (raw GUID) */
function toContainerId(projectId: string): string {
  return projectId.startsWith("b.") ? projectId.slice(2) : projectId;
}

// ── Fetch helpers ────────────────────────────────────────────────────

async function apsFetch(path: string, token: string): Promise<unknown> {
  const res = await fetch(`/api/aps${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`APS ${path}: ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function s3Fetch<T>(url: string): Promise<T> {
  // Proxy through Vite dev server to avoid CORS on S3 presigned URLs
  const res = await fetch("/api/s3-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`S3 proxy failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Modelsets ────────────────────────────────────────────────────────

export async function getModelSets(token: string, containerId: string): Promise<ModelSet[]> {
  const data = await apsFetch(
    `/bim360/modelset/v3/containers/${toContainerId(containerId)}/modelsets`,
    token
  ) as { modelSets: ModelSet[] };
  return data.modelSets || [];
}

export async function getModelSetLatest(
  token: string, containerId: string, modelSetId: string
): Promise<ModelSetLatest> {
  const data = await apsFetch(
    `/bim360/modelset/v3/containers/${toContainerId(containerId)}/modelsets/${modelSetId}/versions/latest`,
    token
  ) as ModelSetLatest;
  return data;
}

/**
 * Get clash views for a model set.
 * MC API returns { modelSetViews: ClashView[] } — flat wrapper.
 * APS returns `viewId` — normalized to `id` for convenience.
 */
export async function getClashViews(
  token: string, containerId: string, modelSetId: string
): Promise<ClashView[]> {
  const data = await apsFetch(
    `/bim360/modelset/v3/containers/${toContainerId(containerId)}/modelsets/${modelSetId}/views`,
    token
  ) as { modelSetViews: (ClashView & { viewId: string })[] };
  return (data.modelSetViews || []).map(v => ({
    ...v,
    id: v.viewId || v.id, // normalize
  }));
}

// ── Clash Tests ──────────────────────────────────────────────────────

export async function getClashTests(
  token: string, containerId: string, modelSetId: string, version: number
): Promise<ClashTest[]> {
  const data = await apsFetch(
    `/bim360/clash/v3/containers/${toContainerId(containerId)}/modelsets/${modelSetId}/versions/${version}/tests`,
    token
  ) as { tests: ClashTest[] };
  return data.tests || [];
}

/**
 * Get S3 resource URLs for a clash test.
 * Uses the SIMPLE path from the reference repo:
 *   /containers/{containerId}/tests/{testId}/resources
 * (no modelsets/versions segments — those are only for the tests list endpoint)
 */
export async function getClashResources(
  token: string, containerId: string, testId: string
): Promise<ClashResource[]> {
  const data = await apsFetch(
    `/bim360/clash/v3/containers/${toContainerId(containerId)}/tests/${testId}/resources`,
    token
  ) as { resources: ClashResource[] };
  return data.resources || [];
}

// ── Clash Resource Data (from S3, NO APS auth) ───────────────────────

export async function fetchClashData(s3Url: string): Promise<ClashDataRaw> {
  return s3Fetch<ClashDataRaw>(s3Url);
}

export async function fetchClashInstances(s3Url: string): Promise<ClashInstanceRaw> {
  return s3Fetch<ClashInstanceRaw>(s3Url);
}

export async function fetchClashDocuments(s3Url: string): Promise<ClashDocumentRaw> {
  return s3Fetch<ClashDocumentRaw>(s3Url);
}

// ── Clash Processing ─────────────────────────────────────────────────

/**
 * Full clash processing pipeline — ported from the reference repo's
 * processClash.js and clashAnalyticProcessing.js.
 *
 * Returns the processed clashes AND the list of model URNs to load in the
 * viewer. Both are filtered against the clash view's DEFINITIONS (3D
 * viewableNames + lineage URNs), NOT against the clash view's own name —
 * `doc.viewableName` in clash-resource data is the 3D model name (e.g.
 * "{3D}", "Navis"), distinct from the clash view name (e.g. "STR_MEP").
 *
 * @param clashViewName  Name of the clash view (e.g. "STR_MEP")
 * @param clashDocs      scope-version-document.2.0.0 data
 * @param clashInstances scope-version-clash-instance.2.0.0 data
 * @param clashDataRaw   scope-version-clash.2.0.0 data
 * @param clashViews     Model set views from getClashViews()
 * @param documentVersions From getModelSetLatest().documentVersions
 */
export interface ProcessClashesResult {
  processed: ProcessedClash[];
  /** Base URNs to load into the Forge Viewer (full versionUrn from docs) */
  modelUrns: string[];
}

export function processClashes(
  clashViewName: string,
  clashDocs: ClashDocumentRaw,
  clashInstances: ClashInstanceRaw,
  clashDataRaw: ClashDataRaw,
  clashViews: ClashView[],
  documentVersions: DocumentVersion[],
): ProcessClashesResult {
  // 1. Find the clash view by name
  const clashView = clashViews.find((v) => v.name === clashViewName);
  if (!clashView) {
    console.warn(`Clash view "${clashViewName}" not found in:`,
      clashViews.map(v => v.name));
    return { processed: [], modelUrns: [] };
  }

  // 2. Map view definitions to document versions from getModelSetLatest
  const viewDocVers = clashView.definition
    .map((d) =>
      documentVersions.find(
        (dv) =>
          dv.documentLineage.lineageUrn === d.lineageUrn &&
          dv.viewableName === d.viewableName
      )
    )
    .filter((d): d is DocumentVersion => !!d);

  // Sets derived from the clash view's definitions (these drive ALL filtering):
  //  - viewDocUrnSet: base URNs the view references
  //  - viewableNameSet: the 3D viewableNames like "{3D}", "Navis"
  const viewDocUrnSet = new Set(
    viewDocVers.map((d) => d.versionUrn.split("?")[0])
  );
  const viewableNameSet = new Set(
    clashView.definition.map((d) => d.viewableName)
  );

  // 3. Filter clash documents that match this view's URNs AND 3D viewableNames
  const projectDocs = clashDocs.documents.filter((doc) => {
    const [baseUrn] = doc.urn.split("?");
    return viewDocUrnSet.has(baseUrn) && viewableNameSet.has(doc.viewableName);
  });

  // 4. Model URNs to load: every clash doc whose URN is in the view (all 3D viewables)
  const modelUrns = clashDocs.documents
    .filter((d) => viewDocUrnSet.has(d.urn.split("?")[0]))
    .map((d) => d.urn);

  if (projectDocs.length === 0) {
    console.warn("No matching project documents for clash view", clashViewName);
    return { processed: [], modelUrns };
  }

  // 5. Filter clash instances for the first project document (left side)
  const targetDocId = projectDocs[0].id;
  const filteredInstances = clashInstances.instances.filter(
    (inst) => inst.ldid === targetDocId
  );

  // 6. Combine clash data with instance details
  const instanceMap = new Map<number, ClashInstanceRaw["instances"][0]>();
  for (const inst of filteredInstances) {
    instanceMap.set(inst.cid, inst);
  }

  const processed = clashDataRaw.clashes
    .filter((c) => instanceMap.has(c.id))
    .map((c) => {
      const inst = instanceMap.get(c.id)!;
      // dist is in METERS, negative = penetration.
      // Convert to mm for display.
      const distMm = (c.dist ?? 0) * 1000;
      return {
        id: String(c.id),
        status: clashStatusLabel(c.status),
        distance: distMm > 0 ? distMm : 0,
        penetration: distMm < 0 ? Math.abs(distMm) : 0,
        entity1: `dbId:${inst.loid}`,
        entity2: `dbId:${inst.roid}`,
        leftDbId: inst.loid,
        rightDbId: inst.roid,
        documentId: String(targetDocId),
      };
    });

  return { processed, modelUrns };
}

// ── Clash Operations ─────────────────────────────────────────────────

export async function closeClashes(
  token: string, containerId: string, modelSetId: string,
  testId: string
): Promise<void> {
  await apsFetch(
    `/bim360/clash/v3/containers/${toContainerId(containerId)}/modelsets/${modelSetId}/tests/${testId}/clashes:close`,
    token
  );
}

export async function assignClashes(
  token: string, containerId: string, modelSetId: string,
  testId: string
): Promise<void> {
  await apsFetch(
    `/bim360/clash/v3/containers/${toContainerId(containerId)}/modelsets/${modelSetId}/tests/${testId}/clashes:assign`,
    token
  );
}
