/**
 * "Qué sigue" (docs/domain/next-steps-and-flows.md): where a project stands in the weekly
 * coordination cycle and what to do next, computed ONLY from server state (store, ledger, cached
 * ACC reads) — no LLM, no free text from models in titles or reasons. Each step either runs a
 * domain flow (agent work: proposals, questions, drafts, reports) or opens a UI location where a
 * human decides (answer, send, approve with passkey, apply, publish).
 *
 * Used by GET /next-steps (UI), the MCP read tool get_next_steps (chat / VS Code) and the chat cards.
 * The in-app agent ships with the app (agent-runtime/): there is no "update the agent" step.
 */
import { runtimeAgentSourceExists } from "./agent-runtime";
import type * as C from "./api/contract";
import type { Coordinator } from "./coordinator";
import { CoordinatorUi } from "./coordinator-ui";
import { outCode, SIN } from "./disciplines";
import { FLOW_AGENT } from "./flows/agent";
import { FlowRunStore, runView } from "./flows/store";
import { listReportFiles } from "./parity";
import type { ClassificationRecord, ProposalRecord, TestRecord } from "./store/types";
import { bareProjectId, CoordError, log, nowIso, plural } from "./util";

const FALLBACK_RULE = "DEF-999";
const PENDING = new Set(["draft", "pending_review"]);
const LIVE = new Set(["draft", "pending_review", "approved", "applied"]);
/** A finished flow suppresses the same suggestion for the same test this long. */
const RECENT_FLOW_MS = 24 * 60 * 60_000;
export const NEXT_STEPS_MAX = 12;

/** Thresholds (documented in docs/domain/next-steps-and-flows.md). */
export const THRESHOLDS = {
  unassignedClashes: 10,
  duplicateClashes: 20,
  fallbackClashes: 20,
  uncuratedFeedback: 5,
} as const;

export interface NextStepsOptions {
  /** App folder holding agent-runtime/ (tests). Default coord.root. */
  agentRoot?: string;
  /** Override "now" (tests). */
  now?: number;
}

type Ctx = { projectId: string; modelSetId: string; testKey: string; version: number };

function triageParams(c: Ctx, extra: Record<string, string> = {}): Record<string, string> {
  return { projectId: c.projectId, modelSetId: c.modelSetId, testKey: c.testKey, ...extra };
}

async function resolveTest(coord: Coordinator, q: { projectId?: string; testKey?: string }): Promise<{ projectId?: string; test?: TestRecord }> {
  if (q.testKey) {
    const test = await coord.store.getTest(q.testKey);
    if (!test) throw new CoordError("not_found", `El test ${q.testKey} no está en caché.`);
    if (q.projectId && bareProjectId(test.projectId) !== bareProjectId(q.projectId)) throw new CoordError("validation_error", "El test no pertenece a ese proyecto.");
    return { projectId: bareProjectId(test.projectId), test };
  }
  const ctx = await coord.store.getContext();
  const projectId = q.projectId ? bareProjectId(q.projectId) : ctx?.projectId ? bareProjectId(ctx.projectId) : undefined;
  if (!projectId) return {};
  const tests = (await coord.store.listTests()).filter((t) => bareProjectId(t.projectId) === projectId);
  if (ctx?.testKey && ctx.projectId && bareProjectId(ctx.projectId) === projectId) {
    const t = tests.find((x) => x.testKey === ctx.testKey);
    // The active test unless a newer version of the same model set is cached.
    if (t && !tests.some((x) => x.modelSetId === t.modelSetId && x.modelSetVersion > t.modelSetVersion)) return { projectId, test: t };
  }
  const sorted = [...tests].sort((a, b) => b.modelSetVersion - a.modelSetVersion || (a.ingestedAt < b.ingestedAt ? 1 : -1));
  return { projectId, ...(sorted[0] ? { test: sorted[0] } : {}) };
}

/** Compute the ordered next steps of a project / test. */
export async function nextSteps(coord: Coordinator, q: { projectId?: string; testKey?: string }, opts: NextStepsOptions = {}): Promise<C.NextStepsPayload> {
  const now = opts.now ?? coord.now();
  const { projectId, test } = await resolveTest(coord, q);
  const steps: C.NextStep[] = [];
  const add = (s: C.NextStep) => steps.push(s);
  const safe = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      log.warn("next_steps.partial", { what, message: (err as Error).message.slice(0, 200) });
    }
  };
  const flowsAvailable = runtimeAgentSourceExists(opts.agentRoot ?? coord.root, FLOW_AGENT);
  const runs = new FlowRunStore(coord.store);
  const projectRuns = projectId ? await runs.list({ projectId }).catch(() => []) : [];
  const active = projectRuns.find((r) => runs.isActive(r, now));
  /** A finished run of `flow` for this test within RECENT_FLOW_MS (the suggestion would repeat itself). */
  const ranRecently = (flow: C.FlowId, testKey?: string, since?: string) =>
    projectRuns.some((r) => r.flowId === flow && r.state === "finished" && (!testKey || r.testKey === testKey) && !!r.finishedAt && now - Date.parse(r.finishedAt) < RECENT_FLOW_MS && (!since || r.finishedAt > since));

  if (!projectId) return { computedAt: nowIso(now), steps: finish(steps), flowsAvailable, ...(active ? { runningFlow: runView(active) } : {}) };

  // ── batches (human: approve with passkey, apply, rebase) ───────────────────
  await safe("batches", async () => {
    const batches = (await coord.store.listBatches()).filter((b) => bareProjectId(b.projectId) === projectId && ["draft", "ready", "approved", "partial"].includes(b.state));
    for (const b of batches) {
      const inc = b.items.filter((i) => !i.excluded);
      const counts = { items: inc.length, issues: inc.filter((i) => i.mcOperation === "clash.assign").length, closes: inc.filter((i) => i.mcOperation === "clash.close").length };
      const rb = b.state === "partial" ? undefined : await coord.batchRebaseInfo(b).catch(() => undefined);
      if (rb?.stale) {
        add({
          id: `batch_stale:${b.id}`,
          kind: "batch_stale",
          priority: 12,
          title: `Llevar el lote ${b.id} a v${rb.latestVersion}`,
          reason: `El lote se armó sobre v${b.modelSetVersion} y la última versión es v${rb.latestVersion}: revísalo y usa «Llevar decisiones a v${rb.latestVersion}» antes de aprobar o aplicar.`,
          counts: { ...counts, fromVersion: b.modelSetVersion, toVersion: rb.latestVersion },
          action: { type: "open", route: "batch", params: { batchId: b.id } },
        });
      } else if (b.state === "approved" || b.state === "partial") {
        add({
          id: `batch_approved:${b.id}`,
          kind: "batch_approved",
          priority: 10,
          title: b.state === "partial" ? `Revisar fallas del lote ${b.id}` : `Aplicar el lote ${b.id} en ACC`,
          reason:
            b.state === "partial"
              ? `El lote se aplicó parcialmente: ${plural(inc.filter((i) => i.result?.status === "failed").length, "ítem falló", "ítems fallaron")}.`
              : `Aprobado con passkey y sin aplicar: ${plural(counts.issues, "incidencia", "incidencias")} y ${plural(counts.closes, "cierre", "cierres")} esperan (primero el ensayo, sin escribir en ACC).`,
          counts,
          action: { type: "open", route: "batch", params: { batchId: b.id } },
        });
      } else if (b.state === "ready") {
        add({
          id: `batch_ready:${b.id}`,
          kind: "batch_ready",
          priority: 20,
          title: `Aprobar el lote ${b.id}`,
          reason: `Listo para tu revisión: ${plural(counts.items, "ítem", "ítems")} (${plural(counts.issues, "incidencia", "incidencias")}, ${plural(counts.closes, "cierre", "cierres")}). Se aprueba con passkey.`,
          counts,
          action: { type: "open", route: "batch", params: { batchId: b.id } },
        });
      }
    }
  });

  // ── new model-set version / not ingested / not classified ──────────────────
  const st: { cls?: ClassificationRecord } = {};
  await safe("version", async () => {
    if (!test) {
      const sets = await coord.source.listModelSets(`b.${projectId}`).catch(() => []);
      const s = sets[0];
      if (s)
        add({
          id: `new_version:${s.id}`,
          kind: "new_version",
          priority: 5,
          title: "Preparar el primer ciclo",
          reason: `El proyecto no tiene versiones analizadas; ACC tiene v${s.latestVersion} del conjunto de modelos.`,
          counts: { latestVersion: s.latestVersion },
          action: { type: "flow", flow: "preparar-ciclo", args: { projectId } },
        });
      return;
    }
    const cachedMax = Math.max(...(await coord.store.listTests()).filter((t) => t.modelSetId === test.modelSetId && bareProjectId(t.projectId) === projectId).map((t) => t.modelSetVersion));
    const latest = await coord.source.latestVersion(test.projectId, test.modelSetId).catch(() => undefined);
    if (latest !== undefined && latest > cachedMax) {
      add({
        id: `new_version:${test.modelSetId}:${latest}`,
        kind: "new_version",
        priority: 5,
        title: `Preparar el ciclo de v${latest}`,
        reason: `ACC tiene la versión v${latest} del conjunto de modelos; la última analizada es v${cachedMax}.`,
        counts: { latestVersion: latest, analyzedVersion: cachedMax },
        action: { type: "flow", flow: "preparar-ciclo", args: { projectId } },
      });
    }
    st.cls = await coord.store.getClassification(test.testKey);
    if (!st.cls)
      add({
        id: `not_classified:${test.testKey}`,
        kind: "not_classified",
        priority: 6,
        title: `Clasificar v${test.modelSetVersion}`,
        reason: `La versión v${test.modelSetVersion} está descargada pero sin clasificar: el motor aún no agrupó ni priorizó sus ${plural(test.counts.clashes, "interferencia", "interferencias")}.`,
        counts: { clashes: test.counts.clashes },
        action: { type: "flow", flow: "preparar-ciclo", args: { projectId, testKey: test.testKey } },
      });
  });

  const cls = st.cls;
  if (test && cls) {
    const c: Ctx = { projectId, modelSetId: test.modelSetId, testKey: test.testKey, version: test.modelSetVersion };
    await testSteps(coord, test, cls, c, add, safe, { ranRecently, projectRuns, now });
  }

  // ── rules (company scope) ──────────────────────────────────────────────────
  await safe("rules", async () => {
    const rc = await coord.store.listProposals((p) => p.kind === "rule_change" && (PENDING.has(p.state) || p.state === "approved"));
    const pending = rc.filter((p) => PENDING.has(p.state)).length;
    const approved = rc.length - pending;
    if (rc.length)
      add({
        id: "rule_suggestions",
        kind: "rule_suggestions",
        priority: 55,
        title: "Revisar sugerencias de reglas",
        reason: `${plural(pending, "sugerencia espera", "sugerencias esperan")} tu revisión${approved ? ` y ${plural(approved, "aprobada espera", "aprobadas esperan")} publicarse con passkey` : ""} en Reglas › Sugerencias pendientes.`,
        counts: { pending, approved },
        action: { type: "open", route: "rules", params: {} },
      });
    const feedback = (await coord.store.listFeedback()).filter((f) => !f.curated);
    const lastFeedback = feedback.map((f) => f.at).sort().at(-1);
    const fallback = cls ? cls.clashes.filter((x) => x.ruleId === FALLBACK_RULE).length : 0;
    if ((feedback.length >= THRESHOLDS.uncuratedFeedback || fallback >= THRESHOLDS.fallbackClashes) && !ranRecently("curar-reglas", undefined, lastFeedback))
      add({
        id: "rule_insights",
        kind: "rule_insights",
        priority: 65,
        title: "Curar reglas",
        reason: [
          feedback.length >= THRESHOLDS.uncuratedFeedback ? `${plural(feedback.length, "corrección sin curar", "correcciones sin curar")}` : "",
          fallback >= THRESHOLDS.fallbackClashes ? `${plural(fallback, "interferencia", "interferencias")} sin regla (DEF-999) en v${test?.modelSetVersion ?? "?"}` : "",
        ]
          .filter(Boolean)
          .join(" y ") + ": el agente puede proponer reglas nuevas o calibraciones (tú apruebas y publicas).",
        counts: { uncuratedFeedback: feedback.length, fallbackClashes: fallback },
        action: { type: "flow", flow: "curar-reglas", args: { projectId, ...(test ? { testKey: test.testKey } : {}) } },
      });
  });

  return {
    projectId,
    ...(test ? { modelSetId: test.modelSetId, testKey: test.testKey, version: test.modelSetVersion } : {}),
    computedAt: nowIso(now),
    steps: finish(steps),
    flowsAvailable,
    ...(active ? { runningFlow: runView(active) } : {}),
  };
}

function finish(steps: C.NextStep[]): C.NextStep[] {
  return steps.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).slice(0, NEXT_STEPS_MAX);
}

async function testSteps(
  coord: Coordinator,
  test: TestRecord,
  cls: ClassificationRecord,
  c: Ctx,
  add: (s: C.NextStep) => void,
  safe: (what: string, fn: () => Promise<void>) => Promise<void>,
  x: { ranRecently: (flow: C.FlowId, testKey?: string, since?: string) => boolean; projectRuns: Array<{ flowId: C.FlowId; state: string; testKey?: string; finishedAt?: string }>; now: number },
): Promise<void> {
  const ui = new CoordinatorUi(coord);
  const proposals = await coord.store.listProposals((p) => p.testKey === test.testKey && LIVE.has(p.state));
  const questions = await coord.questionsFor(test).catch(() => []);
  const views = await coord.familyViewsFor(test.testKey).then((r) => r.views).catch(() => []);
  const familyOf = new Map(views.flatMap((v) => v.groupIds.map((g) => [g, v.id] as const)));
  const groupOfClash = new Map(cls.clashes.map((k) => [k.id, k.groupId]));
  const groupsOf = (p: ProposalRecord) => new Set([...p.target.groupIds, ...p.target.clashIds.map((k) => groupOfClash.get(k.replace(/^C-/, ""))).filter((g): g is string => !!g)]);

  // ── open questions (human) ────────────────────────────────────────────────
  await safe("questions", async () => {
    const open = questions.filter((q) => q.state === "open");
    if (open.length)
      add({
        id: `open_questions:${c.testKey}`,
        kind: "open_questions",
        priority: 25,
        title: `Responder ${plural(open.length, "pregunta", "preguntas")} del agente`,
        reason: `El agente no pudo decidir ${open.length === 1 ? "un caso" : `${open.length} casos`} con los datos y te pregunta; tu respuesta se vuelve decisión.`,
        counts: { questions: open.length },
        action: { type: "open", route: "triage", params: triageParams(c, { lente: "cambios", panel: "preguntas" }) },
      });
  });

  // ── decisions accepted but not sent (human) ────────────────────────────────
  await safe("send", async () => {
    const p = await ui.pendingToSend(test.testKey);
    if (p.families + p.groups > 0)
      add({
        id: `decisions_to_send:${c.testKey}`,
        kind: "decisions_to_send",
        priority: 22,
        title: "Enviar a aprobación",
        reason: `Hay decisiones aceptadas sin lote: ${[p.families ? plural(p.families, "grupo", "grupos") : "", p.groups ? plural(p.groups, "ubicación", "ubicaciones") : ""].filter(Boolean).join(" y ")}. «Enviar a aprobación» arma el lote.`,
        counts: { families: p.families, groups: p.groups },
        action: { type: "open", route: "triage", params: triageParams(c, { accion: "enviar" }) },
      });
  });

  // ── groups for AI review (flow triage) ─────────────────────────────────────
  await safe("ai_review", async () => {
    const info = await coord.cycleInfo(test, cls);
    const needs = cls.groups.filter(info.needsHuman);
    const reviewed = new Set<string>();
    for (const p of proposals) if (p.createdBy.type === "agent") for (const g of groupsOf(p)) reviewed.add(g);
    const famReviewed = new Set<string>([
      ...proposals.filter((p) => p.createdBy.type === "agent" && (p.payload.kind === "family_decision" || p.payload.kind === "family_exception")).map((p) => (p.payload as { familyId: string }).familyId),
      ...questions.filter((q) => q.state !== "stale" && q.familyId).map((q) => q.familyId!),
    ]);
    for (const q of questions) if (q.state !== "stale") for (const g of q.groupIds) reviewed.add(g);
    const pending = needs.filter((g) => !reviewed.has(g.id) && !famReviewed.has(familyOf.get(g.id) ?? ""));
    if (pending.length && !x.ranRecently("triage", c.testKey) && !x.ranRecently("preparar-ciclo", c.testKey))
      add({
        id: `ai_review:${c.testKey}`,
        kind: "ai_review",
        priority: 35,
        title: `Revisión IA de ${plural(pending.length, "ubicación", "ubicaciones")}`,
        reason: `El motor marcó ${plural(needs.length, "ubicación", "ubicaciones")} para revisión humana y ${pending.length === 1 ? "1 aún no tiene" : `${pending.length} aún no tienen`} propuesta del agente: la IA las revisa primero y deja propuestas o preguntas.`,
        counts: { pending: pending.length, needsReview: needs.length },
        action: { type: "flow", flow: "triage", args: { projectId: c.projectId, testKey: c.testKey } },
      });
  });

  // ── meeting notes not processed (flow acta) ────────────────────────────────
  await safe("notes", async () => {
    const notes = await coord.notesFor(test);
    const lastActa = x.projectRuns.filter((r) => r.flowId === "acta" && r.state === "finished" && r.testKey === c.testKey).map((r) => r.finishedAt ?? "").sort().at(-1) ?? "";
    const famOfNote = (n: { targetType: string; targetId: string }) => (n.targetType === "family" ? n.targetId : familyOf.get(n.targetId));
    const pending = notes.filter((n) => {
      if (!n.text.trim() || n.updatedAt <= lastActa) return false;
      const fam = famOfNote(n);
      const byAgent = proposals.some((p) => p.createdBy.type === "agent" && p.createdAt > n.updatedAt && ((fam && p.payload.kind === "family_decision" && p.payload.familyId === fam) || groupsOf(p).has(n.targetId)));
      const asked = questions.some((q) => q.createdAt > n.updatedAt && ((fam && q.familyId === fam) || q.groupIds.includes(n.targetId)));
      return !byAgent && !asked;
    });
    if (pending.length)
      add({
        id: `meeting_notes:${c.testKey}`,
        kind: "meeting_notes",
        priority: 30,
        title: "Pasar el acta de la reunión",
        reason: `${plural(pending.length, "nota de reunión", "notas de reunión")} sin procesar: el agente las convierte en borradores de decisión y pregunta lo ambiguo.`,
        counts: { notes: pending.length },
        action: { type: "flow", flow: "acta", args: { projectId: c.projectId, testKey: c.testKey } },
      });
  });

  // ── real P1–P2 groups without an issue draft (flow redactar-issues) ────────
  await safe("issues", async () => {
    const info = await coord.cycleInfo(test, cls);
    const drafted = new Set<string>();
    for (const p of proposals) if (p.payload.kind === "issue_draft") for (const g of groupsOf(p)) drafted.add(g);
    const famIssue = new Set(
      views
        .filter((v) => (v.decision && v.decision.status === "approved" && (v.decision.action === "create_issue" || v.decision.action === "hygiene_issue")) || proposals.some((p) => p.payload.kind === "family_decision" && p.payload.familyId === v.id && p.payload.action === "create_issue"))
        .map((v) => v.id),
    );
    const decided = await coord.effectiveDecisions(test.testKey);
    const missing = cls.groups.filter((g) => {
      if (g.validity !== "real" || g.band > 2) return false;
      if (drafted.has(g.id) || famIssue.has(familyOf.get(g.id) ?? "")) return false;
      const d = decided.get(g.id);
      if (d && (d.kind === "reject" || d.kind === "postpone")) return false;
      // Already assigned / decided in ACC (ACC wins).
      return !g.clashIds.some((k) => info.acc.index.has(k));
    });
    if (missing.length && !x.ranRecently("redactar-issues", c.testKey))
      add({
        id: `issue_drafts:${c.testKey}`,
        kind: "issue_drafts",
        priority: 40,
        title: `Redactar ${plural(missing.length, "incidencia", "incidencias")} P1–P2`,
        reason: `${plural(missing.length, "ubicación real", "ubicaciones reales")} P1–P2 sin borrador de incidencia ni incidencia en ACC.`,
        counts: { groups: missing.length, p1: missing.filter((g) => g.band === 1).length },
        action: { type: "flow", flow: "redactar-issues", args: { projectId: c.projectId, testKey: c.testKey } },
      });
  });

  // ── issue checks (human: verify) ──────────────────────────────────────────
  await safe("issue_checks", async () => {
    const p = await coord.issueChecksFor(test.testKey);
    const says = p.checks.filter((k) => k.verdict === "dice_resuelta" && !k.decision).length;
    const stuck = p.checks.filter((k) => k.stuck).length;
    if (says + stuck > 0)
      add({
        id: `issue_checks:${c.testKey}`,
        kind: "issue_checks",
        priority: 28,
        title: "Verificar incidencias",
        reason: [says ? `${plural(says, "incidencia dice", "incidencias dicen")} resuelta pero sus interferencias siguen` : "", stuck ? `${plural(stuck, "P1 estancada", "P1 estancadas")} (≥ 2 versiones)` : ""].filter(Boolean).join("; ") + ".",
        counts: { saysResolved: says, stuckP1: stuck },
        action: { type: "open", route: "triage", params: triageParams(c, { lente: "incidencias" }) },
      });
  });

  // ── hygiene: documents without discipline, duplicates ──────────────────────
  await safe("hygiene", async () => {
    const sinDocs = new Set(test.documents.filter((d) => outCode(d.discipline) === SIN).map((d) => d.documentId));
    const sinClashes = sinDocs.size ? cls.clashes.filter((k) => sinDocs.has(k.a.documentId) || sinDocs.has(k.b.documentId)).length : 0;
    if (sinClashes >= THRESHOLDS.unassignedClashes)
      add({
        id: `hygiene_unassigned:${c.testKey}`,
        kind: "hygiene_unassigned",
        priority: 45,
        title: "Asignar disciplina a documentos",
        reason: `${plural(sinDocs.size, "documento sin disciplina (SIN) afecta", "documentos sin disciplina (SIN) afectan")} ${plural(sinClashes, "interferencia", "interferencias")}: los pares y responsables quedan incompletos.`,
        counts: { documents: sinDocs.size, clashes: sinClashes },
        action: { type: "open", route: "disciplines", params: { projectId: c.projectId, modelSetId: c.modelSetId } },
      });
    const dup = cls.clashes.filter((k) => (k.a.externalId && k.a.externalId === k.b.externalId) || k.nature === "duplicate").length;
    if (dup >= THRESHOLDS.duplicateClashes && !x.ranRecently("auditar-modelo", c.testKey))
      add({
        id: `hygiene_duplicates:${c.testKey}`,
        kind: "hygiene_duplicates",
        priority: 60,
        title: "Auditar higiene del modelo",
        reason: `${plural(dup, "interferencia es", "interferencias son")} de elementos duplicados o copiados: una incidencia de higiene por archivo resuelve más que revisarlas una a una.`,
        counts: { duplicates: dup },
        action: { type: "flow", flow: "auditar-modelo", args: { projectId: c.projectId, testKey: c.testKey } },
      });
  });

  // ── weekly report ─────────────────────────────────────────────────────────
  await safe("report", async () => {
    const files = await listReportFiles(coord, c.projectId).catch(() => []);
    if (files.some((f) => f.kind === "weekly" && f.testKey === c.testKey)) return;
    const batches = (await coord.store.listBatches()).filter((b) => b.testKey === c.testKey && b.state !== "discarded");
    const info = await coord.cycleInfo(test, cls);
    const open = cls.groups.filter(info.needsHuman).length;
    if ((batches.length || open === 0) && !x.ranRecently("informe-semanal", c.testKey))
      add({
        id: `weekly_report:${c.testKey}`,
        kind: "weekly_report",
        priority: 70,
        title: "Generar el informe semanal",
        reason: `El ciclo de v${c.version} ${batches.length ? `ya tiene ${plural(batches.length, "lote", "lotes")}` : "no tiene ubicaciones pendientes de revisión"} y aún no tiene informe semanal.`,
        counts: { batches: batches.length, pendingReview: open },
        action: { type: "flow", flow: "informe-semanal", args: { projectId: c.projectId, testKey: c.testKey } },
      });
  });
}
