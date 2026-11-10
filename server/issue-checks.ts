/**
 * M3 issue verification (F2) and follow-up (F5), READ-ONLY against ACC
 * (docs/PLAN-core-features-simplified.md §3; brief §5 and §8 minus the cuts).
 *
 * One check per ACC issue linked to an assigned group (from the X1 ledger sync):
 *   resuelta        existing = 0, displacement ok, model age ok, scope ok
 *   avance          some resolved, some existing
 *   sigue_abierta   none resolved
 *   dice_resuelta   ACC says closed / in review / completed while existing > 0 (F5 contradiction)
 *   no_verificable  element deleted / out of scope / stale model / displacement blocked
 * Evidence and reminders come from TEMPLATES (no LLM, no comments, no person names).
 *
 *   .coordinator/issue-checks/<projectId>/<modelSetId>.json
 *     { verdicts: { [version]: { [issueId]: verdict } }, decisions: { [version]: { [issueId]: {...} } } }
 */
import { plural } from "./util";
import type * as C from "./api/contract";
import { accAt, type ClashLedger } from "../core/ingest/ledger";
import { pairKeyTokens } from "../core/ingest/pair-key";
import type { ClashDiff } from "../core/types";
import { sanitizeModelText } from "./sanitize";
import type { SourceIssue } from "./source/types";
import type { Store } from "./store";
import { pathSegment } from "./store";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import type { ClashRecord, ClassificationRecord, GroupRecord, TestRecord } from "./store/types";
import { bareProjectId } from "./util";
import { accIssueUrl } from "../core/issues/acc-links";

/** ACC issue status in Spanish for server text (raw value when unknown). */
export function accStatusEs(status: string): string {
  const m: Record<string, string> = { open: "Abierta", in_review: "En revisión", answered: "En revisión", closed: "Cerrada", draft: "Borrador", pending: "Pendiente", completed: "Completada", in_progress: "En curso", not_approved: "No aprobada", in_dispute: "En disputa", void: "Anulada" };
  return m[status.toLowerCase()] ?? status;
}

/** ACC statuses meaning "the discipline says it is fixed". */
export const SAYS_RESOLVED = new Set(["closed", "completed", "in_review", "answered", "work_completed", "ready_to_inspect"]);
const CLOSED = new Set(["closed", "completed", "void"]);

export interface IssueCheckInput {
  test: TestRecord;
  cls: ClassificationRecord;
  prevCls?: ClassificationRecord;
  /** Cached tests of the model set (model-age reference). */
  tests: readonly TestRecord[];
  ledger?: ClashLedger;
  diff?: ClashDiff;
  /** Element tokens (externalIds) of every clash of THIS run. */
  currentElements: ReadonlySet<string>;
  issues: ReadonlyMap<string, SourceIssue>;
  /** today, YYYY-MM-DD */
  today: string;
  /** The version whose ACC state is read (this test's version when synced). */
  accVersion: number;
  /** false = ACC was not read for this version: every check is no_verificable. */
  synced: boolean;
}

interface AccGroupAgg {
  issueId: string;
  groupIds: string[];
  existing: string[];
  resolved: string[];
}

function urnVersion(urn: string | undefined): number | undefined {
  const m = /[?&]version=(\d+)/.exec(urn ?? "");
  return m ? Number(m[1]) : undefined;
}

function dominant(xs: readonly string[]): string | undefined {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

/** Assigned ACC groups with an issue, aggregated per issue, from the ledger (X1). */
export function accIssueGroups(ledger: ClashLedger | undefined, currentIds: ReadonlySet<string>, version: number): AccGroupAgg[] {
  const byIssue = new Map<string, AccGroupAgg>();
  for (const e of Object.values(ledger?.entries ?? {})) {
    const a = accAt(e, version);
    if (!a || a.status !== "assigned" || !a.issueId) continue;
    const agg = byIssue.get(a.issueId) ?? { issueId: a.issueId, groupIds: [], existing: [], resolved: [] };
    if (!agg.groupIds.includes(a.groupId)) agg.groupIds.push(a.groupId);
    if (a.resolved) agg.resolved.push(e.id);
    else if (currentIds.has(e.id)) agg.existing.push(e.id);
    byIssue.set(a.issueId, agg);
  }
  return [...byIssue.values()].filter((x) => x.existing.length + x.resolved.length > 0).sort((a, b) => (a.issueId < b.issueId ? -1 : 1));
}

/** Compute the checks (pure). `history` = recorded verdicts per version (for stuckCycles). */
export function computeIssueChecks(input: IssueCheckInput, history: Record<string, Record<string, C.IssueVerdict>>): C.IssueCheck[] {
  const { test, cls, prevCls } = input;
  const curIds = new Set(cls.clashes.map((c) => c.id));
  const clashById = new Map<string, ClashRecord>([...(prevCls?.clashes ?? []).map((c) => [c.id, c] as const), ...cls.clashes.map((c) => [c.id, c] as const)]);
  const groupById = new Map<string, GroupRecord>([...(prevCls?.groups ?? []).map((g) => [g.id, g] as const), ...cls.groups.map((g) => [g.id, g] as const)]);
  const docTest = (c: ClashRecord) => (curIds.has(c.id) ? test : test.previousTestKey ? input.tests.find((t) => t.testKey === test.previousTestKey) : undefined);
  const deleted = new Set(input.diff?.element_deleted ?? []);
  const outOfScope = new Set(input.diff?.out_of_scope ?? []);
  const out: C.IssueCheck[] = [];
  for (const agg of accIssueGroups(input.ledger, curIds, input.accVersion)) {
    const issue = input.issues.get(agg.issueId);
    const status = (issue?.status ?? "desconocido").toLowerCase();
    const members = [...agg.existing, ...agg.resolved].map((id) => clashById.get(id)).filter((c): c is ClashRecord => !!c);
    const groupIds = [...new Set((agg.existing.length ? agg.existing : agg.resolved).map((id) => clashById.get(id)?.groupId).filter((g): g is string => !!g))];
    const groups = groupIds.map((g) => groupById.get(g)).filter((g): g is GroupRecord => !!g);
    const discipline = dominant(groups.map((g) => g.responsibleDiscipline)) ?? "COORD";
    const families = new Set(groups.map((g) => g.familyId).filter(Boolean));
    const band = groups.length ? (Math.min(...groups.map((g) => g.band)) as C.Priority) : undefined;

    // Checks.
    // Elements of the resolved set (engine records of the previous run; ledger pairKey as fallback).
    const resolvedTokens = new Set(
      agg.resolved.flatMap((id) => {
        const c = clashById.get(id);
        if (c) return [c.a.externalId, c.b.externalId].filter((x): x is string => !!x);
        const pk = input.ledger?.entries[id]?.pairKey;
        return pk ? pairKeyTokens(pk) : [];
      }),
    );
    const moved = [...resolvedTokens].filter((t) => input.currentElements.has(t));
    const displacement: "ok" | "blocked" = moved.length ? "blocked" : "ok";
    const scope: "ok" | "out_of_scope" = agg.resolved.some((id) => outOfScope.has(id)) || agg.existing.some((id) => outOfScope.has(id)) ? "out_of_scope" : "ok";
    const anyDeleted = agg.resolved.some((id) => deleted.has(id));
    // Model age: a responsible document (by lineage) has a newer version than at issue creation.
    let modelAge: "ok" | "stale" | "unknown" = "unknown";
    const created = issue?.createdAt;
    const ref = created
      ? [...input.tests].filter((t) => t.modelSetId === test.modelSetId && (t.completedOn ?? t.ingestedAt) <= created && t.modelSetVersion < test.modelSetVersion).sort((a, b) => b.modelSetVersion - a.modelSetVersion)[0]
      : undefined;
    if (ref) {
      const lins = new Set<string>();
      for (const c of members) {
        const side = c.a.discipline === discipline ? c.a : c.b.discipline === discipline ? c.b : undefined;
        const t = docTest(c);
        const lin = side && t ? t.documents.find((d) => d.documentId === side.documentId)?.lineageUrn : undefined;
        if (lin) lins.add(lin);
      }
      const versions = [...lins].map((lin) => ({ before: urnVersion(ref.documents.find((d) => d.lineageUrn === lin)?.urn), now: urnVersion(test.documents.find((d) => d.lineageUrn === lin)?.urn) }));
      const known = versions.filter((v) => v.before !== undefined && v.now !== undefined);
      if (known.length) modelAge = known.some((v) => v.now! > v.before!) ? "ok" : "stale";
    }

    // Verdict.
    const existing = agg.existing.length;
    const resolved = agg.resolved.length;
    let verdict: C.IssueVerdict;
    let reason: string;
    if (!input.synced) {
      verdict = "no_verificable";
      reason = `ACC sin sincronizar para v${test.modelSetVersion}: vuelve a ingerir esta versión.`;
    } else if (SAYS_RESOLVED.has(status) && existing > 0) {
      verdict = "dice_resuelta";
      reason = `ACC la marca "${accStatusEs(status)}" pero ${existing === 1 ? "sigue 1 interferencia" : `siguen ${existing} interferencias`}.`;
    } else if (existing === 0) {
      const why: string[] = [];
      if (scope === "out_of_scope") why.push("un documento cambió de alcance");
      if (anyDeleted) why.push("se eliminó un elemento (no es una corrección verificable)");
      if (displacement === "blocked") why.push(`${moved.length === 1 ? "1 elemento del conjunto resuelto vuelve" : `${moved.length} elementos del conjunto resuelto vuelven`} a chocar en esta corrida (el problema pudo moverse)`);
      if (modelAge === "stale") why.push(`el modelo de ${discipline} no tiene una versión nueva desde que se creó la incidencia`);
      if (modelAge === "unknown") why.push(`no se puede comprobar que el modelo de ${discipline} se haya actualizado`);
      if (why.length) {
        verdict = "no_verificable";
        reason = `No verificable: ${why.join("; ")}.`;
      } else {
        verdict = "resuelta";
        reason = `${resolved === 1 ? "La interferencia se resolvió" : `Las ${resolved} interferencias se resolvieron`} y el modelo de ${discipline} se actualizó.`;
      }
    } else if (resolved > 0) {
      verdict = "avance";
      reason = `Avance: quedan ${existing} de ${existing + resolved}.`;
    } else {
      verdict = "sigue_abierta";
      reason = `Sigue abierta: ${plural(existing, "interferencia", "interferencias")} sin cambios a favor.`;
    }

    // Stuck cycles (P1 issues that keep being "sigue_abierta").
    const versions = Object.keys(history).map(Number).filter((v) => v < test.modelSetVersion).sort((a, b) => b - a);
    let stuckCycles = verdict === "sigue_abierta" ? 1 : 0;
    if (stuckCycles) for (const v of versions) {
      if (history[String(v)]?.[agg.issueId] === "sigue_abierta") stuckCycles++;
      else break;
    }
    const overdue = !!issue?.dueDate && issue.dueDate.slice(0, 10) < input.today && !CLOSED.has(status);
    const ageText = modelAge === "ok" ? "actualizado" : modelAge === "stale" ? "sin versión nueva" : "sin dato";
    const evidence = sanitizeModelText(
      `v${test.modelSetVersion}: ${existing} de ${existing + resolved} ${existing + resolved === 1 ? "interferencia" : "interferencias"} ${existing === 1 ? "sigue" : "siguen"}, ${plural(resolved, "resuelta", "resueltas")}. Modelo ${discipline}: ${ageText}. Desplazamiento: ${displacement === "ok" ? "sin choques nuevos de los elementos resueltos" : moved.length === 1 ? "1 elemento resuelto vuelve a chocar" : `${moved.length} elementos resueltos vuelven a chocar`}. Alcance: ${scope === "ok" ? "sin cambios" : "cambió"}. Estado ACC: ${accStatusEs(status)}${issue?.dueDate ? `, vence ${issue.dueDate.slice(0, 10)}` : ""}.`,
      400,
    );
    out.push({
      issueId: agg.issueId,
      ...(issue?.displayId !== undefined ? { displayId: issue.displayId } : {}),
      title: sanitizeModelText(issue?.title ?? `Incidencia ${agg.issueId.slice(0, 8)}`, 160),
      accStatus: status,
      ...(issue?.dueDate ? { dueDate: issue.dueDate.slice(0, 10) } : {}),
      overdue,
      ...(issue?.assignedToType ? { assignedToType: issue.assignedToType } : {}),
      ...(families.size === 1 ? { familyId: [...families][0]! } : {}),
      groupIds,
      accGroupIds: agg.groupIds,
      discipline,
      existing,
      resolved,
      verdict,
      reason,
      evidence,
      checks: { displacement, modelAge, scope },
      stuckCycles,
      stuck: band === 1 && stuckCycles >= 2,
      ...(band ? { priority: band } : {}),
      ...(accIssueUrl(test.projectId, agg.issueId) ? { accUrl: accIssueUrl(test.projectId, agg.issueId)! } : {}),
    });
  }
  const order: Record<C.IssueVerdict, number> = { dice_resuelta: 0, sigue_abierta: 1, avance: 2, no_verificable: 3, resuelta: 4 };
  return out.sort((a, b) => order[a.verdict] - order[b.verdict] || Number(b.overdue) - Number(a.overdue) || (a.issueId < b.issueId ? -1 : 1));
}

/** One reminder per responsible discipline (template; no person names, no comment text). */
export function buildReminders(checks: readonly C.IssueCheck[], version: number, today: string): C.IssueReminder[] {
  const byDisc = new Map<string, C.IssueCheck[]>();
  for (const c of checks) {
    // "No verificable" stays out unless it carries a meeting reason (the problem moved / the model is stale).
    if (c.verdict === "resuelta" || (c.verdict === "no_verificable" && c.checks.displacement !== "blocked" && c.checks.modelAge !== "stale")) continue;
    byDisc.set(c.discipline, [...(byDisc.get(c.discipline) ?? []), c]);
  }
  const ref = (c: C.IssueCheck) => `#${c.displayId ?? c.issueId.slice(0, 8)}`;
  const line = (c: C.IssueCheck, extra: string) => `- ${ref(c)} ${c.title.slice(0, 80)}${extra}`;
  const out: C.IssueReminder[] = [];
  for (const [disc, cs] of [...byDisc].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dice = cs.filter((c) => c.verdict === "dice_resuelta");
    const overdue = cs.filter((c) => c.overdue && c.verdict !== "dice_resuelta");
    const open = cs.filter((c) => c.verdict === "sigue_abierta" && !c.overdue);
    const prog = cs.filter((c) => c.verdict === "avance" && !c.overdue);
    const unverified = cs.filter((c) => c.verdict === "no_verificable" && !c.overdue);
    const parts = [
      `Recordatorio ${disc} — coordinación v${version} (${today})`,
      `Incidencias pendientes: ${cs.length} (${plural(cs.filter((c) => c.overdue).length, "vencida", "vencidas")}, ${plural(dice.length, "marcada resuelta", "marcadas resueltas")} con interferencias vigentes).`,
      ...(dice.length ? ["Marcadas resueltas, pero el modelo aún muestra la interferencia:", ...dice.map((c) => line(c, ` — ${plural(c.existing, "vigente", "vigentes")}`))] : []),
      ...(overdue.length ? ["Vencidas:", ...overdue.map((c) => line(c, ` — vencía ${c.dueDate ?? "?"}, ${plural(c.existing, "vigente", "vigentes")}`))] : []),
      ...(open.length ? ["Sin avance:", ...open.map((c) => line(c, ` — ${plural(c.existing, "vigente", "vigentes")}${c.stuck ? `, ${c.stuckCycles} ciclos` : ""}`))] : []),
      ...(prog.length ? ["Con avance:", ...prog.map((c) => line(c, ` — quedan ${c.existing} de ${c.existing + c.resolved}`))] : []),
      ...(unverified.length ? ["Por confirmar:", ...unverified.map((c) => line(c, c.checks.displacement === "blocked" ? " — el problema se movió: un elemento corregido vuelve a chocar" : " — el modelo responsable no tiene versión nueva"))] : []),
      "Por favor publiquen el modelo corregido y actualicen el estado en ACC antes de la próxima corrida.",
    ];
    out.push({
      discipline: disc,
      text: parts.join("\n"),
      issueIds: [...dice, ...overdue, ...open, ...prog, ...unverified].map((c) => c.issueId),
      counts: { total: cs.length, overdue: cs.filter((c) => c.overdue).length, diceResuelta: dice.length, sigueAbierta: cs.filter((c) => c.verdict === "sigue_abierta").length, avance: cs.filter((c) => c.verdict === "avance").length },
    });
  }
  return out;
}

// ── persistence: verdict history (stuckCycles) and verdict decisions (M5 gate) ──

export interface IssueVerdictDecisionRecord {
  verdict: C.IssueVerdict;
  kind: "accept" | "reject";
  reasonCode?: C.ReasonCode;
  note?: string;
  decidedBy: string;
  decidedAt: string;
  testKey: string;
}

interface IssueCheckFile {
  verdicts: Record<string, Record<string, C.IssueVerdict>>;
  decisions: Record<string, Record<string, IssueVerdictDecisionRecord>>;
}

export class IssueCheckStore {
  constructor(private readonly store: Store) {}

  path(projectId: string, modelSetId: string): string {
    const seg = (s: string) => pathSegment(s);
    return this.store.path("issue-checks", seg(bareProjectId(projectId)), `${seg(modelSetId)}.json`);
  }

  async load(projectId: string, modelSetId: string): Promise<IssueCheckFile> {
    return (await readJsonFile<IssueCheckFile>(this.path(projectId, modelSetId))) ?? { verdicts: {}, decisions: {} };
  }

  async mutate(projectId: string, modelSetId: string, fn: (f: IssueCheckFile) => boolean): Promise<void> {
    await this.store.withLock(async () => {
      const f = await this.load(projectId, modelSetId);
      if (fn(f)) await writeJsonAtomic(this.path(projectId, modelSetId), f);
    });
  }
}

/** M5 evidence gate: ≥ 2 cycles with decided "resuelta" verdicts, each ≥ 90 % accepted unchanged. */
export function issueGate(f: IssueCheckFile, testKeyOf: (version: number) => string): C.IssueGate {
  const perCycle: C.IssueGate["perCycle"] = [];
  for (const [v, ds] of Object.entries(f.decisions)) {
    const res = Object.values(ds).filter((d) => d.verdict === "resuelta");
    if (!res.length) continue;
    perCycle.push({ version: Number(v), testKey: res[0]!.testKey ?? testKeyOf(Number(v)), resuelta: res.length, accepted: res.filter((d) => d.kind === "accept").length, rejected: res.filter((d) => d.kind === "reject").length });
  }
  perCycle.sort((a, b) => a.version - b.version);
  const acc = perCycle.reduce((n, c) => n + c.accepted, 0);
  const tot = perCycle.reduce((n, c) => n + c.accepted + c.rejected, 0);
  return {
    cycles: perCycle.length,
    acceptedUnchangedPct: tot ? Math.round((1000 * acc) / tot) / 10 : null,
    perCycle,
    ready: perCycle.length >= 2 && perCycle.every((c) => c.accepted / Math.max(1, c.accepted + c.rejected) >= 0.9),
  };
}
