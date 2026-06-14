/**
 * v5 metadata transport layer.
 *
 * Pure transport — NO crypto, NO business logic. Mirrors the settings.ts shape:
 * every function unwraps the standard envelope (`response.data.body`) and falls
 * back to a well-formed default when the body is null, so callers never crash on
 * an absent settings row (the backend itself falls back to defaults, never
 * 404/500). Errors propagate (axios throws); callers catch and surface them.
 *
 * Shared by:
 *   - feature-vault  (listMetadataKeys + getMetadataTypesSettings for read)
 *   - feature-form   (getMetadataTypesSettings for create-gating)
 *   - feature-admin  (read + write all)
 */
import { api } from '../api';
import type {
  ApiResponse,
  MetadataKey,
  MetadataKeysSettings,
  MetadataKeysSettingsUpdate,
  MetadataTypesSettings,
  MetadataTypesSettingsUpdate,
} from '../types';

/**
 * The seeded backend default for the types policy: everything v4, all v5
 * creation disabled, all v4 creation enabled, no up/downgrade. Used as the
 * fallback so callers always receive a well-formed 14-field object even when
 * the settings row is absent.
 */
export const DEFAULT_METADATA_TYPES_SETTINGS: MetadataTypesSettings = {
  default_resource_types: 'v4',
  default_folder_type: 'v4',
  default_tag_type: 'v4',
  default_comment_type: 'v4',
  allow_creation_of_v5_resources: false,
  allow_creation_of_v5_folders: false,
  allow_creation_of_v5_tags: false,
  allow_creation_of_v5_comments: false,
  allow_creation_of_v4_resources: true,
  allow_creation_of_v4_folders: true,
  allow_creation_of_v4_tags: true,
  allow_creation_of_v4_comments: true,
  allow_v5_v4_downgrade: false,
  allow_v4_v5_upgrade: false,
};

/** The seeded backend default for the keys policy. */
export const DEFAULT_METADATA_KEYS_SETTINGS: MetadataKeysSettings = {
  allow_usage_of_personal_keys: true,
  zero_knowledge_key_share: false,
};

export interface ListMetadataKeysOptions {
  /** contain[metadata_private_keys]=1 — embed the current user's private-key copies. */
  containPrivateKeys?: boolean;
  /** filter[deleted] — true=deleted only, false=active only, omit=unconstrained. */
  deleted?: boolean;
  /** filter[expired] — true=expired only, false=active only, omit=unconstrained. */
  expired?: boolean;
}

/**
 * GET /metadata/keys.json — org metadata keys. With `containPrivateKeys` the
 * current user's encrypted private-key copies are embedded (scoped to them).
 */
export async function listMetadataKeys(
  opts: ListMetadataKeysOptions = {}
): Promise<MetadataKey[]> {
  const params: Record<string, string> = {};
  if (opts.containPrivateKeys) {
    params['contain[metadata_private_keys]'] = '1';
  }
  if (opts.deleted !== undefined) {
    params['filter[deleted]'] = String(opts.deleted);
  }
  if (opts.expired !== undefined) {
    params['filter[expired]'] = String(opts.expired);
  }
  const res = await api.get<ApiResponse<MetadataKey[]>>('/metadata/keys.json', {
    params,
  });
  return res.data.body ?? [];
}

/**
 * GET /metadata/types/settings.json — the create-format policy. Always returns
 * a well-formed 14-field object (falls back to all-v4 defaults if body is null).
 */
export async function getMetadataTypesSettings(): Promise<MetadataTypesSettings> {
  const res = await api.get<ApiResponse<MetadataTypesSettings>>(
    '/metadata/types/settings.json'
  );
  return res.data.body ?? DEFAULT_METADATA_TYPES_SETTINGS;
}

/**
 * GET /metadata/keys/settings.json — the keys policy. Falls back to
 * {allow_usage_of_personal_keys:true, zero_knowledge_key_share:false}.
 */
export async function getMetadataKeysSettings(): Promise<MetadataKeysSettings> {
  const res = await api.get<ApiResponse<MetadataKeysSettings>>(
    '/metadata/keys/settings.json'
  );
  return res.data.body ?? DEFAULT_METADATA_KEYS_SETTINGS;
}

/**
 * POST /metadata/types/settings.json — admin write. The backend returns 400 if
 * any v5 flag is enabled without an active metadata key; callers must surface it.
 */
export async function updateMetadataTypesSettings(
  req: MetadataTypesSettingsUpdate
): Promise<MetadataTypesSettings> {
  const res = await api.post<ApiResponse<MetadataTypesSettings>>(
    '/metadata/types/settings.json',
    req
  );
  return res.data.body ?? req;
}

/** POST /metadata/keys/settings.json — admin write. */
export async function updateMetadataKeysSettings(
  req: MetadataKeysSettingsUpdate
): Promise<MetadataKeysSettings> {
  const res = await api.post<ApiResponse<MetadataKeysSettings>>(
    '/metadata/keys/settings.json',
    req
  );
  return res.data.body ?? req;
}
