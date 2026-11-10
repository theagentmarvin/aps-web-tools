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
import { assertCode, modelLevelDiscipline, outCode, ruleMatches, SIN, suggestedToken, validCodes, type DisciplineRule } from "./disciplines";
import { sanitizeModelText } from "./sanitize";
import { PROBLEM_TYPES } from "../core/families";
import { aggregateAcc, emptyCounts, itemChange, mergeAcc, type AccIndex } from "./cycle";
import { questionView, type StoredQuestion } from "./questions";
import { markFrozen } from "./api/frozen";
import { buildReminders, issueGate } from "./issue-checks";
import type { ClashDiff } from "../core/types";

interface CycleCtx {
  baseReason: "last_reviewed" | "previous";
  inherited: Map<string, C.InheritedDecision>;
  questions: StoredQuestion[];
  acc: AccIndex;
  resolvedByGroup: ReadonlyMap<string, number>;
  sync?: C.AccSyncSummary;
  changes: ReadonlyMap<string, C.ChangeKind>;
  diff?: ClashDiff;
  previous?: TestRecord;
}
import { assertFamilyInTest, familyIssueDescription, type FamilyDecisionFields, type FamilyView } from "./families";
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
import { applyPlan, isRegroup, planRegroup, type RegroupAction } from "./regroup";
import { pathSegment } from "./store";
import { bareProjectId, CoordError, nowIso, paginate, plural, round, sha256, uuidFromHash } from "./util";

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
  // ── short-lived caches (performance: ACC / APS reads on every page load) ──

  private readonly ttlCache = new Map<string, { at: number; value: unknown }>();
  private async ttl<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.ttlCache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value as T;
    const value = await fn();
    this.ttlCache.set(key, { at: Date.now(), value });
    return value;
  }
  /** Drop cached session / ACC reads (login, logout). */
  invalidateCaches(): void {
    this.ttlCache.clear();
    this.triageMemo.clear();
  }

  async currentUser(): Promise<HumanUser | undefined> {
    const st = await this.core.source.authStatus().catch(() => undefined);
    const u = await this.ttl(`user:${st?.loggedIn ? "in" : "out"}:${st?.expiresAt ?? ""}`, 60_000, () => this.core.source.currentUser().catch(() => undefined));
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

  /** Model set counts per project: one ACC call per project, so cache them briefly. */
  private readonly modelSetCountCache = new Map<string, { n: number; at: number }>();
  private static readonly MODEL_SET_COUNT_TTL_MS = 60_000;

  private async modelSetCount(projectId: string, fallback: number): Promise<number> {
    const key = bareProjectId(projectId);
    const hit = this.modelSetCountCache.get(key);
    if (hit && Date.now() - hit.at < CoordinatorUi.MODEL_SET_COUNT_TTL_MS) return hit.n;
    const sets = await this.core.source.listModelSets(projectId).catch(() => undefined);
    if (!sets) return fallback;
    this.modelSetCountCache.set(key, { n: sets.length, at: Date.now() });
    return sets.length;
  }

  private async summarize(p: { id: string; name: string; hubId: string; hubName?: string }, tests: TestRecord[]): Promise<C.ProjectSummary> {
    const mine = tests.filter((t) => bareProjectId(t.projectId) === bareProjectId(p.id));
    let pending = 0;
    for (const t of mine) pending += await this.pendingCount(t);
    const modelSetCount = await this.modelSetCount(p.id, new Set(mine.map((t) => t.modelSetId)).size);
    return { id: bareProjectId(p.id), name: p.name, hubId: p.hubId, hubName: p.hubName, modelSetCount, pendingDecisions: pending } as C.ProjectSummary;
  }

  async projects(q: { hubId?: string; q?: string } = {}): Promise<C.ProjectSummary[]> {
    const ps = await this.core.source.listProjects({ hubId: q.hubId, nameContains: q.q });
    const tests = await this.store.listTests();
    // Projects are independent: summarise them in parallel.
    return Promise.all(ps.map((p) => this.summarize(p, tests)));
  }

  /** One project: summarise only that one (was: every project in every hub). */
  async project(projectId: string): Promise<C.ProjectSummary> {
    const p = await this.ttl(`project:${projectId}`, 60_000, () => this.core.source.getProject(projectId).catch(() => undefined));
    if (!p) throw new CoordError("not_found", `Proyecto ${projectId} no existe`);
    return this.summarize(p, await this.store.listTests());
  }

  private async pendingCount(t: TestRecord): Promise<number> {
    const cls = await this.store.getClassification(t.testKey);
    if (!cls) return 0;
    const decided = await this.decidedGroupIds(t, cls);
    return cls.groups.filter((g) => !decided.has(g.id)).length;
  }

  /**
   * Groups with a human decision on this test: their own (group) decision, or an inherited instance
   * of an approved family decision (G2: "Aprobar grupo" decides every inherited instance).
   */
  private async decidedGroupIds(t: TestRecord, cls: ClassificationRecord): Promise<Set<string>> {
    const out = new Set<string>();
    const own = await this.core.effectiveDecisions(t.testKey);
    for (const g of cls.groups) if (own.has(g.id)) out.add(g.id);
    if (cls.families) {
      const views = await this.core.familyViewsFor(t.testKey).then((r) => r.views).catch(() => []);
      for (const v of views) if (v.decision?.status === "approved") for (const i of v.instances) if (i.inheritance.state === "inherited") out.add(i.groupId);
    }
    return out;
  }

  async modelSets(projectId: string): Promise<C.ModelSetSummary[]> {
    const sets = await this.ttl(`modelSets:${projectId}`, 60_000, () => this.core.source.listModelSets(withB(projectId)));
    const tests = await this.store.listTests();
    const batches = await this.store.listBatches();
    const out: C.ModelSetSummary[] = [];
    for (const s of sets) {
      const mine = tests.filter((t) => t.modelSetId === s.id).sort((a, b) => b.modelSetVersion - a.modelSetVersion);
      let analyzed: TestRecord | undefined;
      for (const t of mine) if (await this.store.getClassification(t.testKey)) { analyzed = t; break; }
      const cls = analyzed ? await this.store.getClassification(analyzed.testKey) : undefined;
      const decided = analyzed && cls ? await this.decidedGroupIds(analyzed, cls) : new Set<string>();
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
      state: analyzed ? "classified" : "counts",
      documentCount: t.documents.length,
      documents: t.documents.map((d) => ({ documentId: d.documentId, urn: d.urn, name: `${d.name} · ${d.viewableName}`, ...(d.discipline ? { discipline: d.discipline } : {}) })),
    };
  }

  async tests(projectId: string, modelSetId: string): Promise<C.TestRun[]> {
    const remote = await this.ttl(`tests:${projectId}:${modelSetId}`, 30_000, () => this.core.source.listClashTests(withB(projectId), modelSetId).catch(() => []));
    const cached = (await this.store.listTests()).filter((t) => t.modelSetId === modelSetId);
    const out: C.TestRun[] = [];
    for (const t of cached) {
      const classified = await this.store.hasClassification(t.testKey);
      const diff = t.previousTestKey ? await this.core.diffForTest(t).catch(() => undefined) : undefined;
      out.push({
        ...this.testRun(t, classified),
        documentCount: t.documents.length,
        state: classified ? "classified" : "counts",
        ...(diff ? { delta: { new: diff.counts.new + diff.counts.reappeared, resolved: diff.counts.resolved + diff.counts.element_deleted, persisting: diff.counts.persisting } } : {}),
      });
    }
    for (const r of remote) {
      if (cached.some((c) => c.testId === r.id)) continue;
      out.push({ id: r.id, accTestId: r.id, cached: false, modelSetId, modelSetVersion: r.modelSetVersion, completedOn: r.completedOn ?? "", clashCount: 0, analyzed: false, documents: [], state: "none" });
    }
    return out.sort((a, b) => b.modelSetVersion - a.modelSetVersion);
  }

  async assignees(projectId: string): Promise<C.Assignee[]> {
    return this.core.source.listAssignees(withB(projectId));
  }

  /** Human-started ingest + classification from the UI. */
  /** Asynchronous phased ingest (+ classification): returns the job immediately; poll GET /ingest-jobs/:jobId. */
  startIngest(projectId: string, modelSetId: string, accTestId: string, opts: { refresh?: boolean; classify?: boolean }, user: HumanUser) {
    const actor: Actor = { type: "user", id: user.id, name: user.name };
    return this.core.startIngestJob({ projectId: withB(projectId), modelSetId, testId: accTestId, refresh: opts.refresh, classify: opts.classify }, { actor });
  }

  /** Synchronous variant (tests, CLI). */
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
      ruleId: g.ruleIds[0] ?? null,
      ruleIds: g.ruleIds,
      humanReview: g.reviewState === "needs_review",
      reviewReasons: g.reviewReasons,
      ...((): Partial<C.ClashGroup> => {
        const c = this.cycles.get(test.testKey);
        if (!c) return {};
        const acc = aggregateAcc(g.clashIds, c.acc, c.resolvedByGroup);
        const inh = c.inherited.get(g.id);
        const clashSet = new Set(g.clashIds);
        const qs = c.questions.filter((q) => q.state === "open" && (q.groupIds.includes(g.id) || q.clashIds.some((x) => clashSet.has(x)))).map((q) => q.id);
        return {
          ...(acc ? { acc } : {}),
          // Closed in ACC while the engine says real (D8 vs invariant 1): surfaced, never overridden.
          ...(acc && acc.status === "closed" && g.validity === "real" ? { closedInAccWhileReal: true } : {}),
          change: itemChange(g.clashIds, c.changes),
          ...(inh ? { inherited: inh } : {}),
          // F1: an inherited decision counts as decided ("Pendiente" filter) unless it needs a confirmation.
          ...(inh && !inh.needsConfirmation && state !== "decided" ? { reviewState: "decided" as const } : {}),
          ...(qs.length ? { questionIds: qs } : {}),
        };
      })(),
      ...(g.familyId ? { familyId: g.familyId, problemType: g.problemType as C.ProblemTypeCode, signature: g.signature ?? "", uniqueClashCount: g.uniqueClashCount ?? g.clashIds.length } : {}),
      ...(g.hostLevelLabel ? { hostLevelLabel: g.hostLevelLabel } : {}),
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
    // X1 (D8): clashes ACC already assigned or closed are never re-proposed as an issue or a closure.
    const inAcc = this.accDecided(test.testKey, g.clashIds);
    const createIssue = !inAcc && (!!iss || (effValidity === "real" && (g.suggestedAction === "create_issue" || !!engineIssue)) || (g.engineStrategy === "hygiene" && g.suggestedAction === "hygiene_issue" && !!engineIssue));
    let setStatus: C.AccStatus | null = null;
    if (inAcc) setStatus = null;
    else if (st && st.payload.kind === "status_change") setStatus = st.payload.action === "close_not_issue" ? "closed" : st.payload.action === "mark_reviewed" ? "reviewed" : "active";
    else if ((CLOSABLE as string[]).includes(effValidity) && g.suggestedAction === "close_not_issue") setStatus = "closed";
    else if ((CLOSABLE as string[]).includes(effValidity) && g.suggestedAction === "mark_reviewed") setStatus = "reviewed";
    const actionSource: C.FieldSource = st || iss ? (cl ? "llm" : "rule+llm") : "rule";

    let issueDraft: C.IssueDraft | undefined;
    const accState = this.accOfGroup(test.testKey, g.clashIds);
    const due = (days: number) => new Date(this.core.now() + days * 86_400_000).toISOString().slice(0, 10);
    if (inAcc) {
      // ACC decided: no draft.
    } else if (iss && iss.payload.kind === "issue_draft") {
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
        ...(accState ? [{ label: "ACC", value: `${accState.status === "assigned" ? "asignada" : accState.status === "closed" ? "cerrada" : "mixta"} (${accState.existing} interf.${accState.issueIds.length ? `, ${plural(accState.issueIds.length, "incidencia", "incidencias")}` : ""})` }] : []),
      ],
      ruleIds: g.ruleIds,
      spotCheck: spotCheck(id + g.id, validity.confidence, this.bands.high),
      ...(agent.some((p) => p.flaggedText) ? { flagged: true } : {}),
      ...(issueDraft ? { issueDraft } : {}),
      origin: agent.length ? "agent" : "engine",
      ...((): Partial<C.Proposal> => {
        const inh = this.cycles.get(test.testKey)?.inherited.get(g.id);
        if (!inh) return {};
        const kind: C.DecisionKind = inh.decision === "correct" || inh.decision === "reject" || inh.decision === "postpone" ? inh.decision : "accept";
        return { inherited: { testId: inh.fromTestKey ?? "", decidedAt: inh.decidedAt, userName: inh.decidedBy ?? (inh.source === "acc" ? "ACC" : inh.source === "family" ? "familia" : ""), kind } };
      })(),
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
    const cycle = await this.cycleCtx(test, cls);
    return { test, cls, states, byGroup, cycle };
  }

  /** M1 per-test context: ACC state (X1, from the ledger) and change words (vs the previous version). */
  private readonly cycles = new Map<string, CycleCtx>();
  private async cycleCtx(test: TestRecord, cls: ClassificationRecord): Promise<CycleCtx> {
    const acc = await this.core.accFor(test, cls.clashes);
    const ch = await this.core.changesFor(test, cls);
    const ctx: CycleCtx = {
      acc: acc.index,
      resolvedByGroup: acc.resolvedByGroup,
      ...(acc.sync ? { sync: acc.sync } : {}),
      changes: ch.byClash,
      ...(ch.diff ? { diff: ch.diff } : {}),
      ...(ch.previous ? { previous: ch.previous } : {}),
      baseReason: ch.baseReason,
      inherited: await this.core.inheritanceFor(test, cls, acc),
      questions: await this.core.questionsFor(test),
    };
    this.cycles.set(test.testKey, ctx);
    return ctx;
  }

  private accOfGroup(testKey: string, clashIds: readonly string[]): C.AccState | undefined {
    const c = this.cycles.get(testKey);
    return c ? aggregateAcc(clashIds, c.acc, c.resolvedByGroup) : undefined;
  }
  /** Every clash of the group is decided in ACC (assigned or closed): never re-proposed. */
  private accDecided(testKey: string, clashIds: readonly string[]): boolean {
    const c = this.cycles.get(testKey);
    return !!c && clashIds.length > 0 && clashIds.every((id) => c.acc.has(id));
  }
  private notInAcc(testKey: string): (c: ClashRecord) => boolean {
    const idx = this.cycles.get(testKey)?.acc;
    return (c) => !idx?.has(c.id);
  }

  /**
   * Memoized triage projection. Key: the test plus the mtime/size of everything the payload reads
   * (classification, test records of the model set, diff, decisions, proposals, batches, questions,
   * family decisions, ledger incl. ACC sync, disciplines) and a 1-minute bucket for remote reads.
   * Same key → the same object (the router then reuses its serialized / compressed bytes).
   */
  private readonly triageMemo = new Map<string, { sig: string; payload: C.TriagePayload }>();
  async triage(projectId: string, modelSetId: string, testKey?: string): Promise<C.TriagePayload> {
    let key = testKey;
    if (!key) {
      const mine = (await this.store.listTests()).filter((t) => t.modelSetId === modelSetId && bareProjectId(t.projectId) === bareProjectId(projectId)).sort((a, b) => b.modelSetVersion - a.modelSetVersion);
      for (const t of mine) if (await this.store.hasClassification(t.testKey)) { key = t.testKey; break; }
    }
    if (!key) return this.triageUncached(projectId, modelSetId, testKey);
    const test = await this.store.getTest(key);
    if (!test) return this.triageUncached(projectId, modelSetId, testKey);
    const seg = (s: string) => pathSegment(s);
    const same = (await this.store.listTests()).filter((t) => t.modelSetId === test.modelSetId).map((t) => ["tests", t.testKey] as const);
    const sig = [
      await this.store.signature([
        ["tests"],
        ...same,
        ["tests", key, "classification.json"],
        ["tests", key, "test.json"],
        ["tests", key, "diff.json"],
        ["decisions", "decisions.jsonl"],
        ["proposals"],
        ["batches"],
        ["questions.json"],
        ["ledgers", seg(bareProjectId(test.projectId)), `${seg(test.modelSetId)}.json`],
        ["projects", seg(bareProjectId(test.projectId)), "model-sets", seg(test.modelSetId), "families.json"],
        ["projects", seg(bareProjectId(test.projectId)), "disciplines.json"],
      ]),
      Math.floor(Date.now() / 60_000),
    ].join("#");
    const mk = `${bareProjectId(projectId)}|${modelSetId}|${key}`;
    const hit = this.triageMemo.get(mk);
    if (hit && hit.sig === sig) return hit.payload;
    const payload = markFrozen(await this.triageUncached(projectId, modelSetId, key));
    this.triageMemo.set(mk, { sig, payload });
    if (this.triageMemo.size > 8) this.triageMemo.delete(this.triageMemo.keys().next().value!);
    return payload;
  }

  private async triageUncached(projectId: string, modelSetId: string, testKey?: string): Promise<C.TriagePayload> {
    let key = testKey;
    if (!key) {
      const mine = (await this.store.listTests()).filter((t) => t.modelSetId === modelSetId && bareProjectId(t.projectId) === bareProjectId(projectId)).sort((a, b) => b.modelSetVersion - a.modelSetVersion);
      for (const t of mine) if (await this.store.hasClassification(t.testKey)) { key = t.testKey; break; }
      if (!key) throw new CoordError("not_ingested", "No hay pruebas analizadas para este conjunto.", "Pide al agente: ingesta y clasifica la prueba más reciente.");
    }
    // Remote reads (ACC, cached briefly) run in parallel with the local projection.
    const remote = Promise.all([this.project(projectId).catch(() => undefined), this.modelSets(projectId).catch(() => []), this.tests(projectId, modelSetId)]);
    remote.catch(() => undefined);
    const { test, cls, states, byGroup, cycle } = await this.testContext(key);
    const [projectR, setsR, testsR] = await remote;
    const project = projectR ?? { id: bareProjectId(projectId), name: test.projectName, hubId: "", hubName: "", modelSetCount: 1, pendingDecisions: 0 };
    const modelSet = setsR.find((m) => m.id === modelSetId) ?? {
      id: modelSetId, projectId: bareProjectId(projectId), name: test.modelSetName, latestVersion: test.modelSetVersion, analyzedVersion: test.modelSetVersion,
      groupsReviewed: 0, groupsTotal: cls.groups.length, readyToApprove: 0, agentCommand: `Analiza el conjunto "${test.modelSetName}"`,
    };
    const proposals = cls.groups.map((g) => this.proposalView(g, test, cls, byGroup.get(g.id) ?? []));
    const groups = cls.groups.map((g, i) => this.groupUi(g, test, states.get(g.id) ?? g.reviewState, !!proposals[i].issueDraft, proposals[i].updatedAt));
    const rs = loadRules();
    const decisions = (await this.store.listDecisions()).filter((d) => d.testId === test.testKey && d.targetType !== "issue").map((d) => this.decisionUi(d));
    let families: C.TriageFamily[] | undefined;
    if (cls.families) {
      const views = (await this.core.familyViewsFor(test.testKey)).views;
      const props = await this.familyProposals(test.testKey);
      this.familyClashIds.set(test.testKey, new Map(cls.groups.map((g) => [g.id, g.clashIds])));
      const pendingSend = await this.familyPendingSend(test, cls, views);
      families = views.map((v) => this.familyUi(v, props, test.testKey, pendingSend));
      const inh = new Map(views.flatMap((v) => v.instances.map((i) => [i.groupId, i.inheritance] as const)));
      for (const g of groups) {
        const x = inh.get(g.id);
        if (x) g.inheritance = x;
      }
    }
    const changeSummary: C.ChangeSummary = {
      groups: emptyCounts(),
      clashes: emptyCounts(),
      resolved: (cycle.diff?.counts.resolved ?? 0) + (cycle.diff?.counts.element_deleted ?? 0),
      outOfScope: cycle.diff?.counts.out_of_scope ?? 0,
      baseReason: cycle.baseReason,
      inherited: cycle.inherited.size,
    };
    if (cycle.previous) Object.assign(changeSummary, { previousVersion: cycle.previous.modelSetVersion, previousTestKey: cycle.previous.testKey, baseVersion: cycle.previous.modelSetVersion, baseTestKey: cycle.previous.testKey });
    for (const g of groups) changeSummary.groups[g.change ?? "unchanged"]++;
    for (const k of cycle.changes.values()) changeSummary.clashes[k]++;
    return {
      ...(families ? { families, problemTypes: PROBLEM_TYPES.map((p) => ({ ...p, options: [...p.options] })) } : {}),
      ...(cycle.sync ? { accSync: cycle.sync } : {}),
      scopeChanges: await this.core.scopeChangesFor(test),
      changeSummary,
      questions: cycle.questions.map(questionView),
      project,
      modelSet,
      test: this.testRun(test, true),
      tests: testsR,
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

  async saveDecisions(input: C.Decision[], user: HumanUser, opts: { source?: "question" } = {}): Promise<{ saved: string[] }> {
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
        ...(opts.source ? { source: opts.source } : {}),
      });
    }
    const { saved, added } = await this.store.appendDecisions(records);
    const actor: Actor = { type: "user", id: user.id, name: user.name };
    // F1: the ledger keeps a reference of every human group decision (with the clash geometry).
    for (const [testId, ctx] of byTest) {
      const mine = added.filter((d) => d.testId === testId && d.targetType === "group");
      const items = mine
        .filter((d) => d.kind === "accept" || d.kind === "correct" || d.kind === "reject" || d.kind === "postpone")
        .map((d) => {
          const g = ctx.cls.groups.find((x) => x.id === d.targetId)!;
          const eff = this.effective(this.proposalView(g, ctx.test, ctx.cls, ctx.byGroup.get(g.id) ?? []), d);
          const effect: "issue" | "close" | "none" = d.kind === "reject" || d.kind === "postpone" ? "none" : eff.action.createIssue ? "issue" : eff.action.setStatus === "closed" || eff.action.setStatus === "reviewed" ? "close" : "none";
          return { groupId: g.id, ref: { source: "human" as const, ref: d.id, decision: d.kind, validity: eff.validity, effect, decidedBy: user.name, decidedAt: d.decidedAt } };
        });
      const undo = mine.filter((d) => d.kind === "undo" && d.undoes).map((d) => d.undoes!);
      await this.core.recordDecisionRefs(ctx.test, ctx.cls, items, undo);
    }
    for (const d of added) {
      const ctx = byTest.get(d.testId)!;
      const action = d.kind === "accept" ? "decision.accepted" : d.kind === "correct" ? "decision.corrected" : d.kind === "reject" ? "decision.rejected" : d.kind === "postpone" ? "decision.postponed" : d.kind === "undo" ? "decision.undone" : "decision.note";
      await this.store.audit({ actor, action, projectId: ctx.test.projectId, modelSetId: ctx.test.modelSetId, testId: ctx.test.testKey, accTestId: ctx.test.testId, targetIds: [d.targetId, d.proposalId], details: { decisionId: d.id, reasonCode: d.reasonCode ?? null, viewedInViewerMs: d.viewedInViewerMs } });
      // Corrections and rejections feed the learning loop (never the ones derived from an agent question).
      if ((d.kind === "correct" || d.kind === "reject") && d.targetType === "group" && d.source !== "question") {
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
    const all = (await this.store.listDecisions()).filter((d) => d.targetType !== "issue" && (!q.testId || d.testId === q.testId) && (!q.projectId || bareProjectId(d.projectId) === bareProjectId(q.projectId)));
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
    const members = cls.clashes.filter((c) => c.groupId === g.id).filter(this.notInAcc(test.testKey));
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
          title: fitTitle(issue.title, suffix, 100),
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
    // Family decisions first: one assign / one close per family; their instances skip the group flow.
    const fam = await this.familyBatchItems(batchId, test, cls, user);
    items.push(...fam.items);
    for (const g of cls.groups) {
      if (fam.covered.has(g.id)) continue;
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
    const rb = await this.core.batchRebaseInfo(b);
    const latest = rb.latestVersion;
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
        ...(i.familyId ? { familyId: i.familyId, familyDecisionVersion: i.familyDecisionVersion, groupIds: i.groupIds ?? [] } : {}),
        ...(i.validityChanges?.length ? { validityChanges: i.validityChanges } : {}),
      })),
      ...(rb.stale && b.state !== "discarded" && b.state !== "applied" ? { rebase: { available: rb.available, targetVersion: rb.latestVersion, ...(rb.reason ? { reason: rb.reason } : {}) } } : {}),
      ...(b.supersededBy ? { supersededBy: b.supersededBy } : {}),
      ...(b.rebasedFrom ? { rebasedFrom: b.rebasedFrom } : {}),
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
   * G3 "Llevar decisiones a vN" (HUMAN only; agents never create, edit, approve or apply batches).
   * A batch prepared on an older model set version cannot be approved once a newer one exists: its
   * items carry old clash ids and the old testId. This builds a NEW `ready`, UNAPPROVED batch on the
   * latest, analysed version:
   *  - group items are carried only when the vN group inherits the batched decision through the
   *    ledger (source human, ref = decision id), every clash is unchanged, the effective validity /
   *    effect on vN equals the ledger reference, and never a closure onto a `real` group. Carried
   *    decisions are copied as vN decision records (audit + ledger refs, no feedback); issue text
   *    edits are copied when the mapping is 1:1;
   *  - family items are rebuilt from the current family decisions (old batch ignored);
   *  - anything else is listed in rebasedFrom.needsReview.
   * The old batch is discarded with supersededBy (its decisions stay attached to it). The new batch
   * needs a fresh approval (passkey in live mode).
   */
  async rebaseBatch(id: string, user: HumanUser): Promise<C.BatchRebaseResult> {
    this.core.requireLevel(1, "Llevar decisiones a la versión nueva");
    return withBatchLock(this.store, async () => {
      const old = await this.requireBatch(id);
      const info = await this.core.batchRebaseInfo(old);
      if (!info.stale) throw new CoordError("validation_error", `El lote ${id} ya está en la versión vigente v${info.latestVersion}.`);
      if (old.state !== "draft" && old.state !== "ready" && old.state !== "approved") throw new CoordError("invalid_state", info.reason ?? `El lote está ${old.state}.`);
      if (!info.available || !info.targetTestKey) throw new CoordError("not_ingested", info.reason ?? `La versión v${info.latestVersion} no está analizada.`, `Usa «Analizar v${info.latestVersion}» en el espacio de trabajo.`);
      const N = info.latestVersion;
      const { test, cls, byGroup, cycle } = await this.testContext(info.targetTestKey);
      const now = nowIso(this.core.now());
      const batchId = await this.store.newBatchId();
      const needsReview: C.BatchRebaseNote["needsReview"] = [];
      const items: BatchItemRecord[] = [];
      const userExcluded = (its: readonly BatchItemRecord[]) => its.length > 0 && its.every((i) => i.excluded && !i.conflict);

      // 1. Families: rebuilt on vN from the current family decisions (the old batch does not count as sent).
      const famItems = new Map<string, BatchItemRecord[]>();
      for (const i of old.items) if (i.familyId) famItems.set(i.familyId, [...(famItems.get(i.familyId) ?? []), i]);
      const views = famItems.size && cls.families ? (await this.core.familyViewsFor(test.testKey)).views : [];
      const viewOf = (fid: string) => views.find((v) => v.id === fid || v.mergedFrom.includes(fid));
      const only = new Map<string, string>();
      for (const [fid, its] of famItems) {
        const v = viewOf(fid);
        if (userExcluded(its)) needsReview.push({ label: its[0]!.label, familyId: fid, reason: "Excluida en el lote anterior: no se lleva." });
        else if (!v) needsReview.push({ label: its[0]!.label, familyId: fid, reason: `El grupo no existe en v${N}.` });
        else only.set(v.id, its[0]!.label);
      }
      const fam = await this.familyBatchItems(batchId, test, cls, user, { ignoreBatchIds: new Set([old.id]), onlyFamilies: new Set(only.keys()) });
      items.push(...fam.items);
      const famSent = new Set(fam.items.flatMap((i) => i.groupIds ?? []));
      for (const [fid, label] of only) {
        const v = views.find((x) => x.id === fid)!;
        if (!fam.items.some((i) => i.familyId === v.id)) needsReview.push({ label, familyId: v.id, reason: `Sin instancias heredadas pendientes de enviar en v${N}: revisa el grupo en el espacio de trabajo.` });
        else if (v.counts.pendingInherited > 0) needsReview.push({ label, familyId: v.id, reason: `${v.counts.pendingInherited} instancia(s) nuevas o cambiadas por confirmar en v${N}: no se incluyen hasta confirmarlas.` });
      }

      // 2. Group decisions: carried only through the ledger inheritance, unchanged.
      const decById = new Map((await this.store.listDecisions()).map((d) => [d.id, d]));
      const own = await this.core.effectiveDecisions(test.testKey);
      const byDecision = new Map<string, BatchItemRecord[]>();
      for (const i of old.items) if (!i.familyId && i.groupId && i.decisionIds[0]) byDecision.set(i.decisionIds[0], [...(byDecision.get(i.decisionIds[0]) ?? []), i]);
      const targets = new Map<string, GroupRecord[]>();
      for (const g of cls.groups) {
        const inh = cycle.inherited.get(g.id);
        if (inh?.source === "human" && byDecision.has(inh.ref)) targets.set(inh.ref, [...(targets.get(inh.ref) ?? []), g]);
      }
      const groupOfClash = new Map(cls.clashes.map((c) => [c.id, c.groupId]));
      const carried: Array<{ g: GroupRecord; d: DecisionRecord; validity: C.Validity; effect: "issue" | "close" | "none" }> = [];
      for (const [decId, olds] of byDecision) {
        const first = olds[0]!;
        const skip = (reason: string, groupId = first.groupId) => needsReview.push({ label: first.label, ...(groupId ? { groupId } : {}), reason });
        const from = decById.get(decId);
        if (!from) {
          skip("No se encontró la decisión original.");
          continue;
        }
        if (userExcluded(olds)) {
          skip("Excluida en el lote anterior: no se lleva.");
          continue;
        }
        const gs = targets.get(decId) ?? [];
        if (!gs.length) {
          const ids = [...new Set(olds.flatMap((i) => i.targetIds.map((t) => t.replace(/^C-/, ""))))];
          const present = ids.filter((c) => groupOfClash.has(c));
          if (!present.length) skip(`Resuelta en v${N}: sus interferencias ya no aparecen.`);
          else if (present.every((c) => cycle.acc.has(c))) skip(`Ya está en ACC en v${N} (asignada o cerrada).`);
          else if (olds.some((i) => i.mcOperation === "clash.close") && present.some((c) => cls.groups.find((g) => g.id === groupOfClash.get(c))?.validity === "real")) skip(`Cierre de una interferencia real en v${N}: nunca se lleva; revísala.`, groupOfClash.get(present[0]!));
          else if (present.some((c) => own.has(groupOfClash.get(c)!))) skip(`Ya tiene una decisión en v${N}: envíala desde el espacio de trabajo.`, groupOfClash.get(present[0]!));
          else skip(`Cambió en v${N} (geometría, elementos o agrupación): revísala en el espacio de trabajo.`, groupOfClash.get(present[0]!));
          continue;
        }
        const oneToOne = gs.length === 1;
        for (const g of gs) {
          if (fam.covered.has(g.id)) {
            if (!famSent.has(g.id)) skip(`Heredada de un grupo aprobado en v${N}: se envía con ese grupo desde el espacio de trabajo.`, g.id);
            continue;
          }
          if (g.clashIds.some((c) => (cycle.changes.get(c) ?? "new") !== "unchanged")) {
            skip(`Cambió en v${N}: revísala en el espacio de trabajo.`, g.id);
            continue;
          }
          const view = this.proposalView(g, test, cls, byGroup.get(g.id) ?? []);
          const eff = this.effective(view, from);
          const effect: "issue" | "close" | "none" = eff.action.createIssue ? "issue" : eff.action.setStatus === "closed" || eff.action.setStatus === "reviewed" ? "close" : "none";
          // Invariant 3: a closure never reaches a real group, whatever the ledger says.
          if (effect === "close" && (g.validity === "real" || eff.validity === "real")) {
            skip(`Cierre de una interferencia real en v${N}: nunca se lleva; revísala.`, g.id);
            continue;
          }
          const inh = cycle.inherited.get(g.id)!;
          if (eff.validity !== inh.validity || effect !== inh.effect) {
            skip(`En v${N} la decisión no daría el mismo resultado (validez o acción): revísala.`, g.id);
            continue;
          }
          const d: DecisionRecord = {
            ...from,
            id: `D-rb-${sha256(`${from.id}|${test.testKey}|${g.id}`).slice(0, 16)}`,
            proposalId: view.id,
            targetId: g.id,
            testId: test.testKey,
            modelSetId: test.modelSetId,
            projectId: bareProjectId(test.projectId),
            batchId: undefined,
            bulk: undefined,
            undoes: undefined,
            receivedAt: now,
            carriedFrom: from.id,
          };
          const st = (byGroup.get(g.id) ?? []).filter((p) => p.payload.kind === "status_change" && p.state !== "withdrawn" && p.state !== "rejected").pop();
          const its = this.buildItems(batchId, test, cls, g, view, d, st?.payload.kind === "status_change" ? st.payload.accReason : undefined);
          if (!its.length) {
            skip(`Sin cambios que aplicar en ACC en v${N}.`, g.id);
            continue;
          }
          // Issue text edited in the old batch (R13): copied when the old item maps 1:1 to the new one.
          const oldIssue = olds.filter((i) => i.mcOperation === "clash.assign");
          const newIssue = its.filter((i) => i.mcOperation === "clash.assign");
          if (oneToOne && oldIssue.length === 1 && newIssue.length === 1 && oldIssue[0]!.reasonCode === "R13") copyIssueText(oldIssue[0]!, newIssue[0]!);
          items.push(...its);
          carried.push({ g, d, validity: eff.validity, effect });
        }
      }
      if (!items.length) {
        const list = needsReview.slice(0, 3).map((x) => `${x.label}: ${x.reason}`).join(" · ");
        throw new CoordError("validation_error", `Nada del lote ${id} se puede llevar a v${N} sin revisión: ${list}${needsReview.length > 3 ? ` (+${needsReview.length - 3})` : ""}`, "Revisa esos grupos en el espacio de trabajo y envía un lote nuevo; luego descarta este.");
      }

      // 3. Writes: carried decisions (+ ledger refs, audit, never feedback), new batch, old batch superseded.
      const actor: Actor = { type: "user", id: user.id, name: user.name };
      const { added } = await this.store.appendDecisions(carried.map((c) => c.d));
      await this.core.recordDecisionRefs(
        test,
        cls,
        carried.map((c) => ({ groupId: c.g.id, ref: { source: "human" as const, ref: c.d.id, decision: c.d.kind, validity: c.validity, effect: c.effect, decidedBy: c.d.userName, decidedAt: c.d.decidedAt } })),
      );
      for (const d of added) {
        await this.store.audit({ actor, action: "decision.carried", projectId: test.projectId, modelSetId: test.modelSetId, testId: test.testKey, accTestId: test.testId, targetIds: [d.targetId, d.id], details: { decisionId: d.id, carriedFrom: d.carriedFrom ?? null, fromBatch: old.id, toBatch: batchId, fromVersion: old.modelSetVersion, toVersion: N } });
      }
      const rebasedFrom: C.BatchRebaseNote = { batchId: old.id, fromVersion: old.modelSetVersion, carried: items.length, needsReview };
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
        rebasedFrom,
      };
      await this.store.putBatch(batch);
      await this.store.markDecisionsBatched(carried.map((c) => c.d.id), batchId);
      await this.store.audit({ actor, action: "batch.ready", projectId: test.projectId, modelSetId: test.modelSetId, testId: test.testKey, accTestId: test.testId, batchId, details: { items: items.length, rebasedFrom: old.id, needsReview: needsReview.length } });
      if (old.state === "approved") {
        // The old approval is void (other version): back to draft first, like "Devolver a revisión".
        await this.store.transitionBatch(old.id, "draft");
        await this.store.deleteApproval(old.id);
        for (const pid of new Set(old.items.flatMap((i) => i.proposalIds))) {
          const p = await this.store.getProposal(pid);
          if (p?.state === "approved") await this.store.transitionProposal(pid, "pending_review", user.name, `lote ${old.id} reemplazado por ${batchId}`);
        }
      }
      // Old decisions stay attached to the old batch: nothing of the old version is offered again.
      await this.store.transitionBatch(old.id, "discarded", (b) => void (b.supersededBy = batchId));
      await this.store.audit({ actor, action: "batch.superseded", projectId: old.projectId, modelSetId: old.modelSetId, testId: old.testKey, accTestId: old.testId, batchId: old.id, targetIds: [batchId], details: { supersededBy: batchId, fromVersion: old.modelSetVersion, toVersion: N, carried: items.length, needsReview: needsReview.length } });
      return { batch: await this.batchUi(batch), previous: old.id, needsReview };
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
        count: p.payload.feedbackIds.length || (p.payload.evidence?.metrics.changedUnique ?? 0),
        reasonCode: "R99",
        pair: "",
        summary: p.rationale,
        patch,
        affected: p.payload.evidence?.metrics.changedUnique ?? p.payload.feedbackIds.length,
        evaluation: ev,
        feedbackCount: p.payload.feedbackIds.length,
        ...(p.payload.evidence ? { evidence: p.payload.evidence } : {}),
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
    const latestDecided = latest ? await this.decidedGroupIds(latest.t, latest.cls) : new Set<string>();
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

  // ── clash grid (documents × documents) ─────────────────────────────────────

  private async findTest(projectId: string, modelSetId: string, test?: string): Promise<TestRecord | undefined> {
    const mine = (await this.store.listTests())
      .filter((t) => bareProjectId(t.projectId) === bareProjectId(projectId) && t.modelSetId === modelSetId)
      .sort((a, b) => b.modelSetVersion - a.modelSetVersion);
    if (!test) return mine[0];
    return mine.find((t) => t.testKey === test || t.testId === test);
  }

  /** Document identity for discipline rules (file name, view, folder when known). */
  private docInfos(t: TestRecord) {
    return t.documents.map((d) => ({ documentId: d.documentId, lineageUrn: d.lineageUrn, fileName: d.name, viewName: d.viewableName }));
  }

  async clashGrid(projectId: string, modelSetId: string, test?: string): Promise<C.ClashGrid> {
    const t = await this.findTest(projectId, modelSetId, test);
    if (!t) {
      const remote = test ? (await this.core.source.listClashTests(withB(projectId), modelSetId).catch(() => [])).find((x) => x.id === test) : undefined;
      return { accTestId: test ?? "", modelSetVersion: remote?.modelSetVersion ?? 0, state: "none", documents: [], cells: [] };
    }
    const raw = await this.core.loadRaw(t);
    const cls = await this.store.getClassification(t.testKey);
    const diff = await this.core.diffForTest(t).catch(() => undefined);
    const fresh = new Set([...(diff?.new ?? []), ...(diff?.reappeared ?? [])]);
    const rs = loadRules();
    const pd = await this.core.disciplines.load(t.projectId);
    const matrixOn = this.core.config.disciplines.fileNameDetection === "matrix";
    const clsById = new Map((cls?.clashes ?? []).map((c) => [c.id, c]));
    const gById = new Map((cls?.groups ?? []).map((g) => [g.id, g]));
    type Cell = { a: number; b: number; clashes: number; groups: Set<string>; real: number; p1: number; needsReview: number; newSinceLast: number };
    const cells = new Map<string, Cell>();
    const perDoc = new Map<number, { clashes: number; groups: Set<string> }>();
    for (const c of raw.clashes) {
      const a = Math.min(c.left.documentId, c.right.documentId);
      const b = Math.max(c.left.documentId, c.right.documentId);
      const k = `${a}|${b}`;
      const cell = cells.get(k) ?? { a, b, clashes: 0, groups: new Set<string>(), real: 0, p1: 0, needsReview: 0, newSinceLast: 0 };
      cell.clashes++;
      if (fresh.has(c.id)) cell.newSinceLast++;
      const cr = clsById.get(c.id);
      const g = cr ? gById.get(cr.groupId) : undefined;
      if (cr && g) {
        cell.groups.add(g.id);
        if (cr.validity === "real") cell.real++;
        if (g.band === 1) cell.p1++;
        if (g.reviewState === "needs_review") cell.needsReview++;
      }
      cells.set(k, cell);
      for (const d of new Set([a, b])) {
        const pdc = perDoc.get(d) ?? { clashes: 0, groups: new Set<string>() };
        pdc.clashes++;
        if (g) pdc.groups.add(g.id);
        perDoc.set(d, pdc);
      }
    }
    // Two documents with the same file name (e.g. two MECHANICAL.rvt): look up their ACC folders.
    const nameCount = new Map<string, number>();
    for (const d of t.documents) nameCount.set(d.name.toLowerCase(), (nameCount.get(d.name.toLowerCase()) ?? 0) + 1);
    const folders = new Map<number, string>();
    const source = this.core.source;
    if (source.folderOf) {
      await Promise.all(
        t.documents
          .filter((d) => d.lineageUrn && (nameCount.get(d.name.toLowerCase()) ?? 0) > 1)
          .map(async (d) => {
            const f = await source.folderOf!(projectId, d.lineageUrn!);
            if (f) folders.set(d.documentId, f);
          }),
      );
    }
    const documents: C.ClashGridDocument[] = t.documents.map((d) => {
      const info = { documentId: d.documentId, lineageUrn: d.lineageUrn, fileName: d.name, viewName: d.viewableName };
      // Classified tests carry the resolution made by the engine; otherwise model-level only.
      const r =
        cls && d.disciplineSource
          ? { discipline: d.discipline ?? SIN, source: d.disciplineSource, share: d.disciplineShare, ruleId: d.disciplineRuleId }
          : (() => {
              const m = modelLevelDiscipline(info, pd, rs, matrixOn);
              return m ? { discipline: m.discipline, source: m.source, share: undefined, ruleId: m.ruleId } : { discipline: SIN, source: "unassigned" as const, share: undefined, ruleId: undefined };
            })();
      const token = suggestedToken(d.name, t.documents.map((x) => x.name));
      return {
        documentId: d.documentId,
        lineageUrn: d.lineageUrn ?? "",
        fileName: d.name,
        viewName: d.viewableName,
        discipline: outCode(r.discipline),
        disciplineSource: r.source,
        ...(r.share !== undefined ? { disciplineShare: r.share } : {}),
        ...(r.ruleId ? { ruleId: r.ruleId } : {}),
        ...(token ? { suggestedToken: token } : {}),
        ...(folders.has(d.documentId) ? { folderPath: folders.get(d.documentId) } : {}),
        clashes: perDoc.get(d.documentId)?.clashes ?? 0,
        groups: perDoc.get(d.documentId)?.groups.size ?? 0,
      };
    });
    return {
      testKey: t.testKey,
      accTestId: t.testId,
      modelSetVersion: t.modelSetVersion,
      state: cls ? "classified" : "counts",
      documents,
      cells: [...cells.values()]
        .sort((x, y) => y.clashes - x.clashes || x.a - y.a || x.b - y.b)
        .map((c) => ({ a: c.a, b: c.b, clashes: c.clashes, groups: c.groups.size, real: c.real, p1: c.p1, needsReview: c.needsReview, newSinceLast: c.newSinceLast })),
    };
  }

  /** Saved model set views ("what is being clashed"), file names resolved from cached tests. */
  async modelSetViews(projectId: string, modelSetId: string): Promise<C.ModelSetView[]> {
    const views = await this.core.source.listModelSetViews(withB(projectId), modelSetId).catch(() => []);
    const names = new Map<string, string>();
    for (const t of (await this.store.listTests()).filter((x) => x.modelSetId === modelSetId)) for (const d of t.documents) if (d.lineageUrn) names.set(d.lineageUrn, d.name);
    return views.map((v) => ({ name: v.name, documents: v.definition.map((d) => names.get(d.lineageUrn) ?? d.viewableName ?? d.lineageUrn) }));
  }

  // ── disciplines (human-only writes) ─────────────────────────────────────────

// ── solution families (docs/domain/solution-families-proposal.md) ───────

  private familyUi(v: FamilyView, proposals: readonly ProposalRecord[], testKey?: string, pendingSend?: ReadonlyMap<string, number>): C.TriageFamily {
    const pending = proposals.filter((p) => p.payload.kind === "family_decision" && p.payload.familyId === v.id && PENDING.has(p.state));
    const pendingExc = proposals.filter((p) => p.payload.kind === "family_exception" && (p.payload.familyId === v.id || v.mergedFrom.includes(p.payload.familyId)) && PENDING.has(p.state));
    const c = testKey ? this.cycles.get(testKey) : undefined;
    const clsOf = c ? this.familyClashIds.get(testKey!) : undefined;
    let extra: Partial<C.TriageFamily> = {};
    if (c && clsOf) {
      const counts = emptyCounts();
      const instances = v.instances.map((i) => {
        const ids = clsOf.get(i.groupId) ?? [];
        const acc = aggregateAcc(ids, c.acc, c.resolvedByGroup);
        const change = itemChange(ids, c.changes);
        counts[change]++;
        return { ...i, ...(acc ? { acc } : {}), change };
      });
      const acc = mergeAcc(instances.map((i) => (i as { acc?: C.AccState }).acc));
      extra = { instances: instances as unknown as C.FamilyInstance[], changeCounts: counts, ...(acc ? { acc } : {}) };
    }
    return {
      ...(v as unknown as Omit<C.TriageFamily, "pendingProposals">),
      ...extra,
      pendingProposals: pending.map((p) => ({ id: p.id, createdAt: p.createdAt, rationale: p.rationale, payload: p.payload as unknown as Record<string, unknown> })),
      ...(pendingExc.length
        ? { pendingExceptions: pendingExc.map((p) => { const pl = p.payload as Extract<ProposalRecord["payload"], { kind: "family_exception" }>; return { id: p.id, createdAt: p.createdAt, groupId: pl.groupId, reason: pl.reason, rationale: p.rationale, fields: pl.fields as Partial<C.FamilyDecisionFields> }; }) }
        : {}),
      ...(pendingSend ? { pendingSend: pendingSend.get(v.id) ?? 0 } : {}),
    };
  }

  private async familyProposals(testKey: string): Promise<ProposalRecord[]> {
    return this.store.listProposals((p) => (p.kind === "family_decision" || p.kind === "family_exception") && p.testKey === testKey);
  }

  /** groupId → raw clash ids, per test (families projection). */
  private readonly familyClashIds = new Map<string, Map<string, string[]>>();
  private async familyContext(testKey: string) {
    const r = await this.core.familyViewsFor(testKey);
    await this.cycleCtx(r.test, r.cls);
    this.familyClashIds.set(r.test.testKey, new Map(r.cls.groups.map((g) => [g.id, g.clashIds])));
    return r;
  }

  async families(testKey: string): Promise<C.FamiliesPayload> {
    const { test, cls, views } = await this.familyContext(testKey);
    const props = await this.familyProposals(test.testKey);
    const pendingSend = await this.familyPendingSend(test, cls, views);
    return { testId: test.testKey, families: views.map((v) => this.familyUi(v, props, test.testKey, pendingSend)), problemTypes: PROBLEM_TYPES.map((p) => ({ ...p, options: [...p.options] })) };
  }

  async family(testKey: string, familyId: string): Promise<C.TriageFamily> {
    const { test, cls, views } = await this.familyContext(testKey);
    return this.familyUi(assertFamilyInTest(views, familyId), await this.familyProposals(test.testKey), test.testKey, await this.familyPendingSend(test, cls, views));
  }

  private decisionFields(v: FamilyView, req: Partial<C.FamilyDecisionRequest>): FamilyDecisionFields {
    const rs = loadRules();
    const validity = req.validity ?? v.proposed.validity;
    const action = req.action ?? v.proposed.action;
    if (validity === "real" && (action === "close" || action === "mark_reviewed")) throw new CoordError("validation_error", "Una familia 'real' no se cierra: usa create_issue o escalate.");
    const responsibleDiscipline = assertCode(rs, req.responsibleDiscipline ?? v.proposed.responsibleDiscipline);
    const secondary = req.secondaryDiscipline ?? v.proposed.secondaryDiscipline;
    return {
      validity,
      action,
      responsibleDiscipline,
      ...(secondary ? { secondaryDiscipline: assertCode(rs, secondary) } : {}),
      ...(req.solutionOption ?? v.proposed.solutionOption ? { solutionOption: sanitizeModelText(req.solutionOption ?? v.proposed.solutionOption!, 300) } : {}),
      ...(req.typicalDetail ? { typicalDetail: { name: sanitizeModelText(req.typicalDetail.name, 120), ...(req.typicalDetail.note ? { note: sanitizeModelText(req.typicalDetail.note, 400) } : {}) } } : {}),
      issueMode: req.issueMode ?? "family",
    };
  }

  private validityChanges(v: FamilyView, validity: C.Validity) {
    return v.instances
      .filter((i) => i.inheritance.state !== "exception" && i.inheritance.state !== "detached" && i.validity !== validity)
      .map((i) => ({ groupId: i.groupId, title: i.title, from: i.validity, to: validity }));
  }

  private spotCheckRequired(v: FamilyView): number {
    return Math.min(v.instanceCount, v.uniqueClashCount > 50 ? 3 : 1);
  }

  async familyDecisionPreview(familyId: string, req: Partial<C.FamilyDecisionRequest> & { testId: string }): Promise<C.FamilyDecisionPreview> {
    const { views } = await this.core.familyViewsFor(req.testId);
    const v = assertFamilyInTest(views, familyId);
    const f = this.decisionFields(v, req);
    const live = v.instances.filter((i) => i.inheritance.state !== "exception" && i.inheritance.state !== "detached");
    const raw = live.reduce((n, i) => n + i.rawClashCount, 0);
    const issueAction = f.action === "create_issue" || f.action === "hygiene_issue";
    return {
      familyId: v.id,
      instances: live.length,
      uniqueClashCount: live.reduce((n, i) => n + i.uniqueClashCount, 0),
      rawClashCount: raw,
      exceptions: v.counts.exceptions,
      pendingInherited: v.counts.pendingInherited,
      spotCheckRequired: this.spotCheckRequired(v),
      validityChanges: this.validityChanges(v, f.validity),
      issues: !issueAction ? 0 : f.issueMode === "family" ? Math.ceil(raw / 1000) : live.reduce((n, i) => n + Math.ceil(i.rawClashCount / 1000), 0),
    };
  }

  /** Approve / edit (new version) / reject a family. Human-only, audited, versioned. */
  async decideFamily(familyId: string, req: C.FamilyDecisionRequest, user: HumanUser): Promise<C.TriageFamily> {
    const { test, views } = await this.core.familyViewsFor(req.testId);
    const v = assertFamilyInTest(views, familyId);
    const prop = req.proposalId ? await this.store.getProposal(req.proposalId) : undefined;
    if (req.proposalId && (!prop || prop.payload.kind !== "family_decision" || prop.payload.familyId !== v.id)) throw new CoordError("not_found", `Propuesta ${req.proposalId} no es de la familia ${v.id}`);
    const now = nowIso(this.core.now());
    const note = req.note ? sanitizeModelText(req.note, 1000) : undefined;
    let fields: FamilyDecisionFields;
    let changes: Array<{ groupId: string; title: string; from: C.Validity; to: C.Validity }> = [];
    let spot: string[] = [];
    if (req.decision === "approve") {
      fields = this.decisionFields(v, req);
      spot = [...new Set(req.spotChecked ?? [])];
      const bad = spot.filter((g) => !v.groupIds.includes(g));
      if (bad.length) throw new CoordError("validation_error", `spotChecked fuera de la familia: ${bad.slice(0, 5).join(", ")}`);
      const need = this.spotCheckRequired(v);
      if (spot.length < need) throw new CoordError("validation_error", `Abre al menos ${plural(need, "ubicación", "ubicaciones")} antes de aprobar la familia (spotChecked).`);
      changes = this.validityChanges(v, fields.validity);
      if (changes.length && !req.acknowledgeValidityChanges) {
        throw new CoordError(
          "conflict",
          `${changes.length === 1 ? "1 ubicación cambiaría" : `${changes.length} ubicaciones cambiarían`} de validez (${changes.slice(0, 5).map((c) => `${c.groupId}: ${c.from}→${c.to}`).join(", ")}${changes.length > 5 ? ", …" : ""}).`,
          "Revisa la lista (POST /families/:id/decision-preview) y confirma con acknowledgeValidityChanges=true.",
        );
      }
    } else {
      const cur = v.decision;
      fields = cur ? { validity: cur.validity, action: cur.action, responsibleDiscipline: cur.responsibleDiscipline, issueMode: cur.issueMode } : { validity: v.proposed.validity, action: v.proposed.action, responsibleDiscipline: v.proposed.responsibleDiscipline, issueMode: "family" };
    }
    const covered = v.instances.filter((i) => i.inheritance.state !== "exception" && i.inheritance.state !== "detached").map((i) => i.groupId);
    await this.core.families.update(
      test.projectId,
      test.modelSetId,
      user,
      (st) => {
        const fs = (st.families[v.id] ??= { versions: [], exceptions: [], confirmed: [] });
        fs.versions.push({
          ...fields,
          familyId: v.id,
          version: fs.versions.length + 1,
          status: req.decision === "approve" ? "approved" : "rejected",
          decidedBy: user.name,
          decidedAt: now,
          spotChecked: spot,
          coveredGroupIds: req.decision === "approve" ? covered : [],
          testKey: test.testKey,
          ...(note ? { note } : {}),
          ...(changes.length ? { acknowledgedValidityChanges: changes.map((c) => c.groupId) } : {}),
        });
      },
      {
        action: req.decision === "approve" ? "family.decided" : "family.rejected",
        testKey: test.testKey,
        targetIds: [v.id, ...(req.proposalId ? [req.proposalId] : [])],
        details: { validity: fields.validity, action: fields.action, issueMode: fields.issueMode, instances: covered.length, validityChanges: changes.length, spotChecked: spot.length },
      },
    );
    {
      // F1: family decision references on the covered instances' clashes (reject removes them).
      const { cls } = await this.core.requireClassified(test.testKey);
      const prevRefs = (v.decision ? Array.from({ length: v.decision.version }, (_, i) => `${v.id}@v${i + 1}`) : []);
      const version = (v.decision?.version ?? 0) + 1;
      const effect: "issue" | "close" | "none" = fields.action === "create_issue" || fields.action === "hygiene_issue" ? "issue" : fields.action === "close" || fields.action === "mark_reviewed" ? "close" : "none";
      await this.core.recordDecisionRefs(
        test,
        cls,
        req.decision === "approve" ? covered.map((groupId) => ({ groupId, ref: { source: "family" as const, ref: `${v.id}@v${version}`, decision: fields.action, validity: fields.validity, effect, decidedBy: user.name, decidedAt: now } })) : [],
        prevRefs,
      );
    }
    if (prop && PENDING.has(prop.state)) {
      if (req.decision === "approve") {
        await this.store.transitionProposal(prop.id, "approved", user.name);
        await this.store.transitionProposal(prop.id, "applied", user.name, "decisión de familia registrada (local)");
      } else await this.store.transitionProposal(prop.id, "rejected", user.name);
    }
    return this.family(test.testKey, v.id);
  }

  async addFamilyException(familyId: string, body: { testId: string; groupId: string; fields: Partial<C.FamilyDecisionFields>; reason: string; proposalId?: string }, user: HumanUser): Promise<C.TriageFamily> {
    const { test, views } = await this.core.familyViewsFor(body.testId);
    const v = assertFamilyInTest(views, familyId);
    if (!v.groupIds.includes(body.groupId)) throw new CoordError("not_found", `La ubicación ${body.groupId} no pertenece a ${v.id}`);
    // Accepting an agent suggestion (propose_family_exception): it must be pending and about this instance.
    const prop = body.proposalId ? await this.store.getProposal(body.proposalId) : undefined;
    if (body.proposalId && (!prop || prop.payload.kind !== "family_exception" || prop.payload.groupId !== body.groupId || !(prop.payload.familyId === v.id || v.mergedFrom.includes(prop.payload.familyId)))) throw new CoordError("not_found", `Propuesta ${body.proposalId} no es una excepción de ${body.groupId} en ${v.id}`);
    if (prop && !PENDING.has(prop.state)) throw new CoordError("invalid_state", `La propuesta ${prop.id} ya está ${prop.state}`);
    if (prop && (body.fields.action === "close" || body.fields.action === "mark_reviewed") && v.instances.some((i) => i.groupId === body.groupId && (i.validity === "real" || i.validity === "needs_info"))) throw new CoordError("validation_error", "La ubicación es 'real' o 'needs_info': no se cierra.");
    const reason = sanitizeModelText(body.reason, 300).trim();
    if (!reason) throw new CoordError("validation_error", "La excepción requiere un motivo.");
    const rs = loadRules();
    const f = body.fields;
    if (f.validity === "real" && (f.action === "close" || f.action === "mark_reviewed")) throw new CoordError("validation_error", "Una ubicación 'real' no se cierra.");
    const fields: Partial<FamilyDecisionFields> = {
      ...(f.validity ? { validity: f.validity } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(f.responsibleDiscipline ? { responsibleDiscipline: assertCode(rs, f.responsibleDiscipline) } : {}),
      ...(f.secondaryDiscipline ? { secondaryDiscipline: assertCode(rs, f.secondaryDiscipline) } : {}),
      ...(f.solutionOption ? { solutionOption: sanitizeModelText(f.solutionOption, 300) } : {}),
      ...(f.issueMode ? { issueMode: f.issueMode } : {}),
    };
    await this.core.families.update(
      test.projectId,
      test.modelSetId,
      user,
      (st) => {
        const fs = (st.families[v.id] ??= { versions: [], exceptions: [], confirmed: [] });
        fs.exceptions = fs.exceptions.filter((e) => e.groupId !== body.groupId);
        const cur = fs.versions.filter((x) => x.status === "approved").pop();
        fs.exceptions.push({ groupId: body.groupId, fields, reason, by: user.name, at: nowIso(this.core.now()), ...(cur ? { decisionVersion: cur.version } : {}) });
      },
      { action: "family.exception", testKey: test.testKey, targetIds: [v.id, body.groupId], details: { reason: reason.slice(0, 80), validity: fields.validity ?? null, action: fields.action ?? null, ...(prop ? { proposalId: prop.id } : {}) } },
    );
    if (prop) {
      await this.store.transitionProposal(prop.id, "approved", user.name);
      await this.store.transitionProposal(prop.id, "applied", user.name, "excepción de familia registrada (local)");
    }
    return this.family(test.testKey, v.id);
  }

  async removeFamilyException(familyId: string, testId: string, groupId: string, user: HumanUser): Promise<C.TriageFamily> {
    const { test, views } = await this.core.familyViewsFor(testId);
    const v = assertFamilyInTest(views, familyId);
    await this.core.families.update(test.projectId, test.modelSetId, user, (st) => {
      const fs = st.families[v.id];
      if (!fs?.exceptions.some((e) => e.groupId === groupId)) throw new CoordError("not_found", `Sin excepción para ${groupId}`);
      fs.exceptions = fs.exceptions.filter((e) => e.groupId !== groupId);
    }, { action: "family.exception_removed", testKey: test.testKey, targetIds: [v.id, groupId] });
    return this.family(test.testKey, v.id);
  }

  /** "Confirmar N nuevas ubicaciones": inherited-pending instances become inherited (never automatic). */
  async confirmInherited(familyId: string, body: { testId: string; groupIds?: string[] }, user: HumanUser): Promise<C.TriageFamily> {
    const { test, views } = await this.core.familyViewsFor(body.testId);
    const v = assertFamilyInTest(views, familyId);
    const pending = v.instances.filter((i) => i.inheritance.state === "inherited_pending").map((i) => i.groupId);
    const ids = body.groupIds?.length ? body.groupIds : pending;
    const bad = ids.filter((g) => !pending.includes(g));
    if (bad.length) throw new CoordError("validation_error", `No están pendientes de confirmación: ${bad.slice(0, 5).join(", ")}`);
    if (!ids.length) throw new CoordError("validation_error", "No hay ubicaciones pendientes de confirmación.");
    const version = v.decision!.version;
    await this.core.families.update(test.projectId, test.modelSetId, user, (st) => {
      const fs = st.families[v.id]!;
      for (const g of ids) fs.confirmed.push({ groupId: g, version, by: user.id, at: nowIso(this.core.now()), testKey: test.testKey });
    }, { action: "family.inherited_confirmed", testKey: test.testKey, targetIds: [v.id, ...ids.slice(0, 20)], details: { confirmed: ids.length, version } });
    return this.family(test.testKey, v.id);
  }

  async detachInstance(familyId: string, body: { testId: string; groupId: string }, user: HumanUser): Promise<C.FamiliesPayload> {
    const { test, views } = await this.core.familyViewsFor(body.testId);
    const v = assertFamilyInTest(views, familyId);
    if (!v.groupIds.includes(body.groupId)) throw new CoordError("not_found", `La ubicación ${body.groupId} no pertenece a ${v.id}`);
    if (v.groupIds.length < 2) throw new CoordError("validation_error", "La familia tiene una sola ubicación.");
    const manual = `F-M${sha256(`${v.id}|${body.groupId}`).slice(0, 9)}`;
    await this.core.families.update(test.projectId, test.modelSetId, user, (st) => {
      st.detached[body.groupId] = { familyId: manual, by: user.name, at: nowIso(this.core.now()) };
    }, { action: "family.detached", testKey: test.testKey, targetIds: [v.id, body.groupId, manual] });
    return this.families(test.testKey);
  }

  async mergeFamilies(body: { testId: string; from: string; into: string }, user: HumanUser): Promise<C.FamiliesPayload> {
    const { test, views } = await this.core.familyViewsFor(body.testId);
    const from = assertFamilyInTest(views, body.from);
    const into = assertFamilyInTest(views, body.into);
    if (from.id === into.id) throw new CoordError("validation_error", "No se puede fusionar una familia consigo misma.");
    if (from.decision?.status === "approved") throw new CoordError("invalid_state", `${from.id} ya tiene una decisión; recházala antes de fusionarla.`);
    await this.core.families.update(test.projectId, test.modelSetId, user, (st) => {
      st.aliases[from.id] = into.id;
    }, { action: "family.merged", testKey: test.testKey, targetIds: [from.id, into.id] });
    return this.families(test.testKey);
  }

  /**
   * Chat panel: a human applies (or rejects) a regroup proposal (propose_group_action move_groups /
   * detach_clashes / merge_families / split_family) with the family merge / detach mechanics.
   * Re-validated against the current families. Local only; nothing goes to ACC.
   */
  async decideRegroup(proposalId: string, body: { testId: string; decision: "apply" | "reject" }, user: HumanUser): Promise<C.FamiliesPayload> {
    const p = await this.store.getProposal(proposalId);
    if (!p || p.payload.kind !== "group_action" || !isRegroup(p.payload.action)) throw new CoordError("not_found", `Propuesta de reagrupación ${proposalId} no existe`);
    if (p.state !== "draft" && p.state !== "pending_review") throw new CoordError("invalid_state", `La propuesta ${p.id} está ${p.state}.`);
    const { test, cls, views } = await this.core.familyViewsFor(body.testId);
    if (p.testKey && p.testKey !== test.testKey) throw new CoordError("validation_error", `La propuesta ${p.id} es del test ${p.testKey}.`);
    if (body.decision === "reject") {
      await this.store.transitionProposal(p.id, "rejected", user.name);
      return this.families(test.testKey);
    }
    const plan = planRegroup(p.payload.action as unknown as RegroupAction, cls, views, p.id);
    const at = nowIso(this.core.now());
    await this.core.families.update(test.projectId, test.modelSetId, user, (st) => applyPlan(st, plan, user.name, at), {
      action: "family.regrouped",
      testKey: test.testKey,
      targetIds: [p.id, ...plan.targetIds.slice(0, 20)],
      details: { type: p.payload.action.type, aliases: Object.keys(plan.aliases).length, detached: Object.keys(plan.detached).length },
    });
    await this.store.transitionProposal(p.id, "approved", user.name);
    await this.store.transitionProposal(p.id, "applied", user.name, "reagrupación aplicada (local)");
    return this.families(test.testKey);
  }

  // ── M3: issue checks (F2/F5), read-only against ACC ─────────────────────

  async issueChecks(testKey: string): Promise<C.IssueChecksPayload> {
    return this.core.issueChecksFor(testKey);
  }

  async reminders(testKey: string): Promise<C.IssueReminder[]> {
    const p = await this.core.issueChecksFor(testKey);
    return buildReminders(p.checks, p.version, nowIso(this.core.now()).slice(0, 10));
  }

  /**
   * The coordinator accepts or rejects a verdict (accept = "listo para mover en ACC" for resuelta,
   * "a la reunión" for dice_resuelta / sigue_abierta). Stored for the M5 gate and as a decision
   * with targetType "issue" (audited). Nothing is written to ACC.
   */
  async decideIssueVerdict(testKey: string, issueId: string, body: C.IssueVerdictDecisionRequest, user: HumanUser): Promise<C.IssueCheck> {
    const p = await this.core.issueChecksFor(testKey);
    const c = p.checks.find((x) => x.issueId === issueId);
    if (!c) throw new CoordError("not_found", `La incidencia ${issueId} no tiene verificación en ${testKey}`);
    if (body.decision === "reject" && !body.reasonCode) throw new CoordError("validation_error", "Rechazar un veredicto requiere reasonCode (V01–V05).");
    if (body.reasonCode === "R99" && !body.note?.trim()) throw new CoordError("validation_error", "R99 requiere una nota.");
    const { test } = await this.core.loadTest(testKey);
    const now = nowIso(this.core.now());
    const note = body.note ? sanitizeModelText(body.note, 1000) : undefined;
    await this.core.issueChecks.mutate(test.projectId, test.modelSetId, (f) => {
      const v = String(test.modelSetVersion);
      (f.decisions[v] ??= {})[issueId] = { verdict: c.verdict, kind: body.decision, ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}), ...(note ? { note } : {}), decidedBy: user.name, decidedAt: now, testKey: test.testKey };
      return true;
    });
    const id = `d-issue-${test.testKey}-${issueId}-${sha256(now).slice(0, 6)}`;
    await this.store.appendDecisions([
      {
        id,
        proposalId: `IC-${test.testKey}-${issueId}`,
        targetType: "issue",
        targetId: issueId,
        testId: test.testKey,
        modelSetId: test.modelSetId,
        projectId: bareProjectId(test.projectId),
        kind: body.decision,
        changes: [],
        ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}),
        note: note ?? `Veredicto ${c.verdict}`,
        viewedInViewerMs: 0,
        decidedAt: now,
        userId: user.id,
        userName: user.name,
        batchId: undefined,
        receivedAt: now,
      },
    ]);
    await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: "issue_check.decided", projectId: test.projectId, modelSetId: test.modelSetId, testId: test.testKey, targetIds: [issueId, id], details: { verdict: c.verdict, decision: body.decision, reasonCode: body.reasonCode ?? null } });
    return (await this.core.issueChecksFor(testKey)).checks.find((x) => x.issueId === issueId)!;
  }

  async issueGate(projectId: string, modelSetId: string): Promise<C.IssueGate> {
    const f = await this.core.issueChecks.load(withB(projectId), modelSetId);
    const tests = (await this.store.listTests()).filter((t) => t.modelSetId === modelSetId);
    return issueGate(f, (v) => tests.find((t) => t.modelSetVersion === v)?.testKey ?? "");
  }

  // ── X3 questions ─────────────────────────────────────────────────────────

  async questionsOf(testKey: string): Promise<C.CoordinatorQuestion[]> {
    const { test } = await this.core.loadTest(testKey);
    return (await this.core.questionsFor(test)).map(questionView);
  }

  /**
   * Human answer (POST /questions/:id/answer). validity / action answers become human decisions on
   * the question's groups (same path as the triage decisions: audit, learning loop, ledger refs);
   * "other" answers are stored for the next agent run (list_questions).
   */
  async answerQuestion(id: string, body: C.QuestionAnswerRequest, user: HumanUser): Promise<C.CoordinatorQuestion> {
    const q = await this.core.questions.get(id);
    if (!q) throw new CoordError("not_found", `Pregunta ${id} no existe`);
    if (q.state !== "open") throw new CoordError("invalid_state", `La pregunta ${id} está ${q.state === "stale" ? "obsoleta (sus interferencias cambiaron)" : "respondida"}.`);
    // Review fix #6: only a chosen OPTION's structured fields decide; free text is stored and decides nothing.
    const opt = body.optionIndex !== undefined ? q.options?.[body.optionIndex] : undefined;
    if (body.optionIndex !== undefined && !opt) throw new CoordError("validation_error", `La opción ${body.optionIndex} no existe.`);
    const free = body.answer ? sanitizeModelText(body.answer, 1000).trim() : "";
    const answer = [opt?.label, free].filter(Boolean).join(" — ");
    if (!answer) throw new CoordError("validation_error", "Elige una opción o escribe una respuesta.");
    const decides = !!opt && ((q.kind === "validity" && !!opt.validity) || (q.kind === "action" && !!opt.action));
    const decisionIds: string[] = [];
    if (decides) {
      const { test, cls, byGroup } = await this.testContext(q.testKey);
      const targets = q.groupIds.map((gid) => cls.groups.find((x) => x.id === gid)).filter((g): g is GroupRecord => !!g);
      if (targets.length > 3 && body.confirmCount !== targets.length) {
        throw new CoordError("conflict", `Esta respuesta decide ${targets.length} ubicaciones: confirma con confirmCount=${targets.length}.`);
      }
      const now = nowIso(this.core.now());
      const decisions: C.Decision[] = [];
      for (const g of targets) {
        const view = this.proposalView(g, test, cls, byGroup.get(g.id) ?? []);
        const base = { proposalId: view.id, targetType: "group" as const, targetId: g.id, testId: test.testKey, modelSetId: test.modelSetId, projectId: bareProjectId(test.projectId), viewedInViewerMs: 0, decidedAt: now, userId: user.id, userName: user.name };
        const did = `d-${q.id}-${g.id}`;
        const note = `Respuesta a ${q.id}: ${answer}`.slice(0, 1000);
        if (q.kind === "validity") {
          const same = opt!.validity === view.fields.validity.value;
          decisions.push({ ...base, id: did, kind: same ? "accept" : "correct", changes: same ? [] : [{ field: "validity", aiValue: view.fields.validity.value, humanValue: opt!.validity }], ...(same ? {} : { reasonCode: body.reasonCode ?? "R99", note }) });
        } else if (opt!.action === "postpone") {
          decisions.push({ ...base, id: did, kind: "postpone", changes: [], note });
        } else {
          const want: C.ProposedAction = opt!.action === "create_issue" ? { createIssue: true, setStatus: null } : { createIssue: false, setStatus: opt!.action === "close" ? "closed" : "reviewed" };
          const cur = view.fields.action.value;
          const same = cur.createIssue === want.createIssue && cur.setStatus === want.setStatus;
          if (!same && want.setStatus === "closed" && !body.reasonCode) throw new CoordError("validation_error", "Cerrar requiere reasonCode.");
          decisions.push({ ...base, id: did, kind: same ? "accept" : "correct", changes: same ? [] : [{ field: "action", aiValue: cur, humanValue: want }], ...(same ? {} : { reasonCode: body.reasonCode ?? "R99", note }) });
        }
      }
      // Question-derived corrections are tagged and kept OUT of the learning loop (review fix #6).
      const r = await this.saveDecisions(decisions, user, { source: "question" });
      decisionIds.push(...r.saved);
    }
    const updated = await this.core.questions.update(id, (x) => {
      x.state = "answered";
      x.answer = answer;
      x.answeredBy = user.id;
      x.answeredAt = nowIso(this.core.now());
      if (decisionIds.length) x.decisionIds = decisionIds;
    });
    await this.store.audit({ actor: { type: "user", id: user.id, name: user.name }, action: "question.answered", projectId: q.projectId, modelSetId: q.modelSetId, testId: q.testKey, targetIds: [q.id, ...decisionIds.slice(0, 10)], details: { kind: q.kind, decisions: decisionIds.length, option: body.optionIndex ?? null, validity: opt?.validity ?? null, action: opt?.action ?? null } });
    return questionView(updated);
  }

  /** Assign body for a set of clashes (shared by family issue items). */
  private assignBody(seed: string, test: TestRecord, chunk: readonly ClashRecord[], issue: { title: string; description: string; dueDate: string }, preferredRepId?: string): { body: AssignedGroupCreate; conflict?: { reason: string; accValueNow: null } } {
    const rep = chunk.find((c) => c.id === preferredRepId) ?? [...chunk].sort((a, b) => b.penetrationMm - a.penetrationMm || (a.id < b.id ? -1 : 1))[0]!;
    const doc = test.documents.find((x) => x.documentId === rep.a.documentId);
    const typeId = this.core.config.issues.issueTypeId ?? (this.core.source.kind === "fixtures" ? "00000000-0000-4000-a000-00000000f1a7" : undefined);
    const subId = this.core.config.issues.issueSubtypeId ?? (this.core.source.kind === "fixtures" ? "00000000-0000-4000-a000-00000000f1a8" : undefined);
    const body: AssignedGroupCreate = {
      id: uuidFromHash(sha256(`${seed}|assign`)),
      title: issue.title.slice(0, 100),
      description: issue.description.slice(0, 1000),
      dueDate: issue.dueDate,
      status: "Open",
      pushpin: { location: rep.a.bboxCenterM ?? { x: 0, y: 0, z: 0 }, objectId: rep.a.dbId, ...(rep.a.externalId ? { externalId: rep.a.externalId } : {}), type: "TwoDVectorPushpin" },
      clashes: chunk.map((c) => Number(c.id)),
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
    return { body, ...(conflict ? { conflict } : {}) };
  }

  /**
   * Family work still to send for one test: per approved, non-escalate family decision, its inherited
   * instances (they skip the group flow) and `todo`: those not yet in a non-discarded batch (minus
   * `ignoreBatchIds`) that still have a clash outside ACC. Shared by {@link familyBatchItems} and
   * TriageFamily.pendingSend, so the toolbar counts exactly what "Enviar a aprobación" would send.
   */
  private async familyTodo(test: TestRecord, cls: ClassificationRecord, views: readonly FamilyView[], opts: { ignoreBatchIds?: ReadonlySet<string> } = {}) {
    type Inst = FamilyView["instances"][number];
    const families: Array<{ v: FamilyView; dec: NonNullable<FamilyView["decision"]>; issue: boolean; op: "clash.assign" | "clash.close"; inherited: Inst[]; todo: Inst[] }> = [];
    const issuedFamilies = new Set<string>();
    if (!cls.families) return { families, issuedFamilies };
    const batches = (await this.store.listBatches()).filter((b) => b.modelSetId === test.modelSetId && b.state !== "discarded" && !opts.ignoreBatchIds?.has(b.id));
    const done = new Set<string>();
    for (const b of batches) for (const i of b.items) if (i.familyId && !i.excluded) {
      for (const g of i.groupIds ?? []) done.add(`${i.familyId}|${g}|${i.mcOperation}`);
      if (i.mcOperation === "clash.assign" && b.testKey !== test.testKey) issuedFamilies.add(i.familyId);
    }
    const hasLive = new Set(cls.clashes.filter(this.notInAcc(test.testKey)).map((c) => c.groupId));
    for (const v of views) {
      const dec = v.decision;
      if (!dec || dec.status !== "approved" || dec.action === "escalate") continue;
      const issue = dec.action === "create_issue" || dec.action === "hygiene_issue";
      const op = issue ? "clash.assign" : "clash.close";
      const inherited = v.instances.filter((i) => i.inheritance.state === "inherited");
      // Review fix #1: a close never carries an instance whose CURRENT validity is real / needs_info.
      const closable = (i: Inst) => issue || (i.validity !== "real" && i.validity !== "needs_info");
      const todo = inherited.filter((i) => closable(i) && hasLive.has(i.groupId) && !done.has(`${v.id}|${i.groupId}|${op}`));
      families.push({ v, dec, issue, op, inherited, todo });
    }
    return { families, issuedFamilies };
  }

  /** familyId → inherited instances decided but not yet sent to approval (TriageFamily.pendingSend). */
  private async familyPendingSend(test: TestRecord, cls: ClassificationRecord, views: readonly FamilyView[]): Promise<Map<string, number>> {
    const { families } = await this.familyTodo(test, cls, views);
    return new Map(families.map((f) => [f.v.id, f.todo.length]));
  }

  /**
   * Batch items of decided families: ONE assign (issue) per family (chunks of 1,000 clashes) or one
   * per instance (issueMode per_instance), or ONE close per family. Only inherited instances: pending
   * (new since the decision) and exceptions are never included automatically.
   */
  private async familyBatchItems(
    batchId: string,
    test: TestRecord,
    cls: ClassificationRecord,
    user: HumanUser,
    opts: { ignoreBatchIds?: ReadonlySet<string>; onlyFamilies?: ReadonlySet<string> } = {},
  ): Promise<{ items: BatchItemRecord[]; covered: Set<string> }> {
    const items: BatchItemRecord[] = [];
    const covered = new Set<string>();
    if (!cls.families) return { items, covered };
    const views = (await this.core.familyViewsFor(test.testKey)).views;
    const { families, issuedFamilies } = await this.familyTodo(test, cls, views, opts);
    const byGroup = new Map<string, ClashRecord[]>();
    for (const c of cls.clashes) byGroup.set(c.groupId, [...(byGroup.get(c.groupId) ?? []), c]);
    const gById = new Map(cls.groups.map((g) => [g.id, g]));
    const due = new Date(this.core.now() + this.core.config.issues.defaultDueInDays * 86_400_000).toISOString().slice(0, 10);
    for (const { v, dec, issue, inherited, todo } of families) {
      // Every approved family covers its inherited instances (they never go through the group flow).
      for (const i of inherited) covered.add(i.groupId);
      if (opts.onlyFamilies && !opts.onlyFamilies.has(v.id)) continue;
      if (!todo.length) continue;
      const changes = this.validityChanges(v, dec.validity).filter((c) => todo.some((t) => t.groupId === c.groupId));
      const common = {
        proposalIds: [] as string[],
        decisionIds: [`FD-${v.id}-v${dec.version}`],
        origin: "manual" as const,
        reviewer: dec.decidedBy,
        // The spot-check was made on the version the decision was taken on: never carried to another one.
        viewedInViewer: dec.spotChecked.length > 0 && dec.testKey === test.testKey,
        familyId: v.id,
        familyDecisionVersion: dec.version,
        ...(changes.length ? { validityChanges: changes } : {}),
      };
      const cycle = issuedFamilies.has(v.id) ? `[${v.id} · ciclo v${test.modelSetVersion}]` : `[${v.id}]`;
      const units: Array<{ key: string; instances: typeof todo; label: string }> =
        issue && dec.issueMode === "per_instance" ? todo.map((i) => ({ key: i.groupId, instances: [i], label: `${cycle} ${i.title}` })) : [{ key: "family", instances: todo, label: `${cycle} ${v.title}` }];
      for (const u of units) {
        const clashes = u.instances.flatMap((i) => byGroup.get(i.groupId) ?? []).filter(this.notInAcc(test.testKey));
        const chunks: ClashRecord[][] = [];
        for (let k = 0; k < clashes.length; k += 1000) chunks.push(clashes.slice(k, k + 1000));
        chunks.forEach((chunk, ci) => {
          const suffix = chunks.length > 1 ? ` (${ci + 1}/${chunks.length})` : "";
          const seed = `${batchId}|${v.id}|${u.key}|${ci}`;
          const groupIds = [...new Set(chunk.map((c) => c.groupId))];
          const id = `I-${sha256(seed).slice(0, 10)}`;
          const label = sanitizeModelText(`${u.label}${suffix}`, 160);
          if (issue) {
            const description = familyIssueDescription(v, dec, u.instances.filter((i) => groupIds.includes(i.groupId)));
            const worst = groupIds.map((g) => gById.get(g)).filter((g): g is GroupRecord => !!g).sort((a, b) => a.band - b.band || b.maxPenetrationMm - a.maxPenetrationMm)[0];
            const { body, conflict } = this.assignBody(seed, test, chunk, { title: fitTitle(u.label, suffix, 100), description, dueDate: due }, worst?.representativeClashId);
            items.push({
              ...common,
              id,
              targetType: "group",
              targetIds: chunk.map((c) => `C-${c.id}`),
              groupIds,
              label,
              operation: "issue.create",
              mcOperation: "clash.assign",
              fields: [{ field: "issue", accCurrent: null, accNew: body.title }, { field: "status", accCurrent: "active", accNew: "assigned" }],
              accNew: body,
              excluded: !!conflict,
              ...(conflict ? { conflict } : {}),
              issue: { title: body.title, description: body.description, ownerDiscipline: dec.responsibleDiscipline, dueDate: due, includeView: true, linkClashIds: [], priorityLabel: `P${v.proposed.band}` },
            });
          } else {
            const body: ClosedGroupCreate = {
              id: uuidFromHash(sha256(`${seed}|close`)),
              title: label.slice(0, 128),
              // No personal data in ACC bodies (review fix #3): the decider stays in the audit log only.
              description: `${v.title}. Cerrada: ${dec.validity === "tolerated" ? "tolerancia aceptada" : dec.validity === "false_positive" ? "no es interferencia" : dec.validity}${v.parts.hostType && v.parts.problemType === "PT14" ? ` (${v.parts.hostType})` : ""}. Decisión de coordinación v${dec.version}.`.slice(0, 1024),
              reason: dec.action === "mark_reviewed" || dec.validity === "tolerated" ? "MINIMAL_OVERLAP" : this.closeReason(dec.validity, v.parts.problemType === "PT12" ? "duplicate" : "", undefined),
              clashes: chunk.map((c) => Number(c.id)),
            };
            const real = dec.validity === "real";
            items.push({
              ...common,
              id,
              targetType: "group",
              targetIds: chunk.map((c) => `C-${c.id}`),
              groupIds,
              label,
              operation: "clash.setStatus",
              mcOperation: "clash.close",
              fields: [{ field: "status", accCurrent: "active", accNew: "closed" }],
              accNew: body,
              excluded: real,
              ...(real ? { conflict: { reason: "Cierre de una familia de validez 'real': revisar antes de incluir", accValueNow: "active" } } : {}),
            });
          }
        });
      }
    }
    void user;
    return { items, covered };
  }

  async disciplineConfig(projectId: string): Promise<C.DisciplineConfig> {
    const cfg = await this.core.disciplines.load(withB(projectId));
    const pending = await this.store.listProposals((p) => p.payload.kind === "discipline_mapping" && p.projectId !== undefined && bareProjectId(p.projectId) === bareProjectId(projectId) && (p.state === "pending_review" || p.state === "draft"));
    return {
      version: cfg.version,
      assignments: cfg.assignments,
      rules: cfg.rules,
      codes: validCodes(loadRules()),
      fileNameDetection: this.core.config.disciplines.fileNameDetection,
      pendingProposals: pending.map((p) => ({ id: p.id, summary: proposalSummary(p), rationale: p.rationale, createdAt: p.createdAt, payload: p.payload as unknown as Record<string, unknown> })),
    };
  }

  private ruleFrom(input: { match: DisciplineRule["match"]; value: string; field: DisciplineRule["field"] }, discipline: string, user: HumanUser, existing: DisciplineRule[]): DisciplineRule {
    if (input.match === "regex") {
      try {
        new RegExp(input.value, "i");
      } catch {
        throw new CoordError("validation_error", `Expresión regular inválida: ${input.value}`);
      }
    }
    let n = existing.length + 1;
    while (existing.some((r) => r.id === `DR-${String(n).padStart(3, "0")}`)) n++;
    return { id: `DR-${String(n).padStart(3, "0")}`, match: input.match, value: input.value, field: input.field, discipline, createdBy: user.name, createdAt: nowIso(this.core.now()) };
  }

  /** Assign one document (exact lineage), optionally saving a rule from it; re-classify; return the grid. */
  async setDocumentDiscipline(
    projectId: string,
    modelSetId: string,
    lineageUrn: string,
    body: { discipline: string; createRule?: { match: DisciplineRule["match"]; value: string; field: DisciplineRule["field"] } },
    user: HumanUser,
    test?: string,
  ): Promise<C.ClashGrid> {
    const rs = loadRules();
    const discipline = assertCode(rs, body.discipline);
    const known = (await this.store.listTests()).some((t) => t.modelSetId === modelSetId && t.documents.some((d) => d.lineageUrn === lineageUrn));
    if (!known) throw new CoordError("not_found", "Documento no encontrado en las pruebas en caché de este conjunto.");
    await this.core.disciplines.update(withB(projectId), user, (cfg) => {
      cfg.assignments[lineageUrn] = discipline;
      if (body.createRule) cfg.rules.push(this.ruleFrom(body.createRule, discipline, user, cfg.rules));
    }, "discipline.assigned", { lineageUrn, discipline, ruleCreated: !!body.createRule });
    await this.core.reclassifyCached({ projectId: withB(projectId), modelSetId }, { actor: { type: "user", id: user.id, name: user.name } });
    return this.clashGrid(projectId, modelSetId, test);
  }

  /** Replace the ordered rule list; re-classify every classified test of the project. */
  async replaceDisciplineRules(projectId: string, rules: Array<Pick<DisciplineRule, "match" | "value" | "field" | "discipline"> & { id?: string }>, user: HumanUser): Promise<C.DisciplineConfig & { reclassified: string[] }> {
    const rs = loadRules();
    const prev = new Map((await this.core.disciplines.load(withB(projectId))).rules.map((r) => [r.id, r]));
    const next: DisciplineRule[] = [];
    for (const r of rules) {
      const d = assertCode(rs, r.discipline);
      const keep = r.id && /^DR-\d{3,}$/.test(r.id) && !next.some((x) => x.id === r.id);
      const old = keep ? prev.get(r.id!) : undefined;
      const fresh = this.ruleFrom(r, d, user, [...next, ...prev.values()]);
      next.push(keep ? { ...fresh, id: r.id!, ...(old ? { createdBy: old.createdBy, createdAt: old.createdAt } : {}) } : fresh);
    }
    await this.core.disciplines.update(withB(projectId), user, (cfg) => void (cfg.rules = next), "discipline.rules_replaced", { rules: next.length });
    const reclassified = await this.core.reclassifyCached({ projectId: withB(projectId) }, { actor: { type: "user", id: user.id, name: user.name } });
    return { ...(await this.disciplineConfig(projectId)), reclassified };
  }

  /** Which cached documents each rule would match (no changes). */
  async previewDisciplineRules(projectId: string, rules: Array<Pick<DisciplineRule, "match" | "value" | "field" | "discipline"> & { id?: string }>): Promise<C.DisciplinePreview> {
    const docs = new Map<string, { lineageUrn: string; fileName: string; viewName: string; modelSetId: string }>();
    for (const t of (await this.store.listTests()).filter((x) => bareProjectId(x.projectId) === bareProjectId(projectId))) {
      for (const d of this.docInfos(t)) {
        const k = d.lineageUrn ?? `${t.modelSetId}:${d.documentId}`;
        if (!docs.has(k)) docs.set(k, { lineageUrn: d.lineageUrn ?? "", fileName: d.fileName, viewName: d.viewName, modelSetId: t.modelSetId });
      }
    }
    const all = [...docs.values()];
    const claimed = new Set<string>();
    return {
      rules: rules.map((r, i) => {
        const matches = all.filter((d) => ruleMatches(r, { documentId: 0, lineageUrn: d.lineageUrn, fileName: d.fileName, viewName: d.viewName }));
        const effective = matches.filter((d) => !claimed.has(d.lineageUrn));
        for (const d of effective) claimed.add(d.lineageUrn);
        return { index: i, ...(r.id ? { id: r.id } : {}), matches, effective: effective.length };
      }),
    };
  }

  /** Human decision on an agent's discipline-mapping proposal. */
  async decideDisciplineProposal(projectId: string, proposalId: string, decision: "accept" | "reject", user: HumanUser): Promise<C.DisciplineConfig> {
    const p = await this.store.getProposal(proposalId);
    if (!p || p.payload.kind !== "discipline_mapping" || !p.projectId || bareProjectId(p.projectId) !== bareProjectId(projectId)) throw new CoordError("not_found", `Propuesta ${proposalId} no existe`);
    if (decision === "reject") {
      await this.store.transitionProposal(p.id, "rejected", user.name);
      return this.disciplineConfig(projectId);
    }
    const pl = p.payload;
    await this.core.disciplines.update(withB(projectId), user, (cfg) => {
      if (pl.lineageUrn) cfg.assignments[pl.lineageUrn] = pl.discipline;
      if (pl.rule) cfg.rules.push(this.ruleFrom(pl.rule, pl.discipline, user, cfg.rules));
    }, "discipline.proposal_accepted", { proposalId: p.id, discipline: pl.discipline });
    await this.store.transitionProposal(p.id, "approved", user.name);
    await this.store.transitionProposal(p.id, "applied", user.name, "mapeo de disciplina aplicado (local)");
    await this.core.reclassifyCached({ projectId: withB(projectId), ...(pl.modelSetId ? { modelSetId: pl.modelSetId } : {}) }, { actor: { type: "user", id: user.id, name: user.name } });
    return this.disciplineConfig(projectId);
  }
}

/**
 * ACC issue title ≤ max characters that never loses the chunk suffix " (k/n)" / "#k":
 * the base is cut on a word boundary with an ellipsis.
 */
export function fitTitle(base: string, suffix: string, max: number): string {
  if (base.length + suffix.length <= max) return base + suffix;
  const room = Math.max(1, max - suffix.length - 1);
  const cut = base.slice(0, room);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > room * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…${suffix}`;
}

/** G3: copy an issue text edited in an old batch item onto its re-based item (ACC body + preview). */
function copyIssueText(from: BatchItemRecord, to: BatchItemRecord): void {
  const a = from.accNew as AssignedGroupCreate;
  const b = to.accNew as AssignedGroupCreate;
  b.title = a.title;
  b.description = a.description;
  if (a.dueDate) b.dueDate = a.dueDate;
  if (a.assignedTo) {
    b.assignedTo = a.assignedTo;
    b.assignedToType = a.assignedToType;
  }
  to.issue = { ...(to.issue ?? {}), ...(from.issue ?? {}), linkClashIds: to.issue?.linkClashIds ?? [] } as BatchItemRecord["issue"];
  to.fields = to.fields.map((f) => (f.field === "issue" ? { ...f, accNew: b.title } : f));
  if (to.origin === "ai_accepted") to.origin = "ai_corrected";
  to.reasonCode = "R13";
}

export { AGENT_ACTOR };
