/**
 * CategoryHeatmapService — DataViz-style API for property-category heatmaps.
 *
 * Architectural reference: Autodesk.DataVisualization extension
 *  (aps-iot-extensions-demo / forge-dataviz-iot-reference-app)
 *
 * Key adaptation: replaces "rooms" with property value groups.
 * Same pipeline: register colors → generate data → render → update.
 * Uses setThemingColor internally (element-level) rather than setupSurfaceShading
 * (room-level) because property categories span arbitrary dbId sets, not rooms.
 */
import {
  assignColors,
  toNumeric,
  hexToVector4,
} from "./color-scales";
import { getPropertyForElements, getLeafNodes } from "./property-service";
import type { ApsViewerAPI } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelHandle = any;

// ── Types ───────────────────────────────────────────────────────────

/** Color stop: value at normalized position (0..1) → color. */
export interface ColorStop {
  position: number; // 0 = min, 1 = max
  color: string;    // hex
}

/** A registered category with its color gradient. */
export interface CategoryRegistration {
  category: string;
  colorStops: ColorStop[];
  /** Get current value (0..1 normalized) for a given group. */
  getValue: (groupId: string) => number;
}

/** Callback: provides current normalized value for a property value group. */
export type ValueProvider = (propertyValue: string) => number;

// ── Service State ───────────────────────────────────────────────────

let registeredCategories = new Map<string, CategoryRegistration>();
let currentRendering: {
  registration: CategoryRegistration;
  groupDbIds: Map<string, number[]>;
} | null = null;

// ── Public API (mirrors DataViz extension surface) ──────────────────

/**
 * Register a category with its color gradient.
 * Like DataViz.registerSurfaceShadingColors(type, [0x00ff00, 0xff0000]).
 */
export function registerCategoryColors(
  category: string,
  colorStops: number[], // 0xRRGGBB format
  getValue: ValueProvider,
): void {
  registeredCategories.set(category, {
    category,
    colorStops: colorStops.map((c, i) => ({
      position: colorStops.length > 1 ? i / (colorStops.length - 1) : 0,
      color: `#${c.toString(16).padStart(6, "0")}`,
    })),
    getValue,
  });
}

/**
 * Generate category shading data — groups elements by property value
 * and computes normalized value per group.
 *
 * Like DataViz.ModelStructureInfo.generateSurfaceShadingData(devices).
 *
 * @param propertyName — the property to group by
 * @param scaleType — "sequential" or "diverging"
 */
export async function generateCategoryShadingData(
  viewer: GuiViewer3D,
  model: ModelHandle,
  propertyName: string,
  scaleType: "sequential" | "diverging" = "sequential",
): Promise<{
  groupDbIds: Map<string, number[]>;  // value → [dbId, ...]
  valueRange: [number, number];
  scaleType: "sequential" | "diverging";
}> {
  const leafDbIds = getLeafNodes(model);
  if (leafDbIds.length === 0) {
    return { groupDbIds: new Map(), valueRange: [0, 1], scaleType };
  }

  return new Promise((resolve) => {
    getPropertyForElements(viewer, leafDbIds, propertyName, (dbIdValueMap) => {
      // Group dbIds by value
      const groupDbIds = new Map<string, number[]>();
      const values: string[] = [];

      for (const [dbId, value] of dbIdValueMap) {
        const key = value || "(empty)";
        if (!groupDbIds.has(key)) groupDbIds.set(key, []);
        groupDbIds.get(key)!.push(dbId);
        values.push(key);
      }

      // Compute numeric range
      const nums = values.map(toNumeric).filter((n) => !isNaN(n));
      const valueRange: [number, number] =
        nums.length > 0 ? [Math.min(...nums), Math.max(...nums)] : [0, 1];

      resolve({ groupDbIds, valueRange, scaleType });
    });
  });
}

/**
 * Render the heatmap — applies color to all elements.
 * Like DataViz.renderSurfaceShading(floor.name, "temperature", getSensorValue).
 *
 * Unlike DataViz, this does NOT need a floor/level selector because
 * we're coloring elements by property, not rooms on a level.
 */
export async function renderCategoryHeatmap(
  propertyName: string,
  scaleType: "sequential" | "diverging" | "categorical" = "sequential",
  onProgress: (msg: string) => void,
  onComplete: () => void,
): Promise<void> {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  if (!api) return;

  const viewer = api.getViewer() as GuiViewer3D;
  const models = api.getModels() as ModelHandle[];
  if (!viewer || !models?.length) return;

  const model = models[0];

  // Generate shading data (value groups)
  // generateCategoryShadingData only needs sequential/diverging for numeric range
  const shadingType = scaleType === "categorical" ? "sequential" : scaleType;
  onProgress(`Grouping elements by "${propertyName}"…`);
  const { groupDbIds, valueRange } = await generateCategoryShadingData(
    viewer, model, propertyName, shadingType,
  );

  if (groupDbIds.size === 0) {
    onComplete();
    return;
  }

  const [min, max] = valueRange;
  onProgress(`Coloring ${groupDbIds.size} groups (${min.toFixed(1)} – ${max.toFixed(1)})…`);

  // Build color map: each value group → gradient color
  const colorMap = assignColors(
    Array.from(groupDbIds.keys()),
    scaleType === "categorical" ? "categorical" : scaleType === "diverging" ? "diverging" : "sequential",
  );

  // Clear previous coloring
  clearHeatmap();

  // Apply colors
  const THREE = (window as unknown as Record<string, unknown>).THREE as {
    Vector4: new (r: number, g: number, b: number, a: number) => unknown;
  };

  for (const [value, dbIds] of groupDbIds) {
    const hex = colorMap.get(value) || "#7f7f7f";
    const color = hexToVector4(hex);
    const vec4 = new THREE.Vector4(color.x, color.y, color.z, color.w);

    for (const dbId of dbIds) {
      try {
        viewer.setThemingColor(dbId, vec4, model);
      } catch {
        // Skip unloaded geometry
      }
    }
  }

  // Force re-render
  try { viewer.impl.invalidate(false, false, true); } catch { /* ignore */ }

  // Store current rendering state
  const scaleGradient = scaleType === "diverging"
    ? ["#053061","#2166ac","#4393c3","#92c5de","#d1e5f0","#f7f7f7","#fddbc7","#f4a582","#d6604d","#b2182b","#67001f"]
    : ["#f7fbff","#deebf7","#c6dbef","#9ecae1","#6baed6","#4292c6","#2171b5","#08519c","#08306b"];

  currentRendering = {
    registration: {
      category: propertyName,
      colorStops: scaleGradient.map((hex: string, i: number) => ({
        position: i / (scaleGradient.length - 1),
        color: hex,
      })),
      getValue: (groupId: string) => {
        const n = toNumeric(groupId);
        if (isNaN(n) || max === min) return 0.5;
        return Math.max(0, Math.min(1, (n - min) / (max - min)));
      },
    },
    groupDbIds,
  };

  onComplete();
}

/**
 * Lightweight update — recalculates values without re-grouping.
 * Like DataViz.updateSurfaceShading(getSensorValue).
 * Currently a no-op for static property values; in the future with
 * real-time data, this would re-apply colors based on new values.
 */
export function updateCategoryHeatmap(): void {
  if (!currentRendering) return;

  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  if (!api) return;

  const viewer = api.getViewer() as GuiViewer3D;
  const models = api.getModels() as ModelHandle[];
  if (!viewer || !models?.length) return;

  const model = models[0];
  const THREE = (window as unknown as Record<string, unknown>).THREE as {
    Vector4: new (r: number, g: number, b: number, a: number) => unknown;
  };
  const { registration, groupDbIds } = currentRendering;

  for (const [value, dbIds] of groupDbIds) {
    const v = registration.getValue(value);
    const idx = v * (registration.colorStops.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, registration.colorStops.length - 1);
    const frac = idx - lo;

    // Lerp between stops
    const cs = registration.colorStops[lo].color;
    const ce = registration.colorStops[hi].color;
    const hex = lerpHex(cs, ce, frac);
    const color = hexToVector4(hex);
    const vec4 = new THREE.Vector4(color.x, color.y, color.z, color.w);

    for (const dbId of dbIds) {
      try { viewer.setThemingColor(dbId, vec4, model); } catch { /* skip */ }
    }
  }
  try { viewer.impl.invalidate(false, false, true); } catch { /* ignore */ }
}

/** Clear the heatmap — removes all theming colors. */
export function clearHeatmap(): void {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  if (!api) return;

  const viewer = api.getViewer() as GuiViewer3D;
  const models = api.getModels() as ModelHandle[];
  if (!viewer || !models?.length) return;

  for (const model of models) {
    try { viewer.clearThemingColors(model); } catch { /* ignore */ }
  }
  try { viewer.impl.invalidate(false, false, true); } catch { /* ignore */ }

  currentRendering = null;
}

export function getCurrentHeatmap() {
  return currentRendering;
}

// ── Internal ────────────────────────────────────────────────────────

function lerpHex(a: string, b: string, t: number): string {
  const ca = {
    r: parseInt(a.slice(1, 3), 16),
    g: parseInt(a.slice(3, 5), 16),
    b: parseInt(a.slice(5, 7), 16),
  };
  const cb = {
    r: parseInt(b.slice(1, 3), 16),
    g: parseInt(b.slice(3, 5), 16),
    b: parseInt(b.slice(5, 7), 16),
  };
  const rc = Math.round(ca.r + (cb.r - ca.r) * t);
  const gc = Math.round(ca.g + (cb.g - ca.g) * t);
  const bc = Math.round(ca.b + (cb.b - ca.b) * t);
  return (
    "#" +
    rc.toString(16).padStart(2, "0") +
    gc.toString(16).padStart(2, "0") +
    bc.toString(16).padStart(2, "0")
  );
}
