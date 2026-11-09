/**
 * Forge Viewer v7 wrapper — React component.
 *
 * Script & CSS are loaded in index.html (canonical v7 pattern).
 * window.Autodesk.Viewing is guaranteed available before React mounts
 * because the <script> tag blocks parsing.
 *
 * Uses Private.GuiViewer3D for multi-model clash visualization.
 *
 * Key init pattern (from working reference):
 *   1. Pre-fetch token BEFORE Initializer (getAccessToken must be synchronous)
 *   2. env: 'AutodeskProduction' (not AutodeskProduction2)
 *   3. viewer.start() then viewer.setUp({ extensions })
 *
 * Multi-model: models load in parallel (max 3 concurrent). The component
 * keeps a map raw URN → model and reports failures instead of skipping them
 * silently (onModelsLoaded / onProgress, window.__apsViewer.getModelByUrn).
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "~/i18n";
import { registerShaderExtension } from "~/lib/viewer-tools/extensions/shader-extension";
import { registerMarkerExtension } from "~/lib/viewer-tools/extensions/marker-extension";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    Autodesk: { Viewing: any };
    THREE: { Vector4: new (r: number, g: number, b: number, a: number) => unknown };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelHandle = any;

export const TOOLKIT_EXTENSIONS = ["ApsViewerToolkit.Shader", "ApsViewerToolkit.Marker"];
export const DEFAULT_EXTENSIONS = ["Autodesk.DocumentBrowser", "Autodesk.DataVisualization", ...TOOLKIT_EXTENSIONS];

interface ForgeViewerProps {
  getToken: () => Promise<string | null>;
  expiresIn: number;
  /** Raw version URNs (not base64). */
  modelUrns: string[];
  /** Extensions passed to viewer.setUp. Default: DEFAULT_EXTENSIONS. */
  extensions?: string[];
  onViewerReady?: () => void;
  /** Called once all requested models settled. Keys are the raw URNs passed in. */
  onModelsLoaded?: (models: Map<string, ModelHandle>, failed: string[]) => void;
  onProgress?: (loaded: number, total: number) => void;
  /** Hide the built-in "model failed" banner (when the parent renders its own). */
  hideLoadErrors?: boolean;
}

const MAX_PARALLEL = 3;

export function ForgeViewer({
  getToken,
  expiresIn,
  modelUrns,
  extensions = DEFAULT_EXTENSIONS,
  onViewerReady,
  onModelsLoaded,
  onProgress,
  hideLoadErrors,
}: ForgeViewerProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GuiViewer3D | null>(null);
  const modelsRef = useRef<ModelHandle[]>([]);
  const modelMapRef = useRef<Map<string, ModelHandle>>(new Map());
  const startedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  // ── Stable refs ───────────────────────────────────────────────────
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const expiresRef = useRef(expiresIn);
  expiresRef.current = expiresIn;
  const cbRef = useRef({ onViewerReady, onModelsLoaded, onProgress });
  cbRef.current = { onViewerReady, onModelsLoaded, onProgress };
  const extensionsRef = useRef(extensions);

  // ── Viewer init (runs once) ──────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container || startedRef.current) return;

    const Viewing = window.Autodesk?.Viewing;
    if (!Viewing) {
      setInitError("Autodesk.Viewing not available");
      return;
    }

    let cancelled = false;
    startedRef.current = true;

    async function init() {
      // Pre-fetch token: getAccessToken MUST be synchronous.
      const token = await tokenRef.current();
      if (cancelled) return;
      let latestToken = token ?? "";
      if (!token) {
        setInitError("getToken() returned null — not authenticated");
        return;
      }

      Viewing.Initializer(
        {
          env: "AutodeskProduction",
          // Must answer synchronously: hand over the latest token, then refresh in the
          // background (server-side refresh; the browser never holds a refresh token).
          getAccessToken: (cb: (t: string, e: number) => void) => {
            cb(latestToken, expiresRef.current);
            void tokenRef.current().then((t) => {
              if (t) latestToken = t;
            });
          },
          logLevel: 0,
        },
        () => {
          if (cancelled) return;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Klass = (Viewing as any).Private?.GuiViewer3D;
            if (!Klass) {
              setInitError("Private.GuiViewer3D not found on Autodesk.Viewing");
              return;
            }
            const viewer = new Klass(container);
            viewer.start();

            // Register custom toolbar extensions BEFORE setUp, only if requested.
            const exts = extensionsRef.current;
            if (exts.includes("ApsViewerToolkit.Shader")) registerShaderExtension();
            if (exts.includes("ApsViewerToolkit.Marker")) registerMarkerExtension();
            viewer.setUp({ extensions: exts });

            viewerRef.current = viewer;
            setReady(true);
            cbRef.current.onViewerReady?.();
          } catch (err) {
            setInitError(`viewer init error: ${String(err)}`);
          }
        },
      );
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Dispose on unmount ───────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (viewerRef.current) {
        try {
          viewerRef.current.finish?.();
        } catch {
          /* best-effort */
        }
        viewerRef.current = null;
      }
      startedRef.current = false;
      setReady(false);
      setInitError(null);
      delete (window as unknown as Record<string, unknown>).__forgeViewer;
    };
  }, []);

  // ── Model loading: incremental (parallel, max 3) ─────────────────
  // `modelUrns` is the set of models that must be VISIBLE. Models already loaded are
  // reused (shown again), missing ones are loaded, and loaded models not requested are
  // hidden but kept cached, so switching between clash pairs does not reload anything.

  const failedRef = useRef<Set<string>>(new Set());
  const loadingRef = useRef<Map<string, Promise<void>>>(new Map());
  /** The models requested by the latest render (a load that finishes late checks it). */
  const latestWantedRef = useRef<Set<string>>(new Set());
  latestWantedRef.current = new Set(modelUrns);
  const urnKey = modelUrns.join(",");
  useEffect(() => {
    if (!ready || modelUrns.length === 0) return;
    const v = viewerRef.current!;
    let stale = false;
    const wanted = new Set(modelUrns);

    // Hide what is no longer requested, show what is (cached models).
    for (const [urn, model] of modelMapRef.current) setModelVisible(v, model, wanted.has(urn));

    const toLoad = modelUrns.filter((u) => !modelMapRef.current.has(u) && !failedRef.current.has(u) && !loadingRef.current.has(u));
    const done = () => modelUrns.filter((u) => modelMapRef.current.has(u)).length;
    cbRef.current.onProgress?.(done(), modelUrns.length);

    const loadOne = (rawUrn: string): Promise<void> => {
      const p = loadDoc(v, `urn:${urnify(rawUrn)}`)
        .then((model) => {
          modelsRef.current.push(model);
          modelMapRef.current.set(rawUrn, model);
          // A newer request may no longer want this model: keep it cached but hidden.
          if (!latestWantedRef.current.has(rawUrn)) setModelVisible(v, model, false);
        })
        .catch((err) => {
          console.warn("[ForgeViewer] load failed:", rawUrn, err);
          failedRef.current.add(rawUrn);
        })
        .finally(() => {
          loadingRef.current.delete(rawUrn);
          if (!stale) cbRef.current.onProgress?.(done(), modelUrns.length);
        });
      loadingRef.current.set(rawUrn, p);
      return p;
    };

    const queue = [...toLoad];
    const worker = async () => {
      while (queue.length) await loadOne(queue.shift()!);
    };
    // Also wait for loads started by an earlier request that this one needs.
    const pendingNeeded = modelUrns.map((u) => loadingRef.current.get(u)).filter((p): p is Promise<void> => !!p);
    void Promise.all([...Array.from({ length: Math.min(MAX_PARALLEL, toLoad.length) }, worker), ...pendingNeeded]).then(() => {
      if (stale) return;
      const failures = modelUrns.filter((u) => failedRef.current.has(u));
      setFailed(failures);
      const visible = new Map(modelUrns.flatMap((u) => (modelMapRef.current.has(u) ? [[u, modelMapRef.current.get(u)] as const] : [])));
      cbRef.current.onModelsLoaded?.(visible, failures);
    });

    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, urnKey]);

  // ── Public API (exposed for viewer-tools consumers) ──────────────

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__apsViewer = {
      getViewer: () => viewerRef.current,
      getModels: () => modelsRef.current,
      getModelByUrn: (urn: string) => modelMapRef.current.get(urn) ?? null,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__apsViewer;
    };
  }, [ready]);

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="relative h-full w-full">
      {initError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-bg">
          <div className="max-w-md p-4 text-center">
            <p className="mb-2 text-sm text-red-700">{t("viewer.initFailed")}</p>
            <p className="break-all font-mono text-xs text-gray-500">{initError}</p>
          </div>
        </div>
      )}
      {!ready && !initError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-bg">
          <div className="text-center">
            <span aria-hidden className="mb-2 inline-block h-6 w-6 animate-spin rounded-full border-2 border-brand/20 border-t-brand motion-reduce:animate-none" />
            <p className="text-sm text-gray-600">{t("viewer.initializing")}</p>
          </div>
        </div>
      )}
      {!hideLoadErrors && failed.length > 0 && (
        <div role="alert" className="absolute left-2 right-2 top-2 z-10 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          {failed.map((u) => (
            <div key={u}>{t("viewer.modelFailed", { name: u.split(":").pop() ?? u })}</div>
          ))}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Show or hide a whole loaded model (kept in memory either way). */
function setModelVisible(viewer: GuiViewer3D, model: ModelHandle, visible: boolean): void {
  try {
    const isVisible = (viewer.getVisibleModels?.() ?? []).includes(model);
    if (visible && !isVisible) viewer.showModel(model, true);
    else if (!visible && isVisible) viewer.hideModel(model);
  } catch (err) {
    console.warn("[ForgeViewer] show/hide model failed:", err);
  }
}

/** Base64-encode a raw URN for Document.load (strips = padding). */
function urnify(id: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(id))).replace(/=/g, "");
}

function loadDoc(viewer: GuiViewer3D, urn: string): Promise<ModelHandle> {
  return new Promise((resolve, reject) => {
    window.Autodesk.Viewing.Document.load(
      urn,
      (doc: { getRoot: () => { getDefaultGeometry: () => unknown }; getViewablePath: (v: unknown) => string }) => {
        const viewables = doc.getRoot().getDefaultGeometry();
        if (!viewables) {
          reject(new Error("No viewables"));
          return;
        }
        viewer.loadModel(
          doc.getViewablePath(viewables),
          { keepCurrentModels: true, globalOffset: { x: 0, y: 0, z: 0 } },
          (model: ModelHandle) => resolve(model),
          (code: number) => reject(new Error(`loadModel [${code}]`)),
        );
      },
      (code: number, msg: string) => reject(new Error(`Document.load [${code}]: ${msg}`)),
    );
  });
}
