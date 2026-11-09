/**
 * Live DataSource over the APS clients in server/aps. Read paths only, except
 * {@link ClashWriter}, whose functions require an ApprovedWriteToken that only
 * server/approval can mint.
 */
import { attachPairKeys, elementLookupFromTables, normalizeClashTest } from "../../core/ingest";
import type { ElementProps } from "../../core/types";
import { ApsAuth } from "../aps/auth";
import { ApsError } from "../aps/errors";
import { fetchClashResults, intersectAssignedGroups, intersectClosedGroups, listAssignedGroups, listClashTests, listClosedGroups } from "../aps/clash";
import type { AccSnapshot } from "../../core/ingest/ledger";
import { listIssues } from "../aps/issues";
import { assignClashes, closeClashes, waitClashJob } from "../aps/clash-writes";
import { apsRequest, type ApsCtx } from "../aps/http";
import {
  ensureIndexes,
  getIndexFields,
  getIndexManifest,
  indexForVersion,
  lmvIdQuery,
  loadPropertyAliases,
  queryIndex,
  resolveManifestViewId,
} from "../aps/index-properties";
import { compileMapper, FieldDictionary } from "../aps/property-mapping";
import type { IndexRow } from "../aps/types";
import { mapLimit, PropertyRowCache } from "../cache/property-cache";
import { normalizeLinkedExternalIds } from "../group-titles";
import { join } from "node:path";
import { getModelSetVersion, listModelSets, listModelSetVersions, getModelSet, listModelSetViews } from "../aps/modelset";
import { log } from "../util";

/** APS OIDC userinfo host (https://aps.autodesk.com/en/docs/profile/v1/reference/profile/oidcuserinfo/). */
const USERINFO_BASE_URL = "https://api.userprofile.autodesk.com";
import type { SourceIssue } from "./types";
import type { ClashWriter, DataSource, SourceClashData, SourceClashTest, SourceModelSet, SourceProject, SourceProperties, SourceTestData } from "./types";

/**
 * Hosts allowed for presigned clash resource downloads: Amazon S3 endpoints
 * only (virtual-hosted and regional styles). Narrower than the generic
 * server/aps/download.ts default (any amazonaws / autodesk host).
 * UNVERIFIED on a real tenant which S3 region APS uses; extend here if needed.
 */
export const CLASH_RESOURCE_HOSTS: readonly string[] = [
  ".s3.amazonaws.com",
  ".s3-accelerate.amazonaws.com",
  ...["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-west-2", "eu-central-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ca-central-1"].flatMap((r) => [`.s3.${r}.amazonaws.com`, `.s3.dualstack.${r}.amazonaws.com`]),
];

interface DmHub {
  id: string;
  attributes?: { name?: string };
}
interface DmProject {
  id: string;
  attributes?: { name?: string };
  relationships?: { hub?: { data?: { id?: string } } };
}

export class LiveSource implements DataSource {
  readonly kind = "live" as const;
  readonly ctx: ApsCtx;
  readonly writer: ClashWriter;
  private hubsCache?: Array<{ id: string; name: string }>;

  /** undefined when the APS client id is not configured: every APS call then fails with auth_required. */
  readonly auth: ApsAuth | undefined;

  /** Root of the property row cache (default <root>/.coordinator/cache). */
  private readonly cacheRoot: string;

  constructor(auth: ApsAuth | (() => ApsAuth), opts: { region?: "US" | "EMEA"; root?: string; cacheRoot?: string } = {}) {
    let a: ApsAuth | undefined;
    try {
      a = typeof auth === "function" ? auth() : auth;
    } catch (err) {
      log.warn("aps.auth.unconfigured", { message: (err as Error).message });
    }
    this.auth = a;
    this.ctx = {
      token: a ?? {
        getAccessToken: async () => {
          throw new ApsError({ code: "auth_required", detail: "APS no configurado (falta el client id)" });
        },
      },
      region: opts.region,
      log: { debug() {}, info: (m, meta) => log.info(m, meta), warn: (m, meta) => log.warn(m, meta) },
    };
    this.writer = {
      assign: async (token, projectId, testId, groups) => assignClashes(this.ctx, token, projectId, testId, groups),
      close: async (token, projectId, testId, groups) => closeClashes(this.ctx, token, projectId, testId, groups),
      waitJob: async (projectId, jobId, timeoutMs) => waitClashJob(this.ctx, projectId, jobId, { timeoutMs }),
    };
    this.root = opts.root ?? process.cwd();
    this.cacheRoot = opts.cacheRoot ?? join(this.root, ".coordinator", "cache");
  }

  private readonly root: string;

  async authStatus() {
    if (!this.auth) return { loggedIn: false };
    const s = await this.auth.status();
    return { loggedIn: s.loggedIn, expiresAt: s.expiresAt, scopes: s.scopes, ...(s.needsReauth ? { needsReauth: true } : {}) };
  }

  async currentUser() {
    try {
      // OIDC userinfo (scope user-profile:read). The old /userprofile/v1/users/@me returns 410 Gone.
      const me = await apsRequest<{ sub?: string; name?: string; given_name?: string; family_name?: string; preferred_username?: string; email?: string }>(
        { ...this.ctx, baseUrl: USERINFO_BASE_URL },
        "GET",
        "/userinfo",
      );
      const name = me.name || [me.given_name, me.family_name].filter(Boolean).join(" ") || me.preferred_username || "Usuario APS";
      return { id: me.sub ?? "unknown", name, email: me.email };
    } catch (e) {
      // Never swallow silently: a missing scope here looks like "not logged in" to the UI.
      const err = e as { status?: number; code?: string; message?: string };
      log.warn("aps.user_profile_failed", { status: err.status, code: err.code, message: String(err.message ?? e).slice(0, 300) });
      return undefined;
    }
  }

  async listHubs() {
    if (this.hubsCache) return this.hubsCache;
    const data = await apsRequest<{ data?: DmHub[] }>(this.ctx, "GET", "/project/v1/hubs");
    this.hubsCache = (data?.data ?? []).map((h) => ({ id: h.id, name: h.attributes?.name ?? h.id }));
    return this.hubsCache;
  }

  async listProjects(opts: { hubId?: string; nameContains?: string } = {}): Promise<SourceProject[]> {
    const hubs = (await this.listHubs()).filter((h) => !opts.hubId || h.id === opts.hubId);
    const out: SourceProject[] = [];
    for (const hub of hubs) {
      const rows: DmProject[] = [];
      for (let page = 0; page < 50; page++) {
        const data = await apsRequest<{ data?: DmProject[]; links?: { next?: unknown } }>(
          this.ctx,
          "GET",
          `/project/v1/hubs/${encodeURIComponent(hub.id)}/projects`,
          { query: { "page[number]": page, "page[limit]": 100 } },
        );
        rows.push(...(data?.data ?? []));
        if (!data?.links?.next || (data.data ?? []).length === 0) break;
      }
      for (const p of rows) {
        const name = p.attributes?.name ?? p.id;
        if (opts.nameContains && !name.toLowerCase().includes(opts.nameContains.toLowerCase())) continue;
        out.push({ id: p.id, name, hubId: hub.id, hubName: hub.name });
      }
    }
    return out;
  }

  async getProject(projectId: string) {
    const id = projectId.startsWith("b.") ? projectId : `b.${projectId}`;
    return (await this.listProjects()).find((p) => p.id === id);
  }

  private readonly folderCache = new Map<string, string | undefined>();

  /** Parent folder name of a document's lineage item (Data Management); cached; never throws. */
  async folderOf(projectId: string, lineageUrn: string): Promise<string | undefined> {
    if (!lineageUrn) return undefined;
    if (this.folderCache.has(lineageUrn)) return this.folderCache.get(lineageUrn);
    const dmProject = projectId.startsWith("b.") ? projectId : `b.${projectId}`;
    try {
      const r = await apsRequest<{ data?: { attributes?: { displayName?: string; name?: string } } }>(
        this.ctx,
        "GET",
        `/data/v1/projects/${encodeURIComponent(dmProject)}/items/${encodeURIComponent(lineageUrn)}/parent`,
      );
      const name = r?.data?.attributes?.displayName ?? r?.data?.attributes?.name;
      this.folderCache.set(lineageUrn, name);
      return name;
    } catch (e) {
      log.warn("aps.folder_lookup_failed", { message: String((e as Error).message ?? e).slice(0, 200) });
      this.folderCache.set(lineageUrn, undefined);
      return undefined;
    }
  }

  async listModelSets(projectId: string): Promise<SourceModelSet[]> {
    const sets = await listModelSets(this.ctx, projectId);
    const out: SourceModelSet[] = [];
    for (const s of sets) {
      const versions = await listModelSetVersions(this.ctx, projectId, s.modelSetId).catch(() => []);
      const latest = versions.reduce((m, v) => (v.version > m.version ? v : m), { version: 0, createTime: undefined as string | undefined, status: "" });
      out.push({ id: s.modelSetId, name: s.name, latestVersion: latest.version, latestVersionAt: latest.createTime, documentCount: 0 });
    }
    return out;
  }

  async listModelSetVersions(projectId: string, modelSetId: string) {
    const versions = await listModelSetVersions(this.ctx, projectId, modelSetId);
    return versions
      .sort((a, b) => b.version - a.version)
      .map((v) => ({ version: v.version, createdAt: v.createTime, status: v.status, documentCount: 0 }));
  }

  async listClashTests(projectId: string, modelSetId: string, version?: number): Promise<SourceClashTest[]> {
    const tests = await listClashTests(this.ctx, projectId, modelSetId, version);
    const ms = await getModelSet(this.ctx, projectId, modelSetId).catch(() => undefined);
    return tests
      .map((t) => ({ id: t.id, modelSetId: t.modelSetId, modelSetVersion: t.modelSetVersion, status: t.status, completedOn: t.completedOn, viewName: ms?.name ?? "Clash test" }))
      .sort((a, b) => b.modelSetVersion - a.modelSetVersion);
  }

  async latestVersion(projectId: string, modelSetId: string) {
    const versions = await listModelSetVersions(this.ctx, projectId, modelSetId);
    return versions.reduce((m, v) => Math.max(m, v.version), 0);
  }

  /** Phase 1: clash resources only (seconds). */
  async fetchClashes(projectId: string, modelSetId: string, testId: string): Promise<SourceClashData> {
    const [project, tests, ms] = await Promise.all([
      this.getProject(projectId).catch(() => undefined),
      listClashTests(this.ctx, projectId, modelSetId),
      getModelSet(this.ctx, projectId, modelSetId),
    ]);
    const t = tests.find((x) => x.id === testId);
    if (!t) throw new Error(`Clash test ${testId} no existe en el model set`);
    const test: SourceClashTest = { id: t.id, modelSetId: t.modelSetId, modelSetVersion: t.modelSetVersion, status: t.status, completedOn: t.completedOn, viewName: ms.name };
    const [msv, raw] = await Promise.all([
      getModelSetVersion(this.ctx, projectId, modelSetId, test.modelSetVersion),
      fetchClashResults(this.ctx, projectId, testId, { allowedHostSuffixes: CLASH_RESOURCE_HOSTS, maxBytes: 256 * 1024 * 1024 }),
    ]);
    const result = normalizeClashTest(raw, { documentVersions: msv.documentVersions });
    return {
      test,
      project: project ?? { id: projectId, name: projectId, hubId: "", hubName: "" },
      modelSet: { id: ms.modelSetId, name: ms.name, latestVersion: test.modelSetVersion, documentCount: msv.documentVersions.length },
      clashes: result.clashes,
      documents: result.documents,
      warnings: result.warnings.map((w) => `${w.code}:${w.count}`),
    };
  }

  /**
   * Phase 2: element properties via Model Properties (Index v2).
   * - one batch-status for all seeds, then documents in PARALLEL (4 at a time);
   * - query polling capped at 1 s (the API's retryAt asked for ~30 s waits;
   *   results are ready in ~2 s) — this was ~150 s of a 171 s ingest;
   * - rows cached per seed file version: unchanged documents of another model
   *   set version are served from disk and only new lmvIds are queried.
   */
  async fetchProperties(projectId: string, data: SourceClashData, progress?: (s: string, d: number, t: number) => void): Promise<SourceProperties> {
    const config = await loadPropertyAliases(undefined, this.root);
    const cache = new PropertyRowCache(this.cacheRoot);
    const docs = data.documents.filter((d) => d.seedVersionUrn);
    const seeds = [...new Set(docs.map((d) => d.seedVersionUrn!))];
    const wanted = new Map<number, Set<number>>();
    for (const c of data.clashes) for (const s of [c.left, c.right]) (wanted.get(s.documentId) ?? wanted.set(s.documentId, new Set()).get(s.documentId)!).add(s.viewerDbId);
    const cachedBySeed = new Map(await Promise.all(seeds.map(async (s) => [s, await cache.get(s)] as const)));
    const needIndex = seeds.filter((s) => {
      const c = cachedBySeed.get(s)!;
      return docs.filter((d) => d.seedVersionUrn === s).some((d) => !c.fields || [...(wanted.get(d.id) ?? [])].some((id) => !c.rows.has(id) && !c.absent.has(id)));
    });
    const indexes = needIndex.length ? await ensureIndexes(this.ctx, projectId, needIndex, undefined, { maxIntervalMs: 2000, defaultIntervalMs: 1000 }) : [];
    const warnings: string[] = [];
    let done = 0;
    let fromCache = 0;
    const tables = new Map<number, Map<number, ElementProps>>();
    const elements: ElementProps[] = [];
    progress?.("properties", 0, docs.length);
    await mapLimit(docs, 4, async (doc) => {
      const seed = doc.seedVersionUrn!;
      const ids = [...(wanted.get(doc.id) ?? [])];
      try {
        const cached = cachedBySeed.get(seed)!;
        const missing = ids.filter((id) => !cached.rows.has(id) && !cached.absent.has(id));
        let fields = cached.fields;
        let views = cached.views ?? {};
        const idx = indexForVersion(indexes, seed);
        if ((missing.length || !fields) && !idx) throw new Error("sin índice de propiedades");
        if (!fields || (doc.viewableGuid && views[doc.viewableGuid] === undefined)) {
          const [f, manifest] = await Promise.all([fields ? Promise.resolve(fields) : getIndexFields(this.ctx, projectId, idx!.indexId), getIndexManifest(this.ctx, projectId, idx!.indexId)]);
          fields = f;
          if (doc.viewableGuid) views = { ...views, [doc.viewableGuid]: resolveManifestViewId(manifest, seed, doc.viewableGuid) ?? "" };
          await cache.putMeta(seed, { fields, views });
        }
        if (missing.length) {
          const chunks: number[][] = [];
          for (let i = 0; i < missing.length; i += 1000) chunks.push(missing.slice(i, i + 1000));
          const got: IndexRow[] = [];
          await mapLimit(chunks, 3, async (chunk) => {
            for await (const row of queryIndex(this.ctx, projectId, idx!.indexId, { query: lmvIdQuery(chunk) }, { maxIntervalMs: 1000, defaultIntervalMs: 500 })) got.push(row);
          });
          for (const r of got) cached.rows.set(r.lmvId, r);
          const absent = missing.filter((id) => !cached.rows.has(id));
          await cache.addRows(seed, got, absent, cached.absent);
          for (const a of absent) cached.absent.add(a);
        } else fromCache++;
        const viewId = doc.viewableGuid ? views[doc.viewableGuid] || undefined : undefined;
        const map = compileMapper(new FieldDictionary(fields), config, { documentId: doc.id, modelFile: doc.lineageUrn, documentName: doc.displayName });
        const table = new Map<number, ElementProps>();
        for (const id of ids) {
          const row = cached.rows.get(id);
          if (!row || (viewId && !(row.views ?? []).includes(viewId))) continue;
          table.set(id, map(row));
        }
        tables.set(doc.id, table);
      } catch (err) {
        warnings.push(`properties:${doc.displayName}:${(err as Error).message.slice(0, 120)}`);
      } finally {
        progress?.("properties", ++done, docs.length);
      }
    });
    for (const t of tables.values()) elements.push(...t.values());
    const normalized = normalizeLinkedExternalIds(elements);
    const normTables = new Map<number, Map<number, ElementProps>>();
    for (const e of normalized) if (e.documentId !== undefined) (normTables.get(e.documentId) ?? normTables.set(e.documentId, new Map()).get(e.documentId)!).set(e.lmvId, e);
    const failed = warnings.length;
    return {
      clashes: attachPairKeys(data.clashes, data.documents, elementLookupFromTables(normTables)),
      elements: normalized,
      propertiesStatus: failed === 0 ? "ready" : failed < docs.length ? "partial" : "pending",
      warnings,
      cachedDocuments: fromCache,
    };
  }

  async fetchTest(projectId: string, modelSetId: string, testId: string, opts: { fetchProperties: boolean; progress?: (s: string, d: number, t: number) => void }): Promise<SourceTestData> {
    const data = await this.fetchClashes(projectId, modelSetId, testId);
    if (!opts.fetchProperties) return { ...data, elements: [], propertiesStatus: "skipped" };
    const p = await this.fetchProperties(projectId, data, opts.progress);
    return { ...data, clashes: p.clashes, elements: p.elements, propertiesStatus: p.propertiesStatus, warnings: [...data.warnings, ...p.warnings] };
  }

  async listModelSetViews(projectId: string, modelSetId: string) {
    const views = await listModelSetViews(this.ctx, projectId, modelSetId);
    return views.map((v) => ({ name: v.name, definition: (v.definition ?? []).map((d) => ({ lineageUrn: d.lineageUrn, ...(d.viewableName ? { viewableName: d.viewableName } : {}) })) }));
  }

  async accState(projectId: string, modelSetId: string, testId: string, version: number): Promise<AccSnapshot> {
    const [ia, ic, la, lc] = await Promise.all([
      intersectAssignedGroups(this.ctx, projectId, testId),
      intersectClosedGroups(this.ctx, projectId, testId),
      listAssignedGroups(this.ctx, projectId, modelSetId),
      listClosedGroups(this.ctx, projectId, modelSetId),
    ]);
    const issueOf = new Map(la.map((g) => [g.id, g.issueId]));
    const reasonOf = new Map(lc.map((g) => [g.id, g.reason]));
    const ids = (xs: readonly number[] | undefined) => (xs ?? []).map(String);
    return {
      version,
      at: new Date().toISOString(),
      groups: [
        ...ia.map((g) => ({ groupId: g.id, kind: "assigned" as const, ...(issueOf.get(g.id) ? { issueId: issueOf.get(g.id)! } : {}), existing: ids(g.existing), resolved: ids(g.resolved) })),
        ...ic.map((g) => ({ groupId: g.id, kind: "closed" as const, ...(reasonOf.get(g.id) ? { reason: String(reasonOf.get(g.id)) } : {}), existing: ids(g.existing), resolved: ids(g.resolved) })),
      ],
    };
  }

  async getIssues(projectId: string, issueIds: readonly string[]): Promise<SourceIssue[]> {
    const out: SourceIssue[] = [];
    for (let i = 0; i < issueIds.length; i += 50) {
      const page = await listIssues(this.ctx, projectId, { id: issueIds.slice(i, i + 50) as string[] });
      for (const x of page) out.push({ id: x.id, ...(x.displayId !== undefined ? { displayId: x.displayId } : {}), title: x.title, status: x.status, ...(x.dueDate ? { dueDate: x.dueDate } : {}), ...(x.assignedToType ? { assignedToType: x.assignedToType } : {}), ...(x.createdAt ? { createdAt: x.createdAt } : {}) });
    }
    return out;
  }

  async triageState(projectId: string, testId: string) {
    const assigned = new Set<string>();
    const closed = new Set<string>();
    for (const g of await intersectAssignedGroups(this.ctx, projectId, testId)) for (const id of g.existing ?? []) assigned.add(String(id));
    for (const g of await intersectClosedGroups(this.ctx, projectId, testId)) for (const id of g.existing ?? []) closed.add(String(id));
    return { assigned, closed };
  }

  async listAssignees() {
    // Assignment to a person happens in ACC / the UI picker; v1 offers roles only.
    return [] as Array<{ id: string; name: string; kind: "user" | "role" | "company" }>;
  }
}
