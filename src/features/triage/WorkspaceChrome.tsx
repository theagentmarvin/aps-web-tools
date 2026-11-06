/**
 * Workspace header (breadcrumb, test selector, progress, send CTA), banners,
 * selection bar and status bar (spec §3.1–3.3, §3.9, §4.5).
 */
import { useMemo } from "react";
import { useI18n, useT } from "~/i18n";
import type { Priority, Validity } from "~/lib/api/types";
import { Breadcrumbs } from "~/lib/components/PageHeader";
import { CopyCommand, useAgentStatus } from "~/lib/components/shell-widgets";
import { IconX } from "~/lib/components/icons";
import { Banner, Kbd, ProgressBar, inputCls } from "~/lib/components/ui";
import { DECISION_KEY, PRIORITY_KEY, VALIDITY_KEY, VALIDITY_ORDER } from "~/lib/labels";
import { latestDecisions } from "~/lib/api/decision-utils";
import { useTriageContext } from "./actions";
import { useTriage } from "./store";

/** Counts over the whole test (ignoring filters). */
export function useProgress() {
  const { store } = useTriageContext();
  const log = useTriage(store, (s) => s.log);
  const groups = useTriage(store, (s) => s.groups);
  const manual = useTriage(store, (s) => s.manual);
  const clashes = useTriage(store, (s) => s.clashes);
  return useMemo(() => {
    const latest = latestDecisions(log);
    const ids = manual ? [...clashes.keys()] : [...groups.keys()];
    const breakdown = { accepted: 0, corrected: 0, rejected: 0, postponed: 0 };
    let ready = 0;
    for (const id of ids) {
      const d = latest.get(id);
      if (!d) continue;
      if (d.kind === "accept") breakdown.accepted++;
      if (d.kind === "correct") breakdown.corrected++;
      if (d.kind === "reject") breakdown.rejected++;
      if (d.kind === "postpone") breakdown.postponed++;
      if (d.kind !== "postpone" && !d.batchId) ready++;
    }
    const done = breakdown.accepted + breakdown.corrected + breakdown.rejected;
    return { done, total: ids.length, ready, breakdown };
  }, [log, groups, clashes, manual]);
}

export function WorkspaceHeader({ onTestChange, onSend }: { onTestChange: (testId: string) => void; onSend: () => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store, actions } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const progress = useProgress();
  const agent = useAgentStatus();
  const inheritedCount = useTriage(store, (s) => s.rows.filter((r) => !r.nested && !s.latest.has(r.id) && s.proposals.get(r.id)?.inherited).length);
  if (!payload) return null;
  const tip = Object.entries(progress.breakdown)
    .map(([k, v]) => `${t(DECISION_KEY[k as keyof typeof DECISION_KEY])}: ${v}`)
    .join(" · ");

  return (
    <header className="flex flex-shrink-0 flex-wrap items-center gap-4 border-b border-brand-muted/20 bg-white px-4 py-2">
      <Breadcrumbs
        crumbs={[
          { label: t("nav.projects"), to: "/proyectos" },
          { label: payload.project.name, to: `/proyectos/${payload.project.id}` },
          { label: payload.modelSet.name },
        ]}
      />
      <label className="flex items-center gap-2 text-xs text-gray-500">
        {t("workspace.test")}
        <select className={`${inputCls} py-0.5 text-xs`} value={payload.test.id} onChange={(e) => onTestChange(e.target.value)}>
          {payload.tests.map((x) => (
            <option key={x.id} value={x.id}>
              {t("workspace.testOption", { date: fmt.date(x.completedOn), version: x.modelSetVersion, count: x.clashCount })} {x.analyzed ? t("workspace.analyzed") : ""}
            </option>
          ))}
        </select>
      </label>
      {agent?.running && <span className="rounded-full bg-brand-surface px-2 py-0.5 text-xs text-brand">{t("workspace.analyzing", { task: agent.currentTask ?? "" })}</span>}
      <div className="flex min-w-[180px] flex-col gap-0.5" title={tip}>
        <span className="text-xs text-gray-500">{t("workspace.progress", { done: progress.done, total: progress.total })}</span>
        <ProgressBar done={progress.done} total={progress.total} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        {inheritedCount > 0 && (
          <button type="button" onClick={actions.acceptInherited} className="rounded border border-brand-muted/30 px-2 py-1 text-xs text-gray-700 hover:text-brand">
            {t("workspace.acceptInherited", { count: inheritedCount })}
          </button>
        )}
        <button type="button" disabled={progress.ready === 0} onClick={onSend} title="Ctrl+Enter" className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50">
          {t("workspace.sendToApproval", { count: progress.ready })}
        </button>
      </div>
    </header>
  );
}

export function WorkspaceBanners() {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const pending = useTriage(store, (s) => s.pendingProposals.length);
  const pace = useTriage(store, (s) => s.paceNudge);
  if (!payload) return null;
  const ms = payload.modelSet;
  const newest = payload.tests[0];
  const staleVersion = ms.analyzedVersion !== undefined && ms.latestVersion > ms.analyzedVersion;
  const newerTest = newest && newest.id !== payload.test.id;
  return (
    <>
      {(staleVersion || newerTest) && (
        <Banner
          tone="warning"
          className="flex-shrink-0 border-x-0 border-t-0"
          actions={
            <>
              <CopyCommand text={ms.agentCommand} compact />
            </>
          }
        >
          {staleVersion ? t("stale.banner", { latest: ms.latestVersion, analyzed: ms.analyzedVersion ?? "" }) : t("stale.newerTest", { date: fmt.date(newest.completedOn) })}
        </Banner>
      )}
      {pending > 0 && (
        <Banner tone="info" className="flex-shrink-0 border-x-0 border-t-0" actions={<button type="button" onClick={() => store.applyProposalUpdates()} className="rounded border border-brand-light/40 bg-white px-2 py-0.5 text-xs">{t("workspace.refresh")}</button>}>
          {t("workspace.newProposals", { count: pending })}
        </Banner>
      )}
      {pace && (
        <Banner tone="warning" className="flex-shrink-0 border-x-0 border-t-0" actions={<button type="button" onClick={() => store.dismissPace()} className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs">{t("workspace.paceNudgeDismiss")}</button>}>
          {t("guard.paceNudge")}
        </Banner>
      )}
    </>
  );
}

export function SelectionBar() {
  const t = useT();
  const { store, actions } = useTriageContext();
  const count = useTriage(store, (s) => s.checked.size);
  const hasClashes = useTriage(store, (s) => [...s.checked].some((k) => k.startsWith("c:")));
  if (!count) return null;
  return (
    <div className="sticky bottom-0 flex flex-wrap items-center gap-1.5 border-t border-brand-muted/20 bg-white px-3 py-2 text-xs shadow-[0_-2px_6px_rgba(0,0,0,0.05)]">
      <span className="mr-1 font-medium text-gray-700">{t("list.selected", { count })}</span>
      <button type="button" onClick={actions.bulkAccept} className="rounded bg-brand px-2 py-1 text-white hover:bg-brand-light" title="Shift+A">
        {t("actions.acceptSelected")}
      </button>
      <select aria-label={t("actions.setPriority")} className={`${inputCls} py-0.5 text-xs`} value="" onChange={(e) => e.target.value && actions.bulkPriority(Number(e.target.value) as Priority)}>
        <option value="">{t("actions.setPriority")} ▾</option>
        {([1, 2, 3, 4] as const).map((p) => (
          <option key={p} value={p}>
            {t(PRIORITY_KEY[p])}
          </option>
        ))}
      </select>
      <select aria-label={t("actions.setValidity")} className={`${inputCls} py-0.5 text-xs`} value="" onChange={(e) => e.target.value && actions.bulkValidity(e.target.value as Validity)}>
        <option value="">{t("actions.setValidity")} ▾</option>
        {VALIDITY_ORDER.map((v) => (
          <option key={v} value={v}>
            {t(VALIDITY_KEY[v])}
          </option>
        ))}
      </select>
      <button type="button" onClick={actions.bulkReject} className="rounded border border-brand-muted/30 px-2 py-1 hover:text-brand" title="Shift+X">
        {t("actions.rejectSelected")}
      </button>
      <button type="button" onClick={actions.bulkPostpone} className="rounded border border-brand-muted/30 px-2 py-1 hover:text-brand">
        {t("actions.postpone")}
      </button>
      {hasClashes ? (
        <button type="button" onClick={actions.split} className="rounded border border-brand-muted/30 px-2 py-1 hover:text-brand">
          {t("actions.split")}
        </button>
      ) : (
        <button type="button" onClick={actions.merge} disabled={count < 2} className="rounded border border-brand-muted/30 px-2 py-1 hover:text-brand disabled:opacity-50">
          {t("actions.merge")}
        </button>
      )}
      <button type="button" onClick={() => store.clearChecks()} aria-label={t("list.clearSelection")} className="ml-auto rounded p-1 text-gray-500 hover:text-brand">
        <IconX />
      </button>
    </div>
  );
}

export function StatusBar() {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const session = useTriage(store, (s) => s.session);
  const save = useTriage(store, (s) => s.save);
  const viewer = useTriage(store, (s) => s.viewer);
  const decisions = session.filter((x) => x.kind !== "note" && x.kind !== "undo");
  const minutes = decisions.length > 1 ? (decisions[decisions.length - 1].at - decisions[0].at) / 60000 : 0;
  const rate = minutes > 0 ? decisions.length / minutes : 0;
  const dwells = decisions.map((d) => d.dwellMs).sort((a, b) => a - b);
  const median = dwells.length ? dwells[Math.floor(dwells.length / 2)] / 1000 : 0;
  const accepted = decisions.length ? decisions.filter((d) => d.kind === "accept").length / decisions.length : 0;
  const viewerText =
    viewer.status === "ready"
      ? t("viewer.ready", { loaded: viewer.loaded, total: viewer.total })
      : viewer.status === "loading"
        ? t("viewer.loadingModels", { loaded: viewer.loaded, total: viewer.total })
        : viewer.status === "failed"
          ? t("viewer.initFailed")
          : viewer.status === "init"
            ? t("viewer.initializing")
            : t("viewer.placeholderTitle");
  return (
    <footer className="flex flex-shrink-0 items-center gap-4 border-t border-brand-muted/20 bg-white/80 px-4 py-1 text-xs text-gray-500">
      <span>
        {t("session.decisions", { count: decisions.length })} · {t("session.rate", { value: fmt.number(rate, 1) })} · {t("session.medianDwell", { value: fmt.number(median, 1) })} · {t("session.accepted", { pct: fmt.pct(accepted) })}
      </span>
      <span className="flex items-center gap-1">
        {save.status === "failed" ? (
          <>
            <span className="text-red-700">{t("save.failed", { count: save.failed })}</span>
            <button type="button" onClick={() => store.retrySave()} className="text-brand underline">
              {t("save.retry")}
            </button>
          </>
        ) : save.status === "saving" ? (
          t("save.saving")
        ) : save.status === "saved" ? (
          <>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green-600" />
            {t("save.saved")}
          </>
        ) : null}
      </span>
      <span>{viewerText}</span>
      <button type="button" onClick={() => store.setDialog({ type: "shortcuts" })} className="ml-auto inline-flex items-center gap-1 hover:text-brand">
        <Kbd>?</Kbd> {t("shortcuts.open").replace(/^\?\s*/, "")}
      </button>
    </footer>
  );
}
