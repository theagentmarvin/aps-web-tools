/**
 * Chart Data Provider — flexible data sources for dashboard charts.
 *
 * Supports two source types:
 *   1. ModelDataSource — pulls from APS Viewer getBulkProperties
 *   2. ExternalDataSource — accepts arbitrary arrays / async fetchers
 *
 * Each source resolves to { labels: string[], values: number[], total: number }
 */

import type { ApsViewerAPI } from "./types";
import { getLeafNodes } from "./property-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelHandle = any;

// ── Types ─────────────────────────────────────────────────────────

export interface ChartDataset {
  labels: string[];
  values: number[];
  total: number;
}

export type ChartType = "bar" | "horizontalBar" | "doughnut" | "pie" | "line";

export interface ChartConfig {
  id: string;
  title: string;
  type: ChartType;
  /** Model property to group by (e.g. "Material", "Category", "Level"). */
  propertyName: string;
  /** Max number of slices/bars to show. Rest grouped as "Other". */
  maxSlices?: number;
  /** Color palette override (hex arrays). Falls back to SalfaCorp brand. */
  colors?: string[];
}

export interface KpiConfig {
  id: string;
  label: string;
  /** Value source: "elements" = model element count, or a property name. */
  source: "elements" | string;
  format?: "number" | "percentage" | "currency";
}

export interface ExternalSource {
  fetch: () => Promise<ChartDataset>;
}

// ── Default Configs ───────────────────────────────────────────────

/** Top 5 charts for construction digital twin PoC. */
export const DEFAULT_CHARTS: ChartConfig[] = [
  {
    id: "material",
    title: "Material Distribution",
    type: "doughnut",
    propertyName: "Material",
    maxSlices: 8,
  },
  {
    id: "category",
    title: "Element Categories",
    type: "horizontalBar",
    propertyName: "Category",
    maxSlices: 10,
  },
  {
    id: "level",
    title: "Elements by Level",
    type: "bar",
    propertyName: "Level",
    maxSlices: 12,
  },
  {
    id: "phase",
    title: "Phase Distribution",
    type: "doughnut",
    propertyName: "Phase Created",
    maxSlices: 6,
  },
  {
    id: "type",
    title: "Top Element Types",
    type: "horizontalBar",
    propertyName: "Type",
    maxSlices: 10,
  },
];

/** Top 5 KPIs for construction digital twin PoC. */
export const DEFAULT_KPIS: KpiConfig[] = [
  { id: "total-elements", label: "Total Elements", source: "elements", format: "number" },
  { id: "unique-materials", label: "Unique Materials", source: "Material", format: "number" },
  { id: "unique-categories", label: "Categories", source: "Category", format: "number" },
  { id: "unique-types", label: "Element Types", source: "Type", format: "number" },
  { id: "levels", label: "Floors / Levels", source: "Level", format: "number" },
];

// ── Data Pipeline ─────────────────────────────────────────────────

/**
 * Fetch chart data from the model's property database.
 * Groups elements by property value, returns top-N labels + values.
 */
export async function fetchModelChartData(
  config: ChartConfig,
): Promise<ChartDataset | null> {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  const models = api?.getModels() as ModelHandle[];
  if (!models?.length) return null;

  const model = models[0];
  const allDbIds = getLeafNodes(model);
  if (allDbIds.length === 0) return null;

  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (model as any).getBulkProperties2(
      allDbIds.slice(0, 5000), // cap for performance
      { ignoreHidden: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (results: any[]) => {
        const valueMap = new Map<string, number>();

        for (const elem of results) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prop = (elem.properties || []).find((p: any) =>
            p.displayName === config.propertyName ||
            p.attributeName === config.propertyName,
          );
          const val = String(prop?.displayValue ?? "(unknown)");
          valueMap.set(val, (valueMap.get(val) || 0) + 1);
        }

        // Sort by count desc, limit slices
        const sorted = Array.from(valueMap.entries())
          .sort((a, b) => b[1] - a[1]);

        const max = config.maxSlices ?? 10;
        const top = sorted.slice(0, max);
        const rest = sorted.slice(max).reduce((sum, [, c]) => sum + c, 0);

        const labels = top.map(([l]) => l);
        const values = top.map(([, v]) => v);
        if (rest > 0) {
          labels.push("Other");
          values.push(rest);
        }

        resolve({
          labels,
          values,
          total: values.reduce((a, b) => a + b, 0),
        });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: any) => {
        console.error(`[chart-data] ${config.propertyName}:`, err);
        resolve(null);
      },
    );
  });
}

/**
 * Fetch KPI value from model data.
 * - source: "elements" → returns total leaf element count
 * - source: property name → returns count of unique values for that property
 */
export async function fetchModelKpi(
  kpi: KpiConfig,
): Promise<number | null> {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  const models = api?.getModels() as ModelHandle[];
  if (!models?.length) return null;

  const model = models[0];
  const allDbIds = getLeafNodes(model);
  if (allDbIds.length === 0) return null;

  if (kpi.source === "elements") {
    return allDbIds.length;
  }

  return new Promise((resolve) => {
    const sampleSize = Math.min(2000, allDbIds.length);
    const step = Math.max(1, Math.floor(allDbIds.length / sampleSize));
    const sample = allDbIds.filter((_, i) => i % step === 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (model as any).getBulkProperties2(
      sample,
      { ignoreHidden: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (results: any[]) => {
        const uniqueValues = new Set<string>();
        for (const elem of results) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prop = (elem.properties || []).find((p: any) =>
            p.displayName === kpi.source || p.attributeName === kpi.source,
          );
          if (prop) uniqueValues.add(String(prop.displayValue));
        }
        resolve(uniqueValues.size);
      },
      () => resolve(null),
    );
  });
}

// ── External Source Support ───────────────────────────────────────

/** Map of external data sources keyed by chart ID. */
const externalSources = new Map<string, ExternalSource>();
const externalKpis = new Map<string, () => Promise<number>>();

export function registerExternalSource(chartId: string, source: ExternalSource): void {
  externalSources.set(chartId, source);
}

export function registerExternalKpi(kpiId: string, fetcher: () => Promise<number>): void {
  externalKpis.set(kpiId, fetcher);
}

export async function fetchChartData(config: ChartConfig): Promise<ChartDataset | null> {
  // Check external first
  if (externalSources.has(config.id)) {
    return externalSources.get(config.id)!.fetch();
  }
  return fetchModelChartData(config);
}

export async function fetchKpi(kpi: KpiConfig): Promise<number | null> {
  if (externalKpis.has(kpi.id)) {
    return externalKpis.get(kpi.id)!();
  }
  return fetchModelKpi(kpi);
}
