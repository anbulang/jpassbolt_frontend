/**
 * Data layer for the Vault page.
 *
 * Loads the resource list (with favorite status) and the folder list (with
 * children_resources so folder membership can be computed client-side, since
 * Resource DTOs carry no folder field). Exposes a derived `folderMembership`
 * map (folderId -> Set<resourceId>) and a `refetch()`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Folder, Resource } from '../../types';
import { listResources } from '../../services/resources';
import { listFolders } from '../../services/folders';

interface VaultData {
  resources: Resource[];
  folders: Folder[];
  /** folderId -> set of resource ids that live directly in that folder. */
  folderMembership: Map<string, Set<string>>;
  /** set of resource ids that belong to ANY folder (used for the "no folder" case). */
  foldered: Set<string>;
  loading: boolean;
  /** First-load only — subsequent refetches keep the old data visible. */
  initialLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function messageFor(err: unknown, fallback: string): string {
  const apiMsg = (err as { response?: { data?: { header?: { message?: string } } } })?.response
    ?.data?.header?.message;
  if (apiMsg) return apiMsg;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function useVaultData(): VaultData {
  const [resources, setResources] = useState<Resource[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, fol] = await Promise.all([
        // containMetadata asks the server for the encrypted v5 `metadata` blob so
        // useResolvedResources can decrypt + display v5 rows transparently. It is
        // forward-compatible: the backend ignores it under v4 (task-2 gap), so v4
        // rows are unaffected today.
        listResources({ containFavorite: true, containMetadata: true }),
        // children_resources lets us compute folder membership locally.
        listFolders({ childrenResources: true }).catch(() => [] as Folder[]),
      ]);
      setResources(res);
      setFolders(fol);
    } catch (err) {
      setError(messageFor(err, 'Failed to load your vault.'));
    } finally {
      setLoading(false);
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const { folderMembership, foldered } = useMemo(() => {
    const membership = new Map<string, Set<string>>();
    const all = new Set<string>();
    for (const folder of folders) {
      const ids = new Set<string>();
      for (const child of folder.children_resources ?? []) {
        ids.add(child.id);
        all.add(child.id);
      }
      membership.set(folder.id, ids);
    }
    return { folderMembership: membership, foldered: all };
  }, [folders]);

  return {
    resources,
    folders,
    folderMembership,
    foldered,
    loading,
    initialLoading,
    error,
    refetch,
  };
}
