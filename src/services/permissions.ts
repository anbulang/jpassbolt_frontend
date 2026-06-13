/**
 * Permission listing over GET /permissions/resource/{resourceId}.json.
 *
 * This is the standard Passbolt ACL endpoint (PHP
 * PermissionsViewController::viewAcoPermissions, ported to
 * com.jpassbolt.api.controller.PermissionsController). It returns EVERY
 * permission row of the resource ACO — both User and Group AROs, and other
 * users' rows, not just the caller's — so the ShareDialog can render and edit
 * the complete current access list.
 *
 * Contain semantics (PHP isset() parity — a param PRESENT with ANY value, even
 * 0, activates the association; absent params stay off):
 *   contain[group]        — embed the full Group object on Group-ARO rows
 *   contain[user]         — embed the full User object on User-ARO rows
 *   contain[user.profile] — additionally embed the user's Profile (implies user)
 *
 * We always request all three so the dialog can show human-readable names and
 * avatars WITHOUT a second round-trip per ARO in the common case. The embedded
 * objects are only present when the matching contain flag was sent AND the
 * server could resolve them; callers must still tolerate their absence (e.g. a
 * Group row when contain[group] yields a soft-deleted/missing group) and fall
 * back to resolving aro_foreign_key via the users / groups service.
 *
 * Validation order (surfaced as thrown axios errors the caller maps to a
 * banner): non-UUID id -> 400 "The identifier should be a valid UUID.";
 * missing / soft-deleted / inaccessible resource -> 404 "The resource does not
 * exist." No pagination — the full ACL is returned in one call.
 *
 * NOTE: this endpoint is READ-ONLY. Mutating the ACL (add / change level /
 * remove) goes through the share service (PUT /share/resource/{id}.json),
 * because removing or lowering a permission needs no re-encryption while adding
 * an ARO requires a freshly re-encrypted secret per recipient public key.
 */
import { api } from '../api';
import type { ApiResponse, PermissionWithAro } from '../types';

export interface GetResourcePermissionsOptions {
  /** contain[group] — embed the Group object on Group rows (default: true). */
  containGroup?: boolean;
  /** contain[user] — embed the User object on User rows (default: true). */
  containUser?: boolean;
  /**
   * contain[user.profile] — additionally embed the Profile (first/last name +
   * avatar) on User rows; implies the user association (default: true).
   */
  containUserProfile?: boolean;
}

/**
 * GET /permissions/resource/{resourceId}.json — the resource's full ACL.
 *
 * Returns every permission row (User + Group AROs). Each row carries the 8 base
 * fields (id, aco, aco_foreign_key, aro, aro_foreign_key, type, created,
 * modified); when the matching contain flag is set, User rows additionally
 * carry an embedded `user` (with `profile` when contain[user.profile]) and
 * Group rows an embedded `group`. By default we request all three contains.
 */
export async function getResourcePermissions(
  resourceId: string,
  opts: GetResourcePermissionsOptions = {}
): Promise<PermissionWithAro[]> {
  const withGroup = opts.containGroup ?? true;
  const withUser = opts.containUser ?? true;
  const withUserProfile = opts.containUserProfile ?? true;

  const params: Record<string, string> = {};
  if (withGroup) params['contain[group]'] = '1';
  // contain[user.profile] implies the user association server-side, but send
  // contain[user] explicitly too so a profile-less request still embeds users.
  if (withUser || withUserProfile) params['contain[user]'] = '1';
  if (withUserProfile) params['contain[user.profile]'] = '1';

  const res = await api.get<ApiResponse<PermissionWithAro[]>>(
    `/permissions/resource/${resourceId}.json`,
    { params }
  );
  return res.data.body ?? [];
}
