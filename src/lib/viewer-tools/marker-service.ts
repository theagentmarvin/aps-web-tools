/**
 * MarkerService — 3D marker/annotation system for APS Viewer.
 *
 * References:
 *   - wallabyway/markupExt: point-cloud shader, spritesheet icons, 10K markers @ 60fps
 *   - Petr Broz forge-digital-twin/issues.js: THREE sprites at world coords + info cards
 *   - APS Viewer overlay scenes: createOverlayScene + addOverlay for custom THREE rendering
 *
 * Marker types: camera (📷), issue (🚩), object (📦), sonar (📡).
 * Uses overlay scenes for all rendering — gives full THREE.js control.
 */

import type { ApsViewerAPI } from "./types";
import type {
  Marker,
  CameraMarker,
  IssueMarker,
  ObjectMarker,
  SonarMarker,
} from "./marker-types";
import { ISSUE_STATUS_COLORS, MARKER_ICONS } from "./marker-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OverlayObj = any; // THREE.Object3D — only available via window.THREE at runtime

const OVERLAY_SCENE = "markers-overlay";

// ── Internal State ────────────────────────────────────────────────

const markers = new Map<string, Marker>();
const markerObjects = new Map<string, OverlayObj>();
const sonarAnimations = new Map<string, { obj: OverlayObj; startTime: number }>();
let overlaySceneReady = false;
let animationId: number | null = null;

// ── THREE Helpers ─────────────────────────────────────────────────

function getTHREE(): Record<string, unknown> {
  return (window as unknown as Record<string, unknown>).THREE as Record<string, unknown> || {};
}

function getViewer(): GuiViewer3D | null {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  return api?.getViewer() as GuiViewer3D || null;
}

// ── Public API ────────────────────────────────────────────────────

export function initMarkerService(): void {
  if (overlaySceneReady) return;

  const viewer = getViewer();
  if (!viewer) return;

  try {
    viewer.impl.createOverlayScene(OVERLAY_SCENE);
    overlaySceneReady = true;
    startAnimationLoop();
  } catch (e) {
    console.warn("[MarkerService] overlay scene creation failed:", e);
  }
}

export function disposeMarkerService(): void {
  stopAnimationLoop();
  clearAllMarkers();

  const viewer = getViewer();
  if (viewer) {
    try { viewer.impl.removeOverlayScene(OVERLAY_SCENE); } catch { /* ignore */ }
  }
  overlaySceneReady = false;
}

// ── Marker Creation ──────────────────────────────────────────────

export function addCameraMarker(opts: {
  position: { x: number; y: number; z: number };
  label: string;
  caption?: string;
  screenshotUrl?: string;
  cameraState?: CameraMarker["cameraState"];
}): string {
  const id = genId("cam");
  const marker: CameraMarker = {
    id, type: "camera", position: opts.position, label: opts.label,
    caption: opts.caption, screenshotUrl: opts.screenshotUrl,
    cameraState: opts.cameraState, createdAt: Date.now(),
  };
  addMarker(marker);
  return id;
}

export function addIssueMarker(opts: {
  position: { x: number; y: number; z: number };
  label: string;
  issueId: string;
  status: IssueMarker["status"];
  description?: string;
  linkedDbId?: number;
}): string {
  const id = genId("iss");
  const marker: IssueMarker = {
    id, type: "issue", position: opts.position, label: opts.label,
    issueId: opts.issueId, status: opts.status,
    description: opts.description, linkedDbId: opts.linkedDbId,
    color: ISSUE_STATUS_COLORS[opts.status], createdAt: Date.now(),
  };
  addMarker(marker);
  return id;
}

export function addObjectMarker(opts: {
  position: { x: number; y: number; z: number };
  label: string;
  dbId: number;
  displayProperty?: { name: string; value: string };
}): string {
  const id = genId("obj");
  const marker: ObjectMarker = {
    id, type: "object", position: opts.position, label: opts.label,
    dbId: opts.dbId, displayProperty: opts.displayProperty, createdAt: Date.now(),
  };
  addMarker(marker);
  return id;
}

export function addSonarMarker(opts: {
  position: { x: number; y: number; z: number };
  label: string;
  radius?: number;
  speed?: number;
  ringColor?: string;
}): string {
  const id = genId("son");
  const marker: SonarMarker = {
    id, type: "sonar", position: opts.position, label: opts.label,
    radius: opts.radius ?? 5, speed: opts.speed ?? 2,
    ringColor: opts.ringColor ?? "#00ccff", createdAt: Date.now(),
  };
  addMarker(marker);
  return id;
}

export function removeMarker(id: string): boolean {
  markers.delete(id);
  const obj = markerObjects.get(id);
  if (obj) {
    removeFromOverlay(obj);
    markerObjects.delete(id);
  }
  sonarAnimations.delete(id);
  return true;
}

export function clearAllMarkers(): void {
  for (const id of markers.keys()) removeMarker(id);
}

export function getMarkers(): Marker[] {
  return Array.from(markers.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getMarkersByType(type: Marker["type"]): Marker[] {
  return getMarkers().filter((m) => m.type === type);
}

export function flyToMarker(id: string): void {
  const marker = markers.get(id);
  if (!marker) return;
  const viewer = getViewer();
  if (!viewer) return;

  const THREE = getTHREE();
  const Vector3 = THREE.Vector3 as { new (x: number, y: number, z: number): unknown };

  if (marker.cameraState) {
    const cs = marker.cameraState;
    viewer.navigation.setView(
      new Vector3(cs.position.x, cs.position.y, cs.position.z),
      new Vector3(cs.target.x, cs.target.y, cs.target.z),
    );
  } else {
    viewer.navigation.setView(
      new Vector3(marker.position.x + 5, marker.position.y + 5, marker.position.z + 5),
      new Vector3(marker.position.x, marker.position.y, marker.position.z),
    );
  }
}

// ── Internal: Add marker to viewer ────────────────────────────────

function addMarker(marker: Marker): void {
  markers.set(marker.id, marker);
  const obj = createMarkerObject(marker);
  if (obj) {
    markerObjects.set(marker.id, obj);
    addToOverlay(obj);
  }
}

function createMarkerObject(marker: Marker): OverlayObj | null {
  switch (marker.type) {
    case "camera": return createSpriteMarker(marker, "#4a90d9");
    case "issue": return createSpriteMarker(marker, marker.color ?? ISSUE_STATUS_COLORS[marker.status]);
    case "object": return createSpriteMarker(marker, "#2ecc71");
    case "sonar": return createSonarMarker(marker);
    default: return null;
  }
}

function createSpriteMarker(marker: Marker, tintColor: string): OverlayObj | null {
  const THREE = getTHREE();
  const Sprite = THREE.Sprite as { new (mat: unknown): OverlayObj } | undefined;
  const SpriteMaterial = THREE.SpriteMaterial as { new (opts: Record<string, unknown>): unknown } | undefined;
  const CanvasTexture = THREE.CanvasTexture as { new (canvas: HTMLCanvasElement): unknown } | undefined;
  if (!Sprite || !SpriteMaterial || !CanvasTexture) return null;

  const canvas = createIconCanvas(marker.type, tintColor, marker.label);
  const texture = new CanvasTexture(canvas);
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new Sprite(material);
  sprite.position.set(marker.position.x, marker.position.y, marker.position.z);
  sprite.scale.set(0.5, 0.5, 1);
  sprite.userData = { markerId: marker.id };
  return sprite;
}

function createSonarMarker(marker: SonarMarker): OverlayObj | null {
  const THREE = getTHREE();
  const Group = THREE.Group as { new (): OverlayObj } | undefined;
  const RingGeometry = THREE.RingGeometry as { new (inner: number, outer: number, segs: number): unknown } | undefined;
  const MeshBasicMaterial = THREE.MeshBasicMaterial as { new (opts: Record<string, unknown>): unknown } | undefined;
  const Mesh = THREE.Mesh as { new (geo: unknown, mat: unknown): OverlayObj } | undefined;
  if (!Group || !RingGeometry || !MeshBasicMaterial || !Mesh) return null;

  const group = new Group();
  group.position.set(marker.position.x, marker.position.y, marker.position.z);
  group.rotation.x = -Math.PI / 2; // flat in XZ plane

  const geo = new RingGeometry(0.1, marker.radius, 32);
  const mat = new MeshBasicMaterial({
    color: parseInt(marker.ringColor.slice(1), 16),
    side: 2 as number, // DoubleSide
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false,
  });
  const ring = new Mesh(geo, mat);
  group.add(ring);
  group.userData = { markerId: marker.id };

  sonarAnimations.set(marker.id, { obj: ring, startTime: performance.now() });
  return group;
}

// ── Icon Canvas ───────────────────────────────────────────────────

function createIconCanvas(type: Marker["type"], tintColor: string, _label: string): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = tintColor;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = "28px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(MARKER_ICONS[type] || "●", size / 2, size / 2);

  return canvas;
}

// ── Overlay Scene ─────────────────────────────────────────────────

function addToOverlay(obj: OverlayObj): void {
  const viewer = getViewer();
  if (!viewer) return;
  try { viewer.impl.addOverlay(OVERLAY_SCENE, obj); } catch { /* ignore */ }
}

function removeFromOverlay(obj: OverlayObj): void {
  const viewer = getViewer();
  if (!viewer) return;
  try { viewer.impl.removeOverlay(OVERLAY_SCENE, obj); } catch { /* ignore */ }
}

// ── Animation Loop ────────────────────────────────────────────────

function startAnimationLoop(): void {
  if (animationId !== null) return;

  function tick(now: number): void {
    animationId = requestAnimationFrame(tick);

    const viewer = getViewer();
    for (const [id, { obj, startTime }] of sonarAnimations) {
      const marker = markers.get(id) as SonarMarker | undefined;
      if (!marker || !obj) continue;

      const elapsed = (now - startTime) / 1000;
      const cycle = elapsed % marker.speed;
      const t = cycle / marker.speed;
      const scale = 0.3 + 0.7 * t;

      try {
        obj.scale.set(scale, scale, scale);
        const mat = obj.material as Record<string, unknown>;
        if (mat) mat.opacity = 0.7 * (1 - t);
        obj.rotation.z += 0.01;
      } catch { /* ignore */ }

      try { viewer?.impl.invalidate(false, false, true); } catch { /* ignore */ }
    }
  }
  animationId = requestAnimationFrame(tick);
}

function stopAnimationLoop(): void {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

let _counter = 0;
function genId(prefix: string): string {
  _counter++;
  return `${prefix}-${Date.now()}-${_counter.toString(36)}`;
}
