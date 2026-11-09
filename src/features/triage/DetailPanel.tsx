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
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import { band, minConfidence } from "~/lib/api/decision-utils";
import type { Calibration, DecisionChange, ElementInfo, IssueDraft, Nature, Proposal, Validity } from "~/lib/api/types";
import { categoryNoun, categoryTitle } from "~/lib/category-names";
import { ConfidenceBadge, FlaggedChip, NatureBadge, PriorityChip, ReasonChip, SpotCheckChip, ValidityBadge } from "~/lib/components/badges";
import { IconChevronDown, IconChevronLeft, IconChevronRight, SideASwatch, SideBSwatch } from "~/lib/components/icons";
import { EmptyState, Kbd, Skeleton } from "~/lib/components/ui";
import { DECISION_KEY } from "~/lib/labels";
import { readJson, writeJson } from "~/lib/storage";
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
import type { Evaluated } from "./filters";
import { oneLine, summarizePair, type PairSummary, type SideFacts } from "./pair-summary";
import { parseKey, useTriage } from "./store";

// ── Persisted accordion state ──────────────────────────────────────

type SectionId = "elements" | "clashes" | "reasoning" | "changes" | "properties" | "issue" | "history";
const SECTIONS_KEY = "coord.detail.sections";

function useSectionPrefs() {
  const [prefs, setPrefs] = useState<Partial<Record<SectionId, boolean>>>(() => readJson(SECTIONS_KEY, {}));
  const set = useCallback((id: SectionId, open: boolean) => {
    setPrefs((p) => {
      const next = { ...p, [id]: open };
      writeJson(SECTIONS_KEY, next);
      return next;
    });
  }, []);
  return { prefs, set };
}

function Section({ id, title, open, onToggle, children }: { id: SectionId; title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="border-t border-brand-muted/20" aria-labelledby={`dsec-${id}-h`}>
      <h3 id={`dsec-${id}-h`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`dsec-${id}`}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50"
        >
          <span className="truncate">{title}</span>
          <IconChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </h3>
      {open && (
        <div id={`dsec-${id}`} className="min-w-0 px-4 pb-3">
          {children}
        </div>
      )}
    </section>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function useCalibrationText() {
  const api = useApi();
  const t = useT();
  const { fmt } = useI18n();
  const { data } = useAsync<Calibration>(() => api.getCalibration(), [api]);
  return (c: number): string | undefined => {
    if (!data) return undefined;
    const b = data.bands.find((x) => x.band === band(c, data.thresholds));
    if (!b || b.proposals < data.minDecisions) return t("confidence.uncalibrated", { min: data.minDecisions });
    return t("confidence.calibrated", { count: b.proposals, pct: fmt.pct(b.acceptedUnchanged / b.proposals) });
  };
}

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

export function DetailPanel() {
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
          <FamilyChip />
          <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-gray-400">
            {kind === "group" ? id : e.s.clash?.id.slice(-8)} · {t("list.clashesCount", { count: clashCount })}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" id="triage-detail" tabIndex={-1}>
        <ProposalBlock e={e} proposal={proposal} decisionChanges={decision?.kind === "correct" ? decision.changes : []} reasonCode={decision?.reasonCode} calibration={calibration} onSeeReasoning={openReasoning} />

        {pair && (
          <section aria-label={t("detail.evidence")} className="space-y-0.5 px-4 py-3 text-xs">
            <EvidenceLine side="a" text={stripText(pair.a, lang)} more={pair.a.elements.length - 1} />
            <EvidenceLine side="b" text={stripText(pair.b, lang)} more={pair.b.elements.length - 1} />
          </section>
        )}

        <div className="mt-1">
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
          {hasChanges(e, members) && (
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

/** Placeholder for the solution-family chip (BIM "solution families", not implemented yet). */
function FamilyChip({ family }: { family?: { name: string; count: number } }) {
  const t = useT();
  if (!family) return null;
  return <span className="rounded-full border border-slate-200 bg-slate-50 px-2 text-[11px] leading-5 text-slate-700">{t("detail.family", { name: family.name, count: family.count })}</span>;
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
  return (
    <section aria-labelledby="dp-proposal" className="mx-4 mt-3 rounded-lg border border-brand-muted/30 bg-white p-3">
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
