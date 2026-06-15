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
import { Plus, Search, Star, Lock, AlertTriangle, Clock, X } from 'lucide-react';
import type { Resource, ResourceType } from '../types';
import { deleteResource } from '../services/resources';
import { getResourceTypes } from '../services/settings';
import { addFavorite, removeFavorite, FavoriteAlreadyExistsError } from '../services/favorites';
import { useToast } from '../components/toastContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import FolderTree, { RESOURCE_DRAG_MIME } from '../components/FolderTree';
import ShareDialog from '../components/ShareDialog';
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

function errMessage(err: unknown, fallback: string): string {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 403) return '你没有权限执行此操作。';
  const apiMsg = (err as { response?: { data?: { header?: { message?: string } } } })?.response?.data
    ?.header?.message;
  if (apiMsg) return apiMsg;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
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

  useEffect(() => {
    getResourceTypes()
      .then(setResourceTypes)
      .catch(() => setResourceTypes([]));
  }, []);

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

  const toggleFavorite = async (resource: Resource) => {
    setFavBusyId(resource.id);
    try {
      if (resource.favorite) {
        await removeFavorite(resource.favorite.id);
        toast.success('已取消收藏');
      } else {
        await addFavorite(resource.id);
        toast.success('已加入收藏');
      }
      await refetch();
    } catch (err) {
      if (err instanceof FavoriteAlreadyExistsError) {
        await refetch();
      } else {
        toast.error(errMessage(err, '更新收藏失败。'));
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
      toast.success('凭据已删除');
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      await refetch();
    } catch (err) {
      toast.error(errMessage(err, '删除凭据失败。'));
    } finally {
      setDeleting(false);
    }
  };

  const openEdit = (resource: Resource) => setEditing(resource);
  const openShare = (resource: Resource) => setSharing(resource);

  const scopeName = debouncedSearch.trim()
    ? '搜索结果'
    : favoritesOnly
      ? '收藏'
      : selectedFolderId
        ? folders.find((f) => f.id === selectedFolderId)?.name ?? '文件夹'
        : '全部凭据';

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
              placeholder="搜索凭据、用户名、网址…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button className="star" onClick={() => setSearch('')} title="清除">
                <X />
              </button>
            ) : (
              <kbd>⌘K</kbd>
            )}
          </div>
          <div className="reslist-meta">
            <span className="count">
              <b>{filtered.length}</b> 项 · {scopeName}
            </span>
            {resolving && (
              <span className="count" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="spin-ring" /> 解密中…
              </span>
            )}
            <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
              <Plus /> 新建
            </button>
          </div>
        </div>

        <div className="reslist-scroll">
          {initialLoading ? (
            <div className="empty">
              <div className="ico">
                <span className="spin-ring" style={{ width: 26, height: 26 }} />
              </div>
              <h3>正在解密你的保险库…</h3>
            </div>
          ) : error ? (
            <div className="empty">
              <div className="ico">
                <AlertTriangle />
              </div>
              <h3>加载失败</h3>
              <p>{error}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="ico">{search ? <Search /> : <Lock />}</div>
              <h3>{search ? '没有匹配的凭据' : resources.length === 0 ? '保险库是空的' : '这里还没有凭据'}</h3>
              <p>
                {search
                  ? `没有找到与「${search}」相关的结果，换个关键词试试。`
                  : '点击右上角「新建」添加你的第一条凭据——它会在离开浏览器前先在本地加密。'}
              </p>
              {!search && (
                <button className="btn primary sm" onClick={() => setCreating(true)}>
                  <Plus /> 新建凭据
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
                  title="拖到文件夹可移动"
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
                      aria-label={r.favorite ? '取消收藏' : '收藏'}
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
            <h3>选择一个凭据</h3>
            <p>从中间的列表选择一项，即可查看并按需在本地解密其密码。</p>
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

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除凭据"
        message={
          <>
            删除 <strong>{deleteTarget?.name}</strong>？这会对所有共享对象一并移除。你必须是该凭据的拥有者。
          </>
        }
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
