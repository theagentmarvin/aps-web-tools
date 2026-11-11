/**
 * Family pane (docs/domain/solution-families-proposal.md §5.2), same
 * decision-first pattern as the instance pane:
 *   headline → proposed single decision → Aprobar familia / Cambiar / Rechazar
 *   (blast radius + spot-check status inline) → instances with an "excepción"
 *   toggle → issue preview (one per family, or split per instance).
 * Approval itself happens in FamilyApproveDialog (mandatory confirmation).
 */
import { useEffect, useState } from "react";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import { useToast } from "~/lib/components/Toast";
import type { FamilyAction, FamilyDecisionPreview, FamilyGroup, ProposalDiffField, TriageFamily, Validity } from "~/lib/api/types";
import { categoryTitle } from "~/lib/category-names";
import { PriorityChip, ValidityBadge } from "~/lib/components/badges";
import { IconChevronLeft, IconChevronRight } from "~/lib/components/icons";
import { EmptyState, Kbd } from "~/lib/components/ui";
import { VALIDITY_KEY, VALIDITY_ORDER, VALIDITY_TIP } from "~/lib/labels";
import { FAMILY_ACTIONS, isClosingAction, problemTypeOf } from "~/lib/problem-types";
import { useTriageContext } from "./actions";
import { Section, useSectionPrefs } from "./detail-accordion";
import { FamilyTags, InheritanceMark, levelRange, useNodeLabel } from "./FamilyRows";
import { oneLine } from "./pair-summary";
import { familyChangeCounts, topChange } from "./change";
import { ChangeChip } from "./RowMarks";
import { CopyReminderButton } from "./IssueViews";
import { MeetingNoteSection } from "./MeetingViews";
import { AskAgentLink } from "./DetailPanel";
import { FamilyMoreMenu } from "./FamilyMoreMenu";
import { rowKey, useTriage, type FamilyDraft, type TriageStore } from "./store";
import { LoopRail, familyRail } from "../loop/LoopRail";
import { NeqMark, OriginBadge } from "../loop/OriginBadge";
import { ConsequencePopover, useConsequences, type Consequence } from "../loop/Consequences";
import { DecisionReceipt, learningParts } from "../loop/DecisionReceipt";

export const FAMILY_ACTION_KEY: Record<FamilyAction, TKey> = {
  create_issue: "families.action.create_issue",
  close: "families.action.close",
  mark_reviewed: "families.action.mark_reviewed",
  hygiene_issue: "families.action.hygiene_issue",
  escalate: "families.action.escalate",
};

// ── Impact of a family decision (shared with the approve dialog) ───

export interface FamilyImpact {
  instances: FamilyGroup[];
  applied: FamilyGroup[];
  excepted: { g: FamilyGroup; reason: string }[];
  /** Real instances a closing decision must not touch: they stay for an individual decision. */
  protectedReal: FamilyGroup[];
  /** Instances whose current validity differs from the family decision (mixed-validity guard). */
  validityChanges: FamilyGroup[];
  /** Inherited but changed / reappeared / gated: they stay pending, confirmed one by one (not in the blast radius). */
  pendingConfirm: FamilyGroup[];
  affectedClashes: number;
  spotRequired: number;
  spotDone: string[];
}

/** One unit everywhere: ACC clashes (raw, what ACC shows). Unique counts only appear in tooltips. */
export const clashCount = (g: FamilyGroup) => g.clashIds.length;

export function familyImpact(store: TriageStore, f: TriageFamily, draft: FamilyDraft): FamilyImpact {
  const s = store.state;
  const instances = f.groupIds.map((id) => s.groups.get(id)).filter((g): g is FamilyGroup => !!g);
  const exc = s.familyExceptions.get(f.id) ?? new Map<string, string>();
  const closing = isClosingAction(draft.action);
  const out: FamilyImpact = { instances, applied: [], excepted: [], protectedReal: [], validityChanges: [], pendingConfirm: [], affectedClashes: 0, spotRequired: 1, spotDone: [] };
  for (const g of instances) {
    if (exc.has(g.id)) out.excepted.push({ g, reason: exc.get(g.id) ?? "" });
    else if (closing && g.validity === "real") out.protectedReal.push(g);
    else if (g.inheritance?.state === "inherited_pending" || g.inherited?.needsConfirmation) out.pendingConfirm.push(g);
    else {
      out.applied.push(g);
      out.affectedClashes += clashCount(g);
      if (g.validity !== draft.validity) out.validityChanges.push(g);
    }
  }
  out.spotRequired = 0; // no mandatory spot-check (product decision 2026-11-11)
  const visited = s.familyVisits.get(f.id) ?? new Set<string>();
  out.spotDone = f.groupIds.filter((id) => visited.has(id));
  return out;
}

/** Show catalogue options with the number the crew needs ("Bajar el ducto ~81 mm …"), not the formula. */
export function optionLabel(t: ReturnType<typeof useT>, option: string, f: TriageFamily): string {
  if (/^Bajar penetraci[oó]n \+ 25 mm/i.test(option)) return t("families.solutionLower", { mm: Math.round(f.evidence.penetrationMm.max + 25) });
  return option;
}

export function instanceLabel(g: FamilyGroup): string {
  return g.hostLevelLabel ?? g.location?.level ?? "—";
}

/** Locations grouped by level: "Nivel 2: 3 instancias (24 interf.)". */
export function byLevel(groups: FamilyGroup[]): { level: string; instances: number; clashes: number }[] {
  const m = new Map<string, { level: string; instances: number; clashes: number }>();
  for (const g of groups) {
    const level = g.location?.level ?? "Sin nivel";
    const e = m.get(level) ?? { level, instances: 0, clashes: 0 };
    e.instances++;
    e.clashes += clashCount(g);
    m.set(level, e);
  }
  return [...m.values()].sort((a, b) => a.level.localeCompare(b.level, "es", { numeric: true }));
}

// ── Panel ──────────────────────────────────────────────────────────

export function FamilyPanel({ familyId }: { familyId: string }) {
  const t = useT();
  const { lang } = useI18n();
  const { store } = useTriageContext();
  const f = useTriage(store, (s) => s.families.get(familyId));
  const pts = useTriage(store, (s) => s.problemTypes);
  useTriage(store, (s) => s.familyExceptions);
  useTriage(store, (s) => s.familyVisits);
  useTriage(store, (s) => s.familyDrafts);
  useTriage(store, (s) => s.groups);
  useTriage(store, (s) => s.latest);
  const { prefs, set } = useSectionPrefs();
  const lens = useTriage(store, () => store.effectiveLens());
  if (!f) return <EmptyState title={t("detail.noSelection")} />;
  const draft = store.familyDraft(f.id)!;
  const pt = problemTypeOf(pts, f.parts.problemType);
  const impact = familyImpact(store, f, draft);
  const worst = store.familyWorst(f);
  // hostClass is a Revit category (mock) or an engine class token such as "losa_fundación" (server).
  const hostNoun = categoryTitle(f.parts.hostClass, lang).replace(/_/g, " ");
  // Model type names often start with the category word ("Viga H.A. 25x60"): do not repeat it.
  const host = f.parts.hostType ? (f.parts.hostType.toLowerCase().startsWith(hostNoun.toLowerCase()) ? f.parts.hostType : `${hostNoun} ${f.parts.hostType}`) : hostNoun;
  const headline = [f.pair ? `${f.pair[0]} × ${f.pair[1]}` : null, pt?.nameEs, host, t("families.instancesOnLevels", { count: f.instanceCount, levels: f.levels.length })].filter(Boolean).join(" · ");
  const issueOn = draft.action === "create_issue" || draft.action === "hygiene_issue";
  const instancesOpen = prefs.instances ?? true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex-shrink-0 border-b border-brand-muted/20 px-4 pb-2 pt-2.5">
        {/* Compact header: P1 · pair · problem (1 line) / host · counts (1 line). Full names, id and signature on hover. */}
        <div className="flex items-center gap-1.5">
          {worst && <PriorityChip value={worst} />}
          {f.pair && <span className="shrink-0 rounded bg-gray-100 px-1.5 font-mono text-[11px] font-semibold leading-5 text-gray-800">{`${f.pair[0]} × ${f.pair[1]}`}</span>}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900" lang="es" title={`${headline}\n${f.title}\n${f.id} · ${t("families.uniqueTooltip", { raw: f.rawClashCount, unique: f.uniqueClashCount })}`}>
            {pt?.nameEs ?? f.title}
          </h2>
          <span className="flex shrink-0 gap-0.5">
            <button type="button" aria-label={t("shortcuts.prev")} title={`${t("shortcuts.prev")} (K)`} onClick={() => store.move(-1)} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface">
              <IconChevronLeft size={14} />
            </button>
            <button type="button" aria-label={t("shortcuts.next")} title={`${t("shortcuts.next")} (J)`} onClick={() => store.move(1)} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface">
              <IconChevronRight size={14} />
            </button>
            <FamilyMoreMenu family={f} />
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-gray-600">
          <span className="min-w-0 truncate" lang="es" title={`${host}\n${f.title}`}>
            {host}
          </span>
          <span className="shrink-0 whitespace-nowrap" title={`${t("families.uniqueTooltip", { raw: f.rawClashCount, unique: f.uniqueClashCount })}\n${f.id} · ${f.signature}`}>
            · {t("families.headerCounts", { instances: f.instanceCount, levels: f.levels.length, clashes: f.rawClashCount })}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <FamilyTags family={f} />
            {f.decision?.status === "rejected" && <span className="rounded-full border border-red-200 bg-red-50 px-1.5 leading-5 text-red-800" title={t("families.rejectedBy", { user: f.decision.decidedBy })}>{t("families.split")}</span>}
          </span>
        </div>
        {/* G16: decisions of older grupos (previous signature) that disagree here: never applied, a human reviews them. */}
        {!!f.legacyDecisions?.length && (
          <div role="note" className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
            <p className="font-medium">{t("inheritedBulk.legacyTitle")}</p>
            <ul className="mt-0.5 space-y-0.5">
              {f.legacyDecisions.map((d) => (
                <li key={`${d.familyId}@${d.version}`}>{t("inheritedBulk.legacyRow", { family: d.familyId, version: d.version, validity: t(VALIDITY_KEY[d.validity]), responsible: d.responsibleDiscipline })}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" id="triage-detail" tabIndex={-1}>
        {lens === "reunion" && <MeetingNoteSection key={f.id} rowKey={`f:${f.id}`} />}
        <div className="mx-4">
          <LoopRail model={familyRail(t, f, { done: f.groupIds.filter((id) => store.state.latest.has(id)).length, total: f.groupIds.length })} provenance={f.provenance} />
        </div>
        <FamilyReceipt f={f} />
        <FamilyProposal f={f} draft={draft} options={pt?.options ?? []} impact={impact} />

        <FamilyChangeLine f={f} />
        {f.tags.includes("validez_mixta") && <ValidityMixLine f={f} />}
        <EvidenceLine f={f} />

        <Section id="instances" title={t("families.instancesTitle", { count: f.instanceCount })} open={instancesOpen} onToggle={() => set("instances", !instancesOpen)}>
          <InstancesTable f={f} />
        </Section>
        {issueOn && (
          <Section id="issuePreview" title={t("families.issueTitle")} open={!!prefs.issuePreview} onToggle={() => set("issuePreview", !prefs.issuePreview)}>
            <IssuePreview f={f} draft={draft} impact={impact} ptName={pt?.nameEs ?? ""} />
          </Section>
        )}
        <Section id="signature" title={t("families.signatureTitle")} open={!!prefs.signature} onToggle={() => set("signature", !prefs.signature)}>
          <p className="break-words font-mono text-[11px] text-gray-600">{f.signature}</p>
          {f.levels.length > 0 && <p className="mt-1 text-xs text-gray-600">{t("families.levelsCovered", { levels: f.levels.join(", ") })}</p>}
        </Section>
      </div>
    </div>
  );
}

/** Receipt of the last decision on this family; it stays until the coordinator moves to another group. */
function FamilyReceipt({ f }: { f: TriageFamily }) {
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const r = useTriage(store, (s) => s.familyReceipt);
  const [busy, setBusy] = useState(false);
  // Leaving the group clears it (the panel is keyed by the cursor).
  useEffect(() => () => {
    if (store.state.familyReceipt?.familyId === f.id) store.setFamilyReceipt(null);
  }, [store, f.id]);
  if (!r || r.familyId !== f.id) return null;
  const testId = store.state.payload?.test.id ?? "";
  async function undo() {
    if (!f.decision || busy) return;
    setBusy(true);
    try {
      const res = await api.undoFamilyDecision(f.id, { testId, version: f.decision.version });
      store.applyFamilies(await api.getFamilies(testId), f.id);
      if (res.receipt) store.setFamilyReceipt({ familyId: f.id, receipt: res.receipt, corrected: false });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const canUndo = !!f.decision && f.decision.testKey === testId;
  return <DecisionReceipt receipt={r.receipt} corrected={r.corrected} onUndo={canUndo ? () => void undo() : undefined} undoBusy={busy} />;
}

type FamilyButton = "accept" | "correct" | "split";

function FamilyProposal({ f, draft, options, impact }: { f: TriageFamily; draft: FamilyDraft; options: string[]; impact: FamilyImpact }) {
  const t = useT();
  const { lang } = useI18n();
  const api = useApi();
  const { store, actions } = useTriageContext();
  const editing = useTriage(store, (s) => s.editing);
  const disciplines = useTriage(store, (s) => s.disciplines);
  const hint = useTriage(store, (s) => s.hint);
  const cons = useConsequences<FamilyButton>();
  const [preview, setPreview] = useState<FamilyDecisionPreview | null>(null);
  const dl = (code: string) => {
    const d = disciplines.find((x) => x.code === code);
    return d ? `${code} · ${lang === "en" ? d.en : d.es}` : code;
  };
  const decided = f.decision?.status === "approved";
  const agentP = !decided ? f.pendingProposals[f.pendingProposals.length - 1] : undefined;
  const prov = f.provenance;
  const isAgent = !decided && prov?.source === "agent";
  const diffs = new Map((isAgent ? prov?.agent?.diffs ?? [] : []).map((d) => [d.field, d]));
  const pen = f.evidence.penetrationMm;
  const why = agentP?.rationale ?? t("families.whyDefault", { count: f.instanceCount, levels: f.levels.length, min: Math.round(pen.min), max: Math.round(pen.max) });
  const spotOk = impact.spotDone.length >= impact.spotRequired;
  const testId = store.state.payload?.test.id ?? "";
  const draftKey = JSON.stringify(draft);
  // Rules line of the consequences: server preview (same tally as Reglas), fetched on the first hover/focus.
  const wantPreview = cons.active !== null;
  useEffect(() => {
    if (!wantPreview || !testId || editing) return;
    let live = true;
    api
      .previewFamilyDecision(f.id, { testId, decision: "approve", validity: draft.validity, action: draft.action, responsibleDiscipline: draft.responsibleDiscipline, ...(agentP ? { proposalId: agentP.id } : {}) })
      .then((p) => live && setPreview(p), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, f.id, testId, draftKey, wantPreview, editing, agentP?.id]);
  const row = (label: string, value: React.ReactNode, field?: ProposalDiffField, ruleLabel?: (v: string) => string) => {
    const d = field ? diffs.get(field) : undefined;
    return (
      <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-xs text-gray-500">{label}</dt>
        <dd className="min-w-0 break-words">
          {value}
          {d && <NeqMark value={ruleLabel ? ruleLabel(d.ruleValue) : d.ruleValue} />}
        </dd>
      </div>
    );
  };
  const sel = "w-full min-w-0 rounded border border-brand-muted/30 bg-white px-1.5 py-1 text-sm";
  const values = [t(VALIDITY_KEY[draft.validity]), t(FAMILY_ACTION_KEY[draft.action]), draft.responsibleDiscipline].join(" · ");
  const issueAction = draft.action === "create_issue" || draft.action === "hygiene_issue";
  const closing = isClosingAction(draft.action);
  const learnParts = preview?.learning ? learningParts(t, preview.learning) : null;
  const agentCorr = isAgent ? preview?.learning?.find((l) => l.corrections.some((c) => c.count > 0)) : undefined;
  const rulesLine = !preview ? t("loop.cons.rulesLoading") : agentCorr ? t("loop.cons.agentRules", { id: agentCorr.ruleId }) : learnParts?.length ? learnParts.join(" · ") : t("loop.cons.rulesNone");
  const consequences: Record<FamilyButton, Consequence> = {
    accept: {
      title: t("loop.cons.title.accept"),
      now: t("loop.cons.acceptNow", { count: impact.applied.length, values }),
      after: issueAction ? t("loop.cons.afterIssue", { count: preview?.issues ?? 1 }) : closing ? t("loop.cons.afterClose", { count: impact.affectedClashes }) : t("loop.cons.afterNone"),
      rules: rulesLine,
    },
    correct: { title: t("loop.cons.title.correct"), now: t("loop.cons.correctNow"), after: t("loop.cons.correctAfter"), rules: t("loop.cons.correctRules") },
    split: { title: t("loop.cons.title.split"), now: t("loop.cons.splitNow"), after: t("loop.cons.splitAfter"), rules: t("loop.cons.splitRules") },
  };
  const ruleValueLabel = (field: ProposalDiffField) => (v: string) =>
    field === "validity" && (VALIDITY_KEY as Record<string, TKey>)[v] ? t((VALIDITY_KEY as Record<string, TKey>)[v]!) : field === "action" && (FAMILY_ACTION_KEY as Record<string, TKey>)[v] ? t((FAMILY_ACTION_KEY as Record<string, TKey>)[v]!) : v || "—";
  return (
    <section aria-labelledby="fp-proposal" className={`mx-4 mt-3 rounded-lg border border-brand-muted/30 bg-white p-3 ${isAgent ? "border-l-4 border-l-violet-400" : ""}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <h3 id="fp-proposal" className="mr-auto text-xs font-semibold uppercase tracking-wide text-gray-500">
          {decided ? t("families.decisionTitle") : t("families.proposal")}
        </h3>
      </div>
      <OriginBadge provenance={prov} className="mb-2" />
      {editing ? (
        <div className="space-y-2 text-sm">
          <label className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
            <span className="text-xs text-gray-500">{t("detail.field.validity")}</span>
            <select className={sel} value={draft.validity} onChange={(e) => store.setFamilyDraft(f.id, { validity: e.target.value as Validity })}>
              {VALIDITY_ORDER.map((v) => (
                <option key={v} value={v} title={t(VALIDITY_TIP[v])}>
                  {t(VALIDITY_KEY[v])}
                </option>
              ))}
            </select>
          </label>
          <label className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
            <span className="text-xs text-gray-500">{t("detail.suggestedAction")}</span>
            <select className={sel} value={draft.action} onChange={(e) => store.setFamilyDraft(f.id, { action: e.target.value as FamilyAction })}>
              {FAMILY_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(FAMILY_ACTION_KEY[a])}
                </option>
              ))}
            </select>
          </label>
          <label className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
            <span className="text-xs text-gray-500">{t("detail.whoMoves")}</span>
            <select className={sel} value={draft.responsibleDiscipline} onChange={(e) => store.setFamilyDraft(f.id, { responsibleDiscipline: e.target.value })}>
              {[...new Set([draft.responsibleDiscipline, ...disciplines.map((d) => d.code)])].map((c) => (
                <option key={c} value={c}>
                  {dl(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
            <span className="text-xs text-gray-500">{t("families.solution")}</span>
            <select className={sel} value={draft.solutionOption ?? ""} onChange={(e) => store.setFamilyDraft(f.id, { solutionOption: e.target.value || undefined })}>
              <option value="">{t("families.solutionNone")}</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {optionLabel(t, o, f)}
                </option>
              ))}
            </select>
          </label>
          {f.tags.includes("tipico") && (
            <label className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
              <span className="text-xs text-gray-500">{t("families.typicalNote")}</span>
              <input className={sel} value={draft.typicalNote ?? ""} placeholder={t("families.typicalNotePlaceholder")} onChange={(e) => store.setFamilyDraft(f.id, { typicalNote: e.target.value })} />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => { store.setFamilyDraft(f.id, null); store.setEditing(false); }} className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={() => { store.setEditing(false); actions.accept(); }} className="rounded bg-brand px-2 py-1 text-xs font-medium text-white hover:bg-brand-light">
              {t("families.useChanges")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="space-y-1 text-sm">
            {row(t("detail.field.validity"), <ValidityBadge value={draft.validity} />, "validity", ruleValueLabel("validity"))}
            {row(t("detail.suggestedAction"), t(FAMILY_ACTION_KEY[draft.action]), "action", ruleValueLabel("action"))}
            {row(t("detail.whoMoves"), <>{dl(draft.responsibleDiscipline)}{f.proposed.secondaryDiscipline && <span className="text-xs text-gray-500"> · {t("families.consulted", { d: f.proposed.secondaryDiscipline })}</span>}</>, "responsibleDiscipline")}
            {row(
              t("families.solution"),
              draft.solutionOption ? (
                optionLabel(t, draft.solutionOption, f)
              ) : (
                <ol className="list-decimal space-y-0.5 pl-4 text-xs text-gray-700">
                  {options.map((o) => (
                    <li key={o}>{optionLabel(t, o, f)}</li>
                  ))}
                </ol>
              ),
              "solutionOption",
            )}
          </dl>
          <p className="mt-2 text-xs text-gray-700" lang="es" title={why}>
            {isAgent && <span aria-hidden="true" className="text-actor-agent">✦ </span>}
            {oneLine(why)}
          </p>
        </>
      )}
      {!editing && (
        <div className="mt-3">
          <div className="relative">
            <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t("families.proposal")}>
              <button type="button" title={t("families.acceptTip")} {...cons.bind("accept")} onClick={() => actions.accept()} className="flex min-w-0 items-center justify-center gap-1 rounded bg-brand px-1.5 py-1.5 text-xs font-medium text-white hover:bg-brand-light">
                {f.decision?.status === "approved" ? t("families.reapprove") : t("families.approve")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">A</kbd>
              </button>
              <button type="button" title={t("families.correctTip")} {...cons.bind("correct")} onClick={() => store.setEditing(true)} className="flex min-w-0 items-center justify-center gap-1 rounded border border-brand-muted/30 px-1.5 py-1.5 text-xs text-gray-700 hover:border-brand-light/40">
                {t("families.correct")} <Kbd>E</Kbd>
              </button>
              <button type="button" title={t("families.splitTip")} aria-label={t("families.splitLong")} {...cons.bind("split")} onClick={() => actions.reject()} className="flex min-w-0 items-center justify-center gap-1 rounded border border-brand-muted/30 px-1.5 py-1.5 text-xs text-gray-700 hover:border-brand-light/40">
                {t("families.split")} <Kbd>X</Kbd>
              </button>
            </div>
            <ConsequencePopover items={consequences} active={cons.active} idOf={cons.idOf} />
          </div>
          <p className="mt-1.5 text-[11px] text-gray-600">
            {t("families.blastRadius", { clashes: impact.affectedClashes, instances: impact.applied.length })}
            {impact.excepted.length > 0 && ` · ${t("families.exceptionsCount", { count: impact.excepted.length })}`}
          </p>
          {!spotOk && (
            <p className="mt-0.5 text-[11px] text-amber-800">
              {t("families.spotCheckNeeded", { count: impact.spotRequired, done: impact.spotDone.length })}
            </p>
          )}
          {hint && (
            <p role="status" className="mt-0.5 text-[11px] text-amber-800">
              {hint}
            </p>
          )}
          <AskAgentLink />
        </div>
      )}
    </section>
  );
}

/** Size breakdown and penetration range (§5.2 evidence), one line. */
function EvidenceLine({ f }: { f: TriageFamily }) {
  const t = useT();
  const pen = f.evidence.penetrationMm;
  const sizes = f.evidence.sizeHistogram.slice(0, 4).map((x) => `${x.size} ×${x.count}`).join(" · ");
  return (
    <p className="mx-4 mt-2 truncate text-[11px] text-gray-600" title={f.evidence.sizeHistogram.map((x) => `${x.size} ×${x.count}`).join("\n")}>
      {t("families.evidence", { min: Math.round(pen.min), max: Math.round(pen.max) })}
      {sizes && ` · ${sizes}`}
    </p>
  );
}

/** "Respecto de v10: 3 nuevas · 1 reapareció · 8 sin cambios" (ubicaciones). */
function FamilyChangeLine({ f }: { f: TriageFamily }) {
  const t = useT();
  const { store } = useTriageContext();
  const groups = useTriage(store, (s) => s.groups);
  const prev = useTriage(store, (s) => s.payload?.changeSummary?.previousVersion);
  const counts = familyChangeCounts(f, groups);
  const top = topChange(counts);
  if (!top || prev === undefined) return null;
  const parts = [
    counts.reappeared ? t("families.changeReappeared", { count: counts.reappeared }) : "",
    counts.changed ? t("families.changeChanged", { count: counts.changed }) : "",
    counts.new ? t("families.changeNew", { count: counts.new }) : "",
    counts.unchanged ? t("families.changeUnchanged", { count: counts.unchanged }) : "",
  ].filter(Boolean);
  return (
    <p className="mx-4 mt-2 flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
      <ChangeChip change={top} />
      <span>{t("families.changeLine", { version: prev, parts: parts.join(" · ") })}</span>
    </p>
  );
}

function ValidityMixLine({ f }: { f: TriageFamily }) {
  const t = useT();
  const parts = VALIDITY_ORDER.filter((v) => f.validityMix[v]).map((v) => `${f.validityMix[v]} ${t(VALIDITY_KEY[v]).toLowerCase()}`);
  return (
    <p className="mx-4 mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
      ⚠ {t("families.mixedToday", { parts: parts.join(" · ") })}
    </p>
  );
}

function InstancesTable({ f }: { f: TriageFamily }) {
  const t = useT();
  const { store } = useTriageContext();
  const exc = useTriage(store, (s) => s.familyExceptions.get(f.id));
  const visits = useTriage(store, (s) => s.familyVisits.get(f.id));
  const [editingReason, setEditingReason] = useState<string | null>(null);
  const instances = f.groupIds.map((id) => store.state.groups.get(id)).filter((g): g is FamilyGroup => !!g);
  return (
    <ul className="divide-y divide-brand-muted/10 text-xs" aria-label={t("families.instancesTitle", { count: instances.length })}>
      {instances.map((g) => {
        const isExc = !!exc?.has(g.id);
        const e = store.evaluate("group", g.id);
        return (
          <li key={g.id} className="py-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              {e?.d.priority && <PriorityChip value={e.d.priority} />}
              <button type="button" onClick={() => store.reveal(rowKey("group", g.id))} className="min-w-0 flex-1 truncate text-left text-gray-800 hover:text-brand hover:underline" title={`${g.title}\n${t("families.openInstance")}`}>
                {instanceLabel(g)} · <span className="text-gray-500">{g.title}</span>
              </button>
              <span className="shrink-0 font-mono text-[11px] text-gray-500">×{clashCount(g)}</span>
              <ValidityBadge value={g.validity} />
              {visits?.has(g.id) && <span title={t("families.visited")} className="shrink-0 text-[10px] text-green-700">✓</span>}
              <InheritanceMark group={g} />
              <label className="flex shrink-0 items-center gap-1 text-[11px] text-gray-600" title={t("families.exceptionTooltip")}>
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-amber-600"
                  checked={isExc}
                  onChange={(ev) => {
                    store.setFamilyException(f.id, g.id, ev.target.checked ? "" : null);
                    setEditingReason(ev.target.checked ? g.id : null);
                  }}
                />
                {t("families.exception")}
              </label>
            </div>
            {isExc && (
              <input
                autoFocus={editingReason === g.id}
                aria-label={t("families.exceptionReason")}
                placeholder={t("families.exceptionReasonPlaceholder")}
                value={exc?.get(g.id) ?? ""}
                onChange={(ev) => store.setFamilyException(f.id, g.id, ev.target.value)}
                className={`mt-1 w-full rounded border px-1.5 py-0.5 text-xs ${exc?.get(g.id) ? "border-brand-muted/30" : "border-amber-400"}`}
              />
            )}
            {!isExc && f.pendingExceptions?.filter((p) => p.groupId === g.id).slice(0, 1).map((p) => <AgentException key={p.id} f={f} p={p} />)}
          </li>
        );
      })}
    </ul>
  );
}

/** Agent suggestion (propose_family_exception): the human accepts it here; the server marks the proposal applied. */
function AgentException({ f, p }: { f: TriageFamily; p: NonNullable<TriageFamily["pendingExceptions"]>[number] }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const [busy, setBusy] = useState(false);
  const testId = store.state.payload?.test.id ?? "";
  async function accept() {
    if (!testId || busy) return;
    setBusy(true);
    try {
      await api.setFamilyException(f.id, { testId, groupId: p.groupId, reason: p.reason, fields: p.fields, proposalId: p.id });
      store.applyFamilies(await api.getFamilies(testId));
      toast.show(t("families.agentExceptionAccepted"));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-900" title={p.rationale}>
      <span className="min-w-0 flex-1 truncate">{t("families.agentException", { reason: p.reason })}</span>
      <button type="button" disabled={busy || !testId} onClick={() => void accept()} className="shrink-0 rounded bg-violet-600 px-1.5 text-[11px] font-medium text-white hover:bg-violet-700 disabled:opacity-50">
        {t("families.agentExceptionAccept")}
      </button>
    </div>
  );
}

/** One ACC issue per family (default) or one per instance, built from the current draft. */
export function buildFamilyIssues(f: TriageFamily, draft: FamilyDraft, impact: FamilyImpact, ptName: string, split: boolean): { title: string; description: string; clashes: number }[] {
  const code = `[${f.id}]`;
  const solution = draft.solutionOption ? `Solución: ${draft.solutionOption}.` : "";
  const typical = f.tags.includes("tipico") ? `Detalle típico${draft.typicalNote ? `: ${draft.typicalNote}` : ""}.` : "";
  const resp = `Responsable: ${draft.responsibleDiscipline}${f.proposed.secondaryDiscipline ? `; consultados: ${f.proposed.secondaryDiscipline}` : ""}.`;
  if (!split) {
    const levels = byLevel(impact.applied)
      .map((l) => `· ${l.level}: ${l.instances} ${l.instances === 1 ? "ubicación" : "ubicaciones"} (${l.clashes} interf.)`)
      .join("\n");
    const description = [`${ptName}: ${f.title}.`, solution, typical, `Ubicaciones por nivel:\n${levels}`, resp].filter(Boolean).join("\n");
    return [{ title: `${code} ${f.title}`.slice(0, 120), description, clashes: impact.affectedClashes }];
  }
  return impact.applied.map((g) => ({
    title: `${code} ${f.title} — ${instanceLabel(g)}`.slice(0, 120),
    description: [`${ptName}: ${g.title}.`, solution, typical, resp].filter(Boolean).join("\n"),
    clashes: clashCount(g),
  }));
}

function IssuePreview({ f, draft, impact, ptName }: { f: TriageFamily; draft: FamilyDraft; impact: FamilyImpact; ptName: string }) {
  const t = useT();
  const { store } = useTriageContext();
  const split = useTriage(store, (s) => s.familySplit.has(f.id));
  const issues = buildFamilyIssues(f, draft, impact, ptName, split);
  return (
    <div className="space-y-2 text-xs">
      <label className="flex items-center gap-1.5 text-gray-700">
        <input type="checkbox" className="h-3.5 w-3.5 accent-brand" checked={split} onChange={(e) => store.setFamilySplit(f.id, e.target.checked)} />
        {t("families.splitIssues")}
      </label>
      <p className="text-[11px] text-gray-500">{split ? t("families.issueCountSplit", { count: issues.length }) : t("families.issueCountFamily", { clashes: impact.affectedClashes })}</p>
      <ul className="space-y-2">
        {issues.slice(0, split ? 50 : 1).map((iss, i) => (
          <li key={i} className="rounded border border-brand-muted/20 bg-gray-50 p-2">
            <p className="font-medium text-gray-900">{iss.title}</p>
            {!split && (
              <>
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[11px] text-gray-700">{iss.description}</pre>
                <p className={`mt-1 text-right text-[10px] ${iss.description.length > 1000 ? "text-red-700" : "text-gray-400"}`}>{t("families.charCount", { count: iss.description.length })}</p>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Node summary (pair / problem type rows) ────────────────────────

/** Compact summary of a pair / problem-type node: totals, by priority, by validity, and its grupos (all under the active filters). */
export function NodePanel({ nodeId }: { nodeId: string }) {
  const t = useT();
  const { store } = useTriageContext();
  const n = useTriage(store, (s) => s.nodes.get(nodeId));
  const families = useTriage(store, (s) => s.families);
  const stats = useTriage(store, (s) => s.familyStats);
  const visible = useTriage(store, (s) => s.visibleByGroup);
  const label = useNodeLabel(n);
  const reminder = useTriage(store, (s) => (n?.discipline ? s.reminders.get(n.discipline) : undefined));
  if (!n) return <EmptyState title={t("detail.noSelection")} />;
  if (n.bucket === "discipline")
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-brand-muted/20 px-4 pb-2 pt-3">
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-gray-900">{label}</h2>
          {n.discipline && <CopyReminderButton discipline={n.discipline} />}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs" id="triage-detail" tabIndex={-1}>
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-gray-500">{t("issues.reminderTitle")}</h3>
          <pre className="whitespace-pre-wrap break-words rounded border border-brand-muted/20 bg-gray-50 p-2 font-sans text-gray-800">{reminder?.text ?? t("issues.noReminder")}</pre>
        </div>
      </div>
    );
  const clashes = store.selectionMembers(`n:${nodeId}`).members;
  const byPriority = new Map<number, number>();
  for (const gid of store.subtreeGroups(`n:${nodeId}`)) {
    const p = store.evaluate("group", gid)?.d.priority;
    if (p) byPriority.set(p, (byPriority.get(p) ?? 0) + (visible.get(gid)?.length ?? 0));
  }
  const byValidity = new Map<Validity, number>();
  for (const c of clashes) byValidity.set(c.validity, (byValidity.get(c.validity) ?? 0) + 1);
  const fams = n.familyIds.map((id) => families.get(id)).filter((f): f is TriageFamily => !!f);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex-shrink-0 border-b border-brand-muted/20 px-4 pb-2 pt-3">
        <h2 className="text-sm font-semibold text-gray-900">{label}</h2>
        <p className="mt-0.5 text-xs text-gray-600">{t("families.summaryClashes", { count: n.bucket === "loose" ? n.instanceCount : n.familyIds.length, groups: n.bucket === "loose" ? n.instanceCount : n.familyIds.length, locations: n.instanceCount, clashes: n.clashCount })}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs" id="triage-detail" tabIndex={-1}>
        <h3 className="mb-1 font-semibold uppercase tracking-wide text-gray-500">{t("families.byPriority")}</h3>
        <ul className="mb-3 flex flex-wrap gap-2">
          {[1, 2, 3, 4].filter((p) => byPriority.get(p)).map((p) => (
            <li key={p} className="flex items-center gap-1">
              <PriorityChip value={p as 1 | 2 | 3 | 4} /> <span className="text-gray-700">{t("list.clashesCount", { count: byPriority.get(p) ?? 0 })}</span>
            </li>
          ))}
        </ul>
        <h3 className="mb-1 font-semibold uppercase tracking-wide text-gray-500">{t("families.byValidity")}</h3>
        <ul className="mb-3 flex flex-wrap gap-2">
          {VALIDITY_ORDER.filter((v) => byValidity.get(v)).map((v) => (
            <li key={v} className="flex items-center gap-1">
              <ValidityBadge value={v} /> <span className="text-gray-700">{byValidity.get(v)}</span>
            </li>
          ))}
        </ul>
        {fams.length > 0 && (
          <>
            <h3 className="mb-1 font-semibold uppercase tracking-wide text-gray-500">{t("families.familiesTitle")}</h3>
            <ul className="divide-y divide-brand-muted/10" aria-label={t("families.familiesTitle")}>
              {fams.map((f) => {
                const st = stats.get(f.id);
                return (
                  <li key={f.id} className="py-1.5">
                    <button type="button" onClick={() => store.reveal(`f:${f.id}`)} className="flex w-full min-w-0 items-center gap-1.5 text-left hover:text-brand">
                      {st?.worst && <PriorityChip value={st.worst} />}
                      <span className="min-w-0 flex-1 truncate" title={f.title}>{f.title}</span>
                      <span className="shrink-0 text-[11px] text-gray-500">{t("families.rowCounts", { instances: st?.instanceCount ?? 0, clashes: st?.clashCount ?? 0, levels: st?.levels ?? 0 })}</span>
                    </button>
                    <p className="text-[11px] text-gray-500">{levelRange(f.levels)}</p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
