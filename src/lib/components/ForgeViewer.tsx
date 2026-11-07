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

  // ── Model loading (parallel, max 3) ──────────────────────────────

  const urnKey = modelUrns.join(",");
  useEffect(() => {
    if (!ready || modelUrns.length === 0) return;
    const v = viewerRef.current!;
    let cancelled = false;
    const urns = [...modelUrns];
    modelsRef.current = [];
    modelMapRef.current = new Map();
    const failures: string[] = [];
    let settled = 0;
    setFailed([]);
    cbRef.current.onProgress?.(0, urns.length);

    async function worker(queue: string[]) {
      while (queue.length && !cancelled) {
        const rawUrn = queue.shift()!;
        try {
          const model = await loadDoc(v, `urn:${urnify(rawUrn)}`);
          if (cancelled) return;
          modelsRef.current.push(model);
          modelMapRef.current.set(rawUrn, model);
        } catch (err) {
          console.warn("[ForgeViewer] load failed:", rawUrn, err);
          failures.push(rawUrn);
        }
        settled++;
        if (!cancelled) cbRef.current.onProgress?.(settled - failures.length, urns.length);
      }
    }

    const queue = [...urns];
    void Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, urns.length) }, () => worker(queue))).then(() => {
      if (cancelled) return;
      setFailed(failures);
      cbRef.current.onModelsLoaded?.(new Map(modelMapRef.current), failures);
    });

    return () => {
      cancelled = true;
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
