/**
 * Theming Service — applies color to model elements by property value.
 *
 * Stage 2: color-by-property, clear, and the active coloring state.
 */
import { assignColors, hexToVector4 } from "./color-scales";
import { getPropertyForElements, getLeafNodes } from "./property-service";
import type { ApsViewerAPI } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelHandle = any;

export interface ActiveColoring {
  propertyName: string;
  colorMap: Map<string, string>;  // value → hex color
}

let currentColoring: ActiveColoring | null = null;

/** Get the current active coloring (if any). */
export function getActiveColoring(): ActiveColoring | null {
  return currentColoring;
}

/**
 * Color all elements in the viewer by a specific property's values.
 * Clears any previous coloring first.
 */
export function applyColorByProperty(
  propertyName: string,
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
    // Group dbIds by value
    const valueGroups = new Map<string, number[]>();
    for (const [dbId, value] of dbIdValueMap) {
      const key = value || "(empty)";
      if (!valueGroups.has(key)) valueGroups.set(key, []);
      valueGroups.get(key)!.push(dbId);
    }

    // Assign colors based on frequency (most common first)
    const sortedValues = Array.from(valueGroups.entries())
      .sort((a, b) => b[1].length - a[1].length);
    const colorMap = assignColors(sortedValues.map(([v]) => v));

    // Clear previous coloring
    clearColoring();

    // Apply new coloring
    const THREE = (window as unknown as Record<string, unknown>).THREE as {
      Vector4: new (r: number, g: number, b: number, a: number) => unknown;
    };

    for (const [value, dbIds] of sortedValues) {
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

    currentColoring = { propertyName, colorMap };
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
