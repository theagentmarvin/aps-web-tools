/**
 * KPI tile and chart card (spec §6, §7.2). Every chart has a "Ver tabla"
 * toggle (accessible data table) and CSV export.
 */
import { useState, type ReactNode } from "react";
import { Bar } from "react-chartjs-2";
import type { ChartData } from "chart.js";
import { useT } from "~/i18n";
import { baseOptions } from "~/lib/charts/theme";
import { downloadCsv } from "~/lib/csv";
import { IconArrowDown, IconArrowUp, IconDownload } from "./icons";
import { cardCls } from "./ui";

export function KpiTile({ label, value, delta, deltaGood, hint, children }: { label: string; value: string; delta?: string; deltaGood?: boolean; hint?: string; children?: ReactNode }) {
  return (
    <div className={`${cardCls} p-4`} title={hint}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-gray-900">{value}</div>
      {delta && (
        <div className={`mt-0.5 flex items-center gap-0.5 text-xs ${deltaGood ? "text-green-700" : "text-red-700"}`}>
          {deltaGood ? <IconArrowDown size={12} /> : <IconArrowUp size={12} />}
          {delta}
        </div>
      )}
      {children}
    </div>
  );
}

export interface SimpleSeries {
  label: string;
  data: number[];
  color: string;
  /** Render as a line over the bars (mixed chart). */
  line?: boolean;
}

export function ChartCard({
  title,
  labels,
  series,
  stacked,
  horizontal,
  height = 240,
  filename,
}: {
  title: string;
  labels: string[];
  series: SimpleSeries[];
  stacked?: boolean;
  horizontal?: boolean;
  height?: number;
  filename: string;
}) {
  const t = useT();
  const [table, setTable] = useState(false);
  const data: ChartData<"bar"> = {
    labels,
    datasets: series.map((s) =>
      s.line
        ? ({ type: "line", label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 3, stack: "line" } as unknown as ChartData<"bar">["datasets"][number])
        : { label: s.label, data: s.data, backgroundColor: s.color, borderRadius: 2, maxBarThickness: 36 },
    ),
  };
  const rows = labels.map((l, i) => [l, ...series.map((s) => s.data[i] ?? 0)]);
  return (
    <section className={`${cardCls} p-4`} aria-label={title}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        <div className="no-print flex gap-2 text-xs">
          <button type="button" onClick={() => setTable((v) => !v)} className="text-brand hover:underline">
            {table ? t("common.showChart") : t("common.showTable")}
          </button>
          <button type="button" onClick={() => downloadCsv(`${filename}.csv`, [["", ...series.map((s) => s.label)], ...rows])} className="inline-flex items-center gap-1 text-gray-600 hover:text-brand">
            <IconDownload size={12} />
            CSV
          </button>
        </div>
      </header>
      {labels.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">{t("reports.empty")}</p>
      ) : table ? (
        <DataTable head={["", ...series.map((s) => s.label)]} rows={rows} />
      ) : (
        <div style={{ height }}>
          <Bar data={data} options={baseOptions({ stacked, horizontal, legend: series.length > 1 })} aria-label={title} role="img" />
        </div>
      )}
    </section>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white">
          <tr className="text-left text-gray-500">
            {head.map((h, i) => (
              <th key={i} className={`py-1 pr-2 font-medium ${i > 0 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-brand-muted/10">
              {r.map((c, j) => (
                <td key={j} className={`py-1 pr-2 ${j > 0 ? "text-right tabular-nums" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
