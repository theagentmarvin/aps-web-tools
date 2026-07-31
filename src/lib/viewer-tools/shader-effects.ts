/**
 * Shader Effects Service — Custom WebGL shaders on model geometry.
 *
 * Reference: Petr Broz "Custom shader materials in Forge Viewer"
 *   https://aps.autodesk.com/blog/custom-shader-materials-forge-viewer
 *   https://github.com/petrbroz/forge-basic-app/tree/custom-shader-material
 *
 * Effects:
 *   1. X-Ray Isolation — dim everything except selection (ghost mode)
 *   2. Glow Highlight — bright outline glow on selected elements
 *   3. Pulse Animation — oscillating glow for attention
 */

import type { ApsViewerAPI } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;

// ── MRT-Compatible Shader Base ────────────────────────────────────

/** MRT (Multiple Render Target) compatibility header for WebGL2.
 *  Required by the APS Viewer so hover/picking still works. */
const MRT_HEADER = `
#ifdef _LMVWEBGL2_
  #if defined(MRT_NORMALS)
    layout(location = 1) out vec4 outNormal;
    #if defined(MRT_ID_BUFFER)
      layout(location = 2) out vec4 outId;
      #if defined(MODEL_COLOR)
        layout(location = 3) out vec4 outModelId;
      #endif
    #endif
  #elif defined(MRT_ID_BUFFER)
    layout(location = 1) out vec4 outId;
    #if defined(MODEL_COLOR)
      layout(location = 2) out vec4 outModelId;
    #endif
  #endif
#else
  #define gl_FragColor gl_FragData[0]
  #if defined(MRT_NORMALS)
    #define outNormal gl_FragData[1]
    #if defined(MRT_ID_BUFFER)
      #define outId gl_FragData[2]
      #if defined(MODEL_COLOR)
        #define outModelId gl_FragData[3]
      #endif
    #endif
  #elif defined(MRT_ID_BUFFER)
    #define outId gl_FragData[1]
    #if defined(MODEL_COLOR)
      #define outModelId gl_FragData[2]
    #endif
  #endif
#endif

void writeMRTOutputs() {
  #ifdef MRT_ID_BUFFER
    outId = vec4(0.0);
  #endif
  #ifdef MODEL_COLOR
    outModelId = vec4(0.0);
  #endif
  #ifdef MRT_NORMALS
    outNormal = vec4(0.0);
  #endif
}
`;

// ── Shader Sources ────────────────────────────────────────────────

/** X-Ray/Ghost vertex shader — passes through positions. */
const GHOST_VERTEX = `
varying vec3 vNormal;
varying vec3 vPosition;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** X-Ray/Ghost fragment shader — translucent white with edge highlight. */
const GHOST_FRAGMENT = MRT_HEADER + `
uniform float uOpacity;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0));
  float fresnel = pow(1.0 - abs(dot(vNormal, viewDir)), 2.0);
  vec3 color = mix(vec3(0.85, 0.85, 0.88), vec3(0.95, 0.95, 1.0), fresnel);
  gl_FragColor = vec4(color, uOpacity);
  writeMRTOutputs();
}
`;

/** Glow vertex shader — inflates geometry slightly along normals. */
const GLOW_VERTEX = `
varying vec3 vNormal;
uniform float uInflate;
void main() {
  vec4 inflated = vec4(position + normal * uInflate, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * inflated;
  vNormal = normalize(normalMatrix * normal);
}
`;

/** Glow fragment — bright color with fresnel edge. */
const GLOW_FRAGMENT = MRT_HEADER + `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vNormal;

void main() {
  vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0));
  float fresnel = pow(1.0 - abs(dot(vNormal, viewDir)), 3.0);
  float pulse = 0.7 + 0.3 * sin(uTime * 3.0);
  vec3 glow = uColor * (1.0 + fresnel * uIntensity * pulse);
  gl_FragColor = vec4(glow, 1.0);
  writeMRTOutputs();
}
`;

// ── Service State ─────────────────────────────────────────────────

let xRayActive = false;
let glowActive = false;
let xRayMaterial: unknown = null;
let glowMaterial: unknown = null;
let animationId: number | null = null;
let targetDbIds: Set<number> = new Set();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getViewer(): any | null {
  const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
  return api?.getViewer() || null;
}

function getTHREE(): Record<string, unknown> {
  return (window as unknown as Record<string, unknown>).THREE as Record<string, unknown> || {};
}

// ── Public API ────────────────────────────────────────────────────

/** Activate X-Ray isolation: everything except selected dbIds goes ghost-translucent. */
export function enableXRay(dbIds: number[], opacity = 0.15): void {
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !viewer.model || !THREE.ShaderMaterial) return;

  disableGlow(); // mutually exclusive
  xRayActive = true;
  targetDbIds = new Set(dbIds);

  const ShaderMaterial = THREE.ShaderMaterial as { new(opts: Record<string, unknown>): unknown };

  // Create ghost material for non-target elements
  const ghostMat = new ShaderMaterial({
    uniforms: {
      uOpacity: { value: opacity },
      uTime: { value: 0 },
    },
    vertexShader: GHOST_VERTEX,
    fragmentShader: GHOST_FRAGMENT,
    transparent: true,
    depthWrite: true,
    side: 2 as number, // DoubleSide
  }) as Record<string, unknown>;
  (ghostMat as Record<string, unknown>).supportsMrtNormals = true;
  xRayMaterial = ghostMat;

  // Unconsolidate and apply
  try { viewer.model.unconsolidate(); } catch { /* best effort */ }
  applyGhostMaterial(viewer, dbIds, ghostMat);
  startAnimation();
  viewer.impl.invalidate(false, false, true);
}

/** Activate Glow: selected elements get a bright fresnel glow. */
export function enableGlow(dbIds: number[], color = "#ff4444", inflate = 0.3, intensity = 2.5): void {
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !viewer.model || !THREE.ShaderMaterial) return;

  disableXRay(); // mutually exclusive
  glowActive = true;
  targetDbIds = new Set(dbIds);

  const ShaderMaterial = THREE.ShaderMaterial as { new(opts: Record<string, unknown>): unknown };
  const c = hexToRGB(color);

  const glowMat = new ShaderMaterial({
    uniforms: {
      uColor: { value: new ((THREE.Color || THREE.Vector3) as unknown as { new(r: number, g: number, b: number): unknown })(c.r, c.g, c.b) },
      uIntensity: { value: intensity },
      uInflate: { value: inflate },
      uTime: { value: 0 },
    },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: 0 as number, // FrontSide
  }) as Record<string, unknown>;
  (glowMat as Record<string, unknown>).supportsMrtNormals = true;
  glowMaterial = glowMat;

  try { viewer.model.unconsolidate(); } catch { /* best effort */ }
  const tree = viewer.model.getInstanceTree();
  const frags = viewer.model.getFragmentList();

  for (const dbId of dbIds) {
    try {
      tree.enumNodeFragments(dbId, (fragId: number) => {
        try { frags.setMaterial(fragId, glowMat); } catch { /* skip */ }
      });
    } catch { /* skip invalid dbIds */ }
  }
  startAnimation();
  viewer.impl.invalidate(false, false, true);
}

/** Disable X-Ray, restore original materials. */
export function disableXRay(): void {
  if (!xRayActive) return;
  const viewer = getViewer();
  if (viewer) resetAllMaterials(viewer);
  xRayActive = false;
  xRayMaterial = null;
  targetDbIds.clear();
  if (!glowActive) stopAnimation();
}

/** Disable Glow, restore original materials. */
export function disableGlow(): void {
  if (!glowActive) return;
  const viewer = getViewer();
  if (viewer) resetAllMaterials(viewer);
  glowActive = false;
  glowMaterial = null;
  targetDbIds.clear();
  if (!xRayActive) stopAnimation();
}

/** Disable all effects. */
export function disableAll(): void {
  disableXRay();
  disableGlow();
}

export function isXRayActive(): boolean { return xRayActive; }
export function isGlowActive(): boolean { return glowActive; }

// ── Internal ──────────────────────────────────────────────────────

function applyGhostMaterial(
  viewer: GuiViewer3D,
  targetDbIds: number[],
  ghostMat: unknown,
): void {
  const model = viewer.model;
  const tree = model.getInstanceTree();
  const frags = model.getFragmentList();
  const targetSet = new Set(targetDbIds);

  // Walk instance tree, apply ghost to ALL fragments, then restore target
  const allDbIds = getAllDbIds(tree);
  for (const dbId of allDbIds) {
    if (targetSet.has(dbId)) continue;
    try {
      tree.enumNodeFragments(dbId, (fragId: number) => {
        try { frags.setMaterial(fragId, ghostMat); } catch { /* skip */ }
      });
    } catch { /* skip */ }
  }
}

function getAllDbIds(tree: {
  getRootId: () => number;
  getChildCount: (id: number) => number;
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

function resetAllMaterials(viewer: GuiViewer3D): void {
  const model = viewer.model;
  if (!model) return;
  try {
    // Restore original materials by re-consolidating
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model.consolidate?.();
  } catch {
    // Fallback: clear custom materials from the material manager
    try {
      const mm = viewer.impl.matman();
      if (xRayMaterial) mm.removeMaterial?.("xrayGhost");
      if (glowMaterial) mm.removeMaterial?.("glowHighlight");
    } catch { /* ignore */ }
  }
  try { viewer.impl.invalidate(false, false, true); } catch { /* ignore */ }
}

// ── Animation Loop ────────────────────────────────────────────────

function startAnimation(): void {
  if (animationId !== null) return;
  let startTime = performance.now();

  function tick(now: number): void {
    const elapsed = (now - startTime) / 1000;

    // Update time uniforms for pulse effects
    if (xRayMaterial) {
      try { ((xRayMaterial as Record<string, unknown>).uniforms as Record<string, Record<string, number>>).uTime.value = elapsed; } catch { /* skip */ }
    }
    if (glowMaterial) {
      try { ((glowMaterial as Record<string, unknown>).uniforms as Record<string, Record<string, number>>).uTime.value = elapsed; } catch { /* skip */ }
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

function hexToRGB(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}
