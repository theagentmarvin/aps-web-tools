/**
 * Web-UI side of the service layer: projections of the store into the HTTP
 * contract (server/api/contract.ts), human triage decisions, approval batches,
 * approval and apply. Builds on {@link Coordinator}; the HTTP router only
 * validates input and calls these methods.
 */
import { join } from "node:path";
import type * as C from "./api/contract";
import { applyApproved, approvalOptions, approveBatch, verifyBatchApproval, withBatchLock, type ApprovalDeps } from "./approval";
import type { AssignedGroupCreate, CloseReason, ClosedGroupCreate } from "./aps/types";
import { AGENT_ACTOR, type Coordinator, proposalSummary, type ReviewState } from "./coordinator";
import { CLOSABLE, loadRules } from "./engine";
import { sanitizeModelText } from "./sanitize";
import type {
  Actor,
  BatchItemRecord,
  BatchRecord,
  ClashRecord,
  ClassificationRecord,
  DecisionRecord,
  GroupRecord,
  ProposalRecord,
  TestRecord,
} from "./store/types";
import { REASON_CODES } from "./store/types";
import { bareProjectId, CoordError, nowIso, paginate, round, sha256, uuidFromHash } from "./util";

export interface HumanUser {
  id: string;
  name: string;
}

type IssueDraftsMap = Record<string, { title: string; description: string; responsibleDiscipline: string; dueDate: string; viewpointClashId?: string }>;

const PENDING = new Set(["draft", "pending_review"]);

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function withB(p: string): string {
  return p.startsWith("b.") ? p : `b.${p}`;
}

function confBand(conf: number, t: { high: number; medium: number }): C.ConfidenceBandName {
  return conf >= t.high ? "alta" : conf >= t.medium ? "media" : "baja";
}

/** Deterministic ~5 % spot check per proposal id (UX §4.5). */
function spotCheck(id: string, conf: number, high: number): boolean {
  return conf >= high && parseInt(sha256(id).slice(0, 4), 16) % 20 === 0;
}

export class CoordinatorUi {
  constructor(readonly core: Coordinator) {}

  private get store() {
    return this.core.store;
  }

  private get bands() {
    return this.core.config.ui.confidenceBands;
  }

  approvalDeps(): ApprovalDeps {
    return this.core.approvalDeps();
  }

  // ── session ──────────────────────────────────────────────────────────────

  /** The human using the web UI / CLI: APS profile, else configured approver name. */
  async currentUser(): Promise<HumanUser | undefined> {
    const u = await this.core.source.currentUser().catch(() => undefined);
    if (u) return { id: u.id, name: u.name };
    const name = this.core.config.approver.name;
    return name ? { id: `local:${name}`, name } : undefined;
  }

  async me(): Promise<C.UserInfo> {
    const u = await this.currentUser();
    if (!u) throw new CoordError("not_authenticated", "Sin sesión APS ni approver.name configurado.");
    return { id: u.id, name: u.name, initials: initials(u.name) };
  }

  async session(): Promise<C.SessionInfo> {
    const s = await this.core.sessionStatus();
    return {
      autonomy: s.autonomy,
      dataSource: s.dataSource,
      ...(s.active
        ? {
            active: {
              projectId: s.active.projectId,
              projectName: s.active.projectName.untrusted,
              ...(s.active.modelSetId ? { modelSetId: s.active.modelSetId } : {}),
              ...(s.active.modelSetName ? { modelSetName: (s.active.modelSetName as { untrusted: string }).untrusted } : {}),
              ...(s.active.testKey ? { testKey: s.active.testKey } : {}),
            },
          }
        : {}),
      pending: s.pending,
      versions: s.versions,
      confidenceBands: this.bands,
    };
  }

  async agentStatus(): Promise<C.AgentStatus> {
    const events = await this.store.listAudit();
    const agent = events.filter((e) => e.actor.type === "agent").pop();
    const run = events.filter((e) => e.action === "classification.run").pop();
    return {
      lastActivityAt: agent?.at ?? null,
      lastRunId: run ? String(run.details.testKey ?? run.id) : null,
      running: !!agent && this.core.now() - Date.parse(agent.at) < 120_000,
      ...(agent ? { currentTask: agent.action } : {}),
    };
  }

  // ── projects / model sets / tests ────────────────────────────────────────

  async hubs(): Promise<C.Hub[]> {
    return this.core.source.listHubs();
  }

  async projects(q: { hubId?: string; q?: string } = {}): Promise<C.ProjectSummary[]> {
    const ps = await this.core.source.listProjects({ hubId: q.hubId, nameContains: q.q });
    const tests = await this.store.listTests();
    const out: C.ProjectSummary[] = [];
    for (const p of ps) {
      const mine = tests.filter((t) => bareProjectId(t.projectId) === bareProjectId(p.id));
      let pending = 0;
      for (const t of mine) pending += await this.pendingCount(t);
      const sets = await this.core.source.listModelSets(p.id).catch(() => undefined);
      const modelSetCount = sets ? sets.length : new Set(mine.map((t) => t.modelSetId)).size;
      out.push({ id: bareProjectId(p.id), name: p.name, hubId: p.hubId, hubName: p.hubName, modelSetCount, pendingDecisions: pending });
    }
    return out;
  }

  async project(projectId: string): Promise<C.ProjectSummary> {
    const p = (await this.projects()).find((x) => x.id === bareProjectId(projectId));
    if (!p) throw new CoordError("not_found", `Proyecto ${projectId} no existe`);
    return p;
  }

  private async pendingCount(t: TestRecord): Promise<number> {
    const cls = await this.store.getClassification(t.testKey);
    if (!cls) return 0;
    const decided = await this.core.effectiveDecisions(t.testKey);
    return cls.groups.filter((g) => !decided.has(g.id)).length;
  }

  async modelSets(projectId: string): Promise<C.ModelSetSummary[]> {
    const sets = await this.core.source.listModelSets(withB(projectId));
    const tests = await this.store.listTests();
    const batches = await this.store.listBatches();
    const out: C.ModelSetSummary[] = [];
    for (const s of sets) {
      const mine = tests.filter((t) => t.modelSetId === s.id).sort((a, b) => b.modelSetVersion - a.modelSetVersion);
      let analyzed: TestRecord | undefined;
      for (const t of mine) if (await this.store.getClassification(t.testKey)) { analyzed = t; break; }
      const cls = analyzed ? await this.store.getClassification(analyzed.testKey) : undefined;
      const decided = analyzed ? await this.core.effectiveDecisions(analyzed.testKey) : new Map();
      const last = mine[0];
      out.push({
        id: s.id,
        projectId: bareProjectId(projectId),
        name: s.name,
        latestVersion: s.latestVersion,
        ...(analyzed ? { analyzedVersion: analyzed.modelSetVersion } : {}),
        ...(last ? { lastTest: { id: last.testKey, completedOn: last.completedOn ?? last.ingestedAt, clashCount: last.counts.clashes, modelSetVersion: last.modelSetVersion } } : {}),
        groupsReviewed: cls ? cls.groups.filter((g) => decided.has(g.id)).length : 0,
        groupsTotal: cls?.groups.length ?? 0,
        readyToApprove: batches.filter((b) => b.modelSetId === s.id && b.state === "ready").reduce((n, b) => n + b.items.filter((i) => !i.excluded).length, 0),
        agentCommand: `Analiza el conjunto "${s.name}" (v${s.latestVersion}) del proyecto ${bareProjectId(projectId)}`,
      });
    }
    return out;
  }

  private testRun(t: TestRecord, analyzed: boolean): C.TestRun {
    return {
      id: t.testKey,
      accTestId: t.testId,
      cached: true,
      modelSetId: t.modelSetId,
      modelSetVersion: t.modelSetVersion,
      completedOn: t.completedOn ?? t.ingestedAt,
      clashCount: t.counts.clashes,
      analyzed,
      documents: t.documents.map((d) => ({ documentId: d.documentId, urn: d.urn, name: `${d.name} · ${d.viewableName}`, ...(d.discipline ? { discipline: d.discipline } : {}) })),
    };
  }

  async tests(projectId: string, modelSetId: string): Promise<C.TestRun[]> {
    const remote = await this.core.source.listClashTests(withB(projectId), modelSetId).catch(() => []);
    const cached = (await this.store.listTests()).filter((t) => t.modelSetId === modelSetId);
    const out: C.TestRun[] = [];
    for (const t of cached) out.push(this.testRun(t, !!(await this.store.getClassification(t.testKey))));
    for (const r of remote) {
      if (cached.some((c) => c.testId === r.id)) continue;
      out.push({ id: r.id, accTestId: r.id, cached: false, modelSetId, modelSetVersion: r.modelSetVersion, completedOn: r.completedOn ?? "", clashCount: 0, analyzed: false, documents: [] });
    }
    return out.sort((a, b) => b.modelSetVersion - a.modelSetVersion);
  }

  async assignees(projectId: string): Promise<C.Assignee[]> {
    return this.core.source.listAssignees(withB(projectId));
  }

  /** Human-started ingest + classification from the UI. */
  async ingestAndClassify(projectId: string, modelSetId: string, accTestId: string, opts: { refresh?: boolean; classify?: boolean }, user: HumanUser) {
    const actor: Actor = { type: "user", id: user.id, name: user.name };
    const r = await this.core.ingest({ projectId: withB(projectId), modelSetId, testId: accTestId, refresh: opts.refresh }, { actor });
    if (opts.classify !== false) await this.core.classify({ testKey: r.testKey }, { actor });
    return { testKey: r.testKey };
  }

  // ── projections ──────────────────────────────────────────────────────────

  private clashUi(c: ClashRecord): C.Clash {
    const el = (s: ClashRecord["a"]): C.ElementInfo => ({
      ref: s.ref,
      documentId: s.documentId,
      dbId: s.dbId,
      ...(s.externalId ? { externalId: s.externalId } : {}),
      discipline: s.discipline,
      name: s.name,
      category: s.category,
      ...(s.family ? { family: s.family } : {}),
      ...(s.type ? { type: s.type } : {}),
      ...(s.system ? { system: s.system } : {}),
      ...(s.level ? { level: s.level } : {}),
      ...(s.sizeHint ? { sizeHint: s.sizeHint } : {}),
      modelName: s.modelName,
    });
    return {
      id: `C-${c.id}`,
      groupId: c.groupId,
      status: c.status,
      distanceMm: round(c.distanceMm),
      a: el(c.a),
      b: el(c.b),
      ...(c.level ? { level: c.level } : {}),
      validity: c.validity,
      nature: c.nature,
      delta: c.delta,
      ...(c.previousDistanceMm !== undefined ? { previousDistanceMm: round(c.previousDistanceMm) } : {}),
    };
  }

  private groupUi(g: GroupRecord, test: TestRecord, state: ReviewState, hasIssueDraft: boolean, updatedAt: string): C.ClashGroup {
    return {
      id: g.id,
      testId: test.testKey,
      strategy: g.strategy,
      engineStrategy: g.engineStrategy,
      title: g.title,
      clashIds: g.clashIds.map((id) => `C-${id}`),
      pair: g.pair,
      ...(g.levels[0] ? { location: { level: g.levels[0] } } : {}),
      penetrationMaxMm: round(g.maxPenetrationMm),
      penetrationMinMm: round(g.minPenetrationMm),
      deltaSummary: g.deltaSummary,
      delta: g.delta,
      accStatus: g.accStatus,
      issue: hasIssueDraft ? "draft" : "none",
      updatedAt,
      validity: g.validity,
      nature: g.nature,
      severity: g.severity,
      priority: g.band,
      confidence: g.confidence,
      reviewState: state,
    };
  }

  /** Merge engine result + agent proposals for one group into the UI proposal view. */
  proposalView(g: GroupRecord, test: TestRecord, cls: ClassificationRecord, props: ProposalRecord[]): C.Proposal {
    const agent = props.filter((p) => p.createdBy.type === "agent" && p.state !== "withdrawn" && p.state !== "rejected");
    const engineBatch = props.find((p) => p.createdBy.type === "engine" && p.state !== "withdrawn");
    const cl = agent.filter((p) => p.payload.kind === "classification").pop();
    const st = agent.filter((p) => p.payload.kind === "status_change").pop();
    const iss = agent.filter((p) => p.payload.kind === "issue_draft").pop();
    const prio = agent.filter((p) => p.payload.kind === "group_action" && (p.payload.action.type === "set_priority" || p.payload.action.type === "assign_responsible")).pop();
    const engineIssue = (cls as ClassificationRecord & { issueDrafts?: IssueDraftsMap }).issueDrafts?.[g.id];
    const llmConf = (band: string) => (band === "alta" ? 0.9 : band === "media" ? 0.7 : 0.45);

    const validity: C.ProposalField<C.Validity> =
      cl && cl.payload.kind === "classification"
        ? { value: cl.payload.validity, confidence: llmConf(cl.confidence), source: cl.payload.disagreesWithEngine ? "llm" : "rule+llm", ruleIds: g.ruleIds }
        : { value: g.validity, confidence: g.confidence, source: "rule", ruleIds: g.ruleIds };
    let priorityValue = g.band as C.Priority;
    let owner = g.responsibleDiscipline;
    let prioSource: C.FieldSource = "rule";
    if (prio && prio.payload.kind === "group_action") {
      const a = prio.payload.action;
      if (a.type === "set_priority" && typeof a.priority === "number") {
        priorityValue = (a.priority >= 75 ? 1 : a.priority >= 50 ? 2 : a.priority >= 25 ? 3 : 4) as C.Priority;
        prioSource = "rule+llm";
      }
      if (a.type === "assign_responsible" && typeof a.discipline === "string") owner = a.discipline;
    }
    if (cl && cl.payload.kind === "classification" && cl.payload.responsibleDiscipline) owner = cl.payload.responsibleDiscipline;
    const effValidity = validity.value;
    const createIssue = !!iss || (effValidity === "real" && (g.suggestedAction === "create_issue" || !!engineIssue));
    let setStatus: C.AccStatus | null = null;
    if (st && st.payload.kind === "status_change") setStatus = st.payload.action === "close_not_issue" ? "closed" : st.payload.action === "mark_reviewed" ? "reviewed" : "active";
    else if ((CLOSABLE as string[]).includes(effValidity) && g.suggestedAction === "close_not_issue") setStatus = "closed";
    else if ((CLOSABLE as string[]).includes(effValidity) && g.suggestedAction === "mark_reviewed") setStatus = "reviewed";
    const actionSource: C.FieldSource = st || iss ? (cl ? "llm" : "rule+llm") : "rule";

    let issueDraft: C.IssueDraft | undefined;
    const due = (days: number) => new Date(this.core.now() + days * 86_400_000).toISOString().slice(0, 10);
    if (iss && iss.payload.kind === "issue_draft") {
      const d = iss.payload.issue;
      issueDraft = {
        title: d.title,
        description: d.description,
        ownerDiscipline: d.responsibleDiscipline,
        ...(d.assigneeRole ? { assigneeRole: d.assigneeRole } : {}),
        dueDate: due(this.core.config.issues.defaultDueInDays),
        ...(g.levels[0] ? { location: g.levels[0] } : {}),
        includeView: true,
        linkClashIds: (d.linkClashIds ?? g.clashIds).map((c) => `C-${c}`),
        ...(d.viewpointClashId ? { viewpointClashId: d.viewpointClashId } : {}),
      } as C.IssueDraft;
    } else if (createIssue && engineIssue) {
      issueDraft = {
        title: engineIssue.title,
        description: engineIssue.description,
        ownerDiscipline: engineIssue.responsibleDiscipline,
        dueDate: engineIssue.dueDate,
        ...(g.levels[0] ? { location: g.levels[0] } : {}),
        includeView: true,
        linkClashIds: g.clashIds.map((c) => `C-${c}`),
        ...(engineIssue.viewpointClashId ?? g.representativeClashId ? { viewpointClashId: engineIssue.viewpointClashId ?? g.representativeClashId } : {}),
      } as C.IssueDraft;
    }
    const primary = cl ?? iss ?? st ?? prio ?? engineBatch;
    const id = primary?.id ?? `E-${test.testKey}-${g.id}`;
    const rationale = agent.length ? agent.map((p) => p.rationale).join("\n") : g.rationale ?? g.reviewReasons.join("; ") ?? "";
    return {
      id,
      sourceProposalIds: [...new Set([...agent.map((p) => p.id), ...(engineBatch ? [engineBatch.id] : [])])],
      targetType: "group",
      targetId: g.id,
      testId: test.testKey,
      runId: cls.createdAt,
      ...(agent.length ? { model: "claude-code" } : {}),
      createdAt: primary?.createdAt ?? cls.createdAt,
      updatedAt: agent.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), primary?.updatedAt ?? cls.createdAt),
      fields: {
        validity,
        priority: { value: priorityValue, confidence: g.confidence, source: prioSource, ruleIds: g.ruleIds },
        owner: { value: owner, confidence: g.confidence, source: cl?.payload.kind === "classification" && cl.payload.responsibleDiscipline ? "llm" : "rule", ruleIds: g.ruleIds },
        action: { value: { createIssue, setStatus }, confidence: Math.min(g.confidence, validity.confidence), source: actionSource },
      },
      rationale: rationale || `Clasificación del motor (${g.ruleIds.slice(0, 3).join(", ")}).`,
      signals: [
        { label: "Penetración máx.", value: `${round(g.maxPenetrationMm)} mm` },
        { label: "Interferencias", value: String(g.clashIds.length) },
        { label: "Par", value: g.disciplinePair },
        { label: "Naturaleza", value: g.nature },
        ...(g.reviewReasons.length ? [{ label: "Revisión", value: g.reviewReasons.join("; ") }] : []),
      ],
      ruleIds: g.ruleIds,
      spotCheck: spotCheck(id + g.id, validity.confidence, this.bands.high),
      ...(agent.some((p) => p.flaggedText) ? { flagged: true } : {}),
      ...(issueDraft ? { issueDraft } : {}),
    };
  }

  private decisionUi(d: DecisionRecord): C.Decision {
    const { receivedAt: _r, ...rest } = d;
    void _r;
    return rest as C.Decision;
  }

  private async testContext(testKey: string) {
    const { test, cls } = await this.core.requireClassified(testKey);
    const states = await this.core.groupStates(test.testKey, cls);
    const byGroup = await this.core.proposalsByGroup(test.testKey, cls);
    return { test, cls, states, byGroup };
  }

  async triage(projectId: string, modelSetId: string, testKey?: string): Promise<C.TriagePayload> {
    let key = testKey;
    if (!key) {
      const mine = (await this.store.listTests()).filter((t) => t.modelSetId === modelSetId && bareProjectId(t.projectId) === bareProjectId(projectId)).sort((a, b) => b.modelSetVersion - a.modelSetVersion);
      for (const t of mine) if (await this.store.getClassification(t.testKey)) { key = t.testKey; break; }
      if (!key) throw new CoordError("not_ingested", "No hay pruebas analizadas para este conjunto.", "Pide al agente: ingesta y clasifica la prueba más reciente.");
    }
    const { test, cls, states, byGroup } = await this.testContext(key);
    const project = await this.project(projectId).catch(() => ({ id: bareProjectId(projectId), name: test.projectName, hubId: "", hubName: "", modelSetCount: 1, pendingDecisions: 0 }));
    const modelSet = (await this.modelSets(projectId).catch(() => [])).find((m) => m.id === modelSetId) ?? {
      id: modelSetId, projectId: bareProjectId(projectId), name: test.modelSetName, latestVersion: test.modelSetVersion, analyzedVersion: test.modelSetVersion,
      groupsReviewed: 0, groupsTotal: cls.groups.length, readyToApprove: 0, agentCommand: `Analiza el conjunto "${test.modelSetName}"`,
    };
    const proposals = cls.groups.map((g) => this.proposalView(g, test, cls, byGroup.get(g.id) ?? []));
    const groups = cls.groups.map((g, i) => this.groupUi(g, test, states.get(g.id) ?? g.reviewState, !!proposals[i].issueDraft, proposals[i].updatedAt));
    const rs = loadRules();
    const decisions = (await this.store.listDecisions()).filter((d) => d.testId === test.testKey).map((d) => this.decisionUi(d));
    return {
      project,
      modelSet,
      test: this.testRun(test, true),
      tests: await this.tests(projectId, modelSetId),
      disciplines: rs.source.matrix.disciplines.map((d) => ({ code: d.code, es: d.es, en: (d as { en?: string }).en ?? d.es })),
      groups,
      clashes: cls.clashes.map((c) => this.clashUi(c)),
      proposals,
      decisions,
      changesCursor: nowIso(this.core.now()),
    };
  }

  async triageChanges(testKey: string, since: string): Promise<C.TriageChanges> {
    const { test, cls, byGroup } = await this.testContext(testKey);
    const changed = new Set<string>();
    for (const [gid, ps] of byGroup) if (ps.some((p) => p.updatedAt > since)) changed.add(gid);
    const proposals = cls.groups.filter((g) => changed.has(g.id)).map((g) => this.proposalView(g, test, cls, byGroup.get(g.id) ?? []));
    return { cursor: nowIso(this.core.now()), proposals };
  }

  async groups(q: C.GroupQuery): Promise<C.Page<C.ClashGroup>> {
    const { test, cls, states, byGroup } = await this.testContext(q.testId);
    const f = q.filter ?? {};
    let gs = cls.groups.filter(
      (g) =>
        (!f.pair?.length || f.pair.includes(g.disciplinePair) || f.pair.includes(`${g.pair[1]}×${g.pair[0]}`)) &&
        (!f.priority?.length || f.priority.includes(g.band)) &&
        (!f.validity?.length || f.validity.includes(g.validity)) &&
        (!f.level?.length || g.levels.some((l) => f.level!.includes(l))) &&
        (!f.accStatus?.length || f.accStatus.includes(g.accStatus)) &&
        (!f.delta?.length || f.delta.includes(g.delta)),
    );
    gs = this.core.sortGroups(gs, q.sort ?? "priority");
    const page = paginate(gs, Math.min(q.limit ?? 100, 500), q.cursor);
    return {
      items: page.items.map((g) => {
        const pv = this.proposalView(g, test, cls, byGroup.get(g.id) ?? []);
        return this.groupUi(g, test, states.get(g.id) ?? g.reviewState, !!pv.issueDraft, pv.updatedAt);
      }),
      total: page.total,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async groupDetail(testKey: string, groupId: string): Promise<C.GroupDetail> {
    const { test, cls, states, byGroup } = await this.testContext(testKey);
    const g = cls.groups.find((x) => x.id === groupId);
    if (!g) throw new CoordError("not_found", `Grupo ${groupId} no existe`);
    const props = byGroup.get(g.id) ?? [];
    const proposal = this.proposalView(g, test, cls, props);
    const decisions = (await this.store.listDecisions()).filter((d) => d.testId === test.testKey && d.targetId === g.id).map((d) => this.decisionUi(d));
    const history: C.HistoryEntry[] = [
      { at: cls.createdAt, kind: "agent" as const, text: `Motor: ${g.validity} · ${g.severity} · confianza ${round(g.confidence, 2)}`, actor: "motor" },
      ...props.map((p) => ({ at: p.createdAt, kind: "agent" as const, text: `${p.id}: ${proposalSummary(p)} (${p.state})`, actor: p.createdBy.name })),
      ...decisions.map((d) => ({ at: d.decidedAt, kind: "decision" as const, text: `${d.kind}${d.reasonCode ? " " + d.reasonCode : ""}${d.note ? ": " + d.note : ""}`, actor: d.userName })),
    ].sort((a, b) => (a.at < b.at ? -1 : 1));
    return {
      group: this.groupUi(g, test, states.get(g.id) ?? g.reviewState, !!proposal.issueDraft, proposal.updatedAt),
      proposal,
      clashes: cls.clashes.filter((c) => c.groupId === g.id).map((c) => this.clashUi(c)),
      decisions,
      history,
      reviewReasons: g.reviewReasons,
    };
  }

  async groupClashes(testKey: string, groupId: string, limit = 100, cursor?: string): Promise<C.Page<C.Clash>> {
    const { cls } = await this.core.requireClassified(testKey);
    if (!cls.groups.some((g) => g.id === groupId)) throw new CoordError("not_found", `Grupo ${groupId} no existe`);
    const page = paginate(cls.clashes.filter((c) => c.groupId === groupId).sort((a, b) => b.penetrationMm - a.penetrationMm), Math.min(limit, 500), cursor);
    return { items: page.items.map((c) => this.clashUi(c)), total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async elementProperties(testKey: string, refs: string[]): Promise<C.ElementProperties[]> {
    const r = await this.core.getElementProperties({ testKey, elements: refs, properties: "core" });
    return r.elements.map((e) => ({
      ref: e.ref,
      found: e.found,
      props: Object.fromEntries(Object.entries(e.props).map(([k, v]) => [k, v && typeof v === "object" ? v.untrusted : v])),
    }));
  }

  async proposals(testKey: string, ids?: string[], limit = 200, cursor?: string): Promise<C.Page<C.Proposal>> {
    const { test, cls, byGroup } = await this.testContext(testKey);
    let views = cls.groups.map((g) => this.proposalView(g, test, cls, byGroup.get(g.id) ?? []));
    if (ids?.length) views = views.filter((v) => ids.includes(v.id) || v.sourceProposalIds.some((s) => ids.includes(s)));
    const page = paginate(views, Math.min(limit, 1000), cursor);
    return { items: page.items, total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async saveDecisions(input: C.Decision[], user: HumanUser): Promise<{ saved: string[] }> {
    const byTest = new Map<string, Awaited<ReturnType<CoordinatorUi["testContext"]>>>();
    const records: DecisionRecord[] = [];
    for (const d of input) {
      if (!byTest.has(d.testId)) byTest.set(d.testId, await this.testContext(d.testId));
      const ctx = byTest.get(d.testId)!;
      if (d.targetType === "group" && !ctx.cls.groups.some((g) => g.id === d.targetId)) throw new CoordError("not_found", `Grupo ${d.targetId} no existe en ${d.testId}`);
      if (d.targetType === "clash" && !ctx.cls.clashes.some((c) => `C-${c.id}` === d.targetId || c.id === d.targetId)) throw new CoordError("not_found", `Clash ${d.targetId} no existe`);
      if ((d.kind === "correct" || d.kind === "reject") && !d.reasonCode) throw new CoordError("validation_error", `La decisión ${d.id} (${d.kind}) requiere reasonCode.`);
      if (d.reasonCode && !(REASON_CODES as readonly string[]).includes(d.reasonCode)) throw new CoordError("validation_error", `reasonCode inválido: ${d.reasonCode}`);
      if (d.reasonCode === "R99" && !d.note?.trim()) throw new CoordError("validation_error", "R99 requiere una nota.");
      records.push({
        ...d,
        note: d.note ? sanitizeModelText(d.note, 1000) : undefined,
        projectId: bareProjectId(ctx.test.projectId),
        modelSetId: ctx.test.modelSetId,
        userId: user.id,
        userName: user.name,
        batchId: undefined,
        receivedAt: nowIso(this.core.now()),
      });
    }
    const { saved, added } = await this.store.appendDecisions(records);
    const actor: Actor = { type: "user", id: user.id, name: user.name };
    for (const d of added) {
      const ctx = byTest.get(d.testId)!;
      const action = d.kind === "accept" ? "decision.accepted" : d.kind === "correct" ? "decision.corrected" : d.kind === "reject" ? "decision.rejected" : d.kind === "postpone" ? "decision.postponed" : d.kind === "undo" ? "decision.undone" : "decision.note";
      await this.store.audit({ actor, action, projectId: ctx.test.projectId, modelSetId: ctx.test.modelSetId, testId: ctx.test.testKey, accTestId: ctx.test.testId, targetIds: [d.targetId, d.proposalId], details: { decisionId: d.id, reasonCode: d.reasonCode ?? null, viewedInViewerMs: d.viewedInViewerMs } });
      // Corrections and rejections feed the learning loop.
      if ((d.kind === "correct" || d.kind === "reject") && d.targetType === "group") {
        const vc = d.changes.find((c) => c.field === "validity");
        await this.core.recordFeedback(
          {
            target: { groupId: d.targetId, testKey: d.testId },
            verdict: d.kind === "reject" ? "incorrect" : "partially_correct",
            ...(vc ? { corrected: { validity: vc.humanValue } } : {}),
            coordinatorStatement: d.note ? d.note : `Decisión ${d.kind} ${d.reasonCode ?? ""}`.trim(),
            generalizable: d.suggestRule ? "yes" : "unsure",
            scope: d.suggestRule ? "project" : "this_group",
            reasonCode: d.reasonCode,
          },
          { actor },
          "decision",
        ).catch(() => undefined);
      }
      // Rejection of every target of a real proposal rejects it.
      if (d.kind === "reject") {
        const p = await this.store.getProposal(d.proposalId).catch(() => undefined);
        if (p && PENDING.has(p.state)) {
          const decided = await this.core.effectiveDecisions(d.testId);
          const allRejected = p.target.groupIds.every((g) => decided.get(g)?.kind === "reject");
          if (allRejected) await this.store.transitionProposal(p.id, "rejected", user.name, d.reasonCode);
        }
      }
    }
    return { saved };
  }

  async listDecisions(q: { testId?: string; projectId?: string; limit?: number; cursor?: string }): Promise<C.Page<C.Decision>> {
    const all = (await this.store.listDecisions()).filter((d) => (!q.testId || d.testId === q.testId) && (!q.projectId || bareProjectId(d.projectId) === bareProjectId(q.projectId)));
    const page = paginate(all.reverse(), Math.min(q.limit ?? 200, 1000), q.cursor);
    return { items: page.items.map((d) => this.decisionUi(d)), total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  // ── batches ──────────────────────────────────────────────────────────────

  private closeReason(validity: string, nature: string, reasonCode?: string): CloseReason {
    if (reasonCode === "R02") return "VALID_PENETRATION";
    if (reasonCode === "R03" || validity === "tolerated") return "MINIMAL_OVERLAP";
    if (reasonCode === "R11") return "FIELD_FIX";
    if (nature === "duplicate") return "OTHER";
    return validity === "false_positive" ? "MODEL_INACCURACY" : "OTHER";
  }

  /** Effective values: proposal view overridden by the human decision changes. */
  private effective(view: C.Proposal, d: DecisionRecord) {
    const get = <T>(field: string, ai: T): T => {
      const c = d.changes.find((x) => x.field === field);
      return c ? (c.humanValue as T) : ai;
    };
    const issueChange = d.changes.find((x) => x.field === "issueDraft");
    return {
      validity: get<C.Validity>("validity", view.fields.validity.value),
      priority: get<C.Priority>("priority", view.fields.priority.value),
      owner: get<string>("owner", view.fields.owner.value),
      action: get<C.ProposedAction>("action", view.fields.action.value),
      issue: issueChange ? ({ ...(view.issueDraft ?? {}), ...(issueChange.humanValue as object) } as C.IssueDraft) : view.issueDraft,
    };
  }

  private buildItems(batchId: string, test: TestRecord, cls: ClassificationRecord, g: GroupRecord, view: C.Proposal, d: DecisionRecord, accReason?: string): BatchItemRecord[] {
    const eff = this.effective(view, d);
    const members = cls.clashes.filter((c) => c.groupId === g.id);
    const origin: BatchItemRecord["origin"] = d.kind === "accept" ? "ai_accepted" : "ai_corrected";
    const proposalIds = view.sourceProposalIds;
    const common = {
      proposalIds,
      decisionIds: [d.id],
      groupId: g.id,
      origin,
      ...(d.reasonCode ? { reasonCode: d.reasonCode } : {}),
      reviewer: d.userName,
      aiConfidence: view.fields.validity.confidence,
      lowConfidence: view.fields.validity.confidence < this.bands.medium,
      viewedInViewer: d.viewedInViewerMs > 0,
    };
    const chunks: ClashRecord[][] = [];
    for (let i = 0; i < members.length; i += 1000) chunks.push(members.slice(i, i + 1000));
    const items: BatchItemRecord[] = [];
    chunks.forEach((chunk, ci) => {
      const suffix = chunks.length > 1 ? `#${ci + 1}` : "";
      const id = `I-${sha256(`${batchId}|${g.id}|${ci}`).slice(0, 10)}`;
      const clashes = chunk.map((c) => Number(c.id));
      if (eff.action.createIssue) {
        const issue = eff.issue ?? {
          title: g.title,
          description: view.rationale,
          ownerDiscipline: eff.owner,
          dueDate: new Date(this.core.now() + this.core.config.issues.defaultDueInDays * 86_400_000).toISOString().slice(0, 10),
          includeView: true,
          linkClashIds: g.clashIds.map((c) => `C-${c}`),
        };
        const vpId = (eff.issue as (C.IssueDraft & { viewpointClashId?: string }) | undefined)?.viewpointClashId;
        const rep =
          chunk.find((c) => c.id === vpId?.replace(/^C-/, "")) ??
          chunk.find((c) => c.id === g.representativeClashId) ??
          [...chunk].sort((a, b) => b.penetrationMm - a.penetrationMm || (a.id < b.id ? -1 : 1))[0]!;
        const doc = test.documents.find((x) => x.documentId === rep.a.documentId);
        const typeId = issue.issueType && /^[0-9a-f-]{36}$/i.test(issue.issueType) ? issue.issueType : this.core.config.issues.issueTypeId ?? (this.core.source.kind === "fixtures" ? "00000000-0000-4000-a000-00000000f1a7" : undefined);
        const subId = issue.issueSubtype && /^[0-9a-f-]{36}$/i.test(issue.issueSubtype) ? issue.issueSubtype : this.core.config.issues.issueSubtypeId ?? (this.core.source.kind === "fixtures" ? "00000000-0000-4000-a000-00000000f1a8" : undefined);
        const body: AssignedGroupCreate = {
          id: uuidFromHash(sha256(`${batchId}|${g.id}|${ci}|assign`)),
          title: (issue.title + suffix).slice(0, 100),
          description: issue.description.slice(0, 1000),
          ...(issue.assigneeId ? { assignedTo: issue.assigneeId, assignedToType: (issue.assigneeType === "company" ? "Company" : issue.assigneeType === "role" ? "Role" : "User") as "User" | "Role" | "Company" } : {}),
          dueDate: issue.dueDate,
          status: "Open",
          pushpin: {
            location: rep.a.bboxCenterM ?? { x: 0, y: 0, z: 0 },
            objectId: rep.a.dbId,
            ...(rep.a.externalId ? { externalId: rep.a.externalId } : {}),
            type: "TwoDVectorPushpin",
          },
          clashes,
          issueTypeId: typeId ?? "",
          issueSubTypeId: subId ?? "",
          documentVersionUrn: doc?.urn ?? "",
          ...(doc ? { viewableName: doc.viewableName } : {}),
        };
        const conflict = !typeId || !subId
          ? { reason: "Falta el tipo/subtipo de incidencia ACC (issues.issueTypeId / issueSubtypeId en coordinator.config.local.json)", accValueNow: null }
          : !doc || doc.urn.length > 80
            ? { reason: "documentVersionUrn ausente o > 80 caracteres", accValueNow: null }
            : undefined;
        items.push({
          ...common,
          id,
          targetType: "group",
          targetIds: chunk.map((c) => `C-${c.id}`),
          label: `${g.title}${suffix}`,
          operation: "issue.create",
          mcOperation: "clash.assign",
          fields: [
            { field: "issue", accCurrent: null, accNew: body.title },
            { field: "status", accCurrent: g.accStatus, accNew: "assigned" },
          ],
          accCurrent: { status: g.accStatus },
          accNew: body,
          excluded: !!conflict,
          ...(conflict ? { conflict } : {}),
          issue: { ...issue, ownerDiscipline: eff.owner, priorityLabel: `P${eff.priority}` },
        });
      } else if (eff.action.setStatus === "closed" || eff.action.setStatus === "reviewed") {
        const body: ClosedGroupCreate = {
          id: uuidFromHash(sha256(`${batchId}|${g.id}|${ci}|close`)),
          title: `${g.title}${suffix}`.slice(0, 128),
          description: `${view.rationale}`.slice(0, 1024),
          // MC has no "reviewed": mark_reviewed closes with a tolerance reason (contracts §status_change).
          reason: (accReason as CloseReason | undefined) ?? (eff.action.setStatus === "reviewed" ? "MINIMAL_OVERLAP" : this.closeReason(eff.validity, g.nature, d.reasonCode)),
          clashes,
        };
        items.push({
          ...common,
          id,
          targetType: "group",
          targetIds: chunk.map((c) => `C-${c.id}`),
          label: `${g.title}${suffix}`,
          operation: "clash.setStatus",
          mcOperation: "clash.close",
          fields: [{ field: "status", accCurrent: g.accStatus, accNew: "closed" }],
          accCurrent: { status: g.accStatus },
          accNew: body,
          excluded: eff.validity === "real",
          ...(eff.validity === "real" ? { conflict: { reason: "Cierre de un grupo de validez 'real': revisar antes de incluir", accValueNow: g.accStatus } } : {}),
        });
      } else if (eff.action.setStatus) {
        items.push({
          ...common,
          id,
          targetType: "group",
          targetIds: chunk.map((c) => `C-${c.id}`),
          label: `${g.title}${suffix}`,
          operation: "clash.setStatus",
          mcOperation: "none",
          fields: [{ field: "status", accCurrent: g.accStatus, accNew: eff.action.setStatus }],
          accNew: { status: eff.action.setStatus },
          excluded: true,
          conflict: { reason: `Model Coordination v3 no permite fijar '${eff.action.setStatus}' por API (solo asignar o cerrar)`, accValueNow: g.accStatus },
        });
      }
    });
    return items;
  }

  async sendToApproval(input: { projectId: string; modelSetId: string; testId: string }, user: HumanUser): Promise<C.Batch> {
    this.core.requireLevel(1, "Enviar a aprobación");
    const { test, cls, byGroup } = await this.testContext(input.testId);
    if (test.modelSetId !== input.modelSetId || bareProjectId(test.projectId) !== bareProjectId(input.projectId)) throw new CoordError("validation_error", "El test no pertenece a ese proyecto / conjunto.");
    const decided = await this.core.effectiveDecisions(test.testKey);
    const batchId = await this.store.newBatchId();
    const items: BatchItemRecord[] = [];
    const usedDecisions: string[] = [];
    for (const g of cls.groups) {
      const d = decided.get(g.id);
      if (!d || d.batchId || (d.kind !== "accept" && d.kind !== "correct")) continue;
      const view = this.proposalView(g, test, cls, byGroup.get(g.id) ?? []);
      const st = (byGroup.get(g.id) ?? []).filter((p) => p.payload.kind === "status_change" && p.state !== "withdrawn" && p.state !== "rejected").pop();
      const accReason = st?.payload.kind === "status_change" ? st.payload.accReason : undefined;
      const its = this.buildItems(batchId, test, cls, g, view, d, accReason);
      if (its.length) {
        items.push(...its);
        usedDecisions.push(d.id);
      }
    }
    if (items.length === 0) throw new CoordError("validation_error", "No hay decisiones aceptadas o corregidas pendientes de enviar a aprobación.");
    const now = nowIso(this.core.now());
    const batch: BatchRecord = {
      id: batchId,
      projectId: test.projectId,
      projectName: test.projectName,
      modelSetId: test.modelSetId,
      modelSetName: test.modelSetName,
      testKey: test.testKey,
      testId: test.testId,
      testDate: test.completedOn ?? test.ingestedAt,
      modelSetVersion: test.modelSetVersion,
      state: "ready",
      createdBy: user.name,
      createdAt: now,
      updatedAt: now,
      items,
    };
    await this.store.putBatch(batch);
    await this.store.markDecisionsBatched(usedDecisions, batchId);
    await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: "batch.ready", projectId: test.projectId, modelSetId: test.modelSetId, testId: test.testKey, accTestId: test.testId, batchId, details: { items: items.length } });
    return this.batchUi(batch);
  }

  async batchUi(b: BatchRecord): Promise<C.Batch> {
    const latest = await this.core.source.latestVersion(b.projectId, b.modelSetId).catch(() => b.modelSetVersion);
    const inc = b.items.filter((i) => !i.excluded);
    // Status changes = clash.setStatus items only (clashes:close). Issue items (clashes:assign) are
    // reported separately in issueEffects: they link clashes to an issue, they are not status changes.
    const trans = new Map<string, number>();
    for (const i of inc) {
      if (i.operation !== "clash.setStatus") continue;
      for (const f of i.fields) if (f.field === "status") {
        const k = `${String(f.accCurrent)}→${String(f.accNew)}`;
        trans.set(k, (trans.get(k) ?? 0) + i.targetIds.length);
      }
    }
    const issueItems = inc.filter((i) => i.operation === "issue.create");
    const byDisc: Record<string, number> = {};
    for (const i of inc) if (i.operation === "issue.create") byDisc[String(i.issue?.ownerDiscipline ?? "?")] = (byDisc[String(i.issue?.ownerDiscipline ?? "?")] ?? 0) + 1;
    const appr = await this.store.getApproval(b.id);
    let approval: C.Batch["approval"];
    if (appr) {
      const v = await verifyBatchApproval(this.approvalDeps(), b.id);
      approval = { approvedBy: appr.approvedBy.name, approvedAt: appr.approvedAt, expiresAt: appr.expiresAt, channel: appr.approvedBy.channel, valid: v.ok, ...(v.ok ? {} : { reason: v.reason }) };
    }
    const low = inc.filter((i) => i.lowConfidence);
    return {
      id: b.id,
      projectId: bareProjectId(b.projectId),
      projectName: b.projectName,
      modelSetId: b.modelSetId,
      modelSetName: b.modelSetName,
      testId: b.testKey,
      testDate: b.testDate,
      modelSetVersion: b.modelSetVersion,
      latestVersion: latest,
      state: b.state,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      ...(b.approvedBy ? { approvedBy: b.approvedBy, approvedAt: b.approvedAt } : {}),
      ...(b.appliedAt ? { appliedAt: b.appliedAt } : {}),
      stale: latest !== b.modelSetVersion,
      counts: {
        issuesCreate: inc.filter((i) => i.operation === "issue.create").length,
        statusChanges: inc.filter((i) => i.operation === "clash.setStatus").reduce((n, i) => n + i.targetIds.length, 0),
        assignments: 0,
        comments: 0,
      },
      origin: { accepted: inc.filter((i) => i.origin === "ai_accepted").length, corrected: inc.filter((i) => i.origin === "ai_corrected").length, manual: inc.filter((i) => i.origin === "manual").length },
      review: { humanReviewedPct: 100, lowConfidence: low.length, lowConfidenceViewed: low.filter((i) => i.viewedInViewer).length },
      statusTransitions: [...trans.entries()].map(([k, count]) => {
        const [from, to] = k.split("→");
        return { from: from as C.AccStatus, to: to as C.AccStatus, count };
      }),
      issueEffects: { issues: issueItems.length, clashesLinked: issueItems.reduce((n, i) => n + i.targetIds.length, 0) },
      issuesByDiscipline: byDisc,
      ...(b.lastPreflightAt ? { lastPreflightAt: b.lastPreflightAt } : {}),
      ...(approval ? { approval } : {}),
      items: b.items.map((i) => ({
        id: i.id,
        decisionIds: i.decisionIds,
        proposalIds: i.proposalIds,
        targetType: i.targetType,
        targetIds: i.targetIds,
        label: i.label,
        ...(i.groupId ? { groupId: i.groupId } : {}),
        operation: i.operation,
        mcOperation: i.mcOperation,
        fields: i.fields,
        ...(i.accCurrent !== undefined ? { accCurrent: i.accCurrent } : {}),
        accNew: i.accNew,
        origin: i.origin,
        ...(i.reasonCode ? { reasonCode: i.reasonCode } : {}),
        reviewer: i.reviewer,
        ...(i.aiConfidence !== undefined ? { aiConfidence: i.aiConfidence } : {}),
        lowConfidence: !!i.lowConfidence,
        viewedInViewer: !!i.viewedInViewer,
        excluded: i.excluded,
        ...(i.conflict ? { conflict: i.conflict } : {}),
        ...(i.issue ? { issue: i.issue as unknown as C.IssueDraft } : {}),
        ...(i.result ? { result: i.result } : {}),
      })),
    };
  }

  async listBatches(q: { state?: string[]; projectId?: string } = {}): Promise<C.BatchSummary[]> {
    const all = (await this.store.listBatches()).filter((b) => (!q.state?.length || q.state.includes(b.state)) && (!q.projectId || bareProjectId(b.projectId) === bareProjectId(q.projectId)));
    const out: C.BatchSummary[] = [];
    for (const b of all.sort((a, b) => (a.state === "ready" ? 0 : 1) - (b.state === "ready" ? 0 : 1) || (a.createdAt < b.createdAt ? 1 : -1))) {
      const { items: _items, ...rest } = await this.batchUi(b);
      void _items;
      out.push(rest);
    }
    return out;
  }

  private async requireBatch(id: string): Promise<BatchRecord> {
    const b = await this.store.getBatch(id);
    if (!b) throw new CoordError("not_found", `Lote ${id} no existe`);
    return b;
  }

  async getBatch(id: string): Promise<C.Batch> {
    return this.batchUi(await this.requireBatch(id));
  }

  async preflight(id: string, user: HumanUser): Promise<C.PreflightResult> {
    return withBatchLock(this.store, async () => {
      const b = await this.requireBatch(id);
      const at = nowIso(this.core.now());
      let conflicts = 0;
      if (b.state === "draft" || b.state === "ready") {
        const st = await this.core.source.triageState(b.projectId, b.testId);
        for (const i of b.items) {
          if (i.mcOperation === "none") continue;
          const closed = i.targetIds.filter((t) => st.closed.has(t.replace(/^C-/, ""))).length;
          const assigned = i.targetIds.filter((t) => st.assigned.has(t.replace(/^C-/, ""))).length;
          if (closed || assigned) {
            conflicts++;
            i.conflict = { reason: `En ACC ya hay ${closed} cerradas y ${assigned} con incidencia`, accValueNow: { closed, assigned } };
            i.excluded = true;
          }
        }
        b.lastPreflightAt = at;
        await this.store.putBatch(b);
      }
      await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: "preflight.run", projectId: b.projectId, batchId: id, details: { conflicts } });
      return { at, conflicts, batch: await this.batchUi(b) };
    });
  }

  /** Any edit is allowed only before approval (draft/ready); an approved batch must be returned first. */
  private editable(b: BatchRecord): void {
    if (b.state !== "draft" && b.state !== "ready") throw new CoordError("invalid_state", `El lote está ${b.state}; devuélvelo a revisión para modificarlo (la aprobación se anula).`);
  }

  async setItemsExcluded(id: string, itemIds: string[], excluded: boolean): Promise<C.Batch> {
    return withBatchLock(this.store, async () => {
      const b = await this.requireBatch(id);
      this.editable(b);
      const set = new Set(itemIds);
      for (const i of b.items) if (set.has(i.id)) {
        if (!excluded && i.mcOperation === "none") continue;
        i.excluded = excluded;
      }
      await this.store.putBatch(b);
      return this.batchUi(b);
    });
  }

  async updateIssue(id: string, itemId: string, patch: Partial<C.IssueDraft>): Promise<C.Batch> {
    return withBatchLock(this.store, async () => {
      const b = await this.requireBatch(id);
      this.editable(b);
      const it = b.items.find((i) => i.id === itemId);
      if (!it || it.mcOperation !== "clash.assign") throw new CoordError("not_found", `Ítem de incidencia ${itemId} no existe`);
      const body = it.accNew as AssignedGroupCreate;
      if (patch.title !== undefined) body.title = sanitizeModelText(patch.title, 100);
      if (patch.description !== undefined) body.description = patch.description.replace(/\u0000/g, "").slice(0, 1000);
      if (patch.dueDate !== undefined) body.dueDate = patch.dueDate;
      if (patch.assigneeId !== undefined) {
        body.assignedTo = patch.assigneeId;
        body.assignedToType = patch.assigneeType === "company" ? "Company" : patch.assigneeType === "role" ? "Role" : "User";
      }
      if (patch.issueType && /^[0-9a-f-]{36}$/i.test(patch.issueType)) body.issueTypeId = patch.issueType;
      if (patch.issueSubtype && /^[0-9a-f-]{36}$/i.test(patch.issueSubtype)) body.issueSubTypeId = patch.issueSubtype;
      it.issue = { ...(it.issue ?? {}), ...patch };
      it.fields = it.fields.map((f) => (f.field === "issue" ? { ...f, accNew: body.title } : f));
      if (it.conflict && body.issueTypeId && body.issueSubTypeId && it.conflict.reason.startsWith("Falta el tipo")) delete it.conflict;
      if (it.origin === "ai_accepted") it.origin = "ai_corrected";
      it.reasonCode = "R13";
      await this.store.putBatch(b);
      return this.batchUi(b);
    });
  }

  /** Back to review: the approval record is deleted (any later apply is refused). */
  async returnToReview(id: string, user: HumanUser): Promise<C.Batch> {
    return withBatchLock(this.store, async () => {
      const b = await this.requireBatch(id);
      const updated = await this.store.transitionBatch(id, "draft");
      await this.store.deleteApproval(id);
      await this.store.markDecisionsBatched(b.items.flatMap((i) => i.decisionIds), undefined);
      for (const pid of new Set(b.items.flatMap((i) => i.proposalIds))) {
        const p = await this.store.getProposal(pid);
        if (p?.state === "approved") await this.store.transitionProposal(pid, "pending_review", user.name, `lote ${id} devuelto`);
      }
      await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: "batch.returned", projectId: b.projectId, batchId: id });
      return this.batchUi(updated);
    });
  }

  async discard(id: string, user: HumanUser): Promise<C.Batch> {
    return withBatchLock(this.store, async () => {
      const b = await this.requireBatch(id);
      const updated = await this.store.transitionBatch(id, "discarded");
      await this.store.deleteApproval(id);
      await this.store.markDecisionsBatched(b.items.flatMap((i) => i.decisionIds), undefined);
      await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: "batch.discarded", projectId: b.projectId, batchId: id });
      return this.batchUi(updated);
    });
  }

  /**
   * Step 1 of the approval ceremony: WebAuthn options whose challenge is derived
   * from the batch payload (with the requested exclusions applied).
   */
  async approveOptions(id: string, excludedItemIds: string[] = []) {
    const r = await approvalOptions(this.approvalDeps(), id, excludedItemIds);
    return { batchId: r.batchId, nonce: r.nonce, payloadHash: r.payloadHash, testVersion: r.testVersion, items: r.items, options: r.options };
  }

  /**
   * Step 2: HUMAN approval. Live mode requires the WebAuthn assertion produced
   * for the options of step 1; fixtures mode accepts `demo: true` (labelled demo
   * approval). Never applies: apply is always a separate call.
   */
  async approve(id: string, req: C.ApproveRequest, user: HumanUser): Promise<C.ApplyStatus> {
    const b = await this.requireBatch(id);
    const inc = b.items.filter((i) => !i.excluded && !(req.excludedItemIds ?? []).includes(i.id));
    const issues = inc.filter((i) => i.operation === "issue.create").length;
    const changes = inc.reduce((n, i) => n + i.targetIds.length, 0);
    if ((issues > 0 || changes >= 50) && !/^(aplicar|apply)$/i.test(req.confirmWord.trim())) {
      throw new CoordError("validation_error", "Escribe APLICAR para confirmar.");
    }
    if (!b.lastPreflightAt || this.core.now() - Date.parse(b.lastPreflightAt) > 10 * 60_000) {
      if (req.webauthn) throw new CoordError("conflict", "El pre-chequeo con ACC tiene más de 10 minutos: ejecútalo y pide opciones de aprobación nuevas.");
      await this.preflight(id, user);
    }
    await approveBatch(this.approvalDeps(), id, { id: user.id, name: user.name, channel: "web-ui" }, {
      ...(req.note ? { note: req.note } : {}),
      excludedItemIds: req.excludedItemIds,
      ...(req.webauthn ? { webauthn: req.webauthn as never } : {}),
      ...(req.demo ? { demo: true } : {}),
    });
    return this.applyStatus(id);
  }

  async webauthnRegisterOptions(user: HumanUser) {
    return this.core.webauthn.registrationOptions(user.name);
  }

  async webauthnRegister(input: { origin: string; response: unknown; label?: string; enrollCode?: string; stepUp?: unknown }, user: HumanUser) {
    const cred = await this.core.webauthn.register(input as never);
    await this.store.audit({
      actor: { type: "user", id: user.id, name: user.name },
      action: "webauthn.enrolled",
      targetIds: [cred.id],
      details: { label: cred.label, via: cred.enrolledVia, credentialId: cred.id },
    });
    return { credentialId: cred.id, label: cred.label, enrolledVia: cred.enrolledVia };
  }

  async apply(id: string, req: C.ApplyRequest, actor: Actor): Promise<C.ApplyResponse> {
    const r = await applyApproved(this.approvalDeps(), id, { dryRun: req.dryRun !== false, actor });
    return {
      dryRun: r.dryRun,
      ok: r.ok,
      ...(r.refused ? { refused: r.refused } : {}),
      requests: r.requests,
      status: await this.applyStatus(id),
    };
  }

  async applyStatus(id: string): Promise<C.ApplyStatus> {
    const b = await this.requireBatch(id);
    const inc = b.items.filter((i) => !i.excluded && i.mcOperation !== "none");
    const iss = inc.filter((i) => i.mcOperation === "clash.assign");
    const st = inc.filter((i) => i.mcOperation === "clash.close");
    return {
      batchId: id,
      state: b.state,
      issues: { done: iss.filter((i) => i.result?.status === "applied").length, total: iss.length },
      statuses: { done: st.filter((i) => i.result?.status === "applied").reduce((n, i) => n + i.targetIds.length, 0), total: st.reduce((n, i) => n + i.targetIds.length, 0) },
      log: b.apply?.log ?? [],
      failures: inc.filter((i) => i.result?.status === "failed").map((i) => ({ itemId: i.id, label: i.label, message: i.result?.message ?? "error" })),
    };
  }

  // ── learning ─────────────────────────────────────────────────────────────

  async submitFeedback(input: C.FeedbackInput, user: HumanUser) {
    const target = "proposalId" in input.target ? { proposalId: input.target.proposalId } : { groupId: input.target.groupId, testKey: input.target.testId };
    const r = await this.core.recordFeedback({ ...input, target, corrected: input.corrected as Record<string, unknown> | undefined }, { actor: { type: "user", id: user.id, name: user.name } }, "ui");
    return { feedbackId: r.feedbackId };
  }

  private async ruleStats() {
    const decisions = await this.store.listDecisions();
    const tests = await this.store.listTests();
    const hits = new Map<string, number>();
    const accepted = new Map<string, number>();
    const corrected = new Map<string, number>();
    const decidedFor = new Map<string, number>();
    const weekAgo = this.core.now() - 7 * 86_400_000;
    for (const t of tests) {
      const cls = await this.store.getClassification(t.testKey);
      if (!cls) continue;
      const recent = Date.parse(cls.createdAt) >= weekAgo;
      if (recent) for (const c of cls.clashes) if (c.ruleId) hits.set(c.ruleId, (hits.get(c.ruleId) ?? 0) + 1);
      const gById = new Map(cls.groups.map((g) => [g.id, g]));
      for (const d of decisions.filter((x) => x.testId === t.testKey && x.targetType === "group")) {
        const g = gById.get(d.targetId);
        const r = g?.ruleIds[0];
        if (!r) continue;
        decidedFor.set(r, (decidedFor.get(r) ?? 0) + 1);
        if (d.kind === "accept") accepted.set(r, (accepted.get(r) ?? 0) + 1);
        if (d.kind === "correct" || d.kind === "reject") corrected.set(r, (corrected.get(r) ?? 0) + 1);
      }
    }
    return { hits, accepted, corrected, decidedFor };
  }

  async rules(): Promise<C.RuleSummary[]> {
    const rs = loadRules();
    const s = await this.ruleStats();
    const { stat } = await import("node:fs/promises");
    const rulesFile = join(this.core.root, "rules", "classification-rules.yaml");
    const updatedAt = await stat(rulesFile).then((st) => st.mtime.toISOString()).catch(() => "");
    return rs.source.classification.rules.map((r) => ({
      id: r.id,
      name: r.name,
      scope: JSON.stringify(r.when).slice(0, 120),
      effect: "validity" as const,
      state: "active" as const,
      hits7d: s.hits.get(r.id) ?? 0,
      acceptance: s.decidedFor.get(r.id) ? round((s.accepted.get(r.id) ?? 0) / s.decidedFor.get(r.id)!, 3) : null,
      corrections: s.corrected.get(r.id) ?? 0,
      updatedAt,
      file: "rules/classification-rules.yaml",
    }));
  }

  async rule(ruleId: string): Promise<C.RuleDetail> {
    const rs = loadRules();
    const r = rs.source.classification.rules.find((x) => x.id === ruleId);
    if (!r) throw new CoordError("not_found", `Regla ${ruleId} no existe`);
    const summary = (await this.rules()).find((x) => x.id === ruleId)!;
    const reasons = new Map<string, number>();
    const recentHits: C.RuleDetail["recentHits"] = [];
    for (const t of await this.store.listTests()) {
      const cls = await this.store.getClassification(t.testKey);
      if (!cls) continue;
      const decided = await this.core.effectiveDecisions(t.testKey);
      for (const g of cls.groups.filter((x) => x.ruleIds.includes(ruleId)).slice(0, 20)) {
        const d = decided.get(g.id);
        if (d?.reasonCode) reasons.set(d.reasonCode, (reasons.get(d.reasonCode) ?? 0) + 1);
        recentHits.push({ groupId: g.id, projectId: bareProjectId(t.projectId), modelSetId: t.modelSetId, title: g.title, decision: d ? d.kind : "pending", at: cls.createdAt });
      }
    }
    const { stringify } = await import("yaml");
    return {
      ...summary,
      description: r.then.rationale,
      conditions: Object.entries(r.when).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      yaml: stringify([r]),
      recentHits: recentHits.slice(0, 50),
      reasonDistribution: [...reasons.entries()].map(([code, count]) => ({ code: code as C.ReasonCode, count })),
    };
  }

  async ruleSuggestions(): Promise<C.RuleSuggestion[]> {
    const { readFile } = await import("node:fs/promises");
    const ps = await this.store.listProposals((p) => p.kind === "rule_change");
    const out: C.RuleSuggestion[] = [];
    for (const p of ps) {
      if (p.payload.kind !== "rule_change") continue;
      const patch = await readFile(p.payload.patchFile, "utf8").catch(() => "");
      const raw = p.payload.evaluation;
      const ev = {
        baselineMacroF1: raw.baselineMacroF1 ?? (raw.baselineRubricScore ?? 0) / 100,
        candidateMacroF1: raw.candidateMacroF1 ?? (raw.candidateRubricScore ?? 0) / 100,
        unsafeClosureRate: raw.unsafeClosureRate ?? 0,
      };
      out.push({
        id: p.id,
        title: p.payload.title,
        count: p.payload.feedbackIds.length,
        reasonCode: "R99",
        pair: "",
        summary: p.rationale,
        patch,
        affected: p.payload.feedbackIds.length,
        evaluation: ev,
        state: p.state === "approved" || p.state === "applied" ? "approved" : p.state === "rejected" || p.state === "withdrawn" ? "rejected" : "pending",
        createdAt: p.createdAt,
      });
    }
    return out;
  }

  /** Human decision on a rule suggestion. Approval does NOT edit rules/: a human merges the patch with git. */
  async decideRuleSuggestion(id: string, decision: "approve" | "reject", user: HumanUser): Promise<C.RuleSuggestion> {
    const p = await this.store.getProposal(id);
    if (!p || p.kind !== "rule_change") throw new CoordError("not_found", `Sugerencia ${id} no existe`);
    await this.store.transitionProposal(id, decision === "approve" ? "approved" : "rejected", user.name);
    if (p.payload.kind === "rule_change") {
      const fb = new Set(p.payload.feedbackIds);
      const all = await this.store.listFeedback();
      if (all.some((f) => fb.has(f.id))) {
        const { writeFileAtomic } = await import("./store/fs");
        await this.store.withLock(async () => {
          const cur = await this.store.listFeedback();
          for (const f of cur) if (fb.has(f.id)) f.curated = true;
          await writeFileAtomic(this.store.path("feedback", "feedback.jsonl"), cur.map((f) => JSON.stringify(f)).join("\n") + "\n");
        });
      }
    }
    await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: decision === "approve" ? "rule.approved" : "rule.rejected", targetIds: [id] });
    return (await this.ruleSuggestions()).find((s) => s.id === id)!;
  }

  async corrections(q: { projectId?: string; limit?: number; cursor?: string }): Promise<C.Page<C.CorrectionRow>> {
    const decisions = (await this.store.listDecisions()).filter((d) => (d.kind === "correct" || d.kind === "reject") && (!q.projectId || bareProjectId(d.projectId) === bareProjectId(q.projectId)));
    const rows: C.CorrectionRow[] = [];
    const titleCache = new Map<string, ClassificationRecord | undefined>();
    for (const d of decisions.reverse()) {
      if (!titleCache.has(d.testId)) titleCache.set(d.testId, await this.store.getClassification(d.testId).catch(() => undefined));
      const g = titleCache.get(d.testId)?.groups.find((x) => x.id === d.targetId);
      const base = { decisionId: d.id, at: d.decidedAt, userName: d.userName, targetId: d.targetId, targetLabel: g?.title ?? d.targetId, ...(d.reasonCode ? { reasonCode: d.reasonCode } : {}), ...(d.note ? { note: d.note } : {}), ruleIds: g?.ruleIds ?? [] };
      if (d.kind === "reject") rows.push({ ...base, field: "reject", aiValue: "", humanValue: "rechazada" });
      for (const c of d.changes) rows.push({ ...base, field: c.field as C.DecisionField, aiValue: JSON.stringify(c.aiValue), humanValue: JSON.stringify(c.humanValue), ...(c.aiConfidence !== undefined ? { confidence: c.aiConfidence } : {}) });
    }
    const page = paginate(rows, Math.min(q.limit ?? 100, 1000), q.cursor);
    return { items: page.items, total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async calibration(): Promise<C.Calibration> {
    const bandsOf = () => ({ alta: { proposals: 0, acceptedUnchanged: 0 }, media: { proposals: 0, acceptedUnchanged: 0 }, baja: { proposals: 0, acceptedUnchanged: 0 } });
    const all = bandsOf();
    const byField = { validity: { rule: bandsOf(), llm: bandsOf() }, priority: { rule: bandsOf(), llm: bandsOf() }, owner: { rule: bandsOf(), llm: bandsOf() } };
    let spotReviewed = 0;
    let spotCorrected = 0;
    for (const t of await this.store.listTests()) {
      const cls = await this.store.getClassification(t.testKey);
      if (!cls) continue;
      const decided = await this.core.effectiveDecisions(t.testKey);
      const byGroup = await this.core.proposalsByGroup(t.testKey, cls);
      for (const g of cls.groups) {
        const d = decided.get(g.id);
        if (!d || (d.kind !== "accept" && d.kind !== "correct" && d.kind !== "reject")) continue;
        const view = this.proposalView(g, t, cls, byGroup.get(g.id) ?? []);
        const band = confBand(view.fields.validity.confidence, this.bands);
        all[band].proposals++;
        if (d.kind === "accept") all[band].acceptedUnchanged++;
        for (const f of ["validity", "priority", "owner"] as const) {
          const src = view.fields[f].source === "rule" ? "rule" : "llm";
          const b = confBand(view.fields[f].confidence, this.bands);
          byField[f][src][b].proposals++;
          if (d.kind === "accept" || (d.kind === "correct" && !d.changes.some((c) => c.field === f))) byField[f][src][b].acceptedUnchanged++;
        }
        if (view.spotCheck) {
          spotReviewed++;
          if (d.kind !== "accept") spotCorrected++;
        }
      }
    }
    const toBands = (x: ReturnType<typeof bandsOf>): C.CalibrationBand[] => (["alta", "media", "baja"] as const).map((band) => ({ band, ...x[band] }));
    return {
      thresholds: this.bands,
      minDecisions: 50,
      bands: toBands(all),
      byField: (["validity", "priority", "owner"] as const).flatMap((field) => (["rule", "llm"] as const).map((source) => ({ field, source, bands: toBands(byField[field][source]) }))),
      spotCheck: { reviewed: spotReviewed, corrected: spotCorrected },
    };
  }

  // ── reports / audit / home ───────────────────────────────────────────────

  async report(scope: C.ReportScope): Promise<C.ReportData> {
    const inRange = (iso: string) => (!scope.from || iso >= scope.from) && (!scope.to || iso <= `${scope.to}￿`);
    const tests = (await this.store.listTests())
      .filter((t) => (!scope.projectId || bareProjectId(t.projectId) === bareProjectId(scope.projectId)) && (!scope.modelSetId || t.modelSetId === scope.modelSetId))
      .sort((a, b) => a.modelSetVersion - b.modelSetVersion);
    const classified: Array<{ t: TestRecord; cls: ClassificationRecord }> = [];
    for (const t of tests) {
      const cls = await this.store.getClassification(t.testKey);
      if (cls) classified.push({ t, cls });
    }
    const latest = classified[classified.length - 1];
    const prev = classified[classified.length - 2];
    const decisions = (await this.store.listDecisions()).filter((d) => tests.some((t) => t.testKey === d.testId) && inRange(d.decidedAt));
    const audit = (await this.store.listAudit()).filter((e) => inRange(e.at) && (!scope.projectId || bareProjectId(e.projectId || "") === bareProjectId(scope.projectId)));
    const latestDecided = latest ? await this.core.effectiveDecisions(latest.t.testKey) : new Map<string, DecisionRecord>();
    const active = (c?: { cls: ClassificationRecord }) => (c ? c.cls.clashes.filter((x) => x.status === "active").length : 0);
    const disciplines = new Set<string>();
    const matrix: Record<string, Record<string, number>> = {};
    const byPair = new Map<string, { active: number; reviewed: number; resolved: number; closed: number }>();
    if (latest) {
      for (const c of latest.cls.clashes) {
        const [a, b] = c.disciplinePair.split("×");
        disciplines.add(a!);
        disciplines.add(b!);
        const row = byPair.get(c.disciplinePair) ?? { active: 0, reviewed: 0, resolved: 0, closed: 0 };
        row[c.status]++;
        byPair.set(c.disciplinePair, row);
        if (c.status === "active" && c.validity === "real") {
          (matrix[a!] ??= {})[b!] = (matrix[a!]![b!] ?? 0) + 1;
          if (a !== b) (matrix[b!] ??= {})[a!] = (matrix[b!]![a!] ?? 0) + 1;
        }
      }
    }
    const reasons = new Map<string, number>();
    for (const d of decisions) if (d.reasonCode) reasons.set(d.reasonCode, (reasons.get(d.reasonCode) ?? 0) + 1);
    const aging = { lt1w: 0, w1to2: 0, w2to4: 0, gt4w: 0 };
    if (latest) {
      for (const g of latest.cls.groups.filter((x) => x.band === 1 && !latestDecided.has(x.id))) {
        const since = g.delta === "persisting" || g.delta === "modified" ? prev?.t.completedOn ?? latest.t.completedOn : latest.t.completedOn;
        const days = since ? (this.core.now() - Date.parse(since)) / 86_400_000 : 0;
        if (days < 7) aging.lt1w++;
        else if (days < 14) aging.w1to2++;
        else if (days < 28) aging.w2to4++;
        else aging.gt4w++;
      }
    }
    const calib = await this.calibration();
    const decidedClashes = latest ? latest.cls.groups.filter((g) => latestDecided.has(g.id)).reduce((n, g) => n + g.clashIds.length, 0) : 0;
    return {
      scope,
      kpis: {
        activeClashes: active(latest),
        activeClashesPrev: prev ? active(prev) : null,
        groups: latest?.cls.groups.length ?? 0,
        rawClashes: latest?.cls.clashes.length ?? 0,
        groupsReviewed: latestDecided.size,
        issuesCreated: audit.filter((e) => e.action === "acc.issue.created").reduce((n, e) => n + Number(e.details.groups ?? 0), 0),
        aiAccepted: decisions.filter((d) => d.kind === "accept").length,
        aiCorrected: decisions.filter((d) => d.kind === "correct").length,
        aiRejected: decisions.filter((d) => d.kind === "reject").length,
        rawClashesReviewed: decidedClashes,
        actualReviewSeconds: Math.round(decisions.reduce((n, d) => n + (d.viewedInViewerMs || 0), 0) / 1000),
      },
      burndown: classified.map(({ t, cls }) => {
        const s = { active: 0, reviewed: 0, resolved: 0, closed: 0 };
        for (const c of cls.clashes) s[c.status]++;
        return { label: `${(t.completedOn ?? t.ingestedAt).slice(0, 10)} · v${t.modelSetVersion}`, ...s, valid: cls.clashes.filter((c) => c.validity === "real").length };
      }),
      disciplines: [...disciplines].sort(),
      matrix,
      byStatusPair: [...byPair.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([pair, v]) => ({ pair, ...v })),
      newVsResolved: classified.map(({ t, cls }) => ({ label: `v${t.modelSetVersion}`, new: cls.clashes.filter((c) => c.delta === "new" || c.delta === "reappeared").length, resolved: cls.resolvedSincePrevious.length })),
      reasons: [...reasons.entries()].map(([code, count]) => ({ code: code as C.ReasonCode, count })),
      calibration: calib.bands,
      p1Aging: aging,
    };
  }

  async audit(q: C.AuditQuery): Promise<C.Page<C.AuditEvent>> {
    const ev = (await this.store.listAudit())
      .filter(
        (e) =>
          e.action !== "tool.call" &&
          (!q.project || bareProjectId(e.projectId || "") === bareProjectId(q.project)) &&
          (!q.user || e.actor.name === q.user || e.actor.id === q.user) &&
          (!q.action || e.action.startsWith(q.action)) &&
          (!q.from || e.at >= q.from) &&
          (!q.to || e.at <= `${q.to}￿`) &&
          (!q.batch || e.batchId === q.batch),
      )
      .reverse();
    const page = paginate(ev, Math.min(q.limit ?? 100, 1000), q.cursor);
    return {
      items: page.items.map((e) => ({
        id: e.id, at: e.at, actor: e.actor, action: e.action, projectId: bareProjectId(e.projectId || ""), ...(e.modelSetId ? { modelSetId: e.modelSetId } : {}),
        ...(e.testId ? { testId: e.testId } : {}), ...(e.accTestId ? { accTestId: e.accTestId } : {}), ...(e.batchId ? { batchId: e.batchId } : {}), targetIds: e.targetIds, details: e.details,
        ...(e.accResponseId ? { accResponseId: e.accResponseId } : {}), hash: e.hash,
      })),
      total: page.total,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async home(): Promise<C.HomeSummary> {
    const user = await this.me().catch(() => ({ id: "anon", name: "Coordinador", initials: "C" }));
    const queue: C.HomeSummary["queue"] = [];
    const tests = await this.store.listTests();
    const latestBySet = new Map<string, TestRecord>();
    for (const t of tests) if ((latestBySet.get(t.modelSetId)?.modelSetVersion ?? -1) < t.modelSetVersion && (await this.store.getClassification(t.testKey))) latestBySet.set(t.modelSetId, t);
    for (const t of latestBySet.values()) queue.push({ projectId: bareProjectId(t.projectId), projectName: t.projectName, modelSetId: t.modelSetId, modelSetName: t.modelSetName, pending: await this.pendingCount(t) });
    const activity = (await this.store.listAudit())
      .filter((e) => e.action !== "tool.call")
      .slice(-10)
      .reverse()
      .map((e) => ({ at: e.at, text: `${e.actor.name}: ${e.action}${e.details.groups !== undefined ? ` (${e.details.groups} grupos)` : ""}` }));
    return {
      user,
      queue,
      batches: await this.listBatches({ state: ["ready", "approved", "partial"] }),
      activity,
      kpis: (await this.report({})).kpis,
    };
  }

  async notes(projectId: string): Promise<C.ProjectNotes> {
    return this.core.getNotes(withB(projectId));
  }

  async appendNote(projectId: string, text: string, kind: string | undefined, user: HumanUser): Promise<C.ProjectNotes> {
    return this.core.appendNote({ projectId: withB(projectId), text, kind }, { actor: { type: "user", id: user.id, name: user.name } });
  }
}

export { AGENT_ACTOR };
