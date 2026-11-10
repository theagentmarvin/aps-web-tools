/**
 * Workspace chrome: context in the app header (breadcrumb, test selector), the
 * right part of the single toolbar (status, progress, Analizar, "⋯", send CTA),
 * selection bar and status bar (spec §3.1–3.3, §3.9, §4.5).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useIngest } from "~/features/modelset/useIngest";
import { useToast } from "~/lib/components/Toast";
import { IconChevronDown, IconInherited, IconMore, IconRefresh, IconSparkle, Spinner } from "~/lib/components/icons";
import { useI18n, useT, type TKey } from "~/i18n";
import type { Priority, Validity } from "~/lib/api/types";
import { useAgentStatus } from "~/lib/components/shell-widgets";
import { IconX } from "~/lib/components/icons";
import { Kbd, ProgressBar, inputCls } from "~/lib/components/ui";
import { DECISION_KEY, PRIORITY_KEY, VALIDITY_KEY, VALIDITY_ORDER, VALIDITY_TIP } from "~/lib/labels";
import { latestDecisions } from "~/lib/api/decision-utils";
import { useTriageContext } from "./actions";
import { computeProgress } from "./progress";
import { StatusLine } from "./StatusLine";
import { useTriage } from "./store";

/** Counts over the whole test (ignoring filters). */
export function useProgress() {
  const { store } = useTriageContext();
  const log = useTriage(store, (s) => s.log);
  const groups = useTriage(store, (s) => s.groups);
  const manual = useTriage(store, (s) => s.manual);
  const clashes = useTriage(store, (s) => s.clashes);
  const families = useTriage(store, (s) => s.families);
  return useMemo(
    () => computeProgress({ ids: manual ? [...clashes.keys()] : [...groups.keys()], latest: latestDecisions(log), families: families.values(), manual }),
    [log, groups, clashes, manual, families],
  );
}

/** True while the media query matches (e.g. the 1366 px toolbar overflow breakpoint). */
export function useMediaQuery(q: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const update = () => setOn(m.matches);
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, [q]);
  return on;
}

/** The toolbar moves Orden / Vistas / Analizar into "⋯" at 1366 px and below (it never wraps). */
export const TOOLBAR_COMPACT_QUERY = "(max-width: 1366px)";

/** Where the workspace context lives inside the app header (rendered by Nav on the workspace route only). */
export const NAV_SLOT_ID = "nav-workspace-slot";

/**
 * Workspace context inside the main app header: compact breadcrumb
 * "Proyecto › Conjunto de modelos" (truncated, full text in the tooltip) and
 * the test selector as a compact "v11 · 14-09" dropdown (the native select is
 * kept for keyboard and screen readers, drawn over a short label).
 */
export function WorkspaceNavContext({ onTestChange }: { onTestChange: (testId: string) => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(NAV_SLOT_ID)), []);
  if (!payload || !slot) return null;
  const full = `${payload.project.name} › ${payload.modelSet.name}`;
  const cur = payload.tests.find((x) => x.id === payload.test.id);
  const short = (d: string) => fmt.date(d).slice(0, 5);
  const label = cur ? `v${cur.modelSetVersion} · ${short(cur.completedOn)}` : t("workspace.test");
  return createPortal(
    <>
      <nav aria-label="breadcrumb" title={full} className="flex min-w-0 items-center gap-1 text-xs text-gray-500">
        <span aria-hidden className="text-gray-300">|</span>
        <Link to={`/proyectos/${payload.project.id}`} className="min-w-0 max-w-[16rem] truncate hover:text-brand">
          {payload.project.name}
        </Link>
        <span aria-hidden>›</span>
        <span aria-current="page" className="min-w-0 max-w-[16rem] truncate text-gray-700">
          {payload.modelSet.name}
        </span>
      </nav>
      <span
        className="relative inline-flex flex-shrink-0 items-center gap-1 rounded border border-brand-muted/30 px-2 py-0.5 text-xs text-gray-700 hover:border-brand"
        title={cur ? `${t("workspace.test")}: ${t("workspace.testOption", { date: fmt.date(cur.completedOn), version: cur.modelSetVersion, count: cur.clashCount })}` : undefined}
      >
        <span className="whitespace-nowrap font-medium">{label}</span>
        <IconChevronDown size={11} />
        <select aria-label={t("workspace.test")} className="absolute inset-0 cursor-pointer opacity-0" value={payload.test.id} onChange={(e) => onTestChange(e.target.value)}>
          {payload.tests.map((x) => (
            <option key={x.accTestId} value={x.id} disabled={!x.cached}>
              {x.cached
                ? `${t("workspace.testOption", { date: fmt.date(x.completedOn), version: x.modelSetVersion, count: x.clashCount })} ${x.analyzed ? t("workspace.analyzed") : ""}`
                : `${fmt.date(x.completedOn)} · v${x.modelSetVersion} · ${t("modelSets.notCached")}`}
            </option>
          ))}
        </select>
      </span>
    </>,
    slot,
  );
}

/**
 * Right part of the single workspace toolbar: status chip · "Preparado por el
 * agente" (icon + tooltip) · review progress · Analizar · "⋯" · Enviar a
 * aprobación (primary, right-most). `overflow` holds the items the left part
 * moves into "⋯" when compact (Orden, Vistas).
 */
export function WorkspaceActions({
  onTestChange,
  onSend,
  compact,
  overflow,
}: {
  onTestChange: (testId: string) => void;
  onSend: () => void;
  compact: boolean;
  overflow?: (close: () => void) => ReactNode;
}) {
  const t = useT();
  const { fmt } = useI18n();
  const { store, actions } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const progress = useProgress();
  const agent = useAgentStatus();
  const preparedAt = usePreparedAt();
  const rightTab = useTriage(store, (s) => s.rightTab);
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const uncached = payload?.tests.find((x) => !x.cached);
  const ingest = useIngest(payload?.project.id ?? "", payload?.modelSet.id ?? "", {
    onDone: (_acc, testKey) => {
      toast.show(t("modelSets.analyzed", { version: uncached?.modelSetVersion ?? "" }));
      if (testKey) onTestChange(testKey);
    },
    onError: (_acc, err) => toast.show(t("ingest.failed", { error: err }), { tone: "error" }),
  });
  const job = uncached ? ingest.jobs[uncached.accTestId] : undefined;
  const ingesting = !!job && job.phase !== "done" && job.phase !== "failed";
  function analyze() {
    if (uncached) void ingest.start(uncached.accTestId);
  }
  const inheritedCount = useTriage(store, (s) => s.rows.filter((r) => !r.nested && !s.latest.has(r.id) && s.proposals.get(r.id)?.inherited).length);
  if (!payload) return null;
  const tip = [
    t("workspace.progress", { done: progress.done, total: progress.total }),
    ...Object.entries(progress.breakdown).map(([k, v]) => `${t(k === "family" ? "workspace.familyDecided" : DECISION_KEY[k as keyof typeof DECISION_KEY])}: ${v}`),
  ].join("\n");
  const analyzeLabel = `${t("modelSets.analyze")} v${uncached?.modelSetVersion ?? ""}`;
  const close = () => setMenu(false);
  const item = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-brand-surface disabled:opacity-50";
  const prepared = preparedAt ? t("header.preparedBy", { time: fmt.time(preparedAt) }) : "";

  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {/* One slim status chip (scope / stale / new proposals / pace). */}
      <div className="flex min-w-[7rem] max-w-[24rem] flex-1">
        <StatusLine />
      </div>
      {agent?.running && (
        <span className="max-w-[10rem] truncate whitespace-nowrap rounded-full bg-brand-surface px-2 py-0.5 text-xs text-brand" title={t("workspace.analyzing", { task: agent.currentTask ?? "" })}>
          {t("workspace.analyzing", { task: agent.currentTask ?? "" })}
        </span>
      )}
      {preparedAt && (
        <span
          role="img"
          tabIndex={0}
          aria-label={prepared}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-violet-700 hover:bg-violet-50"
          title={[prepared, t("header.preparedTip"), payload.accSync ? t("header.accSync", { time: fmt.time(payload.accSync.at), assigned: payload.accSync.assignedGroups, closed: payload.accSync.closedGroups }) : ""].filter(Boolean).join("\n")}
        >
          <IconSparkle size={14} />
        </span>
      )}
      <div className="flex w-20 flex-col gap-1" title={tip}>
        <span className="whitespace-nowrap text-center font-mono text-[11px] leading-none text-gray-600">
          {progress.done}/{progress.total}
        </span>
        <ProgressBar done={progress.done} total={progress.total} className="!h-1" />
      </div>
      {ingesting && job ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-gray-600">
          <Spinner />
          {t(`ingest.phase.${job.phase}` as TKey)} {Math.round(job.progress * 100)} %
        </span>
      ) : (
        uncached &&
        !compact && (
          <button type="button" onClick={analyze} title={analyzeLabel} aria-label={analyzeLabel} className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded border border-brand-muted/30 px-1.5 text-xs text-gray-700 hover:text-brand">
            <IconRefresh size={13} />v{uncached.modelSetVersion}
          </button>
        )
      )}
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={t("toolbar.more")}
          title={t("toolbar.more")}
          onClick={() => setMenu((o) => !o)}
          className="relative inline-flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-brand-surface hover:text-brand"
        >
          <IconMore size={16} />
          {(inheritedCount > 0 || (compact && uncached && !ingesting)) && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-brand" />}
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 top-9 z-40 w-64 rounded-lg border border-brand-muted/20 bg-white py-1 shadow-lg" onKeyDown={(e) => e.key === "Escape" && close()}>
            {compact && overflow?.(close)}
            {compact && uncached && !ingesting && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  analyze();
                  close();
                }}
                className={item}
              >
                <IconRefresh size={14} />
                {analyzeLabel}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                store.toggleRightTab();
                close();
              }}
              className={item}
            >
              <span className="flex-1">{rightTab === "agent" ? t("chat.tabDetail") : t("chat.tabAgent")}</span>
              <Kbd>Shift+C</Kbd>
            </button>
            {inheritedCount > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  actions.acceptInherited();
                  close();
                }}
                className={item}
              >
                <IconInherited size={14} />
                {t("workspace.acceptInherited", { count: inheritedCount })}
              </button>
            )}
          </div>
        )}
      </div>
      <button type="button" disabled={progress.ready === 0} onClick={onSend} title="Ctrl+Enter" className="whitespace-nowrap rounded-lg bg-brand px-3 py-1 text-sm font-medium text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50">
        {t("workspace.sendToApproval", { count: progress.ready })}
      </button>
    </div>
  );
}

/** "Preparado por el agente · hh:mm": newest of the agent's last activity and the newest proposal. */
function usePreparedAt(): string | null {
  const { store } = useTriageContext();
  const agent = useAgentStatus();
  const proposals = useTriage(store, (s) => s.proposals);
  let latest = agent?.lastActivityAt ?? null;
  for (const p of proposals.values()) {
    const at = p.updatedAt ?? p.createdAt;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
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
          <option key={v} value={v} title={t(VALIDITY_TIP[v])}>
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
