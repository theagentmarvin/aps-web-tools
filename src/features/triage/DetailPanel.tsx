/**
 * Detail pane, decision-first: a coordinator should decide in ~5 seconds.
 *
 *   1. Header: one plain-language line of what is happening + priority +
 *      review state (one chip; reasons in its tooltip) + ◀ ▶.
 *   2. Agent proposal: validity, suggested action, who moves, ONE confidence
 *      indicator, a one-line why.
 *   3. Actions right below: Aceptar (A) · Cambiar (E) · Rechazar (X) · Posponer (S),
 *      with a small inline hint only when a guard applies.
 *   4. Evidence strip: one line per side (A ■ / B ▲); full cards collapsed below.
 *   5. Everything else in collapsed sections (state remembered per user).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import { minConfidence } from "~/lib/api/decision-utils";
import type { Clash, InheritedDecision, DecisionChange, ElementInfo, IssueDraft, Nature, Proposal, Validity } from "~/lib/api/types";
import { categoryNoun, categoryTitle } from "~/lib/category-names";
import { ConfidenceBadge, FlaggedChip, NatureBadge, PriorityChip, ReasonChip, SpotCheckChip, ValidityBadge } from "~/lib/components/badges";
import { IconInherited, IconChevronLeft, IconChevronRight, SideASwatch, SideBSwatch } from "~/lib/components/icons";
import { EmptyState, Kbd, Skeleton } from "~/lib/components/ui";
import { useToast } from "~/lib/components/Toast";
import { DECISION_KEY } from "~/lib/labels";
import { useTriageContext } from "./actions";
import {
  ChangesContent,
  ClashesTable,
  ElementDetails,
  HistoryList,
  InlineEditor,
  IssueDraftFields,
  PropertiesContent,
  ReasoningContent,
  hasChanges,
  useActionLabel,
  useHistoryItems,
} from "./detail-sections";

import { writeQuery, type Evaluated } from "./filters";
import { clashChange, groupChange } from "./change";
import { CONFIRM_ABOVE, answerBody, decidedCount, inheritedSummary, optionsOf, type UiOption } from "./questions";
import { ChangeChip } from "./RowMarks";
import { oneLine, summarizePair, type PairSummary, type SideFacts } from "./pair-summary";
import { parseKey, useTriage } from "./store";
import { Section, useCalibrationText, useSectionPrefs, type SectionId } from "./detail-accordion";
import { FamilyPanel, NodePanel } from "./FamilyPanel";
import { IssuePanel, VerificationSection } from "./IssueViews";
import { MeetingNoteSection } from "./MeetingViews";

// ── Helpers ────────────────────────────────────────────────────────


/** Review reasons: GroupDetail.reviewReasons, else the proposal's "Revisión" signal. */
function useReviewReasons(e: Evaluated, groupId: string): string[] {
  const api = useApi();
  const [reasons, setReasons] = useState<string[]>([]);
  const needs = e.s.group?.reviewState === "needs_review";
  const testId = e.s.group?.testId ?? "";
  useEffect(() => {
    let alive = true;
    setReasons([]);
    if (!needs) return;
    const id = window.setTimeout(() => {
      api.getGroup(testId, groupId).then(
        (d) => alive && setReasons(d.reviewReasons ?? []),
        () => undefined,
      );
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [api, testId, groupId, needs]);
  if (!needs) return [];
  if (reasons.length) return reasons;
  const sig = e.s.proposal?.signals.find((s) => /^revisi[oó]n$|^review$/i.test(s.label));
  return sig ? sig.value.split(/;\s*/).filter(Boolean) : [];
}

const VERB: Record<Nature, TKey> = { hard: "detail.verb.hard", clearance: "detail.verb.clearance", duplicate: "detail.verb.duplicate", workflow: "detail.verb.workflow" };

function useWhatLine(pair: PairSummary | null, nature: Nature | undefined, fallback: string): string {
  const t = useT();
  const { fmt, lang } = useI18n();
  if (!pair) return fallback;
  const m = pair.mover;
  const h = pair.host;
  const n = m.elements.length;
  const movers = `${n} ${categoryNoun(m.category, n, lang)} ${m.discipline}`.trim();
  const host1 = h.elements.length === 1 ? `${categoryTitle(h.representative.category, lang)} ${h.representative.type ?? ""}`.trim() : `${h.elements.length} ${categoryNoun(h.category, h.elements.length, lang)} ${h.discipline}`;
  const parts = [t(VERB[nature ?? "hard"], { count: n, movers, host: host1 })];
  if (pair.level) parts.push(pair.level);
  if (pair.penetrationMaxMm > 0 && nature !== "clearance") parts.push(t("detail.penMax", { value: fmt.number(Math.round(pair.penetrationMaxMm)) }));
  return parts.join(" · ");
}

function stripText(side: SideFacts, lang: "es" | "en"): string {
  const el: ElementInfo = side.representative;
  const what = `${categoryTitle(el.category, lang)} ${el.system ?? el.type ?? ""}`.trim();
  return [what, el.sizeHint, el.modelName].filter(Boolean).join(" · ");
}

export function DetailSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-busy="true">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-24" />
      <Skeleton className="h-10" />
      <Skeleton className="h-28" />
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────

/** Right pane: family / tree-node summary, or the instance (group/clash) panel. */
export function DetailPanel() {
  const { store } = useTriageContext();
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  if (cursorKey?.startsWith("f:")) return <FamilyPanel key={cursorKey} familyId={cursorKey.slice(2)} />;
  if (cursorKey?.startsWith("n:")) return <NodePanel key={cursorKey} nodeId={cursorKey.slice(2)} />;
  if (cursorKey?.startsWith("i:")) return <IssuePanel key={cursorKey} issueId={cursorKey.slice(2)} />;
  return <InstancePanel />;
}

function InstancePanel() {
  const t = useT();
  const { lang } = useI18n();
  const { store } = useTriageContext();
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  const log = useTriage(store, (s) => s.log);
  useTriage(store, (s) => s.latest);
  useTriage(store, (s) => s.proposals);
  const rationaleOpen = useTriage(store, (s) => s.rationaleOpen);
  const issueEdits = useTriage(store, (s) => (cursorKey ? s.edits.get(cursorKey.slice(2))?.issue : undefined));
  const calibration = useCalibrationText();
  const { prefs, set } = useSectionPrefs();
  const lens = useTriage(store, () => store.effectiveLens());
  const issue = useTriage(store, (s) => {
    const parsedKey = s.cursorKey && (s.cursorKey.startsWith("g:") || s.cursorKey.startsWith("c:")) ? s.cursorKey : null;
    if (!parsedKey) return undefined;
    const gid = parsedKey.startsWith("g:") ? parsedKey.slice(2) : (s.clashes.get(parsedKey.slice(2))?.groupId ?? "");
    const id = s.issueByGroup.get(gid);
    return id ? s.issueChecks.get(id) : undefined;
  });

  const parsed = cursorKey ? parseKey(cursorKey) : null;
  const e = parsed ? store.evaluate(parsed.kind, parsed.id) : undefined;
  const kind = parsed?.kind ?? "group";
  const id = parsed?.id ?? "";
  const groupId = e?.s.group?.id ?? e?.s.clash?.groupId ?? "";
  const members = !e ? [] : kind === "group" ? (store.state.clashesByGroup.get(id) ?? []) : e.s.clash ? [e.s.clash] : [];
  const proposal = e?.s.proposal;
  const pair = e ? summarizePair(kind === "group" ? members : e.s.clash ? (store.state.clashesByGroup.get(groupId) ?? [e.s.clash]) : [], e.s.group, proposal, e.s.clash) : null;
  const reasons = useReviewReasons(e ?? ({ s: {} } as Evaluated), groupId);
  const fallbackTitle = e?.s.group?.title ?? (e?.s.clash ? `${e.s.clash.a.name} ↔ ${e.s.clash.b.name}` : "");
  const what = useWhatLine(kind === "clash" && pair && e?.s.clash ? { ...pair, mover: pair.mover.side === "a" ? { ...pair.a, elements: [pair.a.representative] } : { ...pair.b, elements: [pair.b.representative] }, host: pair.host.side === "a" ? { ...pair.a, elements: [pair.a.representative] } : { ...pair.b, elements: [pair.b.representative] }, penetrationMaxMm: Math.max(0, -e.s.clash.distanceMm) } : pair, e?.s.group?.nature ?? e?.s.clash?.nature, fallbackTitle);
  const history = useHistoryItems(proposal, log.filter((d) => d.targetId === id || (kind === "clash" && d.targetId === groupId)), members);

  if (!e || !cursorKey) return <EmptyState title={t("detail.noSelection")} />;

  const decision = store.decisionFor(kind, id);
  const showIssue = !!proposal?.issueDraft || !!issueEdits || !!(proposal && e.d.state === "corrected" && decision?.changes.some((c) => c.field === "action"));
  const baseDraft: IssueDraft | undefined =
    proposal?.issueDraft ??
    (issueEdits
      ? {
          title: fallbackTitle.slice(0, 120),
          description: "",
          ownerDiscipline: e.d.owner ?? e.s.group?.pair[1] ?? "",
          dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          includeView: true,
          linkClashIds: members.slice(0, 10).map((c) => c.id),
        }
      : undefined);
  const reasoningOpen = rationaleOpen ?? !!prefs.reasoning;
  const toggle = (sid: SectionId) => set(sid, !prefs[sid]);
  const clashCount = kind === "group" ? members.length : 1;
  const changesFirst = lens === "cambios" && hasChanges(e, members);

  function pinView() {
    let state: unknown = true;
    try {
      const v = (window as unknown as { __apsViewer?: { getViewer: () => { getState?: () => unknown } | null } }).__apsViewer?.getViewer();
      state = v?.getState?.() ?? true;
    } catch {
      /* no viewer */
    }
    store.setEdits(id, { issue: { ...issueEdits, pinnedView: state } });
  }

  function openReasoning() {
    if (!reasoningOpen) store.toggleRationale(!!prefs.reasoning);
    set("reasoning", true);
    window.setTimeout(() => document.getElementById("dsec-reasoning-h")?.scrollIntoView({ block: "nearest" }), 30);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex-shrink-0 border-b border-brand-muted/20 px-4 pb-2 pt-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-gray-900" lang="es" title={fallbackTitle}>
            {what}
          </h2>
          <span className="flex shrink-0 gap-0.5">
            <button type="button" aria-label={t("shortcuts.prev")} title={`${t("shortcuts.prev")} (K)`} onClick={() => store.move(-1)} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface">
              <IconChevronLeft size={14} />
            </button>
            <button type="button" aria-label={t("shortcuts.next")} title={`${t("shortcuts.next")} (J)`} onClick={() => store.move(1)} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface">
              <IconChevronRight size={14} />
            </button>
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          {e.d.priority && <PriorityChip value={e.d.priority} edited={e.d.edited && e.d.priority !== proposal?.fields.priority.value} />}
          {reasons.length > 0 && (
            <span title={reasons.join("\n")} className="max-w-full truncate rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] leading-5 text-amber-900">
              {t("detail.needsReview", { reason: reasons[0] })}
              {reasons.length > 1 && ` +${reasons.length - 1}`}
            </span>
          )}
          {e.s.group && <NatureBadge value={e.s.group.nature} />}
          {/* Reserved: future solution-family chip ("Familia: … (24 instancias)"). */}
          {groupId && <FamilyChip groupId={groupId} />}
          <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-gray-400">
            {kind === "group" ? id : e.s.clash?.id.slice(-8)} · {t("list.clashesCount", { count: clashCount })}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" id="triage-detail" tabIndex={-1}>
        {lens === "reunion" && <MeetingNoteSection key={cursorKey} rowKey={cursorKey} />}
        {/* Lens "Incidencias": the verification of this ubicación's issue opens first. */}
        {lens === "incidencias" && issue && <VerificationSection check={issue} />}
        {e.s.group?.closedInAccWhileReal && (
          <p role="note" className="mx-4 mt-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
            ⚠ {t("acc.closedWhileReal", { reason: e.s.group.acc?.closedReason ?? "—" })}
          </p>
        )}
        <QuestionCallout groupId={groupId} />
        {!decision && e.s.group?.inherited && (groupChange(e.s.group) === "unchanged" || e.s.group.inherited.needsConfirmation) && <InheritedCallout targetKey={cursorKey} inherited={e.s.group.inherited} />}
        <ChangeLine e={e} members={members} />
        <ProposalBlock e={e} proposal={proposal} decisionChanges={decision?.kind === "correct" ? decision.changes : []} reasonCode={decision?.reasonCode} calibration={calibration} onSeeReasoning={openReasoning} />

        {pair && (
          <section aria-label={t("detail.evidence")} className="space-y-0.5 px-4 py-3 text-xs">
            <EvidenceLine side="a" text={stripText(pair.a, lang)} more={pair.a.elements.length - 1} />
            <EvidenceLine side="b" text={stripText(pair.b, lang)} more={pair.b.elements.length - 1} />
          </section>
        )}

        <div className="mt-1">
          {/* Lens "Qué cambió": the changes section opens first. */}
          {changesFirst && (
            <Section id="changes" title={t("detail.sections.changes")} open={prefs.changes !== false} onToggle={() => set("changes", prefs.changes === false)}>
              <ChangesContent e={e} members={members} />
            </Section>
          )}
          {pair && (
            <Section id="elements" title={t("detail.sections.elements")} open={!!prefs.elements} onToggle={() => toggle("elements")}>
              <ElementDetails pair={pair} focusId={e.s.clash?.id ?? members[0]?.id ?? ""} />
            </Section>
          )}
          {kind === "group" && pair && members.length > 1 && (
            <Section id="clashes" title={t("detail.sections.clashes", { count: members.length })} open={!!prefs.clashes} onToggle={() => toggle("clashes")}>
              <ClashesTable pair={pair} groupId={id} />
            </Section>
          )}
          {proposal && (
            <Section
              id="reasoning"
              title={t("detail.sections.reasoning")}
              open={reasoningOpen}
              onToggle={() => {
                store.toggleRationale(!!prefs.reasoning);
                set("reasoning", !reasoningOpen);
              }}
            >
              <ReasoningContent proposal={proposal} calibration={calibration} />
            </Section>
          )}
          {!changesFirst && hasChanges(e, members) && (
            <Section id="changes" title={t("detail.sections.changes")} open={!!prefs.changes} onToggle={() => toggle("changes")}>
              <ChangesContent e={e} members={members} />
            </Section>
          )}
          {pair && (
            <Section id="properties" title={t("detail.sections.properties")} open={!!prefs.properties} onToggle={() => toggle("properties")}>
              <PropertiesContent testId={e.s.group?.testId ?? store.state.payload?.test.id ?? ""} a={pair.a.representative} b={pair.b.representative} />
            </Section>
          )}
          {showIssue && baseDraft && (
            <Section id="issue" title={t("detail.sections.issue")} open={!!prefs.issue || !!issueEdits} onToggle={() => toggle("issue")}>
              <IssueDraftFields targetId={id} draft={baseDraft} onPin={pinView} />
            </Section>
          )}
          {history.length > 0 && (
            <Section id="history" title={t("detail.sections.history")} open={!!prefs.history} onToggle={() => toggle("history")}>
              <HistoryList items={history} />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * X3 callout at the top of the panel. A decision comes only from a STRUCTURED
 * option sent by the server (never from text); free text is only an answer.
 * "Esta respuesta decidirá N ubicaciones"; above 3 an explicit confirmation.
 */
function QuestionCallout({ groupId }: { groupId: string }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const q = useTriage(store, (s) => {
    const id = s.openQuestionByGroup.get(groupId) ?? [...s.questions.values()].find((x) => x.groupIds.includes(groupId))?.id;
    return id ? s.questions.get(id) : undefined;
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<UiOption | null>(null);
  if (!q) return null;
  const options = optionsOf(q);
  const n = decidedCount(q);
  const anyDecides = options.some((o) => o.decides);
  async function send(option: UiOption | null, confirmed: boolean) {
    if (!q || (!option && !text.trim())) return;
    setBusy(true);
    try {
      const res = await api.answerQuestion(q.id, answerBody(q, option, text, confirmed));
      store.applyAnswer(q.id, res);
      if (res.decisionIds?.length) {
        const page = await api.listDecisions({ testId: store.state.payload?.test.id, limit: 200 });
        store.mergeServerDecisions(page.items);
      }
      toast.show(res.decisionIds?.length ? t("questions.answeredDecision") : t("questions.answered"));
      setText("");
      setPending(null);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  function choose(o: UiOption) {
    if (o.decides && n > CONFIRM_ABOVE) setPending(o);
    else void send(o, false);
  }
  return (
    <section aria-labelledby={`q-${q.id}`} className="mx-4 mt-3 rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm">
      <h3 id={`q-${q.id}`} className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-violet-900">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[10px] text-white">?</span>
        {t("questions.title")}
      </h3>
      <p className="text-gray-900" lang="es">
        {q.question}
      </p>
      {q.state === "open" ? (
        <>
          {anyDecides && <p className="mt-1 text-xs font-medium text-violet-900">{t("questions.willDecide", { count: n })}</p>}
          {!!options.length && !pending && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {options.map((o) => (
                <button
                  key={o.index}
                  type="button"
                  disabled={busy}
                  onClick={() => choose(o)}
                  title={o.decides ? t("questions.optionDecides", { count: n }) : t("questions.optionAnswerOnly")}
                  className="rounded border border-violet-300 bg-white px-2 py-1 text-xs text-violet-900 hover:border-violet-500 disabled:opacity-50"
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {pending && (
            <div role="alertdialog" aria-labelledby={`qc-${q.id}`} className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
              <p id={`qc-${q.id}`} className="font-medium text-amber-900">
                {t("questions.confirmText", { option: pending.label, count: n })}
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <button type="button" disabled={busy} onClick={() => void send(pending, true)} className="rounded bg-brand px-2 py-1 text-white disabled:opacity-50">
                  {t("questions.confirm", { count: n })}
                </button>
                <button type="button" onClick={() => setPending(null)} className="rounded border border-brand-muted/30 px-2 py-1 text-gray-700">
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(ev) => {
              ev.preventDefault();
              void send(null, false);
            }}
          >
            <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder={options.length ? t("questions.otherOption") : t("questions.placeholder")} aria-label={t("questions.placeholder")} title={t("questions.freeTextHint")} maxLength={1000} className="min-w-0 flex-1 rounded border border-violet-200 px-2 py-1 text-xs" />
            <button type="submit" disabled={busy || !text.trim()} className="rounded bg-violet-700 px-2 py-1 text-xs text-white disabled:opacity-50">
              {t("questions.send")}
            </button>
          </form>
        </>
      ) : q.state === "stale" ? (
        <p className="mt-1 text-xs text-gray-600">{t("questions.stale", { reason: q.staleReason ?? "" })}</p>
      ) : (
        <p className="mt-1 text-xs text-gray-700">{t("questions.answeredBy", { user: q.answeredBy ?? "—", answer: q.answer ?? "" })}</p>
      )}
    </section>
  );
}

/** F1: "Decisión heredada de v10" with Mantener (Enter) / Revisar, for unchanged ubicaciones. */
function InheritedCallout({ targetKey, inherited }: { targetKey: string; inherited: InheritedDecision }) {
  const t = useT();
  const { store, actions } = useTriageContext();
  return (
    <section aria-labelledby="inh-title" className="mx-4 mt-3 rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm">
      <h3 id="inh-title" className={`mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${inherited.needsConfirmation ? "text-amber-800" : "text-gray-600"}`}>
        <IconInherited size={13} />
        {inherited.needsConfirmation ? t("inherited.confirmTitle", { version: inherited.fromVersion }) : t("inherited.title", { version: inherited.fromVersion })}
      </h3>
      <p className="text-gray-900">{t("inherited.body", { summary: inheritedSummary(t, inherited), who: t(`inherited.source.${inherited.source}`), by: inherited.decidedBy ? ` (${inherited.decidedBy})` : "" })}</p>
      <div className="mt-2 flex gap-1.5">
        {inherited.needsConfirmation ? (
          // Changed / reappeared / gated: a normal, guarded accept (dwell guard and spot-check apply).
          <button type="button" onClick={() => actions.accept(targetKey)} className="flex items-center gap-1 rounded bg-brand px-2 py-1 text-xs font-medium text-white hover:bg-brand-light">
            {t("inherited.confirm")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">A</kbd>
          </button>
        ) : (
          <button type="button" onClick={() => actions.keepInherited(targetKey)} className="flex items-center gap-1 rounded bg-brand px-2 py-1 text-xs font-medium text-white hover:bg-brand-light">
            {t("inherited.keep")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">⏎</kbd>
          </button>
        )}
        <button type="button" onClick={() => store.setEditing(true)} className="flex items-center gap-1 rounded border border-brand-muted/30 px-2 py-1 text-xs text-gray-700 hover:border-brand-light/40">
          {t("inherited.review")} <Kbd>E</Kbd>
        </button>
      </div>
    </section>
  );
}

/** One line under the header when the item changed: "Antes (v10): … → ahora: …", or "Nueva" / "Reapareció". */
function ChangeLine({ e, members }: { e: Evaluated; members: Clash[] }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const prevVersion = useTriage(store, () => store.baseVersion());
  const change = e.s.clash ? clashChange(e.s.clash) : groupChange(e.s.group);
  if (!change || change === "unchanged") return null;
  const v = prevVersion ?? "—";
  const inh = e.s.group?.inherited;
  let text: string;
  if (change === "new") text = t("detail.changeNew", { version: v });
  else if (change === "reappeared") text = t("detail.changeReappeared");
  else {
    const list = e.s.clash ? [e.s.clash] : members;
    const prevPen = Math.max(0, ...list.filter((c) => c.previousDistanceMm !== undefined).map((c) => -(c.previousDistanceMm ?? 0)));
    const nowPen = e.s.clash ? Math.max(0, -e.s.clash.distanceMm) : (e.s.group?.penetrationMaxMm ?? 0);
    // Only the fields that changed: clash count (when clashes were added) and max penetration (when it moved).
    const added = list.filter((c) => c.delta === "new").length;
    const countChanged = !e.s.clash && added > 0;
    const hasPrevPen = list.some((c) => c.previousDistanceMm !== undefined);
    const penChanged = hasPrevPen && Math.round(prevPen) !== Math.round(nowPen);
    const before = [countChanged ? t("list.clashesCount", { count: list.length - added }) : "", penChanged ? t("detail.beforePen", { value: fmt.number(Math.round(prevPen)) }) : ""].filter(Boolean).join(" · ");
    const now = [countChanged ? t("detail.nowCount", { count: list.length, added }) : "", penChanged ? t("detail.beforePen", { value: fmt.number(Math.round(nowPen)) }) : ""].filter(Boolean).join(" · ");
    text = before ? t("detail.before", { version: v, before, now }) : t("detail.changedOther", { version: v });
    // The item had a decision on the baseline: show it so the coordinator re-decides quickly.
    if (inh) text = t("inherited.beforeChanged", { version: inh.fromVersion, summary: inheritedSummary(t, inh), what: before ? `${before} → ${now}` : t("detail.changedOther", { version: v }) });
  }
  return (
    <p className="mx-4 mt-3 flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
      <ChangeChip change={change} />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** "Grupo: … (N ubicaciones)": jumps to the grupo row in the tree. */
function FamilyChip({ groupId }: { groupId: string }) {
  const t = useT();
  const { store } = useTriageContext();
  const [, setSp] = useSearchParams();
  const family = useTriage(store, (s) => {
    const fid = s.familyOf.get(groupId);
    return fid ? s.families.get(fid) : undefined;
  });
  if (!family) return null;
  const go = () => {
    const key = `f:${family.id}`;
    if (store.state.query.view !== "families") {
      store.setQuery({ ...store.state.query, view: "families" });
      setSp((prev) => writeQuery(new URLSearchParams(prev), store.state.query), { replace: true });
    }
    store.reveal(key);
  };
  return (
    <button
      type="button"
      onClick={go}
      title={`${family.title}\n${t("families.goToFamily")}`}
      className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-slate-300 bg-slate-50 px-2 text-[11px] leading-5 text-slate-700 hover:border-brand hover:text-brand"
    >
      <span className="shrink-0">{t("detail.familyLabel")}</span>
      <span className="min-w-0 truncate">{family.title.split(" · ")[0]}</span>
      <span className="shrink-0">{t("detail.familyCount", { count: family.instanceCount })}</span>
    </button>
  );
}

function EvidenceLine({ side, text, more }: { side: "a" | "b"; text: string; more: number }) {
  const t = useT();
  return (
    <p className={`flex min-w-0 items-center gap-1.5 ${side === "a" ? "text-clash-a-ink" : "text-clash-b-ink"}`} title={text}>
      <span className="font-semibold">{side === "a" ? "A" : "B"}</span>
      {side === "a" ? <SideASwatch /> : <SideBSwatch />}
      <span className="min-w-0 truncate text-gray-800">{text}</span>
      {more > 0 && <span className="shrink-0 text-gray-500">{t("detail.moreElements", { count: more })}</span>}
    </p>
  );
}

function ProposalBlock({
  e,
  proposal,
  decisionChanges,
  reasonCode,
  calibration,
  onSeeReasoning,
}: {
  e: Evaluated;
  proposal: Proposal | undefined;
  decisionChanges: DecisionChange[];
  reasonCode?: string;
  calibration: (c: number) => string | undefined;
  onSeeReasoning: () => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  const { store } = useTriageContext();
  const editing = useTriage(store, (s) => s.editing);
  const disciplines = useTriage(store, (s) => s.disciplines);
  const actionLabel = useActionLabel();
  const changes = new Map(decisionChanges.map((c) => [c.field, c]));
  const dl = (code: string) => {
    const d = disciplines.find((x) => x.code === code);
    return d ? `${code} · ${lang === "en" ? d.en : d.es}` : code;
  };

  const row = (label: string, ai: ReactNode, field: "validity" | "owner" | "action", render: (v: unknown) => ReactNode) => {
    const ch = changes.get(field);
    return (
      <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-xs text-gray-500">{label}</dt>
        <dd className="min-w-0 break-words">
          {ch ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <s className="text-gray-400">{render(ch.aiValue)}</s>
              <span className="font-medium">{render(ch.humanValue)}</span>
              {reasonCode && <ReasonChip code={reasonCode} />}
            </span>
          ) : (
            ai
          )}
        </dd>
      </div>
    );
  };

  const conf = proposal ? minConfidence(proposal) : null;
  const agentMade = !!proposal && proposal.origin === "agent" && !e.d.edited && decisionChanges.length === 0;
  return (
    // Thin violet bar = agent-prepared content; it disappears once the human edits or corrects it.
    <section
      aria-labelledby="dp-proposal"
      className={`mx-4 mt-3 rounded-lg border border-brand-muted/30 bg-white p-3 ${agentMade ? "border-l-4 border-l-violet-400" : ""}`}
      title={agentMade ? t("detail.agentPrepared") : undefined}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <h3 id="dp-proposal" className="mr-auto text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t("detail.proposal")}
        </h3>
        {proposal?.spotCheck && <SpotCheckChip />}
        {proposal?.flagged && <FlaggedChip />}
        {conf !== null && <ConfidenceBadge value={conf} calibration={calibration(conf)} />}
      </div>
      {!proposal ? (
        <p className="text-sm text-gray-500">{t("detail.noProposal")}</p>
      ) : editing ? (
        <InlineEditor proposal={proposal} />
      ) : (
        <>
          <dl className="space-y-1 text-sm">
            {row(t("detail.field.validity"), <ValidityBadge value={proposal.fields.validity.value} />, "validity", (v) => <ValidityBadge value={v as Validity} />)}
            {row(t("detail.suggestedAction"), actionLabel(proposal.fields.action.value), "action", (v) => actionLabel(v as Proposal["fields"]["action"]["value"]))}
            {row(t("detail.whoMoves"), dl(proposal.fields.owner.value), "owner", (v) => dl(String(v)))}
          </dl>
          <p className="mt-2 text-xs text-gray-700" lang="es">
            {oneLine(proposal.rationale)}{" "}
            <button type="button" onClick={onSeeReasoning} className="whitespace-nowrap text-brand hover:underline">
              {t("detail.seeReasoning")}
            </button>
          </p>
        </>
      )}
      <DecisionActions e={e} />
    </section>
  );
}

function DecisionActions({ e }: { e: Evaluated }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store, actions } = useTriageContext();
  const hint = useTriage(store, (s) => s.hint);
  const editing = useTriage(store, (s) => s.editing);
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  const targetId = cursorKey ? parseKey(cursorKey).id : "";
  useTriage(store, (s) => s.latest.get(targetId));
  const own = store.state.latest.get(targetId);
  if (editing) return null;
  const secondary = "flex min-w-0 items-center justify-center gap-1 rounded border border-brand-muted/30 px-1.5 py-1.5 text-xs text-gray-700 hover:border-brand-light/40 disabled:opacity-50";
  return (
    <div className="mt-3">
      {own ? (
        <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
          <span>{t("decision.summary", { decision: t(DECISION_KEY[e.d.state]), user: own.userName, time: fmt.time(own.decidedAt) })}</span>
          <button type="button" onClick={actions.undo} className="text-brand hover:underline">
            {t("decision.undo")}
          </button>
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          <button type="button" title={t("actions.acceptTooltip")} onClick={() => actions.accept()} disabled={!e.s.proposal} className="flex min-w-0 items-center justify-center gap-1 rounded bg-brand px-1.5 py-1.5 text-xs font-medium text-white hover:bg-brand-light disabled:opacity-50">
            {t("actions.accept")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">A</kbd>
          </button>
          <button type="button" title={`${t("actions.change")} (E)`} onClick={() => store.setEditing(true)} disabled={!e.s.proposal} className={secondary}>
            {t("actions.change")} <Kbd>E</Kbd>
          </button>
          <button type="button" title={`${t("actions.reject")} (X)`} onClick={() => actions.reject()} className={secondary}>
            {t("actions.reject")} <Kbd>X</Kbd>
          </button>
          <button type="button" title={`${t("actions.postpone")} (S)`} onClick={() => actions.postpone()} className={secondary}>
            {t("actions.postpone")} <Kbd>S</Kbd>
          </button>
        </div>
      )}
      {hint && (
        <p role="status" className="mt-1.5 text-[11px] text-amber-800">
          {hint}
        </p>
      )}
    </div>
  );
}
