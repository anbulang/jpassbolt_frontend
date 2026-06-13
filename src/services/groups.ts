/**
 * Group management over /groups.json, including the dry-run endpoints that
 * drive the client-side re-encryption workflow.
 *
 * Re-encryption: PUT /groups/{id}/dry-run.json returns `dry-run.SecretsNeeded`
 * (which (resource,user) pairs need a secret) and `dry-run.Secrets` (the
 * operator's own secret per resource to decrypt). The page decrypts those and
 * re-encrypts one secret per new member's public key, then sends them in the
 * final PUT /groups/{id}.json `secrets[]`.
 */
import { api } from '../api';
import type {
  ApiResponse,
  Group,
  GroupCreateRequest,
  GroupDeleteTransfer,
  GroupDryRunResult,
  GroupUpdateRequest,
  Resource,
} from '../types';

export interface ListGroupsOptions {
  /** filter[has-users] — group ids the listed users belong to. */
  hasUsers?: string[];
  /** filter[has-managers] — group ids the listed users manage. */
  hasManagers?: string[];
  /** contain[groups_users] and contain[groups_users.user]. */
  containUsers?: boolean;
  /**
   * Request the embedded user's profile. NOTE: the backend's GroupController.toUserDto
   * hard-codes the embedded user shape (id/username/role_id/active/deleted/disabled/
   * created/modified) and never emits profile, so this flag is a documented no-op kept
   * for caller intent. Display code falls back to username; full profiles come from a
   * per-user GET /users/{id}.json.
   */
  containUserProfile?: boolean;
  /**
   * Request the embedded user's gpgkey. Also a documented no-op for the same reason:
   * the backend never emits gpgkey on grouped users, so re-encryption resolves each
   * member's key via GET /users/{id}.json (see Groups/ShareDialog fallbacks).
   */
  containUserGpgkey?: boolean;
  /** contain[my_group_user]. */
  containMyGroupUser?: boolean;
}

export interface GetGroupOptions {
  containUsers?: boolean;
  /** No-op — see ListGroupsOptions.containUserProfile. */
  containUserProfile?: boolean;
  /** No-op — see ListGroupsOptions.containUserGpgkey. */
  containUserGpgkey?: boolean;
  containMyGroupUser?: boolean;
}

function buildGroupParams(
  opts: ListGroupsOptions | GetGroupOptions
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  if ('hasUsers' in opts && opts.hasUsers?.length) {
    params['filter[has-users][]'] = opts.hasUsers;
  }
  if ('hasManagers' in opts && opts.hasManagers?.length) {
    params['filter[has-managers][]'] = opts.hasManagers;
  }
  if (opts.containUsers) {
    params['contain[groups_users]'] = '1';
    params['contain[groups_users.user]'] = '1';
  }
  // contain[groups_users.user.profile] / .gpgkey are intentionally NOT sent: the
  // backend ignores them (it never emits those nested objects on grouped users), so
  // sending them is dead weight. Callers rely on the per-user GET fallback instead.
  if (opts.containMyGroupUser) params['contain[my_group_user]'] = '1';
  return params;
}

/** GET /groups.json — non-deleted groups with optional member includes. */
export async function listGroups(opts: ListGroupsOptions = {}): Promise<Group[]> {
  const res = await api.get<ApiResponse<Group[]>>('/groups.json', {
    params: buildGroupParams(opts),
  });
  return res.data.body ?? [];
}

/** GET /groups/{id}.json — single group with members. */
export async function getGroup(
  id: string,
  opts: GetGroupOptions = {}
): Promise<Group> {
  const res = await api.get<ApiResponse<Group>>(`/groups/${id}.json`, {
    params: buildGroupParams(opts),
  });
  return res.data.body as Group;
}

/** POST /groups.json — admin-only create. */
export async function createGroup(req: GroupCreateRequest): Promise<Group> {
  const res = await api.post<ApiResponse<Group>>('/groups.json', req);
  return res.data.body as Group;
}

/** PUT /groups/{id}.json — update name / members (manager or admin). */
export async function updateGroup(
  id: string,
  req: GroupUpdateRequest
): Promise<Group> {
  const res = await api.put<ApiResponse<Group>>(`/groups/${id}.json`, req);
  return res.data.body as Group;
}

/**
 * PUT /groups/{id}/dry-run.json — returns the SecretsNeeded / Secrets lists
 * for the re-encryption workflow (manager or admin).
 */
export async function updateGroupDryRun(
  id: string,
  req: GroupUpdateRequest
): Promise<GroupDryRunResult> {
  const res = await api.put<ApiResponse<GroupDryRunResult>>(
    `/groups/${id}/dry-run.json`,
    req
  );
  return res.data.body as GroupDryRunResult;
}

/** DELETE /groups/{id}.json — delete (manager or admin); throws (400) if sole owner. */
export async function deleteGroup(
  id: string,
  transfer?: GroupDeleteTransfer
): Promise<void> {
  await api.delete(`/groups/${id}.json`, {
    data: transfer ? { transfer } : undefined,
  });
}

/**
 * DELETE /groups/{id}/dry-run.json — sole-owner check. Resolves with the
 * accessible resources when the group can be deleted; throws (400) with the
 * sole_owner blocking list otherwise.
 */
export async function deleteGroupDryRun(id: string): Promise<Resource[]> {
  const res = await api.delete<ApiResponse<Resource[]>>(`/groups/${id}/dry-run.json`);
  return res.data.body ?? [];
}
