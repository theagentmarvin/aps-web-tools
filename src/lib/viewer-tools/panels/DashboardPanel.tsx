/**
 * DashboardPanel — Property analytics dashboard with KPIs + charts.
 *
 * Top 5 KPIs: Total Elements, Unique Materials, Categories, Types, Levels
 * Top 5 Charts: Material doughnut, Category bar, Level bar, Phase doughnut, Types bar
 *
 * Data: model properties (getBulkProperties) or external sources via registerExternalSource/Kpi.
 * Style: SalfaCorp brand palette (#A32428 burgundy, #F6E9E9 surface, #8D9299 muted).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Bar, Doughnut, Pie } from "react-chartjs-2";
import {
  Chart as ChartJS,
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Title,
} from "chart.js";
import {
  fetchChartData,
  fetchKpi,
  DEFAULT_CHARTS,
  DEFAULT_KPIS,
  type ChartConfig,
  type ChartDataset,
  type KpiConfig,
} from "../chart-data";

// ── Register ChartJS components
ChartJS.register(ArcElement, BarElement, CategoryScale, LinearScale, Tooltip, Legend, Title);

// ── SalfaCorp Brand Palette ──────────────────────────────────────

const BRAND = "#A32428";
const BRAND_LIGHT = "#B44E51";
const BRAND_LIGHTER = "#BE6568";
const WHITE = "#FEFEFE";
const MUTED = "#8D9299";

/** Chart.js color palette derived from SalfaCorp brand + complementary. */
const CHART_COLORS = [
  BRAND,            // burgundy
  "#4A90D9",        // blue
  "#2ECC71",        // green
  "#F39C12",        // orange
  BRAND_LIGHTER,    // lighter burgundy
  "#9B59B6",        // purple
  "#1ABC9C",        // teal
  MUTED,            // gray
  "#E74C3C",        // red
  "#34495E",        // dark slate
  BRAND_LIGHT,      // light burgundy
  "#D4AC0D",        // gold
];

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      display: false, // We use a custom inline legend
    },
    tooltip: {
      backgroundColor: "#1a1a1a",
      titleFont: { size: 11 },
      bodyFont: { size: 10 },
      padding: 8,
      cornerRadius: 4,
    },
  },
};

// ── Props ─────────────────────────────────────────────────────────

interface Props {
  hasModel: boolean;
}

// ── Component ─────────────────────────────────────────────────────

export function DashboardPanel({ hasModel }: Props) {
  const [kpis] = useState<KpiConfig[]>(DEFAULT_KPIS);
  const [charts] = useState<ChartConfig[]>(DEFAULT_CHARTS);
  const [chartData, setChartData] = useState<Map<string, ChartDataset | null>>(new Map());
  const [kpiValues, setKpiValues] = useState<Map<string, number | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    if (!hasModel) return;
    setLoading(true);

    // Fetch KPIs
    const kpiResults = new Map<string, number | null>();
    for (const kpi of kpis) {
      const val = await fetchKpi(kpi);
      kpiResults.set(kpi.id, val);
    }
    setKpiValues(kpiResults);

    // Fetch charts
    const chartResults = new Map<string, ChartDataset | null>();
    for (const chart of charts) {
      const data = await fetchChartData(chart);
      chartResults.set(chart.id, data);
    }
    setChartData(chartResults);

    setLoading(false);
    fetchedRef.current = true;
  }, [hasModel, kpis, charts]);

  useEffect(() => {
    if (hasModel && !fetchedRef.current) {
      const t = setTimeout(fetchAll, 1500); // Let viewer settle
      return () => clearTimeout(t);
    }
  }, [hasModel, fetchAll]);

  // ── Chart Renderers ─────────────────────────────────────────

  const renderChart = (config: ChartConfig) => {
    const data = chartData.get(config.id);
    if (!data) return <ChartSkeleton />;

    const scheme = config.colors ?? CHART_COLORS;
    const dataset = {
      labels: data.labels,
      datasets: [{
        data: data.values,
        backgroundColor: data.labels.map((_, i) => scheme[i % scheme.length]),
        borderColor: WHITE,
        borderWidth: 1,
      }],
    };

    const opts = {
      ...chartOptions,
      indexAxis: config.type === "horizontalBar" ? ("y" as const) : ("x" as const),
      plugins: {
        ...chartOptions.plugins,
        title: {
          display: true,
          text: config.title,
          font: { size: 11, weight: "bold" as const },
          color: BRAND,
          padding: { bottom: 8 },
        },
      },
    };

    if (config.type === "doughnut") return <Doughnut data={dataset} options={opts} />;
    if (config.type === "pie") return <Pie data={dataset} options={opts} />;
    return <Bar data={dataset} options={opts} />;
  };

  const renderInlineLegend = (config: ChartConfig) => {
    const data = chartData.get(config.id);
    if (!data) return null;

    const scheme = config.colors ?? CHART_COLORS;
    const total = data.total;

    return (
      <div className="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
        {data.labels.map((label, i) => {
          const pct = total > 0 ? ((data.values[i] / total) * 100).toFixed(1) : "0";
          return (
            <div key={label} className="flex items-center gap-1.5 text-[10px]">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: scheme[i % scheme.length] }}
              />
              <span className="text-gray-600 truncate flex-1">{label}</span>
              <span className="text-gray-400">{pct}%</span>
            </div>
          );
        })}
      </div>
    );
  };

  // ── KPI Renderers ───────────────────────────────────────────

  const renderKpi = (kpi: KpiConfig) => {
    const val = kpiValues.get(kpi.id) ?? null;
    const formatted = formatKpi(val, kpi.format ?? "number");
    return (
      <div
        key={kpi.id}
        className="flex-1 min-w-[80px] rounded-lg border border-brand-muted/20 bg-white p-2 text-center"
      >
        <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-0.5">
          {kpi.label}
        </p>
        <p className="text-sm font-bold text-brand">
          {formatted}
        </p>
      </div>
    );
  };

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-brand-muted/20 bg-brand-surface">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
            Dashboard
          </h3>
          <button
            onClick={fetchAll}
            disabled={loading || !hasModel}
            className="text-[10px] text-brand hover:underline disabled:text-gray-400"
          >
            {loading ? "⏳" : "↻"}
          </button>
        </div>
      </div>

      {/* No model */}
      {!hasModel && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-gray-400 text-center">
            Open a model to see analytics.
          </p>
        </div>
      )}

      {/* Loading */}
      {hasModel && loading && !fetchedRef.current && (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="animate-spin text-lg">⏳</div>
        </div>
      )}

      {/* Content */}
      {hasModel && fetchedRef.current && (
        <div className="flex-1 overflow-y-auto">
          {/* KPI Row */}
          <div className="flex flex-wrap gap-1.5 p-2 pb-1">
            {kpis.map(renderKpi)}
          </div>

          {/* Charts */}
          <div className="space-y-2 p-2 pt-0">
            {charts.map((config) => (
              <div
                key={config.id}
                className="rounded-lg border border-brand-muted/20 bg-white p-2"
              >
                <div className="h-36">
                  {renderChart(config)}
                </div>
                {renderInlineLegend(config)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────

function ChartSkeleton() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="w-full h-full rounded bg-brand-surface/50 animate-pulse" />
    </div>
  );
}

// ── Formatting ───────────────────────────────────────────────────

function formatKpi(val: number | null, format: string): string {
  if (val === null || val === undefined) return "—";
  switch (format) {
    case "currency":
      return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(val);
    case "percentage":
      return `${val}%`;
    case "number":
    default:
      return val.toLocaleString("es-CL");
  }
}
