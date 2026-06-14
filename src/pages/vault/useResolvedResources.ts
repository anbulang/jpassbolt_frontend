/**
 * useResolvedResources — bridges async v5 metadata decryption into the otherwise
 * synchronous vault table WITHOUT blocking render.
 *
 * v4 rows pass through untouched and render instantly (their name/username/uri/
 * description live in plain columns). v5 rows (encrypted `metadata` blob) start
 * with a neutral placeholder (name = '…') and fill in IN PLACE the instant their
 * blob decrypts. Because the hook projects the resolved values back onto the SAME
 * `name`/`username`/`uri`/`description` keys, Vault.tsx's table JSX, search
 * filter, and folder-membership filter need NO change.
 *
 * Gating: v5 decryption is deferred while the vault is locked (useKey().isLocked)
 * or before the shared metadata key has loaded (useMetadataKey().ready), exactly
 * like SecretPanel guards its secret decryption. When those flip ready, the
 * effect re-runs and resolves the still-placeholder v5 rows.
 *
 * Performance: the list is already paginated server-side and there is no
 * virtualization, so we resolve ALL currently-listed v5 rows on a batched
 * microtask. The module-level `${id}:${modified}` cache in resourceMetadata.ts
 * means a row is decrypted at most once per version across refetches.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Resource } from '../../types';
import { useKey } from '../../crypto/KeyContext';
import { useMetadataKey } from '../../crypto/MetadataKeyContext';
import {
  getCachedResolution,
  isV5Resource,
  resolveResourceFields,
  type ResolvedMetadata,
} from './resourceMetadata';

/**
 * A Resource with its display fields guaranteed populated. v4 rows keep their
 * column values; v5 rows carry either the decrypted metadata fields or a neutral
 * placeholder until decryption lands. The field NAMES are identical to Resource,
 * so existing consumers are unchanged.
 */
export type ResourceDisplay = Resource;

interface UseResolvedResources {
  /** Resources with name/username/uri/description guaranteed populated. */
  display: ResourceDisplay[];
  /** True while one or more v5 rows are still decrypting. */
  resolving: boolean;
}

/**
 * Version-aware state key: combines identity + `modified` so an edited v5 row
 * (new `modified`) misses any pre-edit entry and re-resolves. Mirrors the
 * `${id}:${modified}` key used by the module cache in resourceMetadata.ts.
 */
function stateKey(r: Resource): string {
  return `${r.id}:${r.modified}`;
}

/** Project a ResolvedMetadata back onto the Resource's display field names. */
function project(r: Resource, resolved: ResolvedMetadata): ResourceDisplay {
  return {
    ...r,
    name: resolved.name,
    username: resolved.username,
    uri: resolved.uri,
    description: resolved.description,
  };
}

export function useResolvedResources(resources: Resource[]): UseResolvedResources {
  const { decrypt, isLocked } = useKey();
  const { ready, available, decryptResourceMetadata } = useMetadataKey();

  // Resolved display fields keyed by `${id}:${modified}` (version-aware, so an
  // edited row re-resolves instead of returning a stale pre-edit projection).
  const [resolvedById, setResolvedById] = useState<Map<string, ResolvedMetadata>>(
    () => new Map()
  );

  // v5 rows in the current list that still lack a resolution (cache miss + not
  // yet in state for THIS version). Computed during render so `resolving` can be
  // DERIVED rather than stored — avoids synchronous setState in the effect. The
  // state lookup is keyed by `${id}:${modified}`, so an edited row (new modified)
  // is treated as pending again and re-decrypts.
  const pending = useMemo(
    () =>
      resources.filter(
        (r) => isV5Resource(r) && !getCachedResolution(r) && !resolvedById.get(stateKey(r))
      ),
    [resources, resolvedById]
  );

  useEffect(() => {
    // Defer v5 decryption while locked or before the shared key has loaded,
    // mirroring SecretPanel's locked guard. The effect re-runs on unlock/ready.
    if (pending.length === 0 || isLocked || !ready) return;

    let cancelled = false;

    void (async () => {
      const next = new Map<string, ResolvedMetadata>();
      await Promise.all(
        pending.map(async (r) => {
          const resolved = await resolveResourceFields(r, {
            decrypt,
            decryptSharedMetadata: decryptResourceMetadata,
            isLocked: false,
          });
          // Cache ONLY successful resolutions. A null means decryption failed
          // (e.g. the org shared key is not yet configured); leaving it out of
          // state keeps the row in `pending` so it re-resolves when `available`
          // (or another dep) transitions, instead of being stuck on '…' forever.
          if (resolved) next.set(stateKey(r), resolved);
        })
      );
      if (cancelled || next.size === 0) return;
      // Async setState (inside the promise) is allowed by the cascading-render
      // rule; it triggers exactly one re-render when the batch lands.
      setResolvedById((prev) => {
        const merged = new Map(prev);
        for (const [id, resolved] of next) merged.set(id, resolved);
        return merged;
      });
    })();

    return () => {
      cancelled = true;
    };
    // `available` is a dependency so that when an admin configures the shared
    // metadata key (available: false -> true), this effect re-runs and the rows
    // that previously failed to decrypt (and were NOT cached) re-resolve.
  }, [pending, isLocked, ready, available, decrypt, decryptResourceMetadata]);

  // Project resolved values back onto Resource field names. v4 rows pass through
  // untouched; v5 rows use the cached/decrypted projection or a placeholder.
  const display = useMemo<ResourceDisplay[]>(() => {
    return resources.map((r) => {
      if (!isV5Resource(r)) return r;
      // Version-aware lookup: an edited row (new `modified`) misses both the
      // module cache and the id+version state key, so it falls back to the
      // placeholder and re-resolves instead of showing pre-edit values.
      const resolved = getCachedResolution(r) ?? resolvedById.get(stateKey(r));
      if (resolved) return project(r, resolved);
      // Not yet resolved (decrypting, locked, or shared key not ready):
      // show a neutral placeholder name so the row renders without blanks.
      return project(r, {
        name: '…',
        username: '',
        uri: '',
        description: '',
        resource_type_id: r.resource_type_id,
      });
    });
  }, [resources, resolvedById]);

  // Derived: still decrypting when v5 rows are pending and the vault is unlocked
  // + the shared key is ready (i.e. work is actually in flight, not just deferred).
  const resolving = pending.length > 0 && !isLocked && ready;

  return { display, resolving };
}
