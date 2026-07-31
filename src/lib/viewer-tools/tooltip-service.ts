/**
 * Tooltip Service — floating popup info cards on model elements.
 *
 * Reference: Autodesk ObjectTooltipExtension (Stack Overflow 79133029) —
 * uses OBJECT_UNDER_MOUSE_CHANGED + worldToClient + getProperties2.
 * Pattern: wallabyway/markupExt info-card — single DIV, translate3d positioning.
 */

import type { ApsViewerAPI } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;

interface TooltipContent {
  name: string;
  dbId: number;
  properties: { name: string; value: string }[];
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: TooltipContent | null;
}

type TooltipListener = (state: TooltipState) => void;

let currentDbId = -1;
let listeners: TooltipListener[] = [];
let watching = false;

// ── Public API ────────────────────────────────────────────────────

export function subscribeToTooltip(listener: TooltipListener): () => void {
  listeners.push(listener);
  startWatching();
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

export function getTooltipState(): TooltipState {
  return {
    visible: currentDbId >= 0,
    x: 0,
    y: 0,
    content: null,
  };
}

// ── Start Watching ────────────────────────────────────────────────

function startWatching(): void {
  if (watching) return;

  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  const viewer = api?.getViewer() as GuiViewer3D;
  if (!viewer) return;

  watching = true;

  // Use OBJECT_UNDER_MOUSE_CHANGED (v7 API) for hover tracking
  viewer.addEventListener(
    (window.Autodesk?.Viewing as Record<string, string>)?.["OBJECT_UNDER_MOUSE_CHANGED"] || "OBJECT_UNDER_MOUSE_CHANGED",
    (event: { dbId: number; modelId?: number }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleHoverChange(event as any);
    },
  );
}

async function handleHoverChange(event: { dbId: number; modelId?: number }): Promise<void> {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  const viewer = api?.getViewer() as GuiViewer3D;
  if (!viewer) return;

  // -1 = nothing under cursor
  if (event.dbId === -1 || event.dbId == null) {
    currentDbId = -1;
    notify({ visible: false, x: 0, y: 0, content: null });
    return;
  }

  // Don't refetch if same element
  if (event.dbId === currentDbId) return;
  currentDbId = event.dbId;

  try {
    const model = viewer.model;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props: any = await new Promise((resolve, reject) => {
      model.getProperties2(event.dbId, resolve, reject);
    });

    // Get element world position from bounding box center
    const bbox = getBoundingBox(event.dbId, model);
    const center = bbox.center;

    // Convert world → screen
    const Vec3 = (window.THREE as unknown as Record<string, unknown>).Vector3 as { new(x: number, y: number, z: number): { x: number; y: number; z: number } };
    const screenPos = viewer.worldToClient(new Vec3(center.x, center.y, center.z)) as { x: number; y: number };

    notify({
      visible: true,
      x: screenPos.x,
      y: screenPos.y,
      content: {
        name: props?.name || `Element #${event.dbId}`,
        dbId: event.dbId,
        properties: extractTopProperties(props?.properties || []),
      },
    });
  } catch {
    currentDbId = -1;
    notify({ visible: false, x: 0, y: 0, content: null });
  }
}

function notify(state: TooltipState): void {
  for (const fn of listeners) {
    try { fn(state); } catch { /* ignore */ }
  }
}

// ── World Position Helpers ────────────────────────────────────────

function getBoundingBox(dbId: number, model: {
  getInstanceTree: () => {
    enumNodeFragments: (dbId: number, cb: (fragId: number) => void, recursive: boolean) => void;
  };
  getFragmentList: () => {
    getWorldBounds: (fragId: number, box: unknown) => void;
  };
}): { center: { x: number; y: number; z: number } } {
  const tree = model.getInstanceTree();
  const fragList = model.getFragmentList();
  const THREE = window.THREE as unknown as Record<string, unknown>;
  const Box3 = THREE.Box3 as { new(): unknown } | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bounds: any;

  try {
    bounds = Box3 ? new Box3() : new ((THREE.Box3) as unknown as { new(): unknown })();
  } catch {
    // Fallback: no bounding box, return zero
    return { center: { x: 0, y: 0, z: 0 } };
  }

  tree.enumNodeFragments(dbId, (fragId: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const box: any = (() => { try { const b = Box3 ? new Box3() : {}; return b; } catch { return {}; } })();
    try { fragList.getWorldBounds(fragId, box); } catch { return; }
    if (bounds.expandByPoint) {
      try {
        bounds.expandByPoint(box.min);
        bounds.expandByPoint(box.max);
      } catch { /* ignore */ }
    }
  }, true);

  const center = {
    x: bounds.center?.()?.x ?? 0,
    y: bounds.center?.()?.y ?? 0,
    z: bounds.center?.()?.z ?? 0,
  };
  return { center };
}

// ── Property Extraction ────────────────────────────────────────────

function extractTopProperties(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: any[],
  max = 4,
): { name: string; value: string }[] {
  const priority = ["Name", "Material", "Category", "Type", "Phase", "Level"];
  const picked: { name: string; value: string }[] = [];

  // First pass: pick priority props
  for (const key of priority) {
    const p = properties.find((pr) => pr?.displayName === key || pr?.attributeName === key);
    if (p) {
      picked.push({
        name: p.displayName || p.attributeName,
        value: String(p.displayValue ?? p.displayCategory ?? ""),
      });
    }
  }

  // Second pass: fill remaining slots
  for (const p of properties) {
    if (picked.length >= max) break;
    if (!picked.some((e) => e.name === (p.displayName || p.attributeName))) {
      picked.push({
        name: p.displayName || p.attributeName,
        value: String(p.displayValue ?? ""),
      });
    }
  }

  return picked.slice(0, max);
}
