/**
 * Vault — the Aegis primary screen, mounted at "/" inside the Layout shell.
 *
 * Three columns (the design's hero layout):
 *   - left:   <FolderTree> (folder filtering + a 收藏 virtual node)
 *   - center: a searchable resource list (.reslist) of .rescard rows
 *   - right:  <SecretPanel> — inline, encrypted-by-default secret with
 *             client-side reveal, copy-burn, expiry, shared list, comments.
 *
 * E2EE: the data layer (useVaultData + useResolvedResources) is unchanged — v4
 * rows pass through, v5 rows are transparently decrypted into the same display
 * fields. The server never sees plaintext; revealing/copying a secret happens
 * entirely in the browser via SecretPanel + useKey().
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Plus, Search, Star, Lock, AlertTriangle, Clock, X } from 'lucide-react';
import type { Folder, Resource, ResourceType } from '../types';
import { describeApiError } from '../i18n/errors';
import { deleteResource } from '../services/resources';
import { listFolders, moveResource } from '../services/folders';
import { getResourceTypes } from '../services/settings';
import { addFavorite, removeFavorite, FavoriteAlreadyExistsError } from '../services/favorites';
import { useToast } from '../components/toastContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import FolderTree, { RESOURCE_DRAG_MIME } from '../components/FolderTree';
import ShareDialog from '../components/ShareDialog';
import { Modal } from '../components/Modal';
import { useVaultData } from './vault/useVaultData';
import { useResolvedResources } from './vault/useResolvedResources';
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

// --- small presentation helpers ---
function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}
function tileColor(seed: string): string {
  return `oklch(0.58 0.15 ${hashHue(seed)})`;
}
function tileLetter(name: string): string {
  return name.replace(/^[^A-Za-z一-龥]*/, '').slice(0, 1).toUpperCase() || '•';
}
function expiryState(iso: string | null | undefined): 'expired' | 'soon' | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return 'expired';
  if (days <= 14) return 'soon';
  return null;
}

export default function Vault() {
  const { t } = useTranslation('vault');
  const toast = useToast();
  const { resources, folders, folderMembership, initialLoading, error, refetch } = useVaultData();

  // Format-transparent display projection (v4 pass-through; v5 decrypted in-memory).
  const { display, resolving } = useResolvedResources(resources);

  const [resourceTypes, setResourceTypes] = useState<ResourceType[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Selection (drives the inline SecretPanel) + mutation state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<Resource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [favBusyId, setFavBusyId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Resource | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveFolderOptions, setMoveFolderOptions] = useState<Folder[]>([]);

  useEffect(() => {
    getResourceTypes()
      .then(setResourceTypes)
      .catch(() => setResourceTypes([]));
  }, []);

  // Refresh the "移动到…" dialog's folder options when it opens (mirrors the
  // create modal): seed instantly from the cached vault list, then replace with a
  // live /folders.json read so a folder just created in the sidebar is a valid
  // move target without a full reload. Failures keep the seeded cached list.
  useEffect(() => {
    if (!moving) return;
    setMoveFolderOptions(folders);
    let cancelled = false;
    (async () => {
      try {
        const fresh = await listFolders();
        if (!cancelled) setMoveFolderOptions(fresh);
      } catch {
        // keep the seeded cached list
      }
    })();
    return () => {
      cancelled = true;
    };
    // `folders` is re-seeded synchronously above on open; omitting it from deps
    // avoids refetching on every parent refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const folderSet = selectedFolderId ? folderMembership.get(selectedFolderId) : null;
    return display.filter((r) => {
      if (favoritesOnly && !r.favorite) return false;
      if (folderSet && !folderSet.has(r.id)) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.username.toLowerCase().includes(q) ||
        r.uri.toLowerCase().includes(q)
      );
    });
  }, [display, debouncedSearch, favoritesOnly, selectedFolderId, folderMembership]);

  // Keep a valid selection: default to the first row; clear when the list is empty.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) => (cur && filtered.some((r) => r.id === cur) ? cur : filtered[0].id));
  }, [filtered]);

  const selected = filtered.find((r) => r.id === selectedId) ?? null;

  // Invert folderMembership (folderId -> resourceIds) into resourceId -> folderId
  // so the edit modal can preselect a resource's current folder. A resource lives
  // in at most one folder per user, so the mapping is unambiguous. Membership is
  // derived from folders_relations — the resource row itself carries no folder.
  const resourceFolderId = useMemo(() => {
    const m = new Map<string, string>();
    for (const [folderId, ids] of folderMembership) {
      for (const rid of ids) m.set(rid, folderId);
    }
    return m;
  }, [folderMembership]);

  const toggleFavorite = async (resource: Resource) => {
    setFavBusyId(resource.id);
    try {
      if (resource.favorite) {
        await removeFavorite(resource.favorite.id);
        toast.success(t('toast.favRemoved'));
      } else {
        await addFavorite(resource.id);
        toast.success(t('toast.favAdded'));
      }
      await refetch();
    } catch (err) {
      if (err instanceof FavoriteAlreadyExistsError) {
        await refetch();
      } else {
        toast.error(describeApiError(err));
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
      toast.success(t('toast.deleted'));
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      await refetch();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setDeleting(false);
    }
  };

  const openEdit = (resource: Resource) => setEditing(resource);
  const openShare = (resource: Resource) => setSharing(resource);
  // Folder change is a standalone action, separate from edit — mirroring Passbolt:
  // the resource row carries no folder, so relocation goes through PUT /move/Resource
  // (folders_relations), never the resource update.
  const openMove = (resource: Resource) => {
    setMoving(resource);
    setMoveTarget(resourceFolderId.get(resource.id) ?? '');
  };
  const confirmMove = async () => {
    if (!moving) return;
    const target = moveTarget || null;
    const current = resourceFolderId.get(moving.id) ?? null;
    if (target === current) {
      setMoving(null);
      return;
    }
    setMoveBusy(true);
    try {
      await moveResource(moving.id, target);
      toast.success(t('toast.moved'));
      // Close only after BOTH the move and the refetch finish. Closing before
      // refetch left a window where reopening the dialog showed it frozen
      // (moveBusy still true until the finally below). Holding it open keeps the
      // busy state coherent, then it closes and clears together.
      await refetch();
      setMoving(null);
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setMoveBusy(false);
    }
  };

  const scopeName = debouncedSearch.trim()
    ? t('scope.searchResults')
    : favoritesOnly
      ? t('scope.favorites')
      : selectedFolderId
        ? folders.find((f) => f.id === selectedFolderId)?.name ?? t('scope.folder')
        : t('scope.all');

  return (
    <div className="vault">
      {/* Left: folder navigation */}
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
        onResourceMoved={() => void refetch()}
      />

      {/* Center: resource list */}
      <div className="reslist">
        <div className="reslist-head">
          <div className="searchbox">
            <Search />
            <input
              placeholder={t('search.placeholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button className="star" onClick={() => setSearch('')} title={t('search.clear')}>
                <X />
              </button>
            ) : (
              <kbd>⌘K</kbd>
            )}
          </div>
          <div className="reslist-meta">
            <span className="count">
              <Trans
                i18nKey="meta.count"
                t={t}
                values={{ count: filtered.length, scope: scopeName }}
                components={[<b />]}
              />
            </span>
            {resolving && (
              <span className="count" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="spin-ring" /> {t('meta.decrypting')}
              </span>
            )}
            <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
              <Plus /> {t('actions.create')}
            </button>
          </div>
        </div>

        <div className="reslist-scroll">
          {initialLoading ? (
            <div className="empty">
              <div className="ico">
                <span className="spin-ring" style={{ width: 26, height: 26 }} />
              </div>
              <h3>{t('list.loadingVault')}</h3>
            </div>
          ) : error ? (
            <div className="empty">
              <div className="ico">
                <AlertTriangle />
              </div>
              <h3>{t('list.loadFailed')}</h3>
              <p>{error}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="ico">{search ? <Search /> : <Lock />}</div>
              <h3>{search ? t('list.noMatch') : resources.length === 0 ? t('list.emptyVault') : t('list.noResourcesYet')}</h3>
              <p>
                {search
                  ? t('list.noMatchHint', { query: search })
                  : t('list.emptyHint')}
              </p>
              {!search && (
                <button className="btn primary sm" onClick={() => setCreating(true)}>
                  <Plus /> {t('actions.createResource')}
                </button>
              )}
            </div>
          ) : (
            filtered.map((r) => {
              const exp = expiryState(r.expired);
              return (
                <button
                  key={r.id}
                  className={`rescard${r.id === selectedId ? ' active' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(RESOURCE_DRAG_MIME, r.id);
                    e.dataTransfer.setData('text/plain', r.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingId(r.id);
                  }}
                  onDragEnd={() => setDraggingId(null)}
                  title={t('list.dragHint')}
                  style={{ opacity: draggingId === r.id ? 0.45 : 1 }}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span className="res-ico" style={{ background: tileColor(r.id) }}>
                    {tileLetter(r.name)}
                  </span>
                  <span className="res-mid">
                    <span className="res-name">
                      <span className="nm">{r.name}</span>
                      {exp === 'expired' && <AlertTriangle style={{ width: 13, height: 13, color: 'var(--red)' }} />}
                      {exp === 'soon' && <Clock style={{ width: 13, height: 13, color: 'var(--amber)' }} />}
                    </span>
                    <span className="res-sub">{r.username || r.uri || '—'}</span>
                  </span>
                  <span className="res-right">
                    <span
                      className={`star${r.favorite ? ' on' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={r.favorite ? t('actions.unfavorite') : t('actions.favorite')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (favBusyId !== r.id) void toggleFavorite(r);
                      }}
                    >
                      <Star style={r.favorite ? { fill: 'currentColor' } : undefined} />
                    </span>
                    <Lock style={{ width: 14, height: 14, color: 'var(--text-3)' }} />
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: secret detail panel (inline) */}
      {selected ? (
        <SecretPanel
          key={selected.id}
          resource={selected}
          resourceTypes={resourceTypes}
          onEdit={openEdit}
          onShare={openShare}
          onMove={openMove}
          onToggleFavorite={toggleFavorite}
          onDelete={(r) => setDeleteTarget(r)}
          favBusy={favBusyId === selected.id}
        />
      ) : (
        <div className="panel">
          <div className="empty" style={{ flex: 1 }}>
            <div className="ico">
              <Lock />
            </div>
            <h3>{t('panel.selectPrompt')}</h3>
            <p>{t('panel.selectHint')}</p>
          </div>
        </div>
      )}

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

      {/* Share dialog */}
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

      {/* Move dialog — folder change is a standalone op, separate from edit. */}
      <Modal
        open={!!moving}
        title={moving ? t('move.title', { name: moving.name }) : t('move.titleFallback')}
        onClose={() => {
          if (!moveBusy) setMoving(null);
        }}
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setMoving(null)} disabled={moveBusy}>
              {t('common:actions.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void confirmMove()} disabled={moveBusy}>
              {moveBusy ? t('move.moving') : t('move.move')}
            </button>
          </>
        }
      >
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">{t('move.targetFolder')}</label>
          <select
            className="form-control"
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value)}
            disabled={moveBusy}
          >
            <option value="">{t('move.noFolder')}</option>
            {moveFolderOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('delete.title')}
        message={
          <Trans
            i18nKey="delete.message"
            t={t}
            values={{ name: deleteTarget?.name ?? '' }}
            components={[<span />, <strong />]}
          />
        }
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
