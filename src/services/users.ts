/**
 * User management over /users.json.
 *
 * The backend renders the userIndexAndView shape (base fields + profile +
 * role + gpgkey + groups_users + last_logged_in). Admin-only operations
 * (create / role+disabled edit / delete) return 403 for non-admins; callers
 * catch and surface that.
 */
import { api } from '../api';
import type {
  ApiResponse,
  User,
  UserCreateRequest,
  UserDeleteTransfer,
  UserUpdateRequest,
} from '../types';

export interface ListUsersOptions {
  /** filter[search] — case-insensitive on username / first / last name. */
  search?: string;
  /** filter[is-active] — admin-only; ignored for non-admins. */
  isActive?: boolean;
}

/** GET /users.json — non-deleted users (ordered by username asc). */
export async function listUsers(opts: ListUsersOptions = {}): Promise<User[]> {
  const params: Record<string, string> = {};
  if (opts.search) params['filter[search]'] = opts.search;
  if (opts.isActive !== undefined) {
    params['filter[is-active]'] = opts.isActive ? '1' : '0';
  }
  const res = await api.get<ApiResponse<User[]>>('/users.json', { params });
  return res.data.body ?? [];
}

/** GET /users/{id}.json — by UUID or the "me" alias. */
export async function getUser(idOrMe: string): Promise<User> {
  const res = await api.get<ApiResponse<User>>(`/users/${idOrMe}.json`);
  return res.data.body as User;
}

/** POST /users.json — admin invite-style create (inactive until setup). */
export async function createUser(req: UserCreateRequest): Promise<User> {
  const res = await api.post<ApiResponse<User>>('/users.json', req);
  return res.data.body as User;
}

/** PUT /users/{id}.json — update profile (self/admin), role+disabled (admin). */
export async function updateUser(
  id: string,
  req: UserUpdateRequest
): Promise<User> {
  const res = await api.put<ApiResponse<User>>(`/users/${id}.json`, req);
  return res.data.body as User;
}

/** DELETE /users/{id}.json — admin soft delete with optional ownership transfer. */
export async function deleteUser(
  id: string,
  transfer?: UserDeleteTransfer
): Promise<void> {
  await api.delete(`/users/${id}.json`, {
    data: transfer ? { transfer } : undefined,
  });
}

/**
 * DELETE /users/{id}/dry-run.json — validate delete preconditions only.
 * Resolves when the user can be deleted; throws (400) on a sole-owner
 * conflict so the caller can surface the blocking message.
 */
export async function deleteUserDryRun(id: string): Promise<void> {
  await api.delete(`/users/${id}/dry-run.json`);
}
