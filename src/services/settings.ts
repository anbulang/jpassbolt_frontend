/**
 * Read-only reference data shared across pages: server settings, roles, and
 * resource types.
 */
import { api } from '../api';
import type { ApiResponse, ResourceType, Role, ServerSettings } from '../types';

/**
 * GET /settings.json — server settings (public; guest view is reduced).
 * With `includeHeader === false` the backend returns the bare settings map at
 * the top level (no envelope), so we read `response.data` directly in that
 * case; otherwise we unwrap the envelope body.
 */
export async function getServerSettings(
  includeHeader = true
): Promise<ServerSettings> {
  if (!includeHeader) {
    const res = await api.get<ServerSettings>('/settings.json', {
      params: { 'contain[header]': '0' },
    });
    return res.data;
  }
  const res = await api.get<ApiResponse<ServerSettings>>('/settings.json');
  return (res.data.body ?? {}) as ServerSettings;
}

/** GET /roles.json — all roles (admin / user / guest). */
export async function getRoles(): Promise<Role[]> {
  const res = await api.get<ApiResponse<Role[]>>('/roles.json');
  return res.data.body ?? [];
}

/** GET /resource-types.json — active v4 resource types. */
export async function getResourceTypes(): Promise<ResourceType[]> {
  const res = await api.get<ApiResponse<ResourceType[]>>('/resource-types.json');
  return res.data.body ?? [];
}

/** GET /resource-types/{id}.json — a single resource type (no v5/deleted filter). */
export async function getResourceType(id: string): Promise<ResourceType> {
  const res = await api.get<ApiResponse<ResourceType>>(
    `/resource-types/${id}.json`
  );
  return res.data.body as ResourceType;
}
