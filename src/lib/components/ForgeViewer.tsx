/**
 * Forge Viewer v7 wrapper — React component.
 *
 * Uses Autodesk.Viewing.Private.GuiViewer3D for multi-model clash visualization.
 * Loading pattern: Document.load() → loadDocumentNode() with keepCurrentModels: true.
 * This is the proven pattern from the official APS blog and reference implementation.
 * Scripts loaded dynamically from Autodesk CDN.
 */
import { useEffect, useRef, useCallback, useState } from "react";

// Extend window for Autodesk globals
declare global {
  interface Window {
    Autodesk: {
      Viewing: {
        Initializer: (opts: Record<string, unknown>, cb: () => void) => void;
        Document: {
          load: (
            urn: string,
            ok: (d: DocumentNode) => void,
            fail: (c: number, m: string, e: unknown) => void
          ) => void;
        };
      };
    };
    THREE: {
      Vector4: new (r: number, g: number, b: number, a: number) => unknown;
      Matrix4: new () => Matrix4;
    };
  }
}

interface GuiViewer3D {
  start: (svgUrl?: string, options?: Record<string, unknown>) => number;
  setUp: (config: Record<string, unknown>) => void;
  setLightPreset: (preset: number) => void;
  loadDocumentNode: (
    doc: DocumentNode,
    viewable: unknown,
    options?: Record<string, unknown>
  ) => Promise<ModelHandle>;
  loadModel: (
    svfUrl: string,
    options: Record<string, unknown>,
    onSuccess?: (m: ModelHandle) => void,
    onError?: (c: number) => void
  ) => void;
  getProperties: (
    dbId: number,
    model: ModelHandle,
    cb: (props: unknown) => void
  ) => void;
  setThemingColor: (
    dbId: number | number[],
    color: unknown,
    model?: ModelHandle
  ) => void;
  clearThemingColors: (model?: ModelHandle) => void;
  fitToView: (dbIds: number[], model?: ModelHandle) => void;
  getState: () => Record<string, unknown>;
  restoreState: (state: Record<string, unknown>) => void;
  addEventListener: (event: string, handler: (e: unknown) => void) => void;
  removeEventListener: (event: string, handler: (e: unknown) => void) => void;
  impl: {
    visibilityManager: {
      isolate: (dbIds: number | number[], model?: ModelHandle) => void;
      aggregateIsolate: (dbIds: number[]) => void;
      show: (dbIds: number | number[], model?: ModelHandle) => void;
    };
    selector: {
      getSelection: () => { model: ModelHandle; dbIdArray: number[] }[];
    };
  };
}

interface DocumentNode {
  getRoot: () => {
    getDefaultGeometry: () => unknown;
    search: (query: Record<string, unknown>) => unknown[];
  };
}

interface ModelHandle {
  getModelKey: () => string;
  getDocumentNode: () => unknown;
  getExternalIdMapping: (cb: (m: Map<number, string>) => void) => void;
}

interface Matrix4 {
  setPosition: (pos: { x: number; y: number; z: number }) => Matrix4;
}

interface ForgeViewerProps {
  getToken: () => Promise<string | null>;
  expiresIn: number;
  modelUrns: string[]; // full version URNs (urn:adsk.wipprod:fs.file:vf.xxx?version=N)
  onViewerReady?: () => void;
}

export function ForgeViewer({
  getToken,
  expiresIn,
  modelUrns,
  onViewerReady,
}: ForgeViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GuiViewer3D | null>(null);
  const modelsRef = useRef<ModelHandle[]>([]);
  const [scriptsLoaded, setScriptsLoaded] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load Forge Viewer scripts
  useEffect(() => {
    let cancelled = false;

    async function loadScripts() {
      if ((window as unknown as Record<string, unknown>).Autodesk) {
        if (!cancelled) setScriptsLoaded(true);
        return;
      }

      try {
        await loadScript(
          "https://developer.api.autodesk.com/modelderivative/v2/viewers/7.0/viewer3D.min.js"
        );
        if (!cancelled) setScriptsLoaded(true);
      } catch (err) {
        if (!cancelled)
          setLoadError(`Failed to load Forge Viewer scripts: ${err}`);
      }
    }

    loadScripts();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Viewer lifecycle ───────────────────────────────────────────────
  //
  // Two effects instead of one:
  //   A) Create viewer (once) — guarded by canvas-presence check so
  //      React StrictMode double-mount doesn't create a second instance.
  //      StrictMode cleanup just sets cancelled; it does NOT destroy
  //      the viewer or remove the canvas.
  //   B) Dispose viewer on REAL unmount — empty dep array runs only on
  //      final unmount, not StrictMode's simulate-remount cycle.

  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const expiresRef = useRef(expiresIn);
  expiresRef.current = expiresIn;

  // (A) Create viewer — once per component lifetime
  useEffect(() => {
    if (!scriptsLoaded || !containerRef.current) return;

    // If a canvas already sits in the container, a viewer was already
    // created (StrictMode remount or genuine re-render). Don't double.
    if (containerRef.current.querySelector("canvas")) return;

    let cancelled = false;

    async function init() {
      const token = await tokenRef.current();
      if (cancelled || !token) return;

      const options = {
        env: "AutodeskProduction",
        getAccessToken: (cb: (t: string, e: number) => void) => {
          tokenRef.current().then((tok) => {
            if (tok) cb(tok, expiresRef.current);
          });
        },
        logLevel: 0,
      };

      window.Autodesk.Viewing.Initializer(options, async () => {
        if (cancelled) return;

        const viewer = new (
          window.Autodesk.Viewing as unknown as {
            Private: { GuiViewer3D: new (c: HTMLElement) => GuiViewer3D };
          }
        ).Private.GuiViewer3D(containerRef.current!);

        const started = viewer.start();
        if (started > 0) {
          console.error("[ForgeViewer] Failed to start viewer (WebGL?)");
          return;
        }

        viewer.setLightPreset(0);
        viewer.setUp({});
        viewerRef.current = viewer;
        setViewerReady(true);
        onViewerReady?.();
      });
    }

    init();

    return () => {
      cancelled = true;
      // Intentional: do NOT destroy the viewer or remove the canvas here.
      // StrictMode fires cleanup then re-runs the effect synchronously;
      // the canvas guard above is what prevents double-creation.
    };
  }, [scriptsLoaded]);

  // (B) Dispose viewer on real component unmount
  useEffect(() => {
    return () => {
      if (viewerRef.current) {
        try {
          const v = viewerRef.current as GuiViewer3D & { finish?: () => void };
          if (v.finish) v.finish();
        } catch {
          // Best-effort cleanup
        }
        viewerRef.current = null;
      }
    };
  }, []);

  // ── Model loading — runs whenever URNs change ─────────────────────

  useEffect(() => {
    if (!viewerReady || modelUrns.length === 0) return;

    const v = viewerRef.current!;
    let cancelled = false;

    async function loadModels() {
      // Clear previously loaded models
      modelsRef.current = [];

      // Encode URNs
      const encodedUrns = modelUrns.map((u) => `urn:${urnify(u)}`);
      console.log("[ForgeViewer] Loading", encodedUrns.length, "model(s)");

      let loaded = 0;
      for (const urn of encodedUrns) {
        if (cancelled) break;
        try {
          const model = await loadDocumentAsync(v, urn);
          modelsRef.current.push(model);
          loaded++;
          console.log(
            "[ForgeViewer] Model loaded",
            `(${loaded}/${modelUrns.length})`
          );
        } catch (err) {
          console.error("[ForgeViewer] Failed to load:", urn, err);
        }
      }

      console.log(
        "[ForgeViewer] All models processed:",
        loaded,
        "loaded of",
        modelUrns.length
      );
    }

    loadModels();

    return () => {
      cancelled = true;
    };
  }, [modelUrns.join(","), viewerReady]);

  // ── Public API exposed via window ──────────────────────────────────

  const getElementName = useCallback(
    (dbId: number): Promise<string> => {
      const viewer = viewerRef.current;
      const models = modelsRef.current;
      if (!viewer || models.length === 0)
        return Promise.resolve(`dbId:${dbId}`);

      return new Promise((resolve) => {
        const targetModel = models[models.length - 1];
        viewer.getProperties(dbId, targetModel, (props: unknown) => {
          const p = props as Record<string, unknown>;
          const name =
            (p.name as string) ||
            ((p.properties as Record<string, unknown>)?.name as string);
          resolve(String(name || `dbId:${dbId}`));
        });
      });
    },
    []
  );

  const highlightClash = useCallback(
    (leftDbId: number, rightDbId: number) => {
      const viewer = viewerRef.current;
      const models = modelsRef.current;
      if (!viewer || models.length === 0) return;

      const red = new window.THREE.Vector4(1, 0, 0, 1);
      const blue = new window.THREE.Vector4(0, 0.4, 1, 1);

      // Clear previous highlights
      for (const m of models) {
        viewer.clearThemingColors(m);
        viewer.impl.visibilityManager.isolate(-1, m);
      }

      // Highlight on the last loaded model
      const targetModel = models[models.length - 1];
      viewer.impl.visibilityManager.show(leftDbId, targetModel);
      viewer.impl.visibilityManager.show(rightDbId, targetModel);
      viewer.setThemingColor(leftDbId, red, targetModel);
      viewer.setThemingColor(rightDbId, blue, targetModel);
      viewer.fitToView([leftDbId, rightDbId], targetModel);
    },
    []
  );

  const clearHighlight = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const m of modelsRef.current) {
      viewer.clearThemingColors(m);
      viewer.impl.visibilityManager.aggregateIsolate([]);
    }
  }, []);

  // Expose API on window for page-level access
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__forgeViewer = {
      highlightClash,
      clearHighlight,
      getElementName,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__forgeViewer;
    };
  }, [highlightClash, clearHighlight, getElementName]);

  return (
    <div className="relative w-full h-full min-h-[60vh]">
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-10">
          <div className="p-4 rounded-lg border border-red-900/50 bg-red-950/30 text-red-400 text-sm">
            {loadError}
          </div>
        </div>
      )}
      {!scriptsLoaded && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-10">
          <div className="text-center">
            <div className="animate-spin text-3xl mb-2">⏳</div>
            <p className="text-gray-400 text-sm">Loading Forge Viewer…</p>
          </div>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full min-h-[60vh]" />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(script);
  });
}

/** Wrap Document.load in a Promise for async/await usage */
function loadDocumentAsync(
  viewer: GuiViewer3D,
  urn: string
): Promise<ModelHandle> {
  return new Promise((resolve, reject) => {
    window.Autodesk.Viewing.Document.load(
      urn,
      (doc) => {
        const viewables = doc.getRoot().getDefaultGeometry();
        if (!viewables) {
          reject(new Error("No viewables in document"));
          return;
        }

        const matrix = new window.THREE.Matrix4();
        viewer
          .loadDocumentNode(doc, viewables, {
            keepCurrentModels: true,
            globalOffset: { x: 0, y: 0, z: 0 },
            placementTransform: matrix.setPosition({ x: 0, y: 0, z: 0 }),
          })
          .then(resolve)
          .catch(reject);
      },
      (code, msg) => {
        reject(new Error(`Document.load failed [${code}]: ${msg}`));
      }
    );
  });
}

/** Base64-encode URN for Forge Viewer (matches reference repo pattern) */
function urnify(id: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(id);
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary).replace(/=/g, "");
}
