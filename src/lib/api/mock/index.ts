/**
 * MockCoordinatorApi — in-memory implementation with realistic Spanish data.
 * State lives for the page session (decisions, batches, audit events). Only
 * used when VITE_COORD_API=mock (the dev default until the server lands).
 */
import { ApiError, type CoordinatorApi } from "../coordinator-api";
import { effectiveValues, latestDecisions, minConfidence, newId } from "../decision-utils";
import type * as T from "../types";
import { buildItems, recount } from "./batches";
import { DISCIPLINES, RULES, USERS } from "./catalog";
import { HUBS, PROJECTS, type MockModelSet, type MockProject } from "./fixtures";
import { generateTest, rng, type GenerateOptions, type GeneratedTest } from "./generate";
import { buildReport, fakeHash, seedAudit, seedCorrections, seedSuggestions } from "./reports";

const ME = USERS[0];
const delay = (ms = 160) => new Promise<void>((r) => setTimeout(r, ms + Math.random() * 120));
const clone = <V,>(v: V): V => structuredClone(v);

interface ApplyJob {
  startedAt: number;
  issueTotal: number;
  statusTotal: number;
  failures: T.ApplyStatus["failures"];
}

export class MockCoordinatorApi implements CoordinatorApi {
  readonly mode = "mock" as const;

  private tests = new Map<string, GeneratedTest>();
  private decisions = new Map<string, T.Decision[]>();
  private batches = new Map<string, T.Batch>();
  private applyJobs = new Map<string, ApplyJob>();
  private audit: T.AuditEvent[] = [];
  private suggestions: T.RuleSuggestion[] = seedSuggestions();
  private corrections: T.CorrectionRow[] = seedCorrections();
  private firstLoad = new Map<string, number>();
  private changesSent = new Set<string>();
  private seeded = false;
  private batchSeq = 2;

  // ── internals ────────────────────────────────────────────────────

  private findProject(projectId: string): MockProject {
    const p = PROJECTS.find((x) => x.id === projectId);
    if (!p) throw new ApiError("Proyecto no encontrado", 404, "not_found");
    return p;
  }

  private findModelSet(projectId: string, modelSetId: string): MockModelSet {
    const ms = this.findProject(projectId).modelSets.find((m) => m.id === modelSetId);
    if (!ms) throw new ApiError("Conjunto no encontrado", 404, "not_found");
    return ms;
  }

  private locateTest(testId: string): { project: MockProject; modelSet: MockModelSet; opts: GenerateOptions } {
    for (const project of PROJECTS)
      for (const modelSet of project.modelSets)
        for (const opts of modelSet.tests) if (opts.testId === testId) return { project, modelSet, opts };
    throw new ApiError("Prueba no encontrada", 404, "not_found");
  }

  /** Tests ingested during this session (fixtures with analyzed:false start uncached). */
  private ingested = new Set<string>();

  private isCached(o: GenerateOptions): boolean {
    return o.analyzed || this.ingested.has(o.testId);
  }

  private data(testId: string): GeneratedTest {
    let d = this.tests.get(testId);
    if (!d) {
      const opts = this.locateTest(testId).opts;
      d = generateTest({ ...opts, analyzed: this.isCached(opts) });
      this.tests.set(testId, d);
    }
    return d;
  }

  private sources(testId: string) {
    const d = this.data(testId);
    return {
      groups: new Map(d.groups.map((g) => [g.id, g])),
      clashes: new Map(d.clashes.map((c) => [c.id, c])),
      proposals: new Map(d.proposals.map((p) => [p.id, p])),
    };
  }

  private decisionsOf(testId: string): T.Decision[] {
    let list = this.decisions.get(testId);
    if (!list) {
      list = [];
      this.decisions.set(testId, list);
    }
    return list;
  }

  private projectSummary(p: MockProject): T.ProjectSummary {
    const pending = p.modelSets.reduce((s, ms) => s + this.modelSetSummary(p, ms).groupsTotal - this.modelSetSummary(p, ms).groupsReviewed, 0);
    return {
      id: p.id,
      name: p.name,
      hubId: p.hubId,
      hubName: HUBS.find((h) => h.id === p.hubId)?.name ?? "",
      modelSetCount: p.modelSets.length,
      pendingDecisions: pending,
    };
  }

  private modelSetSummary(p: MockProject, ms: MockModelSet): T.ModelSetSummary {
    const latest = ms.tests[0];
    const analyzedTest = ms.tests.find((t) => this.isCached(t));
    let reviewed = 0;
    let ready = 0;
    const total = this.isCached(latest) ? latest.groups : 0;
    if (this.isCached(latest) && this.tests.has(latest.testId)) {
      const latestMap = latestDecisions(this.decisionsOf(latest.testId));
      for (const d of latestMap.values()) {
        if (d.targetType !== "group") continue;
        if (d.kind !== "postpone") reviewed++;
        if (!d.batchId && d.kind !== "postpone") ready++;
      }
    }
    return {
      id: ms.id,
      projectId: p.id,
      name: ms.name,
      latestVersion: ms.latestVersion,
      analyzedVersion: analyzedTest?.version,
      lastTest: { id: latest.testId, completedOn: latest.completedOn, clashCount: latest.clashes, modelSetVersion: latest.version },
      groupsReviewed: reviewed,
      groupsTotal: total,
      readyToApprove: ready,
      agentCommand: `Analiza el conjunto "${p.name.split(" — ")[0]} — ${ms.name}" (v${ms.latestVersion})`,
    };
  }

  private log(e: Omit<T.AuditEvent, "id" | "at" | "hash"> & { at?: string }) {
    const id = `A-${newId().slice(0, 8)}`;
    this.audit.unshift({ id, at: e.at ?? new Date().toISOString(), ...e, hash: fakeHash(id + (this.audit[0]?.hash ?? "")) });
  }

  /** Seed history: earlier decisions, three batches, audit trail. */
  private ensureSeed() {
    if (this.seeded) return;
    this.seeded = true;
    this.audit = seedAudit();

    // Torre B v14: 26 groups decided yesterday, 18 of them already in a ready batch.
    const tb = this.data("T-3f9a21c0");
    const r = rng(77);
    const yesterday = Date.now() - 22 * 3600000;
    const decided: T.Decision[] = [];
    tb.proposals.slice(0, 26).forEach((p, i) => {
      const correct = r.chance(0.18);
      const reject = !correct && r.chance(0.06);
      const pr = p.fields.priority.value;
      const d: T.Decision = {
        id: newId(),
        proposalId: p.id,
        targetType: "group",
        targetId: p.targetId,
        testId: p.testId,
        modelSetId: "a1b2c3d4-0001-4000-8000-000000000001",
        projectId: PROJECTS[0].id,
        kind: correct ? "correct" : reject ? "reject" : "accept",
        changes: correct
          ? [{ field: "priority", aiValue: pr, humanValue: pr === 1 ? 2 : pr - 1, aiConfidence: p.fields.priority.confidence, aiSource: p.fields.priority.source, ruleIds: p.fields.priority.ruleIds }]
          : [],
        reasonCode: correct ? (pr === 1 ? "R08" : "R09") : reject ? "R02" : undefined,
        viewedInViewerMs: 2000 + r.int(0, 9000),
        decidedAt: new Date(yesterday + i * 41000).toISOString(),
        userId: ME.id,
        userName: ME.short,
      };
      decided.push(d);
    });
    this.decisionsOf("T-3f9a21c0").push(...decided);
    this.makeBatch("T-3f9a21c0", decided.slice(0, 18), "ready", new Date(yesterday + 30 * 60000).toISOString(), "L-2026-11-05-01");

    // MEP Subterráneos v6 (stale: model set already at v7): ready batch.
    const sub = this.data("T-5a6b7c8d");
    const subDecisions = sub.proposals.slice(0, 9).map((p, i) => this.seedAccept(p, "a1b2c3d4-0002-4000-8000-000000000002", PROJECTS[0].id, Date.now() - 4 * 86400000 + i * 60000));
    this.decisionsOf("T-5a6b7c8d").push(...subDecisions);
    this.makeBatch("T-5a6b7c8d", subDecisions, "ready", new Date(Date.now() - 4 * 86400000 + 3600000).toISOString(), "L-2026-11-02-01");

    // Hospital v9: applied batch.
    const hrt = this.data("T-9e0f1a2b");
    const hrtDecisions = hrt.proposals.slice(0, 14).map((p, i) => this.seedAccept(p, "c3d4e5f6-0004-4000-8000-000000000004", PROJECTS[2].id, Date.now() - 6 * 86400000 + i * 60000));
    this.decisionsOf("T-9e0f1a2b").push(...hrtDecisions);
    const applied = this.makeBatch("T-9e0f1a2b", hrtDecisions, "applied", new Date(Date.now() - 6 * 86400000 + 7200000).toISOString(), "L-2026-10-31-01");
    applied.approvedBy = USERS[1].short;
    applied.approvedAt = new Date(Date.now() - 6 * 86400000 + 9000000).toISOString();
    applied.appliedAt = new Date(Date.now() - 6 * 86400000 + 9100000).toISOString();
  }

  private seedAccept(p: T.Proposal, modelSetId: string, projectId: string, at: number): T.Decision {
    return {
      id: newId(),
      proposalId: p.id,
      targetType: "group",
      targetId: p.targetId,
      testId: p.testId,
      modelSetId,
      projectId,
      kind: "accept",
      changes: [],
      viewedInViewerMs: 3500,
      decidedAt: new Date(at).toISOString(),
      userId: ME.id,
      userName: ME.short,
    };
  }

  private makeBatch(testId: string, decisions: T.Decision[], state: T.BatchState, createdAt: string, id?: string): T.Batch {
    const { project, modelSet, opts } = this.locateTest(testId);
    const batchId = id ?? `L-${new Date().toISOString().slice(0, 10)}-${String(++this.batchSeq).padStart(2, "0")}`;
    const items = buildItems(decisions, this.sources(testId), ME.short);
    const batch: T.Batch = recount({
      id: batchId,
      projectId: project.id,
      projectName: project.name,
      modelSetId: modelSet.id,
      modelSetName: modelSet.name,
      testId,
      testDate: opts.completedOn,
      modelSetVersion: opts.version,
      latestVersion: modelSet.latestVersion,
      state,
      createdBy: ME.short,
      createdAt,
      stale: modelSet.latestVersion > opts.version,
      counts: { issuesCreate: 0, statusChanges: 0, assignments: 0, comments: 0 },
      origin: { accepted: 0, corrected: 0, manual: 0 },
      review: { humanReviewedPct: 100, lowConfidence: 0, lowConfidenceViewed: 0 },
      statusTransitions: [],
      issuesByDiscipline: {},
      items,
    });
    for (const d of decisions) d.batchId = batchId;
    this.batches.set(batchId, batch);
    return batch;
  }

  private getBatchOrThrow(id: string): T.Batch {
    this.ensureSeed();
    const b = this.batches.get(id);
    if (!b) throw new ApiError("Lote no encontrado", 404, "not_found");
    return b;
  }

  private summarize(b: T.Batch): T.BatchSummary {
    const { items: _items, ...rest } = b;
    void _items;
    return clone(rest);
  }

  // ── Session / agent ─────────────────────────────────────────────

  async getAuthStatus(): Promise<T.AuthStatus> {
    await delay(30);
    return { loggedIn: true, dataSource: "fixtures", user: { id: ME.id, name: ME.name, initials: ME.initials }, loginInProgress: false };
  }

  async login(): Promise<T.LoginStartResponse> {
    return { alreadyLoggedIn: true };
  }

  async logout(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async getSession(): Promise<T.SessionInfo> {
    await delay(30);
    return {
      autonomy: { level: 1, effectiveLevel: 1, source: "mock" },
      dataSource: "fixtures",
      pending: { proposals: 0, approvedNotApplied: 0, feedbackSinceLastCuration: 0 },
      versions: { server: "mock", ruleset: "mock", engine: "mock" },
      confidenceBands: { high: 0.85, medium: 0.6 },
    };
  }

  async getCurrentUser(): Promise<T.UserInfo> {
    await delay(40);
    return { id: ME.id, name: ME.name, initials: ME.initials };
  }

  async getAgentStatus(): Promise<T.AgentStatus> {
    await delay(40);
    return {
      lastActivityAt: new Date(Date.now() - 2 * 60000).toISOString(),
      lastRunId: "run-1a2b14",
      running: false,
      currentTask: "Redactó 23 borradores de incidencia para Torre B (v14)",
    };
  }

  async getHomeSummary(): Promise<T.HomeSummary> {
    this.ensureSeed();
    await delay();
    const queue: T.HomeSummary["queue"] = [];
    for (const p of PROJECTS)
      for (const ms of p.modelSets) {
        const s = this.modelSetSummary(p, ms);
        if (s.groupsTotal - s.groupsReviewed > 0)
          queue.push({ projectId: p.id, projectName: p.name, modelSetId: ms.id, modelSetName: ms.name, pending: s.groupsTotal - s.groupsReviewed });
      }
    const report = buildReport(this.reportInput({}));
    return {
      user: { id: ME.id, name: ME.name, initials: ME.initials },
      queue,
      batches: [...this.batches.values()].filter((b) => b.state === "ready").map((b) => this.summarize(b)),
      activity: [
        { at: new Date(Date.now() - 12 * 60000).toISOString(), text: "Agrupó 1.200 interferencias en 150 grupos (Torre B, v14)" },
        { at: new Date(Date.now() - 65 * 60000).toISOString(), text: "Redactó 23 borradores de incidencia (Torre B, v14)" },
        { at: new Date(Date.now() - 3 * 3600000).toISOString(), text: "Propuso 2 reglas nuevas a partir de 12 correcciones R02" },
        { at: new Date(Date.now() - 26 * 3600000).toISOString(), text: "Analizó Hospital Regional de Talca (v9): 38 grupos" },
      ],
      kpis: report.kpis,
    };
  }

  // ── Projects ────────────────────────────────────────────────────

  async listHubs() {
    await delay(60);
    return clone(HUBS);
  }

  async listProjects(params?: { hubId?: string; q?: string }) {
    this.ensureSeed();
    await delay();
    const q = params?.q?.toLowerCase();
    return PROJECTS.filter((p) => (!params?.hubId || p.hubId === params.hubId) && (!q || p.name.toLowerCase().includes(q))).map((p) =>
      this.projectSummary(p),
    );
  }

  async getProject(projectId: string) {
    this.ensureSeed();
    await delay(60);
    return this.projectSummary(this.findProject(projectId));
  }

  async listModelSets(projectId: string) {
    this.ensureSeed();
    await delay();
    const p = this.findProject(projectId);
    return p.modelSets.map((ms) => this.modelSetSummary(p, ms));
  }

  async listTests(projectId: string, modelSetId: string) {
    await delay(60);
    return this.findModelSet(projectId, modelSetId).tests.map((o): T.TestRun => {
      const cached = this.isCached(o);
      // Uncached ACC tests: no counts yet (the server reports 0 too).
      return { id: o.testId, accTestId: o.accTestId ?? o.testId, cached, modelSetId: o.modelSetId, modelSetVersion: o.version, completedOn: o.completedOn, clashCount: cached ? o.clashes : 0, analyzed: cached, documents: [] };
    });
  }

  async ingestTest(projectId: string, modelSetId: string, accTestId: string): Promise<{ testKey: string }> {
    const ms = this.findModelSet(projectId, modelSetId);
    const o = ms.tests.find((t) => (t.accTestId ?? t.testId) === accTestId);
    if (!o) throw new ApiError("Prueba no encontrada", 404, "not_found");
    await delay(1200);
    this.ingested.add(o.testId);
    this.tests.delete(o.testId);
    this.log({ actor: { type: "engine", id: "engine", name: "Motor" }, action: "classification.run", projectId, modelSetId, testId: o.testId, targetIds: [], details: { testKey: o.testId, groups: o.groups } });
    return { testKey: o.testId };
  }

  // ── Triage ──────────────────────────────────────────────────────

  async getTriage(projectId: string, modelSetId: string, testId?: string): Promise<T.TriagePayload> {
    this.ensureSeed();
    const project = this.findProject(projectId);
    const ms = this.findModelSet(projectId, modelSetId);
    const opts = testId ? ms.tests.find((t) => t.testId === testId) : ms.tests.find((t) => this.isCached(t));
    if (!opts) throw new ApiError("No hay pruebas analizadas para este conjunto.", 409, "conflict", "not_ingested");
    if (!this.isCached(opts)) throw new ApiError("La prueba no está descargada.", 409, "conflict", "not_ingested");
    const d = this.data(opts.testId);
    await delay(400);
    if (!this.firstLoad.has(opts.testId)) this.firstLoad.set(opts.testId, Date.now());
    const tests = await this.listTests(projectId, modelSetId);
    return clone({
      project: this.projectSummary(project),
      modelSet: this.modelSetSummary(project, ms),
      test: d.test,
      tests,
      disciplines: DISCIPLINES,
      groups: d.groups,
      clashes: d.clashes,
      proposals: d.proposals,
      decisions: this.decisionsOf(opts.testId),
      changesCursor: "0",
    });
  }

  /** After ~90 s the "agent" updates three proposals once, to exercise the refresh bar. */
  async getTriageChanges(_p: string, _m: string, testId: string, cursor: string): Promise<T.TriageChanges> {
    await delay(60);
    const first = this.firstLoad.get(testId) ?? Date.now();
    if (this.changesSent.has(testId) || Date.now() - first < 90000) return { cursor, proposals: [] };
    this.changesSent.add(testId);
    const d = this.data(testId);
    const pending = new Set(d.proposals.map((p) => p.id));
    for (const x of latestDecisions(this.decisionsOf(testId)).values()) pending.delete(x.proposalId);
    const changed = d.proposals.filter((p) => pending.has(p.id)).slice(5, 8);
    const now = new Date().toISOString();
    for (const p of changed) {
      p.updatedAt = now;
      p.fields.validity.confidence = Math.min(0.97, p.fields.validity.confidence + 0.08);
      p.rationale += " Actualizado: se confirmó con las propiedades del modelo que no hay pasada modelada.";
      this.log({ actor: { type: "agent", id: "agent", name: "Agente" }, action: "proposal.updated", projectId: _p, modelSetId: _m, testId, targetIds: [p.targetId], details: { proposalId: p.id } });
    }
    return { cursor: String(Number(cursor) + 1), proposals: clone(changed) };
  }

  async listGroups(q: T.GroupQuery): Promise<T.Page<T.ClashGroup>> {
    await delay();
    const d = this.data(q.testId);
    const props = new Map(d.proposals.map((p) => [p.targetId, p]));
    let list = d.groups.filter((g) => {
      const p = props.get(g.id);
      const f = q.filter ?? {};
      if (f.pair?.length && !f.pair.includes(`${g.pair[0]}:${g.pair[1]}`) && !f.pair.includes(`${g.pair[1]}:${g.pair[0]}`)) return false;
      if (f.priority?.length && (!p || !f.priority.includes(p.fields.priority.value))) return false;
      if (f.validity?.length && (!p || !f.validity.includes(p.fields.validity.value))) return false;
      if (f.level?.length && !f.level.includes(g.location?.level ?? "")) return false;
      if (f.accStatus?.length && !f.accStatus.includes(g.accStatus)) return false;
      if (f.delta?.length && !f.delta.includes(g.delta)) return false;
      return true;
    });
    if (q.sort === "count_desc") list = [...list].sort((a, b) => b.clashIds.length - a.clashIds.length);
    else if (q.sort === "distance") list = [...list].sort((a, b) => b.penetrationMaxMm - a.penetrationMaxMm);
    else if (q.sort === "confidence_asc")
      list = [...list].sort((a, b) => (props.get(a.id) ? minConfidence(props.get(a.id)!) : 1) - (props.get(b.id) ? minConfidence(props.get(b.id)!) : 1));
    else list = [...list].sort((a, b) => (props.get(a.id)?.fields.priority.value ?? 5) - (props.get(b.id)?.fields.priority.value ?? 5) || b.clashIds.length - a.clashIds.length);
    const start = Number(q.cursor ?? 0);
    const limit = q.limit ?? 50;
    const items = list.slice(start, start + limit);
    return { items: clone(items), total: list.length, nextCursor: start + limit < list.length ? String(start + limit) : undefined };
  }

  async getGroup(testId: string, groupId: string): Promise<T.GroupDetail> {
    await delay();
    const d = this.data(testId);
    const group = d.groups.find((g) => g.id === groupId);
    if (!group) throw new ApiError("Grupo no encontrado", 404, "not_found");
    const proposal = d.proposals.find((p) => p.targetId === groupId);
    const decisions = this.decisionsOf(testId).filter((x) => x.targetId === groupId);
    const history: T.HistoryEntry[] = [];
    if (proposal) history.push({ at: proposal.createdAt, kind: "agent", text: `Agente propuso (${proposal.runId})`, actor: "Agente" });
    for (const x of decisions) history.push({ at: x.decidedAt, kind: "decision", text: x.kind, actor: x.userName });
    const reviewReasons: string[] = [];
    if (group.confidence < 0.7) reviewReasons.push(`confianza ${group.confidence.toFixed(2)} < 0,70`);
    if (group.validity === "needs_info") reviewReasons.push("validez requiere información");
    if (group.severity === "critical") reviewReasons.push("severidad crítica");
    return clone({ group, proposal, clashes: d.clashes.filter((c) => c.groupId === groupId), decisions, history, reviewReasons });
  }

  async listGroupClashes(testId: string, groupId: string, p?: { limit?: number; cursor?: string }) {
    await delay(80);
    const all = this.data(testId).clashes.filter((c) => c.groupId === groupId);
    const start = Number(p?.cursor ?? 0);
    const limit = p?.limit ?? 100;
    return { items: clone(all.slice(start, start + limit)), total: all.length, nextCursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async getElementProperties(testId: string, refs: string[]): Promise<T.ElementProperties[]> {
    await delay(120);
    const d = this.data(testId);
    const byRef = new Map<string, T.ElementInfo>();
    for (const c of d.clashes) {
      byRef.set(c.a.ref, c.a);
      byRef.set(c.b.ref, c.b);
    }
    return refs.map((ref): T.ElementProperties => {
      const e = byRef.get(ref);
      if (!e) return { ref, found: false, props: {} };
      const r = rng(e.dbId);
      return {
        ref,
        found: true,
        props: {
          Categoría: e.category,
          Familia: e.family ?? null,
          Tipo: e.type ?? null,
          Nivel: e.level ?? null,
          Sistema: e.system ?? null,
          "Desfase desde nivel (mm)": r.int(2200, 3000),
          Material: e.discipline === "EST" ? "Hormigón H30" : e.discipline === "ARQ" ? "Volcanita ST 12,5" : e.discipline === "CLI" ? "Acero galvanizado" : e.discipline === "ELE" ? "Acero galvanizado" : "PVC",
          Subproyecto: `${e.discipline}-Principal`,
          Marca: e.name.split(" ").pop() ?? null,
          Comentarios: null,
          ExternalId: e.externalId ?? null,
          Modelo: e.modelName,
        },
      };
    });
  }

  async listProposals(p: { testId: string; ids?: string[]; limit?: number; cursor?: string }) {
    await delay(80);
    let list = this.data(p.testId).proposals;
    if (p.ids?.length) list = list.filter((x) => p.ids!.includes(x.id));
    const start = Number(p.cursor ?? 0);
    const limit = p.limit ?? 50;
    return { items: clone(list.slice(start, start + limit)), total: list.length, nextCursor: start + limit < list.length ? String(start + limit) : undefined };
  }

  async listAssignees(): Promise<T.Assignee[]> {
    await delay(60);
    return [
      ...DISCIPLINES.map((d) => ({ id: `role-${d.code}`, name: `Modelador ${d.code}`, kind: "role" as const })),
      { id: "co-climatec", name: "Climatec Ltda. (CLI)", kind: "company" },
      { id: "co-hidro", name: "Hidrosur SpA (SAN)", kind: "company" },
      { id: "u-dmunoz", name: "Diego Muñoz", kind: "user" },
      { id: "u-pvaldes", name: "Paula Valdés", kind: "user" },
    ];
  }

  // ── Decisions ───────────────────────────────────────────────────

  async saveDecisions(decisions: T.Decision[]) {
    await delay(90);
    const saved: string[] = [];
    for (const d of decisions) {
      const list = this.decisionsOf(d.testId);
      if (!list.some((x) => x.id === d.id)) {
        list.push(clone(d));
        const action = d.kind === "undo" ? "decision.undone" : d.kind === "note" ? "decision.note" : `decision.${d.kind === "accept" ? "accepted" : d.kind === "correct" ? "corrected" : d.kind === "reject" ? "rejected" : "postponed"}`;
        this.log({
          actor: { type: "user", id: d.userId, name: d.userName },
          action,
          projectId: d.projectId,
          modelSetId: d.modelSetId,
          testId: d.testId,
          targetIds: [d.targetId],
          details: { proposalId: d.proposalId, reasonCode: d.reasonCode ?? null, viewedInViewerMs: d.viewedInViewerMs, bulk: d.bulk?.size ?? null },
        });
        if (d.kind === "correct" || d.kind === "reject") this.corrections.unshift(...this.toCorrections(d));
      }
      saved.push(d.id);
    }
    return { saved };
  }

  private toCorrections(d: T.Decision): T.CorrectionRow[] {
    const base = { decisionId: d.id, at: d.decidedAt, userName: d.userName, targetId: d.targetId, targetLabel: d.targetId, reasonCode: d.reasonCode, note: d.note };
    if (d.kind === "reject") return [{ ...base, field: "reject", aiValue: "—", humanValue: "Rechazada", ruleIds: [] }];
    return d.changes.map((c) => ({
      ...base,
      field: c.field,
      aiValue: JSON.stringify(c.aiValue),
      humanValue: JSON.stringify(c.humanValue),
      ruleIds: c.ruleIds ?? [],
      confidence: c.aiConfidence,
    }));
  }

  async listDecisions(p: { testId?: string; projectId?: string; limit?: number; cursor?: string }) {
    await delay(80);
    let all = [...this.decisions.values()].flat();
    if (p.testId) all = all.filter((d) => d.testId === p.testId);
    if (p.projectId) all = all.filter((d) => d.projectId === p.projectId);
    const start = Number(p.cursor ?? 0);
    const limit = p.limit ?? 100;
    return { items: clone(all.slice(start, start + limit)), total: all.length, nextCursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async sendToApproval(p: { projectId: string; modelSetId: string; testId: string }) {
    this.ensureSeed();
    await delay(250);
    const latest = latestDecisions(this.decisionsOf(p.testId));
    const unbatched = [...latest.values()].filter((d) => !d.batchId && d.kind !== "postpone");
    if (!unbatched.length) throw new ApiError("No hay decisiones para enviar", 400, "validation");
    const batch = this.makeBatch(p.testId, unbatched, "ready", new Date().toISOString());
    // rejected decisions are part of the batch record but produce no ACC writes
    for (const d of unbatched) d.batchId = batch.id;
    this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: "batch.ready", projectId: p.projectId, modelSetId: p.modelSetId, testId: p.testId, batchId: batch.id, targetIds: [], details: { decisions: unbatched.length, items: batch.items.length } });
    return clone(batch);
  }

  // ── Batches ─────────────────────────────────────────────────────

  async listBatches(p?: { state?: T.BatchState[]; projectId?: string }) {
    this.ensureSeed();
    await delay();
    this.tickApplyJobs();
    return [...this.batches.values()]
      .filter((b) => (!p?.state?.length || p.state.includes(b.state)) && (!p?.projectId || b.projectId === p.projectId))
      .map((b) => this.summarize(b));
  }

  async getBatch(id: string) {
    await delay();
    this.tickApplyJobs();
    return clone(this.getBatchOrThrow(id));
  }

  async preflightBatch(id: string): Promise<T.PreflightResult> {
    const b = this.getBatchOrThrow(id);
    await delay(900);
    let conflicts = 0;
    b.items.forEach((item, i) => {
      if (item.operation === "clash.setStatus" && i % 61 === 5 && !item.conflict) {
        item.conflict = { reason: "la interferencia fue cerrada en ACC por J. Pérez", accValueNow: "closed" };
        item.excluded = true;
      }
      if (item.conflict) conflicts++;
    });
    if (b.items.some((i) => i.operation === "issue.create") && !b.items.some((i) => i.conflict && i.operation === "issue.create")) {
      const issueItem = b.items.find((i) => i.operation === "issue.create");
      if (issueItem && b.items.length > 40) {
        issueItem.conflict = { reason: "ya existe la incidencia #312 para este par de elementos", accValueNow: "#312" };
        issueItem.excluded = true;
        conflicts++;
      }
    }
    b.lastPreflightAt = new Date().toISOString();
    recount(b);
    this.log({ actor: { type: "server", id: "server", name: "Servidor" }, action: "preflight.run", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: { conflicts } });
    return { at: b.lastPreflightAt, conflicts, batch: clone(b) };
  }

  async setBatchItemsExcluded(id: string, itemIds: string[], excluded: boolean) {
    const b = this.getBatchOrThrow(id);
    await delay(60);
    const set = new Set(itemIds);
    for (const i of b.items) if (set.has(i.id)) i.excluded = excluded;
    return clone(recount(b));
  }

  async updateBatchIssue(id: string, itemId: string, issue: Partial<T.IssueDraft>) {
    const b = this.getBatchOrThrow(id);
    await delay(60);
    const item = b.items.find((i) => i.id === itemId);
    if (item?.issue) {
      item.issue = { ...item.issue, ...issue };
      item.fields = item.fields.map((f) => (f.field === "Título" && issue.title ? { ...f, accNew: issue.title } : f));
      item.reasonCode = "R13";
      item.origin = "ai_corrected";
    }
    return clone(recount(b));
  }

  private releaseDecisions(b: T.Batch) {
    for (const d of this.decisionsOf(b.testId)) if (d.batchId === b.id) delete d.batchId;
  }

  async returnBatchToReview(id: string) {
    const b = this.getBatchOrThrow(id);
    await delay();
    b.state = "draft";
    this.releaseDecisions(b);
    this.batches.delete(id);
    this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: "batch.returned", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: {} });
    return clone(b);
  }

  async discardBatch(id: string) {
    const b = this.getBatchOrThrow(id);
    await delay();
    b.state = "discarded";
    this.releaseDecisions(b);
    this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: "batch.discarded", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: {} });
    return clone(b);
  }

  async approveBatch(id: string, req: T.ApproveRequest): Promise<T.ApplyStatus> {
    const b = this.getBatchOrThrow(id);
    await delay(300);
    if (b.state !== "ready") throw new ApiError("El lote no está listo para aprobar", 400, "validation");
    if (!b.lastPreflightAt || Date.now() - new Date(b.lastPreflightAt).getTime() > 10 * 60000)
      throw new ApiError("Pre-chequeo vencido", 400, "validation");
    const excluded = new Set(req.excludedItemIds);
    for (const i of b.items) if (excluded.has(i.id)) i.excluded = true;
    recount(b);
    b.state = "approved";
    b.approvedBy = ME.short;
    b.approvedAt = new Date().toISOString();
    const live = b.items.filter((i) => !i.excluded);
    b.approval = { approvedBy: ME.short, approvedAt: b.approvedAt, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(), channel: "web-ui", valid: true };
    this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: "batch.approved", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: { items: live.length, note: req.note ?? null } });
    return this.applyStatus(id);
  }

  /** dryRun returns the exact bodies; a real apply starts the (simulated) job. */
  async applyBatch(id: string, req: T.ApplyRequest): Promise<T.ApplyResponse> {
    const b = this.getBatchOrThrow(id);
    await delay(400);
    const dryRun = req.dryRun ?? true;
    if (b.state !== "approved" || !b.approval?.valid) {
      return { dryRun, ok: false, refused: { reason: "approval_missing", message: "El lote no tiene una aprobación humana válida." }, requests: [], status: this.applyStatus(id) };
    }
    const live = b.items.filter((i) => !i.excluded && i.mcOperation !== "none");
    const close = live.filter((i) => i.mcOperation === "clash.close");
    const assign = live.filter((i) => i.mcOperation === "clash.assign");
    const requests: T.ApplyResponse["requests"] = [];
    const base = `/bim360/clash/v3/containers/${b.projectId}/tests/${b.testId}`;
    const closeGroups = [...new Set(close.map((i) => i.groupId))];
    if (close.length)
      requests.push({
        idempotencyKey: fakeHash(id + "close").slice(0, 16), operation: "clashes:close", path: `${base}/clashes:close`, groups: closeGroups.length, clashes: close.length, outcome: dryRun ? "would_apply" : "applied",
        body: { groups: closeGroups.map((g) => ({ clashes: close.filter((i) => i.groupId === g).map((i) => i.targetIds[0].replace(/^C-/, "")), reason: "NOT_AN_ISSUE" })) },
      });
    if (assign.length)
      requests.push({
        idempotencyKey: fakeHash(id + "assign").slice(0, 16), operation: "clashes:assign", path: `${base}/clashes:assign`, groups: assign.length, clashes: assign.reduce((n, i) => n + (i.issue?.linkClashIds.length ?? 0), 0), outcome: dryRun ? "would_apply" : "applied",
        body: { groups: assign.map((i) => ({ clashes: (i.issue?.linkClashIds ?? []).map((c) => c.replace(/^C-/, "")), issue: { title: i.issue?.title, description: i.issue?.description, assignedTo: i.issue?.assigneeRole, dueDate: i.issue?.dueDate } })) },
      });
    if (!dryRun) {
      const failures = live
        .filter((i, idx) => i.operation === "clash.setStatus" && idx % 97 === 13)
        .slice(0, 1)
        .map((i) => ({ itemId: i.id, label: i.label, message: "ACC respondió 409: la interferencia cambió de estado durante la aplicación." }));
      this.applyJobs.set(id, { startedAt: Date.now(), issueTotal: b.counts.issuesCreate, statusTotal: b.counts.statusChanges, failures });
      this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: "batch.apply", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: { requests: requests.length } });
    }
    return clone({ dryRun, ok: true, requests, status: this.applyStatus(id) });
  }

  private applyStatus(id: string): T.ApplyStatus {
    const b = this.getBatchOrThrow(id);
    const job = this.applyJobs.get(id);
    if (!job) {
      const done = b.state === "applied" || b.state === "partial";
      return {
        batchId: id,
        state: b.state,
        issues: { done: done ? b.counts.issuesCreate : 0, total: b.counts.issuesCreate },
        statuses: { done: done ? b.counts.statusChanges : 0, total: b.counts.statusChanges },
        log: [],
        failures: [],
      };
    }
    const elapsed = (Date.now() - job.startedAt) / 1000;
    const issuesDone = Math.min(job.issueTotal, Math.floor(elapsed * 3));
    const statusDone = Math.min(job.statusTotal, Math.floor(Math.max(0, elapsed - job.issueTotal / 3) * 60));
    const finished = issuesDone >= job.issueTotal && statusDone >= job.statusTotal;
    const log: T.ApplyStatus["log"] = [];
    if (issuesDone) log.push({ at: new Date().toISOString(), text: `Incidencias creadas: ${issuesDone}/${job.issueTotal}`, ok: true });
    if (statusDone) log.push({ at: new Date().toISOString(), text: `Estados actualizados: ${statusDone}/${job.statusTotal}`, ok: true });
    if (finished && b.state === "approved") {
      b.state = job.failures.length ? "partial" : "applied";
      b.appliedAt = new Date().toISOString();
      this.log({ actor: { type: "server", id: "server", name: "Servidor" }, action: "acc.issue.created", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: { count: job.issueTotal }, accResponseId: `acc-${newId().slice(0, 8)}` });
      this.log({ actor: { type: "server", id: "server", name: "Servidor" }, action: "acc.clash.statusChanged", projectId: b.projectId, modelSetId: b.modelSetId, testId: b.testId, batchId: b.id, targetIds: [], details: { count: job.statusTotal - job.failures.length }, accResponseId: `acc-${newId().slice(0, 8)}` });
      for (const f of job.failures)
        this.log({ actor: { type: "server", id: "server", name: "Servidor" }, action: "acc.error", projectId: b.projectId, batchId: b.id, targetIds: [f.label], details: { message: f.message } });
    }
    if (finished) for (const f of job.failures) log.push({ at: new Date().toISOString(), text: `${f.label}: ${f.message}`, ok: false });
    return {
      batchId: id,
      state: b.state,
      issues: { done: issuesDone, total: job.issueTotal },
      statuses: { done: statusDone, total: job.statusTotal },
      log,
      failures: finished ? job.failures : [],
    };
  }

  private tickApplyJobs() {
    for (const id of this.applyJobs.keys()) this.applyStatus(id);
  }

  async getApplyStatus(id: string) {
    await delay(80);
    return clone(this.applyStatus(id));
  }

  // ── Learning / rules ────────────────────────────────────────────

  async submitFeedback(input: T.FeedbackInput) {
    await delay(80);
    const id = `F-${newId().slice(0, 8)}`;
    this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: "feedback.recorded", projectId: PROJECTS[0].id, targetIds: [], details: { verdict: input.verdict, scope: input.scope } });
    return { feedbackId: id };
  }

  async listRules(): Promise<T.RuleSummary[]> {
    await delay();
    return RULES.map((r, i) => this.ruleSummary(r, i));
  }

  private ruleSummary(r: (typeof RULES)[number], i: number): T.RuleSummary {
    const g = rng(i * 31 + 7);
    const hits = r.state === "disabled" ? 0 : g.int(4, 160);
    return {
      id: r.id,
      name: r.name,
      scope: r.scope,
      effect: r.effect,
      state: r.state,
      hits7d: hits,
      acceptance: hits ? Number((0.55 + g.next() * 0.44).toFixed(2)) : null,
      corrections: hits ? g.int(0, Math.ceil(hits / 6)) : 0,
      updatedAt: new Date(Date.now() - g.int(2, 60) * 86400000).toISOString(),
      file: r.file,
    };
  }

  async getRule(ruleId: string): Promise<T.RuleDetail> {
    await delay();
    const idx = RULES.findIndex((r) => r.id === ruleId);
    if (idx < 0) throw new ApiError("Regla no encontrada", 404, "not_found");
    const r = RULES[idx];
    const tb = this.data("T-3f9a21c0");
    const latest = latestDecisions(this.decisionsOf("T-3f9a21c0"));
    const hits = tb.proposals.filter((p) => p.ruleIds.includes(ruleId)).slice(0, 8);
    const g = rng(idx + 3);
    return {
      ...this.ruleSummary(r, idx),
      description: r.description,
      conditions: r.conditions,
      yaml: `- id: ${r.id}\n  name: "${r.name}"\n  scope: "${r.scope}"\n  effect: ${r.effect}\n  when:\n${r.conditions.map((c) => `    - "${c}"`).join("\n")}\n  state: ${r.state}`,
      recentHits: hits.map((p) => {
        const d = latest.get(p.targetId);
        const grp = tb.groups.find((x) => x.id === p.targetId);
        return {
          groupId: p.targetId,
          projectId: PROJECTS[0].id,
          modelSetId: PROJECTS[0].modelSets[0].id,
          title: grp?.title ?? p.targetId,
          decision: d ? (d.kind === "accept" ? "accepted" : d.kind === "correct" ? "corrected" : d.kind === "reject" ? "rejected" : "postponed") : "pending",
          at: p.createdAt,
        };
      }),
      reasonDistribution: (["R01", "R02", "R03", "R08", "R09"] as const).map((code) => ({ code, count: g.int(0, 9) })).filter((x) => x.count > 0),
    };
  }

  async listRuleSuggestions() {
    await delay();
    return clone(this.suggestions);
  }

  async decideRuleSuggestion(id: string, decision: "approve" | "reject") {
    await delay(150);
    const s = this.suggestions.find((x) => x.id === id);
    if (!s) throw new ApiError("Sugerencia no encontrada", 404, "not_found");
    s.state = decision === "approve" ? "approved" : "rejected";
    this.log({ actor: { type: "user", id: ME.id, name: ME.short }, action: decision === "approve" ? "rule.approved" : "rule.rejected", projectId: PROJECTS[0].id, targetIds: [id], details: { title: s.title } });
    return clone(s);
  }

  async listCorrections(p?: { projectId?: string; limit?: number; cursor?: string }) {
    await delay();
    const start = Number(p?.cursor ?? 0);
    const limit = p?.limit ?? 500;
    return { items: clone(this.corrections.slice(start, start + limit)), total: this.corrections.length };
  }

  async getCalibration(): Promise<T.Calibration> {
    await delay();
    const bands = (alta: number, media: number, baja: number): T.CalibrationBand[] => [
      { band: "alta", proposals: alta, acceptedUnchanged: Math.round(alta * 0.95) },
      { band: "media", proposals: media, acceptedUnchanged: Math.round(media * 0.78) },
      { band: "baja", proposals: baja, acceptedUnchanged: Math.round(baja * 0.52) },
    ];
    return {
      thresholds: { high: 0.85, medium: 0.6 },
      minDecisions: 50,
      bands: bands(1204, 412, 38),
      byField: [
        { field: "validity", source: "rule", bands: bands(820, 160, 12) },
        { field: "validity", source: "llm", bands: bands(120, 140, 22) },
        { field: "priority", source: "rule", bands: bands(610, 220, 30) },
        { field: "priority", source: "llm", bands: bands(90, 110, 41) },
        { field: "owner", source: "rule", bands: bands(980, 90, 8) },
        { field: "owner", source: "llm", bands: bands(40, 33, 6) },
      ],
      spotCheck: { reviewed: 61, corrected: 4 },
    };
  }

  // ── Reports / audit ─────────────────────────────────────────────

  private reportInput(scope: T.ReportScope) {
    const testId =
      scope.projectId && scope.modelSetId
        ? this.findModelSet(scope.projectId, scope.modelSetId).tests[0].testId
        : scope.projectId
          ? this.findProject(scope.projectId).modelSets[0].tests[0].testId
          : "T-3f9a21c0";
    const d = this.data(testId);
    const latest = latestDecisions(this.decisionsOf(testId));
    const eff = new Map(d.proposals.map((p) => [p.targetId, effectiveValues(p, latest.get(p.targetId))]));
    return { scope, data: d, decisions: [...latest.values()], effective: eff, corrections: this.corrections };
  }

  async getReport(scope: T.ReportScope) {
    this.ensureSeed();
    await delay(250);
    return buildReport(this.reportInput(scope));
  }

  async listAudit(q: T.AuditQuery): Promise<T.Page<T.AuditEvent>> {
    this.ensureSeed();
    await delay();
    const from = q.from ? new Date(q.from).getTime() : -Infinity;
    const to = q.to ? new Date(q.to).getTime() + 86400000 : Infinity;
    const list = this.audit.filter((e) => {
      const at = new Date(e.at).getTime();
      if (at < from || at > to) return false;
      if (q.project && e.projectId !== q.project) return false;
      if (q.user && !e.actor.name.toLowerCase().includes(q.user.toLowerCase())) return false;
      if (q.action && !e.action.startsWith(q.action)) return false;
      if (q.batch && e.batchId !== q.batch) return false;
      return true;
    });
    return { items: clone(list), total: list.length };
  }
}
