/**
 * Clash pair visualisation (docs/ux/coordinator-ux-spec.md §3.8).
 *
 * Differences from shader-effects.ts (kept for /data-management):
 *  - multi-model: every side is a list of { model, dbIds } and every call is
 *    resolved against that model (dbIds are per model);
 *  - context via NATIVE isolate/ghosting (no overlay meshes for non-selected
 *    geometry, so cost is O(selection), not O(model));
 *  - two simultaneous glow overlay scenes (A blue, B orange) plus a solid
 *    theming tint so colours read even when the glow is faint;
 *  - overlay meshes cached per (model, dbId, side) — LRU 2 000 — so j/k back
 *    and forth is instant; disposeClashCache() on test change;
 *  - static glow under prefers-reduced-motion.
 *
 * Viewer v7 calls used: setGhosting, isolate(ids, model), hide(ids, model),
 * show(ids, model), showAll, setThemingColor(dbId, Vector4, model, recursive),
 * clearThemingColors(model), impl.getRenderProxy(model, fragId),
 * impl.createOverlayScene/addOverlay/removeOverlay/removeOverlayScene,
 * navigation.fitBounds(immediate, box), Autodesk.Section setSectionBox.
 */
import { addObjectMarker, addSonarMarker, clearAllMarkers, setMarkerClickHandler } from "./marker-service";
import type { ApsViewerAPI } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Model = any;
type Viewer = any;
type Box3 = any;
type Vec3 = { x: number; y: number; z: number };

export interface ClashSide {
  model: Model;
  dbIds: number[];
}

export type ClashViewMode = "isolate" | "xray" | "context";

export interface ShowClashOptions {
  mode: ClashViewMode;
  colorA: string;
  colorB: string;
  glow?: boolean;
  /** Above this many dbIds per side, skip glow overlays (theming tint only). */
  maxGlowIds?: number;
  /** Fit the camera to the union bbox (default true). */
  fit?: boolean;
}

export interface ShowClashResult {
  /** True when the glow was skipped because a side exceeded maxGlowIds. */
  simplified: boolean;
  /** Union world bbox of both sides (null if no geometry found). */
  bbox: Box3 | null;
}

export interface ClashMarkerSpec {
  /** Caller id, returned by the click handler. */
  id: string;
  label: string;
  position: Vec3;
  active: boolean;
}

const SCENE_A = "clash-glow-a";
const SCENE_B = "clash-glow-b";
const CACHE_MAX = 2000;

// ── Module state ───────────────────────────────────────────────────

interface State {
  a: ClashSide[];
  b: ClashSide[];
  opts: ShowClashOptions | null;
  side: "a" | "b" | "both";
  themedModels: Set<Model>;
  bbox: Box3 | null;
  sectionOn: boolean;
}

const state: State = { a: [], b: [], opts: null, side: "both", themedModels: new Set(), bbox: null, sectionOn: false };
const meshCache = new Map<string, any[]>(); // key `${modelId}:${dbId}:${side}` → meshes (LRU via Map order)
const materials: { a: any | null; b: any | null } = { a: null, b: null };
let animationId: number | null = null;
const markerIdMap = new Map<string, string>(); // marker-service id → caller id

// ── Access helpers ─────────────────────────────────────────────────

function getViewer(): Viewer | null {
  const api = (window as unknown as Record<string, ApsViewerAPI | undefined>).__apsViewer;
  return (api?.getViewer() as Viewer) ?? null;
}

function THREE(): any {
  return (window as any).THREE ?? {};
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function hexToVec(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function modelId(model: Model): string {
  try {
    return String(model.id ?? model.getModelId?.() ?? model.getData?.()?.urn ?? "m");
  } catch {
    return "m";
  }
}

function allModels(viewer: Viewer): Model[] {
  try {
    return viewer.getAllModels?.() ?? viewer.impl?.modelQueue?.().getModels?.() ?? (viewer.model ? [viewer.model] : []);
  } catch {
    return viewer.model ? [viewer.model] : [];
  }
}

/** Merge sides that point at the same model. */
function bySide(sides: ClashSide[]): Map<Model, number[]> {
  const m = new Map<Model, number[]>();
  for (const s of sides) {
    if (!s.model) continue;
    const list = m.get(s.model) ?? [];
    list.push(...s.dbIds);
    m.set(s.model, list);
  }
  return m;
}

// ── Glow materials / overlays ──────────────────────────────────────

const GLOW_VERTEX = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GLOW_FRAGMENT = `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
void main() {
  float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
  gl_FragColor = vec4(uColor * uIntensity * pulse, 0.45);
}`;

function makeGlowMaterial(viewer: Viewer, hex: string, name: string): any | null {
  const T = THREE();
  if (!T.ShaderMaterial) return null;
  const c = hexToVec(hex);
  const ColorCtor = T.Color ?? T.Vector3;
  const mat = new T.ShaderMaterial({
    uniforms: {
      uColor: { type: "c", value: new ColorCtor(c.r, c.g, c.b) },
      uIntensity: { type: "f", value: 1.4 },
      uTime: { type: "f", value: 0 },
    },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    depthTest: false, // visible through ghosted context ("x-ray" read)
    depthWrite: false,
    blending: T.AdditiveBlending ?? 2,
    side: T.DoubleSide ?? 2,
  });
  try {
    viewer.impl.matman().addMaterial(name, mat, true);
  } catch {
    /* older viewers: material still works without registration */
  }
  return mat;
}

function ensureScene(viewer: Viewer, name: string) {
  try {
    if (!viewer.impl.overlayScenes?.[name]) viewer.impl.createOverlayScene(name);
  } catch {
    /* exists */
  }
}

function clearScene(viewer: Viewer, name: string) {
  try {
    viewer.impl.clearOverlay?.(name);
  } catch {
    /* ignore */
  }
  try {
    viewer.impl.removeOverlayScene?.(name);
  } catch {
    /* ignore */
  }
}

function meshesFor(viewer: Viewer, model: Model, dbId: number, side: "a" | "b", material: any): any[] {
  const key = `${modelId(model)}:${dbId}:${side}`;
  const hit = meshCache.get(key);
  if (hit) {
    meshCache.delete(key);
    meshCache.set(key, hit);
    return hit;
  }
  const T = THREE();
  const out: any[] = [];
  try {
    const tree = model.getInstanceTree?.();
    if (!tree || !T.Mesh) return out;
    tree.enumNodeFragments(
      dbId,
      (fragId: number) => {
        try {
          const proxy = viewer.impl.getRenderProxy(model, fragId);
          if (!proxy?.geometry) return;
          const mesh = new T.Mesh(proxy.geometry, material);
          mesh.matrix.copy(proxy.matrixWorld);
          mesh.matrixWorldNeedsUpdate = true;
          mesh.matrixAutoUpdate = false;
          mesh.frustumCulled = false;
          out.push(mesh);
        } catch {
          /* skip fragment */
        }
      },
      true,
    );
  } catch {
    /* invalid dbId for this model */
  }
  meshCache.set(key, out);
  while (meshCache.size > CACHE_MAX) {
    const oldest = meshCache.keys().next().value as string;
    meshCache.delete(oldest);
  }
  return out;
}

function addGlow(viewer: Viewer, sides: Map<Model, number[]>, side: "a" | "b", scene: string, material: any) {
  ensureScene(viewer, scene);
  for (const [model, ids] of sides)
    for (const id of ids)
      for (const mesh of meshesFor(viewer, model, id, side, material)) {
        try {
          viewer.impl.addOverlay(scene, mesh);
        } catch {
          /* ignore */
        }
      }
}

function startPulse() {
  if (animationId !== null || reducedMotion()) return;
  const start = performance.now();
  const tick = (now: number) => {
    const tsec = (now - start) / 1000;
    for (const m of [materials.a, materials.b]) if (m?.uniforms?.uTime) m.uniforms.uTime.value = tsec;
    try {
      getViewer()?.impl.invalidate(false, false, true);
    } catch {
      /* ignore */
    }
    animationId = state.opts ? requestAnimationFrame(tick) : null;
  };
  animationId = requestAnimationFrame(tick);
}

function stopPulse() {
  if (animationId !== null) cancelAnimationFrame(animationId);
  animationId = null;
}

// ── Bounding boxes ─────────────────────────────────────────────────

function elementBox(model: Model, dbIds: number[]): Box3 | null {
  const T = THREE();
  if (!T.Box3) return null;
  const box = new T.Box3();
  const tmp = new T.Box3();
  let any = false;
  try {
    const tree = model.getInstanceTree?.();
    const frags = model.getFragmentList?.();
    if (!tree || !frags) return null;
    for (const id of dbIds)
      tree.enumNodeFragments(
        id,
        (fragId: number) => {
          frags.getWorldBounds(fragId, tmp);
          box.union(tmp);
          any = true;
        },
        true,
      );
  } catch {
    return any ? box : null;
  }
  return any ? box : null;
}

function sideBox(sides: ClashSide[]): Box3 | null {
  let out: Box3 | null = null;
  for (const s of sides) {
    const b = elementBox(s.model, s.dbIds);
    if (!b) continue;
    out = out ? out.union(b) : b;
  }
  return out;
}

/**
 * Clash point: per axis, the midpoint of the overlap interval of A's and B's
 * bboxes. When the boxes do not overlap on an axis (clearance clash) this is
 * the midpoint between the closest faces — one formula covers both cases.
 */
export function computeClashPoint(a: ClashSide[], b: ClashSide[]): Vec3 | null {
  const ba = sideBox(a);
  const bb = sideBox(b);
  if (!ba || !bb) return null;
  const mid = (axis: "x" | "y" | "z") => {
    const lo = Math.max(ba.min[axis], bb.min[axis]);
    const hi = Math.min(ba.max[axis], bb.max[axis]);
    return (lo + hi) / 2;
  };
  return { x: mid("x"), y: mid("y"), z: mid("z") };
}

function unitScale(model: Model): number {
  try {
    return model.getUnitScale?.() || 1;
  } catch {
    return 1;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function showClashPair(a: ClashSide[], b: ClashSide[], opts: ShowClashOptions): ShowClashResult {
  const viewer = getViewer();
  if (!viewer) return { simplified: false, bbox: null };
  resetVisuals(viewer);

  state.a = a;
  state.b = b;
  state.opts = opts;
  state.side = "both";

  const sa = bySide(a);
  const sb = bySide(b);
  const involved = new Map<Model, number[]>();
  for (const [m, ids] of [...sa, ...sb]) involved.set(m, [...(involved.get(m) ?? []), ...ids]);

  // 1. Context: native ghosting/isolate per model.
  applyContext(viewer, involved, opts.mode);

  // 2. Solid tint A/B (colours read even at low glow).
  const T = THREE();
  const tint = (sides: Map<Model, number[]>, hex: string) => {
    if (!T.Vector4) return;
    const c = hexToVec(hex);
    const v = new T.Vector4(c.r, c.g, c.b, 0.6);
    for (const [model, ids] of sides) {
      state.themedModels.add(model);
      for (const id of ids) {
        try {
          viewer.setThemingColor(id, v, model, true);
        } catch {
          /* ignore */
        }
      }
    }
  };
  tint(sa, opts.colorA);
  tint(sb, opts.colorB);

  // 3. Glow overlays (capped).
  const max = opts.maxGlowIds ?? 200;
  const countA = a.reduce((s, x) => s + x.dbIds.length, 0);
  const countB = b.reduce((s, x) => s + x.dbIds.length, 0);
  const simplified = countA > max || countB > max;
  if (opts.glow !== false && !simplified) {
    materials.a ??= makeGlowMaterial(viewer, opts.colorA, "clash-glow-a-mat");
    materials.b ??= makeGlowMaterial(viewer, opts.colorB, "clash-glow-b-mat");
    if (materials.a) addGlow(viewer, sa, "a", SCENE_A, materials.a);
    if (materials.b) addGlow(viewer, sb, "b", SCENE_B, materials.b);
    startPulse();
  }

  // 4. Camera.
  const ba = sideBox(a);
  const bb = sideBox(b);
  state.bbox = ba && bb ? ba.clone().union(bb) : ba ?? bb;
  if (opts.fit !== false) fitToCurrent();
  if (state.sectionOn) void applySectionBox(true);

  try {
    viewer.impl.invalidate(true, true, true);
  } catch {
    /* ignore */
  }
  return { simplified, bbox: state.bbox };
}

function applyContext(viewer: Viewer, involved: Map<Model, number[]>, mode: ClashViewMode) {
  try {
    viewer.setGhosting(mode === "xray");
  } catch {
    /* ignore */
  }
  for (const model of allModels(viewer)) {
    const ids = involved.get(model);
    try {
      if (mode === "context") {
        viewer.isolate([], model); // show everything in this model
      } else if (ids?.length) {
        viewer.isolate(ids, model);
      } else {
        // No involved elements: ghost (xray) or hide (isolate) the whole model.
        const root = model.getInstanceTree?.()?.getRootId?.();
        if (root !== undefined) viewer.hide(root, model);
      }
    } catch {
      /* model not ready */
    }
  }
}

function resetVisuals(viewer: Viewer) {
  clearScene(viewer, SCENE_A);
  clearScene(viewer, SCENE_B);
  for (const m of state.themedModels) {
    try {
      viewer.clearThemingColors(m);
    } catch {
      /* ignore */
    }
  }
  state.themedModels.clear();
}

/** Show only side A, only side B, or both (keys [ ] =). */
export function setSideVisibility(side: "a" | "b" | "both"): void {
  const viewer = getViewer();
  if (!viewer || !state.opts) return;
  state.side = side;
  const hideSides = side === "a" ? state.b : side === "b" ? state.a : [];
  const show = [...state.a, ...state.b];
  for (const s of show) {
    try {
      viewer.show(s.dbIds, s.model);
    } catch {
      /* ignore */
    }
  }
  for (const s of hideSides) {
    try {
      viewer.hide(s.dbIds, s.model);
    } catch {
      /* ignore */
    }
  }
  clearScene(viewer, side === "a" ? SCENE_B : SCENE_A);
  if (side === "both") {
    if (materials.a) addGlow(viewer, bySide(state.a), "a", SCENE_A, materials.a);
    if (materials.b) addGlow(viewer, bySide(state.b), "b", SCENE_B, materials.b);
  }
  try {
    viewer.impl.invalidate(true, true, true);
  } catch {
    /* ignore */
  }
}

/** Fit camera to the current pair: union bbox expanded by max(0.5 m, 0.5 × diagonal). */
export function fitToCurrent(): void {
  const viewer = getViewer();
  const box = state.bbox;
  if (!viewer || !box) return;
  const model = state.a[0]?.model ?? state.b[0]?.model;
  const halfMeter = 0.5 / unitScale(model);
  const size = box.getSize ? box.getSize(new (THREE().Vector3)()) : { length: () => 0 };
  const diag = typeof size.length === "function" ? size.length() : 0;
  const expanded = box.clone().expandByScalar(Math.max(halfMeter, 0.5 * diag));
  try {
    viewer.navigation.fitBounds(reducedMotion(), expanded);
  } catch {
    try {
      viewer.fitToView(state.a.concat(state.b).flatMap((s) => s.dbIds));
    } catch {
      /* ignore */
    }
  }
}

async function applySectionBox(on: boolean): Promise<void> {
  const viewer = getViewer();
  if (!viewer) return;
  try {
    const ext = viewer.getExtension("Autodesk.Section") ?? (await viewer.loadExtension("Autodesk.Section"));
    if (on && state.bbox) {
      const model = state.a[0]?.model ?? state.b[0]?.model;
      ext.setSectionBox(state.bbox.clone().expandByScalar(1 / unitScale(model)));
    } else {
      ext.setSectionBox?.(null);
      viewer.setCutPlanes?.([]);
    }
  } catch {
    /* section extension unavailable */
  }
}

/** Toggle a section box around the current pair (bbox + 1 m). Returns the new state. */
export function toggleSectionBox(): boolean {
  state.sectionOn = !state.sectionOn;
  void applySectionBox(state.sectionOn);
  return state.sectionOn;
}

/** Place clash markers: sonar for the active clash, numbered object markers for the rest. */
export function setClashMarkers(specs: ClashMarkerSpec[], onClick?: (id: string) => void): void {
  clearAllMarkers();
  markerIdMap.clear();
  if (!getViewer()) return;
  for (const s of specs) {
    const mid = s.active
      ? addSonarMarker({ position: s.position, label: s.label, radius: 0.3, ringColor: "#A32428" })
      : addObjectMarker({ position: s.position, label: s.label, dbId: -1 });
    markerIdMap.set(mid as string, s.id);
  }
  setMarkerClickHandler(
    onClick
      ? (markerId: string) => {
          const id = markerIdMap.get(markerId);
          if (!id) return;
          onClick(id);
          return true;
        }
      : null,
  );
}

export function clearClashMarkers(): void {
  clearAllMarkers();
  markerIdMap.clear();
  setMarkerClickHandler(null);
}

/** Remove highlight, glow and markers; restore full visibility. */
export function clearClashPair(): void {
  const viewer = getViewer();
  stopPulse();
  state.opts = null;
  state.a = [];
  state.b = [];
  state.bbox = null;
  if (!viewer) return;
  resetVisuals(viewer);
  clearClashMarkers();
  try {
    viewer.setGhosting(true);
    viewer.showAll();
  } catch {
    /* ignore */
  }
}

/** Drop cached overlay meshes (call on test change). */
export function disposeClashCache(): void {
  meshCache.clear();
  materials.a = null;
  materials.b = null;
}
