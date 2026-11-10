/**
 * /aprobaciones/:batchId — batch review, pre-flight, approve & apply (spec §5.3–5.5).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import { useCoordAuth } from "~/lib/coord-auth";
import { passkeyMessage } from "~/lib/passkey-messages";
import { approveWithPasskey } from "~/lib/webauthn";
import type { ApplyResponse, ApplyStatus, Batch, IssueDraft } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { PageHeader } from "~/lib/components/PageHeader";
import { useToast } from "~/lib/components/Toast";
import { Banner, Button, EmptyState, ErrorState, SkeletonRows } from "~/lib/components/ui";
import { ApplyConfirmDialog, changeCount, ApplyProgress, BatchSummaryView, ConflictsList, DryRunPreview, IssuePreviewCard, PreflightStatus, preflightFresh } from "~/features/approvals/BatchParts";
import { BatchDiffTable } from "~/features/approvals/BatchDiffTable";
import { BatchStateLabel } from "./approvals";

const TABS = ["resumen", "cambios", "incidencias", "conflictos"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TKey> = { resumen: "batch.tabs.summary", cambios: "batch.tabs.changes", incidencias: "batch.tabs.issues", conflictos: "batch.tabs.conflicts" };

export function BatchPage() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const { batchId = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(sp.get("tab") ?? "") ? (sp.get("tab") as Tab) : "resumen";
  const { data: batch, setData: setBatch, error, loading, reload } = useAsync<Batch>(() => api.getBatch(batchId), [api, batchId]);
  const [preflighting, setPreflighting] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"approve" | "apply" | null>(null);
  const [dryRun, setDryRun] = useState<ApplyResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apply, setApply] = useState<ApplyStatus | null>(null);
  const [rebasing, setRebasing] = useState(false);
  const autoRan = useRef(false);
  const { status: authStatus } = useCoordAuth();
  const [approveError, setApproveError] = useState<string | null>(null);
  const demoApproval = api.mode === "mock" || authStatus?.dataSource !== "live";

  const runPreflight = useCallback(async () => {
    setPreflighting(true);
    try {
      const res = await api.preflightBatch(batchId);
      setBatch(res.batch);
    } catch (err) {
      toast.show(String(err instanceof Error ? err.message : err), { tone: "error" });
    } finally {
      setPreflighting(false);
    }
  }, [api, batchId, setBatch, toast]);

  // Pre-flight runs automatically on open if the last one is older than 10 min.
  useEffect(() => {
    if (!batch || autoRan.current || batch.state !== "ready") return;
    autoRan.current = true;
    if (!preflightFresh(batch)) void runPreflight();
  }, [batch, runPreflight]);

  const loadDryRun = useCallback(async () => {
    try {
      setDryRun(await api.applyBatch(batchId, { dryRun: true }));
    } catch (err) {
      toast.show(String(err instanceof Error ? err.message : err), { tone: "error" });
    }
  }, [api, batchId, toast]);

  // Approved batch: show the dry run (exact ACC request bodies) before any real write.
  useEffect(() => {
    if (batch?.state === "approved" && !dryRun && !applying) void loadDryRun();
  }, [batch?.state, dryRun, applying, loadDryRun]);

  // Applied / partial batch: show the final status once.
  useEffect(() => {
    if (!batch || apply || (batch.state !== "applied" && batch.state !== "partial")) return;
    api.getApplyStatus(batchId).then(setApply, () => undefined);
  }, [api, batch, apply, batchId]);

  // Apply progress polling, only after a real apply was started here.
  useEffect(() => {
    if (!applying) return;
    if (apply && (apply.state === "applied" || apply.state === "partial")) return;
    const id = window.setInterval(async () => {
      try {
        const s = await api.getApplyStatus(batchId);
        setApply(s);
        if (s.state === "applied" || s.state === "partial") {
          window.clearInterval(id);
          setApplying(false);
          reload();
        }
      } catch {
        /* keep polling */
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [api, batchId, applying, apply, reload]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !batch) return <SkeletonRows count={6} height="h-12" />;

  const readOnly = batch.state !== "ready";
  const conflicts = batch.items.filter((i) => i.conflict);
  const issues = batch.items.filter((i) => i.operation === "issue.create" && i.issue && !i.conflict);
  const changesCount = batch.items.filter((i) => !i.conflict).reduce((s, i) => s + i.fields.length, 0);
  const excluded = batch.items.filter((i) => i.excluded).length;
  // G3: a batch on an outdated base is never approved; "Llevar decisiones a vN" makes a new one.
  const canApprove = batch.state === "ready" && preflightFresh(batch) && !preflighting && !batch.stale;

  async function toggle(itemIds: string[], ex: boolean) {
    setBatch(await api.setBatchItemsExcluded(batchId, itemIds, ex));
  }
  async function saveIssue(itemId: string, patch: Partial<IssueDraft>) {
    setBatch(await api.updateBatchIssue(batchId, itemId, patch));
  }
  async function approve(word: string) {
    if (!batch) return;
    setBusy(true);
    setApproveError(null);
    const excludedItemIds = batch.items.filter((i) => i.excluded).map((i) => i.id);
    try {
      if (demoApproval) {
        // Fixtures / mock: labelled demo approval, no passkey (the live source refuses it).
        await api.approveBatch(batchId, { confirmWord: word, excludedItemIds, demo: true });
      } else {
        // Live: WebAuthn ceremony (Windows Hello) over a challenge bound to this exact payload.
        await approveWithPasskey(api, { batchId, confirmWord: word, excludedItemIds });
      }
      setConfirmMode(null);
      setDryRun(null);
      reload();
    } catch (err) {
      // Keep the dialog open with a clear message (cancelled, timeout, no passkey…).
      setApproveError(passkeyMessage(t, err));
    } finally {
      setBusy(false);
    }
  }
  async function applyReal() {
    setBusy(true);
    try {
      const res = await api.applyBatch(batchId, { dryRun: false });
      setConfirmMode(null);
      if (res.refused) {
        setDryRun(res);
        return;
      }
      setDryRun(res);
      setApply(res.status);
      if (res.status.state === "applied" || res.status.state === "partial") reload();
      else setApplying(true);
    } catch (err) {
      toast.show(String(err instanceof Error ? err.message : err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function returnToReview() {
    await api.returnBatchToReview(batchId);
    toast.show(t("batch.returned"));
    navigate("/aprobaciones");
  }
  async function rebase() {
    setRebasing(true);
    try {
      const r = await api.rebaseBatch(batchId);
      toast.show(t("batch.rebaseDone", { batch: r.batch.id, count: r.batch.items.filter((i) => !i.excluded).length, version: r.batch.modelSetVersion }));
      navigate(`/aprobaciones/${encodeURIComponent(r.batch.id)}`);
    } catch (err) {
      toast.show(String(err instanceof Error ? err.message : err), { tone: "error" });
    } finally {
      setRebasing(false);
    }
  }
  async function discard() {
    await api.discardBatch(batchId);
    setDiscardOpen(false);
    toast.show(t("batch.discarded"));
    navigate("/aprobaciones");
  }
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(sp);
    p.set("tab", next);
    setSp(p, { replace: true });
  };
  const counts: Record<Tab, number | null> = { resumen: null, cambios: changesCount, incidencias: issues.length, conflictos: conflicts.length };

  return (
    <div>
      <PageHeader
        title={t("batch.title", { id: batch.id })}
        crumbs={[{ label: t("approvals.title"), to: "/aprobaciones" }, { label: batch.id }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {batch.projectName} / {batch.modelSetName} · {t("workspace.test")} v{batch.modelSetVersion} ({fmt.date(batch.testDate)})
            </span>
            <BatchStateLabel b={batch} />
            <span>{t("batch.createdBy", { user: batch.createdBy, date: fmt.dateTime(batch.createdAt), count: changesCount })}</span>
          </span>
        }
      />
      {batch.rebase && (
        <Banner tone="warning" className="mb-4 rounded">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              {t("batch.staleWarning", { latest: batch.latestVersion })}{" "}
              <span className="text-xs">{batch.rebase.available ? t("batch.rebaseHint", { version: batch.rebase.targetVersion }) : batch.rebase.reason}</span>
            </span>
            <Button variant="primary" disabled={!batch.rebase.available || rebasing} onClick={() => void rebase()} title={batch.rebase.reason}>
              {t("batch.rebaseAction", { version: batch.rebase.targetVersion })}
            </Button>
          </div>
        </Banner>
      )}
      {batch.supersededBy && (
        <Banner tone="info" className="mb-4 rounded">
          <Link to={`/aprobaciones/${encodeURIComponent(batch.supersededBy)}`} className="underline">
            {t("batch.supersededBy", { batch: batch.supersededBy })}
          </Link>
        </Banner>
      )}
      {batch.rebasedFrom && (
        <div className="mb-4 rounded border border-brand-muted/20 bg-white px-3 py-2 text-sm text-gray-700">
          <p>
            {t("batch.rebasedFrom", { batch: batch.rebasedFrom.batchId, version: batch.rebasedFrom.fromVersion })}
          </p>
          {batch.rebasedFrom.needsReview.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-amber-800">{t("batch.rebaseNeedsReview", { count: batch.rebasedFrom.needsReview.length })}</summary>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto text-xs">
                {batch.rebasedFrom.needsReview.map((x, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="min-w-0 max-w-[50%] truncate font-medium" title={x.label}>{x.label}</span>
                    <span className="text-gray-600">{x.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {batch.approval && (
        <Banner tone={batch.approval.valid ? "info" : "error"} className="mb-4 rounded">
          {batch.approval.valid
            ? t("batch.approvalBy", { user: batch.approval.approvedBy, date: fmt.dateTime(batch.approval.approvedAt), expires: fmt.dateTime(batch.approval.expiresAt) })
            : t("batch.approvalInvalid", { reason: batch.approval.reason ?? "" })}
        </Banner>
      )}
      {apply && <div className="mb-4"><ApplyProgress status={apply} /></div>}
      {batch.state === "approved" && (
        <div className="mb-4 space-y-3">
          {dryRun ? <DryRunPreview res={dryRun} projectId={batch.projectId} /> : <SkeletonRows count={2} height="h-12" />}
          <div className="flex flex-wrap gap-2">
            <Button onClick={loadDryRun}>{t("batch.dryRun")}</Button>
            <Button variant="primary" className="ml-auto" disabled={!dryRun || !!dryRun.refused || applying || batch.approval?.valid === false} onClick={() => setConfirmMode("apply")}>
              {t("batch.applyReal")}
            </Button>
          </div>
        </div>
      )}

      <div role="tablist" aria-label={t("batch.title", { id: batch.id })} className="mb-4 flex gap-1 border-b border-brand-muted/20">
        {TABS.map((tb) => (
          <button
            key={tb}
            type="button"
            role="tab"
            aria-selected={tab === tb}
            onClick={() => setTab(tb)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === tb ? "border-brand text-brand" : "border-transparent text-gray-600 hover:text-brand"}`}
          >
            {t(TAB_KEY[tb])} {counts[tb] !== null && <span className="text-gray-400">{fmt.number(counts[tb]!)}</span>}
          </button>
        ))}
      </div>

      {tab === "resumen" && (
        <div className="space-y-4">
          <BatchSummaryView batch={batch} preflight={<PreflightStatus batch={batch} running={preflighting} />} />
          {excluded > 0 && <p className="text-sm text-gray-600">{t("batch.excludedCount", { count: excluded })}</p>}
          {batch.state === "ready" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runPreflight} disabled={preflighting}>
                {t("batch.preflight")}
              </Button>
              <Button onClick={returnToReview}>{t("batch.returnToReview")}</Button>
              <Button variant="danger" onClick={() => setDiscardOpen(true)}>
                {t("batch.discard")}
              </Button>
              <Button variant="primary" className="ml-auto" disabled={!canApprove} onClick={() => setConfirmMode("approve")} title={!preflightFresh(batch) ? t("batch.preflightRequired") : undefined}>
                {t("batch.approveOnly")}
              </Button>
            </div>
          )}
        </div>
      )}
      {tab === "cambios" && <BatchDiffTable batch={batch} readOnly={readOnly} onToggle={toggle} />}
      {tab === "incidencias" &&
        (issues.length === 0 ? (
          <EmptyState title={t("batch.noIssues")} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {issues.map((i) => (
              <IssuePreviewCard key={i.id} item={i} readOnly={readOnly} onSave={(p) => saveIssue(i.id, p)} onToggle={(ex) => toggle([i.id], ex)} projectId={batch.projectId} />
            ))}
          </div>
        ))}
      {tab === "conflictos" && <ConflictsList items={conflicts} readOnly={readOnly} onInclude={(id, include) => toggle([id], !include)} onReturn={(id) => toggle([id], true)} />}

      {confirmMode && (
        <ApplyConfirmDialog
          batch={batch}
          mode={confirmMode}
          busy={busy}
          onCancel={() => {
            setConfirmMode(null);
            setApproveError(null);
          }}
          onConfirm={confirmMode === "approve" ? approve : applyReal}
          confirmLabel={confirmMode === "approve" && !demoApproval ? t("approve.buttonPasskey", { count: changeCount(batch) }) : undefined}
          extra={
            confirmMode === "approve" ? (
              <div className="mb-3 space-y-2">
                {demoApproval ? (
                  <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                    <strong className="mr-1 uppercase">{t("approve.demoLabel")}</strong>
                    {t("approve.demoHint")}
                  </p>
                ) : (
                  <p className="rounded border border-brand-light/30 bg-brand-surface px-2 py-1 text-xs text-brand">{busy ? t("approve.passkeyWaiting") : t("approve.passkeyHint")}</p>
                )}
                {approveError && (
                  <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                    {approveError}{" "}
                    {/passkey-enroll/.test(approveError) && (
                      <Link to="/ajustes/passkey" className="underline">
                        {t("passkey.link")}
                      </Link>
                    )}
                  </p>
                )}
              </div>
            ) : undefined
          }
        />
      )}
      {discardOpen && (
        <Modal
          title={t("batch.discard")}
          onClose={() => setDiscardOpen(false)}
          footer={
            <>
              <Button onClick={() => setDiscardOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="danger" onClick={discard}>
                {t("batch.discard")}
              </Button>
            </>
          }
        >
          {t("batch.discardConfirm")}
        </Modal>
      )}
    </div>
  );
}
