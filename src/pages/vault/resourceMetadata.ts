/**
 * Format-transparent resource metadata resolver (the vault-only READ seam).
 *
 * Passbolt v5 moves a resource's name/username/uri/description out of cleartext
 * DB columns and into an end-to-end-encrypted `metadata` blob (encrypted either
 * to the user's own GPG key or to a shared org metadata key). The vault UI must
 * render v5 resources EXACTLY like v4 ones — no badge, no toggle — so this module
 * translates an encrypted metadata blob back into the same scalar display fields
 * a v4 resource exposes (`name`/`username`/`uri`/`description`).
 *
 * Three exports:
 *   - parseResourceMetadata(plaintext): pure runtime-narrowing of a decrypted
 *     PASSBOLT_RESOURCE_METADATA blob into a ResolvedMetadata (maps the PLURAL
 *     `uris[0]` -> the scalar `uri` the v4 UI reads).
 *   - isV5Resource(r): cheap discriminator (has both `metadata` + key type).
 *   - resolveResourceFields(r, deps): for v4, returns the columns verbatim (zero
 *     crypto, instant); for v5, selects the decrypt path by metadata_key_type and
 *     parses the blob. While the vault is locked, returns a neutral placeholder.
 *
 * A module-level Map keyed by `${id}:${modified}` memoizes resolved blobs across
 * refetches / re-renders so v4 rows cost nothing and a v5 row whose `modified`
 * timestamp is unchanged is never re-decrypted.
 *
 * E2EE: this module NEVER persists or logs decrypted metadata. The only cache is
 * an in-memory Map of resolved DISPLAY fields (already plaintext to the user, the
 * same as a v4 row's columns), wiped naturally when the page unloads. No private
 * key, passphrase, or armored blob is ever stored here.
 */
import type { Resource } from '../../types';

/**
 * The format-transparent display projection. For a v4 resource these come
 * straight off the columns; for a v5 resource they are decrypted out of the
 * `metadata` blob. Identical shape either way, so the table/search/detail code
 * is unchanged.
 */
export interface ResolvedMetadata {
  name: string;
  username: string;
  uri: string;
  description: string;
  resource_type_id: string;
}

/**
 * Dependencies injected by the hook so this module stays pure-ish and testable:
 *  - `decrypt`               — useKey().decrypt (own GPG key; the `user_key` path).
 *  - `decryptSharedMetadata` — MetadataKeyContext.decryptResourceMetadata (the
 *                              `shared_key` path).
 *  - `isLocked`              — useKey().isLocked; when true, v5 rows cannot be
 *                              decrypted and resolve to a placeholder.
 */
export interface ResolveDeps {
  decrypt: (armoredMessage: string) => Promise<string>;
  decryptSharedMetadata: (armoredMetadata: string) => Promise<string>;
  isLocked: boolean;
}

/**
 * Module-level cache of resolved display fields, keyed by `${id}:${modified}`.
 * A row whose modified timestamp is unchanged is never re-decrypted. Holds only
 * already-plaintext display fields (never a key/passphrase/armored blob).
 */
const resolvedCache = new Map<string, ResolvedMetadata>();

/** Cache key combining identity + version so an edited row re-resolves. */
function cacheKey(r: Resource): string {
  return `${r.id}:${r.modified}`;
}

/** Read a previously-resolved projection for this exact resource version. */
export function getCachedResolution(r: Resource): ResolvedMetadata | undefined {
  return resolvedCache.get(cacheKey(r));
}

/**
 * True when a resource is a v5 (encrypted-metadata) resource: it carries both a
 * `metadata` blob AND a `metadata_key_type`. v4 resources never have these.
 */
export function isV5Resource(r: Resource): boolean {
  return !!r.metadata && !!r.metadata_key_type;
}

/**
 * Pure narrowing of a decrypted PASSBOLT_RESOURCE_METADATA blob into the scalar
 * display fields. The v5 blob stores `uris` (PLURAL array); the v4 UI reads a
 * scalar `uri`, so map `uris[0]`. Tolerates missing username/description (=> '').
 * `resource_type_id` is taken from the blob when present, else left ''.
 *
 * Throws on a blob that is not a PASSBOLT_RESOURCE_METADATA object (so the
 * resolver can degrade rather than render garbage).
 */
export function parseResourceMetadata(plaintext: string): ResolvedMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('Resource metadata is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Resource metadata is not an object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.object_type !== 'PASSBOLT_RESOURCE_METADATA') {
    throw new Error('Resource metadata has an unexpected object_type.');
  }

  const uris = Array.isArray(obj.uris) ? obj.uris : [];
  const firstUri = uris.length > 0 && typeof uris[0] === 'string' ? (uris[0] as string) : '';

  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    username: typeof obj.username === 'string' ? obj.username : '',
    uri: firstUri,
    description: typeof obj.description === 'string' ? obj.description : '',
    resource_type_id: typeof obj.resource_type_id === 'string' ? obj.resource_type_id : '',
  };
}

/**
 * Resolve a resource's display fields, format-transparently.
 *
 * v4 (isV5Resource(r) === false): returns the columns verbatim, wrapped in a
 * resolved Promise — ZERO crypto, instant, never cached (already free).
 *
 * v5 (metadata + metadata_key_type): if the vault is locked, returns `null`
 * (the caller renders a placeholder and retries after unlock — never throws into
 * render). Else selects the decrypt fn by metadata_key_type ('user_key' -> own
 * GPG key via deps.decrypt; 'shared_key' -> deps.decryptSharedMetadata),
 * decrypts, parses, and memoizes the SUCCESSFUL result by `${id}:${modified}`.
 * A decrypt/parse failure (e.g. the shared key is not yet configured) returns
 * `null` and is NOT memoized, so the row re-resolves once the key becomes
 * available — the caller renders a placeholder for it in the meantime.
 */
export async function resolveResourceFields(
  r: Resource,
  deps: ResolveDeps
): Promise<ResolvedMetadata | null> {
  // v4 fast path: straight off the columns, no crypto, no caching needed.
  if (!isV5Resource(r)) {
    return {
      name: r.name,
      username: r.username,
      uri: r.uri,
      description: r.description,
      resource_type_id: r.resource_type_id,
    };
  }

  // v5 path. Re-use a previously-decrypted projection for this exact version.
  const cached = resolvedCache.get(cacheKey(r));
  if (cached) return cached;

  // Cannot decrypt while locked: signal "unresolved" so the caller renders a
  // placeholder and retries on unlock. NOT cached (locked is transient).
  if (deps.isLocked) {
    return null;
  }

  const armored = r.metadata as string;
  try {
    const plaintext =
      r.metadata_key_type === 'shared_key'
        ? await deps.decryptSharedMetadata(armored)
        : await deps.decrypt(armored);
    const resolved = parseResourceMetadata(plaintext);
    // Cache ONLY successful resolutions, so a transient failure (e.g. the shared
    // key is not yet configured) is retried later rather than stuck forever.
    resolvedCache.set(cacheKey(r), resolved);
    return resolved;
  } catch {
    // Decrypt/parse failed (e.g. shared key not yet loaded). Return null (NOT a
    // cached placeholder) so the row re-resolves once the key becomes available.
    return null;
  }
}
