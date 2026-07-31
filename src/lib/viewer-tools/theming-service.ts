/**
 * Theming Service — applies color to model elements by property value.
 *
 * Stage 2: color-by-property, clear, and the active coloring state.
 * Stage 3: auto-detects numeric properties → continuous gradient coloring.
 */
import { assignColors, isNumericProperty, toNumeric, hexToVector4 } from "./color-scales";
import { getPropertyForElements, getLeafNodes } from "./property-service";
import type { ApsViewerAPI } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelHandle = any;

export type ScaleType = "categorical" | "sequential" | "diverging";

export interface ActiveColoring {
  propertyName: string;
  colorMap: Map<string, string>;  // value → hex color
  scaleType: ScaleType;
  /** For gradient scales: [min, max] of the numeric values. */
  numericRange?: [number, number];
}

let currentColoring: ActiveColoring | null = null;

/** Get the current active coloring (if any). */
export function getActiveColoring(): ActiveColoring | null {
  return currentColoring;
}

/**
 * Color all elements in the viewer by a specific property's values.
 * Stage 3: auto-detects numeric values and chooses gradient vs categorical.
 * Clears any previous coloring first.
 */
export function applyColorByProperty(
  propertyName: string,
  scaleHint: ScaleType = "categorical",
  onProgress: (msg: string) => void,
  onComplete: () => void,
): void {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  if (!api) return;

  const viewer = api.getViewer() as GuiViewer3D;
  const models = api.getModels() as ModelHandle[];
  if (!viewer || !models?.length) return;

  const model = models[0];
  const leafDbIds = getLeafNodes(model);

  if (leafDbIds.length === 0) {
    onComplete();
    return;
  }

  onProgress(`Reading "${propertyName}" for ${leafDbIds.length} elements…`);

  getPropertyForElements(viewer, leafDbIds, propertyName, (dbIdValueMap) => {
    // Collect all unique values
    const allValues: string[] = [];
    const valueGroups = new Map<string, number[]>();
    for (const [dbId, value] of dbIdValueMap) {
      const key = value || "(empty)";
      if (!valueGroups.has(key)) valueGroups.set(key, []);
      valueGroups.get(key)!.push(dbId);
      allValues.push(key);
    }

    // The unique set for scale detection
    const uniqueValues = Array.from(valueGroups.keys());

    // Auto-detect: numeric properties → sequential, else categorical
    const autoScale: ScaleType =
      scaleHint !== "categorical"
        ? scaleHint
        : isNumericProperty(uniqueValues.filter((v) => v !== "(empty)"))
          ? "sequential"
          : "categorical";

    // Assign colors
    const colorMap = assignColors(uniqueValues, autoScale);

    // Compute numeric range for gradient legends
    let numericRange: [number, number] | undefined;
    if (autoScale === "sequential" || autoScale === "diverging") {
      const nums = uniqueValues.map(toNumeric).filter((n) => !isNaN(n));
      if (nums.length > 0) {
        numericRange = [Math.min(...nums), Math.max(...nums)];
      }
    }

    // Clear previous coloring
    clearColoring();

    // Apply new coloring
    const THREE = (window as unknown as Record<string, unknown>).THREE as {
      Vector4: new (r: number, g: number, b: number, a: number) => unknown;
    };

    for (const [value, dbIds] of valueGroups) {
      const hex = colorMap.get(value) || "#7f7f7f";
      const color = hexToVector4(hex);
      const vec4 = new THREE.Vector4(color.x, color.y, color.z, color.w);

      for (const dbId of dbIds) {
        try {
          viewer.setThemingColor(dbId, vec4, model);
        } catch {
          // Some dbIds might not have geometry loaded — skip
        }
      }
    }

    // Force re-render
    try { viewer.impl.invalidate(false, false, true); } catch { /* ignore */ }

    currentColoring = { propertyName, colorMap, scaleType: autoScale, numericRange };
    onComplete();
  });
}

/** Remove all theming colors and reset the active coloring state. */
export function clearColoring(): void {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  if (!api) return;

  const viewer = api.getViewer() as GuiViewer3D;
  const models = api.getModels() as ModelHandle[];
  if (!viewer || !models?.length) return;

  for (const model of models) {
    try { viewer.clearThemingColors(model); } catch { /* ignore */ }
  }
  try { viewer.impl.invalidate(false, false, true); } catch { /* ignore */ }

  currentColoring = null;
}
