/**
 * Shared TypeScript types for the JPassbolt frontend.
 *
 * Single source of truth for every shape exchanged with the Spring Boot
 * backend (`com.jpassbolt.api`). All field names are snake_case to mirror the
 * backend JSON exactly (the API maps Java camelCase fields to snake_case JSON
 * via @JsonProperty). `LocalDateTime` values are serialized as RFC3339 strings
 * (e.g. "2026-06-13T13:39:25+00:00"), so they are typed as `string` here.
 *
 * Imported by every service file in src/services/* and by the pages/components.
 */

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

/**
 * The header of the standard Passbolt response envelope. The backend always
 * emits the seven spec-required fields; services only depend on `status`,
 * `message`, `code`, `url`, but `id`/`action`/`servertime` are typed for
 * completeness.
 */
export interface ApiHeader {
  id?: string;
  status: 'success' | 'error';
  message: string;
  code: number;
  url: string;
  /** Unix seconds (integer). */
  servertime?: number;
  /** Stable per-endpoint action UUID derived from the url. */
  action?: string;
}

/**
 * Every JSON endpoint returns this envelope. `body` is the typed payload (or
 * literal `null` for the nullBody / DELETE success responses). Services always
 * unwrap and return `response.data.body`.
 */
export interface ApiResponse<T> {
  header: ApiHeader;
  body: T | null;
}

// ---------------------------------------------------------------------------
// Permission model (ACO / ARO)
// ---------------------------------------------------------------------------

/** READ = 1, UPDATE/ADMIN = 7, OWNER = 15. */
export type PermissionType = 1 | 7 | 15;

/** Named constants for the integer permission levels. */
export const PERMISSION = {
  READ: 1,
  UPDATE: 7,
  OWNER: 15,
} as const;

export interface Permission {
  id: string;
  /** ACO type, e.g. "Resource" or "Folder". */
  aco: string;
  /** ACO id (resource / folder id). */
  aco_foreign_key: string;
  /** ARO type. */
  aro: 'User' | 'Group';
  /** ARO id (user / group id). */
  aro_foreign_key: string;
  type: PermissionType;
  created: string;
  modified: string;
}

/**
 * A permission row from GET /permissions/resource/{id}.json with the optional
 * embedded ARO display objects the endpoint includes when the matching
 * `contain[...]` flag is requested.
 *
 * - `user` is present only on `aro === 'User'` rows AND when contain[user] or
 *   contain[user.profile] was sent (the nested `profile` only with
 *   contain[user.profile]).
 * - `group` is present only on `aro === 'Group'` rows AND when contain[group]
 *   was sent.
 *
 * Both may still be `null` / absent if the server could not resolve the ARO
 * (e.g. a soft-deleted group), so consumers must tolerate their absence and
 * fall back to resolving `aro_foreign_key` via the users / groups service. This
 * is purely a display-enrichment type — it extends, and never replaces, the
 * base `Permission` shape used everywhere else.
 */
export interface PermissionWithAro extends Permission {
  /** Embedded user (User ARO + contain[user] / contain[user.profile]). */
  user?: User | null;
  /** Embedded group (Group ARO + contain[group]). */
  group?: Group | null;
}

// ---------------------------------------------------------------------------
// Resources & secrets
// ---------------------------------------------------------------------------

/** A per-user PGP-encrypted secret row. */
export interface Secret {
  id: string | null;
  user_id: string;
  resource_id: string;
  /** Armored PGP ciphertext. */
  data: string;
  created: string;
  modified: string;
}

/** A secret item in a write payload (create / update / share). */
export interface SecretWrite {
  user_id?: string;
  resource_id?: string;
  /** Armored PGP ciphertext (required). */
  data: string;
}

export interface Resource {
  id: string;
  name: string;
  username: string;
  uri: string;
  description: string;
  deleted: boolean;
  expired: string | null;
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
  resource_type_id: string;
  /** Included on get-with-secrets / create / update responses. */
  secrets?: Secret[];
  /**
   * Included when contain[favorite]=1. `null` (the key is always present in
   * that mode) when the resource is not a favorite of the current user.
   */
  favorite?: Favorite | null;
  /**
   * v5 metadata (see "v5 metadata" section below). STRICTLY OPTIONAL — the
   * backend does not emit these today (task-2 gap), and a v4 resource never
   * carries them. When present (v5 resource), `name`/`username`/`uri`/
   * `description` live encrypted inside `metadata` instead of these columns,
   * and the format-transparent resolver projects them back. `metadata` is the
   * armored PGP MESSAGE; `metadata_key_id`/`metadata_key_type` say which key
   * decrypts it.
   */
  metadata?: string | null;
  metadata_key_id?: string | null;
  metadata_key_type?: MetadataKeyType | null;
}

export interface ResourceCreateRequest {
  // v4 cleartext columns: REQUIRED for v4 creates, OMITTED for v5 (the real
  // values live encrypted in `metadata`). Optional so the v5 path can leave
  // them out entirely — PHP rejects any non-null v4 field on a v5 payload
  // ("V4 related fields are not supported for V5."), so sending '' is wrong.
  name?: string;
  username?: string;
  uri?: string;
  description?: string;
  resource_type_id: string;
  /** Destination folder in the creator's tree; omit / null = root. */
  folder_parent_id?: string;
  secrets?: SecretWrite[];
  /**
   * v5 metadata write triple (optional). When the org policy selects v5 AND a
   * usable metadata key exists, the form sends these INSTEAD of the cleartext
   * `name`/`username`/`uri`/`description` fields. Strictly optional so the v4
   * cleartext path is unchanged.
   */
  metadata?: string | null;
  metadata_key_id?: string | null;
  metadata_key_type?: MetadataKeyType | null;
}

export interface ResourceUpdateRequest {
  name?: string;
  username?: string;
  uri?: string;
  description?: string;
  resource_type_id?: string;
  secrets?: SecretWrite[];
  /** v5 metadata write triple (optional). See ResourceCreateRequest. */
  metadata?: string | null;
  metadata_key_id?: string | null;
  metadata_key_type?: MetadataKeyType | null;
}

export interface ResourceType {
  id: string;
  /** e.g. "password-string", "password-and-description", "totp". */
  slug: string;
  name: string;
  description: string | null;
  /** Deserialized JSON-schema definition object. */
  definition: unknown;
  /** Soft-delete timestamp; null = active (v4). */
  deleted: string | null;
  created: string;
  modified: string;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface Folder {
  id: string;
  name: string;
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
  /** Parent in the current user's tree; null = root. */
  folder_parent_id?: string | null;
  /** True when only a single user can see the folder. */
  personal: boolean;
  /** contain[permissions]=1. */
  permissions?: Permission[];
  /** contain[children_resources]=1 — direct child resources (flat). */
  children_resources?: Resource[];
  /** contain[children_folders]=1 — direct child folders (flat). */
  children_folders?: Folder[];
}

/** Client-built tree node (folders are returned flat by the API). */
export interface FolderNode extends Folder {
  children: FolderNode[];
}

export interface FolderCreateRequest {
  name: string;
  /** null / omit = root. */
  folder_parent_id?: string | null;
}

export interface FolderUpdateRequest {
  name: string;
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

export interface Favorite {
  id: string;
  user_id: string;
  foreign_key: string;
  /** Always "Resource" (capitalized) in responses. */
  foreign_model: 'Resource';
  created: string;
  modified: string;
}

// ---------------------------------------------------------------------------
// Identity: users, profiles, roles, gpg keys, groups
// ---------------------------------------------------------------------------

export interface Avatar {
  url: {
    small: string;
    medium: string;
  };
}

export interface Profile {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  created: string;
  modified: string;
  /** Always present in profile responses (placeholder URLs by default). */
  avatar?: Avatar | null;
}

export interface Role {
  id: string;
  name: 'admin' | 'user' | 'guest' | (string & {});
  description: string | null;
  created: string;
  modified: string;
}

export interface GpgKey {
  id: string;
  user_id: string;
  armored_key: string;
  bits: number | null;
  uid: string;
  key_id: string;
  fingerprint: string;
  type: string | null;
  expires: string | null;
  key_created: string | null;
  deleted: boolean;
  created: string;
  modified: string;
}

export interface GroupUser {
  id: string;
  group_id: string;
  user_id: string;
  is_admin: boolean;
  created: string;
  /** Embedded when contain[groups_users.user] is requested. */
  user?: User | null;
}

export interface User {
  id: string;
  role_id: string;
  username: string;
  active: boolean;
  deleted: boolean;
  /** Disabled timestamp; null for active accounts. */
  disabled: string | null;
  created: string;
  modified: string;
  /** Not yet tracked by the backend — always null. */
  last_logged_in?: string | null;
  profile?: Profile | null;
  role?: Role | null;
  gpgkey?: GpgKey | null;
  groups_users?: GroupUser[];
}

export interface Group {
  id: string;
  name: string;
  deleted?: boolean;
  /** Present on the search-aros group element. */
  user_count?: number;
  created: string;
  modified: string;
  created_by?: string;
  modified_by?: string;
  groups_users?: GroupUser[];
  my_group_user?: GroupUser | null;
}

// User / group write payloads ------------------------------------------------

export interface UserCreateRequest {
  username: string;
  role_id: string;
  profile: {
    first_name: string;
    last_name: string;
  };
}

export interface UserUpdateRequest {
  role_id?: string;
  /** ISO-8601 datetime string (or null to re-enable). Admin-only. */
  disabled?: string | null;
  profile?: {
    first_name?: string;
    last_name?: string;
  };
}

/** Ownership-transfer payload for user / group deletion. */
export interface UserDeleteTransfer {
  owners?: { id: string; aco_foreign_key: string }[];
  managers?: { id: string; group_id: string }[];
}

export interface GroupCreateRequest {
  name: string;
  groups_users?: { user_id: string; is_admin?: boolean }[];
}

export interface GroupUserChange {
  /** groups_users id of an existing membership (omit to add). */
  id?: string;
  user_id: string;
  is_admin?: boolean;
  /** Mark an existing membership for removal. */
  delete?: boolean;
}

export interface GroupUpdateRequest {
  name?: string;
  groups_users?: GroupUserChange[];
  /** Re-encrypted secrets for members gaining access. */
  secrets?: SecretWrite[];
}

/** Ownership-transfer payload for group deletion. */
export interface GroupDeleteTransfer {
  owners?: { id: string; aco_foreign_key: string }[];
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

/**
 * An ARO returned by GET /share/search-aros.json — either a `User` (has
 * `username`) or a `Group` (has `name`). Discriminate by the presence of
 * `username`.
 */
export type Aro = User | Group;

/** Type guard: true when the ARO is a User (vs a Group). */
export function isUserAro(aro: Aro): aro is User {
  return typeof (aro as User).username === 'string';
}

export interface SharePermissionItem {
  /** Locates an existing permission (omit for new AROs). */
  id?: string;
  aro?: 'User' | 'Group';
  aro_foreign_key?: string;
  type?: PermissionType;
  /** Mark an existing permission for removal. */
  delete?: boolean;
  /** Informational only (ignored server-side). */
  is_new?: boolean;
}

export interface ShareRequest {
  permissions?: SharePermissionItem[];
  /** Folders carry no secrets — pass undefined / null for folder shares. */
  secrets?: SecretWrite[] | null;
}

/** Result of POST /share/simulate/resource/{id}.json. */
export interface ShareSimulateResult {
  changes: {
    added: { User: { id: string } }[];
    removed: { User: { id: string } }[];
  };
}

// ---------------------------------------------------------------------------
// Group dry-run (re-encryption workflow)
// ---------------------------------------------------------------------------

/**
 * Result of PUT /groups/{id}/dry-run.json. Note the legacy V1 asymmetry:
 * each `SecretsNeeded` entry wraps an object, each `Secrets` entry wraps a
 * one-element array of {resource_id, data}. The client parses
 * `Secrets[i].Secret[0].data`.
 */
export interface GroupDryRunResult {
  'dry-run': {
    SecretsNeeded: { Secret: { resource_id: string; user_id: string } }[];
    Secrets: { Secret: { resource_id: string; data: string }[] }[];
  };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface Comment {
  id: string;
  parent_id: string | null;
  foreign_key: string;
  foreign_model: 'Resource';
  content: string;
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
  user_id: string;
  /** Nested replies (threaded GET list only). */
  children?: Comment[];
  /** Embedded when contain[creator]=1. */
  creator?: User;
  /** Embedded when contain[modifier]=1. */
  modifier?: User;
}

export interface CommentCreateRequest {
  content: string;
  parent_id?: string;
}

// ---------------------------------------------------------------------------
// MFA & server settings
// ---------------------------------------------------------------------------

/**
 * Shape of the TOTP setup state. When TOTP is not configured the backend
 * returns `otpProvisioningUri` (+ empty `otpQrCodeSvg`); once configured it
 * returns `verified`.
 */
export interface MfaSetupState {
  otpProvisioningUri?: string;
  /** Always "" — QR rendering is delegated to the client. */
  otpQrCodeSvg?: string;
  verified?: string | null;
}

export interface MfaOrgSettings {
  providers: string[];
}

/** Free-form server settings map (GET /settings.json body). */
export interface ServerSettings {
  passbolt?: Record<string, unknown>;
  server?: { hostname?: string; [k: string]: unknown };
  domain?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// v5 metadata
//
// Passbolt v5 moves a resource's name/username/uri/description out of cleartext
// DB columns and into an end-to-end-encrypted `metadata` blob. The blob is
// encrypted EITHER to the user's own GPG key (`metadata_key_type: 'user_key'`)
// OR to a shared organization "metadata key" (`'shared_key'`). The shapes here
// mirror the backend DTOs (MetadataKeyDto / MetadataSettingsDto) and the
// reference plugin verbatim. All field names are snake_case to match the wire.
//
// IMPORTANT: this is a transparent layer — the UI never surfaces a v4-vs-v5
// distinction. These types exist so the resolver (read) and form (write) can
// translate between encrypted metadata and the plain Resource display fields.
// ---------------------------------------------------------------------------

/**
 * How a v5 resource's `metadata` blob is encrypted:
 *  - `shared_key` -> encrypted to a shared org metadata key (metadata_keys row);
 *    `metadata_key_id` references that metadata_keys.id.
 *  - `user_key`   -> encrypted to the user's own GPG key (personal item);
 *    `metadata_key_id` references the user's gpgkeys.id.
 */
export type MetadataKeyType = 'user_key' | 'shared_key';

/**
 * A row from GET /metadata/keys.json. `armored_key` is the shared metadata
 * key's PUBLIC half (used to ENCRYPT new metadata). The current user's
 * encrypted copy of the corresponding PRIVATE half arrives inside
 * `metadata_private_keys` only when contain[metadata_private_keys]=1 is sent
 * (and is scoped server-side to the current user). The active key is the row
 * with `expired === null && deleted === null`.
 */
export interface MetadataKey {
  id: string;
  fingerprint: string;
  /** Armored PUBLIC key of the shared metadata key (encrypt to this). */
  armored_key: string;
  /** Expiry timestamp; null = active. */
  expired: string | null;
  /** Soft-delete timestamp; null = active. */
  deleted: string | null;
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
  /**
   * The current user's encrypted copies of this shared key's private half.
   * Present only with contain[metadata_private_keys]=1; scoped to the user.
   */
  metadata_private_keys?: MetadataPrivateKey[];
}

/**
 * A user's encrypted copy of a shared metadata key's private half. `data` is an
 * armored PGP MESSAGE that, once decrypted with the user's own GPG key, yields a
 * PASSBOLT_METADATA_PRIVATE_KEY JSON blob carrying the shared key's armored
 * PRIVATE key (used to DECRYPT shared-key resource metadata).
 */
export interface MetadataPrivateKey {
  id: string;
  metadata_key_id: string;
  user_id: string;
  /** Armored PGP MESSAGE (encrypted to the user's own key). */
  data: string;
  created: string;
  modified: string;
  created_by: string;
  modified_by: string;
}

/** A 'v4'-or-'v5' default-format selector used by the types settings. */
export type MetadataDefaultType = 'v4' | 'v5';

/**
 * GET /metadata/types/settings.json — the org's create-format policy. Exactly
 * 14 fields. Out of the box every default is 'v4', all allow_creation_of_v5_*
 * are false, all allow_creation_of_v4_* are true, and both up/downgrade flags
 * are false (so v5 creation is disabled until an admin enables it).
 */
export interface MetadataTypesSettings {
  default_resource_types: MetadataDefaultType;
  default_folder_type: MetadataDefaultType;
  default_tag_type: MetadataDefaultType;
  default_comment_type: MetadataDefaultType;
  allow_creation_of_v5_resources: boolean;
  allow_creation_of_v5_folders: boolean;
  allow_creation_of_v5_tags: boolean;
  allow_creation_of_v5_comments: boolean;
  allow_creation_of_v4_resources: boolean;
  allow_creation_of_v4_folders: boolean;
  allow_creation_of_v4_tags: boolean;
  allow_creation_of_v4_comments: boolean;
  allow_v5_v4_downgrade: boolean;
  allow_v4_v5_upgrade: boolean;
}

/**
 * POST /metadata/types/settings.json write shape. Every field is required by
 * the spec for the write (the backend persists the full policy object).
 */
export type MetadataTypesSettingsUpdate = MetadataTypesSettings;

/**
 * GET /metadata/keys/settings.json — whether personal (user_key) metadata is
 * allowed and whether zero-knowledge key sharing is on. Defaults:
 * allow_usage_of_personal_keys=true, zero_knowledge_key_share=false.
 */
export interface MetadataKeysSettings {
  allow_usage_of_personal_keys: boolean;
  zero_knowledge_key_share: boolean;
}

/** POST /metadata/keys/settings.json write shape (both fields required). */
export type MetadataKeysSettingsUpdate = MetadataKeysSettings;
