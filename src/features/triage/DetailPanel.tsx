/**
 * Detail / AI reasoning pane (spec §3.7) with the sticky decision bar.
 */
import { useEffect, useState } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import { band } from "~/lib/api/decision-utils";
import type { Calibration, IssueDraft } from "~/lib/api/types";
import { FlaggedChip, NatureBadge, SeverityLabel, SpotCheckChip } from "~/lib/components/badges";
import { IconChevronLeft, IconChevronRight } from "~/lib/components/icons";
import { EmptyState, Kbd, Skeleton } from "~/lib/components/ui";
import { DECISION_KEY } from "~/lib/labels";
import { useTriageContext } from "./actions";
import { ChangeSinceLastTest, EvidenceSection, HistoryTimeline, IssueDraftEditor, ProposalCard, RationaleBlock } from "./detail-sections";
import { parseKey, useTriage } from "./store";

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

export function DetailSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-busy="true">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-24" />
      <Skeleton className="h-20" />
      <Skeleton className="h-28" />
    </div>
  );
}

export function DetailPanel() {
  const t = useT();
  const { store } = useTriageContext();
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  const rows = useTriage(store, (s) => s.rows);
  const log = useTriage(store, (s) => s.log);
  useTriage(store, (s) => s.latest);
  useTriage(store, (s) => s.proposals);
  const issueEdits = useTriage(store, (s) => (cursorKey ? s.edits.get(cursorKey.slice(2))?.issue : undefined));
  const calibration = useCalibrationText();

  if (!cursorKey) return <EmptyState title={t("detail.noSelection")} />;
  const { kind, id } = parseKey(cursorKey);
  const e = store.evaluate(kind, id);
  if (!e) return <EmptyState title={t("detail.noSelection")} />;

  const groupId = e.s.group?.id ?? e.s.clash?.groupId ?? "";
  const members = kind === "group" ? (store.state.clashesByGroup.get(id) ?? []) : e.s.clash ? [e.s.clash] : [];
  const proposal = e.s.proposal;
  const decision = store.decisionFor(kind, id);
  const decisions = log.filter((d) => d.targetId === id || (kind === "clash" && d.targetId === groupId));
  const topRows = rows.filter((r) => !r.nested);
  const pos = topRows.findIndex((r) => r.key === cursorKey || (r.kind === "group" && r.id === groupId));
  const title = e.s.group?.title ?? `${e.s.clash?.a.name} ↔ ${e.s.clash?.b.name}`;
  const showIssue = !!proposal?.issueDraft || !!issueEdits || !!(proposal && e.d.state === "corrected" && decision?.changes.some((c) => c.field === "action"));
  const baseDraft: IssueDraft | undefined =
    proposal?.issueDraft ??
    (issueEdits
      ? {
          title: title.slice(0, 120),
          description: "",
          ownerDiscipline: e.d.owner ?? e.s.group?.pair[1] ?? "",
          dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          includeView: true,
          linkClashIds: members.slice(0, 10).map((c) => c.id),
        }
      : undefined);
  const defaultOpen = e.d.confidence === null || band(e.d.confidence, store.state.thresholds) !== "alta";

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex-shrink-0 border-b border-brand-muted/20 px-4 py-3">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{kind === "group" ? t("detail.group", { current: pos + 1, total: topRows.length }) : t("detail.clash", { current: pos + 1, total: topRows.length })}</span>
          <span className="flex gap-1">
            <button type="button" aria-label={t("shortcuts.prev")} title={`${t("shortcuts.prev")} (K)`} onClick={() => store.move(-1)} className="rounded p-1 hover:bg-brand-surface">
              <IconChevronLeft />
            </button>
            <button type="button" aria-label={t("shortcuts.next")} title={`${t("shortcuts.next")} (J)`} onClick={() => store.move(1)} className="rounded p-1 hover:bg-brand-surface">
              <IconChevronRight />
            </button>
          </span>
        </div>
        <h2 className="mt-1 text-sm font-semibold text-gray-900" lang="es">
          {title}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-gray-400">
          <span>{kind === "group" ? id : e.s.clash?.id}</span>
          <span>· {t("list.clashesCount", { count: members.length || 1 })}</span>
          {e.s.level && <span>· {e.s.level}</span>}
          {proposal?.spotCheck && <SpotCheckChip />}
          {proposal?.flagged && <FlaggedChip />}
          {e.s.group && <NatureBadge value={e.s.group.nature} />}
        </p>
        {e.s.group && (
          <p className="mt-0.5 text-xs text-gray-500">
            {t("severity.label")}: <SeverityLabel value={e.s.group.severity} />
          </p>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" id="triage-detail" tabIndex={-1}>
        {kind === "group" && e.s.group?.reviewState === "needs_review" && <ReviewReasons testId={e.s.group.testId} groupId={id} />}
        <EvidenceSection e={e} members={members} />
        {proposal ? (
          <>
            <ProposalCard proposal={proposal} decision={decision} calibration={calibration} />
            <RationaleBlock proposal={proposal} defaultOpen={defaultOpen} />
          </>
        ) : (
          <p className="border-t border-brand-muted/20 px-4 py-4 text-sm text-gray-500">{t("detail.noProposal")}</p>
        )}
        <ChangeSinceLastTest e={e} members={members} />
        {showIssue && baseDraft && <IssueDraftEditor targetId={id} draft={baseDraft} onPin={pinView} />}
        <HistoryTimeline proposal={proposal} decisions={decisions} members={members} />
      </div>
      <DecisionBar targetId={id} />
    </div>
  );
}

function DecisionBar({ targetId }: { targetId: string }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store, actions } = useTriageContext();
  const hint = useTriage(store, (s) => s.hint);
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  useTriage(store, (s) => s.latest.get(targetId));
  const kind = cursorKey ? parseKey(cursorKey).kind : "group";
  const own = store.state.latest.get(targetId);
  const e = store.evaluate(kind, targetId);
  const secondary = "flex items-center justify-center gap-1 rounded border border-brand-muted/30 px-2 py-1.5 text-xs text-gray-700 hover:border-brand-light/40";

  return (
    <div className="sticky bottom-0 flex-shrink-0 border-t border-brand-muted/20 bg-white p-3">
      {hint && (
        <p role="status" className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {hint}
        </p>
      )}
      {own && e ? (
        <p className="flex items-center justify-between text-xs text-gray-600">
          <span>{t("decision.summary", { decision: t(DECISION_KEY[e.d.state]), user: own.userName, time: fmt.time(own.decidedAt) })}</span>
          <button type="button" onClick={actions.undo} className="text-brand hover:underline">
            {t("decision.undo")}
          </button>
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          <button type="button" title={t("actions.acceptTooltip")} onClick={() => actions.accept()} disabled={!e?.s.proposal} className="flex items-center justify-center gap-1 rounded bg-brand px-2 py-1.5 text-xs font-medium text-white hover:bg-brand-light disabled:opacity-50">
            {t("actions.accept")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">A</kbd>
          </button>
          <button type="button" title={`${t("actions.edit")} (E)`} onClick={() => store.setEditing(true)} disabled={!e?.s.proposal} className={`${secondary} disabled:opacity-50`}>
            {t("actions.edit")} <Kbd>E</Kbd>
          </button>
          <button type="button" title={`${t("actions.reject")} (X)`} onClick={() => actions.reject()} className={secondary}>
            {t("actions.reject")} <Kbd>X</Kbd>
          </button>
          <button type="button" title={`${t("actions.postpone")} (S)`} onClick={() => actions.postpone()} className={secondary}>
            {t("actions.postpone")} <Kbd>S</Kbd>
          </button>
        </div>
      )}
    </div>
  );
}

/** Server review reasons (GroupDetail.reviewReasons), fetched after the cursor settles. */
function ReviewReasons({ testId, groupId }: { testId: string; groupId: string }) {
  const t = useT();
  const api = useApi();
  const [reasons, setReasons] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    setReasons([]);
    const id = window.setTimeout(() => {
      api.getGroup(testId, groupId).then(
        (d) => alive && setReasons(d.reviewReasons ?? []),
        () => undefined,
      );
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [api, testId, groupId]);
  if (!reasons.length) return null;
  return (
    <section className="mx-4 mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" aria-label={t("detail.reviewReasons")}>
      <p className="font-medium">{t("detail.reviewReasons")}</p>
      <ul className="mt-1 list-disc pl-4">
        {reasons.map((r) => (
          <li key={r} lang="es">
            {r}
          </li>
        ))}
      </ul>
    </section>
  );
}
