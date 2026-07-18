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

export interface ItemTip {
  id: string; // urn
  type: string;
  attributes: {
    name: string;
    displayName: string;
    extension: { type: string; version: string };
  };
  relationships: {
    derivatives: { data: { id: string; type: string } };
    tip: { data: { id: string; type: string } };
    versions: { data: { id: string; type: string }[] };
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
): Promise<ItemTip> {
  const data = await apsFetch(
    `/data/v1/projects/${projectId}/items/${itemId}/tip`,
    token
  ) as { data: ItemTip };
  return data.data;
}
