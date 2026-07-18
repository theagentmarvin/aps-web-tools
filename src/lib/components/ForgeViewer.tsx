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
 */
import { useEffect, useRef, useCallback, useState } from "react";

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
type ModelHandle = any;

interface ForgeViewerProps {
  getToken: () => Promise<string | null>;
  expiresIn: number;
  modelUrns: string[];
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
  const startedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // ── Token refs (stable across renders) ────────────────────────────
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const expiresRef = useRef(expiresIn);
  expiresRef.current = expiresIn;

  // ── Viewer init (runs once) ──────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container || startedRef.current) return;

    const Viewing = window.Autodesk?.Viewing;
    if (!Viewing) {
      console.error("[ForgeViewer] Autodesk.Viewing not available — script missing?");
      return;
    }

    let cancelled = false;
    startedRef.current = true;

    async function init() {
      // Pre-fetch token: getAccessToken MUST be synchronous.
      // The Forge Viewer calls it internally during init and hangs
      // if the callback is async (won't fire until the event loop yields).
      console.log("[ForgeViewer] fetching token…");
      const token = await tokenRef.current();
      if (cancelled) return;

      if (!token) {
        const msg = "getToken() returned null — not authenticated";
        console.error("[ForgeViewer]", msg);
        setInitError(msg);
        return;
      }
      console.log("[ForgeViewer] token obtained, calling Initializer…");

      Viewing.Initializer(
        {
          env: "AutodeskProduction",
          getAccessToken: (cb: (t: string, e: number) => void) => {
            // Synchronous — matches working reference implementation
            cb(token, expiresRef.current);
          },
          logLevel: 0,
        },
        () => {
          if (cancelled) return;
          console.log("[ForgeViewer] Initializer callback fired");

          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Klass = (Viewing as any).Private?.GuiViewer3D;
            if (!Klass) {
              const msg = "Private.GuiViewer3D not found on Autodesk.Viewing";
              console.error("[ForgeViewer]", msg);
              setInitError(msg);
              return;
            }

            const viewer = new Klass(container);
            viewer.start();
            viewer.setUp({
              extensions: ["Autodesk.DocumentBrowser"],
            });

            viewerRef.current = viewer;
            console.log("[ForgeViewer] ready — viewer created, started, and set up");
            setReady(true);
            onViewerReady?.();
          } catch (err) {
            const msg = `viewer init error: ${String(err)}`;
            console.error("[ForgeViewer]", msg);
            setInitError(msg);
          }
        },
      );
    }

    init();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dispose on unmount ───────────────────────────────────────────

  useEffect(() => {
    return () => {
      console.log("[ForgeViewer] unmount — disposing viewer");
      if (viewerRef.current) {
        try { viewerRef.current.finish?.(); } catch { /* best-effort */ }
        viewerRef.current = null;
      }
      startedRef.current = false;
      setReady(false);
      setInitError(null);
      // Clean up global API
      delete (window as unknown as Record<string, unknown>).__forgeViewer;
    };
  }, []);

  // ── Model loading (triggers when viewer is ready AND urns available) ─

  useEffect(() => {
    if (!ready || modelUrns.length === 0) return;

    const v = viewerRef.current!;
    let cancelled = false;

    async function loadModels() {
      console.log("[ForgeViewer] loading", modelUrns.length, "model(s)…");
      modelsRef.current = [];

      for (const rawUrn of modelUrns) {
        if (cancelled) break;
        // URNs from APS API are raw (e.g. "urn:adsk.objects:…").
        // Document.load needs base64-encoded URN without padding.
        const urn = `urn:${urnify(rawUrn)}`;
        try {
          console.log("[ForgeViewer] loading:", urn, "(from", rawUrn.slice(0, 40) + "…)");
          const model = await loadDoc(v, urn);
          modelsRef.current.push(model);
          console.log("[ForgeViewer] model loaded:", urn);
        } catch (err) {
          console.error("[ForgeViewer] load failed:", urn, err);
        }
      }
      console.log("[ForgeViewer] done —", modelsRef.current.length, "model(s) loaded");
    }

    loadModels();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, modelUrns.join(",")]);

  // ── Public API ───────────────────────────────────────────────────

  const highlightClash = useCallback((leftDbId: number, rightDbId: number) => {
    const v = viewerRef.current;
    const models = modelsRef.current;
    if (!v || models.length === 0) return;

    const red = new window.THREE.Vector4(1, 0, 0, 1);
    const blue = new window.THREE.Vector4(0, 0.4, 1, 1);

    for (const m of models) {
      v.clearThemingColors(m);
      v.impl.visibilityManager.isolate(-1, m);
    }
    for (const model of models) {
      v.impl.visibilityManager.show(leftDbId, model);
      v.impl.visibilityManager.show(rightDbId, model);
      v.setThemingColor(leftDbId, red, model);
      v.setThemingColor(rightDbId, blue, model);
    }
    v.fitToView([leftDbId, rightDbId], models[models.length - 1]);
  }, []);

  const clearHighlight = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    for (const m of modelsRef.current) {
      v.clearThemingColors(m);
      v.impl.visibilityManager.aggregateIsolate([]);
    }
  }, []);

  const getElementName = useCallback((dbId: number): Promise<string> => {
    const v = viewerRef.current;
    const models = modelsRef.current;
    if (!v || models.length === 0) return Promise.resolve(`dbId:${dbId}`);

    const attempts = models.map(
      (model) =>
        new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve(""), 5000);
          v.getProperties(dbId, model, (props: unknown) => {
            clearTimeout(t);
            const p = props as Record<string, unknown>;
            resolve((p.name || (p.properties as Record<string, unknown>)?.name || "") as string);
          });
        }),
    );

    return Promise.race([...attempts, new Promise<string>((r) => setTimeout(() => r(""), 5000))])
      .then((name) => name || `dbId:${dbId}`);
  }, []);

  // ── Expose public API on window for clash-viewer ─────────────────

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__forgeViewer = {
      highlightClash, clearHighlight, getElementName,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__forgeViewer;
    };
  }, [highlightClash, clearHighlight, getElementName]);

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="relative w-full h-full">
      {initError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-10">
          <div className="text-center max-w-md p-4">
            <p className="text-red-400 text-sm mb-2">Viewer initialization failed</p>
            <p className="text-gray-500 text-xs font-mono break-all">{initError}</p>
          </div>
        </div>
      )}
      {!ready && !initError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-10">
          <div className="text-center">
            <div className="animate-spin text-3xl mb-2">⏳</div>
            <p className="text-gray-400 text-sm">Initializing viewer…</p>
          </div>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />
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
        if (!viewables) { reject(new Error("No viewables")); return; }
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
