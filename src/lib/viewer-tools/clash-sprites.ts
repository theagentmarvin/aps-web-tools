/**
 * Clash point markers as Autodesk.DataVisualization sprites: screen-space icons of a fixed
 * pixel size (they never scale with the model, sink into slabs or hide the elements), the
 * same mechanism as the official APS IoT extensions demo
 * (autodesk-platform-services/aps-iot-extensions-demo, SensorSpritesExtension.js).
 *
 * Icons are drawn on a canvas at runtime (no external icon hosts). Positions are world
 * coordinates; the coordinator loads models with globalOffset {0,0,0}, so world = model.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SpriteSpec {
  id: string;
  label: string;
  position: { x: number; y: number; z: number };
  active: boolean;
}

const SPRITE_PX = 24;
const ACTIVE_RED = "#A32428";
const DBID_BASE = 9_000_000; // synthetic ids, never model dbIds

let ext: any = null;
let loading: Promise<any> | null = null;
let clickViewer: any = null;
let clickHandler: ((ev: any) => void) | null = null;
const dbIdToClash = new Map<number, string>();
const styleCache = new Map<string, any>();

function core(): any {
  return (window as any).Autodesk?.DataVisualization?.Core;
}

/** Load (once) the DataVisualization extension on this viewer. Null when unavailable. */
async function ensureExtension(viewer: any): Promise<any> {
  if (ext && ext.viewer === viewer) return ext;
  if (!loading || clickViewer !== viewer) {
    styleCache.clear();
    loading = viewer.loadExtension("Autodesk.DataVisualization").then(
      (e: any) => (ext = e),
      (err: unknown) => {
        console.warn("[clash-sprites] Autodesk.DataVisualization not available:", err);
        ext = null;
        return null;
      },
    );
  }
  return loading;
}

/** Round badge: red with a white ring (active clash) or white with an orange ring + number. */
function iconUrl(label: string, active: boolean): string {
  const size = 64; // drawn at 64 px, displayed at SPRITE_PX: crisp on HiDPI
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const r = size / 2;
  g.beginPath();
  g.arc(r, r, r - 3, 0, Math.PI * 2);
  g.fillStyle = active ? ACTIVE_RED : "#FFFFFF";
  g.fill();
  g.lineWidth = active ? 7 : 6;
  g.strokeStyle = active ? "#FFFFFF" : "#E69F00";
  g.stroke();
  if (active) {
    // Outer dark hairline so the white ring reads on light backgrounds.
    g.beginPath();
    g.arc(r, r, r - 1, 0, Math.PI * 2);
    g.lineWidth = 2;
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.stroke();
  }
  const text = active ? "!" : label.slice(0, 3);
  g.fillStyle = active ? "#FFFFFF" : "#1F2937";
  g.font = `bold ${text.length > 2 ? 22 : 30}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, r, r + 2);
  return c.toDataURL("image/png");
}

function styleFor(label: string, active: boolean): any {
  const key = `${active ? "A" : "N"}:${active ? "" : label}`;
  let s = styleCache.get(key);
  if (!s) {
    const C = core();
    const T = (window as any).THREE;
    s = new C.ViewableStyle(C.ViewableType.SPRITE, new T.Color(0xffffff), iconUrl(label, active));
    styleCache.set(key, s);
  }
  return s;
}

/**
 * Replace all clash sprites. Returns false if DataVisualization is unavailable (the caller
 * should fall back to its own markers).
 */
export async function setClashSprites(viewer: any, specs: SpriteSpec[], onClick?: (clashId: string) => void): Promise<boolean> {
  const gen = ++generation;
  const e = await ensureExtension(viewer);
  const C = core();
  const T = (window as any).THREE;
  if (!e || !C || !T) return false;
  if (gen !== generation) return true; // superseded by a newer call
  e.removeAllViewables();
  dbIdToClash.clear();

  // Click wiring (one listener per viewer).
  if (clickViewer !== viewer || !clickHandler) {
    if (clickViewer && clickHandler) clickViewer.removeEventListener(C.MOUSE_CLICK, clickHandler);
    clickViewer = viewer;
    clickHandler = (ev: any) => {
      const id = dbIdToClash.get(ev?.dbId);
      if (id) currentOnClick?.(id);
    };
    viewer.addEventListener(C.MOUSE_CLICK, clickHandler);
  }
  currentOnClick = onClick ?? null;
  if (!specs.length) return true;

  const data = new C.ViewableData();
  data.spriteSize = SPRITE_PX;
  // Inactive first, active last, so the active badge draws on top.
  const ordered = [...specs].sort((a, b) => Number(a.active) - Number(b.active));
  ordered.forEach((s, i) => {
    const dbId = DBID_BASE + i;
    dbIdToClash.set(dbId, s.id);
    data.addViewable(new C.SpriteViewable(new T.Vector3(s.position.x, s.position.y, s.position.z), styleFor(s.label, s.active), dbId));
  });
  await data.finish();
  // A newer call may have replaced the sprites meanwhile; only the latest set is shown.
  if (gen === generation && ext === e) e.addViewables(data);
  return true;
}

let currentOnClick: ((clashId: string) => void) | null = null;
let generation = 0;

export function clearClashSprites(): void {
  generation++;
  try {
    ext?.removeAllViewables();
  } catch {
    /* viewer gone */
  }
  dbIdToClash.clear();
  currentOnClick = null;
}
