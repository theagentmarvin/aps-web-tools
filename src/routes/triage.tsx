/**
 * Triage workspace /coordinacion/:projectId/:modelSetId (spec §3).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useT } from "~/i18n";
import { ApiError, useApi, useAsync } from "~/lib/api";
import { TestList } from "./project";
import { LAST_WORKSPACE_KEY } from "./projects";
import type { TriagePayload } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { CopyCommand } from "~/lib/components/shell-widgets";
import { useToast } from "~/lib/components/Toast";
import { Button, EmptyState, ErrorState, Kbd, SkeletonRows } from "~/lib/components/ui";
import { useSettings } from "~/lib/settings";
import { readJson, writeJson } from "~/lib/storage";
import { TriageContext, useCreateActions, useTriageContext } from "~/features/triage/actions";
import { ClashViewerPane } from "~/features/triage/ClashViewerPane";
import { DetailPanel, DetailSkeleton } from "~/features/triage/DetailPanel";
import { WorkspaceDialogs } from "~/features/triage/dialogs";
import { FilterBar } from "~/features/triage/FilterBar";
import { isDefaultQuery, parseQuery, writeQuery, type ListQuery } from "~/features/triage/filters";
import { GroupList } from "~/features/triage/GroupList";
import { LensBar } from "~/features/triage/LensBar";
import { ChatPanel } from "~/features/triage/ChatPanel";
import { PrintAgenda, printAgenda } from "~/features/triage/MeetingViews";
import { TriageStore, rowKey, useTriage } from "~/features/triage/store";
import { useTriageHotkeys } from "~/features/triage/useTriageHotkeys";
import { SelectionBar, StatusBar, WorkspaceHeader, useProgress } from "~/features/triage/WorkspaceChrome";

interface LayoutPrefs {
  list: number;
  detail: number;
}

export function TriageWorkspace() {
  const t = useT();
  const api = useApi();
  const { projectId = "", modelSetId = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const testParam = sp.get("test") ?? undefined;
  const query = useMemo(() => parseQuery(sp), [sp]);
  const store = useMemo(() => new TriageStore(api, query), [api, projectId, modelSetId]); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useCreateActions(store);
  const { settings } = useSettings();
  const { data, error, loading, reload } = useAsync<TriagePayload>(() => api.getTriage(projectId, modelSetId, testParam), [api, projectId, modelSetId, testParam]);
  const [manualOk, setManualOk] = useState(false);
  const pendingIssueCursor = useRef<string | null>(null);

  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => store.setThresholds(settings.thresholds), [store, settings.thresholds]);
  useEffect(() => {
    api.getCurrentUser().then((u) => store.setUser(u), () => undefined);
  }, [api, store]);

  // Payload → store; restore ?group= / ?clash= cursor.
  useEffect(() => {
    if (!data) return;
    store.load(data);
    const g = sp.get("group");
    const c = sp.get("clash");
    const f = sp.get("grupo") ?? sp.get("family");
    if (c && store.state.clashes.has(c)) {
      const gid = store.state.clashes.get(c)!.groupId;
      if (store.state.query.view !== "clashes" && gid) store.toggleExpand(gid, true);
      store.reveal(rowKey("clash", c));
    } else if (g && store.state.groups.has(g)) {
      store.reveal(rowKey("group", g));
    } else if (f && store.state.families.has(f)) {
      store.reveal(`f:${f}`);
    }
    // ?incidencia= is restored once the issue checks arrive.
    pendingIssueCursor.current = sp.get("incidencia");
    // Setting "Aceptar decisiones heredadas automáticamente" (default off in v1).
    if (settings.autoAcceptInherited) actions.acceptInherited();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, store]);

  // Remember this coordinación for "Continuar donde quedaste" on Proyectos.
  useEffect(() => {
    if (!data) return;
    writeJson(LAST_WORKSPACE_KEY, { url: `/coordinacion/${projectId}/${modelSetId}?test=${encodeURIComponent(data.test.id)}`, label: `${data.project.name} / ${data.modelSet.name}` });
  }, [data, projectId, modelSetId]);

  // M3 (read-only): ACC issue checks + reminders for the "Incidencias" lens. Absent endpoint = lens disabled.
  useEffect(() => {
    if (!data) return;
    let alive = true;
    api.getIssueChecks(data.test.id).then(
      (p) => {
        if (!alive) return;
        store.setIssueChecks(p.checks, p.version);
        const inc = pendingIssueCursor.current;
        pendingIssueCursor.current = null;
        if (inc && store.state.rows.some((r) => r.key === `i:${inc}`)) store.setCursor(`i:${inc}`);
      },
      () => undefined,
    );
    api.getReminders(data.test.id).then(
      (p) => alive && store.setReminders(p.reminders),
      () => undefined,
    );
    // M4: meeting agenda and notes. Absent endpoint = lens disabled.
    api.getAgenda(data.test.id).then(
      (p) => alive && store.setAgenda(p.disciplines),
      () => undefined,
    );
    api.getNotes(data.test.id).then(
      (p) => alive && store.setNotes(p.notes),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, data, store]);

  // URL → store query.
  useEffect(() => {
    if (JSON.stringify(query) !== JSON.stringify(store.state.query)) store.setQuery(query);
  }, [query, store]);

  const onQueryChange = useCallback(
    (q: ListQuery) => {
      setSp((prev) => writeQuery(new URLSearchParams(prev), q), { replace: true });
    },
    [setSp],
  );

  // Cursor → URL (?group / ?clash), without re-rendering the route.
  useEffect(() => {
    let timer = 0;
    return store.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const key = store.state.cursorKey;
        const url = new URL(window.location.href);
        url.searchParams.delete("group");
        url.searchParams.delete("clash");
        url.searchParams.delete("family");
        url.searchParams.delete("grupo");
        url.searchParams.delete("incidencia");
        if (key && !key.startsWith("n:")) url.searchParams.set(key.startsWith("g:") ? "group" : key.startsWith("f:") ? "grupo" : key.startsWith("i:") ? "incidencia" : "clash", key.slice(2));
        if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
      }, 400);
    });
  }, [store]);

  // Live updates: poll for proposals changed by the agent (never auto-reorder).
  useEffect(() => {
    if (!data) return;
    let cursor = data.changesCursor;
    const id = window.setInterval(() => {
      api.getTriageChanges(projectId, modelSetId, data.test.id, cursor).then(
        (res) => {
          cursor = res.cursor;
          store.queueProposalUpdates(res.proposals);
        },
        () => undefined,
      );
    }, 10000);
    return () => window.clearInterval(id);
  }, [api, data, projectId, modelSetId, store]);

  const ctx = useMemo(() => ({ store, actions }), [store, actions]);

  if (error instanceof ApiError && error.serverCode === "not_ingested")
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState title={t("workspace.notCachedTitle")} body={error.hint} />
        <div className="rounded-lg border border-brand-muted/20 bg-white px-4 pb-3">
          <TestList projectId={projectId} modelSetId={modelSetId} onChanged={reload} />
        </div>
      </div>
    );
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <TriageContext.Provider value={ctx}>
      <Workspace
        loading={loading || !data}
        manualOk={manualOk}
        onManual={() => setManualOk(true)}
        onTestChange={(testId) => setSp((prev) => {
          const next = new URLSearchParams(prev);
          next.set("test", testId);
          next.delete("group");
          next.delete("clash");
          return next;
        })}
        onReload={reload}
        onQueryChange={onQueryChange}
        query={query}
      />
      <div id="triage-live" aria-live="polite" className="sr-only" />
      {loading && <span className="sr-only">{t("workspace.loading")}</span>}
    </TriageContext.Provider>
  );
}

interface WorkspaceProps {
  loading: boolean;
  manualOk: boolean;
  onManual: () => void;
  onTestChange: (id: string) => void;
  onReload: () => void;
  onQueryChange: (q: ListQuery) => void;
  query: ListQuery;
}

function Workspace({ loading, manualOk, onManual, onTestChange, onReload, onQueryChange, query }: WorkspaceProps) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const { store } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const manual = useTriage(store, (s) => s.manual);
  const collapsed = useTriage(store, (s) => s.detailCollapsed);
  const rightTab = useTriage(store, (s) => s.rightTab);
  const [chatMounted, setChatMounted] = useState(rightTab === "agent");
  useEffect(() => {
    if (rightTab === "agent") setChatMounted(true);
  }, [rightTab]);
  const progress = useProgress();
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [layout, setLayout] = useState<LayoutPrefs>(() => ({ list: 380, detail: 400, ...readJson<Partial<LayoutPrefs>>("coord.layout", {}) }));
  const narrow = useNarrow(1280);

  useTriageHotkeys({ onSend: () => progress.ready > 0 && setSendOpen(true) });

  function resize(which: "list" | "detail", value: number) {
    const [min, max] = which === "list" ? [300, 600] : [340, 560];
    const next = { ...layout, [which]: Math.max(min, Math.min(max, value)) };
    setLayout(next);
    writeJson("coord.layout", { ...readJson<object>("coord.layout", {}), ...next });
  }

  async function send() {
    if (!payload) return;
    setSending(true);
    try {
      await store.flushSave();
      const batch = await api.sendToApproval({ projectId: payload.project.id, modelSetId: payload.modelSet.id, testId: payload.test.id });
      setSendOpen(false);
      toast.show(t("workspace.sentToApproval", { count: progress.ready, batch: batch.id }), {
        action: { label: t("workspace.viewBatch"), onClick: () => navigate(`/aprobaciones/${batch.id}`) },
        durationMs: 8000,
      });
      onReload();
    } catch (err) {
      toast.show(String(err instanceof Error ? err.message : err), { tone: "error" });
    } finally {
      setSending(false);
    }
  }

  const showNoAnalysis = !loading && manual && !manualOk;

  return (
    <div className="flex h-full flex-col">
      {loading || !payload ? <div className="h-11 flex-shrink-0 border-b border-brand-muted/20 bg-white" /> : <WorkspaceHeader onTestChange={onTestChange} onSend={() => setSendOpen(true)} />}
      {!loading && !showNoAnalysis && <FilterBar query={query} onChange={onQueryChange} />}
      <div className="relative flex min-h-0 flex-1">
        <a href="#triage-list" className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:bg-white focus:px-2">
          {t("a11y.skipToList")}
        </a>
        <a href="#triage-detail" className="sr-only focus:not-sr-only focus:absolute focus:left-40 focus:z-20 focus:bg-white focus:px-2">
          {t("a11y.skipToDetail")}
        </a>
        <section style={{ width: layout.list }} className="flex flex-shrink-0 flex-col border-r border-brand-muted/20 bg-white">
          {loading ? (
            <SkeletonRows />
          ) : showNoAnalysis ? (
            <NoAnalysis command={payload?.modelSet.agentCommand ?? ""} onManual={onManual} />
          ) : (
            <ListArea onQueryChange={onQueryChange} onClear={() => onQueryChange({ ...query, filters: { decision: ["pendiente"] }, q: "", docs: undefined })} onSend={() => setSendOpen(true)} readyCount={progress.ready} />
          )}
        </section>
        <ResizeHandle label={t("workspace.resizeList")} value={layout.list} onChange={(v) => resize("list", v)} />
        <ClashViewerPane />
        {collapsed ? (
          <button type="button" onClick={() => store.toggleDetail()} title={`${t("detail.expand")} (\\)`} aria-label={t("detail.expand")} className="w-10 flex-shrink-0 border-l border-brand-muted/20 bg-white text-xs text-gray-500 hover:text-brand">
            ‹
          </button>
        ) : (
          <>
            {!narrow && <ResizeHandle label={t("workspace.resizeDetail")} value={layout.detail} onChange={(v) => resize("detail", v)} invert />}
            <aside style={{ width: layout.detail }} className={`flex flex-shrink-0 flex-col border-l border-brand-muted/20 bg-white ${narrow ? "absolute inset-y-0 right-0 z-20 shadow-xl" : ""}`}>
              <RightTabs />
              <div className={`min-h-0 flex-1 flex-col ${rightTab === "detail" ? "flex" : "hidden"}`}>{loading ? <DetailSkeleton /> : <DetailPanel />}</div>
              {/* Mounted once opened and kept: switching tabs keeps the chat scroll and draft. */}
              {(rightTab === "agent" || chatMounted) && <div className={`min-h-0 flex-1 flex-col ${rightTab === "agent" ? "flex" : "hidden"}`}>{!loading && <ChatPanel />}</div>}
            </aside>
          </>
        )}
      </div>
      <StatusBar />
      <WorkspaceDialogs />
      {sendOpen && (
        <Modal
          title={t("workspace.sendToApproval", { count: progress.ready })}
          onClose={() => setSendOpen(false)}
          footer={
            <>
              <Button onClick={() => setSendOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="primary" onClick={send} disabled={sending}>
                {t("common.confirm")}
              </Button>
            </>
          }
        >
          {t("workspace.sendConfirm", { count: progress.ready })}
        </Modal>
      )}
    </div>
  );
}

function ListArea({ onClear, onSend, readyCount, onQueryChange }: { onClear: () => void; onSend: () => void; readyCount: number; onQueryChange: (q: ListQuery) => void }) {
  const t = useT();
  const { store } = useTriageContext();
  const rows = useTriage(store, (s) => s.rows.length);
  const query = useTriage(store, (s) => s.query);
  const summary = useTriage(store, (s) => s.summary);
  const manual = useTriage(store, (s) => s.manual);
  const progress = useProgress();
  const lens = useTriage(store, () => store.effectiveLens());
  const lensBar = !manual && <LensBar query={query} onChange={onQueryChange} />;
  if (rows === 0) {
    const allDone = progress.total > 0 && progress.done + progress.breakdown.postponed >= progress.total;
    return allDone && isDefaultQuery(query) ? (
      <>
      {lensBar}
      <EmptyState
        title={t("list.allDone", { count: readyCount })}
        action={
          <Button variant="primary" onClick={onSend} disabled={!readyCount}>
            {t("workspace.sendToApproval", { count: readyCount })}
          </Button>
        }
      />
      </>
    ) : (
      <>
        {lensBar}
        <EmptyState title={t("list.emptyFiltered")} action={<Button onClick={onClear}>{t("list.clearFilters")}</Button>} />
      </>
    );
  }
  return (
    <>
      {lensBar}
      <div className="flex-shrink-0 border-b border-brand-muted/10 px-3 py-1 text-[11px] text-gray-500">
        {manual && <span className="mr-2 text-amber-800">{t("workspace.manualMode")}</span>}
        {/* Same line in both views for the same filters: grupos · ubicaciones · interferencias (ACC clashes). */}
        <span data-testid="list-summary">
          {summary.meeting
            ? t("meeting.summary", { count: summary.meeting.topics, disciplines: summary.meeting.disciplines })
            : summary.issues
            ? t("issues.summary", { count: summary.issues.total, resolved: summary.issues.resolved, says: summary.issues.saysResolved })
            : t("families.summaryClashes", { count: summary.groups, groups: summary.groups, locations: summary.locations, clashes: summary.clashes })}
          {summary.changed !== undefined && ` ${t("lens.changedBracket", { count: summary.changed })}`}
        </span>
        {lens === "reunion" && (
          <button type="button" onClick={printAgenda} className="float-right text-brand hover:underline">
            {t("meeting.print")}
          </button>
        )}
        {lens === "cambios" && summary.locations === 0 && (
          <span className="ml-2">
            {t("lens.empty")}{" "}
            <button type="button" className="text-brand hover:underline" onClick={() => onQueryChange({ ...query, lens: "todo" })}>
              {t("lens.showAll")}
            </button>
          </span>
        )}
      </div>
      <GroupList />
      <SelectionBar />
      {lens === "reunion" && <PrintAgenda />}
    </>
  );
}

/** "Detalle" | "Agente" tabs of the right column (same width; the viewer never shrinks). Key C toggles. */
function RightTabs() {
  const t = useT();
  const { store } = useTriageContext();
  const tab = useTriage(store, (s) => s.rightTab);
  const badge = useTriage(store, (s) => s.chatBadge);
  const btn = (on: boolean) => `relative flex h-8 flex-1 items-center justify-center gap-1 border-b-2 text-xs font-medium ${on ? "border-brand text-brand" : "border-transparent text-gray-500 hover:text-brand"}`;
  return (
    <div role="tablist" aria-label={t("chat.tabsLabel")} className="flex flex-shrink-0 border-b border-brand-muted/20">
      <button type="button" role="tab" aria-selected={tab === "detail"} onClick={() => store.setRightTab("detail")} className={btn(tab === "detail")}>
        {t("chat.tabDetail")}
      </button>
      <button type="button" role="tab" aria-selected={tab === "agent"} title={t("chat.tabAgentTip")} onClick={() => store.setRightTab("agent")} className={btn(tab === "agent")}>
        {t("chat.tabAgent")} <Kbd>C</Kbd>
        {badge > 0 && <span aria-label={t("chat.badge", { count: badge })} className="ml-1 rounded-full bg-violet-600 px-1.5 text-[10px] leading-4 text-white">{badge}</span>}
      </button>
    </div>
  );
}

function NoAnalysis({ command, onManual }: { command: string; onManual: () => void }) {
  const t = useT();
  return (
    <EmptyState
      title={t("workspace.noAnalysis.title")}
      body={
        <div className="space-y-3">
          <p>{t("workspace.noAnalysis.body")}</p>
          <p className="text-xs">{t("agent.commandHint")}</p>
          <CopyCommand text={command} />
        </div>
      }
      action={<Button onClick={onManual}>{t("workspace.noAnalysis.manual")}</Button>}
    />
  );
}

function ResizeHandle({ label, value, onChange, invert }: { label: string; value: number; onChange: (v: number) => void; invert?: boolean }) {
  const start = useRef<{ x: number; v: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          const d = (e.key === "ArrowRight" ? 20 : -20) * (invert ? -1 : 1);
          onChange(value + d);
        }
      }}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, v: value };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const d = e.clientX - start.current.x;
        onChange(start.current.v + (invert ? -d : d));
      }}
      onPointerUp={() => (start.current = null)}
      className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-brand/20 focus-visible:bg-brand/30"
    />
  );
}

function useNarrow(px: number) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < px);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < px);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [px]);
  return narrow;
}

