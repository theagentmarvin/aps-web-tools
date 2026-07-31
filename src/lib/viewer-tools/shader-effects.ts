/**
 * Shader Effects Service — WebGL shaders rendered as overlay geometry.
 *
 * Uses viewer.impl.createOverlayScene/addOverlay to render custom THREE.js
 * geometry ON TOP of the model — never replaces original fragment materials.
 * This fixes the "element disappears on rotate" bug (FrontSide culling when
 * the shader was the only material on the fragment).
 *
 * Effects:
 *   1. X-Ray Isolation — dim everything except selection (ghost overlay)
 *   2. Glow Highlight — bright fresnel outline glow on selected elements
 *   3. Pulse Animation — oscillating glow for attention
 */

import type { ApsViewerAPI } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OverlayObj = any;

const XRAY_OVERLAY = "xray-overlay";
const GLOW_OVERLAY = "glow-overlay";

// ── Shader Sources (standalone — no MRT header needed for overlay scenes) ────

/** Glow vertex — inflates geometry along normals. */
const GLOW_VERTEX = `
varying vec3 vNormal;
uniform float uInflate;
void main() {
  vec4 inflated = vec4(position + normal * uInflate, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * inflated;
  vNormal = normalize(normalMatrix * normal);
}
`;

/** Glow fragment — bright color with fresnel edge, additive blending. */
const GLOW_FRAGMENT = `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vNormal;

void main() {
  vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0));
  float fresnel = pow(1.0 - abs(dot(vNormal, viewDir)), 3.0);
  float pulse = 0.7 + 0.3 * sin(uTime * 3.0);
  vec3 glow = uColor * fresnel * uIntensity * pulse;
  float alpha = fresnel * 0.85;
  gl_FragColor = vec4(glow, alpha);
}
`;

/** X-Ray ghost vertex — pass-through. */
const GHOST_VERTEX = `
varying vec3 vNormal;
varying vec3 vPosition;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** X-Ray ghost fragment — translucent white with fresnel edge glow. */
const GHOST_FRAGMENT = `
uniform float uOpacity;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0));
  float fresnel = pow(1.0 - abs(dot(vNormal, viewDir)), 2.0);
  vec3 color = mix(vec3(0.85, 0.85, 0.88), vec3(0.95, 0.95, 1.0), fresnel);
  gl_FragColor = vec4(color, uOpacity);
}
`;

// ── Service State ─────────────────────────────────────────────────

let xRayActive = false;
let glowActive = false;
let xRayMaterial: Record<string, unknown> | null = null;
let glowMaterial: Record<string, unknown> | null = null;
let animationId: number | null = null;
let targetDbIds: Set<number> = new Set();
let overlayObjects: OverlayObj[] = [];

function getViewer(): GuiViewer3D | null {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  return api?.getViewer() as GuiViewer3D || null;
}

function getTHREE(): Record<string, unknown> {
  return (window as unknown as Record<string, unknown>).THREE as Record<string, unknown> || {};
}

// ── Public API ────────────────────────────────────────────────────

/** Activate X-Ray isolation: dim ghost overlay on non-selected geometry. */
export function enableXRay(dbIds: number[], opacity = 0.15): void {
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !viewer.model || !THREE.ShaderMaterial) return;

  disableGlow();
  xRayActive = true;
  targetDbIds = new Set(dbIds);

  const ShaderMaterial = THREE.ShaderMaterial as { new(opts: Record<string, unknown>): unknown };
  xRayMaterial = new ShaderMaterial({
    uniforms: {
      uOpacity: { value: opacity },
      uTime: { value: 0 },
    },
    vertexShader: GHOST_VERTEX,
    fragmentShader: GHOST_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    side: 2 as number, // DoubleSide — visible from all angles
  }) as Record<string, unknown>;
  (xRayMaterial as Record<string, unknown>).supportsMrtNormals = true;

  ensureOverlay(viewer, XRAY_OVERLAY);
  const tree = viewer.model.getInstanceTree();
  const allIds = getAllDbIds(tree);
  const targetSet = new Set(dbIds);

  for (const dbId of allIds) {
    if (targetSet.has(dbId)) continue;
    try {
      tree.enumNodeFragments(dbId, (fragId: number) => {
        const mesh = createFragmentMesh(viewer, fragId, xRayMaterial!);
        if (mesh) {
          overlayObjects.push(mesh);
          try { viewer.impl.addOverlay(XRAY_OVERLAY, mesh); } catch { /* ignore */ }
        }
      });
    } catch { /* skip */ }
  }

  startAnimation();
  viewer.impl.invalidate(false, false, true);
}

/** Activate Glow: add an inflated overlay mesh with fresnel glow on selected elements. */
export function enableGlow(dbIds: number[], color = "#ff4444", inflate = 0.3, intensity = 2.5): void {
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !viewer.model || !THREE.ShaderMaterial) return;

  disableXRay();
  glowActive = true;
  targetDbIds = new Set(dbIds);

  const ShaderMaterial = THREE.ShaderMaterial as { new(opts: Record<string, unknown>): unknown };
  const c = hexToRGB(color);

  glowMaterial = new ShaderMaterial({
    uniforms: {
      uColor: {
        value: new ((THREE.Color || THREE.Vector3) as { new(r: number, g: number, b: number): unknown })(
          c.r, c.g, c.b,
        ),
      },
      uIntensity: { value: intensity },
      uInflate: { value: inflate },
      uTime: { value: 0 },
    },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    blending: 2 as number, // AdditiveBlending — brightens instead of replacing
    depthTest: true,
    depthWrite: false,
    side: 2 as number, // DoubleSide — visible from all angles
  }) as Record<string, unknown>;

  ensureOverlay(viewer, GLOW_OVERLAY);

  for (const dbId of dbIds) {
    try {
      const tree = viewer.model.getInstanceTree();
      tree.enumNodeFragments(dbId, (fragId: number) => {
        const mesh = createFragmentMesh(viewer, fragId, glowMaterial!);
        if (mesh) {
          overlayObjects.push(mesh);
          try { viewer.impl.addOverlay(GLOW_OVERLAY, mesh); } catch { /* ignore */ }
        }
      });
    } catch { /* skip invalid dbIds */ }
  }

  startAnimation();
  viewer.impl.invalidate(false, false, true);
}

export function disableXRay(): void {
  if (!xRayActive) return;
  clearOverlay(XRAY_OVERLAY);
  xRayActive = false;
  xRayMaterial = null;
  if (!glowActive) stopAnimation();
}

export function disableGlow(): void {
  if (!glowActive) return;
  clearOverlay(GLOW_OVERLAY);
  glowActive = false;
  glowMaterial = null;
  if (!xRayActive) stopAnimation();
}

export function disableAll(): void {
  disableXRay();
  disableGlow();
}

export function isXRayActive(): boolean { return xRayActive; }
export function isGlowActive(): boolean { return glowActive; }

// ── Overlay Scene Management ──────────────────────────────────────

function ensureOverlay(viewer: GuiViewer3D, name: string): void {
  if (!viewer.impl.hasOverlayScene?.(name)) {
    try { viewer.impl.createOverlayScene(name); } catch { /* already exists */ }
  }
}

function clearOverlay(name: string): void {
  const viewer = getViewer();
  if (!viewer) return;

  // Remove all objects from this overlay scene
  for (const obj of overlayObjects) {
    try { viewer.impl.removeOverlay(name, obj); } catch { /* ignore */ }
  }
  overlayObjects = [];

  try { viewer.impl.removeOverlayScene?.(name); } catch { /* ignore */ }
  targetDbIds.clear();
}

// ── Fragment → Overlay Mesh ───────────────────────────────────────

/**
 * Extracts fragment geometry and creates a new THREE.Mesh with the given
 * material. The mesh inherits the fragment's world matrix so it aligns
 * perfectly with the model.
 */
function createFragmentMesh(
  viewer: GuiViewer3D,
  fragId: number,
  material: Record<string, unknown>,
): OverlayObj | null {
  const THREE = getTHREE();
  const BufferGeometry = THREE.BufferGeometry as { new(): Record<string, unknown> & { setAttribute: (n: string, a: unknown) => void; setIndex: (a: unknown) => void } };
  const Float32BufferAttribute = (THREE as Record<string, unknown>).Float32BufferAttribute as
    { new(data: Float32Array, size: number): unknown } | undefined;
  const Mesh = THREE.Mesh as { new(geo: unknown, mat: unknown): OverlayObj } | undefined;
  const Matrix4 = THREE.Matrix4 as { new(): { elements: Float32Array } } | undefined;

  if (!BufferGeometry || !Float32BufferAttribute || !Mesh || !Matrix4) return null;

  try {
    const fragList = viewer.model.getFragmentList();
    const mesh = fragList.getVizmesh(fragId);

    if (!mesh || !mesh.positions || !mesh.indices) return null;

    const geo = new BufferGeometry();
    geo.setAttribute(
      "position",
      new Float32BufferAttribute(mesh.positions, 3),
    );
    geo.setIndex(new Float32BufferAttribute(mesh.indices, 1));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geo as any).computeVertexNormals?.();

    // Get the fragment's transform matrix
    const matrix = new Matrix4();
    fragList.getWorldMatrix(fragId, matrix.elements);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geo as any).applyMatrix4?.(matrix);

    return new Mesh(geo, material);
  } catch {
    return null;
  }
}

// ── Animation Loop ────────────────────────────────────────────────

function startAnimation(): void {
  if (animationId !== null) return;
  const startTime = performance.now();

  function tick(now: number): void {
    const elapsed = (now - startTime) / 1000;

    if (xRayMaterial?.uniforms) {
      try { (xRayMaterial.uniforms as Record<string, Record<string, number>>).uTime.value = elapsed; } catch { /* skip */ }
    }
    if (glowMaterial?.uniforms) {
      try { (glowMaterial.uniforms as Record<string, Record<string, number>>).uTime.value = elapsed; } catch { /* skip */ }
    }

    const viewer = getViewer();
    try { viewer?.impl.invalidate(false, false, true); } catch { /* ignore */ }

    if (xRayActive || glowActive) {
      animationId = requestAnimationFrame(tick);
    }
  }
  animationId = requestAnimationFrame(tick);
}

function stopAnimation(): void {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function getAllDbIds(tree: {
  getRootId: () => number;
  enumNodeChildren: (id: number, cb: (dbId: number) => void, recursive: boolean) => void;
}): number[] {
  const result: number[] = [];
  function walk(id: number) {
    result.push(id);
    tree.enumNodeChildren(id, (child) => walk(child), false);
  }
  walk(tree.getRootId());
  return result;
}

function hexToRGB(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}
