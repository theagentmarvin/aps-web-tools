/**
 * WS-N UI parts: the live state of a flow run, its progress panel, the confirm dialog before running a
 * flow, and one next-step row with its single button. Everything shown comes from the server
 * (next steps, flow catalog, run records); nothing here applies, approves or publishes.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useT } from "~/i18n";
import { useApi } from "~/lib/api";
import type { FlowDef, FlowId, FlowRunView, NextStep } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { useToast } from "~/lib/components/Toast";
import { Button } from "~/lib/components/ui";
import { flowsChanged, openFlows, openHarnessDialog, runHref, stepHref } from "./links";

const TERMINAL = new Set(["finished", "failed", "cancelled"]);
export const isTerminal = (r: Pick<FlowRunView, "state">) => TERMINAL.has(r.state);

/** Live view of one run: replays + streams its events; polls while it is queued by another process. */
export function useFlowRun(runId: string | undefined, initial?: FlowRunView): FlowRunView | undefined {
  const api = useApi();
  const [run, setRun] = useState<FlowRunView | undefined>(initial);
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const ctrl = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const r = await api.getFlowRun(runId);
        if (!alive) return;
        setRun(r);
        if (!isTerminal(r)) timer = window.setTimeout(() => void refresh(), 3000);
        else flowsChanged();
      } catch {
        // a missing run keeps the last known state
      }
    };
    void (async () => {
      let ended = false;
      try {
        await api.watchFlowRun(
          runId,
          (e) => {
            if (!alive) return;
            if (e.type === "log") setRun((r) => (r ? { ...r, log: [...r.log, e.line].slice(-200) } : r));
            else if (e.type === "status") setRun((r) => (r ? { ...r, state: e.state } : r));
            else if ((e.type === "done" || e.type === "error") && e.run) {
              ended = true;
              setRun(e.run);
              flowsChanged();
            }
          },
          ctrl.signal,
        );
      } catch {
        // stream unavailable: fall back to polling
      }
      if (alive && !ended) await refresh();
    })();
    return () => {
      alive = false;
      ctrl.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [api, runId]);
  return run;
}

export function FlowStateBadge({ state }: { state: FlowRunView["state"] }) {
  const t = useT();
  const cls =
    state === "finished" ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : state === "failed" ? "bg-red-50 text-red-800 border-red-200"
    : state === "cancelled" ? "bg-gray-50 text-gray-600 border-gray-200"
    : "bg-sky-50 text-sky-800 border-sky-200";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 text-[11px] leading-5 ${cls}`}>
      {!TERMINAL.has(state) && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />}
      {t(`flows.state.${state}`)}
    </span>
  );
}

export function FlowOutcomeLine({ run }: { run: FlowRunView }) {
  const t = useT();
  const o = run.outcome;
  return <p className="text-[11px] text-gray-600">{t("flows.outcome", { proposals: o.proposals, questions: o.questions, drafts: o.issueDrafts, reports: o.reports.length })}</p>;
}

/** Progress log + summary + cancel of one run (Flujos drawer and chat card). */
export function FlowRunPanel({ run, compact = false }: { run: FlowRunView; compact?: boolean }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [run.log.length]);
  async function cancel() {
    if (!window.confirm(t("flows.cancelConfirm"))) return;
    setBusy(true);
    try {
      await api.cancelFlowRun(run.runId);
      toast.show(t("flows.cancelled"));
      flowsChanged();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const href = runHref(run);
  const lines = compact ? run.log.slice(-4) : run.log;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <FlowStateBadge state={run.state} />
        <span className="text-[11px] text-gray-500">{t(run.startedBy === "agent:chat" ? "flows.startedBy.agent" : "flows.startedBy.human")}</span>
        {run.costUsd !== undefined && <span className="text-[11px] text-gray-400">{t("flows.cost", { usd: run.costUsd.toFixed(2), cap: run.costCapUsd.toFixed(2) })}</span>}
        {!isTerminal(run) && (
          <button type="button" onClick={() => void cancel()} disabled={busy} className="ml-auto rounded border border-gray-300 px-1.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {t("flows.cancel")}
          </button>
        )}
      </div>
      {lines.length ? (
        <ol ref={logRef} aria-label={t("flows.log")} className={`space-y-0.5 overflow-y-auto rounded bg-gray-50 p-2 text-[11px] leading-4 text-gray-700 ${compact ? "max-h-24" : "max-h-56"}`} lang="es">
          {lines.map((l, i) => (
            <li key={i} className={l.kind === "error" ? "text-red-700" : l.kind === "created" ? "text-emerald-800" : l.kind === "tool" ? "text-gray-500" : ""}>
              {l.text}
            </li>
          ))}
        </ol>
      ) : (
        !isTerminal(run) && <p className="text-[11px] text-gray-500">{t("flows.empty")}</p>
      )}
      {isTerminal(run) && <FlowOutcomeLine run={run} />}
      {run.outcome.reports.length > 0 && <p className="text-[11px] text-gray-600">{t("flows.reports", { names: run.outcome.reports.join(", ") })}</p>}
      {run.error && run.state === "failed" && <p className="text-[11px] text-red-700">{run.error.message}</p>}
      {!compact && run.summary && (
        <details className="text-[11px] text-gray-700">
          <summary className="cursor-pointer text-gray-500">{t("flows.summary")}</summary>
          <p className="mt-1 whitespace-pre-line" lang="es">
            {run.summary}
          </p>
        </details>
      )}
      {isTerminal(run) && href && (run.outcome.proposals > 0 || run.outcome.questions > 0) && (
        <Link to={href} className="inline-block text-[11px] text-brand hover:underline">
          {t("flows.openResults")}
        </Link>
      )}
    </div>
  );
}

/** Confirm before running a flow: what it does, what it leaves, scope and cost cap. */
export function FlowConfirmDialog({ flowId, projectId, testKey, step, onClose }: { flowId: FlowId; projectId: string; testKey?: string; step?: NextStep; onClose: () => void }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const [def, setDef] = useState<FlowDef | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.listFlowRuns(projectId).then(
      (p) => {
        if (!alive) return;
        setDef(p.catalog.find((f) => f.id === flowId) ?? null);
        if (!p.available) setUnavailable(p.unavailableReason ?? t("nextSteps.unavailable"));
      },
      (e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, flowId, projectId, t]);
  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.runFlow(flowId, { projectId, ...(testKey ? { testKey } : {}), ...(step ? { reason: step.reason.slice(0, 300) } : {}) });
      toast.show(t("flows.started", { label: r.label }));
      flowsChanged();
      onClose();
      openFlows(r.runId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("flows.confirmTitle", { label: def?.label ?? flowId })}
      onClose={() => !busy && onClose()}
      width="w-[520px]"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || !def || !!unavailable}>
            {t("flows.confirmRun")}
          </Button>
        </>
      }
    >
      {def ? (
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("flows.confirmWhat")}</dt>
            <dd lang="es">{def.description}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("flows.confirmProduces")}</dt>
            <dd lang="es">{def.produces}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("flows.confirmScope")}</dt>
            <dd>
              {t("flows.confirmScopeProject", { project: projectId })}
              {testKey ? ` · ${t("flows.confirmScopeTest", { testKey })}` : ""}
            </dd>
          </div>
          {step && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t("flows.confirmWhy")}</dt>
              <dd lang="es">{step.reason}</dd>
            </div>
          )}
          <p className="text-xs text-gray-600">{t("flows.confirmCap", { cap: def.costCapUsd.toFixed(2), min: Math.round(def.timeoutMs / 60_000) })}</p>
          <p className="rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">{t("flows.confirmSafe")}</p>
        </dl>
      ) : (
        !err && <p className="text-xs text-gray-500">{t("common.loading")}</p>
      )}
      {unavailable && (
        <p role="alert" className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          {unavailable}
        </p>
      )}
      {err && (
        <p role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {err}
        </p>
      )}
    </Modal>
  );
}

/** One next step with its single button: Ejecutar (flow → confirm) or Abrir (human step). */
export function NextStepRow({ step, flowsAvailable = true, busy = false, compact = false }: { step: NextStep; flowsAvailable?: boolean; busy?: boolean; compact?: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const a = step.action;
  const isFlow = a.type === "flow";
  const disabled = isFlow && (!flowsAvailable || busy);
  function open() {
    if (a.type !== "open") return;
    if (a.route === "harness") return openHarnessDialog();
    const href = stepHref(a);
    if (href) navigate(href);
  }
  return (
    <li className={`flex items-start gap-3 ${compact ? "py-1.5" : "py-2"}`}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-gray-900" lang="es">
            {step.title}
          </span>
          <span className={`rounded px-1 text-[10px] ${isFlow ? "bg-violet-100 text-violet-800" : "bg-amber-100 text-amber-900"}`}>{t(isFlow ? "nextSteps.agentWork" : "nextSteps.humanStep")}</span>
        </p>
        {!compact && (
          <p className="text-xs text-gray-600" lang="es">
            {step.reason}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => (isFlow ? setConfirm(true) : open())}
        disabled={disabled}
        title={isFlow && !flowsAvailable ? t("nextSteps.unavailable") : isFlow && busy ? t("nextSteps.busy") : step.reason}
        className={`shrink-0 rounded px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${isFlow ? "bg-brand text-white hover:bg-brand-light" : "border border-brand-muted/30 bg-white text-gray-800 hover:border-brand-light/40 hover:text-brand"}`}
      >
        {t(isFlow ? "nextSteps.run" : "nextSteps.open")}
      </button>
      {confirm && a.type === "flow" && <FlowConfirmDialog flowId={a.flow} projectId={a.args.projectId} {...(a.args.testKey ? { testKey: a.args.testKey } : {})} step={step} onClose={() => setConfirm(false)} />}
    </li>
  );
}
