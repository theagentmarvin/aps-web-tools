/**
 * "Qué sigue" card (project page), the Flujos drawer (app shell) and its nav button (WS-N).
 * The coordinator never has to remember a command: the server says what comes next in the cycle,
 * agent work runs as a flow after a confirmation, human steps open the right screen.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMatch, useSearchParams } from "react-router";
import { useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { FlowRunView, NextStepsPayload } from "~/lib/api/types";
import { cardCls, Skeleton } from "~/lib/components/ui";
import { FlowRunPanel, FlowStateBadge, isTerminal, NextStepRow, useFlowRun } from "./FlowParts";
import { FLOWS_CHANGED_EVENT, OPEN_FLOWS_EVENT, openFlows } from "./links";

function useFlowsChanged(fn: () => void) {
  useEffect(() => {
    window.addEventListener(FLOWS_CHANGED_EVENT, fn);
    return () => window.removeEventListener(FLOWS_CHANGED_EVENT, fn);
  }, [fn]);
}

/** Up to 3 next steps of a project (or test), each with one button. */
export function NextStepsCard({ projectId, testKey, compact = false }: { projectId: string; testKey?: string; compact?: boolean }) {
  const t = useT();
  const api = useApi();
  const q = useAsync<NextStepsPayload>(() => api.getNextSteps({ projectId, ...(testKey ? { testKey } : {}) }), [api, projectId, testKey]);
  useFlowsChanged(q.reload);
  const p = q.data;
  const running = p?.runningFlow;
  return (
    <section aria-label={t("nextSteps.title")} className={compact ? "" : `${cardCls} mb-4 px-4 py-3`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className={compact ? "text-xs font-semibold uppercase tracking-wide text-gray-500" : "text-sm font-semibold text-gray-900"}>{compact ? t("nextSteps.compactTitle") : t("nextSteps.title")}</h2>
        {!compact && (
          <button type="button" onClick={() => openFlows()} className="text-xs text-brand hover:underline">
            {t("nextSteps.viewFlows")}
          </button>
        )}
      </div>
      {!compact && <p className="text-xs text-gray-500">{t("nextSteps.subtitle")}</p>}
      {q.loading && !p ? (
        <Skeleton className="mt-2 h-16" />
      ) : q.error ? (
        <p className="mt-2 text-xs text-red-700">{q.error.message}</p>
      ) : (
        <>
          {running && (
            <button type="button" onClick={() => openFlows(running.runId)} className="mt-2 flex w-full items-center gap-2 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-left text-xs text-sky-900 hover:bg-sky-100">
              <FlowStateBadge state={running.state} />
              <span className="truncate">{t("nextSteps.running", { label: running.label })}</span>
            </button>
          )}
          {p && p.steps.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">{t("nextSteps.empty")}</p>
          ) : (
            <ul className="mt-1 divide-y divide-gray-100">
              {(p?.steps ?? []).slice(0, 3).map((s) => (
                <NextStepRow key={s.id} step={s} flowsAvailable={p?.flowsAvailable ?? false} busy={!!running} compact={compact} />
              ))}
            </ul>
          )}
          {p && !p.flowsAvailable && p.steps.some((s) => s.action.type === "flow") && <p className="mt-1 text-[11px] text-amber-800">{t("nextSteps.unavailable")}</p>}
        </>
      )}
    </section>
  );
}

/** Project (and test) of the current page, if any. */
function useRouteProject(): { projectId?: string; testKey?: string } {
  const project = useMatch("/proyectos/:projectId");
  const workspace = useMatch("/coordinacion/:projectId/:modelSetId");
  const [sp] = useSearchParams();
  const projectId = workspace?.params.projectId ?? project?.params.projectId;
  const testKey = workspace ? (sp.get("test") ?? undefined) : undefined;
  return { ...(projectId ? { projectId } : {}), ...(testKey && /^T-/.test(testKey) ? { testKey } : {}) };
}

function RunItem({ initial, expanded, onToggle }: { initial: FlowRunView; expanded: boolean; onToggle: () => void }) {
  const t = useT();
  const live = useFlowRun(expanded || !isTerminal(initial) ? initial.runId : undefined, initial);
  const run = live ?? initial;
  return (
    <li className="py-2">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-center gap-2 text-left">
        <FlowStateBadge state={run.state} />
        <span className="min-w-0 flex-1 truncate text-sm text-gray-900">{run.label}</span>
        <span className="shrink-0 text-[11px] text-gray-400">{new Date(run.createdAt).toLocaleString()}</span>
      </button>
      {expanded ? <div className="mt-1.5">{<FlowRunPanel run={run} />}</div> : isTerminal(run) ? <div className="mt-0.5">{<p className="text-[11px] text-gray-500">{t("flows.outcome", { proposals: run.outcome.proposals, questions: run.outcome.questions, drafts: run.outcome.issueDrafts, reports: run.outcome.reports.length })}</p>}</div> : null}
    </li>
  );
}

/** The Flujos drawer: compact "Qué sigue", the running flow with its log, and the history. */
export function FlowsDrawer() {
  const t = useT();
  const api = useApi();
  const route = useRouteProject();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const onOpen = (e: Event) => {
      setFocus((e as CustomEvent<{ runId?: string }>).detail?.runId);
      setOpen(true);
      setNonce((n) => n + 1);
    };
    window.addEventListener(OPEN_FLOWS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FLOWS_EVENT, onOpen);
  }, []);
  const runs = useAsync(() => (open ? api.listFlowRuns(route.projectId) : Promise.resolve(undefined)), [api, open, route.projectId, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useFlowsChanged(reload);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const list = runs.data?.runs ?? [];
  const active = list.filter((r) => !isTerminal(r));
  const past = list.filter((r) => isTerminal(r));
  return createPortal(
    <aside role="dialog" aria-label={t("flows.title")} className="fixed bottom-0 right-0 top-0 z-40 flex w-[440px] max-w-full flex-col border-l border-brand-muted/20 bg-white shadow-xl">
      <header className="flex items-center justify-between border-b border-brand-muted/20 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{t("flows.title")}</h2>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100">
          {t("flows.close")}
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {route.projectId ? <NextStepsCard projectId={route.projectId} {...(route.testKey ? { testKey: route.testKey } : {})} compact /> : <p className="text-xs text-gray-500">{t("nextSteps.noProject")}</p>}
        {runs.data && !runs.data.available && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{runs.data.unavailableReason ?? t("nextSteps.unavailable")}</p>}
        {active.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("flows.runningTitle")}</h3>
            <ul className="divide-y divide-gray-100">
              {active.map((r) => (
                <RunItem key={r.runId} initial={r} expanded onToggle={() => undefined} />
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("flows.history")}</h3>
          {runs.loading && !runs.data ? (
            <Skeleton className="mt-2 h-20" />
          ) : past.length === 0 ? (
            <p className="mt-1 text-xs text-gray-500">{t("flows.noRuns")}</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {past.map((r) => (
                <RunItem key={r.runId} initial={r} expanded={focus === r.runId} onToggle={() => setFocus((f) => (f === r.runId ? undefined : r.runId))} />
              ))}
            </ul>
          )}
        </section>
        {runs.data && <p className="text-[11px] text-gray-400">{t("flows.agentCap", { used: runs.data.agentRunsToday, cap: runs.data.dailyAgentCap })}</p>}
      </div>
    </aside>,
    document.body,
  );
}

/** Compact entry in the app shell: opens the drawer; a dot while a flow runs. */
export function FlowsNavButton() {
  const t = useT();
  const api = useApi();
  const [running, setRunning] = useState(false);
  const check = useCallback(() => {
    api.listFlowRuns().then(
      (p) => setRunning(p.runs.some((r) => !isTerminal(r))),
      () => undefined,
    );
  }, [api]);
  useEffect(() => {
    check();
    const id = window.setInterval(() => document.visibilityState === "visible" && check(), running ? 5000 : 30000);
    return () => window.clearInterval(id);
  }, [check, running]);
  useFlowsChanged(check);
  return (
    <button type="button" onClick={() => openFlows()} title={running ? t("flows.navRunning") : t("flows.title")} className="inline-flex items-center gap-1.5 rounded border border-brand-muted/30 px-2 py-0.5 text-xs text-gray-700 hover:border-brand-light/40 hover:text-brand">
      {running && <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />}
      {t("flows.navButton")}
    </button>
  );
}
