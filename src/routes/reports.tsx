/**
 * /reportes and /reportes/:projectId (spec §6.2). Filters live in the URL:
 * ?project= (portfolio only), ?modelSet=, ?from=, ?to=.
 */
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { ReportData } from "~/lib/api/types";
import { ChartCard } from "~/lib/components/charts";
import { PageHeader } from "~/lib/components/PageHeader";
import { Button, ErrorState, Skeleton, cardCls, inputCls } from "~/lib/components/ui";
import { BRAND, MUTED, SERIES_2, STATUS_COLORS } from "~/lib/charts/theme";
import { ReportKpis } from "~/features/reports/ReportKpis";

export function ReportsPage() {
  const t = useT();
  const api = useApi();
  const navigate = useNavigate();
  const params = useParams();
  const [sp, setSp] = useSearchParams();
  const projectId = params.projectId ?? sp.get("project") ?? undefined;
  const modelSetId = sp.get("modelSet") ?? undefined;
  const from = sp.get("from") ?? undefined;
  const to = sp.get("to") ?? undefined;
  const projects = useAsync(() => api.listProjects(), [api]);
  const modelSets = useAsync(() => (projectId ? api.listModelSets(projectId) : Promise.resolve([])), [api, projectId]);
  const report = useAsync<ReportData>(() => api.getReport({ projectId, modelSetId, from, to }), [api, projectId, modelSetId, from, to]);

  function setParam(k: string, v: string) {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === "project") next.delete("modelSet");
    setSp(next, { replace: true });
  }

  const projectName = projects.data?.find((p) => p.id === projectId)?.name;
  const scopeMs = modelSetId ?? modelSets.data?.[0]?.id;

  return (
    <div>
      <PageHeader
        title={t("reports.title")}
        crumbs={projectName ? [{ label: t("reports.portfolio"), to: "/reportes" }, { label: projectName }] : undefined}
        subtitle={projectName ?? t("reports.portfolio")}
        actions={<Button onClick={() => window.print()}>{t("reports.print")}</Button>}
      />
      <div className="no-print mb-4 flex flex-wrap items-end gap-3 text-sm">
        {!params.projectId && (
          <label className="flex flex-col text-xs text-gray-500">
            {t("reports.filters.project")}
            <select className={inputCls} value={projectId ?? ""} onChange={(e) => setParam("project", e.target.value)}>
              <option value="">{t("reports.allProjects")}</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {projectId && (
          <label className="flex flex-col text-xs text-gray-500">
            {t("reports.filters.modelSet")}
            <select className={inputCls} value={modelSetId ?? ""} onChange={(e) => setParam("modelSet", e.target.value)}>
              <option value="">{t("reports.allModelSets")}</option>
              {modelSets.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs text-gray-500">
          {t("reports.filters.from")}
          <input type="date" className={inputCls} value={from ?? ""} onChange={(e) => setParam("from", e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          {t("reports.filters.to")}
          <input type="date" className={inputCls} value={to ?? ""} onChange={(e) => setParam("to", e.target.value)} />
        </label>
      </div>
      {report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : report.loading || !report.data ? (
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      ) : (
        <ReportBody data={report.data} onPair={(pair) => projectId && scopeMs && navigate(`/coordinacion/${projectId}/${scopeMs}?pair=${pair}&decision=`)} canDrill={!!projectId} />
      )}
    </div>
  );
}

function ReportBody({ data, onPair, canDrill }: { data: ReportData; onPair: (pair: string) => void; canDrill: boolean }) {
  const t = useT();
  const status = (k: keyof typeof STATUS_COLORS) => ({ active: t("accStatus.active"), reviewed: t("accStatus.reviewed"), resolved: t("accStatus.resolved"), closed: t("accStatus.closed") })[k];
  const statusSeries = <R extends Record<keyof typeof STATUS_COLORS, number>>(rows: R[]) =>
    (Object.keys(STATUS_COLORS) as (keyof typeof STATUS_COLORS)[]).map((k) => ({ label: status(k), data: rows.map((r) => r[k]), color: STATUS_COLORS[k] }));
  return (
    <div className="space-y-4">
      <ReportKpis kpis={data.kpis} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={t("reports.chart.burndown")}
          filename="evolucion"
          labels={data.burndown.map((b) => b.label)}
          stacked
          series={[...statusSeries(data.burndown), { label: t("reports.chart.valid"), data: data.burndown.map((b) => b.valid), color: "#111827", line: true }]}
        />
        <DisciplineMatrix data={data} onPair={onPair} canDrill={canDrill} />
        <ChartCard title={t("reports.chart.byStatusPair")} filename="estado-par" labels={data.byStatusPair.map((r) => r.pair)} stacked horizontal height={Math.max(220, data.byStatusPair.length * 22)} series={statusSeries(data.byStatusPair)} />
        <ChartCard
          title={t("reports.chart.newVsResolved")}
          filename="nuevas-resueltas"
          labels={data.newVsResolved.map((r) => r.label)}
          series={[
            { label: t("delta.new"), data: data.newVsResolved.map((r) => r.new), color: SERIES_2 },
            { label: t("delta.resolved"), data: data.newVsResolved.map((r) => r.resolved), color: STATUS_COLORS.resolved },
          ]}
        />
        <ChartCard title={t("reports.chart.reasons")} filename="razones" horizontal labels={data.reasons.map((r) => `${r.code} · ${t(`reasons.${r.code}`)}`)} series={[{ label: t("reports.count"), data: data.reasons.map((r) => r.count), color: BRAND }]} height={Math.max(200, data.reasons.length * 26)} />
        <ChartCard
          title={t("reports.chart.calibration")}
          filename="calibracion"
          labels={data.calibration.map((b) => t(b.band === "alta" ? "confidence.high" : b.band === "media" ? "confidence.medium" : "confidence.low"))}
          series={[
            { label: t("rules.calibrationProposals"), data: data.calibration.map((b) => b.proposals), color: MUTED },
            { label: t("rules.calibrationAccepted"), data: data.calibration.map((b) => b.acceptedUnchanged), color: BRAND },
          ]}
        />
        <ChartCard
          title={t("reports.chart.p1Aging")}
          filename="antiguedad-p1"
          labels={[t("reports.aging.lt1w"), t("reports.aging.w1to2"), t("reports.aging.w2to4"), t("reports.aging.gt4w")]}
          series={[{ label: t("reports.count"), data: [data.p1Aging.lt1w, data.p1Aging.w1to2, data.p1Aging.w2to4, data.p1Aging.gt4w], color: BRAND }]}
        />
      </div>
    </div>
  );
}

/** C2: discipline pair matrix as an HTML heatmap (single-hue brand scale, number always printed). */
function DisciplineMatrix({ data, onPair, canDrill }: { data: ReportData; onPair: (pair: string) => void; canDrill: boolean }) {
  const t = useT();
  const codes = data.disciplines;
  const max = Math.max(1, ...codes.flatMap((a) => codes.map((b) => data.matrix[a]?.[b] ?? 0)));
  const shade = (n: number) => {
    if (!n) return "bg-white";
    const steps = ["bg-brand/5", "bg-brand/15", "bg-brand/30", "bg-brand/50", "bg-brand/80"];
    return steps[Math.min(steps.length - 1, Math.floor((n / max) * steps.length))];
  };
  return (
    <section className={`${cardCls} p-4`} aria-label={t("reports.chart.matrix")}>
      <h2 className="mb-2 text-sm font-semibold text-gray-800">{t("reports.chart.matrix")}</h2>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th />
              {codes.map((c) => (
                <th key={c} scope="col" className="px-1 py-1 font-mono font-medium text-gray-600">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map((a, i) => (
              <tr key={a}>
                <th scope="row" className="pr-2 text-right font-mono font-medium text-gray-600">
                  {a}
                </th>
                {codes.map((b, j) => {
                  const n = data.matrix[a]?.[b] ?? 0;
                  if (j < i) return <td key={b} />;
                  const pair = a < b ? `${a}:${b}` : `${b}:${a}`;
                  const dark = n / max > 0.6;
                  return (
                    <td key={b} className="p-0.5">
                      <button
                        type="button"
                        disabled={!canDrill || !n}
                        onClick={() => onPair(pair)}
                        aria-label={`${a} × ${b}: ${n}`}
                        className={`h-9 w-12 rounded border border-brand-muted/10 tabular-nums ${shade(n)} ${dark ? "text-white" : "text-gray-800"} enabled:hover:ring-2 enabled:hover:ring-brand/40`}
                      >
                        {n}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
