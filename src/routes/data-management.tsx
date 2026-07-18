import { useState, useEffect, useCallback } from "react";
import { useAuth } from "~/lib/auth-context";
import {
  getHubs,
  getProjects,
  getTopFolders,
  getFolderContents,
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

// ── Component ───────────────────────────────────────────────────────

export function DataManagement() {
  const { login, isAuthenticated } = useAuth();

  // Auth gate
  if (!isAuthenticated) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Data Management</h1>
        <p className="text-gray-500 mb-6">
          Browse your APS hubs, projects, and ACC Docs folder hierarchy.
        </p>
        <div className="p-8 rounded-lg border border-gray-800 bg-gray-900 text-center">
          <p className="text-lg mb-4 text-gray-400">🔒 Authentication required</p>
          <button
            onClick={login}
            className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
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

function Browser() {
  const { getAccessToken } = useAuth();
  const [level, setLevel] = useState<BrowserLevel>({ kind: "hubs" });
  const [items, setItems] = useState<(Hub | Project | FolderContent)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const isFolder = (item: Hub | Project | FolderContent): item is FolderContent =>
    (item as FolderContent).attributes?.extension?.type === "folders:autodesk.core:Folder" ||
    (item as FolderContent).type === "folders";

  const isItem = (item: Hub | Project | FolderContent): boolean =>
    (item as FolderContent).attributes?.extension?.type === "items:autodesk.bim360:File" ||
    (item as FolderContent).type === "items";

  const handleClick = (item: Hub | Project | FolderContent) => {
    if (level.kind === "hubs" && item.type === "hubs") selectHub(item as Hub);
    else if (level.kind === "projects" && item.type === "projects") selectProject(item as Project);
    else if (isFolder(item)) selectFolder(item as FolderContent);
    // items are leaves for now
  };

  const getItemLabel = (item: Hub | Project | FolderContent): string => {
    const attrs = item.attributes as Record<string, unknown> | undefined;
    return (attrs?.name as string) || (attrs?.displayName as string) || String(item.id);
  };

  const getItemType = (item: Hub | Project | FolderContent): string => {
    if (item.type === "hubs") return "Hub";
    if (item.type === "projects") return "Project";
    if (isFolder(item)) return "Folder";
    if (isItem(item)) return "File";
    return item.type;
  };

  const getItemIcon = (item: Hub | Project | FolderContent): string => {
    if (item.type === "hubs") return "🏢";
    if (item.type === "projects") return "📁";
    if (isFolder(item)) return "📂";
    if (isItem(item)) return "📄";
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

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Data Management</h1>

      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1 text-sm text-gray-400 mb-4 overflow-x-auto">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1 whitespace-nowrap">
            {i > 0 && <span className="text-gray-600">/</span>}
            <button
              onClick={crumb.onClick}
              className="hover:text-white transition-colors truncate max-w-[200px]"
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
            <div
              key={i}
              className="h-14 rounded-lg bg-gray-900 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="p-4 rounded-lg border border-red-900/50 bg-red-950/30 mb-4">
          <p className="text-red-400 text-sm font-medium mb-1">Error</p>
          <p className="text-red-300 text-sm font-mono">{error}</p>
          <button
            onClick={fetch}
            className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && items.length === 0 && (
        <div className="p-8 rounded-lg border border-gray-800 bg-gray-900 text-center text-gray-500">
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
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-800 bg-gray-900 hover:border-gray-700 hover:bg-gray-800/50 transition-colors text-left"
            >
              <span className="text-xl flex-shrink-0">{getItemIcon(item)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{getItemLabel(item)}</p>
                <p className="text-xs text-gray-500">{getItemType(item)}</p>
              </div>
              {getItemSub(item) && (
                <span className="text-xs text-gray-600 flex-shrink-0">
                  {getItemSub(item)}
                </span>
              )}
              <span className="text-gray-600 flex-shrink-0">→</span>
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
