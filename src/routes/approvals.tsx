/**
 * /aprobaciones — batch queue (spec §5.2). Query: status, project.
 */
import { Link, useSearchParams } from "react-router";
import { useI18n, useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { BatchState, BatchSummary } from "~/lib/api/types";
import { PageHeader } from "~/lib/components/PageHeader";
import { IconAlert, IconCheck } from "~/lib/components/icons";
import { EmptyState, ErrorState, SkeletonRows, cardCls } from "~/lib/components/ui";
import { BATCH_STATE_KEY } from "~/lib/labels";

const STATES: BatchState[] = ["ready", "approved", "applied", "partial", "draft", "discarded"];

export function BatchStateLabel({ b }: { b: Pick<BatchSummary, "state" | "stale"> }) {
  const t = useT();
  const tone =
    b.state === "ready"
      ? b.stale
        ? "text-amber-800"
        : "text-brand"
      : b.state === "applied"
        ? "text-green-700"
        : b.state === "partial"
          ? "text-red-700"
          : "text-gray-500";
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${tone}`}>
      {b.state === "applied" ? <IconCheck size={13} /> : b.stale && b.state === "ready" ? <IconAlert size={13} /> : <span aria-hidden className="h-2 w-2 rounded-full bg-current" />}
      {t(BATCH_STATE_KEY[b.state])}
      {b.stale && b.state === "ready" && ` (${t("approvals.state.stale").toLowerCase()})`}
    </span>
  );
}

export function ApprovalsPage() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const [sp, setSp] = useSearchParams();
  const status = sp.get("status") as BatchState | null;
  const project = sp.get("project") ?? undefined;
  const { data, error, loading, reload } = useAsync(() => api.listBatches({ projectId: project }), [api, project]);

  const list = (data ?? [])
    .filter((b) => !status || b.state === status)
    .sort((a, b) => (a.state === "ready" ? 0 : 1) - (b.state === "ready" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));

  function setStatus(s: BatchState | null) {
    const next = new URLSearchParams(sp);
    if (s) next.set("status", s);
    else next.delete("status");
    setSp(next, { replace: true });
  }

  return (
    <div>
      <PageHeader title={t("approvals.title")} />
      <div role="tablist" className="mb-4 flex flex-wrap gap-2 text-xs">
        <button type="button" role="tab" aria-selected={!status} onClick={() => setStatus(null)} className={`rounded-full border px-3 py-1 ${!status ? "border-brand-light/40 bg-brand/5 text-brand" : "border-brand-muted/30 text-gray-600"}`}>
          {t("common.all")}
        </button>
        {STATES.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)} className={`rounded-full border px-3 py-1 ${status === s ? "border-brand-light/40 bg-brand/5 text-brand" : "border-brand-muted/30 text-gray-600"}`}>
            {t(BATCH_STATE_KEY[s])} {data && <span className="text-gray-400">{data.filter((b) => b.state === s).length}</span>}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading ? (
        <SkeletonRows count={4} height="h-10" />
      ) : list.length === 0 ? (
        <EmptyState title={t("approvals.empty")} />
      ) : (
        <div className={`${cardCls} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-muted/20 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">{t("approvals.columns.state")}</th>
                <th className="px-3 py-2 font-medium">{t("approvals.columns.project")}</th>
                <th className="px-3 py-2 font-medium">{t("approvals.columns.test")}</th>
                <th className="px-3 py-2 font-medium">{t("approvals.columns.changes")}</th>
                <th className="px-3 py-2 font-medium">{t("approvals.columns.createdBy")}</th>
                <th className="px-3 py-2 font-medium">{t("approvals.columns.date")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} className="border-b border-brand-muted/10 last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <BatchStateLabel b={b} />
                  </td>
                  <td className="px-3 py-2">
                    {b.projectName.split(" — ")[0]} / {b.modelSetName}
                    <div className="font-mono text-[11px] text-gray-400">{b.id}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    v{b.modelSetVersion} {fmt.date(b.testDate).slice(0, 5)}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{t("approvals.changesSummary", { issues: b.counts.issuesCreate, statuses: b.counts.statusChanges, assignments: b.counts.assignments })}</td>
                  <td className="px-3 py-2">{b.createdBy}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmt.dateTime(b.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Link to={`/aprobaciones/${b.id}`} className={b.state === "ready" ? "rounded bg-brand px-3 py-1 text-xs text-white hover:bg-brand-light" : "rounded border border-brand-muted/30 px-3 py-1 text-xs text-gray-700 hover:text-brand"}>
                      {b.state === "ready" ? t("approvals.review") : t("approvals.view")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
