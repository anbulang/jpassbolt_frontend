/**
 * Folder CRUD over /folders.json plus the move endpoints
 * (/move/{foreignModel}/{foreignId}.json) and a pure buildFolderTree helper.
 *
 * Note the casing asymmetry the backend enforces:
 *   - /move/{foreignModel}/...  uses CAPITALIZED "Folder" / "Resource"
 *   - /share/{foreignModel}/... uses lowercase "folder" / "resource"
 */
import { api } from '../api';
import type {
  ApiResponse,
  Folder,
  FolderCreateRequest,
  FolderNode,
} from '../types';

export interface FolderContainOptions {
  /** filter[has-id] — narrow to a single folder id. */
  hasId?: string;
  childrenResources?: boolean;
  childrenFolders?: boolean;
  permissions?: boolean;
}

function buildContainParams(opts: FolderContainOptions): Record<string, string> {
  const params: Record<string, string> = {};
  if (opts.hasId) params['filter[has-id]'] = opts.hasId;
  if (opts.childrenResources) params['contain[children_resources]'] = '1';
  if (opts.childrenFolders) params['contain[children_folders]'] = '1';
  if (opts.permissions) params['contain[permissions]'] = '1';
  return params;
}

/** GET /folders.json — folders with READ access (invisible ones excluded). */
export async function listFolders(
  opts: FolderContainOptions = {}
): Promise<Folder[]> {
  const res = await api.get<ApiResponse<Folder[]>>('/folders.json', {
    params: buildContainParams(opts),
  });
  return res.data.body ?? [];
}

/** GET /folders/{id}.json — single folder with optional child/permission includes. */
export async function getFolder(
  id: string,
  opts: Omit<FolderContainOptions, 'hasId'> = {}
): Promise<Folder> {
  const res = await api.get<ApiResponse<Folder>>(`/folders/${id}.json`, {
    params: buildContainParams(opts),
  });
  return res.data.body as Folder;
}

/** POST /folders.json — create; creator gets OWNER. Returns 200 (not 201). */
export async function createFolder(req: FolderCreateRequest): Promise<Folder> {
  const res = await api.post<ApiResponse<Folder>>('/folders.json', req);
  return res.data.body as Folder;
}

/** PUT /folders/{id}.json — rename (requires UPDATE). */
export async function renameFolder(id: string, name: string): Promise<Folder> {
  const res = await api.put<ApiResponse<Folder>>(`/folders/${id}.json`, { name });
  return res.data.body as Folder;
}

/**
 * DELETE /folders/{id}.json — hard delete (requires UPDATE).
 * cascade=true deletes writable content; cascade=false moves it to root.
 */
export async function deleteFolder(id: string, cascade: boolean): Promise<void> {
  await api.delete(`/folders/${id}.json`, {
    params: { cascade: cascade ? '1' : '0' },
  });
}

/** PUT /move/Folder/{id}.json — move a folder in the current user's tree. */
export async function moveFolder(
  id: string,
  folder_parent_id: string | null
): Promise<void> {
  await api.put(`/move/Folder/${id}.json`, { folder_parent_id });
}

/** PUT /move/Resource/{id}.json — move a resource in the current user's tree. */
export async function moveResource(
  id: string,
  folder_parent_id: string | null
): Promise<void> {
  await api.put(`/move/Resource/${id}.json`, { folder_parent_id });
}

/**
 * Pure helper (no HTTP): nest a flat folder list into a tree by
 * `folder_parent_id`. Folders whose parent is null/absent (or whose parent is
 * not in the list) become roots. Order within each level follows input order.
 */
export function buildFolderTree(flat: Folder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const folder of flat) {
    byId.set(folder.id, { ...folder, children: [] });
  }

  const roots: FolderNode[] = [];
  for (const folder of flat) {
    const node = byId.get(folder.id)!;
    const parentId = folder.folder_parent_id;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
