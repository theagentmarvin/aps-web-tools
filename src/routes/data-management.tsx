import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "~/lib/auth-context";
import { ForgeViewer } from "~/lib/components/ForgeViewer";
import { ElementTooltip } from "~/lib/viewer-tools/panels/ElementTooltip";
import { PropertyPanel } from "~/lib/viewer-tools/panels/PropertyPanel";
import { ColorLegend } from "~/lib/viewer-tools/panels/ColorLegend";
import { MarkerPanel } from "~/lib/viewer-tools/panels/MarkerPanel";
import { DashboardPanel } from "~/lib/viewer-tools/panels/DashboardPanel";

import { GanttPanel } from "~/lib/viewer-tools/panels/GanttPanel";
import {
  getHubs,
  getProjects,
  getTopFolders,
  getFolderContents,
  getItemTip,
} from "~/lib/aps";
import type { Hub, Project, FolderContent } from "~/lib/aps";

// ── Types ───────────────────────────────────────────────────────────

interface BreadcrumbEntry {
  label: string;
  onClick: () => void;
}

type BrowserLevel =
  | { kind: "hubs" }
  | { kind: "projects"; hub: Hub }
  | { kind: "topFolders"; hub: Hub; project: Project }
  | { kind: "folder"; hub: Hub; project: Project; path: FolderContent[]; folder: FolderContent };

interface LoadedModel {
  urn: string;
  name: string;
}

// ── Component ───────────────────────────────────────────────────────

export function DataManagement() {
  const { login, isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Data Management</h1>
        <p className="text-gray-500 mb-6">
          Browse your APS hubs, projects, and ACC Docs folder hierarchy.
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

  return <Browser />;
}

// ── Browser ─────────────────────────────────────────────────────────

const STORAGE_KEY = "aps-viewer-models";

function loadSavedModels(): LoadedModel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveModels(models: LoadedModel[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
}

function Browser() {
  const { getAccessToken } = useAuth();
  const [level, setLevel] = useState<BrowserLevel>({ kind: "hubs" });
  const [items, setItems] = useState<(Hub | Project | FolderContent)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<LoadedModel[]>(loadSavedModels);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const restoredRef = useRef(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const token = await getAccessToken();
      if (!token) throw new Error("No access token");

      let data: (Hub | Project | FolderContent)[];

      switch (level.kind) {
        case "hubs": {
          const hubs = await getHubs(token);
          data = hubs.filter((h) => h.type === "hubs");
          break;
        }
        case "projects": {
          const projects = await getProjects(token, level.hub.id);
          data = projects.filter((p) => p.type === "projects");
          break;
        }
        case "topFolders": {
          const folders = await getTopFolders(token, level.hub.id, level.project.id);
          data = folders;
          break;
        }
        case "folder": {
          const contents = await getFolderContents(
            token,
            level.project.id,
            level.folder.id
          );
          data = contents;
          break;
        }
      }

      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [level, getAccessToken]);

  useEffect(() => {
    if (!restoredRef.current && loadedModels.length > 0) {
      restoredRef.current = true;
      setLoading(false);
      return;
    }
    if (!restoredRef.current) {
      restoredRef.current = true;
    }
    fetch();
  }, [fetch]);

  // ── Navigation ─────────────────────────────────────────────────

  const breadcrumbs = buildBreadcrumbs(level, setLevel);

  const selectHub = (hub: Hub) => setLevel({ kind: "projects", hub });
  const selectProject = (project: Project) => {
    const lvl = level as Extract<BrowserLevel, { kind: "projects" | "topFolders" | "folder" }>;
    setLevel({ kind: "topFolders", hub: lvl.hub, project });
  };
  const selectFolder = (folder: FolderContent) => {
    const lvl = level as Extract<BrowserLevel, { kind: "topFolders" | "folder" }>;
    const path = lvl.kind === "folder" ? [...lvl.path, lvl.folder] : [];
    setLevel({ kind: "folder", hub: lvl.hub, project: lvl.project, path, folder });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isFolder = (item: any): boolean =>
    item.attributes?.extension?.type === "folders:autodesk.core:Folder" ||
    item.type === "folders";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isLoadableItem = (item: any): boolean =>
    item.attributes?.extension?.type === "items:autodesk.bim360:File" ||
    item.type === "items";

  // ── Open a model in the viewer ────────────────────────────────

  const openModel = useCallback(async (item: FolderContent) => {
    const token = await getAccessToken();
    if (!token) return;

    const lvl = level as Extract<BrowserLevel, { kind: "topFolders" | "folder" }>;
    const projectId = lvl.project.id;
    const itemId = item.id;
    const key = `${projectId}:${itemId}`;

    // Don't reload same model
    if (loadedModels.some((m) => m.urn === key)) return;
    setLoadingModel(key);

    try {
      const urn = await getItemTip(token, projectId, itemId);
      if (!urn) throw new Error("No model URN found — is this file published?");
      const updated = [...loadedModels, { urn, name: item.attributes.name }];
      setLoadedModels(updated);
      saveModels(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load model");
    } finally {
      setLoadingModel(null);
    }
  }, [getAccessToken, level, loadedModels]);

  const removeModel = useCallback((urn: string) => {
    setLoadedModels((prev) => {
      const updated = prev.filter((m) => m.urn !== urn);
      saveModels(updated);
      return updated;
    });
  }, []);

  const handleClick = async (item: Hub | Project | FolderContent) => {
    if (level.kind === "hubs" && item.type === "hubs") selectHub(item as Hub);
    else if (level.kind === "projects" && item.type === "projects") selectProject(item as Project);
    else if (isFolder(item)) selectFolder(item as FolderContent);
    else if (isLoadableItem(item)) await openModel(item as FolderContent);
  };

  // ── Helpers ───────────────────────────────────────────────────

  const getItemLabel = (item: Hub | Project | FolderContent): string => {
    const attrs = item.attributes as Record<string, unknown> | undefined;
    return (attrs?.name as string) || (attrs?.displayName as string) || String(item.id);
  };

  const getItemType = (item: Hub | Project | FolderContent): string => {
    if (item.type === "hubs") return "Hub";
    if (item.type === "projects") return "Project";
    if (isFolder(item)) return "Folder";
    if (isLoadableItem(item)) return "File";
    return item.type;
  };

  const getItemIcon = (item: Hub | Project | FolderContent): string => {
    if (item.type === "hubs") return "🏢";
    if (item.type === "projects") return "📁";
    if (isFolder(item)) return "📂";
    if (isLoadableItem(item)) return "📄";
    return "❓";
  };

  const getItemSub = (item: Hub | Project | FolderContent): string | null => {
    if (item.type === "hubs") {
      const h = item as Hub;
      const count = h.attributes?.extension?.data?.projectCount;
      return count !== undefined ? `${count} project${count === 1 ? "" : "s"}` : null;
    }
    if (item.type === "projects") {
      const p = item as Project;
      return p.attributes?.extension?.data?.projectType ?? null;
    }
    return null;
  };

  // ── Render ────────────────────────────────────────────────────

  const modelUrns = loadedModels.map((m) => m.urn);

  // If we have loaded models, show split view
  if (loadedModels.length > 0) {
    return (
      <div className="h-full flex flex-col">
        {/* Top bar: breadcrumbs + loaded models */}
        <div className="flex-shrink-0 px-4 py-2 border-b border-brand-muted/20 bg-white/90 flex items-center gap-3 flex-wrap">
          <nav className="flex items-center gap-1 text-sm text-gray-500">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1 whitespace-nowrap">
                {i > 0 && <span className="text-gray-400">/</span>}
                <button onClick={crumb.onClick} className="hover:text-gray-700 transition-colors">
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
          <span className="text-gray-400">|</span>
          {loadedModels.map((m) => (
            <span key={m.urn} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-brand/10 text-xs text-brand">
              🧊 {m.name}
              <button onClick={() => removeModel(m.urn)} className="ml-1 text-gray-400 hover:text-red-500">×</button>
            </span>
          ))}
        </div>

        {/* Main area: browser sidebar + viewer */}
        <div className="flex-1 flex min-h-0">
          {/* Browser sidebar */}
          <div className="w-72 flex-shrink-0 border-r border-brand-muted/20 flex flex-col">
            <div className="flex-1 overflow-y-auto bg-white">
            {loading && (
              <div className="space-y-2 p-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-14 rounded-lg bg-brand-surface animate-pulse" />
                ))}
              </div>
            )}
            {error && !loading && (
              <div className="p-3 m-2 rounded border border-red-200 bg-red-50">
                <p className="text-red-700 text-xs font-medium">Error</p>
                <p className="text-red-600 text-xs font-mono">{error}</p>
                <button onClick={fetch} className="mt-1 text-xs text-red-600 underline">Retry</button>
              </div>
            )}
            {!loading && !error && (
              <div className="space-y-0.5 p-1">
                {items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleClick(item)}
                    className="w-full flex items-center gap-2 p-2 rounded text-left hover:bg-brand-surface/60 transition-colors text-sm"
                  >
                    <span className="text-base flex-shrink-0">{getItemIcon(item)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{getItemLabel(item)}</p>
                      <p className="text-xs text-gray-400">{getItemType(item)}</p>
                    </div>
                    {getItemSub(item) && (
                      <span className="text-xs text-gray-400 flex-shrink-0">{getItemSub(item)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            </div>

            {/* Property discovery panel (appears when model is loaded) */}
            <div className="flex-shrink-0 h-64 border-t border-brand-muted/20">
              <PropertyPanel hasModel={loadedModels.length > 0} />
            </div>
            <ColorLegend />

            {/* Marker panel (appears when model is loaded) */}
            <div className="flex-shrink-0 h-48 border-t border-brand-muted/20">
              <MarkerPanel hasModel={loadedModels.length > 0} />
            </div>

            {/* Dashboard panel */}
            <div className="flex-shrink-0 h-80 border-t border-brand-muted/20">
              <DashboardPanel hasModel={loadedModels.length > 0} />
            </div>
          </div>

          {/* Viewer */}
          <div className="flex-1 min-w-0">
            <ForgeViewer
              getToken={getAccessToken}
              expiresIn={3600}
              modelUrns={modelUrns}
            />
            <ElementTooltip />
            <GanttPanel hasModel={loadedModels.length > 0} />
          </div>
        </div>

        {/* Status bar */}
        <div className="flex-shrink-0 px-4 py-1 border-t border-brand-muted/20 bg-white/80 text-xs text-gray-400 flex gap-4">
          <span>{loadedModels.length} model{loadedModels.length !== 1 ? "s" : ""} loaded</span>
          {loadingModel && <span>Loading {loadingModel.split(":")[1].slice(0, 12)}…</span>}
        </div>
      </div>
    );
  }

  // ── Browser-only view (no models loaded yet) ─────────────────

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Data Management</h1>

      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1 text-sm text-gray-500 mb-4 overflow-x-auto">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1 whitespace-nowrap">
            {i > 0 && <span className="text-gray-400">/</span>}
            <button
              onClick={crumb.onClick}
              className="hover:text-gray-700 transition-colors truncate max-w-[200px]"
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {/* Loading */}
      {loading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-brand-surface animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50 mb-4">
          <p className="text-red-700 text-sm font-medium mb-1">Error</p>
          <p className="text-red-600 text-sm font-mono">{error}</p>
          <button
            onClick={fetch}
            className="mt-2 text-xs text-red-600 hover:text-red-500 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && items.length === 0 && (
        <div className="p-8 rounded-lg border border-brand-muted/20 bg-white text-center text-gray-500">
          <p>Nothing here.</p>
        </div>
      )}

      {/* Items */}
      {!loading && !error && items.length > 0 && (
        <div className="space-y-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => handleClick(item)}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-brand-muted/20 bg-white hover:border-brand-muted/40 hover:bg-brand-surface/50 transition-all text-left"
            >
              <span className="text-xl flex-shrink-0">{getItemIcon(item)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{getItemLabel(item)}</p>
                <p className="text-xs text-gray-500">{getItemType(item)}</p>
              </div>
              {getItemSub(item) && (
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {getItemSub(item)}
                </span>
              )}
              <span className="text-gray-400 flex-shrink-0">→</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Breadcrumbs helper ──────────────────────────────────────────────

function buildBreadcrumbs(
  level: BrowserLevel,
  setLevel: (l: BrowserLevel) => void
): BreadcrumbEntry[] {
  const crumbs: BreadcrumbEntry[] = [
    { label: "Hubs", onClick: () => setLevel({ kind: "hubs" }) },
  ];

  if (level.kind === "hubs") return crumbs;

  const lvl = level as Extract<BrowserLevel, { kind: "projects" | "topFolders" | "folder" }>;
  crumbs.push({
    label: lvl.hub.attributes.name,
    onClick: () => setLevel({ kind: "projects", hub: lvl.hub }),
  });

  if (level.kind === "projects") return crumbs;

  const plvl = level as Extract<BrowserLevel, { kind: "topFolders" | "folder" }>;
  crumbs.push({
    label: plvl.project.attributes.name,
    onClick: () => setLevel({ kind: "topFolders", hub: plvl.hub, project: plvl.project }),
  });

  if (plvl.kind === "folder") {
    for (const f of plvl.path) {
      crumbs.push({
        label: f.attributes.name,
        onClick: () =>
          setLevel({
            kind: "folder",
            hub: plvl.hub,
            project: plvl.project,
            path: plvl.path.slice(
              0,
              plvl.path.findIndex((p) => p.id === f.id)
            ),
            folder: f,
          }),
      });
    }
    crumbs.push({ label: plvl.folder.attributes.name, onClick: () => {} });
  }

  return crumbs;
}
