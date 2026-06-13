/**
 * Share endpoints: search AROs, apply a share, simulate a share.
 *
 * Correctness invariant (enforced by callers, surfaced via these typed
 * payloads): adding any ARO requires BOTH a Permission AND a Secret encrypted
 * with THAT recipient's public key. The caller fetches+decrypts the existing
 * secret with the in-memory key, re-encrypts once per recipient, and sends
 * them here in ShareRequest.secrets.
 *
 * Casing: /share/{foreignModel}/... uses lowercase "resource" / "folder"
 * (unlike /move/{foreignModel}/... which is capitalized).
 */
import { api } from '../api';
import type {
  ApiResponse,
  Aro,
  ShareRequest,
  ShareSimulateResult,
  SharePermissionItem,
} from '../types';

export interface SearchArosOptions {
  /** filter[search]. */
  search?: string;
  /** contain[groups_users]. */
  containGroupsUsers?: boolean;
  /** contain[gpgkey]. */
  containGpgkey?: boolean;
  /** contain[role]. */
  containRole?: boolean;
}

/**
 * GET /share/search-aros.json — merged users + groups (25 each), sorted
 * alphabetically. When no contain params are passed, the backend enables all
 * of them by default; profile is always included.
 */
export async function searchAros(opts: SearchArosOptions = {}): Promise<Aro[]> {
  const params: Record<string, string> = {};
  if (opts.search) params['filter[search]'] = opts.search;
  if (opts.containGroupsUsers) params['contain[groups_users]'] = '1';
  if (opts.containGpgkey) params['contain[gpgkey]'] = '1';
  if (opts.containRole) params['contain[role]'] = '1';
  const res = await api.get<ApiResponse<Aro[]>>('/share/search-aros.json', {
    params,
  });
  return res.data.body ?? [];
}

/**
 * PUT /share/{foreignModel}/{foreignId}.json — apply permission (+ secret)
 * changes. `foreignModel` is "resource" or "folder" (folders carry no
 * secrets). nullBody response — resolves to void.
 */
export async function applyShare(
  foreignModel: 'resource' | 'folder',
  foreignId: string,
  req: ShareRequest
): Promise<void> {
  await api.put(`/share/${foreignModel}/${foreignId}.json`, req);
}

/**
 * POST /share/simulate/resource/{id}.json — dry-run a resource share; returns
 * which users would be added / removed. (Defined for resources only — folders
 * 404.)
 */
export async function simulateShare(
  resourceId: string,
  permissions: SharePermissionItem[]
): Promise<ShareSimulateResult> {
  const res = await api.post<ApiResponse<ShareSimulateResult>>(
    `/share/simulate/resource/${resourceId}.json`,
    { permissions, secrets: null }
  );
  return res.data.body as ShareSimulateResult;
}
