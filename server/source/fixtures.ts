/**
 * Offline fixture mode (`COORD_DATA_SOURCE=fixtures`): serves tests/fixtures as
 * if it were ACC, so the whole system (MCP, HTTP, CLI, evals, CI) runs without
 * APS credentials.
 *
 * Project `b.demo-proyecto`, one model set, clash tests for versions 41 and 42.
 * Writes are FAKE: they still require a valid ApprovedWriteToken (consumed
 * here, exactly like the live clients) and are recorded under
 * `.coordinator/fixture-acc/`, but nothing is ever sent over the network.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachPairKeys, elementLookupFromTables, normalizeClashTest } from "../../core/ingest";
import type { RawClashDocumentFile, RawClashFile, RawClashInstanceFile, RawModelSetVersion } from "../../core/ingest/raw";
import type { ElementProps } from "../../core/types";
import type { AccSnapshot } from "../../core/ingest/ledger";
import { parseNdjson } from "../aps/download";
import { parsePropertyAliases } from "../aps/index-properties";
import { compileMapper, FieldDictionary } from "../aps/property-mapping";
import type { AssignedGroupCreate, ClashGroupJob, ClosedGroupCreate, IndexField, IndexRow } from "../aps/types";
import { consumeApprovedWriteToken, type ApprovedWriteToken } from "../aps/write-guard";
import { appendJsonl, readJsonl } from "../store/fs";
import { sha256, uuidFromHash } from "../util";
import { linkedElementUid, normalizeLinkedExternalIds } from "../group-titles";
import type { ClashWriter, DataSource, SourceClashData, SourceClashTest, SourceModelSet, SourceProject, SourceProperties, SourceTestData } from "./types";

export const FIXTURE_PROJECT_ID = "b.demo-proyecto";
export const FIXTURE_HUB = { id: "b.hub-demo", name: "SalfaCorp (demo)" };

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface Truth {
  containerId: string;
  modelSetId: string;
  tests: Record<string, string>;
  index: Record<string, { indexId: string; seed: string; file: string; rows: number }>;
}

interface FixtureWrite {
  at: string;
  jobId: string;
  operation: "clash.assign" | "clash.close";
  projectId: string;
  testId: string;
  groups: Array<{ id: string; clashes: number[]; title: string }>;
  createdIssueIds: string[];
  approvedBy: string;
  proposalIds: readonly string[];
}

export class FixtureSource implements DataSource {
  readonly kind = "fixtures" as const;
  readonly dir: string;
  readonly writer: ClashWriter;
  private readonly truth: Truth;
  private readonly writesFile: string;
  private readonly project: SourceProject = {
    id: FIXTURE_PROJECT_ID,
    name: "Edificio Demo Las Condes",
    hubId: FIXTURE_HUB.id,
    hubName: FIXTURE_HUB.name,
  };

  constructor(opts: { dir?: string; home: string }) {
    this.dir = resolve(opts.dir ?? process.env.COORD_FIXTURE_DIR ?? join(REPO_ROOT, "tests", "fixtures"));
    this.truth = this.json<Truth>("fixture-truth.json");
    this.writesFile = join(opts.home, "fixture-acc", "writes.jsonl");
    this.writer = this.makeWriter();
  }

  private json<T>(rel: string): T {
    return JSON.parse(readFileSync(join(this.dir, rel), "utf8")) as T;
  }

  private text(rel: string): string {
    return readFileSync(join(this.dir, rel), "utf8");
  }

  private get versions(): number[] {
    return Object.keys(this.truth.tests)
      .map(Number)
      .sort((a, b) => a - b);
  }

  private modelSet(): SourceModelSet {
    const latest = Math.max(...this.versions);
    const msv = this.json<RawModelSetVersion>(`mc/v${latest}/modelset-version.json`);
    return {
      id: this.truth.modelSetId,
      name: "Coordinación general",
      latestVersion: latest,
      latestVersionAt: msv.createTime,
      documentCount: msv.documentVersions.length,
    };
  }

  private ensureProject(projectId: string): void {
    if (projectId.replace(/^b\./, "") !== FIXTURE_PROJECT_ID.slice(2)) throw new Error(`Proyecto ${projectId} no existe en modo fixtures`);
  }

  async authStatus() {
    return { loggedIn: true, scopes: ["data:read", "data:write", "data:create"] };
  }

  async currentUser() {
    return { id: "fixture-user", name: "Coordinadora Demo", email: "demo@salfacorp.example" };
  }

  async listHubs() {
    return [FIXTURE_HUB];
  }

  async listProjects(opts: { hubId?: string; nameContains?: string } = {}) {
    if (opts.hubId && opts.hubId !== FIXTURE_HUB.id) return [];
    if (opts.nameContains && !this.project.name.toLowerCase().includes(opts.nameContains.toLowerCase())) return [];
    return [this.project];
  }

  async getProject(projectId: string) {
    return projectId.replace(/^b\./, "") === "demo-proyecto" ? this.project : undefined;
  }

  async listModelSets(projectId: string) {
    this.ensureProject(projectId);
    return [this.modelSet()];
  }

  async listModelSetVersions(projectId: string, modelSetId: string) {
    this.ensureProject(projectId);
    if (modelSetId !== this.truth.modelSetId) return [];
    return this.versions
      .slice()
      .reverse()
      .map((v) => {
        const msv = this.json<RawModelSetVersion>(`mc/v${v}/modelset-version.json`);
        return { version: v, createdAt: msv.createTime, status: "Successful", documentCount: msv.documentVersions.length };
      });
  }

  async listClashTests(projectId: string, modelSetId: string, version?: number): Promise<SourceClashTest[]> {
    this.ensureProject(projectId);
    if (modelSetId !== this.truth.modelSetId) return [];
    const tests = this.json<{ tests: Array<{ id: string; modelSetId: string; modelSetVersion: number; status: string; completedOn?: string }> }>("mc/clash-tests.json").tests;
    return tests
      .filter((t) => version === undefined || t.modelSetVersion === version)
      .map((t) => ({ ...t, viewName: "Coordinación general" }))
      .sort((a, b) => b.modelSetVersion - a.modelSetVersion);
  }

  async latestVersion(projectId: string, modelSetId: string) {
    this.ensureProject(projectId);
    if (modelSetId !== this.truth.modelSetId) throw new Error(`Model set ${modelSetId} no existe`);
    return Math.max(...this.versions);
  }

  async fetchClashes(projectId: string, modelSetId: string, testId: string): Promise<SourceClashData> {
    const test = (await this.listClashTests(projectId, modelSetId)).find((t) => t.id === testId);
    if (!test) throw new Error(`Clash test ${testId} no existe`);
    const v = test.modelSetVersion;
    const raw = {
      clashes: this.json<RawClashFile>(`mc/v${v}/scope-version-clash.json`),
      instances: this.json<RawClashInstanceFile>(`mc/v${v}/scope-version-clash-instance.json`),
      documents: this.json<RawClashDocumentFile>(`mc/v${v}/scope-version-document.json`),
    };
    const msv = this.json<RawModelSetVersion>(`mc/v${v}/modelset-version.json`);
    const result = normalizeClashTest(raw, { documentVersions: msv.documentVersions });
    return { test, modelSet: this.modelSet(), project: this.project, clashes: result.clashes, documents: result.documents, warnings: result.warnings.map((w) => `${w.code}:${w.count}`) };
  }

  async fetchProperties(_projectId: string, data: SourceClashData): Promise<SourceProperties> {
    const msv = this.json<RawModelSetVersion>(`mc/v${data.test.modelSetVersion}/modelset-version.json`);
    const dict = new FieldDictionary(parseNdjson<IndexField>(this.text("index/fields.ndjson")));
    const config = parsePropertyAliases(readFileSync(join(REPO_ROOT, "rules", "property-aliases.yaml"), "utf8"));
    const wanted = new Map<number, Set<number>>();
    for (const c of data.clashes) {
      for (const s of [c.left, c.right]) {
        const set = wanted.get(s.documentId) ?? new Set<number>();
        set.add(s.viewerDbId);
        wanted.set(s.documentId, set);
      }
    }
    const elements: ElementProps[] = [];
    const allKeys = new Set<string>();
    const tables = new Map<number, Map<number, ElementProps>>();
    for (const d of data.documents) {
      const dv = msv.documentVersions.find((x) => x.versionUrn === d.urn && x.viewableName === d.viewableName);
      const entry = dv?.originalSeedFileVersionUrn ? this.truth.index[dv.originalSeedFileVersionUrn] : undefined;
      if (!dv || !entry) continue;
      const rows = parseNdjson<IndexRow>(this.text(entry.file));
      const map = compileMapper(dict, config, { documentId: d.id, modelFile: dv.documentLineage?.lineageUrn, documentName: dv.originalSeedFileVersionName });
      const table = new Map<number, ElementProps>();
      const ids = wanted.get(d.id) ?? new Set<number>();
      for (const r of rows) {
        if (r.externalId) allKeys.add(r.externalId);
        if (!ids.has(r.lmvId)) continue;
        const el = map(r);
        table.set(r.lmvId, el);
        elements.push(el);
      }
      tables.set(d.id, table);
    }
    const normalized = normalizeLinkedExternalIds(elements);
    const normTables = new Map<number, Map<number, ElementProps>>();
    for (const e of normalized) if (e.documentId !== undefined) (normTables.get(e.documentId) ?? normTables.set(e.documentId, new Map()).get(e.documentId)!).set(e.lmvId, e);
    void tables;
    return {
      clashes: attachPairKeys(data.clashes, data.documents, elementLookupFromTables(normTables)),
      elements: normalized,
      propertiesStatus: "ready",
      allElementKeys: [...allKeys].map((k) => linkedElementUid(k) ?? k),
      warnings: [],
    };
  }

  async fetchTest(projectId: string, modelSetId: string, testId: string, opts: { fetchProperties: boolean }): Promise<SourceTestData> {
    const data = await this.fetchClashes(projectId, modelSetId, testId);
    if (!opts.fetchProperties) return { ...data, elements: [], propertiesStatus: "skipped" };
    const p = await this.fetchProperties(projectId, data);
    return { ...data, clashes: p.clashes, elements: p.elements, propertiesStatus: p.propertiesStatus, ...(p.allElementKeys ? { allElementKeys: p.allElementKeys } : {}) };
  }

  async listModelSetViews(projectId: string, modelSetId: string) {
    this.ensureProject(projectId);
    if (modelSetId !== this.truth.modelSetId) return [];
    const f = this.json<{ modelSetViews: Array<{ name: string; definition: Array<{ lineageUrn: string; viewableName?: string }> }> }>("mc/modelset-views.json");
    return f.modelSetViews.map((v) => ({ name: v.name, definition: v.definition }));
  }

  /** Recorded fake writes, for preflight and tests. */
  async writes(): Promise<FixtureWrite[]> {
    return readJsonl<FixtureWrite>(this.writesFile);
  }

  /** X1 fixtures: `mc/v{N}/acc-groups.json` (groups made in ACC) + the recorded fake writes of this test. */
  async accState(_projectId: string, _modelSetId: string, testId: string, version: number): Promise<AccSnapshot> {
    type F = { assigned?: Array<{ id: string; issueId?: string; existing: string[]; resolved?: string[] }>; closed?: Array<{ id: string; reason?: string; existing: string[]; resolved?: string[] }> };
    let f: F = {};
    try {
      f = this.json<F>(`mc/v${version}/acc-groups.json`);
    } catch {
      // no ACC groups for this version
    }
    const groups: AccSnapshot["groups"] = [
      ...(f.assigned ?? []).map((g) => ({ groupId: g.id, kind: "assigned" as const, ...(g.issueId ? { issueId: g.issueId } : {}), existing: g.existing.map(String), resolved: (g.resolved ?? []).map(String) })),
      ...(f.closed ?? []).map((g) => ({ groupId: g.id, kind: "closed" as const, ...(g.reason ? { reason: g.reason } : {}), existing: g.existing.map(String), resolved: (g.resolved ?? []).map(String) })),
    ];
    for (const w of await this.writes()) {
      if (w.testId !== testId) continue;
      w.groups.forEach((g, i) =>
        groups.push({
          groupId: g.id,
          kind: w.operation === "clash.assign" ? "assigned" : "closed",
          ...(w.operation === "clash.assign" && w.createdIssueIds[i] ? { issueId: w.createdIssueIds[i] } : {}),
          existing: g.clashes.map(String),
          resolved: [],
        }),
      );
    }
    return { version, at: new Date().toISOString(), groups };
  }

  async triageState(_projectId: string, testId: string) {
    const assigned = new Set<string>();
    const closed = new Set<string>();
    for (const w of await this.writes()) {
      if (w.testId !== testId) continue;
      for (const g of w.groups) for (const c of g.clashes) (w.operation === "clash.assign" ? assigned : closed).add(String(c));
    }
    return { assigned, closed };
  }

  async listAssignees() {
    return [
      { id: "role-cli", name: "Especialista Clima", kind: "role" as const },
      { id: "role-san", name: "Especialista Sanitario", kind: "role" as const },
      { id: "role-ele", name: "Especialista Eléctrico", kind: "role" as const },
      { id: "role-est", name: "Ingeniería Estructural", kind: "role" as const },
      { id: "co-demo-mep", name: "Instalaciones Demo Ltda.", kind: "company" as const },
    ];
  }

  private makeWriter(): ClashWriter {
    const record = async (
      operation: "clash.assign" | "clash.close",
      token: ApprovedWriteToken,
      projectId: string,
      testId: string,
      groups: Array<AssignedGroupCreate | ClosedGroupCreate>,
    ): Promise<ClashGroupJob> => {
      const jobId = uuidFromHash(sha256(`${operation}|${testId}|${JSON.stringify(groups)}|${Date.now()}|${Math.random()}`));
      const ids = groups.map((g, i) => g.id ?? uuidFromHash(sha256(`${jobId}|${i}`)));
      const createdIssueIds = operation === "clash.assign" ? ids.map((id) => `ISS-${id.slice(0, 8)}`) : [];
      const w: FixtureWrite = {
        at: new Date().toISOString(),
        jobId,
        operation,
        projectId,
        testId,
        groups: groups.map((g, i) => ({ id: ids[i], clashes: g.clashes, title: g.title })),
        createdIssueIds,
        approvedBy: token.approvedBy,
        proposalIds: token.proposalIds,
      };
      await appendJsonl(this.writesFile, w);
      return { jobId, groups: ids, status: "Running" };
    };
    return {
      assign: async (token, projectId, testId, groups) => {
        consumeApprovedWriteToken(token, "clash.assign", groups);
        return record("clash.assign", token, projectId, testId, groups);
      },
      close: async (token, projectId, testId, groups) => {
        consumeApprovedWriteToken(token, "clash.close", groups);
        return record("clash.close", token, projectId, testId, groups);
      },
      waitJob: async (_projectId, jobId) => {
        const w = (await this.writes()).find((x) => x.jobId === jobId);
        if (!w) return { jobId, groups: [], status: "Failed" };
        return { jobId, groups: w.groups.map((g) => g.id), createdIssueIds: w.createdIssueIds, status: "Succeeded" };
      },
    };
  }
}
