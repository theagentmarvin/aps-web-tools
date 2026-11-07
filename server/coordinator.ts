/**
 * Coordinator service: the single business layer used by BOTH the MCP server
 * (server/mcp) and the HTTP API (server/api), and by the CLI. No logic is
 * duplicated in those adapters; they only validate input and format output.
 *
 * Every number shown to the agent or the UI is computed here.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { diffStateIndex, diffTestVersions } from "../core/ingest";
import type { ElementProps, NormalizedClash } from "../core/types";
import { ApsAuth, resolveAuthConfig } from "./aps/auth";
import { ClashCache, type CacheKey } from "./cache/clash-cache";
import { loadConfig, MAX_SUPPORTED_LEVEL, type AutonomyLevel, type CoordinatorConfig, type LoadedConfig } from "./config";
import { CLOSABLE, ENGINE_NAME, ENGINE_VERSION, runEngine } from "./engine";
import { checkAgentText, referencedIds, untrusted, type Untrusted } from "./sanitize";
import { FixtureSource } from "./source/fixtures";
import { LiveSource } from "./source/live";
import type { DataSource } from "./source/types";
import { readJsonFile } from "./store/fs";
import { Store } from "./store";
import type {
  AccStatus,
  Actor,
  ClashRecord,
  ClassificationRecord,
  ConfidenceBand,
  EvidenceItem,
  FeatureSnapshot,
  FeedbackRecord,
  GroupRecord,
  ProposalKind,
  ProposalPayload,
  ProposalRecord,
  ProposalState,
  Risk,
  Severity,
  TestRecord,
  Validity,
} from "./store/types";
import { bareProjectId, CoordError, nowIso, paginate, percentile, round, sha256, testKeyOf } from "./util";

export const SERVER_VERSION = "0.1.0";

export type DataSourceKind = "live" | "fixtures";

export interface CoordinatorOptions {
  /** Repository root (config, rules/). Default: cwd. */
  root?: string;
  /** `.coordinator` directory. Default: <root>/.coordinator or COORDINATOR_HOME. */
  home?: string;
  /** Default: COORD_DATA_SOURCE env, else "live". */
  dataSource?: DataSourceKind;
  source?: DataSource;
  config?: LoadedConfig;
  now?: () => number;
}

/** Which surface called (for audit and created-by). */
export interface CallerContext {
  actor: Actor;
}

export const AGENT_ACTOR: Actor = { type: "agent", id: "claude-code", name: "Agente (Claude Code)" };
export const ENGINE_ACTOR: Actor = { type: "engine", id: "engine", name: "Motor determinístico" };

export interface Table {
  columns: string[];
  rows: unknown[][];
  total: number;
  nextCursor?: string;
}

export interface GroupFilter {
  triageState?: Array<"open" | "assigned" | "closed">;
  band?: string[];
  suggestedAction?: string[];
  tag?: string[];
  /** HTTP/UI only: MC status. */
  status?: AccStatus[];
  validity?: Validity[];
  severity?: Severity[];
  disciplinePair?: string[];
  level?: string[];
  minPenetrationMm?: number;
  needsReview?: boolean;
  confidenceBelow?: number;
  confidenceAtLeast?: number;
  ruleId?: string[];
  diffState?: "new" | "persisting" | "reappeared" | "reopened";
}

export type ReviewState = "auto_ok" | "needs_review" | "proposed" | "decided";

/** Loaded test bundle. */
export interface TestBundle {
  test: TestRecord;
  cls?: ClassificationRecord;
}

const PENDING_STATES: readonly ProposalState[] = ["draft", "pending_review"];

function sortPair(a: string, b: string): string {
  return a <= b ? `${a}×${b}` : `${b}×${a}`;
}

function penBucket(mm: number): string {
  return mm <= 0 ? "0" : mm < 10 ? "<10" : mm < 50 ? "10-50" : mm < 150 ? "50-150" : ">150";
}

export class Coordinator {
  readonly root: string;
  readonly store: Store;
  readonly cache: ClashCache;
  readonly source: DataSource;
  readonly loaded: LoadedConfig;
  readonly now: () => number;
  private jsonCache = new Map<string, { mtime: number; value: unknown }>();

  constructor(opts: CoordinatorOptions = {}) {
    this.root = opts.root ?? process.cwd();
    this.now = opts.now ?? Date.now;
    this.store = new Store({ home: opts.home ?? process.env.COORDINATOR_HOME ?? join(this.root, ".coordinator"), now: this.now });
    this.cache = new ClashCache(this.store.cacheRoot);
    this.loaded = opts.config ?? loadConfig(this.root);
    const kind: DataSourceKind = opts.dataSource ?? (process.env.COORD_DATA_SOURCE === "fixtures" ? "fixtures" : "live");
    this.source = opts.source ?? (kind === "fixtures" ? new FixtureSource({ home: this.store.home }) : new LiveSource(() => new ApsAuth({ config: resolveAuthConfig(this.root) }), { root: this.root }));
  }

  get config(): CoordinatorConfig {
    return this.loaded.config;
  }

  get effectiveLevel(): AutonomyLevel {
    return this.loaded.effectiveLevel;
  }

  /** Throws `autonomy_level_forbids` below `min`. */
  requireLevel(min: number, what: string): void {
    if (this.effectiveLevel < min) {
      throw new CoordError("autonomy_level_forbids", `${what} requiere nivel de autonomía L${min}; el nivel efectivo es L${this.effectiveLevel}.`);
    }
  }

  reviewUrl(id: string): string {
    return `${this.config.ui.baseUrl.replace(/\/$/, "")}/aprobaciones?propuesta=${encodeURIComponent(id)}`;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async cachedJson<T>(path: string): Promise<T | undefined> {
    const s = await stat(path).catch(() => undefined);
    if (!s) return undefined;
    const hit = this.jsonCache.get(path);
    if (hit && hit.mtime === s.mtimeMs) return hit.value as T;
    const value = await readJsonFile<T>(path);
    this.jsonCache.set(path, { mtime: s.mtimeMs, value });
    return value;
  }

  async resolveTestKey(testKey?: string): Promise<string> {
    if (testKey) return testKey;
    const ctx = await this.store.getContext();
    if (ctx?.testKey) return ctx.testKey;
    throw new CoordError("not_ingested", "No hay un test activo.", "Llama a ingest_clash_test o set_active_context con testKey.");
  }

  async loadTest(testKey?: string): Promise<TestBundle> {
    const key = await this.resolveTestKey(testKey);
    const test = await this.cachedJson<TestRecord>(this.store.path("tests", key, "test.json"));
    if (!test) throw new CoordError("not_ingested", `El test ${key} no está en caché.`, "Llama a ingest_clash_test.");
    const cls = await this.cachedJson<ClassificationRecord>(this.store.path("tests", key, "classification.json"));
    return { test, cls };
  }

  async requireClassified(testKey?: string): Promise<{ test: TestRecord; cls: ClassificationRecord }> {
    const b = await this.loadTest(testKey);
    if (!b.cls) throw new CoordError("not_classified", `El test ${b.test.testKey} no está clasificado.`, "Llama a run_classification.");
    return { test: b.test, cls: b.cls };
  }

  cacheKey(t: TestRecord): CacheKey {
    return { projectId: bareProjectId(t.projectId), modelSetId: t.modelSetId, version: t.modelSetVersion, testId: t.testId };
  }

  async loadRaw(t: TestRecord): Promise<{ clashes: NormalizedClash[]; elements: ElementProps[]; documents: import("../core/types").ModelDocument[] }> {
    const data = await this.cache.readTest(this.cacheKey(t));
    if (!data) throw new CoordError("stale_cache", `Caché del test ${t.testKey} incompleta.`, "Llama a ingest_clash_test con refresh=true.");
    const elements = (await this.cache.readElements(this.cacheKey(t))) ?? [];
    return { clashes: data.clashes, documents: data.documents, elements };
  }

  // ── session ──────────────────────────────────────────────────────────────

  async sessionStatus() {
    const auth = await this.source.authStatus().catch(() => ({ loggedIn: false as const }));
    const user = auth.loggedIn ? await this.source.currentUser().catch(() => undefined) : undefined;
    const ctx = await this.store.getContext();
    const proposals = await this.store.listProposals();
    const batches = await this.store.listBatches();
    const feedback = await this.store.listFeedback();
    const tests = await this.store.listTests();
    let notes: { path: string; lines: number } | undefined;
    if (ctx?.projectId) {
      const text = await this.store.readNotes(ctx.projectId);
      if (text !== undefined) notes = { path: this.store.notesPath(ctx.projectId), lines: text.split("\n").length };
    }
    let rulesetVersion = "?";
    try {
      const { loadRules } = await import("./engine");
      const rs = loadRules();
      rulesetVersion = `m${rs.versions.matrix}.r${rs.versions.rules}.s${rs.versions.scoring}#${rs.hash.slice(0, 8)}`;
    } catch {
      rulesetVersion = "invalid";
    }
    return {
      auth: {
        loggedIn: auth.loggedIn,
        ...(user ? { user: { name: user.name, emailDomain: user.email?.split("@")[1] ?? "" } } : {}),
        ...("expiresAt" in auth && auth.expiresAt ? { expiresInMin: Math.max(0, Math.round((auth.expiresAt - this.now()) / 60000)) } : {}),
        ...("scopes" in auth && auth.scopes ? { scopes: auth.scopes } : {}),
        ...(auth.loggedIn ? {} : { loginUrl: `${this.config.ui.baseUrl}/` }),
      },
      autonomy: {
        level: this.loaded.configuredLevel,
        effectiveLevel: this.effectiveLevel,
        source: `${this.loaded.sources.join(" + ") || "defaults"}; máximo soportado v1: L${MAX_SUPPORTED_LEVEL}`,
      },
      dataSource: this.source.kind,
      ...(ctx?.projectId
        ? { active: { projectId: ctx.projectId, projectName: ctx.projectName ?? ctx.projectId, modelSetId: ctx.modelSetId, modelSetName: ctx.modelSetName, testKey: ctx.testKey } }
        : {}),
      ...(notes ? { projectNotes: notes } : {}),
      cache: { tests: tests.length, sizeMb: round(tests.reduce((n, t) => n + t.counts.clashes, 0) * 0.002, 1) },
      pending: {
        proposals: proposals.filter((p) => PENDING_STATES.includes(p.state)).length,
        approvedNotApplied: batches.filter((b) => b.state === "approved" || b.state === "partial").length,
        feedbackSinceLastCuration: feedback.filter((f) => !f.curated).length,
      },
      versions: { server: SERVER_VERSION, ruleset: rulesetVersion, engine: `${ENGINE_NAME}@${ENGINE_VERSION}` },
    };
  }

  async setActiveContext(input: { projectId: string; modelSetId?: string; testKey?: string }) {
    const projectId = input.projectId.startsWith("b.") ? input.projectId : `b.${input.projectId}`;
    const project = await this.source.getProject(projectId).catch(() => undefined);
    if (!project && this.source.kind === "fixtures") throw new CoordError("not_found", `Proyecto ${input.projectId} no existe`);
    let modelSetName: string | undefined;
    if (input.modelSetId) {
      const sets = await this.source.listModelSets(projectId).catch(() => []);
      const ms = sets.find((s) => s.id === input.modelSetId);
      if (!ms && this.source.kind === "fixtures") throw new CoordError("not_found", `Model set ${input.modelSetId} no existe`);
      modelSetName = ms?.name;
    }
    if (input.testKey) {
      const t = await this.store.getTest(input.testKey);
      if (!t) throw new CoordError("not_ingested", `El test ${input.testKey} no está en caché.`, "Llama a ingest_clash_test.");
    }
    const ctx = await this.store.setContext({
      projectId,
      projectName: project?.name ?? projectId,
      modelSetId: input.modelSetId,
      modelSetName,
      testKey: input.testKey,
    });
    return { projectId: ctx.projectId!, projectName: ctx.projectName!, modelSetId: ctx.modelSetId, modelSetName: ctx.modelSetName, testKey: ctx.testKey };
  }

  private async ctxProject(projectId?: string): Promise<string> {
    if (projectId) return projectId.startsWith("b.") ? projectId : `b.${projectId}`;
    const ctx = await this.store.getContext();
    if (ctx?.projectId) return ctx.projectId;
    throw new CoordError("validation_error", "Falta projectId y no hay proyecto activo.", "Llama a set_active_context.");
  }

  private async ctxModelSet(projectId: string, modelSetId?: string): Promise<string> {
    if (modelSetId) return modelSetId;
    const ctx = await this.store.getContext();
    if (ctx?.modelSetId && ctx.projectId === projectId) return ctx.modelSetId;
    const sets = await this.source.listModelSets(projectId);
    if (sets.length === 1) return sets[0].id;
    throw new CoordError("validation_error", "Falta modelSetId y no hay model set activo.", "Llama a list_model_sets y set_active_context.");
  }

  // ── discovery ────────────────────────────────────────────────────────────

  async listProjects(input: { nameContains?: string; hubId?: string; limit: number; cursor?: string }): Promise<Table> {
    const projects = await this.source.listProjects({ hubId: input.hubId, nameContains: input.nameContains });
    const page = paginate(projects, input.limit, input.cursor);
    return {
      columns: ["projectId", "name", "hubName", "mcEnabled"],
      rows: page.items.map((p) => [p.id, untrusted(p.name).untrusted, untrusted(p.hubName).untrusted, true]),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  async listModelSets(input: { projectId?: string }): Promise<Table> {
    const projectId = await this.ctxProject(input.projectId);
    const sets = await this.source.listModelSets(projectId);
    return {
      columns: ["modelSetId", "name", "latestVersion", "latestVersionAt", "documentCount"],
      rows: sets.map((s) => [s.id, untrusted(s.name).untrusted, s.latestVersion, s.latestVersionAt ?? "", s.documentCount]),
      total: sets.length,
    };
  }

  async listModelSetVersions(input: { projectId?: string; modelSetId?: string; limit: number; cursor?: string }): Promise<Table> {
    const projectId = await this.ctxProject(input.projectId);
    const modelSetId = await this.ctxModelSet(projectId, input.modelSetId);
    const versions = await this.source.listModelSetVersions(projectId, modelSetId);
    const page = paginate(versions, input.limit, input.cursor);
    return {
      columns: ["version", "createdAt", "status", "documentCount", "changedDocuments"],
      rows: page.items.map((v) => [v.version, v.createdAt ?? "", v.status, v.documentCount, 0]),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  async listClashTests(input: { projectId?: string; modelSetId?: string; version?: number }): Promise<Table> {
    const projectId = await this.ctxProject(input.projectId);
    const modelSetId = await this.ctxModelSet(projectId, input.modelSetId);
    const tests = await this.source.listClashTests(projectId, modelSetId, input.version);
    const cached = new Map((await this.store.listTests()).map((t) => [t.testId, t.testKey]));
    return {
      columns: ["testId", "viewName", "modelSetVersion", "status", "completedOn", "cachedTestKey"],
      rows: tests.map((t) => [t.id, untrusted(t.viewName).untrusted, t.modelSetVersion, t.status, t.completedOn ?? "", cached.get(t.id) ?? null]),
      total: tests.length,
    };
  }

  // ── ingest ───────────────────────────────────────────────────────────────

  async ingest(
    input: { projectId?: string; modelSetId?: string; testId: string; fetchProperties?: boolean; refresh?: boolean },
    caller: CallerContext = { actor: AGENT_ACTOR },
    progress?: (step: string, done: number, total: number) => void,
  ) {
    const t0 = this.now();
    const projectId = await this.ctxProject(input.projectId);
    const modelSetId = await this.ctxModelSet(projectId, input.modelSetId);
    const testKey = testKeyOf(projectId, modelSetId, input.testId);
    const existing = await this.store.getTest(testKey);
    if (existing && !input.refresh && (await this.cache.has(this.cacheKey(existing)))) {
      return { ...this.ingestOutput(existing), durationMs: this.now() - t0, cached: true };
    }
    const data = await this.source.fetchTest(projectId, modelSetId, input.testId, { fetchProperties: input.fetchProperties !== false, progress });
    // Per-clash triage state from ACC clash groups (research §3.3); best effort.
    const triage = await this.source.triageState(projectId, input.testId).catch(() => undefined);
    if (triage) data.clashes = data.clashes.map((c) => ({ ...c, triage: triage.assigned.has(c.id) ? "assigned" : triage.closed.has(c.id) ? "closed" : "open" }));
    const key: CacheKey = { projectId: bareProjectId(projectId), modelSetId, version: data.test.modelSetVersion, testId: input.testId };
    await this.cache.writeTest(key, { clashes: data.clashes, documents: data.documents, meta: { source: this.source.kind, warnings: data.warnings } });
    await this.cache.writeElements(key, data.elements);

    const byStatus: Record<AccStatus, number> = { active: 0, reviewed: 0, resolved: 0, closed: 0 };
    for (const c of data.clashes) if (c.status in byStatus) byStatus[c.status as AccStatus]++;
    const byTriageState = { open: 0, assigned: 0, closed: 0 };
    for (const c of data.clashes) byTriageState[c.triage ?? "open"]++;
    const afterDedupe = new Set(data.clashes.map((c) => c.pairKey ?? c.id)).size;
    const pens = data.clashes.map((c) => c.penetrationMm).sort((a, b) => a - b);
    const sides = new Set(data.clashes.flatMap((c) => [`${c.left.documentId}:${c.left.viewerDbId}`, `${c.right.documentId}:${c.right.viewerDbId}`]));
    const found = new Set(data.elements.map((e) => `${e.documentId}:${e.lmvId}`));
    const coverage = sides.size ? [...sides].filter((s) => found.has(s)).length / sides.size : 0;
    const previous = (await this.store.listTests())
      .filter((t) => bareProjectId(t.projectId) === bareProjectId(projectId) && t.modelSetId === modelSetId && t.modelSetVersion < data.test.modelSetVersion)
      .sort((a, b) => b.modelSetVersion - a.modelSetVersion)[0];

    const rec: TestRecord = {
      testKey,
      projectId,
      projectName: data.project.name,
      modelSetId,
      modelSetName: data.modelSet.name,
      modelSetVersion: data.test.modelSetVersion,
      testId: input.testId,
      viewName: data.test.viewName,
      completedOn: data.test.completedOn,
      ingestedAt: nowIso(this.now()),
      documents: data.documents.map((d) => ({
        documentId: d.id,
        urn: d.urn,
        viewerUrn: d.viewerUrn,
        name: untrusted(d.displayName).untrusted,
        viewableName: untrusted(d.viewableName).untrusted,
        lineageUrn: d.lineageUrn,
      })),
      counts: { clashes: data.clashes.length, afterDedupe, elements: data.elements.length, byStatus, byTriageState },
      penetrationMm: { p50: round(percentile(pens, 50)), p90: round(percentile(pens, 90)), max: round(pens[pens.length - 1] ?? 0) },
      properties: { status: data.propertiesStatus, coveragePct: round(coverage * 100) },
      previousTestKey: previous?.testKey,
      clashesHash: sha256(data.clashes.map((c) => `${c.id}:${c.distanceMm}:${c.status}`).join("|")),
      warnings: data.warnings,
    };
    await this.store.putTest(rec);
    const ctx = await this.store.getContext();
    await this.store.setContext({ ...ctx, projectId, projectName: data.project.name, modelSetId, modelSetName: data.modelSet.name, testKey });
    await this.store.audit({
      actor: caller.actor,
      action: "test.ingested",
      projectId,
      modelSetId,
      testId: input.testId,
      details: { testKey, clashes: rec.counts.clashes, version: rec.modelSetVersion, properties: rec.properties.status },
    });
    return { ...this.ingestOutput(rec), durationMs: this.now() - t0, cached: false };
  }

  private ingestOutput(t: TestRecord) {
    return {
      testKey: t.testKey,
      modelSet: { id: t.modelSetId, name: t.modelSetName, version: t.modelSetVersion },
      viewName: t.viewName,
      documents: t.documents.map((d) => ({
        docIndex: d.documentId,
        name: untrusted(`${d.name} · ${d.viewableName}`),
        ...(d.discipline ? { discipline: d.discipline } : {}),
        disciplineSource: (d.discipline ? "rule" : "unknown") as "rule" | "unknown",
      })),
      counts: t.counts,
      penetrationMm: t.penetrationMm,
      properties: t.properties,
      ...(t.previousTestKey ? { previousTestKey: t.previousTestKey } : {}),
    };
  }

  // ── classification ───────────────────────────────────────────────────────

  async classify(
    input: { testKey?: string; rulesetRef?: string; dryRun?: boolean; proposeAutoAccepted?: boolean },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    const t0 = this.now();
    if (input.proposeAutoAccepted) this.requireLevel(1, "proposeAutoAccepted");
    const { test } = await this.loadTest(input.testKey);
    const raw = await this.loadRaw(test);
    let rulesDir: string | undefined;
    if (input.rulesetRef) {
      const p = await this.store.getProposal(input.rulesetRef);
      if (!p || p.payload.kind !== "rule_change") throw new CoordError("not_found", `rulesetRef ${input.rulesetRef} no es una propuesta de regla`);
      rulesDir = await this.candidateRulesDir((await import("node:fs/promises")).readFile(p.payload.patchFile, "utf8"));
    }
    const { loadRules } = await import("./engine");
    const out = runEngine({
      clashes: raw.clashes,
      elements: raw.elements,
      documents: raw.documents,
      config: this.config,
      rules: loadRules(rulesDir),
      testId: test.testId,
      modelSetVersion: test.modelSetVersion,
      publishDate: nowIso(this.now()).slice(0, 10),
    });

    // Delta vs the previous cached test of the same model set.
    let resolved: string[] = [];
    let carried = 0;
    if (test.previousTestKey) {
      const prevTest = await this.store.getTest(test.previousTestKey);
      const prevCls = prevTest ? await this.store.getClassification(prevTest.testKey) : undefined;
      if (prevTest) {
        const prevRaw = await this.loadRaw(prevTest).catch(() => undefined);
        if (prevRaw) {
          const diff = diffTestVersions(prevRaw.clashes, raw.clashes, { history: await this.historyBefore(prevTest) });
          const idx = diffStateIndex(diff);
          const prevById = new Map(prevRaw.clashes.map((c) => [c.id, c]));
          const pairMap = new Map(diff.matchedByPairKey.map((m) => [m.nextId, m.prevId]));
          for (const c of out.clashes) {
            const st = idx.get(c.id);
            const prev = prevById.get(pairMap.get(c.id) ?? c.id);
            if (st === "persisting") {
              c.delta = prev && Math.abs(prev.distanceMm - c.distanceMm) > 10 ? "modified" : "persisting";
              if (prev) c.previousDistanceMm = prev.distanceMm;
            } else if (st === "reappeared") c.delta = "reappeared";
            else c.delta = "new";
          }
          resolved = [...diff.resolved, ...diff.element_deleted];
        }
        if (prevCls) {
          const decided = new Set((await this.effectiveDecisions(prevTest.testKey)).keys());
          const prevGroupOfClash = new Map(prevCls.clashes.map((c) => [c.id, c.groupId]));
          const carriedGroups = new Set<string>();
          for (const c of out.clashes) {
            const g = prevGroupOfClash.get(c.id);
            if (g && decided.has(g)) carriedGroups.add(c.groupId);
          }
          carried = carriedGroups.size;
        }
      }
    }
    const clashById = new Map(out.clashes.map((c) => [c.id, c]));
    for (const g of out.groups) {
      const ds = { new: 0, persisting: 0, reappeared: 0, modified: 0 };
      for (const id of g.clashIds) {
        const d = clashById.get(id)?.delta;
        if (d && d !== "resolved") ds[d]++;
      }
      g.deltaSummary = ds;
      g.delta = ds.reappeared ? "reappeared" : ds.new >= ds.persisting + ds.modified ? (ds.new ? "new" : "persisting") : ds.modified ? "modified" : "persisting";
    }

    const rec: ClassificationRecord = {
      testKey: test.testKey,
      createdAt: nowIso(this.now()),
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
      ruleset: out.ruleset,
      groups: out.groups,
      clashes: out.clashes,
      resolvedSincePrevious: resolved,
      stats: { unmatchedClashes: out.unmatchedClashes, topRules: out.topRules, carriedDecisions: carried, durationMs: this.now() - t0 },
    };
    (rec as ClassificationRecord & { issueDrafts?: unknown }).issueDrafts = out.issueDrafts;

    const byValidity: Record<Validity, number> = { real: 0, false_positive: 0, tolerated: 0, needs_info: 0 };
    for (const c of out.clashes) byValidity[c.validity]++;
    const confidence = { alta: 0, media: 0, baja: 0 };
    for (const g of out.groups) confidence[g.confidenceBand]++;
    const nr = out.groups.filter((g) => g.reviewState === "needs_review");

    let batchProposals: Array<{ proposalId: string; kind: ProposalKind; groups: number; clashes: number }> | undefined;
    if (!input.dryRun && !input.rulesetRef) {
      await this.store.putClassification(rec);
      // Document disciplines learned by the engine.
      const discOf = new Map(out.documents.map((d) => [d.documentId, d.discipline]));
      await this.store.putTest({ ...test, documents: test.documents.map((d) => ({ ...d, discipline: discOf.get(d.documentId) ?? d.discipline })) });
      if (input.proposeAutoAccepted) batchProposals = await this.createEngineBatchProposals(test, out.groups);
      await this.store.audit({
        actor: caller.actor,
        action: "classification.run",
        projectId: test.projectId,
        modelSetId: test.modelSetId,
        testId: test.testId,
        details: { testKey: test.testKey, groups: out.groups.length, needsReview: nr.length, ruleset: out.ruleset.hash },
      });
    }
    return {
      testKey: test.testKey,
      ruleset: out.ruleset,
      groups: { total: out.groups.length, byStrategy: out.byStrategy },
      clashesClassified: out.clashes.length,
      byValidity,
      confidence,
      needsReview: { groups: nr.length, clashes: nr.reduce((n, g) => n + g.clashIds.length, 0) },
      unmatchedClashes: out.unmatchedClashes,
      topRules: out.topRules,
      carriedDecisions: carried,
      ...(batchProposals ? { batchProposals } : {}),
      ...(input.dryRun || input.rulesetRef ? { persisted: false } : {}),
      durationMs: this.now() - t0,
    };
  }

  /** Engine batch proposals for auto_ok groups; supersedes earlier pending engine batches for the test. */
  private async createEngineBatchProposals(test: TestRecord, groups: GroupRecord[]) {
    const old = await this.store.listProposals((p) => p.testKey === test.testKey && p.createdBy.type === "engine" && PENDING_STATES.includes(p.state));
    for (const p of old) await this.store.transitionProposal(p.id, "withdrawn", "engine", "reemplazada por nueva clasificación");
    const autoOk = groups.filter((g) => g.reviewState === "auto_ok");
    const closable = autoOk.filter((g) => CLOSABLE.includes(g.validity));
    const real = autoOk.filter((g) => g.validity === "real");
    const out: Array<{ proposalId: string; kind: ProposalKind; groups: number; clashes: number }> = [];
    for (const [op, list] of [["status_change", closable], ["classification", real]] as const) {
      if (list.length === 0) continue;
      const clashes = list.reduce((n, g) => n + g.clashIds.length, 0);
      const p = await this.store.createProposal({
        kind: op,
        testKey: test.testKey,
        projectId: test.projectId,
        modelSetId: test.modelSetId,
        modelSetVersion: test.modelSetVersion,
        createdBy: ENGINE_ACTOR,
        target: { groupIds: list.map((g) => g.id), clashIds: [] },
        payload: {
          kind: "engine_batch",
          op,
          groups: list.map((g) => ({ groupId: g.id, validity: g.validity, confidence: g.confidence, clashes: g.clashIds.length })),
        },
        rationale:
          op === "status_change"
            ? `Motor: ${list.length} grupos cerrables (falso positivo, duplicado o tolerancia) con confianza sobre el umbral de auto-aceptación.`
            : `Motor: ${list.length} grupos reales con confianza sobre el umbral; requieren incidencia.`,
        evidence: [],
        confidence: "alta",
        risk: op === "status_change" ? "low" : "medium",
        affectedClashes: clashes,
      });
      await this.store.audit({ actor: ENGINE_ACTOR, action: "proposal.created", projectId: test.projectId, modelSetId: test.modelSetId, testId: test.testId, targetIds: [p.id], details: { kind: op, groups: list.length, engineBatch: true } });
      out.push({ proposalId: p.id, kind: op, groups: list.length, clashes });
    }
    return out;
  }

  /** Clash ids and pairKeys of cached tests of the same model set OLDER than `t` (reappeared detection). */
  private async historyBefore(t: TestRecord): Promise<string[]> {
    const out: string[] = [];
    for (const o of await this.store.listTests()) {
      if (o.modelSetId !== t.modelSetId || o.modelSetVersion >= t.modelSetVersion) continue;
      const raw = await this.loadRaw(o).catch(() => undefined);
      for (const c of raw?.clashes ?? []) out.push(c.id, ...(c.pairKey ? [c.pairKey] : []));
    }
    return out;
  }

  // ── review state helpers ─────────────────────────────────────────────────

  /** Latest effective (non-undone) decision per group for a test. */
  async effectiveDecisions(testKey: string): Promise<Map<string, import("./store/types").DecisionRecord>> {
    const all = (await this.store.listDecisions()).filter((d) => d.testId === testKey);
    const undone = new Set(all.filter((d) => d.kind === "undo" && d.undoes).map((d) => d.undoes!));
    const out = new Map<string, import("./store/types").DecisionRecord>();
    for (const d of all) {
      if (d.kind === "undo" || d.kind === "note" || undone.has(d.id)) continue;
      out.set(d.targetType === "group" ? d.targetId : `clash:${d.targetId}`, d);
    }
    return out;
  }

  /** Pending/approved agent+engine proposals touching each group. */
  async proposalsByGroup(testKey: string, cls: ClassificationRecord): Promise<Map<string, ProposalRecord[]>> {
    const groupOfClash = new Map(cls.clashes.map((c) => [c.id, c.groupId]));
    const out = new Map<string, ProposalRecord[]>();
    const ps = await this.store.listProposals((p) => p.testKey === testKey && p.state !== "withdrawn" && p.state !== "rejected");
    for (const p of ps) {
      const gs = new Set(p.target.groupIds);
      for (const c of p.target.clashIds) {
        const g = groupOfClash.get(c.replace(/^C-/, ""));
        if (g) gs.add(g);
      }
      for (const g of gs) out.set(g, [...(out.get(g) ?? []), p]);
    }
    return out;
  }

  reviewStateOf(g: GroupRecord, props: ProposalRecord[] | undefined, decided: boolean): ReviewState {
    if (decided) return "decided";
    if (props?.some((p) => p.createdBy.type === "agent" && PENDING_STATES.includes(p.state))) return "proposed";
    return g.reviewState;
  }

  // ── analysis ─────────────────────────────────────────────────────────────

  private filterGroups(groups: GroupRecord[], f: GroupFilter | undefined, states: Map<string, ReviewState>): GroupRecord[] {
    if (!f) return groups;
    return groups.filter((g) => {
      if (f.status?.length && !f.status.includes(g.accStatus)) return false;
      if (f.triageState?.length && !f.triageState.includes(g.triageState)) return false;
      if (f.band?.length && !f.band.includes(g.bandName)) return false;
      if (f.suggestedAction?.length && !(g.suggestedAction && f.suggestedAction.includes(g.suggestedAction))) return false;
      if (f.tag?.length && !g.tags.some((t) => f.tag!.includes(t))) return false;
      if (f.validity?.length && !f.validity.includes(g.validity)) return false;
      if (f.severity?.length && !f.severity.includes(g.severity)) return false;
      if (f.disciplinePair?.length && !f.disciplinePair.includes(g.disciplinePair)) return false;
      if (f.level?.length && !g.levels.some((l) => f.level!.includes(l))) return false;
      if (f.minPenetrationMm !== undefined && g.maxPenetrationMm < f.minPenetrationMm) return false;
      if (f.needsReview !== undefined && (states.get(g.id) === "needs_review") !== f.needsReview) return false;
      if (f.confidenceBelow !== undefined && !(g.confidence < f.confidenceBelow)) return false;
      if (f.confidenceAtLeast !== undefined && !(g.confidence >= f.confidenceAtLeast)) return false;
      if (f.ruleId?.length && !g.ruleIds.some((r) => f.ruleId!.includes(r) || f.ruleId!.includes(`R-${r}`))) return false;
      if (f.diffState) {
        const want = f.diffState === "reopened" ? "reappeared" : f.diffState;
        if (want === "persisting" ? g.deltaSummary.persisting + g.deltaSummary.modified === 0 : g.deltaSummary[want as "new" | "reappeared"] === 0) return false;
      }
      return true;
    });
  }

  async groupStates(testKey: string, cls: ClassificationRecord): Promise<Map<string, ReviewState>> {
    const decided = await this.effectiveDecisions(testKey);
    const props = await this.proposalsByGroup(testKey, cls);
    return new Map(cls.groups.map((g) => [g.id, this.reviewStateOf(g, props.get(g.id), decided.has(g.id))]));
  }

  async listGroups(input: { testKey?: string; filter?: GroupFilter; sort?: string; limit: number; cursor?: string }): Promise<Table> {
    const { test, cls } = await this.requireClassified(input.testKey);
    const states = await this.groupStates(test.testKey, cls);
    let groups = this.filterGroups(cls.groups, input.filter, states);
    groups = this.sortGroups(groups, input.sort ?? "priority");
    const page = paginate(groups, input.limit, input.cursor);
    return {
      columns: ["groupId", "clashCount", "disciplinePair", "categoryPair", "level", "validity", "severity", "priority", "confidence", "reviewState", "label"],
      rows: page.items.map((g) => [
        g.id,
        g.clashIds.length,
        g.disciplinePair,
        g.categoryPair,
        g.levels[0] ?? "",
        g.validity,
        g.severity,
        g.priority,
        round(g.confidence, 2),
        states.get(g.id) ?? g.reviewState,
        untrusted(g.title),
      ]),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  sortGroups(groups: GroupRecord[], sort: string): GroupRecord[] {
    const s = [...groups];
    const byId = (a: GroupRecord, b: GroupRecord) => (a.id < b.id ? -1 : 1);
    switch (sort) {
      case "clashCount":
      case "count_desc":
        return s.sort((a, b) => b.clashIds.length - a.clashIds.length || byId(a, b));
      case "confidenceAsc":
      case "confidence_asc":
        return s.sort((a, b) => a.confidence - b.confidence || byId(a, b));
      case "penetration":
      case "distance":
        return s.sort((a, b) => b.maxPenetrationMm - a.maxPenetrationMm || byId(a, b));
      case "level":
        return s.sort((a, b) => (a.levels[0] ?? "").localeCompare(b.levels[0] ?? "") || byId(a, b));
      default:
        return s.sort((a, b) => a.band - b.band || b.priority - a.priority || byId(a, b));
    }
  }

  async getGroup(input: { testKey?: string; groupId: string; sampleClashes: number; includeElementProps: boolean }) {
    const { test, cls } = await this.requireClassified(input.testKey);
    const g = cls.groups.find((x) => x.id === input.groupId);
    if (!g) throw new CoordError("not_found", `Grupo ${input.groupId} no existe en ${test.testKey}`, "Usa list_groups para ver los ids.");
    const members = cls.clashes.filter((c) => c.groupId === g.id);
    const decided = await this.effectiveDecisions(test.testKey);
    const props = (await this.proposalsByGroup(test.testKey, cls)).get(g.id) ?? [];
    const sampleIds = new Set(g.sampleClashIds);
    const sample = [...members]
      .sort((a, b) => Number(sampleIds.has(b.id)) - Number(sampleIds.has(a.id)) || b.penetrationMm - a.penetrationMm)
      .slice(0, input.sampleClashes)
      .map((c) => ({
        clashId: c.id,
        triageState: c.triageState,
        penetrationMm: round(c.penetrationMm),
        distanceMm: round(c.distanceMm),
        left: `${c.a.ref} ${c.a.category}`,
        right: `${c.b.ref} ${c.b.category}`,
      }));
    let elements: unknown[] | undefined;
    if (input.includeElementProps) {
      const seen = new Map<string, ClashRecord["a"]>();
      for (const c of members) for (const s of [c.a, c.b]) if (!seen.has(s.ref) && seen.size < 12) seen.set(s.ref, s);
      elements = [...seen.values()].map((s) => ({
        ref: s.ref,
        doc: s.modelName,
        discipline: s.discipline,
        category: s.category,
        ...(s.family ? { family: untrusted(s.family) } : {}),
        ...(s.type ? { type: untrusted(s.type) } : {}),
        ...(s.level ? { level: s.level } : {}),
        ...(s.system ? { system: untrusted(s.system) } : {}),
        ...(s.sizeHint ? { sizeHint: s.sizeHint } : {}),
        ...(s.externalId ? { externalId: s.externalId } : {}),
      }));
    }
    const dec = decided.get(g.id);
    const evidence: EvidenceItem[] = g.ruleIds.slice(0, 6).map((r) => {
      const hits = members.filter((m) => m.ruleId === r).length;
      return { kind: "rule_hit", ref: r, summary: `${hits} de ${members.length} interferencias` };
    });
    return {
      groupId: g.id,
      strategy: g.engineStrategy,
      clashCount: g.clashIds.length,
      label: untrusted(g.title),
      location: { levels: g.levels },
      classification: {
        validity: g.validity,
        nature: g.nature,
        ...(g.rootCause ? { rootCause: g.rootCause } : {}),
        responsibleDiscipline: g.responsibleDiscipline,
        ...(g.secondaryDiscipline ? { secondaryDiscipline: g.secondaryDiscipline } : {}),
        severity: g.severity,
        priority: g.priority,
        band: g.bandName,
        confidence: g.confidence,
        humanReview: g.humanReview,
        ...(g.suggestedAction ? { suggestedAction: g.suggestedAction } : {}),
        ruleId: g.ruleIds[0] ?? "",
        ruleIds: g.ruleIds,
        rationale: untrusted(g.rationale ?? ""),
        tags: g.tags,
        source: "engine" as const,
      },
      reviewState: this.reviewStateOf(g, props, !!dec),
      reviewReasons: g.reviewReasons,
      evidence,
      history: {
        firstSeenVersion: test.modelSetVersion,
        versionsPersisting: g.deltaSummary.persisting + g.deltaSummary.modified > 0 ? 2 : 1,
        ...(dec ? { previousDecision: `${dec.kind}${dec.reasonCode ? " " + dec.reasonCode : ""}` } : {}),
      },
      deltaSummary: g.deltaSummary,
      existingProposals: props.map((p) => p.id),
      sample,
      ...(elements ? { elements } : {}),
    };
  }

  async listClashes(input: { testKey?: string; groupId?: string; filter?: GroupFilter; sort?: string; limit: number; cursor?: string }): Promise<Table> {
    const { test, cls } = await this.requireClassified(input.testKey);
    let clashes = cls.clashes;
    if (input.groupId) {
      if (!cls.groups.some((g) => g.id === input.groupId)) throw new CoordError("not_found", `Grupo ${input.groupId} no existe`);
      clashes = clashes.filter((c) => c.groupId === input.groupId);
    }
    const f = input.filter;
    if (f) {
      const states = await this.groupStates(test.testKey, cls);
      const gById = new Map(cls.groups.map((g) => [g.id, g]));
      clashes = clashes.filter((c) => {
        const g = gById.get(c.groupId)!;
        if (f.status?.length && !f.status.includes(c.status)) return false;
        if (f.triageState?.length && !f.triageState.includes(c.triageState)) return false;
        if (f.band?.length && !f.band.includes(g.bandName)) return false;
        if (f.suggestedAction?.length && !(c.suggestedAction && f.suggestedAction.includes(c.suggestedAction))) return false;
        if (f.tag?.length && !(c.tags ?? []).some((t) => f.tag!.includes(t))) return false;
        if (f.validity?.length && !f.validity.includes(c.validity)) return false;
        if (f.severity?.length && !f.severity.includes(c.severity)) return false;
        if (f.disciplinePair?.length && !f.disciplinePair.includes(c.disciplinePair)) return false;
        if (f.level?.length && !(c.level && f.level.includes(c.level))) return false;
        if (f.minPenetrationMm !== undefined && c.penetrationMm < f.minPenetrationMm) return false;
        if (f.needsReview !== undefined && (states.get(c.groupId) === "needs_review") !== f.needsReview) return false;
        if (f.confidenceBelow !== undefined && !(c.confidence < f.confidenceBelow)) return false;
        if (f.confidenceAtLeast !== undefined && !(c.confidence >= f.confidenceAtLeast)) return false;
        if (f.ruleId?.length && !(c.ruleId && f.ruleId.includes(`R-${c.ruleId}`) || (c.ruleId && f.ruleId.includes(c.ruleId)))) return false;
        if (f.diffState && c.delta !== (f.diffState === "reopened" ? "reappeared" : f.diffState)) return false;
        return true;
      });
    }
    const prio = new Map(cls.groups.map((g) => [g.id, g.priority]));
    const sorted = [...clashes].sort((a, b) =>
      input.sort === "id"
        ? a.id.length - b.id.length || (a.id < b.id ? -1 : 1)
        : input.sort === "priority"
          ? (prio.get(b.groupId) ?? 0) - (prio.get(a.groupId) ?? 0) || b.penetrationMm - a.penetrationMm
          : b.penetrationMm - a.penetrationMm || (a.id < b.id ? -1 : 1),
    );
    const page = paginate(sorted, input.limit, input.cursor);
    return {
      columns: ["clashId", "groupId", "triageState", "validity", "penetrationMm", "leftRef", "leftCategory", "rightRef", "rightCategory", "level"],
      rows: page.items.map((c) => [c.id, c.groupId, c.triageState, c.validity, round(c.penetrationMm), c.a.ref, c.a.category, c.b.ref, c.b.category, c.level ?? ""]),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  async getElementProperties(input: { testKey?: string; elements: string[]; properties: "core" | string[] }) {
    const { test } = await this.loadTest(input.testKey);
    if (test.properties.status === "pending") {
      throw new CoordError("properties_pending", "Las propiedades aún se están indexando.", "Reintenta en unos minutos o ingesta con refresh=true.", true);
    }
    const els = (await this.cache.readElements(this.cacheKey(test))) ?? [];
    const byRef = new Map(els.map((e) => [`E-${e.documentId}:${e.lmvId}`, e]));
    const CORE: Array<[string, keyof ElementProps]> = [
      ["category", "category"], ["family", "family"], ["type", "type"], ["level", "level"], ["system", "system"],
      ["size", "size"], ["material", "material"], ["workset", "workset"], ["comments", "comments"], ["mark", "mark"],
    ];
    const elements = input.elements.map((ref) => {
      const e = byRef.get(ref);
      if (!e) return { ref, found: false, props: {} };
      const props: Record<string, Untrusted | number | boolean | null> = {};
      const put = (k: string, v: unknown) => {
        if (v === undefined) return;
        props[k] = typeof v === "number" || typeof v === "boolean" || v === null ? (v as number | boolean | null) : untrusted(v);
      };
      if (input.properties === "core") for (const [k, f] of CORE) put(k, e[f]);
      else {
        for (const name of input.properties) {
          const direct = (e as unknown as Record<string, unknown>)[name];
          if (direct !== undefined && typeof direct !== "object") put(name, direct);
          else {
            const hit = Object.entries(e.raw ?? {}).find(([k]) => k.toLowerCase().endsWith(`/${name.toLowerCase()}`) || k.toLowerCase() === name.toLowerCase());
            put(name, hit ? hit[1] : null);
          }
        }
      }
      return { ref, found: true, props };
    });
    return { elements, status: test.properties.status === "skipped" ? ("partial" as const) : (test.properties.status as "ready" | "partial") };
  }

  // ── summaries ────────────────────────────────────────────────────────────

  async summarize(input: { testKey?: string; groupBy: string[]; filter?: GroupFilter; unit: "clashes" | "groups"; topN: number }) {
    const b = await this.loadTest(input.testKey);
    const RAW_DIMS = new Set(["status", "triageState", "documentPair"]);
    if (!b.cls && !input.groupBy.every((d) => RAW_DIMS.has(d))) {
      throw new CoordError("not_classified", "Solo triageState y documentPair están disponibles antes de clasificar.", "Llama a run_classification.");
    }
    const rows: Array<{ keys: string[]; pen: number }> = [];
    if (!b.cls) {
      const raw = await this.loadRaw(b.test);
      const docName = new Map(b.test.documents.map((d) => [d.documentId, d.name]));
      for (const c of raw.clashes) {
        rows.push({
          keys: input.groupBy.map((d) => (d === "status" ? c.status : d === "triageState" ? c.triage ?? "open" : sortPair(docName.get(c.left.documentId) ?? "?", docName.get(c.right.documentId) ?? "?"))),
          pen: c.penetrationMm,
        });
      }
    } else {
      const cls = b.cls;
      const states = await this.groupStates(b.test.testKey, cls);
      const groups = this.filterGroups(cls.groups, input.filter, states);
      const gById = new Map(groups.map((g) => [g.id, g]));
      if (input.unit === "groups") for (const g of groups) rows.push({ keys: input.groupBy.map((d) => groupDim(g, d)), pen: g.maxPenetrationMm });
      else {
        for (const c of cls.clashes) {
          const g = gById.get(c.groupId);
          if (g) rows.push({ keys: input.groupBy.map((d) => clashDim(c, g, d)), pen: c.penetrationMm });
        }
      }
    }
    const agg = new Map<string, { keys: string[]; count: number; max: number }>();
    for (const r of rows) {
      const k = r.keys.join("\u0000");
      const a = agg.get(k) ?? { keys: r.keys, count: 0, max: 0 };
      a.count++;
      a.max = Math.max(a.max, r.pen);
      agg.set(k, a);
    }
    const total = rows.length;
    const sorted = [...agg.values()].sort((a, b) => b.count - a.count || a.keys.join().localeCompare(b.keys.join()));
    const out: unknown[][] = sorted.slice(0, input.topN).map((a) => [...a.keys, a.count, round((a.count / Math.max(1, total)) * 100), round(a.max)]);
    const rest = sorted.slice(input.topN);
    if (rest.length) {
      const n = rest.reduce((s, a) => s + a.count, 0);
      out.push([...input.groupBy.map(() => "otros"), n, round((n / Math.max(1, total)) * 100), round(Math.max(...rest.map((a) => a.max)))]);
    }
    return { columns: [...input.groupBy, "count", "pctOfTotal", "maxPenetrationMm"], rows: out, total, unit: input.unit, classified: !!b.cls };
  }

  async diffVersions(input: { baseTestKey: string; targetTestKey?: string; groupBy: string; topPersisting: number }) {
    const base = await this.requireClassified(input.baseTestKey);
    const target = await this.requireClassified(await this.resolveTestKey(input.targetTestKey));
    if (base.test.modelSetId !== target.test.modelSetId) throw new CoordError("validation_error", "Los tests deben ser del mismo model set.");
    const baseRaw = await this.loadRaw(base.test);
    const targetRaw = await this.loadRaw(target.test);
    const diff = diffTestVersions(baseRaw.clashes, targetRaw.clashes, { history: await this.historyBefore(base.test) });
    const tById = new Map(target.cls.clashes.map((c) => [c.id, c]));
    const bById = new Map(base.cls.clashes.map((c) => [c.id, c]));
    const tG = new Map(target.cls.groups.map((g) => [g.id, g]));
    const bG = new Map(base.cls.groups.map((g) => [g.id, g]));
    type Row = { new: number; resolved: number; persisting: number; elementDeleted: number; reappeared: number };
    const by = new Map<string, Row>();
    const bump = (c: ClashRecord | undefined, groups: Map<string, GroupRecord>, f: keyof Row) => {
      if (!c) return;
      const k = clashDim(c, groups.get(c.groupId)!, input.groupBy);
      const r = by.get(k) ?? { new: 0, resolved: 0, persisting: 0, elementDeleted: 0, reappeared: 0 };
      r[f]++;
      by.set(k, r);
    };
    for (const id of diff.new) bump(tById.get(id), tG, "new");
    for (const id of diff.persisting) bump(tById.get(id), tG, "persisting");
    for (const id of diff.reappeared) bump(tById.get(id), tG, "reappeared");
    for (const id of diff.resolved) bump(bById.get(id), bG, "resolved");
    for (const id of diff.element_deleted) bump(bById.get(id), bG, "elementDeleted");
    const persisting = new Set(diff.persisting);
    const baseDecided = await this.effectiveDecisions(base.test.testKey);
    const prevGroupOf = new Map(base.cls.clashes.map((c) => [c.id, c.groupId]));
    const pairMap = new Map(diff.matchedByPairKey.map((m) => [m.nextId, m.prevId]));
    const topGroups = target.cls.groups
      .map((g) => {
        const pers = g.clashIds.filter((id) => persisting.has(id));
        const prevG = pers.map((id) => prevGroupOf.get(pairMap.get(id) ?? id)).find((x) => x && baseDecided.has(x));
        const d = prevG ? baseDecided.get(prevG) : undefined;
        return { g, n: pers.length, prev: d ? `${d.kind}${d.reasonCode ? " " + d.reasonCode : ""}` : "" };
      })
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || (a.g.id < b.g.id ? -1 : 1));
    return {
      base: { testKey: base.test.testKey, version: base.test.modelSetVersion },
      target: { testKey: target.test.testKey, version: target.test.modelSetVersion },
      matching: {
        byClashId: diff.counts.persisting - diff.matchedByPairKey.length,
        byPairKey: diff.matchedByPairKey.length,
        unmatched: diff.counts.new + diff.counts.reappeared,
      },
      totals: {
        new: diff.counts.new,
        resolved: diff.counts.resolved,
        persisting: diff.counts.persisting,
        elementDeleted: diff.counts.element_deleted,
        reappeared: diff.counts.reappeared,
      },
      byDimension: {
        columns: [input.groupBy, "new", "resolved", "persisting", "elementDeleted", "reappeared"],
        rows: [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, v.new, v.resolved, v.persisting, v.elementDeleted, v.reappeared]),
        total: by.size,
      },
      topPersistingGroups: {
        columns: ["groupId", "label", "versionsPersisting", "clashCount", "previousDecision"],
        rows: topGroups.slice(0, input.topPersisting).map((x) => [x.g.id, untrusted(x.g.title), 2, x.g.clashIds.length, x.prev || null]),
        total: topGroups.length,
      },
      decisionsCarried: topGroups.filter((x) => x.prev).length,
    };
  }

  async hygieneStats(input: { testKey?: string; checks?: string[]; examplesPerCheck: number }) {
    const { test, cls } = await this.requireClassified(input.testKey);
    const all = ["self_clashes_same_document", "duplicate_elements", "missing_level", "missing_system", "generic_or_placeholder_types", "unassigned_discipline_documents", "insulation_hosted_clashes", "linked_model_misplacement", "category_mismatch_by_name"];
    const checks = input.checks?.length ? input.checks : all;
    const MEP = /duct|pipe|conduit|cable tray|tuber|conduct|bandeja|canaliz/i;
    const GENERIC = /gen[eé]ric|default|predetermin|placeholder|sin tipo|standard$/i;
    const INSUL = /insulation|aislaci|aislamiento|lining/i;
    const docOf = new Map(test.documents.map((d) => [d.documentId, d]));
    type Doc = { doc: string; discipline: string; elements: Set<string>; self: number; dup: number; noLevel: Set<string>; noSystem: Set<string>; generic: Set<string> };
    const perDoc = new Map<number, Doc>();
    const getDoc = (id: number): Doc => {
      let d = perDoc.get(id);
      if (!d) {
        const doc = docOf.get(id);
        d = { doc: doc ? `${doc.name} · ${doc.viewableName}` : `doc ${id}`, discipline: doc?.discipline ?? "?", elements: new Set(), self: 0, dup: 0, noLevel: new Set(), noSystem: new Set(), generic: new Set() };
        perDoc.set(id, d);
      }
      return d;
    };
    const findings = new Map<string, { check: string; doc: string; count: number; examples: string[]; clashes: Set<string> }>();
    const hit = (check: string, doc: string, ref: string, clashId: string) => {
      if (!checks.includes(check)) return;
      const k = `${check}|${doc}`;
      const f = findings.get(k) ?? { check, doc, count: 0, examples: [], clashes: new Set<string>() };
      if (!f.examples.includes(ref)) {
        f.count++;
        if (f.examples.length < input.examplesPerCheck) f.examples.push(ref);
      }
      f.clashes.add(clashId);
      findings.set(k, f);
    };
    for (const c of cls.clashes) {
      for (const s of [c.a, c.b]) {
        const d = getDoc(s.documentId);
        d.elements.add(s.ref);
        if (!s.level) { d.noLevel.add(s.ref); hit("missing_level", d.doc, s.ref, c.id); }
        if (MEP.test(s.category) && !INSUL.test(s.category) && !s.system) { d.noSystem.add(s.ref); hit("missing_system", d.doc, s.ref, c.id); }
        if (s.type && GENERIC.test(s.type)) { d.generic.add(s.ref); hit("generic_or_placeholder_types", d.doc, s.ref, c.id); }
        if (INSUL.test(s.category)) hit("insulation_hosted_clashes", d.doc, s.ref, c.id);
      }
      if (c.a.documentId === c.b.documentId) { getDoc(c.a.documentId).self++; hit("self_clashes_same_document", getDoc(c.a.documentId).doc, c.a.ref, c.id); }
      if ((c.a.externalId && c.a.externalId === c.b.externalId) || c.nature === "duplicate") { getDoc(c.a.documentId).dup++; hit("duplicate_elements", getDoc(c.a.documentId).doc, c.a.ref, c.id); }
    }
    for (const d of test.documents) {
      if (!d.discipline || d.discipline === "?") hit("unassigned_discipline_documents", `${d.name} · ${d.viewableName}`, `doc ${d.documentId}`, "");
      const twins = test.documents.filter((o) => o.name === d.name && o.lineageUrn !== d.lineageUrn);
      if (twins.length) hit("linked_model_misplacement", `${d.name} · ${d.viewableName}`, `doc ${d.documentId}`, "");
    }
    return {
      byDocument: {
        columns: ["doc", "discipline", "elementsInClashes", "selfClashes", "duplicates", "missingLevel", "missingSystem", "genericTypes"],
        rows: [...perDoc.values()].map((d) => [d.doc, d.discipline, d.elements.size, d.self, d.dup, d.noLevel.size, d.noSystem.size, d.generic.size]),
        total: perDoc.size,
      },
      findings: [...findings.values()]
        .sort((a, b) => b.count - a.count)
        .map((f) => ({ check: f.check, doc: f.doc, count: f.count, examples: f.examples, clashesAffected: [...f.clashes].filter(Boolean).length })),
    };
  }

  // ── proposals ────────────────────────────────────────────────────────────

  private checkTexts(fields: Record<string, string | undefined>): void {
    const problems: string[] = [];
    for (const [k, v] of Object.entries(fields)) if (v) problems.push(...checkAgentText(k, v, { urlAllowlist: this.config.issues.urlAllowlist }));
    if (problems.length) throw new CoordError("validation_error", problems.join("; "));
  }

  /** Every G-/C-/E-/P- id referenced in agent text must exist. */
  private async checkReferencedIds(texts: string[], cls: ClassificationRecord): Promise<void> {
    const refs = referencedIds(texts.join("\n"));
    const groups = new Set(cls.groups.map((g) => g.id));
    const clashes = new Set(cls.clashes.map((c) => c.id));
    const elements = new Set(cls.clashes.flatMap((c) => [c.a.ref, c.b.ref]));
    const missing = [
      ...refs.groups.filter((g) => !groups.has(g)),
      ...refs.clashes.filter((c) => !clashes.has(c.slice(2))),
      ...refs.elements.filter((e) => !elements.has(e)),
    ];
    for (const p of refs.proposals) if (!(await this.store.getProposal(p))) missing.push(p);
    if (missing.length) throw new CoordError("validation_error", `Ids inexistentes en el texto: ${missing.slice(0, 10).join(", ")}`, "Cita solo ids devueltos por las herramientas.");
  }

  private resolveTarget(cls: ClassificationRecord, target: { groupId?: string; clashIds?: string[] }): { groupIds: string[]; clashIds: string[]; clashes: ClashRecord[] } {
    if (target.groupId) {
      const g = cls.groups.find((x) => x.id === target.groupId);
      if (!g) throw new CoordError("not_found", `Grupo ${target.groupId} no existe`, "Usa list_groups.");
      return { groupIds: [g.id], clashIds: [], clashes: cls.clashes.filter((c) => c.groupId === g.id) };
    }
    const ids = (target.clashIds ?? []).map((c) => c.replace(/^C-/, ""));
    const byId = new Map(cls.clashes.map((c) => [c.id, c]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new CoordError("not_found", `Clashes inexistentes: ${missing.slice(0, 10).map((m) => `C-${m}`).join(", ")}`);
    return { groupIds: [], clashIds: ids, clashes: ids.map((id) => byId.get(id)!) };
  }

  private async conflictsWith(testKey: string, clashIds: Set<string>, exclude?: string): Promise<string[]> {
    const { cls } = await this.requireClassified(testKey);
    const groupOf = new Map(cls.clashes.map((c) => [c.id, c.groupId]));
    const out: string[] = [];
    for (const p of await this.store.listProposals((p) => p.testKey === testKey && PENDING_STATES.includes(p.state) && p.id !== exclude)) {
      const theirs = new Set([...p.target.clashIds.map((c) => c.replace(/^C-/, "")), ...cls.clashes.filter((c) => p.target.groupIds.includes(c.groupId)).map((c) => c.id)]);
      for (const id of clashIds) if (theirs.has(id)) { out.push(p.id); break; }
    }
    void groupOf;
    return out;
  }

  private async createAgentProposal(
    args: {
      kind: ProposalKind;
      testKey?: string;
      target: { groupIds: string[]; clashIds: string[] };
      clashes: ClashRecord[];
      payload: ProposalPayload;
      rationale: string;
      evidence: EvidenceItem[];
      confidence: ConfidenceBand;
      risk: Risk;
      supersedes?: string;
    },
    caller: CallerContext,
  ) {
    this.requireLevel(1, "Crear propuestas");
    const { test } = await this.requireClassified(args.testKey);
    if (args.supersedes) {
      const old = await this.store.getProposal(args.supersedes);
      if (!old) throw new CoordError("not_found", `supersedes ${args.supersedes} no existe`);
    }
    const ids = new Set(args.clashes.map((c) => c.id));
    const conflicts = await this.conflictsWith(test.testKey, ids);
    const flagged = [args.rationale, ...args.evidence.map((e) => e.summary)].some((t) => untrusted(t).flagged === "instruction_like");
    const p = await this.store.createProposal({
      kind: args.kind,
      testKey: test.testKey,
      projectId: test.projectId,
      modelSetId: test.modelSetId,
      modelSetVersion: test.modelSetVersion,
      createdBy: caller.actor,
      target: args.target,
      payload: args.payload,
      rationale: args.rationale,
      evidence: args.evidence,
      confidence: args.confidence,
      risk: args.risk,
      affectedClashes: ids.size,
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      ...(flagged ? { flaggedText: true } : {}),
    });
    if (args.supersedes) {
      const old = await this.store.getProposal(args.supersedes);
      if (old && PENDING_STATES.includes(old.state)) await this.store.transitionProposal(old.id, "withdrawn", caller.actor.name, `reemplazada por ${p.id}`);
    }
    await this.store.audit({
      actor: caller.actor,
      action: "proposal.created",
      projectId: test.projectId,
      modelSetId: test.modelSetId,
      testId: test.testId,
      targetIds: [p.id, ...args.target.groupIds],
      details: { kind: p.kind, risk: p.risk, clashes: ids.size, flagged },
    });
    return {
      proposalId: p.id,
      kind: p.kind,
      status: p.state,
      risk: p.risk,
      affectedClashes: ids.size,
      conflictsWith: conflicts,
      reviewUrl: this.reviewUrl(p.id),
    };
  }

  async proposeClassification(
    input: {
      testKey?: string; target: { groupId?: string; clashIds?: string[] }; validity: Validity; severity?: Severity; responsibleDiscipline?: string;
      secondaryDiscipline?: string; rootCause?: string; suggestedAction?: string; ruleId?: string; disagreesWithEngine: boolean; rationale: string; evidence: EvidenceItem[]; confidence: ConfidenceBand; supersedes?: string;
    },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    this.requireLevel(1, "propose_classification");
    const { cls } = await this.requireClassified(input.testKey);
    this.checkTexts({ rationale: input.rationale, ...Object.fromEntries(input.evidence.map((e, i) => [`evidence[${i}]`, e.summary])) });
    await this.checkReferencedIds([input.rationale, ...input.evidence.map((e) => `${e.ref} ${e.summary}`)], cls);
    const t = this.resolveTarget(cls, input.target);
    const engineValidities = new Set(t.clashes.map((c) => c.validity));
    const groupsT = cls.groups.filter((g) => t.clashes.some((c) => c.groupId === g.id));
    const differs =
      engineValidities.size !== 1 ||
      !engineValidities.has(input.validity) ||
      (input.severity !== undefined && t.clashes.some((c) => c.severity !== input.severity)) ||
      (input.responsibleDiscipline !== undefined && groupsT.some((g) => g.responsibleDiscipline !== input.responsibleDiscipline));
    if (differs && !input.disagreesWithEngine) {
      throw new CoordError("validation_error", `La propuesta difiere del motor (validez ${[...engineValidities].join(", ")}, severidad o responsable); marca disagreesWithEngine=true.`);
    }
    if (input.ruleId && !t.clashes.some((c) => c.ruleId === input.ruleId?.replace(/^R-/, "")) && !groupsT.some((g) => g.ruleIds.includes(input.ruleId!.replace(/^R-/, "")))) {
      throw new CoordError("validation_error", `La regla ${input.ruleId} no aplica a este objetivo.`);
    }
    if (differs && input.evidence.length === 0) throw new CoordError("validation_error", "Para discrepar del motor incluye al menos una evidencia.");
    const risk: Risk = input.disagreesWithEngine || input.severity === "critical" || input.validity === "needs_info" ? "high" : "medium";
    return this.createAgentProposal(
      {
        kind: "classification",
        testKey: input.testKey,
        target: { groupIds: t.groupIds, clashIds: t.clashIds },
        clashes: t.clashes,
        payload: {
          kind: "classification",
          validity: input.validity,
          ...(input.severity ? { severity: input.severity } : {}),
          ...(input.responsibleDiscipline ? { responsibleDiscipline: input.responsibleDiscipline } : {}),
          ...(input.secondaryDiscipline ? { secondaryDiscipline: input.secondaryDiscipline } : {}),
          ...(input.rootCause ? { rootCause: input.rootCause } : {}),
          ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
          ...(input.ruleId ? { ruleId: input.ruleId.replace(/^R-/, "") } : {}),
          disagreesWithEngine: input.disagreesWithEngine,
        },
        rationale: input.rationale,
        evidence: input.evidence,
        confidence: input.confidence,
        risk,
        supersedes: input.supersedes,
      },
      caller,
    );
  }

  async proposeGroupAction(
    input: { testKey?: string; action: { type: string } & Record<string, unknown>; rationale: string; evidence: EvidenceItem[]; confidence: ConfidenceBand; supersedes?: string },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    this.requireLevel(1, "propose_group_action");
    const { cls } = await this.requireClassified(input.testKey);
    this.checkTexts({ rationale: input.rationale, companyRole: input.action.companyRole as string | undefined });
    await this.checkReferencedIds([input.rationale], cls);
    const a = input.action;
    const groupIds = [a.groupId as string | undefined, a.toGroupId as string | undefined, ...((a.groupIds as string[] | undefined) ?? [])].filter((x): x is string => !!x);
    const clashIds = [...((a.clashIds as string[] | undefined) ?? []), ...(((a.partitions as string[][] | undefined) ?? []).flat())];
    const knownG = new Set(cls.groups.map((g) => g.id));
    const missingG = groupIds.filter((g) => !knownG.has(g));
    if (missingG.length) throw new CoordError("not_found", `Grupos inexistentes: ${missingG.join(", ")}`);
    const t = clashIds.length ? this.resolveTarget(cls, { clashIds }) : { clashes: [] as ClashRecord[] };
    if (a.type === "split") {
      const inGroup = new Set(cls.clashes.filter((c) => c.groupId === a.groupId).map((c) => c.id));
      const outside = clashIds.map(bareClashId).filter((c) => !inGroup.has(c));
      if (outside.length) throw new CoordError("validation_error", `Clashes fuera del grupo ${String(a.groupId)}: ${outside.slice(0, 5).join(", ")}`);
    }
    const clashes = [...t.clashes, ...cls.clashes.filter((c) => groupIds.includes(c.groupId))];
    return this.createAgentProposal(
      {
        kind: "group_action",
        testKey: input.testKey,
        target: { groupIds: [...new Set(groupIds)], clashIds },
        clashes,
        payload: { kind: "group_action", action: a },
        rationale: input.rationale,
        evidence: input.evidence,
        confidence: input.confidence,
        risk: "medium",
        supersedes: input.supersedes,
      },
      caller,
    );
  }

  async draftIssue(
    input: {
      testKey?: string; groupId: string; kind?: "coordination" | "hygiene"; title: string; description: string; responsibleDiscipline: string;
      secondaryDiscipline?: string; assigneeRole?: string; priorityHint: "P1" | "P2" | "P3" | "P4"; linkClashIds?: string[]; viewpointClashId?: string;
      rationale: string; evidence: EvidenceItem[]; confidence: ConfidenceBand; supersedes?: string;
    },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    this.requireLevel(1, "draft_issue");
    const { cls } = await this.requireClassified(input.testKey);
    this.checkTexts({ title: input.title, description: input.description, rationale: input.rationale, assigneeRole: input.assigneeRole });
    await this.checkReferencedIds([input.title, input.description, input.rationale], cls);
    const t = this.resolveTarget(cls, { groupId: input.groupId });
    const g = cls.groups.find((x) => x.id === input.groupId)!;
    if ((input.kind ?? "coordination") === "coordination" && g.validity !== "real") {
      const agentReal = (await this.store.listProposals((p) => p.payload.kind === "classification" && p.target.groupIds.includes(g.id) && PENDING_STATES.includes(p.state))).some(
        (p) => p.payload.kind === "classification" && p.payload.validity === "real",
      );
      if (!agentReal) throw new CoordError("validation_error", `El grupo ${g.id} es ${g.validity}; una incidencia de coordinación requiere validez real (o kind=hygiene).`, "Propón primero la clasificación real con propose_classification.");
    }
    const inGroup = new Set(t.clashes.map((c) => c.id));
    const link = (input.linkClashIds ?? []).map(bareClashId);
    const vp = input.viewpointClashId ? bareClashId(input.viewpointClashId) : undefined;
    for (const c of [...link, ...(vp ? [vp] : [])]) {
      if (!inGroup.has(c)) throw new CoordError("validation_error", `${c} no pertenece al grupo ${input.groupId}`);
    }
    const existing = await this.store.listProposals((p) => p.kind === "issue_draft" && p.target.groupIds.includes(input.groupId) && PENDING_STATES.includes(p.state) && p.id !== input.supersedes);
    if (existing.length) throw new CoordError("conflict", `El grupo ya tiene un borrador de incidencia pendiente (${existing[0].id}).`, "Usa supersedes para reemplazarlo.");
    return this.createAgentProposal(
      {
        kind: "issue_draft",
        testKey: input.testKey,
        target: { groupIds: [input.groupId], clashIds: [] },
        clashes: t.clashes,
        payload: {
          kind: "issue_draft",
          issue: {
            title: input.title,
            description: input.description,
            responsibleDiscipline: input.responsibleDiscipline,
            ...(input.secondaryDiscipline ? { secondaryDiscipline: input.secondaryDiscipline } : {}),
            ...(input.assigneeRole ? { assigneeRole: input.assigneeRole } : {}),
            issueKind: input.kind ?? "coordination",
            priorityHint: input.priorityHint,
            ...(link.length ? { linkClashIds: link } : {}),
            ...(vp ? { viewpointClashId: vp } : {}),
          },
        },
        rationale: input.rationale,
        evidence: input.evidence,
        confidence: input.confidence,
        risk: "high",
        supersedes: input.supersedes,
      },
      caller,
    );
  }

  async proposeStatusChange(
    input: {
      testKey?: string; target: { groupId?: string; clashIds?: string[] }; action: "close_not_issue" | "mark_reviewed" | "reopen"; accReason?: string;
      closedGroupIds?: string[]; rationale: string; evidence: EvidenceItem[]; confidence: ConfidenceBand; supersedes?: string;
    },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    this.requireLevel(1, "propose_status_change");
    const { cls } = await this.requireClassified(input.testKey);
    this.checkTexts({ rationale: input.rationale });
    await this.checkReferencedIds([input.rationale], cls);
    const t = this.resolveTarget(cls, input.target);
    let risk: Risk = "medium";
    if (input.action !== "reopen") {
      if (!this.config.classification.llmMayClose.includes(input.action)) {
        throw new CoordError("autonomy_level_forbids", `La acción ${input.action} no está permitida para el agente (classification.llmMayClose).`);
      }
      const blocked = t.clashes.filter((c) => c.validity === "real" || c.validity === "needs_info");
      if (blocked.length) {
        throw new CoordError("validation_error", `No se puede proponer ${input.action} para ${blocked.length} interferencias de validez ${blocked[0].validity}; las reales se redactan como incidencia y needs_info se escala.`);
      }
      const groupIds = new Set(t.clashes.map((c) => c.groupId));
      const agentReal = (await this.store.listProposals((p) => p.payload.kind === "classification" && PENDING_STATES.includes(p.state) && p.target.groupIds.some((g) => groupIds.has(g)))).find(
        (p) => p.payload.kind === "classification" && (p.payload.validity === "real" || p.payload.validity === "needs_info"),
      );
      if (agentReal) throw new CoordError("validation_error", `La propuesta ${agentReal.id} clasifica estas interferencias como no cerrables; retírala primero.`);
      const safety = t.clashes.some((c) => (c.tags ?? []).includes("seguridad_personas"));
      risk = t.clashes.length > 50 || safety ? "high" : t.clashes.every((c) => c.confidence >= 0.9) ? "low" : "medium";
    } else {
      if (!input.closedGroupIds?.length) throw new CoordError("validation_error", "reopen requiere closedGroupIds (ids de grupos cerrados en ACC, 1..20).");
      risk = "high";
    }
    return this.createAgentProposal(
      {
        kind: "status_change",
        testKey: input.testKey,
        target: { groupIds: t.groupIds, clashIds: t.clashIds },
        clashes: t.clashes,
        payload: {
          kind: "status_change",
          action: input.action,
          ...(input.accReason ? { accReason: input.accReason } : {}),
          ...(input.closedGroupIds?.length ? { closedGroupIds: input.closedGroupIds } : {}),
        },
        rationale: input.rationale,
        evidence: input.evidence,
        confidence: input.confidence,
        risk,
        supersedes: input.supersedes,
      },
      caller,
    );
  }

  async proposeRuleChange(
    input: { title: string; patch: string; rationale: string; feedbackIds: string[]; evaluation: Record<string, number>; scope: "project" | "company" },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    this.requireLevel(1, "propose_rule_change");
    this.checkTexts({ title: input.title, rationale: input.rationale });
    const files = patchTargets(input.patch);
    if (files.length === 0) throw new CoordError("validation_error", "El patch no tiene cabeceras de archivo (unified diff).");
    const bad = files.filter((f) => !/^rules\/[A-Za-z0-9_./-]+\.ya?ml$/.test(f) || f.includes(".."));
    if (bad.length) throw new CoordError("validation_error", `El patch solo puede tocar rules/**.yaml: ${bad.join(", ")}`);
    const known = new Set((await this.store.listFeedback()).map((f) => f.id));
    const unknown = input.feedbackIds.filter((f) => !known.has(f));
    if (unknown.length) throw new CoordError("not_found", `feedbackIds inexistentes: ${unknown.slice(0, 5).join(", ")}`);
    // Validate that the patch applies and the candidate rules load.
    await this.candidateRulesDir(Promise.resolve(input.patch));
    const ctx = await this.store.getContext();
    const p = await this.store.createProposal({
      kind: "rule_change",
      projectId: ctx?.projectId,
      createdBy: caller.actor,
      target: { groupIds: [], clashIds: [] },
      payload: { kind: "rule_change", title: input.title, patchFile: "", patchHash: sha256(input.patch), feedbackIds: input.feedbackIds, evaluation: input.evaluation, scope: input.scope },
      rationale: input.rationale,
      evidence: [],
      confidence: "media",
      risk: "high",
      affectedClashes: 0,
    });
    const file = await this.store.writeRulePatch(p.id, input.patch);
    await this.store.updateProposal(p.id, (x) => {
      if (x.payload.kind === "rule_change") x.payload.patchFile = file;
    });
    await this.store.audit({ actor: caller.actor, action: "rule.suggested", projectId: ctx?.projectId, targetIds: [p.id], details: { files: files.join(","), scope: input.scope } });
    return { proposalId: p.id, kind: p.kind, status: p.state, risk: p.risk, affectedClashes: 0, conflictsWith: [], reviewUrl: this.reviewUrl(p.id), patchPath: file };
  }

  async listProposals(input: { testKey?: string; status?: string[]; kind?: string[]; ids?: string[]; createdBy?: "agent" | "coordinator" | "any"; limit: number; cursor?: string }) {
    const ctx = await this.store.getContext();
    const testKey = input.testKey ?? (input.ids?.length ? undefined : ctx?.testKey);
    const STATUS_ALIAS: Record<string, string[]> = { pending: ["draft", "pending_review"], superseded: ["withdrawn"], applying: ["approved"] };
    const status = input.status?.flatMap((x) => STATUS_ALIAS[x] ?? [x]);
    const kind = input.kind?.map((k) => (k === "issue" ? "issue_draft" : k));
    const all = await this.store.listProposals();
    const counts = Object.fromEntries(["draft", "pending_review", "approved", "rejected", "withdrawn", "applied", "failed"].map((s) => [s, 0])) as Record<ProposalState, number>;
    const rows = all.filter((p) => {
      if (testKey && p.testKey !== testKey && p.kind !== "rule_change") return false;
      if (input.ids?.length && !input.ids.includes(p.id)) return false;
      if (kind?.length && !kind.includes(p.kind)) return false;
      if (input.createdBy === "agent" && p.createdBy.type !== "agent" && p.createdBy.type !== "engine") return false;
      if (input.createdBy === "coordinator" && p.createdBy.type !== "user") return false;
      counts[p.state]++;
      if (status?.length && !status.includes(p.state)) return false;
      return true;
    });
    const page = paginate(rows.reverse(), input.limit, input.cursor);
    return {
      columns: ["proposalId", "kind", "status", "target", "summary", "risk", "createdAt", "decidedBy"],
      rows: page.items.map((p) => [
        p.id,
        p.kind,
        p.state,
        p.target.groupIds.length === 1 ? p.target.groupIds[0] : p.target.groupIds.length ? `${p.target.groupIds.length} grupos` : `${p.affectedClashes} clashes`,
        proposalSummary(p).slice(0, 80),
        p.risk,
        p.createdAt,
        p.history.filter((h) => h.to === "approved" || h.to === "rejected").pop()?.by ?? null,
      ]),
      total: page.total,
      nextCursor: page.nextCursor,
      counts,
    };
  }

  async withdrawProposal(input: { proposalId: string; reason: string }, caller: CallerContext = { actor: AGENT_ACTOR }) {
    this.requireLevel(1, "withdraw_proposal");
    this.checkTexts({ reason: input.reason });
    const p = await this.store.getProposal(input.proposalId);
    if (!p) throw new CoordError("not_found", `Propuesta ${input.proposalId} no existe`);
    if (caller.actor.type === "agent" && p.createdBy.type !== "agent") throw new CoordError("forbidden", "Solo puedes retirar propuestas creadas por el agente.");
    if (!PENDING_STATES.includes(p.state)) throw new CoordError("invalid_state", `La propuesta está en estado ${p.state}; solo se retiran propuestas pendientes.`);
    await this.store.transitionProposal(p.id, "withdrawn", caller.actor.name, input.reason);
    await this.store.audit({ actor: caller.actor, action: "proposal.updated", projectId: p.projectId, testId: p.testKey, targetIds: [p.id], details: { state: "withdrawn" } });
    return { proposalId: p.id, status: "withdrawn" as const };
  }

  // ── feedback ─────────────────────────────────────────────────────────────

  async snapshotFor(target: { proposalId?: string; groupId?: string; testKey?: string }): Promise<{ snapshot?: FeatureSnapshot; projectId?: string; testKey?: string }> {
    let testKey = target.testKey;
    let groupIds: string[] = target.groupId ? [target.groupId] : [];
    if (target.proposalId) {
      const p = await this.store.getProposal(target.proposalId);
      if (!p) throw new CoordError("not_found", `Propuesta ${target.proposalId} no existe`);
      testKey = p.testKey;
      groupIds = p.target.groupIds;
      if (!testKey) return { projectId: p.projectId };
    }
    const b = await this.loadTest(testKey).catch(() => undefined);
    if (!b?.cls) return { projectId: b?.test.projectId, testKey: b?.test.testKey };
    const g = b.cls.groups.find((x) => groupIds.includes(x.id));
    if (target.groupId && !g) throw new CoordError("not_found", `Grupo ${target.groupId} no existe`);
    if (!g) return { projectId: b.test.projectId, testKey: b.test.testKey };
    return {
      projectId: b.test.projectId,
      testKey: b.test.testKey,
      snapshot: {
        disciplinePair: g.disciplinePair,
        categoryPair: g.categoryPair,
        penetrationBucket: penBucket(g.maxPenetrationMm),
        ruleIds: g.ruleIds,
        engine: { validity: g.validity, severity: g.severity, confidence: g.confidence },
        strategy: g.engineStrategy,
        clashCount: g.clashIds.length,
      },
    };
  }

  async recordFeedback(
    input: {
      target: { proposalId?: string; groupId?: string; testKey?: string };
      verdict: "correct" | "incorrect" | "partially_correct";
      corrected?: Record<string, unknown>;
      coordinatorStatement: string;
      generalizable: "yes" | "no" | "unsure";
      scope: "this_group" | "project" | "company";
      reasonCode?: string;
    },
    caller: CallerContext = { actor: AGENT_ACTOR },
    source: FeedbackRecord["source"] = "agent",
  ) {
    this.checkTexts({ coordinatorStatement: input.coordinatorStatement });
    const snap = await this.snapshotFor(input.target);
    const id = await this.store.newFeedbackId();
    const rec: FeedbackRecord = {
      id,
      at: nowIso(this.now()),
      projectId: snap.projectId,
      testKey: snap.testKey,
      target: { ...(input.target.proposalId ? { proposalId: input.target.proposalId } : {}), ...(input.target.groupId ? { groupId: input.target.groupId } : {}) },
      verdict: input.verdict,
      ...(input.corrected ? { corrected: input.corrected } : {}),
      coordinatorStatement: input.coordinatorStatement,
      generalizable: input.generalizable,
      scope: input.scope,
      source,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(snap.snapshot ? { snapshot: snap.snapshot } : {}),
      curated: false,
    };
    await this.store.appendFeedback(rec);
    await this.store.audit({ actor: caller.actor, action: "feedback.recorded", projectId: snap.projectId, targetIds: [id], details: { verdict: input.verdict, generalizable: input.generalizable } });
    const pending = (await this.store.listFeedback()).filter((f) => !f.curated).length;
    return { feedbackId: id, featureSnapshotStored: !!snap.snapshot, pendingForCuration: pending };
  }

  async listFeedback(input: { since?: string; projectId?: string; aggregate: "none" | "by_rule" | "by_signature"; onlyUncurated: boolean; limit: number; cursor?: string }): Promise<Table> {
    let fb = await this.store.listFeedback();
    if (input.since) fb = fb.filter((f) => f.at >= input.since!);
    if (input.projectId) fb = fb.filter((f) => f.projectId && bareProjectId(f.projectId) === bareProjectId(input.projectId!));
    if (input.onlyUncurated) fb = fb.filter((f) => !f.curated);
    if (input.aggregate === "none") {
      const page = paginate(fb, input.limit, input.cursor);
      return {
        columns: ["feedbackId", "at", "verdict", "engineValidity", "correctedValidity", "disciplinePair", "categoryPair", "rules", "statement"],
        rows: page.items.map((f) => [f.id, f.at, f.verdict, f.snapshot?.engine?.validity ?? "", String(f.corrected?.validity ?? ""), f.snapshot?.disciplinePair ?? "", f.snapshot?.categoryPair ?? "", (f.snapshot?.ruleIds ?? []).join(" "), untrusted(f.coordinatorStatement).untrusted]),
        total: page.total,
        nextCursor: page.nextCursor,
      };
    }
    const clusters = new Map<string, { sig: string; count: number; projects: Set<string>; ev: string; cv: string; rules: Set<string>; ids: string[] }>();
    for (const f of fb) {
      const ev = f.snapshot?.engine?.validity ?? "?";
      const cv = String(f.corrected?.validity ?? (f.verdict === "correct" ? ev : "?"));
      const sig =
        input.aggregate === "by_rule"
          ? f.snapshot?.ruleIds?.[0] ?? "(sin regla)"
          : `${f.snapshot?.categoryPair ?? "?"}|${f.snapshot?.disciplinePair ?? "?"}|${ev}→${cv}|${f.snapshot?.penetrationBucket ?? "?"}`;
      const c = clusters.get(sig) ?? { sig, count: 0, projects: new Set(), ev, cv, rules: new Set(), ids: [] };
      c.count++;
      if (f.projectId) c.projects.add(bareProjectId(f.projectId));
      for (const r of f.snapshot?.ruleIds ?? []) c.rules.add(r);
      c.ids.push(f.id);
      clusters.set(sig, c);
    }
    const rows = [...clusters.values()].sort((a, b) => b.count - a.count || a.sig.localeCompare(b.sig));
    const page = paginate(rows, input.limit, input.cursor);
    return {
      columns: ["signature", "count", "projects", "engineValidity", "correctedValidity", "rulesInvolved", "exampleFeedbackIds"],
      rows: page.items.map((c) => [c.sig, c.count, c.projects.size, c.ev, c.cv, [...c.rules].slice(0, 5).join(" "), c.ids.slice(0, 5).join(" ")]),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  // ── evaluation ───────────────────────────────────────────────────────────

  /** Apply a unified diff to a temp copy of rules/ and return its directory (validates loading). */
  async candidateRulesDir(patchP: Promise<string>): Promise<string> {
    const patch = await patchP;
    const { mkdtemp, readdir, readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "coord-rules-"));
    const rulesDir = join(this.root, "rules");
    for (const f of await readdir(rulesDir)) {
      if (/\.ya?ml$/.test(f)) await writeFile(join(dir, f), await readFile(join(rulesDir, f)));
    }
    for (const filePatch of splitPatch(patch)) {
      const rel = filePatch.file.replace(/^rules\//, "");
      const target = join(dir, rel);
      const before = (await readFile(target, "utf8").catch(() => "")) ?? "";
      const after = applyUnifiedPatch(before, filePatch.hunks);
      if (after === undefined) throw new CoordError("validation_error", `El patch no aplica limpiamente sobre rules/${rel}.`);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, after);
    }
    try {
      const { loadRules } = await import("./engine");
      loadRules(dir);
    } catch (err) {
      throw new CoordError("validation_error", `Las reglas candidatas no cargan: ${(err as Error).message.slice(0, 600)}`);
    }
    return dir;
  }

  /**
   * Evaluate the current rules (and optionally a candidate patch applied to a temp
   * copy of rules/; rules/ itself is never touched).
   * Suites: eval_scenarios (EV-xx of docs/domain/eval-scenarios.md, exact-match fields),
   * fixtures (v41→v42 diff vs tests/fixtures/fixture-truth.json), feedback_replay
   * (the project's human decisions and feedback replayed on cached tests).
   */
  async evaluateRuleset(input: { candidatePatch?: string; suites: Array<"eval_scenarios" | "fixtures" | "feedback_replay"> }) {
    const { loadRules } = await import("./engine");
    const { evaluateScenarios, parseScenarioMarkdown } = await import("../core/eval/scenarios");
    const { readFile } = await import("node:fs/promises");
    const schemaErrors: string[] = [];
    let candidateDir: string | undefined;
    if (input.candidatePatch) {
      try {
        candidateDir = await this.candidateRulesDir(Promise.resolve(input.candidatePatch));
      } catch (err) {
        schemaErrors.push((err as Error).message);
      }
    }
    const scenarios = input.suites.includes("eval_scenarios")
      ? parseScenarioMarkdown(await readFile(join(this.root, "docs", "domain", "eval-scenarios.md"), "utf8"))
      : [];
    const diffAccuracy = input.suites.includes("fixtures") ? await this.fixtureDiffAccuracy().catch(() => undefined) : undefined;

    const metricsFor = async (dir?: string) => {
      const rs = loadRules(dir);
      const pairs: Array<{ id: string; expected: string; got: string }> = [];
      const fieldResults = new Map<string, boolean>();
      let exact = 0;
      let asserted = 0;
      let correct = 0;
      let criticalFalseNegatives = 0;
      if (scenarios.length) {
        const rep = evaluateScenarios(rs, scenarios);
        exact = rep.passed;
        for (const f of Object.values(rep.fieldAccuracy)) {
          asserted += f.asserted;
          correct += f.correct;
        }
        for (const r of rep.results) {
          const exp = r.scenario.expected;
          if (typeof exp.validity === "string") pairs.push({ id: r.scenario.id, expected: exp.validity, got: String(r.actual.validity) });
          for (const k of Object.keys(exp)) if (k in r.actual) fieldResults.set(`${r.scenario.id}/${k}`, !r.diffs.some((d) => d.field === k));
          if (exp.severity === "critical" && (!["critical", "high"].includes(String(r.actual.severity)) || r.actual.validity !== "real")) criticalFalseNegatives++;
        }
      }
      let replayN = 0;
      let replayAgree = 0;
      if (input.suites.includes("feedback_replay")) {
        for (const t of await this.store.listTests()) {
          const decisions = await this.effectiveDecisions(t.testKey);
          const fb = (await this.store.listFeedback()).filter((f) => f.testKey === t.testKey && f.target.groupId && f.corrected?.validity);
          if (decisions.size === 0 && fb.length === 0) continue;
          const cls = await this.store.getClassification(t.testKey);
          const raw = cls ? await this.loadRaw(t).catch(() => undefined) : undefined;
          if (!cls || !raw) continue;
          const out = runEngine({ clashes: raw.clashes, elements: raw.elements, documents: raw.documents, config: this.config, rules: rs });
          const newValidity = new Map(out.clashes.map((c) => [c.id, c.validity]));
          const expectFor = new Map<string, string>();
          for (const [gid, d] of decisions) {
            const g = cls.groups.find((x) => x.id === gid);
            if (!g || (d.kind !== "accept" && d.kind !== "correct" && d.kind !== "reject")) continue;
            const vc = d.changes.find((c) => c.field === "validity");
            if (d.kind === "accept" || (d.kind === "correct" && !vc)) expectFor.set(gid, g.validity);
            else if (vc) expectFor.set(gid, normalizeValidity(String(vc.humanValue)));
          }
          for (const f of fb) expectFor.set(f.target.groupId!, normalizeValidity(String(f.corrected!.validity)));
          for (const [gid, expected] of expectFor) {
            const g = cls.groups.find((x) => x.id === gid)!;
            const got = dominantOf(g.clashIds.map((id) => newValidity.get(id)).filter((v): v is Validity => !!v)) ?? "needs_info";
            replayN++;
            if (got === expected) replayAgree++;
            pairs.push({ id: `${t.testKey}/${gid}`, expected, got });
            fieldResults.set(`${t.testKey}/${gid}/validity`, got === expected);
          }
        }
      }
      const base = classificationMetrics(pairs, replayN ? replayAgree / replayN : 1);
      return {
        metrics: {
          scenariosExactMatch: exact,
          rubricScore: asserted ? round((correct / asserted) * 100, 1) : 100,
          validityAccuracy: base.validityAccuracy,
          macroF1: base.macroF1,
          unsafeClosureRate: base.unsafeClosureRate,
          criticalFalseNegatives,
          ...(diffAccuracy !== undefined ? { diffAccuracy } : {}),
          ...(replayN ? { feedbackReplayAgreement: base.feedbackReplayAgreement } : {}),
        },
        fieldResults,
        pairs,
      };
    };

    const baseline = await metricsFor();
    const candidate = candidateDir ? await metricsFor(candidateDir) : undefined;
    const regressions: Array<{ scenario: string; field: string; expected: string; got: string }> = [];
    if (candidate) {
      const got = new Map(candidate.pairs.map((p) => [p.id, p]));
      for (const [k, ok] of baseline.fieldResults) {
        if (!ok || candidate.fieldResults.get(k) !== false || regressions.length >= 20) continue;
        const parts = k.split("/");
        const field = parts.pop()!;
        const scenario = parts.join("/");
        const p = got.get(scenario);
        regressions.push({ scenario, field, expected: field === "validity" && p ? p.expected : "(base ok)", got: field === "validity" && p ? p.got : "(distinto)" });
      }
    }
    return {
      baseline: baseline.metrics,
      ...(candidate ? { candidate: candidate.metrics } : {}),
      regressions,
      schemaErrors,
      cases: baseline.pairs.length,
    };
  }

  /** Diff accuracy of v41→v42 fixtures vs fixture-truth.json (independent of the store). */
  private async fixtureDiffAccuracy(): Promise<number | undefined> {
    const { readFile } = await import("node:fs/promises");
    const dir = join(this.root, "tests", "fixtures");
    const truth = JSON.parse(await readFile(join(dir, "fixture-truth.json"), "utf8")) as {
      modelSetId: string;
      tests: Record<string, string>;
      expectedDiff: Record<"new" | "persisting" | "resolved" | "element_deleted" | "reappeared", string[]>;
    };
    const src = new FixtureSource({ home: this.store.home, dir });
    const [prev, next] = await Promise.all(["41", "42"].map((v) => src.fetchTest("b.demo-proyecto", truth.modelSetId, truth.tests[v]!, { fetchProperties: true })));
    const history = JSON.parse(await readFile(join(dir, "mc", "history-v40-clash-ids.json"), "utf8")) as string[] | { clashIds?: string[]; pairKeys?: string[] };
    const hist = Array.isArray(history) ? history : [...(history.clashIds ?? []), ...(history.pairKeys ?? [])];
    const diff = diffTestVersions(prev!.clashes, next!.clashes, { history: hist, nextElementKeys: next!.allElementKeys });
    const states = ["new", "persisting", "resolved", "element_deleted", "reappeared"] as const;
    let total = 0;
    let ok = 0;
    for (const st of states) {
      const want = new Set(truth.expectedDiff[st]);
      total += want.size;
      ok += diff[st].filter((id) => want.has(id)).length;
    }
    return total ? round(ok / total, 4) : undefined;
  }

  // ── reports ──────────────────────────────────────────────────────────────

  async generateReport(
    input: { kind: "weekly" | "test_summary" | "hygiene" | "proposals_digest"; testKey?: string; compareWithTestKey?: string; format: "md" | "html" | "xlsx"; narrative?: string; language: "es" | "en" },
    caller: CallerContext = { actor: AGENT_ACTOR },
  ) {
    if (input.format === "xlsx") throw new CoordError("validation_error", "Formato xlsx no soportado en v1; usa md o html.");
    if (input.narrative) this.checkTexts({ narrative: input.narrative });
    const { test, cls } = await this.requireClassified(input.testKey);
    const headline: Record<string, number> = {
      clashes: cls.clashes.length,
      groups: cls.groups.length,
      real: cls.clashes.filter((c) => c.validity === "real").length,
      needsReview: cls.groups.filter((g) => g.reviewState === "needs_review").length,
      critical: cls.groups.filter((g) => g.severity === "critical").length,
      maxPenetrationMm: round(Math.max(0, ...cls.clashes.map((c) => c.penetrationMm))),
    };
    const sections: string[] = [];
    const lines: string[] = [];
    const title = { weekly: "Informe semanal de coordinación", test_summary: "Resumen del test", hygiene: "Higiene de modelos", proposals_digest: "Resumen de propuestas" }[input.kind];
    lines.push(`# ${title}`, "", `Proyecto: ${test.projectName} · Conjunto: ${test.modelSetName} v${test.modelSetVersion} · Test ${test.testKey}`, "");
    if (input.narrative) {
      sections.push("Resumen ejecutivo");
      lines.push("## Resumen ejecutivo", "", input.narrative, "");
    }
    sections.push("Cifras");
    lines.push("## Cifras", "", "| Indicador | Valor |", "|---|---|", ...Object.entries(headline).map(([k, v]) => `| ${k} | ${v} |`), "");
    const pairs = await this.summarize({ testKey: test.testKey, groupBy: ["disciplinePair", "validity"], unit: "clashes", topN: 15 });
    sections.push("Por par de disciplinas");
    lines.push("## Por par de disciplinas", "", `| ${pairs.columns.join(" | ")} |`, `|${pairs.columns.map(() => "---").join("|")}|`, ...pairs.rows.map((r) => `| ${r.join(" | ")} |`), "");
    if (input.compareWithTestKey || (input.kind === "weekly" && test.previousTestKey)) {
      const base = input.compareWithTestKey ?? test.previousTestKey!;
      const d = await this.diffVersions({ baseTestKey: base, targetTestKey: test.testKey, groupBy: "disciplinePair", topPersisting: 10 }).catch(() => undefined);
      if (d) {
        Object.assign(headline, { new: d.totals.new, resolved: d.totals.resolved, persisting: d.totals.persisting, reappeared: d.totals.reappeared, elementDeleted: d.totals.elementDeleted });
        sections.push("Evolución");
        lines.push("## Evolución vs versión anterior", "", `Nuevas ${d.totals.new} · Resueltas ${d.totals.resolved} · Persistentes ${d.totals.persisting} · Reaparecidas ${d.totals.reappeared} · Elementos eliminados ${d.totals.elementDeleted}`, "");
      }
    }
    if (input.kind === "hygiene") {
      const h = await this.hygieneStats({ testKey: test.testKey, examplesPerCheck: 3 });
      sections.push("Hallazgos de higiene");
      lines.push("## Hallazgos de higiene", "", ...h.findings.slice(0, 15).map((f) => `- ${f.check} · ${f.doc} · ${f.count} elementos · ${f.clashesAffected} interferencias`), "");
    }
    if (input.kind === "proposals_digest" || input.kind === "weekly") {
      const ps = await this.listProposals({ testKey: test.testKey, limit: 50, createdBy: "any" });
      sections.push("Propuestas");
      lines.push("## Propuestas", "", ...Object.entries(ps.counts).filter(([, n]) => n).map(([s, n]) => `- ${s}: ${n}`), "");
      for (const [s, n] of Object.entries(ps.counts)) headline[`proposals_${s}`] = n;
    }
    const md = lines.join("\n");
    const content = input.format === "md" ? md : markdownToHtml(md, title);
    const name = `${nowIso(this.now()).slice(0, 10)}-${input.kind}-${test.testKey}.${input.format}`;
    const path = await this.store.writeReport(test.projectId, name, content);
    await this.store.audit({ actor: caller.actor, action: "report.generated", projectId: test.projectId, testId: test.testId, details: { kind: input.kind, format: input.format } });
    return { path, headline, sections };
  }

  // ── notes ────────────────────────────────────────────────────────────────

  async getNotes(projectId?: string) {
    const pid = await this.ctxProject(projectId);
    const text = (await this.store.readNotes(pid)) ?? "";
    return { projectId: pid, path: this.store.notesPath(pid), text, lines: text ? text.split("\n").length : 0 };
  }

  /** Append a dated note (human channel: UI / CLI). */
  async appendNote(input: { projectId?: string; text: string; kind?: string }, caller: CallerContext) {
    this.checkTexts({ note: input.text });
    const pid = await this.ctxProject(input.projectId);
    const line = `- ${nowIso(this.now()).slice(0, 10)} · [${input.kind ?? "convención"}] ${input.text.replace(/\s+/g, " ").trim()} (confirmado por ${caller.actor.name})`;
    await this.store.appendNote(pid, line);
    await this.store.audit({ actor: caller.actor, action: "notes.appended", projectId: pid, details: { chars: input.text.length } });
    return this.getNotes(pid);
  }
}

/// ── pure helpers ────────────────────────────────────────────────────────────

/** Value of a summary dimension for a group. */
export function groupDim(g: GroupRecord, d: string): string {
  switch (d) {
    case "disciplinePair": return g.disciplinePair;
    case "categoryPair": return g.categoryPair;
    case "triageState": return g.triageState;
    case "status": return g.accStatus;
    case "validity": return g.validity;
    case "nature": return g.nature;
    case "severity": return g.severity;
    case "band": return g.bandName;
    case "level": return g.levels[0] ?? "(sin nivel)";
    case "responsibleDiscipline": return g.responsibleDiscipline;
    case "rootCause": return g.rootCause ?? "(sin causa)";
    case "suggestedAction": return g.suggestedAction ?? "(sin acción)";
    case "ruleId": return g.ruleIds[0] ?? "(sin regla)";
    case "confidenceBand": return g.confidenceBand;
    case "diffState": return g.delta;
    case "documentPair": return "(n/a)";
    default: return "?";
  }
}

/** Value of a summary dimension for a clash (group-level dims fall back to its group). */
export function clashDim(c: ClashRecord, g: GroupRecord, d: string): string {
  switch (d) {
    case "disciplinePair": return c.disciplinePair;
    case "categoryPair": return c.categoryPair;
    case "documentPair": return sortPair(c.a.modelName, c.b.modelName);
    case "triageState": return c.triageState;
    case "status": return c.status;
    case "validity": return c.validity;
    case "nature": return c.nature;
    case "severity": return c.severity;
    case "level": return c.level ?? "(sin nivel)";
    case "suggestedAction": return c.suggestedAction ?? "(sin acción)";
    case "ruleId": return c.ruleId ?? "(sin regla)";
    case "diffState": return c.delta;
    default: return groupDim(g, d);
  }
}

/** Strip an optional `C-` prefix from a clash id. */
export function bareClashId(id: string): string {
  return id.replace(/^C-/, "");
}

export function safeLabel(g: GroupRecord): string {
  const t = untrusted(g.title);
  if (t.flagged === "instruction_like" || t.flagged === "url") return `${g.categoryPair} — ${g.levels[0] ?? "sin nivel"} (${g.clashIds.length})`;
  return t.untrusted;
}

export function proposalSummary(p: ProposalRecord): string {
  const pl = p.payload;
  switch (pl.kind) {
    case "classification": return `validez ${pl.validity}${pl.severity ? `, ${pl.severity}` : ""}${pl.disagreesWithEngine ? " (discrepa)" : ""}`;
    case "status_change": return `${pl.action}${pl.accReason ? ` (${pl.accReason})` : ""}`;
    case "issue_draft": return pl.issue.title;
    case "group_action": return `acción ${pl.action.type}`;
    case "rule_change": return pl.title;
    case "engine_batch": return `motor: ${pl.groups.length} grupos ${pl.op === "status_change" ? "cerrables" : "reales"}`;
  }
}

/** Accept legacy contract spellings in stored feedback; engine vocabulary otherwise. */
function normalizeValidity(v: string): string {
  return v === "tolerance" ? "tolerated" : v === "unknown" ? "needs_info" : v === "duplicate" ? "false_positive" : v;
}

function dominantOf<T extends string>(vals: T[]): T | undefined {
  const m = new Map<T, number>();
  for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

/** accuracy, macro-F1 over validities, unsafe closure rate (real → closable). */
export function classificationMetrics(pairs: Array<{ expected: string; got: string }>, replayAgreement: number) {
  const labels = [...new Set(pairs.flatMap((p) => [p.expected, p.got]))];
  const correct = pairs.filter((p) => p.expected === p.got).length;
  let f1sum = 0;
  let f1n = 0;
  for (const l of labels) {
    const tp = pairs.filter((p) => p.expected === l && p.got === l).length;
    const fp = pairs.filter((p) => p.expected !== l && p.got === l).length;
    const fn = pairs.filter((p) => p.expected === l && p.got !== l).length;
    if (tp + fp + fn === 0) continue;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    f1sum += prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    f1n++;
  }
  const real = pairs.filter((p) => p.expected === "real");
  const unsafe = real.filter((p) => (CLOSABLE as string[]).includes(p.got)).length;
  return {
    validityAccuracy: round(pairs.length ? correct / pairs.length : 1, 4),
    macroF1: round(f1n ? f1sum / f1n : 1, 4),
    unsafeClosureRate: round(real.length ? unsafe / real.length : 0, 4),
    /** No expert grouping labels in the suites yet: reported as 1 (not measured). */
    groupingARI: 1,
    feedbackReplayAgreement: round(replayAgreement, 4),
  };
}

/** Files touched by a unified diff (`+++ b/<path>`). */
export function patchTargets(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)].map((m) => m[1]).filter((f) => f !== "/dev/null");
}

interface Hunk {
  oldStart: number;
  lines: string[];
}

function splitPatch(patch: string): Array<{ file: string; hunks: Hunk[] }> {
  const out: Array<{ file: string; hunks: Hunk[] }> = [];
  let cur: { file: string; hunks: Hunk[] } | undefined;
  let hunk: Hunk | undefined;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const f = /^\+\+\+ (?:b\/)?(\S+)/.exec(line);
    if (f) {
      cur = { file: f[1], hunks: [] };
      out.push(cur);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h && cur) {
      hunk = { oldStart: Number(h[1]), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "")) hunk.lines.push(line);
  }
  return out;
}

/** Apply hunks with exact context matching (searching near the stated line). Undefined = does not apply. */
export function applyUnifiedPatch(text: string, hunks: Hunk[]): string | undefined {
  const src = text.replace(/\r\n/g, "\n").split("\n");
  let offset = 0;
  for (const h of hunks) {
    const lines = [...h.lines];
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const oldLines = lines.filter((l) => !l.startsWith("+")).map((l) => l.slice(1));
    const newLines = lines.filter((l) => !l.startsWith("-")).map((l) => l.slice(1));
    const want = Math.max(0, h.oldStart - 1 + offset);
    let at = -1;
    for (let d = 0; d < src.length + 1 && at < 0; d++) {
      for (const pos of [want - d, want + d]) {
        if (pos < 0 || pos + oldLines.length > src.length) continue;
        if (oldLines.every((l, i) => src[pos + i] === l)) {
          at = pos;
          break;
        }
      }
    }
    if (at < 0) return undefined;
    src.splice(at, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
  }
  return src.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Tiny markdown → HTML for reports (headings, tables, lists, paragraphs). All text escaped. */
export function markdownToHtml(md: string, title: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      out.push("<table>", ...rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join("")}</tr>`), "</table>");
    } else if (l.startsWith("## ")) out.push(`<h2>${escapeHtml(l.slice(3))}</h2>`);
    else if (l.startsWith("# ")) out.push(`<h1>${escapeHtml(l.slice(2))}</h1>`);
    else if (l.startsWith("- ")) out.push(`<li>${escapeHtml(l.slice(2))}</li>`);
    else if (l.trim()) out.push(`<p>${escapeHtml(l)}</p>`);
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;color:#111}h1,h2{color:#A32428}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}</style></head><body>${out.join("\n")}</body></html>`;
}
