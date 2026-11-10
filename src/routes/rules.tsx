/**
 * /reglas — one simple page: Reglas (explainer, pending suggestions, active rules by pair with
 * use and acierto, Biblioteca, automatic alerts) | Historial (suggestions and publications,
 * feedback, corrections, calibration). Query: tab=reglas|historial, ver=<history section>.
 * Old links (?tab=sugerencias|feedback|correcciones|calibracion) land on the right place.
 */
import { useRef } from "react";
import { useSearchParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { Calibration, CorrectionRow } from "~/lib/api/types";
import { ChartCard } from "~/lib/components/charts";
import { PageHeader } from "~/lib/components/PageHeader";
import { Button, ErrorState, SkeletonRows, cardCls } from "~/lib/components/ui";
import { downloadBlob } from "~/lib/csv";
import { BRAND, SERIES_2 } from "~/lib/charts/theme";
import { FIELD_KEY } from "~/lib/labels";
import { FeedbackLog } from "~/features/rules/FeedbackLog";
import { RulesBoard } from "~/features/rules/RulesBoard";
import { Suggestions } from "~/features/rules/SuggestionCard";

export { PatchView } from "~/features/rules/SuggestionCard";

const TABS = ["reglas", "historial"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, TKey> = { reglas: "rules.tabs.rules", historial: "rules.tabs.history" };
const HISTORY = ["sugerencias", "feedback", "correcciones", "calibracion"] as const;
type HistorySection = (typeof HISTORY)[number];
const HISTORY_KEY: Record<HistorySection, TKey> = { sugerencias: "rules.historyPublications", feedback: "parity.feedback.tab", correcciones: "rules.tabs.corrections", calibracion: "rules.tabs.calibration" };

export function RulesPage() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("tab") ?? "";
  const legacy = (HISTORY as readonly string[]).includes(raw) && raw !== "sugerencias";
  const tab: Tab = raw === "historial" || legacy ? "historial" : "reglas";
  const ver = (legacy ? raw : sp.get("ver") ?? "sugerencias") as HistorySection;
  const section: HistorySection = (HISTORY as readonly string[]).includes(ver) ? ver : "sugerencias";
  return (
    <div>
      <PageHeader title={t("rules.title")} />
      <div role="tablist" className="mb-4 flex gap-1 border-b border-brand-muted/20">
        {TABS.map((tb) => (
          <button key={tb} type="button" role="tab" aria-selected={tab === tb} onClick={() => setSp({ tab: tb }, { replace: true })} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === tb ? "border-brand text-brand" : "border-transparent text-gray-600 hover:text-brand"}`}>
            {t(TAB_KEY[tb])}
          </button>
        ))}
      </div>
      {tab === "reglas" && <RulesBoard />}
      {tab === "historial" && (
        <div className="space-y-3">
          <div role="group" className="flex flex-wrap gap-1">
            {HISTORY.map((h) => (
              <button key={h} type="button" aria-pressed={section === h} onClick={() => setSp({ tab: "historial", ver: h }, { replace: true })} className={`rounded-full border px-2.5 py-0.5 text-xs ${section === h ? "border-brand-light/40 bg-brand/5 text-brand" : "border-brand-muted/30 text-gray-600 hover:text-brand"}`}>
                {t(HISTORY_KEY[h])}
              </button>
            ))}
          </div>
          {section === "sugerencias" && <Suggestions />}
          {section === "feedback" && <FeedbackLog />}
          {section === "correcciones" && <Corrections />}
          {section === "calibracion" && <CalibrationView />}
        </div>
      )}
    </div>
  );
}

export const RULE_STATE_CLS = { active: "text-green-700", draft: "text-amber-800", disabled: "text-gray-500" } as const;

function Corrections() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.listCorrections({ limit: 1000 }), [api]);
  const parentRef = useRef<HTMLDivElement>(null);
  const items = data?.items ?? [];
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => 36, overscan: 10 });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <SkeletonRows count={6} height="h-8" />;
  function exportEval() {
    const jsonl = items.map((c: CorrectionRow) => JSON.stringify({ target: c.targetId, field: c.field, expected: c.humanValue, got: c.aiValue, reason: c.reasonCode, note: c.note ?? null, rules: c.ruleIds })).join("\n");
    downloadBlob("correcciones-eval.jsonl", new Blob([jsonl], { type: "application/x-ndjson" }));
  }
  const grid = "grid grid-cols-[110px_90px_90px_100px_1fr_1fr_60px_1fr_90px_60px] items-center gap-2 px-3";
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button onClick={exportEval}>{t("rules.exportEval")}</Button>
      </div>
      <div className={`${cardCls} text-xs`}>
        <div className={`${grid} border-b border-brand-muted/20 py-2 font-medium text-gray-500`}>
          <span>{t("audit.columns.date")}</span>
          <span>{t("audit.filters.user")}</span>
          <span>{t("audit.columns.object")}</span>
          <span>{t("rules.columns.effect")}</span>
          <span>{t("rules.aiValue")}</span>
          <span>{t("rules.humanValue")}</span>
          <span>{t("rules.reason")}</span>
          <span>{t("reasons.note")}</span>
          <span>{t("nav.rules")}</span>
          <span>{t("confidence.label")}</span>
        </div>
        <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const c = items[vi.index];
              return (
                <div key={vi.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` }} className={`${grid} border-b border-brand-muted/10`}>
                  <span className="text-gray-500">{fmt.dateTime(c.at)}</span>
                  <span className="truncate">{c.userName}</span>
                  <span className="truncate font-mono">{c.targetLabel}</span>
                  <span className="truncate">{c.field === "reject" ? t("actions.reject") : t(FIELD_KEY[c.field])}</span>
                  <span className="truncate text-gray-400 line-through">{c.aiValue}</span>
                  <span className="truncate font-medium">{c.humanValue}</span>
                  <span className="font-mono">{c.reasonCode ?? "—"}</span>
                  <span className="truncate" title={c.note}>
                    {c.note ?? ""}
                  </span>
                  <span className="truncate font-mono">{c.ruleIds.join(", ")}</span>
                  <span className="tabular-nums">{c.confidence !== undefined ? fmt.number(c.confidence, 2) : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function CalibrationView() {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const { data, error, loading, reload } = useAsync<Calibration>(() => api.getCalibration(), [api]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <SkeletonRows count={3} height="h-16" />;
  const bandLabel = (b: string) => t(b === "alta" ? "confidence.high" : b === "media" ? "confidence.medium" : "confidence.low");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title={t("reports.chart.calibration")}
        filename="calibracion"
        labels={data.bands.map((b) => bandLabel(b.band))}
        series={[
          { label: t("rules.calibrationProposals"), data: data.bands.map((b) => b.proposals), color: SERIES_2 },
          { label: t("rules.calibrationAccepted"), data: data.bands.map((b) => b.acceptedUnchanged), color: BRAND },
        ]}
      />
      <section className={`${cardCls} p-4 text-sm`}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1">{t("rules.columns.effect")}</th>
              <th>{t("source.label")}</th>
              <th>{t("rules.calibrationBand")}</th>
              <th className="text-right">{t("rules.calibrationProposals")}</th>
              <th className="text-right">{t("rules.calibrationAccepted")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byField.flatMap((f) =>
              f.bands.map((b) => (
                <tr key={`${f.field}-${f.source}-${b.band}`} className="border-t border-brand-muted/10">
                  <td className="py-1">{t(FIELD_KEY[f.field])}</td>
                  <td>{f.source === "rule" ? t("source.ruleGeneric") : t("source.llm")}</td>
                  <td>{bandLabel(b.band)}</td>
                  <td className="text-right tabular-nums">{fmt.number(b.proposals)}</td>
                  <td className="text-right tabular-nums">{b.proposals < data.minDecisions ? "—" : fmt.pct(b.acceptedUnchanged / b.proposals)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-gray-600">{t("rules.spotCheckRate", { pct: fmt.pct(data.spotCheck.reviewed ? data.spotCheck.corrected / data.spotCheck.reviewed : 0) })}</p>
      </section>
    </div>
  );
}
