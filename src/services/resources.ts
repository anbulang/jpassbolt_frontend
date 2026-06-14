/**
 * Resource CRUD over /resources.json.
 *
 * Every function unwraps the standard envelope and returns `response.data.body`
 * with the correct type. Errors propagate (axios throws); callers catch and
 * surface them. 401 is handled globally by the api.ts interceptor.
 */
import { api } from '../api';
import type {
  ApiResponse,
  Resource,
  ResourceCreateRequest,
  ResourceUpdateRequest,
} from '../types';

export interface ListResourcesOptions {
  /** filter[is-favorite] — only the current user's favorites. */
  favorite?: boolean;
  /** contain[favorite]=1 — include each resource's favorite status. */
  containFavorite?: boolean;
  /**
   * contain[metadata]=1 — ask the server to include the encrypted v5 `metadata`
   * blob (+ metadata_key_id/metadata_key_type) for v5 rows so the vault can
   * decrypt and display them format-transparently. Forward-compatible and
   * harmless under v4 (the backend ignores it until task-2 wires metadata into
   * the resource DTO).
   */
  containMetadata?: boolean;
}

/** GET /resources.json — non-deleted resources with READ access. */
export async function listResources(
  opts: ListResourcesOptions = {}
): Promise<Resource[]> {
  const params: Record<string, string> = {};
  if (opts.favorite !== undefined) {
    params['filter[is-favorite]'] = String(opts.favorite);
  }
  if (opts.containFavorite) {
    params['contain[favorite]'] = '1';
  }
  if (opts.containMetadata) {
    params['contain[metadata]'] = '1';
  }
  const res = await api.get<ApiResponse<Resource[]>>('/resources.json', { params });
  return res.data.body ?? [];
}

/** GET /resources/{id}.json — single resource including its secrets[]. */
export async function getResource(id: string): Promise<Resource> {
  const res = await api.get<ApiResponse<Resource>>(`/resources/${id}.json`);
  return res.data.body as Resource;
}

/** POST /resources.json — create; creator gets OWNER. Returns 201 + body. */
export async function createResource(
  req: ResourceCreateRequest
): Promise<Resource> {
  const res = await api.post<ApiResponse<Resource>>('/resources.json', req);
  return res.data.body as Resource;
}

/** PUT /resources/{id}.json — update metadata and/or secrets. */
export async function updateResource(
  id: string,
  req: ResourceUpdateRequest
): Promise<Resource> {
  const res = await api.put<ApiResponse<Resource>>(`/resources/${id}.json`, req);
  return res.data.body as Resource;
}

/** DELETE /resources/{id}.json — soft delete (requires OWNER). */
export async function deleteResource(id: string): Promise<void> {
  await api.delete(`/resources/${id}.json`);
}
