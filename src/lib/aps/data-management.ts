/**
 * APS Data Management API client.
 *
 * Base: https://developer.api.autodesk.com
 * Proxied through Vite dev server at /api/aps/
 * All functions require an access token — inject via useAuth().getAccessToken()
 */

export interface Hub {
  id: string; // b.{accountId}
  type: string;
  attributes: {
    name: string;
    extension: { data: { projectCount: number } };
    region: string;
  };
}

export interface Project {
  id: string; // b.{projectId}
  type: string;
  attributes: {
    name: string;
    extension: {
      data: {
        projectType: string;
        issueContainerId?: string;
      };
    };
  };
}

export interface FolderContent {
  id: string;
  type: string;
  attributes: {
    name: string;
    displayName: string;
    createTime: string;
    createUserId: string;
    extension: {
      type: string;
      version: string;
      schema: { href: string };
      data: Record<string, unknown>;
    };
  };
}

async function apsFetch(path: string, token: string): Promise<unknown> {
  const res = await fetch(`/api/aps${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`APS ${path}: ${res.status} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch all hubs accessible to the authenticated user.
 */
export async function getHubs(token: string): Promise<Hub[]> {
  const data = await apsFetch("/project/v1/hubs", token) as { data: Hub[] };
  return data.data;
}

/**
 * Fetch projects for a hub. Uses page[limit]=200 for max efficiency.
 */
export async function getProjects(token: string, hubId: string): Promise<Project[]> {
  const data = await apsFetch(
    `/project/v1/hubs/${hubId}/projects?page[limit]=200`,
    token
  ) as { data: Project[] };
  return data.data;
}

/**
 * Fetch top-level folders for a project.
 * Requires the hub ID — APS doesn't accept the "_" wildcard here.
 */
export async function getTopFolders(token: string, hubId: string, projectId: string): Promise<FolderContent[]> {
  const data = await apsFetch(
    `/project/v1/hubs/${hubId}/projects/${projectId}/topFolders`,
    token
  ) as { data: FolderContent[] };
  return data.data;
}

/**
 * Fetch contents of a folder.
 */
export async function getFolderContents(
  token: string,
  projectId: string,
  folderId: string
): Promise<FolderContent[]> {
  const data = await apsFetch(
    `/data/v1/projects/${projectId}/folders/${folderId}/contents`,
    token
  ) as { data: FolderContent[] };
  return data.data;
}

/**
 * Get the latest version (tip) of an item.
 * The tip's id is the URN for the Model Derivative API.
 */
export async function getItemTip(
  token: string,
  projectId: string,
  itemId: string
): Promise<string> {
  const log: string[] = [];

  // Try /versions endpoint first — more reliable than /tip for ACC Docs
  try {
    const versionsRaw = await apsFetch(
      `/data/v1/projects/${projectId}/items/${encodeURIComponent(itemId)}/versions`,
      token
    ) as { data: { id: string }[] };
    log.push(`versions: ${JSON.stringify(versionsRaw).slice(0, 200)}`);
    if (versionsRaw.data?.length > 0) {
      const latestUrn = versionsRaw.data[versionsRaw.data.length - 1].id;
      log.push(`picked: ${latestUrn}`);
      console.log("[getItemTip]", ...log);
      return latestUrn;
    }
  } catch (e) {
    log.push(`versions err: ${String(e).slice(0, 100)}`);
  }

  // Fallback: try tip endpoint
  try {
    const tipRaw = await apsFetch(
      `/data/v1/projects/${projectId}/items/${encodeURIComponent(itemId)}/tip`,
      token
    ) as { data: { id: string } };
    log.push(`tip: ${JSON.stringify(tipRaw).slice(0, 200)}`);
    const urn = tipRaw.data?.id || "";
    console.log("[getItemTip]", ...log);
    return urn;
  } catch (e) {
    log.push(`tip err: ${String(e).slice(0, 100)}`);
  }

  console.log("[getItemTip] ALL FAILED", ...log);
  throw new Error(`getItemTip failed:\n${log.join("\n")}`);
}
