/**
 * Shared Chart.js theme (extracted from DashboardPanel's styling, spec §6.2).
 */
import { BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, Tooltip, type ChartOptions } from "chart.js";

ChartJS.register(BarElement, CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend);

export const BRAND = "#A32428";
export const MUTED = "#8D9299";

/** ACC status colours (match BRAND.md badges). */
export const STATUS_COLORS = {
  active: "#A16207",
  reviewed: "#A32428",
  resolved: "#15803D",
  closed: "#9CA3AF",
} as const;

/** Secondary series colour (neutral slate) paired with brand. */
export const SERIES_2 = "#475569";

export function baseOptions(opts: { stacked?: boolean; horizontal?: boolean; legend?: boolean } = {}): ChartOptions<"bar"> {
  const grid = { color: "rgba(141,146,153,0.15)" };
  const ticks = { color: "#4B5563", font: { size: 11 } };
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: opts.horizontal ? "y" : "x",
    animation: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? false : undefined,
    plugins: {
      legend: { display: opts.legend ?? true, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, color: "#374151", font: { size: 11 } } },
      tooltip: {
        backgroundColor: "rgba(30,30,30,0.92)",
        titleColor: "#fff",
        bodyColor: "#e5e7eb",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        padding: 8,
        cornerRadius: 6,
      },
    },
    scales: {
      x: { stacked: opts.stacked, grid, ticks },
      y: { stacked: opts.stacked, grid, ticks, beginAtZero: true },
    },
  };
}
