/**
 * Live DataSource over the APS clients in server/aps. Read paths only, except
 * {@link ClashWriter}, whose functions require an ApprovedWriteToken that only
 * server/approval can mint.
 */
import { attachPairKeys, elementLookupFromTables, normalizeClashTest } from "../../core/ingest";
import type { ElementProps } from "../../core/types";
import { ApsAuth } from "../aps/auth";
import { ApsError } from "../aps/errors";
import { fetchClashResults, intersectAssignedGroups, intersectClosedGroups, listClashTests } from "../aps/clash";
import { assignClashes, closeClashes, waitClashJob } from "../aps/clash-writes";
import { apsRequest, type ApsCtx } from "../aps/http";
import {
  ensureIndexes,
  fetchElementProps,
  getIndexFields,
  getIndexManifest,
  indexForVersion,
  loadPropertyAliases,
  resolveManifestViewId,
} from "../aps/index-properties";
import { getModelSetVersion, listModelSets, listModelSetVersions, getModelSet } from "../aps/modelset";
import { log } from "../util";
import type { ClashWriter, DataSource, SourceClashTest, SourceModelSet, SourceProject, SourceTestData } from "./types";

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

  constructor(auth: ApsAuth | (() => ApsAuth), opts: { region?: "US" | "EMEA"; root?: string } = {}) {
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
  }

  private readonly root: string;

  async authStatus() {
    if (!this.auth) return { loggedIn: false };
    const s = await this.auth.status();
    return { loggedIn: s.loggedIn, expiresAt: s.expiresAt, scopes: s.scopes };
  }

  async currentUser() {
    try {
      const me = await apsRequest<{ userId?: string; userName?: string; firstName?: string; lastName?: string; emailId?: string }>(
        this.ctx,
        "GET",
        "/userprofile/v1/users/@me",
      );
      const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.userName || "Usuario APS";
      return { id: me.userId ?? "unknown", name, email: me.emailId };
    } catch {
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

  async fetchTest(projectId: string, modelSetId: string, testId: string, opts: { fetchProperties: boolean; progress?: (s: string, d: number, t: number) => void }): Promise<SourceTestData> {
    const project = (await this.getProject(projectId)) ?? { id: projectId, name: projectId, hubId: "", hubName: "" };
    const test = (await this.listClashTests(projectId, modelSetId)).find((t) => t.id === testId);
    if (!test) throw new Error(`Clash test ${testId} no existe en el model set`);
    const ms = await getModelSet(this.ctx, projectId, modelSetId);
    const msv = await getModelSetVersion(this.ctx, projectId, modelSetId, test.modelSetVersion);
    opts.progress?.("download", 0, 3);
    const raw = await fetchClashResults(this.ctx, projectId, testId);
    opts.progress?.("normalize", 1, 3);
    const result = normalizeClashTest(raw, { documentVersions: msv.documentVersions });
    let clashes = result.clashes;
    const elements: ElementProps[] = [];
    let propertiesStatus: SourceTestData["propertiesStatus"] = "skipped";
    if (opts.fetchProperties) {
      opts.progress?.("properties", 2, 3);
      try {
        const config = await loadPropertyAliases(undefined, this.root);
        const seeds = [...new Set(result.documents.map((d) => d.seedVersionUrn).filter((u): u is string => !!u))];
        const indexes = await ensureIndexes(this.ctx, projectId, seeds);
        const tables = new Map<number, Map<number, ElementProps>>();
        let missing = 0;
        for (const doc of result.documents) {
          const idx = doc.seedVersionUrn ? indexForVersion(indexes, doc.seedVersionUrn) : undefined;
          if (!idx) {
            missing++;
            continue;
          }
          const lmvIds = clashes.flatMap((c) => [c.left, c.right]).filter((s) => s.documentId === doc.id).map((s) => s.viewerDbId);
          const fields = await getIndexFields(this.ctx, projectId, idx.indexId);
          const manifest = await getIndexManifest(this.ctx, projectId, idx.indexId);
          const viewId = doc.viewableGuid && doc.seedVersionUrn ? resolveManifestViewId(manifest, doc.seedVersionUrn, doc.viewableGuid) : undefined;
          const map = await fetchElementProps(this.ctx, projectId, idx.indexId, lmvIds, fields, {
            config,
            viewId,
            documentId: doc.id,
            modelFile: doc.lineageUrn,
            documentName: doc.displayName,
          });
          tables.set(doc.id, map);
          elements.push(...map.values());
        }
        clashes = attachPairKeys(clashes, result.documents, elementLookupFromTables(tables));
        propertiesStatus = missing === 0 ? "ready" : "partial";
      } catch (err) {
        log.warn("ingest.properties_failed", { message: (err as Error).message });
        propertiesStatus = "pending";
      }
    }
    opts.progress?.("done", 3, 3);
    return {
      test,
      project,
      modelSet: { id: ms.modelSetId, name: ms.name, latestVersion: test.modelSetVersion, documentCount: msv.documentVersions.length },
      clashes,
      documents: result.documents,
      elements,
      propertiesStatus,
      warnings: result.warnings.map((w) => `${w.code}:${w.count}`),
    };
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
