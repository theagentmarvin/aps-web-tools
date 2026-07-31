/**
 * Markup Service — 3D markups using PointCloud shader.
 *
 * Based directly on wallabyway/markupExt canonical implementation:
 *   - THREE.Geometry with vertex colors (icon index in green channel)
 *   - vertexColors: THREE.VertexColors in ShaderMaterial
 *   - Same vertex/fragment shaders from the canonical source
 *   - Global offset alignment to model coordinates
 *
 * Ref: https://gist.github.com/wallabyway/475cfbf4b200a982b542e6bbbed563c4
 */
/* eslint-disable */
// @ts-nocheck

import type { Marker, CameraMarker, IssueMarker, ObjectMarker, SonarMarker } from "./marker-types";
import { ISSUE_STATUS_COLORS } from "./marker-types";

// ── State ──────────────────────────────────────────────────

let isInitialized = false;
let pointCloud = null;
let geometry = null;
let material = null;
let spriteTex = null;
let raycaster = null;
let camera = null;
let viewerRef = null;
let markupItems = [];
let offset = null;
let hovered = null;
let selected = null;
let labelDiv = null;
const size = 80.0;

// ── Shaders (exact match of canonical wallabyway/markupExt) ─────

const vertexShader = `
uniform float size;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (size / (length(mvPosition.xyz) + 1.0));
  gl_Position = projectionMatrix * mvPosition;
}`;

const fragmentShader = `
uniform sampler2D tex;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor.x, vColor.x, vColor.x, 1.0);
  gl_FragColor = gl_FragColor * texture2D(tex, vec2((gl_PointCoord.x + vColor.y * 1.0) / 4.0, 1.0 - gl_PointCoord.y));
  if (gl_FragColor.w < 0.5) discard;
}`;

// ── Helpers ─────────────────────────────────────────────────

function getViewer() {
  return (window as any).__apsViewer?.getViewer?.() || viewerRef || null;
}
function getTHREE() { return (window as any).THREE || {}; }

// ── Sprite sheet texture ──────────────────────────────────

function createSpriteTex() {
  const THREE = getTHREE();
  const sz = 64, count = 4;
  const canvas = document.createElement("canvas");
  canvas.width = sz * count;
  canvas.height = sz;
  const ctx = canvas.getContext("2d")!;

  const icons = [
    { emoji: "📷", color: "#4a90d9" },
    { emoji: "🚩", color: "#e74c3c" },
    { emoji: "📦", color: "#2ecc71" },
    { emoji: "📡", color: "#00ccff" },
  ];

  for (let i = 0; i < count; i++) {
    const cx = i * sz + sz / 2;
    ctx.beginPath();
    ctx.arc(cx, sz / 2, sz / 2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = icons[i].color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = "28px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(icons[i].emoji, cx, sz / 2);
  }

  // Create texture (try CanvasTexture first, fall back to Texture)
  if (THREE.CanvasTexture) {
    spriteTex = new THREE.CanvasTexture(canvas);
  } else if (THREE.Texture) {
    spriteTex = new THREE.Texture(canvas);
    spriteTex.needsUpdate = true;
  } else {
    spriteTex = canvas; // fallback
  }
  if (spriteTex.minFilter !== undefined) {
    spriteTex.minFilter = THREE.NearestFilter || THREE.LinearMipMapLinearFilter;
    spriteTex.magFilter = THREE.NearestFilter || THREE.LinearFilter;
  }
  return spriteTex;
}

// ── Init / Dispose ────────────────────────────────────────

export function initMarkup() {
  if (isInitialized) return;
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !THREE) { console.warn("[markupExt] viewer or THREE not ready"); return; }

  console.log("[markupExt] initMarkup starting");

  viewerRef = viewer;
  camera = viewer.impl?.camera;
  try { offset = viewer.model?.getData?.()?.globalOffset; } catch(e) {}

  // Sprite texture
  createSpriteTex();

  // ShaderMaterial (vertexColors is critical!)
  material = new THREE.ShaderMaterial({
    vertexColors: THREE.VertexColors,
    fragmentShader: fragmentShader,
    vertexShader: vertexShader,
    depthWrite: true,
    depthTest: true,
    uniforms: {
      size: { type: "f", value: size },
      tex: { type: "t", value: spriteTex },
    },
  });

  // Raycaster
  raycaster = new THREE.Raycaster();
  if (raycaster.params?.PointCloud) raycaster.params.PointCloud.threshold = 5;
  else if (raycaster.params?.Points) raycaster.params.Points.threshold = 5;

  // Info card DIV
  if (!document.getElementById("markup-info-card")) {
    labelDiv = document.createElement("div");
    labelDiv.id = "markup-info-card";
    labelDiv.style.cssText =
      "display:none;position:fixed;z-index:100;background:rgba(30,30,30,0.92);color:#fff;" +
      "border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:10px 14px;" +
      "font:13px -apple-system,BlinkMacSystemFont,sans-serif;max-width:240px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.3);pointer-events:auto;";
    document.body.appendChild(labelDiv);
  } else {
    labelDiv = document.getElementById("markup-info-card");
  }

  // Canvas click → raycaster hit-test
  const canvas = viewer.impl?.getCanvas?.() || viewer.container?.querySelector?.("canvas");
  if (canvas) {
    canvas.addEventListener("click", onCanvasClick);
    canvas.addEventListener("mousemove", onCanvasMove);
  }

  isInitialized = true;
  console.log("[markupExt] initMarkup complete (offset:", offset, ")");
}

export function disposeMarkup() {
  const viewer = getViewer();
  if (pointCloud && viewer) {
    try {
      
      impl?.removeOverlay?.("marker-overlay", pointCloud);
    } catch(e) { /* ignore */ }
  }
  pointCloud = null;
  geometry = null;
  markupItems = [];
  isInitialized = false;
  if (labelDiv) { labelDiv.remove(); labelDiv = null; }
  console.log("[markupExt] disposed");
}

// ── PointCloud build ──────────────────────────────────────

function buildPointCloud() {
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !material) return;

  const OVERLAY = "marker-overlay";

  // Remove existing point from overlay
  if (pointCloud) {
    try { viewer.impl?.removeOverlay?.(OVERLAY, pointCloud); } catch(e) {}
  }

  // Build geometry using THREE.Geometry (r71 compatible)
  geometry = new THREE.Geometry();
  for (const item of markupItems) {
    geometry.vertices.push(new THREE.Vector3(item.x, item.y, item.z));
    // Icon index in green channel, red channel = 1.0 for base color
    geometry.colors.push(new THREE.Color(1.0, item.icon, 0));
  }
  // CRITICAL: prevent frustum culling of point-only geometry
  geometry.computeBoundingSphere();

  // PointCloud (try Points first for newer viewers, fallback)
  const PC = THREE.Points || THREE.PointCloud;
  if (!PC) { console.warn("[markupExt] No Points/PointCloud constructor"); return; }

  pointCloud = new PC(geometry, material);
  if (offset) pointCloud.position.sub(offset);

  try {
    // 🔑 Use overlay scene, NOT viewer.impl.scene — custom geometry
    // added to the main scene is silently removed during camera movement
    // and progressive rendering cycles (documented APS Viewer v7 behavior).
    // Ref: wallabyway blog on pointcloud + Revit in ForgeViewer
    if (!viewer.impl.overlayScenes?.[OVERLAY]) {
      viewer.impl.createOverlayScene(OVERLAY);
    }
    viewer.impl.addOverlay(OVERLAY, pointCloud);
    viewer.impl.invalidate(false, false, true);
    console.log("[markupExt] PointCloud added to overlay with", markupItems.length, "points");
  } catch(e) {
    console.warn("[markupExt] overlay add failed:", e);
  }
}

// ── Raycaster events ──────────────────────────────────────

function onCanvasClick(e) {
  if (!raycaster || !pointCloud || !camera || markupItems.length === 0) return;

  if (hovered != null) {
    selected = hovered;
    const item = markupItems[selected];
    if (item) showInfoCard(item, e.clientX, e.clientY);
    const viewer = getViewer();
    viewer?.impl?.invalidate?.(true);
  }
}

function onCanvasMove(e) {
  if (!raycaster || !pointCloud || !camera || markupItems.length === 0) return;

  try {
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -(e.clientY / window.innerHeight) * 2 + 1;
    const THREE = getTHREE();
    const vec = new THREE.Vector3(x, y, 0.5);
    vec.unproject(camera);
    raycaster.set(camera.position, vec.sub(camera.position).normalize());
    const hits = raycaster.intersectObject(pointCloud);

    if (hits.length > 0) {
      hovered = hits[0].index;
      geometry.colors[hovered].r = 2.0;
      geometry.colorsNeedUpdate = true;
      const viewer = getViewer();
      viewer?.impl?.invalidate?.(true);
    } else if (hovered != null) {
      geometry.colors[hovered].r = 1.0;
      geometry.colorsNeedUpdate = true;
      hovered = null;
      const viewer = getViewer();
      viewer?.impl?.invalidate?.(true);
    }
    // Dynamic card position update: re-project marker world coords to screen
    // whenever the mouse moves (matches blog post sample behavior)
    if (cardsVisibleState && currentCardIndex >= 0 && currentCardIndex < markupItems.length) {
      const cardItem = markupItems[currentCardIndex];
      if (cardItem && labelDiv && labelDiv.style.display !== 'none') {
        try {
          const viewer = getViewer();
          if (viewer) {
            const THREE = getTHREE();
            const V = THREE.Vector3;
            const wp = new V(cardItem.x, cardItem.y, cardItem.z + 1.5);
            const sp = (viewer as any).worldToClient?.(wp);
            if (sp) {
              labelDiv.style.left = sp.x + 'px';
              labelDiv.style.top = sp.y + 'px';
            }
          }
        } catch(dynErr) { /* ignore */ }
      }
    }
  } catch(err) { /* ignore */ }
}

function showInfoCard(item, cx, cy) {
  console.log("[showInfoCard] called, labelDiv:", !!labelDiv, "item:", !!item, "cx:", cx, "cy:", cy);
  if (!labelDiv || !item) { console.log("[showInfoCard] EARLY RETURN - labelDiv missing or item null"); return; }

  // Normalize payload fields for KPI display
  const p = item.payload || {};
  const title = p.title || p.label || (`Marker #${item.id.slice(-4)}`);
  const status = p.status || "";
  const progress = typeof p.progress === "number" ? p.progress : undefined;
  const desc = p.description || p.caption || "";
  const color = p.color || "#4a90d9";

  // Status badge style
  const statusColors = {
    completed: "#27ae60", done: "#27ae60", complete: "#27ae60",
    "in_progress": "#f39c12", active: "#f39c12", ongoing: "#f39c12", inprogress: "#f39c12",
    pending: "#95a5a6", todo: "#95a5a6",
    blocked: "#e74c3c", warning: "#e74c3c", issue: "#e74c3c",
  };
  const statusKey = ((status || "").toLowerCase().replace(/[\s-]/g, "_")) as keyof typeof statusColors;
  const statusColor = statusColors[statusKey] || color;
  const statusLabel = status ? status.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) : "";

  // Build info card HTML
  let html = `<div style="position:relative;min-width:140px;">`;

  // Status badge + title
  if (status) {
    html += `<div style="display:inline-block;background:${statusColor};color:#fff;font-size:9px;font-weight:600;padding:1px 6px;border-radius:8px;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.3px;">${statusLabel}</div>`;
  }
  html += `<div style="font-weight:600;margin-bottom:3px;color:#fff;font-size:13px;">${title}</div>`;

  // Progress bar
  if (progress !== undefined) {
    const pct = Math.max(0, Math.min(100, progress));
    const barColor = pct >= 100 ? "#27ae60" : pct >= 50 ? "#f39c12" : "#e74c3c";
    html += `<div style="margin:6px 0 4px;">
      <div style="display:flex;justify-content:space-between;font-size:9px;color:#aaa;margin-bottom:2px;"><span>Progress</span><span>${Math.round(pct)}%</span></div>
      <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width 0.3s;"></div>
      </div>
    </div>`;
  }

  // Description
  if (desc) {
    html += `<div style="color:#bbb;font-size:10px;margin-top:4px;line-height:1.3;">${desc}</div>`;
  }

  // Footer
  html += `<div style="color:rgba(255,255,255,0.3);font-size:9px;margin-top:6px;text-align:right;">Click to close</div>`;
  html += `</div>`;

  labelDiv.style.display = "block";
  labelDiv.style.left = cx + "px";
  labelDiv.style.top = cy + "px";
  labelDiv.style.transform = "translate(-50%, -120%)";
  labelDiv.innerHTML = html;
}

export function hideInfoCard() {
  if (labelDiv) labelDiv.style.display = "none";
  selected = null;
}

// ── Public API ────────────────────────────────────────────

export function setMarkups(items) {
  markupItems = items;
  buildPointCloud();
}

export function showInfoCardById(id) {
  console.log("[showInfoCardById] looking for id:", id, "in", markupItems.length, "items");
  const item = markupItems.find(x => x.id === id);
  console.log("[showInfoCardById] found item:", !!item);
  if (item) showInfoCard(item, window.innerWidth / 2, window.innerHeight / 2);
  else console.log("[showInfoCardById] ITEM NOT FOUND in markupItems");
}

export function flyToMarkup(id) {
  const item = markupItems.find(x => x.id === id);
  if (!item) return;
  const viewer = getViewer();
  const THREE = getTHREE();
  if (!viewer || !THREE.Vector3) return;
  try {
    const V = THREE.Vector3;
    viewer.navigation?.setView?.(new V(item.x + 5, item.y + 5, item.z + 5), new V(item.x, item.y, item.z));
  } catch(e) {}
}

// ── Backward-compatible API ───────────────────────────────

let _idCounter = 0;
const _iconMap = {};
const _cache = new Map();

function ensureInit() { if (!isInitialized) initMarkup(); }

function genId(pref) { _idCounter++; return `${pref}-${Date.now()}-${_idCounter.toString(36)}`; }

function syncFromCache() {
  ensureInit();
  const pts = [];
  for (const [id, m] of _cache) {
    pts.push({ id, x: m.position.x, y: m.position.y, z: m.position.z, icon: _iconMap[id] ?? 0, payload: m.kpiData || { type: m.type, label: m.label } });
  }
  markupItems = pts;
  buildPointCloud();
}

export function addCameraMarker(opts) {
  const id = genId("cam");
  _cache.set(id, { id, type: "camera", position: opts.position, label: opts.label, caption: opts.caption, screenshotUrl: opts.screenshotUrl, cameraState: opts.cameraState, createdAt: Date.now() });
  _iconMap[id] = 0;
  syncFromCache();
  return id;
}

export function addIssueMarker(opts) {
  const id = genId("iss");
  _cache.set(id, { id, type: "issue", position: opts.position, label: opts.label, issueId: opts.issueId, status: opts.status, description: opts.description, linkedDbId: opts.linkedDbId, color: ISSUE_STATUS_COLORS[opts.status], createdAt: Date.now() });
  _iconMap[id] = 1;
  syncFromCache();
  return id;
}

export function addObjectMarker(opts) {
  const id = genId("obj");
  _cache.set(id, { id, type: "object", position: opts.position, label: opts.label, dbId: opts.dbId, displayProperty: opts.displayProperty, createdAt: Date.now() });
  _iconMap[id] = 2;
  syncFromCache();
  return id;
}

export function addSonarMarker(opts) {
  const id = genId("son");
  _cache.set(id, { id, type: "sonar", position: opts.position, label: opts.label, radius: opts.radius ?? 5, speed: opts.speed ?? 2, ringColor: opts.ringColor ?? "#00ccff", createdAt: Date.now() });
  _iconMap[id] = 3;
  syncFromCache();
  return id;
}

export function removeMarker(id) {
  _cache.delete(id);
  delete _iconMap[id];
  syncFromCache();
  return true;
}

export function clearAllMarkers() {
  _cache.clear();
  for (const k of Object.keys(_iconMap)) delete _iconMap[k];
  markupItems = [];
  if (pointCloud) {
    try { getViewer()?.impl?.removeOverlay?.("marker-overlay", pointCloud); } catch(e) {}
    pointCloud = null;
  hideInfoCard();
  }
}

export function getMarkers() {
  return Array.from(_cache.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getMarkersByType(type) {
  return getMarkers().filter(m => m.type === type);
}

export function flyToMarker(id) {
  flyToMarkup(id);
}

// ── KPI Info Card API ─────────────────────────────────────

/** Place a KPI info card marker at world position with KPI data.
 *  Use this over model elements to display status, progress, etc.
 *  Example: placeKpiCard({x: 10, y: 20, z: 5}, {title: "IWP-12", status: "completed", progress: 100, description: "All tasks done"}) */
export function placeKpiCard(position, kpi) {
  ensureInit();
  const id = genId("kpi");
  _cache.set(id, {
    id, type: "kpi", position,
    label: kpi.title,
    kpiData: kpi,
    createdAt: Date.now(),
  });
  _iconMap[id] = 2; // green marker
  syncFromCache();
  // Auto-show info card immediately after placement.
  // syncFromCache() has already rebuilt markupItems synchronously,
  // so showInfoCardById can be called directly — no setTimeout needed.
  showInfoCardById(id);
  return id;
}

/** Update KPI data for an existing marker (for live dashboard updates). */
export function updateKpiCard(id, kpi) {
  const m = _cache.get(id);
  if (!m) return false;
  m.kpiData = { ...(m.kpiData || {}), ...kpi };
  if (kpi.title) m.label = kpi.title;
  syncFromCache();
  return true;
}

// ── Show/Hide All Cards Toggle ─────────────────────────────

let cardsVisibleState = false;
let currentCardIndex = 0;

/** Toggle all cards ON: show the first KPI card with cycle navigation. */
export function showAllCards() {
  if (markupItems.length === 0) return;
  cardsVisibleState = true;
  currentCardIndex = 0;
  showCardAtIndex(0);
}

/** Toggle all cards OFF: hide the info card. */
export function hideAllCards() {
  cardsVisibleState = false;
  if (labelDiv) labelDiv.style.display = 'none';
  if (selected !== null) selected = null;
}

/** Check if cards visibility is ON. */
export function isCardsVisible() { return cardsVisibleState; }

/** Toggle: if ON turn OFF, if OFF turn ON. */
export function toggleCardsVisibility() {
  if (cardsVisibleState) hideAllCards();
  else showAllCards();
}

/** Show next card in the cycle. */
export function showNextCard() {
  if (!cardsVisibleState || markupItems.length === 0) return;
  currentCardIndex = (currentCardIndex + 1) % markupItems.length;
  showCardAtIndex(currentCardIndex);
}

/** Show previous card in the cycle. */
export function showPrevCard() {
  if (!cardsVisibleState || markupItems.length === 0) return;
  currentCardIndex = (currentCardIndex - 1 + markupItems.length) % markupItems.length;
  showCardAtIndex(currentCardIndex);
}

function showCardAtIndex(idx) {
  if (!labelDiv || idx < 0 || idx >= markupItems.length) return;
  const item = markupItems[idx];
  // Find the marker's screen position
  const viewer = getViewer();
  let sx = 300, sy = 200;
  if (viewer) {
    try {
      const THREE = getTHREE();
      const V = THREE.Vector3;
      const wp = new V(item.x, item.y, item.z + 1.5);
      const sp = (viewer as any).worldToClient?.(wp);
      if (sp) { sx = sp.x; sy = sp.y; }
    } catch(e) {}
  }
  // Show the card with cycle nav footer
  const p = item.payload || {};
  const title = p.title || p.label || (`Marker #${item.id.slice(-4)}`);
  const status = p.status || '';
  const progress = typeof p.progress === 'number' ? p.progress : undefined;
  const desc = p.description || p.caption || '';
  const color = p.color || '#4a90d9';
  const statusColors = {
    completed: '#27ae60', done: '#27ae60', complete: '#27ae60',
    in_progress: '#f39c12', active: '#f39c12', ongoing: '#f39c12', inprogress: '#f39c12',
    pending: '#95a5a6', todo: '#95a5a6',
    blocked: '#e74c3c', warning: '#e74c3c', issue: '#e74c3c',
  };
  const sk = (status || '').toLowerCase().replace(/[\s-]/g, '_');
  const sc = statusColors[sk] || color;
  const sl = status ? status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';

  let html = '<div style="position:relative;min-width:140px;">';
  if (status) html += `<div style="display:inline-block;background:${sc};color:#fff;font-size:9px;font-weight:600;padding:1px 6px;border-radius:8px;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.3px;">${sl}</div>`;
  html += `<div style="font-weight:600;margin-bottom:3px;color:#fff;font-size:13px;">${title}</div>`;
  if (progress !== undefined) {
    const pct = Math.max(0, Math.min(100, progress));
    const bc = pct >= 100 ? '#27ae60' : pct >= 50 ? '#f39c12' : '#e74c3c';
    html += `<div style="margin:6px 0 4px;"><div style="display:flex;justify-content:space-between;font-size:9px;color:#aaa;margin-bottom:2px;"><span>Progress</span><span>${Math.round(pct)}%</span></div><div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${bc};border-radius:2px;transition:width 0.3s;"></div></div></div>`;
  }
  if (desc) html += `<div style="color:#bbb;font-size:10px;margin-top:4px;line-height:1.3;">${desc}</div>`;
  // Card counter + nav
  html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;border-top:1px solid rgba(255,255,255,0.1);padding-top:4px;">`;
  html += `<button onclick="import('/src/lib/viewer-tools/marker-service.ts').then(m => m.showPrevCard())" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);color:#aaa;border-radius:4px;padding:1px 8px;font-size:10px;cursor:pointer;">◀ Prev</button>`;
  html += `<span style="color:rgba(255,255,255,0.3);font-size:9px;">${idx + 1}/${markupItems.length}</span>`;
  html += `<button onclick="import('/src/lib/viewer-tools/marker-service.ts').then(m => m.showNextCard())" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);color:#aaa;border-radius:4px;padding:1px 8px;font-size:10px;cursor:pointer;">Next ▶</button>`;
  html += `</div></div>`;

  labelDiv.style.display = 'block';
  labelDiv.style.left = sx + 'px';
  labelDiv.style.top = sy + 'px';
  labelDiv.style.transform = 'translate(-50%, -120%)';
  labelDiv.innerHTML = html;
  selected = item.id;
}
