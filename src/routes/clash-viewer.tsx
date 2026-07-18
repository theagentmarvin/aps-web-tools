import { useState, useEffect, useCallback } from "react";
import { useAuth } from "~/lib/auth-context";
import { ForgeViewer } from "~/lib/components/ForgeViewer";
import {
  getModelSets, getModelSetLatest, getClashViews,
  getClashTests, getClashResources,
  fetchClashData, fetchClashInstances, fetchClashDocuments,
  processClashes,
  getHubs, getProjects,
} from "~/lib/aps";
import type {
  ModelSet, ClashTest,
  ModelSetLatest, ProcessedClash, ClashView,
  ClashResource, Hub, Project,
} from "~/lib/aps";

export function ClashViewer() {
  const { login, isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Clash Viewer</h1>
        <p className="text-gray-500 mb-6">
          3D model coordination clash detection and inspection.
        </p>
        <div className="p-8 rounded-lg border border-brand-muted/20 bg-white text-center">
          <p className="text-lg mb-4 text-gray-600">🔒 Authentication required</p>
          <button
            onClick={login}
            className="px-6 py-2 rounded-lg bg-brand hover:bg-brand-light text-white font-medium transition-colors"
          >
            Sign in with Autodesk
          </button>
        </div>
      </div>
    );
  }

  return <ClashBrowser />;
}

// ── Clash Browser ────────────────────────────────────────────────────

function ClashBrowser() {
  const { getAccessToken } = useAuth();

  // ── Hub → Project cascading dropdowns ────────────────────────────
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [selectedHub, setSelectedHub] = useState<string>("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectSelectLoading, setProjectSelectLoading] = useState(false);

  // ── Model sets + clash state ─────────────────────────────────────
  const [modelSets, setModelSets] = useState<ModelSet[]>([]);
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [clashTests, setClashTests] = useState<ClashTest[]>([]);
  const [selectedTest, setSelectedTest] = useState<string>("");
  const [clashViews, setClashViews] = useState<ClashView[]>([]);
  const [selectedView, setSelectedView] = useState<string>("");
  const [clashes, setClashes] = useState<ProcessedClash[]>([]);
  const [modelUrns, setModelUrns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [selectedClash, setSelectedClash] = useState<ProcessedClash | null>(null);
  const [modelSetLatest, setModelSetLatest] = useState<ModelSetLatest | null>(null);
  const [elementNames, setElementNames] = useState<Record<number, string>>({});

  // ── Load hubs on mount ───────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = await getAccessToken();
      if (cancelled || !token) return;
      try {
        const h = await getHubs(token);
        if (!cancelled) setHubs(h);
      } catch { /* silent — user sees empty dropdown */ }
    }
    load();
    return () => { cancelled = true; };
  }, [getAccessToken]);

  // ── On hub select → load projects ────────────────────────────────

  useEffect(() => {
    if (!selectedHub) return;
    let cancelled = false;
    async function load() {
      setProjectSelectLoading(true);
      const token = await getAccessToken();
      if (cancelled || !token) return;
      try {
        const p = await getProjects(token, selectedHub);
        if (!cancelled) setProjects(p);
      } catch { /* silent */ }
      if (!cancelled) setProjectSelectLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [selectedHub, getAccessToken]);

  // ── Step 1: Fetch model sets for selected project ───────────────

  const loadModelSets = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("No access token");
      const sets = await getModelSets(token, pid);
      setModelSets(sets);
      setSelectedSet("");
      setClashTests([]);
      setSelectedTest("");
      setClashViews([]);
      setSelectedView("");
      setClashes([]);
      setModelUrns([]);
      setModelSetLatest(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [getAccessToken]);

  // Auto-load model sets when project changes
  useEffect(() => {
    if (projectId) loadModelSets(projectId);
  }, [projectId, loadModelSets]);

  // ── Step 2: Fetch latest version + tests + views ────────────────

  const loadClashData = useCallback(async () => {
    if (!projectId || !selectedSet) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("No access token");

      const latest = await getModelSetLatest(token, projectId, selectedSet);
      setModelSetLatest(latest);

      const version = latest.version || 1;

      const [tests, views] = await Promise.all([
        getClashTests(token, projectId, selectedSet, version),
        getClashViews(token, projectId, selectedSet),
      ]);

      setClashTests(tests);
      setClashViews(views);
      if (tests.length > 0) setSelectedTest(tests[0].id);
      if (views.length > 0) setSelectedView(views[0].name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedSet, getAccessToken]);

  // ── Step 3: Fetch clash resources + process ────────────────────

  const loadClashResults = useCallback(async () => {
    if (!projectId || !selectedSet || !selectedTest || !selectedView) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("No access token");

      let latest = modelSetLatest;
      if (!latest) {
        latest = await getModelSetLatest(token, projectId, selectedSet);
        setModelSetLatest(latest);
      }
      // Get S3 resource URLs — simple path (no modelsets/versions)
      const resources: ClashResource[] = await getClashResources(
        token, projectId, selectedTest
      );

      const byType: Record<string, string> = {};
      for (const r of resources) byType[r.type] = r.url;

      const clashUrl = byType["scope-version-clash.2.0.0"];
      const instanceUrl = byType["scope-version-clash-instance.2.0.0"];
      const docUrl = byType["scope-version-document.2.0.0"];

      if (!clashUrl || !instanceUrl || !docUrl) {
        throw new Error(`Missing clash resources. Found: ${Object.keys(byType).join(", ")}`);
      }

      const [clashData, clashInstances, clashDocs] = await Promise.all([
        fetchClashData(clashUrl),
        fetchClashInstances(instanceUrl),
        fetchClashDocuments(docUrl),
      ]);

      // Process clashes — views + documentVersions passed separately
      const { processed, modelUrns: urns } = processClashes(
        selectedView, clashDocs, clashInstances, clashData,
        clashViews, latest.documentVersions,
      );

      setClashes(processed);
      setModelUrns(urns);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedSet, selectedTest, selectedView, getAccessToken, modelSetLatest]);

  // ── Clash selection → viewer highlight ───────────────────────────

  const selectClash = useCallback(async (clash: ProcessedClash) => {
    console.log("[ClashViewer] selectClash:", { id: clash.id, leftDbId: clash.leftDbId, rightDbId: clash.rightDbId });
    setSelectedClash(clash);
    const api = (window as unknown as Record<string, unknown>).__forgeViewer as
      | {
          highlightClash: (l: number, r: number) => void;
          getElementName: (dbId: number) => Promise<string>;
        }
      | undefined;
    api?.highlightClash(clash.leftDbId, clash.rightDbId);

    // Resolve element names from viewer if not cached
    if (api?.getElementName) {
      const toResolve = [clash.leftDbId, clash.rightDbId].filter(
        (id) => !elementNames[id]
      );
      if (toResolve.length > 0) {
        const names = await Promise.all(toResolve.map((id) => api.getElementName(id)));
        setElementNames((prev) => {
          const next = { ...prev };
          toResolve.forEach((id, i) => { next[id] = names[i]; });
          return next;
        });
      }
    }
  }, [elementNames]);

  /** Resolve entity display: element name if available, else dbId fallback */
  const entityLabel = (entity: string, dbId: number) =>
    elementNames[dbId] || entity;

  // ── Status helpers ───────────────────────────────────────────────

  const statusColors: Record<string, string> = {
    Active: "text-yellow-700 bg-yellow-50 border-yellow-200",
    Reviewed: "text-brand bg-brand/10 border-brand-light/30",
    Resolved: "text-green-700 bg-green-50 border-green-200",
    Closed: "text-gray-500 bg-gray-100 border-gray-200",
  };

  const getStatusStyle = (status: unknown) =>
    statusColors[String(status ?? "")] || "text-gray-500 bg-gray-100 border-gray-200";

  const { getAccessToken: getToken } = useAuth();

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex-shrink-0 p-4 border-b border-brand-muted/20 bg-white/90 backdrop-blur shadow-sm relative z-10">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Hub dropdown */}
          <div className="min-w-[180px]">
            <label className="block text-xs text-gray-500 mb-1">Hub</label>
            <select
              value={selectedHub}
              onChange={(e) => {
                setSelectedHub(e.target.value);
                setProjects([]);
                setProjectId("");
                setModelSets([]);
              }}
              className="w-full px-3 py-1.5 rounded bg-white border border-brand-muted/30 text-sm text-gray-800"
            >
              <option value="">Select hub…</option>
              {hubs.map((h) => (
                <option key={h.id} value={h.id}>{h.attributes.name}</option>
              ))}
            </select>
          </div>

          {/* Project dropdown */}
          <div className="min-w-[220px]">
            <label className="block text-xs text-gray-500 mb-1">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={!selectedHub || projectSelectLoading}
              className="w-full px-3 py-1.5 rounded bg-white border border-brand-muted/30 text-sm text-gray-800 disabled:opacity-40"
            >
              <option value="">
                {projectSelectLoading ? "Loading…" : projects.length === 0 && selectedHub
                  ? "No projects" : "Select project…"}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.attributes.name}</option>
              ))}
            </select>
          </div>

          {/* Model Set dropdown (appears after project loads) */}
          {modelSets.length > 0 && (
            <div className="min-w-[200px]">
              <label className="block text-xs text-gray-500 mb-1">Model Set</label>
              <select
                value={selectedSet}
                onChange={(e) => setSelectedSet(e.target.value)}
                className="w-full px-3 py-1.5 rounded bg-white border border-brand-muted/30 text-sm text-gray-800"
              >
                <option value="">Select model set…</option>
                {modelSets.map((s) => (
                  <option key={s.modelSetId} value={s.modelSetId}>{s.name || s.modelSetId}</option>
                ))}
              </select>
            </div>
          )}

          {selectedSet && (
            <button
              onClick={loadClashData}
              disabled={loading}
              className="px-4 py-1.5 rounded bg-brand hover:bg-brand-light text-white text-sm disabled:opacity-50"
            >
              Load Tests
            </button>
          )}

          {/* Test dropdown */}
          {clashTests.length > 0 && (
            <div className="min-w-[200px]">
              <label className="block text-xs text-gray-500 mb-1">Test</label>
              <select
                value={selectedTest}
                onChange={(e) => setSelectedTest(e.target.value)}
                className="w-full px-3 py-1.5 rounded bg-white border border-brand-muted/30 text-sm text-gray-800"
              >
                {clashTests.map((t) => (
                  <option key={t.id} value={t.id}>
                    Test {String(t.id).slice(0, 8)}… ({t.status})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* View dropdown */}
          {clashViews.length > 0 && (
            <div className="min-w-[150px]">
              <label className="block text-xs text-gray-500 mb-1">View</label>
              <select
                value={selectedView}
                onChange={(e) => setSelectedView(e.target.value)}
                className="w-full px-3 py-1.5 rounded bg-white border border-brand-muted/30 text-sm text-gray-800"
              >
                {clashViews.map((v) => (
                  <option key={v.id || v.name} value={v.name}>{v.name}</option>
                ))}
              </select>
            </div>
          )}

          {selectedTest && selectedView && (
            <button
              onClick={loadClashResults}
              disabled={loading}
              className="px-4 py-1.5 rounded bg-brand-light hover:bg-brand-lighter text-white text-sm disabled:opacity-50"
            >
              Fetch Clashes
            </button>
          )}

          {modelUrns.length > 0 && (
            <span className="text-xs text-gray-500">
              {modelUrns.length} model{modelUrns.length !== 1 ? "s" : ""} ·{" "}
              {clashes.length} clash{clashes.length !== 1 ? "es" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Main area: sidebar + viewer */}
      <div className="flex-1 flex min-h-0">
        {/* Clash Sidebar */}
        <div className="w-72 flex-shrink-0 border-r border-brand-muted/20 overflow-y-auto bg-brand-surface relative z-10">
          {loading && clashes.length === 0 && (
            <div className="p-4 text-sm text-gray-500">Loading clash data…</div>
          )}
          {error && (
            <div className="p-3 m-2 rounded border border-red-200 bg-red-50 text-red-700 text-xs">
              {error}
            </div>
          )}
          {!loading && !error && clashes.length === 0 && modelUrns.length === 0 && (
            <div className="p-4 text-sm text-gray-500">
              Select a hub and project above. Model sets will load automatically.
            </div>
          )}
          {clashes.length > 0 && (
            <div className="p-2 space-y-1">
              {clashes.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectClash(c)}
                  className={`w-full text-left p-2 rounded text-xs transition-colors ${
                    selectedClash?.id === c.id
                      ? "bg-brand/20 border border-brand-light/50"
                      : "border border-transparent hover:bg-white/60 hover:border-brand-muted/30"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-gray-500 truncate">{String(c.id).slice(0, 8)}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] border ${getStatusStyle(c.status)}`}>
                      {c.status}
                    </span>
                  </div>
                  <p className="text-gray-700 truncate">{entityLabel(c.entity1, c.leftDbId)} ↔ {entityLabel(c.entity2, c.rightDbId)}</p>
                  <p className="text-gray-500 mt-0.5">
                    {c.distance > 0
                      ? `Clearance: ${c.distance.toFixed(1)}mm`
                      : `Penetration: ${Math.abs(c.penetration).toFixed(1)}mm`}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Viewer — always mounted; models load when available */}
        <div className="flex-1 min-w-0">
          <ForgeViewer
            getToken={getToken}
            expiresIn={3600}
            modelUrns={modelUrns}
            onViewerReady={() => setViewerReady(true)}
          />
        </div>
      </div>

      {/* Status bar */}
      {modelUrns.length > 0 && (
        <div className="flex-shrink-0 px-4 py-1 border-t border-brand-muted/20 bg-white/80 text-xs text-gray-400">
          {clashes.length} clashes · {modelUrns.length} models ·{" "}
          {viewerReady ? "viewer ready" : "viewer loading…"}
        </div>
      )}
    </div>
  );
}
