/**
 * FolderTree (smart component).
 *
 * Left-navigation folder tree used inside Vault. It:
 *   - fetches the flat /folders.json list and nests it into a tree client-side
 *     (folders.buildFolderTree by folder_parent_id);
 *   - renders "All passwords" (folderId = null) and a virtual "Favorites" node;
 *   - shows each folder with a Folder icon, a personal/shared indicator (Users
 *     icon when personal === false), collapse/expand chevrons, an active
 *     highlight, and a hover "..." menu with Rename / Move / Delete;
 *   - supports create (+ New Folder), rename (PUT /folders/{id}.json),
 *     move (PUT /move/Folder/{id}.json) and delete (DELETE /folders/{id}.json
 *     ?cascade=1|0 driven by a "delete contents too" checkbox);
 *   - accepts HTML5-dropped resources from the Vault table and moves them via
 *     PUT /move/Resource/{id}.json.
 *
 * Theme-matching sidebar styling, loading / error / empty states, useToast.
 *
 * E2EE note: folders carry no secret material, so this component performs NO
 * crypto. (Moving a resource between folders does not re-encrypt anything; the
 * server only re-parents the permission graph in the current user's tree.)
 *
 * This component OWNS this file only. It imports everything else from the
 * foundation (folders service, shared components, types).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
  Users,
  Move as MoveIcon,
} from 'lucide-react';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { Spinner } from './Spinner';
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
// Public contract — kept compatible with the stub that Vault imports.
// ---------------------------------------------------------------------------
export interface FolderTreeProps {
  /** Currently selected folder id (null = All passwords / root). */
  selectedFolderId: string | null;
  /**
   * Alias accepted for the shorter `selectedId` prop name; `selectedFolderId`
   * takes precedence when both are supplied.
   */
  selectedId?: string | null;
  /** Called when a folder (or the All node) is selected. null = All passwords. */
  onSelect: (folderId: string | null) => void;
  /** Whether the virtual "Favorites" node is active (drives parent's filter). */
  favoritesOnly?: boolean;
  /** Toggle the parent's favorites-only filter. */
  onToggleFavorites?: (on: boolean) => void;
}

/**
 * The drag-and-drop MIME type the Vault table sets on a dragged resource row.
 * A plain-text fallback is also read so the feature still works if the table
 * only sets `text/plain`.
 */
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

/**
 * Read a dragged resource id from a drop event.
 *
 * Contract a drag source must satisfy (set both on `dragstart`):
 *   e.dataTransfer.setData(RESOURCE_DRAG_MIME, resourceId);  // primary
 *   e.dataTransfer.setData('text/plain', resourceId);        // fallback
 *
 * The typed MIME is preferred; `text/plain` is the fallback so the drop still
 * works for a source that only set plain text. Values are trimmed and an empty
 * MIME value falls through to the fallback (so a source that registers the MIME
 * but writes a blank value does not cause a silent no-op move).
 */
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
}: FolderTreeProps) {
  const toast = useToast();
  const activeId = selectedFolderId !== undefined ? selectedFolderId : (selectedId ?? null);

  // Data ---------------------------------------------------------------------
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state -----------------------------------------------------------------
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null | 'root'>(null);

  // Modal / dialog state -----------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createParent, setCreateParent] = useState<string>(''); // '' = root
  const [createBusy, setCreateBusy] = useState(false);

  const [renameTarget, setRenameTarget] = useState<Folder | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const [moveTarget, setMoveTarget] = useState<Folder | null>(null);
  const [moveParent, setMoveParent] = useState<string>(''); // '' = root
  const [moveBusy, setMoveBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch --------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listFolders({ permissions: false });
      setFolders(list);
    } catch (err) {
      setError(errMessage(err, 'Failed to load folders.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Close the row menu on any outside click.
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

  // Derived ------------------------------------------------------------------
  const tree = useMemo<FolderNode[]>(() => buildFolderTree(folders), [folders]);

  /** Map of parentId -> direct children (parentId === null for roots). */
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
      if (!id) return 'All passwords (root)';
      return folders.find((f) => f.id === id)?.name ?? '(unknown folder)';
    },
    [folders],
  );

  // Actions ------------------------------------------------------------------
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
        await createFolder({
          name,
          folder_parent_id: createParent || null,
        });
        toast.success(`Folder "${name}" created.`);
        setCreateOpen(false);
        setCreateName('');
        setCreateParent('');
        // Reveal the parent so the new folder is visible.
        if (createParent) {
          setExpanded((prev) => new Set(prev).add(createParent));
        }
        await load();
      } catch (err) {
        toast.error(errMessage(err, 'Failed to create folder.'));
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
        toast.success('Folder renamed.');
        setRenameTarget(null);
        await load();
      } catch (err) {
        toast.error(errMessage(err, 'Failed to rename folder.'));
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
        toast.success(`Moved "${moveTarget.name}" to ${folderName(newParent)}.`);
        setMoveTarget(null);
        if (newParent) setExpanded((prev) => new Set(prev).add(newParent));
        await load();
      } catch (err) {
        toast.error(errMessage(err, 'Failed to move folder.'));
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
        deleteCascade
          ? `Deleted "${deleteTarget.name}" and its contents.`
          : `Deleted "${deleteTarget.name}".`,
      );
      // If the deleted folder was selected, fall back to All passwords.
      if (activeId === deleteTarget.id) onSelect(null);
      setDeleteTarget(null);
      setDeleteCascade(false);
      await load();
    } catch (err) {
      toast.error(errMessage(err, 'Failed to delete folder.'));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, deleteCascade, activeId, onSelect, load, toast]);

  /** Drop a dragged resource onto a folder (or the root "All passwords" node). */
  const handleResourceDrop = useCallback(
    async (e: DragEvent, destinationFolderId: string | null) => {
      e.preventDefault();
      setDropTargetId(null);
      const resourceId = readDroppedResourceId(e);
      if (!resourceId) return;
      try {
        await moveResource(resourceId, destinationFolderId);
        toast.success(`Moved password to ${folderName(destinationFolderId)}.`);
        // Refetch so child-count / membership stays correct for the tree.
        await load();
      } catch (err) {
        toast.error(errMessage(err, 'Failed to move password.'));
      }
    },
    [folderName, load, toast],
  );

  const onRowDragOver = useCallback((e: DragEvent) => {
    // Only treat as a drop target when a resource is being dragged.
    if (
      e.dataTransfer.types.includes(RESOURCE_DRAG_MIME) ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  // Recursive render ---------------------------------------------------------
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
            className="folder-tree-row"
            role="treeitem"
            aria-selected={isActive}
            aria-expanded={hasChildren ? isOpen : undefined}
            onClick={() => onSelect(node.id)}
            onDragOver={onRowDragOver}
            onDragEnter={() => setDropTargetId(node.id)}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                setDropTargetId((cur) => (cur === node.id ? null : cur));
              }
            }}
            onDrop={(e) => void handleResourceDrop(e, node.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 8px',
              paddingLeft: 8 + depth * 16,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 14,
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: isDropTarget
                ? 'rgba(0, 112, 243, 0.18)'
                : isActive
                  ? 'rgba(255, 255, 255, 0.05)'
                  : 'transparent',
              borderLeft: isActive
                ? '2px solid var(--primary-color)'
                : '2px solid transparent',
              position: 'relative',
              transition: 'background var(--transition-fast)',
            }}
          >
            {/* Expand / collapse chevron (or spacer to keep alignment). */}
            {hasChildren ? (
              <button
                type="button"
                aria-label={isOpen ? 'Collapse' : 'Expand'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node.id);
                }}
                style={{
                  display: 'inline-flex',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: 0,
                  width: 16,
                  flexShrink: 0,
                }}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <span style={{ width: 16, flexShrink: 0 }} />
            )}

            <FolderIcon
              size={15}
              style={{ flexShrink: 0, opacity: 0.9 }}
              color={isActive ? 'var(--primary-hover)' : 'currentColor'}
            />

            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={node.name}
            >
              {node.name}
            </span>

            {/* Shared indicator (personal === false => visible to others). */}
            {node.personal === false && (
              <Users
                size={13}
                color="var(--text-muted)"
                aria-label="Shared folder"
                style={{ flexShrink: 0 }}
              />
            )}

            {/* Hover "..." menu trigger. */}
            <button
              type="button"
              className="folder-tree-menu-btn"
              aria-label="Folder actions"
              onClick={(e) => {
                e.stopPropagation();
                setMenuFor((cur) => (cur === node.id ? null : node.id));
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: 2,
                borderRadius: 4,
                opacity: menuOpen ? 1 : undefined,
                flexShrink: 0,
              }}
            >
              <MoreHorizontal size={16} />
            </button>

            {/* Context menu. */}
            {menuOpen && (
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 4,
                  zIndex: 20,
                  minWidth: 150,
                  marginTop: 2,
                  padding: 4,
                  background: 'var(--panel-bg)',
                  backdropFilter: 'blur(16px)',
                  WebkitBackdropFilter: 'blur(16px)',
                  border: '1px solid var(--panel-border)',
                  borderRadius: 'var(--radius-sm)',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
                }}
              >
                <MenuItem
                  icon={<Pencil size={14} />}
                  label="Rename"
                  onClick={() => {
                    setMenuFor(null);
                    setRenameTarget(node);
                    setRenameName(node.name);
                  }}
                />
                <MenuItem
                  icon={<MoveIcon size={14} />}
                  label="Move..."
                  onClick={() => {
                    setMenuFor(null);
                    setMoveTarget(node);
                    setMoveParent(node.folder_parent_id ?? '');
                  }}
                />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  label="Delete"
                  danger
                  onClick={() => {
                    setMenuFor(null);
                    setDeleteTarget(node);
                    setDeleteCascade(false);
                  }}
                />
              </div>
            )}
          </div>

          {/* Children. */}
          {hasChildren && isOpen && (
            <div role="group">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
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

  // -------------------------------------------------------------------------
  // Parent <select> options for the create / move pickers (excludes a folder's
  // own subtree when moving, to prevent cycles).
  // -------------------------------------------------------------------------
  const renderParentOptions = useCallback(
    (excludeSubtreeOf?: string) => {
      const opts: { id: string; label: string }[] = [];
      const walk = (nodes: FolderNode[], depth: number) => {
        for (const n of nodes) {
          if (excludeSubtreeOf && isSelfOrDescendant(excludeSubtreeOf, n.id, byParent)) {
            continue;
          }
          opts.push({ id: n.id, label: `${'— '.repeat(depth)}${n.name}` });
          walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
      return opts;
    },
    [tree, byParent],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      className="glass-panel animate-fade-in"
      style={{
        width: 240,
        minWidth: 240,
        alignSelf: 'flex-start',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {/* All passwords (root) — also a drop target moving resources to root. */}
      <NavRow
        active={activeId === null && !favoritesOnly}
        dropActive={dropTargetId === 'root'}
        icon={<FolderIcon size={15} />}
        label="All passwords"
        onClick={() => {
          onToggleFavorites?.(false);
          onSelect(null);
        }}
        onDragOver={onRowDragOver}
        onDragEnter={() => setDropTargetId('root')}
        onDragLeave={() => setDropTargetId((cur) => (cur === 'root' ? null : cur))}
        onDrop={(e) => void handleResourceDrop(e, null)}
      />

      {/* Favorites — virtual node toggling the parent's favorites filter. */}
      {onToggleFavorites && (
        <NavRow
          active={favoritesOnly}
          icon={
            <Star
              size={15}
              fill={favoritesOnly ? 'var(--primary-hover)' : 'none'}
              color={favoritesOnly ? 'var(--primary-hover)' : 'currentColor'}
            />
          }
          label="Favorites"
          onClick={() => onToggleFavorites(!favoritesOnly)}
        />
      )}

      <div
        style={{
          height: 1,
          background: 'var(--panel-border)',
          margin: '8px 4px',
        }}
      />

      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          padding: '2px 8px 6px',
        }}
      >
        Folders
      </div>

      {/* Folder hierarchy / states. */}
      <div role="tree" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 8px',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            <Spinner size={16} />
            <span>Loading folders...</span>
          </div>
        ) : error ? (
          <div
            style={{
              background: 'rgba(248, 81, 73, 0.1)',
              color: 'var(--danger-color)',
              border: '1px solid var(--danger-color)',
              borderRadius: 'var(--radius-sm)',
              padding: '8px 10px',
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          >
            <div style={{ marginBottom: 6 }}>{error}</div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : tree.length === 0 ? (
          <div
            style={{
              padding: '10px 8px',
              color: 'var(--text-muted)',
              fontSize: 13,
              fontStyle: 'italic',
            }}
          >
            No folders yet
          </div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>

      {/* + New Folder. */}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          setCreateParent(activeId ?? '');
          setCreateName('');
          setCreateOpen(true);
        }}
        style={{
          marginTop: 12,
          width: '100%',
          justifyContent: 'flex-start',
          padding: '8px 12px',
          fontSize: 13,
        }}
      >
        <FolderPlus size={15} />
        New Folder
      </button>

      {/* ---- Create modal ---- */}
      <Modal
        open={createOpen}
        title="New folder"
        onClose={() => !createBusy && setCreateOpen(false)}
        maxWidth={420}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => setCreateOpen(false)}
              disabled={createBusy}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={(e) => void handleCreate(e)}
              disabled={createBusy || createName.trim().length === 0}
            >
              {createBusy ? 'Creating...' : 'Create'}
            </button>
          </>
        }
      >
        <form onSubmit={handleCreate}>
          <div className="form-group">
            <label className="form-label" htmlFor="ft-create-name">
              Folder name
            </label>
            <input
              id="ft-create-name"
              className="form-control"
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              disabled={createBusy}
              placeholder="e.g. Work"
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ft-create-parent">
              Parent folder
            </label>
            <select
              id="ft-create-parent"
              className="form-control"
              value={createParent}
              onChange={(e) => setCreateParent(e.target.value)}
              disabled={createBusy}
            >
              <option value="">All passwords (root)</option>
              {renderParentOptions().map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {/* Allow Enter-to-submit without a visible button inside the form. */}
          <button type="submit" style={{ display: 'none' }} aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* ---- Rename modal ---- */}
      <Modal
        open={renameTarget !== null}
        title="Rename folder"
        onClose={() => !renameBusy && setRenameTarget(null)}
        maxWidth={420}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => setRenameTarget(null)}
              disabled={renameBusy}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={(e) => void handleRename(e)}
              disabled={renameBusy || renameName.trim().length === 0}
            >
              {renameBusy ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleRename}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ft-rename-name">
              Folder name
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
        title={moveTarget ? `Move "${moveTarget.name}"` : 'Move folder'}
        onClose={() => !moveBusy && setMoveTarget(null)}
        maxWidth={420}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => setMoveTarget(null)}
              disabled={moveBusy}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={(e) => void handleMove(e)}
              disabled={moveBusy}
            >
              {moveBusy ? 'Moving...' : 'Move'}
            </button>
          </>
        }
      >
        <form onSubmit={handleMove}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="ft-move-parent">
              Destination
            </label>
            <select
              id="ft-move-parent"
              className="form-control"
              value={moveParent}
              onChange={(e) => setMoveParent(e.target.value)}
              disabled={moveBusy}
            >
              <option value="">All passwords (root)</option>
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
        title="Delete folder"
        danger
        loading={deleteBusy}
        confirmLabel="Delete"
        message={
          <>
            Delete the folder{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {deleteTarget?.name}
            </strong>
            ? This cannot be undone.
          </>
        }
        extra={
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={deleteCascade}
              onChange={(e) => setDeleteCascade(e.target.checked)}
              disabled={deleteBusy}
            />
            Also delete its contents (passwords and sub-folders). When off,
            writable contents are moved to the root.
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

// ---------------------------------------------------------------------------
// Small presentational helpers (local to this file).
// ---------------------------------------------------------------------------
function NavRow({
  active,
  dropActive,
  icon,
  label,
  onClick,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: {
  active: boolean;
  dropActive?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  onDragOver?: (e: DragEvent) => void;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onDrop?: (e: DragEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderLeft: active ? '2px solid var(--primary-color)' : '2px solid transparent',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 500,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: dropActive
          ? 'rgba(0, 112, 243, 0.18)'
          : active
            ? 'rgba(255, 255, 255, 0.05)'
            : 'transparent',
        transition: 'background var(--transition-fast)',
      }}
    >
      <span style={{ display: 'inline-flex', color: active ? 'var(--primary-hover)' : 'inherit' }}>
        {icon}
      </span>
      {label}
    </button>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 10px',
        background: 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
        color: danger ? 'var(--danger-color)' : 'var(--text-primary)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = danger
          ? 'rgba(248, 81, 73, 0.12)'
          : 'rgba(255, 255, 255, 0.06)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {icon}
      {label}
    </button>
  );
}
