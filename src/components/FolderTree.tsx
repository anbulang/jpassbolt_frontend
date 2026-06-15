/**
 * FolderTree (smart component) — Aegis "folders" column.
 *
 * Left-navigation folder tree used as the first column of the Vault. It:
 *   - fetches the flat /folders.json list and nests it into a tree client-side;
 *   - renders smart nodes "全部凭据" (folderId = null) + a virtual "收藏" node;
 *   - shows each folder with a Folder icon, collapse/expand chevron, an active
 *     highlight, and a hover "⋯" menu with 重命名 / 移动 / 删除;
 *   - supports create / rename / move / delete (cascade-aware);
 *   - accepts HTML5-dropped resources from the resource list and moves them.
 *
 * E2EE note: folders carry no secret material, so this component performs NO
 * crypto. Only the presentation changed in the Aegis redesign — the data layer,
 * drag-and-drop contract, and folder CRUD are unchanged.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  ChevronRight,
  Folder as FolderIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
  Vault as VaultIcon,
  Move as MoveIcon,
} from 'lucide-react';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './toastContext';
import type { Folder, FolderNode } from '../types';
import {
  buildFolderTree,
  createFolder,
  deleteFolder,
  listFolders,
  moveFolder,
  moveResource,
  renameFolder,
} from '../services/folders';

// ---------------------------------------------------------------------------
// Public contract — kept compatible with the Vault page.
// ---------------------------------------------------------------------------
export interface FolderTreeProps {
  /** Currently selected folder id (null = 全部凭据 / root). */
  selectedFolderId: string | null;
  /** Alias for `selectedFolderId`; the former takes precedence when both set. */
  selectedId?: string | null;
  /** Called when a folder (or the All node) is selected. null = 全部凭据. */
  onSelect: (folderId: string | null) => void;
  /** Whether the virtual "收藏" node is active. */
  favoritesOnly?: boolean;
  /** Toggle the parent's favorites-only filter. */
  onToggleFavorites?: (on: boolean) => void;
  /** Called after a drag-dropped resource has been successfully moved. */
  onResourceMoved?: () => void;
}

/** The drag-and-drop MIME type the resource list sets on a dragged row. */
export const RESOURCE_DRAG_MIME = 'application/x-jpassbolt-resource-id';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function errMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const anyErr = err as {
      response?: { data?: { header?: { message?: string } } };
      message?: string;
    };
    const apiMsg = anyErr.response?.data?.header?.message;
    if (apiMsg) return apiMsg;
    if (anyErr.message) return anyErr.message;
  }
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function readDroppedResourceId(e: DragEvent): string | null {
  const typed = e.dataTransfer.getData(RESOURCE_DRAG_MIME).trim();
  if (typed) return typed;
  const plain = e.dataTransfer.getData('text/plain').trim();
  return plain || null;
}

/** True if `candidateId` is `nodeId` itself or one of its descendants. */
function isSelfOrDescendant(
  nodeId: string,
  candidateId: string,
  byParent: Map<string | null, Folder[]>,
): boolean {
  if (nodeId === candidateId) return true;
  const stack = [...(byParent.get(nodeId) ?? [])];
  while (stack.length) {
    const f = stack.pop()!;
    if (f.id === candidateId) return true;
    stack.push(...(byParent.get(f.id) ?? []));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function FolderTree({
  selectedFolderId,
  selectedId,
  onSelect,
  favoritesOnly = false,
  onToggleFavorites,
  onResourceMoved,
}: FolderTreeProps) {
  const toast = useToast();
  const activeId = selectedFolderId !== undefined ? selectedFolderId : (selectedId ?? null);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null | 'root'>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createParent, setCreateParent] = useState<string>('');
  const [createBusy, setCreateBusy] = useState(false);

  const [renameTarget, setRenameTarget] = useState<Folder | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const [moveTarget, setMoveTarget] = useState<Folder | null>(null);
  const [moveParent, setMoveParent] = useState<string>('');
  const [moveBusy, setMoveBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listFolders({ permissions: false });
      setFolders(list);
    } catch (err) {
      setError(errMessage(err, '加载文件夹失败。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuFor]);

  const tree = useMemo<FolderNode[]>(() => buildFolderTree(folders), [folders]);

  const byParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const key = f.folder_parent_id ?? null;
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return map;
  }, [folders]);

  const folderName = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return '全部凭据（根）';
      return folders.find((f) => f.id === id)?.name ?? '（未知文件夹）';
    },
    [folders],
  );

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreate = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const name = createName.trim();
      if (!name) return;
      setCreateBusy(true);
      try {
        await createFolder({ name, folder_parent_id: createParent || null });
        toast.success(`已创建文件夹「${name}」。`);
        setCreateOpen(false);
        setCreateName('');
        setCreateParent('');
        if (createParent) setExpanded((prev) => new Set(prev).add(createParent));
        await load();
      } catch (err) {
        toast.error(errMessage(err, '创建文件夹失败。'));
      } finally {
        setCreateBusy(false);
      }
    },
    [createName, createParent, load, toast],
  );

  const handleRename = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!renameTarget) return;
      const name = renameName.trim();
      if (!name || name === renameTarget.name) {
        setRenameTarget(null);
        return;
      }
      setRenameBusy(true);
      try {
        await renameFolder(renameTarget.id, name);
        toast.success('文件夹已重命名。');
        setRenameTarget(null);
        await load();
      } catch (err) {
        toast.error(errMessage(err, '重命名文件夹失败。'));
      } finally {
        setRenameBusy(false);
      }
    },
    [renameTarget, renameName, load, toast],
  );

  const handleMove = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!moveTarget) return;
      const newParent = moveParent || null;
      if ((moveTarget.folder_parent_id ?? null) === newParent) {
        setMoveTarget(null);
        return;
      }
      setMoveBusy(true);
      try {
        await moveFolder(moveTarget.id, newParent);
        toast.success(`已将「${moveTarget.name}」移动到 ${folderName(newParent)}。`);
        setMoveTarget(null);
        if (newParent) setExpanded((prev) => new Set(prev).add(newParent));
        await load();
      } catch (err) {
        toast.error(errMessage(err, '移动文件夹失败。'));
      } finally {
        setMoveBusy(false);
      }
    },
    [moveTarget, moveParent, folderName, load, toast],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteFolder(deleteTarget.id, deleteCascade);
      toast.success(
        deleteCascade ? `已删除「${deleteTarget.name}」及其内容。` : `已删除「${deleteTarget.name}」。`,
      );
      if (activeId === deleteTarget.id) onSelect(null);
      setDeleteTarget(null);
      setDeleteCascade(false);
      await load();
    } catch (err) {
      toast.error(errMessage(err, '删除文件夹失败。'));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, deleteCascade, activeId, onSelect, load, toast]);

  const handleResourceDrop = useCallback(
    async (e: DragEvent, destinationFolderId: string | null) => {
      e.preventDefault();
      setDropTargetId(null);
      const resourceId = readDroppedResourceId(e);
      if (!resourceId) return;
      try {
        await moveResource(resourceId, destinationFolderId);
        toast.success(`已将凭据移动到 ${folderName(destinationFolderId)}。`);
        await load();
        onResourceMoved?.();
      } catch (err) {
        toast.error(errMessage(err, '移动凭据失败。'));
      }
    },
    [folderName, load, onResourceMoved, toast],
  );

  const onRowDragOver = useCallback((e: DragEvent) => {
    if (
      e.dataTransfer.types.includes(RESOURCE_DRAG_MIME) ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  // Recursive folder row render -----------------------------------------------
  const renderNode = useCallback(
    (node: FolderNode, depth: number) => {
      const hasChildren = node.children.length > 0;
      const isOpen = expanded.has(node.id);
      const isActive = activeId === node.id && !favoritesOnly;
      const isDropTarget = dropTargetId === node.id;
      const menuOpen = menuFor === node.id;

      return (
        <div key={node.id}>
          <div
            className={`frow${isActive ? ' active' : ''}${hasChildren && isOpen ? ' open' : ''}${
              isDropTarget ? ' drop' : ''
            }`}
            role="treeitem"
            aria-selected={isActive}
            aria-expanded={hasChildren ? isOpen : undefined}
            style={{ position: 'relative', paddingLeft: 9 + depth * 18 }}
            onClick={() => onSelect(node.id)}
            onDragOver={onRowDragOver}
            onDragEnter={() => setDropTargetId(node.id)}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                setDropTargetId((cur) => (cur === node.id ? null : cur));
              }
            }}
            onDrop={(e) => void handleResourceDrop(e, node.id)}
          >
            {hasChildren ? (
              <button
                type="button"
                className="twirl"
                aria-label={isOpen ? '收起' : '展开'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node.id);
                }}
              >
                <ChevronRight />
              </button>
            ) : (
              <span style={{ width: 12, flex: '0 0 12px' }} />
            )}
            <FolderIcon />
            <span className="fname">{node.name}</span>
            {node.personal === false && <Users style={{ width: 13, height: 13 }} aria-label="共享文件夹" />}
            <button
              type="button"
              className="fmenu"
              aria-label="文件夹操作"
              onClick={(e) => {
                e.stopPropagation();
                setMenuFor((cur) => (cur === node.id ? null : node.id));
              }}
            >
              <MoreHorizontal />
            </button>

            {menuOpen && (
              <div className="menu" role="menu" style={{ top: '100%', right: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => {
                    setMenuFor(null);
                    setRenameTarget(node);
                    setRenameName(node.name);
                  }}
                >
                  <Pencil /> 重命名
                </button>
                <button
                  onClick={() => {
                    setMenuFor(null);
                    setMoveTarget(node);
                    setMoveParent(node.folder_parent_id ?? '');
                  }}
                >
                  <MoveIcon /> 移动…
                </button>
                <div className="sep" />
                <button
                  className="danger"
                  onClick={() => {
                    setMenuFor(null);
                    setDeleteTarget(node);
                    setDeleteCascade(false);
                  }}
                >
                  <Trash2 /> 删除
                </button>
              </div>
            )}
          </div>

          {hasChildren && isOpen && (
            <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>
          )}
        </div>
      );
    },
    [
      activeId,
      favoritesOnly,
      expanded,
      dropTargetId,
      menuFor,
      onSelect,
      onRowDragOver,
      handleResourceDrop,
      toggleExpand,
    ],
  );

  const renderParentOptions = useCallback(
    (excludeSubtreeOf?: string) => {
      const opts: { id: string; label: string }[] = [];
      const walk = (nodes: FolderNode[], depth: number) => {
        for (const n of nodes) {
          if (excludeSubtreeOf && isSelfOrDescendant(excludeSubtreeOf, n.id, byParent)) continue;
          opts.push({ id: n.id, label: `${'— '.repeat(depth)}${n.name}` });
          walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
      return opts;
    },
    [tree, byParent],
  );

  return (
    <div className="folders" ref={containerRef}>
      <div className="folders-scroll">
        <div className="fsec-label">快速访问</div>

        {/* 全部凭据 (root) — also a drop target moving resources to root. */}
        <div
          className={`frow${activeId === null && !favoritesOnly ? ' active' : ''}${
            dropTargetId === 'root' ? ' drop' : ''
          }`}
          role="treeitem"
          onClick={() => {
            onToggleFavorites?.(false);
            onSelect(null);
          }}
          onDragOver={onRowDragOver}
          onDragEnter={() => setDropTargetId('root')}
          onDragLeave={() => setDropTargetId((cur) => (cur === 'root' ? null : cur))}
          onDrop={(e) => void handleResourceDrop(e, null)}
        >
          <span style={{ width: 12, flex: '0 0 12px' }} />
          <VaultIcon />
          <span className="fname">全部凭据</span>
        </div>

        {/* 收藏 — virtual node toggling the favorites filter. */}
        {onToggleFavorites && (
          <div
            className={`frow${favoritesOnly ? ' active' : ''}`}
            role="treeitem"
            onClick={() => onToggleFavorites(!favoritesOnly)}
          >
            <span style={{ width: 12, flex: '0 0 12px' }} />
            <Star style={favoritesOnly ? { fill: 'currentColor' } : undefined} />
            <span className="fname">收藏</span>
          </div>
        )}

        <div className="fsec-label">文件夹</div>

        {loading ? (
          <div className="frow" style={{ color: 'var(--text-3)', cursor: 'default' }}>
            <span className="spin-ring" />
            <span className="fname">加载文件夹…</span>
          </div>
        ) : error ? (
          <div style={{ padding: '8px 9px' }}>
            <div className="warnbox" style={{ fontSize: 12, padding: '10px 11px' }}>
              <div>
                {error}
                <button
                  className="btn sm"
                  style={{ marginTop: 8 }}
                  onClick={() => void load()}
                  type="button"
                >
                  重试
                </button>
              </div>
            </div>
          </div>
        ) : tree.length === 0 ? (
          <div className="frow" style={{ color: 'var(--text-3)', cursor: 'default', fontStyle: 'italic' }}>
            <span style={{ width: 12, flex: '0 0 12px' }} />
            <span className="fname">还没有文件夹</span>
          </div>
        ) : (
          <div role="tree">{tree.map((node) => renderNode(node, 0))}</div>
        )}

        <button
          type="button"
          className="frow"
          style={{ marginTop: 8, color: 'var(--accent-text)' }}
          onClick={() => {
            setCreateParent(activeId ?? '');
            setCreateName('');
            setCreateOpen(true);
          }}
        >
          <span style={{ width: 12, flex: '0 0 12px' }} />
          <Plus style={{ color: 'var(--accent)' }} />
          <span className="fname">新建文件夹</span>
        </button>
      </div>

      {/* ---- Create modal ---- */}
      <Modal
        open={createOpen}
        title="新建文件夹"
        onClose={() => !createBusy && setCreateOpen(false)}
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={(e) => void handleCreate(e)}
              disabled={createBusy || createName.trim().length === 0}
            >
              {createBusy ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <form onSubmit={handleCreate}>
          <div className="form-group">
            <label className="form-label" htmlFor="ft-create-name">
              文件夹名称
            </label>
            <input
              id="ft-create-name"
              className="form-control"
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              disabled={createBusy}
              placeholder="例如：工作"
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ft-create-parent">
              上级文件夹
            </label>
            <select
              id="ft-create-parent"
              className="form-control"
              value={createParent}
              onChange={(e) => setCreateParent(e.target.value)}
              disabled={createBusy}
            >
              <option value="">全部凭据（根）</option>
              {renderParentOptions().map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={{ display: 'none' }} aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* ---- Rename modal ---- */}
      <Modal
        open={renameTarget !== null}
        title="重命名文件夹"
        onClose={() => !renameBusy && setRenameTarget(null)}
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setRenameTarget(null)} disabled={renameBusy}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={(e) => void handleRename(e)}
              disabled={renameBusy || renameName.trim().length === 0}
            >
              {renameBusy ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <form onSubmit={handleRename}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ft-rename-name">
              文件夹名称
            </label>
            <input
              id="ft-rename-name"
              className="form-control"
              autoFocus
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              disabled={renameBusy}
            />
          </div>
          <button type="submit" style={{ display: 'none' }} aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* ---- Move modal ---- */}
      <Modal
        open={moveTarget !== null}
        title={moveTarget ? `移动「${moveTarget.name}」` : '移动文件夹'}
        onClose={() => !moveBusy && setMoveTarget(null)}
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setMoveTarget(null)} disabled={moveBusy}>
              取消
            </button>
            <button className="btn btn-primary" onClick={(e) => void handleMove(e)} disabled={moveBusy}>
              {moveBusy ? '移动中…' : '移动'}
            </button>
          </>
        }
      >
        <form onSubmit={handleMove}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ft-move-parent">
              目标位置
            </label>
            <select
              id="ft-move-parent"
              className="form-control"
              value={moveParent}
              onChange={(e) => setMoveParent(e.target.value)}
              disabled={moveBusy}
            >
              <option value="">全部凭据（根）</option>
              {renderParentOptions(moveTarget?.id).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={{ display: 'none' }} aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* ---- Delete confirm ---- */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除文件夹"
        danger
        loading={deleteBusy}
        confirmLabel="删除"
        cancelLabel="取消"
        message={
          <>
            删除文件夹 <strong style={{ color: 'var(--text)' }}>{deleteTarget?.name}</strong>？此操作不可撤销。
          </>
        }
        extra={
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={deleteCascade}
              onChange={(e) => setDeleteCascade(e.target.checked)}
              disabled={deleteBusy}
            />
            同时删除其内容（凭据与子文件夹）。关闭时，可写内容会被移动到根目录。
          </label>
        }
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteCascade(false);
        }}
      />
    </div>
  );
}
