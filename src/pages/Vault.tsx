/**
 * Vault (Passwords) — the primary screen, mounted at route "/" inside the Layout
 * shell (replaces the old Dashboard).
 *
 * Three zones:
 *   - left:   <FolderTree> for folder filtering + a Favorites virtual node
 *   - center: a searchable, filterable table of password resources
 *   - right:  <SecretPanel> slide-in drawer with on-the-fly client-side decryption
 *
 * Top bar (rendered into the Layout topbar slot): debounced search + a
 * favorites-only toggle + a "New Password" button.
 *
 * E2EE: viewing a secret fetches the armored ciphertext and decrypts it in
 * memory via useKey().decrypt; creating/editing encrypts the secret for the
 * owner's own public key via useKey().encryptForSelf. The server never sees
 * plaintext, and plaintext is never logged.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Lock,
  Plus,
  Search,
  Star,
  Globe,
  Share2,
  Pencil,
  Trash2,
  Eye,
} from 'lucide-react';
import type { Resource, ResourceType } from '../types';
import { deleteResource } from '../services/resources';
import { getResourceTypes } from '../services/settings';
import {
  addFavorite,
  removeFavorite,
  FavoriteAlreadyExistsError,
} from '../services/favorites';
import { useToast } from '../components/toastContext';
import { FullSpinner, Spinner } from '../components/Spinner';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import FolderTree, { RESOURCE_DRAG_MIME } from '../components/FolderTree';
import ShareDialog from '../components/ShareDialog';
import { useVaultData } from './vault/useVaultData';
import { SecretPanel } from './vault/SecretPanel';
import { ResourceFormModal } from './vault/ResourceFormModal';

/** Debounce a fast-changing value (used for the search box). */
function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function errMessage(err: unknown, fallback: string): string {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 403) return 'You do not have permission to perform this action.';
  const apiMsg = (err as { response?: { data?: { header?: { message?: string } } } })?.response
    ?.data?.header?.message;
  if (apiMsg) return apiMsg;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default function Vault() {
  const toast = useToast();
  const {
    resources,
    folders,
    folderMembership,
    initialLoading,
    error,
    refetch,
  } = useVaultData();

  const [resourceTypes, setResourceTypes] = useState<ResourceType[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // View / mutation state
  const [viewing, setViewing] = useState<Resource | null>(null);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<Resource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [favBusyId, setFavBusyId] = useState<string | null>(null);
  // Drag-to-move: id of the resource row currently being dragged (subtle affordance).
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    getResourceTypes()
      .then(setResourceTypes)
      .catch(() => setResourceTypes([]));
  }, []);

  // Keep the open drawer/edit modal in sync with refreshed data.
  useEffect(() => {
    if (viewing) {
      const fresh = resources.find((r) => r.id === viewing.id) ?? null;
      if (fresh !== viewing) setViewing(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const folderSet = selectedFolderId ? folderMembership.get(selectedFolderId) : null;
    return resources.filter((r) => {
      if (favoritesOnly && !r.favorite) return false;
      if (folderSet && !folderSet.has(r.id)) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.username.toLowerCase().includes(q) ||
        r.uri.toLowerCase().includes(q)
      );
    });
  }, [resources, debouncedSearch, favoritesOnly, selectedFolderId, folderMembership]);

  const toggleFavorite = async (resource: Resource) => {
    setFavBusyId(resource.id);
    try {
      if (resource.favorite) {
        await removeFavorite(resource.favorite.id);
        toast.success('Removed from favorites');
      } else {
        await addFavorite(resource.id);
        toast.success('Added to favorites');
      }
      await refetch();
    } catch (err) {
      if (err instanceof FavoriteAlreadyExistsError) {
        await refetch();
      } else {
        toast.error(errMessage(err, 'Could not update favorite.'));
      }
    } finally {
      setFavBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteResource(deleteTarget.id);
      toast.success('Password deleted');
      if (viewing?.id === deleteTarget.id) setViewing(null);
      setDeleteTarget(null);
      await refetch();
    } catch (err) {
      toast.error(errMessage(err, 'Could not delete the password.'));
    } finally {
      setDeleting(false);
    }
  };

  const openEdit = (resource: Resource) => {
    setViewing(null);
    setEditing(resource);
  };

  const openShare = (resource: Resource) => {
    setSharing(resource);
  };

  // ---- Top bar (search + favorites toggle + new) ----
  const topBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <div style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
        <Search
          size={16}
          style={{
            position: 'absolute',
            left: 12,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-muted)',
            pointerEvents: 'none',
          }}
        />
        <input
          className="form-control"
          placeholder="Search passwords…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ paddingLeft: 36 }}
        />
      </div>
      <button
        type="button"
        className={`btn ${favoritesOnly ? 'btn-primary' : 'btn-secondary'}`}
        onClick={() => setFavoritesOnly((v) => !v)}
        title="Show favorites only"
        style={{ padding: '8px 14px' }}
      >
        <Star size={16} fill={favoritesOnly ? 'currentColor' : 'none'} />
        Favorites
      </button>
      <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
        <Plus size={16} /> New Password
      </button>
    </div>
  );

  return (
    <div style={{ padding: '24px 28px' }}>
      {topBar}

      <div style={{ display: 'flex', gap: '20px', marginTop: '20px', alignItems: 'flex-start' }}>
        {/* Left: folder navigation */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <FolderTree
            selectedFolderId={selectedFolderId}
            onSelect={(id) => {
              setSelectedFolderId(id);
              if (id !== null) setFavoritesOnly(false);
            }}
            favoritesOnly={favoritesOnly}
            onToggleFavorites={(on) => {
              setFavoritesOnly(on);
              if (on) setSelectedFolderId(null);
            }}
            // Refresh the center list + folder-membership filter only after the
            // move has actually persisted (FolderTree calls this post-await), so
            // refetch sees the new location instead of racing the pending PUT.
            onResourceMoved={() => void refetch()}
          />
        </div>

        {/* Center: resource table */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {error && (
            <div
              style={{
                background: 'rgba(248, 81, 73, 0.1)',
                color: 'var(--danger-color)',
                border: '1px solid var(--danger-color)',
                borderRadius: 'var(--radius-sm)',
                padding: '12px 16px',
                marginBottom: '16px',
                fontSize: '14px',
              }}
            >
              {error}
            </div>
          )}

          {initialLoading ? (
            <div className="glass-panel">
              <FullSpinner label="Decrypting your vault…" />
            </div>
          ) : filtered.length === 0 ? (
            resources.length === 0 ? (
              <EmptyState
                icon={Lock}
                title="Your vault is empty"
                description="Store your first password to get started. It is encrypted on your device before it ever leaves the browser."
                action={
                  <button className="btn btn-primary" onClick={() => setCreating(true)}>
                    <Plus size={16} /> Add Password
                  </button>
                }
              />
            ) : (
              <EmptyState
                icon={Search}
                title="No matching passwords"
                description="Try a different search, folder, or clear the favorites filter."
              />
            )
          ) : (
            <div className="glass-panel" style={{ overflow: 'hidden' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Username</th>
                    <th>URI</th>
                    <th style={{ width: 60, textAlign: 'center' }}>Favorite</th>
                    <th style={{ width: 180, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((resource) => (
                    <tr
                      key={resource.id}
                      draggable
                      onDragStart={(e) => {
                        // Drag source contract (consumed by FolderTree's drop):
                        // primary typed MIME key, plus a text/plain fallback,
                        // both carrying the resource UUID; effectAllowed='move'
                        // so the folder row's dropEffect='move' is honored.
                        e.dataTransfer.setData(RESOURCE_DRAG_MIME, resource.id);
                        e.dataTransfer.setData('text/plain', resource.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingId(resource.id);
                      }}
                      onDragEnd={() => {
                        // Only clear the drag affordance here. The Vault refresh
                        // is driven by FolderTree's onResourceMoved callback,
                        // which fires AFTER the move PUT resolves — reading the
                        // brittle dragend dropEffect would race the pending move
                        // (and misfire on failed/reset drops).
                        setDraggingId(null);
                      }}
                      title="Drag onto a folder to move"
                      style={{
                        cursor: 'pointer',
                        opacity: draggingId === resource.id ? 0.45 : 1,
                        transition: 'opacity var(--transition-fast)',
                      }}
                      onClick={() => setViewing(resource)}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <Lock size={15} color="var(--text-muted)" />
                          <span style={{ fontWeight: 500 }}>{resource.name}</span>
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-secondary)' }}>{resource.username || '—'}</td>
                      <td style={{ color: 'var(--text-secondary)', maxWidth: 220 }}>
                        {resource.uri ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '100%',
                            }}
                            title={resource.uri}
                          >
                            <Globe size={13} /> {resource.uri}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="icon-btn"
                          style={{ border: 'none', width: 32 }}
                          disabled={favBusyId === resource.id}
                          onClick={() => toggleFavorite(resource)}
                          aria-label={resource.favorite ? 'Remove favorite' : 'Add favorite'}
                          title={resource.favorite ? 'Remove favorite' : 'Add favorite'}
                        >
                          {favBusyId === resource.id ? (
                            <Spinner size={15} />
                          ) : (
                            <Star
                              size={16}
                              color={resource.favorite ? '#e3b341' : 'var(--text-muted)'}
                              fill={resource.favorite ? '#e3b341' : 'none'}
                            />
                          )}
                        </button>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => setViewing(resource)}
                            title="View secret"
                            aria-label="View secret"
                          >
                            <Eye size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => openShare(resource)}
                            title="Share"
                            aria-label="Share"
                          >
                            <Share2 size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => openEdit(resource)}
                            title="Edit"
                            aria-label="Edit"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger"
                            onClick={() => setDeleteTarget(resource)}
                            title="Delete"
                            aria-label="Delete"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Right: secret detail drawer */}
      <SecretPanel
        open={!!viewing}
        resource={viewing}
        resourceTypes={resourceTypes}
        onClose={() => setViewing(null)}
        onEdit={openEdit}
        onShare={openShare}
      />

      {/* Create / edit modal */}
      <ResourceFormModal
        open={creating || !!editing}
        resource={editing}
        resourceTypes={resourceTypes}
        folders={folders}
        defaultFolderId={selectedFolderId}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          void refetch();
        }}
      />

      {/* Share dialog — pass the whole Resource so the title shows the name and
          the dialog self-loads & manages the current access list (ACL). */}
      {sharing && (
        <ShareDialog
          open={!!sharing}
          resource={sharing}
          onClose={(didChange) => {
            setSharing(null);
            if (didChange) void refetch();
          }}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete password"
        message={
          <>
            Delete <strong>{deleteTarget?.name}</strong>? This removes it for everyone it is shared
            with. You must be an owner of this password.
          </>
        }
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
