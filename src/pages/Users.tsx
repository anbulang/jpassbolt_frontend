import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { AxiosError } from 'axios';
import {
  Users as UsersIcon,
  UserPlus,
  Search,
  Pencil,
  Trash2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { Role, User, UserCreateRequest, UserUpdateRequest } from '../types';
import {
  createUser,
  deleteUser,
  deleteUserDryRun,
  listUsers,
  updateUser,
} from '../services/users';
import { getRoles } from '../services/settings';
import { avatarUrl } from '../services/profile';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FullSpinner } from '../components/Spinner';
import { EmptyState } from '../components/EmptyState';
import { Avatar } from '../components/Avatar';
import { Badge, type BadgeVariant } from '../components/Badge';
import { useToast } from '../components/toastContext';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shape we read out of localStorage `jpassbolt_user`. */
interface StoredUser {
  id?: string;
  username?: string;
  role?: { name?: string } | null;
  role_id?: string;
}

/** Reads the current user from localStorage; null when missing / malformed. */
function readCurrentUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem('jpassbolt_user');
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  } catch {
    return null;
  }
}

/** Best-effort full name from a profile, falling back to the username. */
function displayName(user: User): string {
  const full = [user.profile?.first_name, user.profile?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return full || user.username;
}

/** Extracts a human-readable error message from an axios/backend error. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError) {
    const headerMsg = err.response?.data?.header?.message as string | undefined;
    if (headerMsg) return headerMsg;
    if (err.message) return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** True when the error is an HTTP 403 (forbidden). */
function isForbidden(err: unknown): boolean {
  return err instanceof AxiosError && err.response?.status === 403;
}

interface UserStatus {
  label: string;
  /** Aegis statuschip variant: active / disabled / pending. */
  tone: 'active' | 'disabled' | 'pending';
  variant: BadgeVariant;
}

/** Derives the status from a user's active / disabled flags. */
function statusOf(user: User): UserStatus {
  if (user.disabled) return { label: '已禁用', tone: 'disabled', variant: 'danger' };
  if (user.active) return { label: '活跃', tone: 'active', variant: 'success' };
  return { label: '待激活', tone: 'pending', variant: 'muted' };
}

/** Maps a role name to a badge variant (used in the profile modal). */
function roleVariant(roleName?: string): BadgeVariant {
  if (roleName === 'admin') return 'primary';
  return 'default';
}

/** RFC3339 string -> short local date, or an em-dash when absent. */
function formatDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Inline role badge matching the Aegis `.rolebadge` style. */
function RoleBadge({ roleName }: { roleName?: string }) {
  if (roleName === 'admin') {
    return (
      <span className="rolebadge admin">
        <ShieldCheck /> 管理员
      </span>
    );
  }
  return <span className="rolebadge">成员</span>;
}

// ---------------------------------------------------------------------------
// Edit / Invite modal form state
// ---------------------------------------------------------------------------

interface UserFormState {
  first_name: string;
  last_name: string;
  username: string;
  role_id: string;
  disabled: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Users() {
  const toast = useToast();

  const currentUser = useMemo(readCurrentUser, []);
  const isAdmin = currentUser?.role?.name === 'admin';

  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Search (debounced) + admin-only "active only" filter.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

  // Client-side segmented filter (presentation only, derived over the fetched list).
  const [segment, setSegment] = useState<'all' | 'admin' | 'pending' | 'disabled'>('all');

  // Modal state.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [viewTarget, setViewTarget] = useState<User | null>(null);
  const [form, setForm] = useState<UserFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete / dry-run state.
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteChecking, setDeleteChecking] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // --- Debounce the search box (~300ms). ---
  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // --- Load roles once (best-effort; used by the admin forms). ---
  useEffect(() => {
    let cancelled = false;
    getRoles()
      .then((data) => {
        if (!cancelled) setRoles(data);
      })
      .catch(() => {
        /* Non-fatal: the role <select> simply shows nothing extra. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Load the directory whenever the filters change. ---
  const reqIdRef = useRef(0);
  const fetchUsers = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await listUsers({
        search: search || undefined,
        // is-active is admin-only; non-admins never send it.
        isActive: isAdmin && activeOnly ? true : undefined,
      });
      if (reqId === reqIdRef.current) setUsers(data);
    } catch (err) {
      if (reqId === reqIdRef.current) {
        setLoadError(errorMessage(err, '加载用户目录失败。'));
      }
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [search, activeOnly, isAdmin]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const defaultRoleId = useMemo(() => {
    const userRole = roles.find((r) => r.name === 'user');
    return userRole?.id ?? roles[0]?.id ?? '';
  }, [roles]);

  // --- Open the invite modal. ---
  const openInvite = useCallback(() => {
    setFormError(null);
    setForm({
      first_name: '',
      last_name: '',
      username: '',
      role_id: defaultRoleId,
      disabled: false,
    });
    setInviteOpen(true);
  }, [defaultRoleId]);

  // --- Open the edit modal for a given user. ---
  const openEdit = useCallback((user: User) => {
    setFormError(null);
    setEditTarget(user);
    setForm({
      first_name: user.profile?.first_name ?? '',
      last_name: user.profile?.last_name ?? '',
      username: user.username,
      role_id: user.role_id,
      disabled: !!user.disabled,
    });
  }, []);

  const closeForm = useCallback(() => {
    setInviteOpen(false);
    setEditTarget(null);
    setForm(null);
    setFormError(null);
    setSaving(false);
  }, []);

  // --- Submit invite (POST /users.json). ---
  const submitInvite = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!form) return;
      if (!form.username.trim()) {
        setFormError('请填写用户名（邮箱）。');
        return;
      }
      if (!form.role_id) {
        setFormError('请选择一个角色。');
        return;
      }
      setSaving(true);
      setFormError(null);
      const req: UserCreateRequest = {
        username: form.username.trim(),
        role_id: form.role_id,
        profile: {
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
        },
      };
      try {
        await createUser(req);
        toast.success(
          '邀请已发送。对方需先通过邮件完成账户设置，才能登录。'
        );
        closeForm();
        await fetchUsers();
      } catch (err) {
        const msg = isForbidden(err)
          ? '你没有邀请用户的权限。'
          : errorMessage(err, '邀请用户失败。');
        setFormError(msg);
        setSaving(false);
      }
    },
    [form, toast, closeForm, fetchUsers]
  );

  // --- Submit edit (PUT /users/{id}.json). ---
  const submitEdit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!form || !editTarget) return;
      setSaving(true);
      setFormError(null);

      const req: UserUpdateRequest = {
        role_id: form.role_id,
        // Disabled toggles a timestamp on, null to re-enable.
        disabled: form.disabled
          ? editTarget.disabled ?? new Date().toISOString()
          : null,
        profile: {
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
        },
      };
      try {
        await updateUser(editTarget.id, req);
        toast.success('用户已更新。');
        closeForm();
        await fetchUsers();
      } catch (err) {
        const msg = isForbidden(err)
          ? '你没有编辑该用户的权限。'
          : errorMessage(err, '更新用户失败。');
        setFormError(msg);
        setSaving(false);
      }
    },
    [form, editTarget, toast, closeForm, fetchUsers]
  );

  // --- Begin a delete: run the dry-run first to surface sole-owner conflicts. ---
  const beginDelete = useCallback(async (user: User) => {
    setDeleteTarget(user);
    setDeleteBlocked(null);
    setDeleteChecking(true);
    try {
      await deleteUserDryRun(user.id);
      // No conflict — the ConfirmDialog will allow the delete.
    } catch (err) {
      if (isForbidden(err)) {
        setDeleteBlocked('你没有删除该用户的权限。');
      } else {
        // A 400 here means the user solely owns content that must be
        // transferred first; surface the backend's explanation verbatim.
        setDeleteBlocked(
          errorMessage(
            err,
            '该用户暂时无法删除——他们是某些共享密码的唯一所有者，或是某个群组的唯一管理员。请先转移所有权。'
          )
        );
      }
    } finally {
      setDeleteChecking(false);
    }
  }, []);

  const cancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteBlocked(null);
    setDeleteChecking(false);
    setDeleting(false);
  }, []);

  // --- Confirm the delete (DELETE /users/{id}.json). ---
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteBlocked) return;
    setDeleting(true);
    try {
      await deleteUser(deleteTarget.id);
      toast.success(`已删除 ${displayName(deleteTarget)}。`);
      cancelDelete();
      await fetchUsers();
    } catch (err) {
      // The backend may still reject with a transfer requirement at commit time.
      const msg = isForbidden(err)
        ? '你没有删除该用户的权限。'
        : errorMessage(
            err,
            '删除用户失败。他们可能是某些内容的唯一所有者，需先转移所有权。'
          );
      setDeleteBlocked(msg);
      setDeleting(false);
    }
  }, [deleteTarget, deleteBlocked, toast, cancelDelete, fetchUsers]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const hasSearch = search.length > 0;

  // Client-side segment counts + filtered view (presentation only).
  const counts = useMemo(
    () => ({
      all: users.length,
      admin: users.filter((u) => u.role?.name === 'admin').length,
      pending: users.filter((u) => !u.disabled && !u.active).length,
      disabled: users.filter((u) => !!u.disabled).length,
    }),
    [users]
  );

  const visibleUsers = useMemo(() => {
    return users.filter((u) => {
      if (segment === 'admin') return u.role?.name === 'admin';
      if (segment === 'pending') return !u.disabled && !u.active;
      if (segment === 'disabled') return !!u.disabled;
      return true;
    });
  }, [users, segment]);

  return (
    <div className="page">
      {/* In-page section header ------------------------------------------- */}
      <div className="page-head">
        <div className="ph-text">
          <h2>用户</h2>
          <p>
            {isAdmin
              ? `${users.length} 名成员 · 管理你组织中的成员`
              : `${users.length} 名成员 · 你组织中的成员`}
          </p>
        </div>
        <div className="ph-spacer" />
        {isAdmin && (
          <button className="btn primary" onClick={openInvite}>
            <UserPlus /> 邀请用户
          </button>
        )}
      </div>

      {/* Toolbar: search + segmented filter ------------------------------- */}
      <div className="page-toolbar">
        <div className="searchbox">
          <Search />
          <input
            type="text"
            placeholder="按姓名、用户名或邮箱搜索…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="搜索用户"
          />
        </div>
        <div className="seg">
          <button
            className={segment === 'all' ? 'on' : ''}
            onClick={() => setSegment('all')}
          >
            全部 {counts.all}
          </button>
          <button
            className={segment === 'admin' ? 'on' : ''}
            onClick={() => setSegment('admin')}
          >
            管理员 {counts.admin}
          </button>
          <button
            className={segment === 'pending' ? 'on' : ''}
            onClick={() => setSegment('pending')}
          >
            待激活 {counts.pending}
          </button>
          <button
            className={segment === 'disabled' ? 'on' : ''}
            onClick={() => setSegment('disabled')}
          >
            已禁用 {counts.disabled}
          </button>
        </div>
        {isAdmin && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
              color: 'var(--text-2)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            仅活跃用户
          </label>
        )}
      </div>

      {/* Load error banner ------------------------------------------------ */}
      {loadError && (
        <div
          className="warnbox"
          role="alert"
          style={{ margin: '14px 28px 0' }}
        >
          <ShieldAlert />
          <span>{loadError}</span>
        </div>
      )}

      {/* Body: loading / empty / table ------------------------------------ */}
      {loading ? (
        <FullSpinner label="加载用户…" />
      ) : visibleUsers.length === 0 ? (
        <div className="page-scroll">
          <EmptyState
            icon={UsersIcon}
            title="未找到用户"
            description={
              hasSearch
                ? '没有匹配你搜索条件的用户。换个姓名或邮箱试试。'
                : isAdmin
                  ? '邀请你的第一位同事开始使用吧。'
                  : '你的组织中暂时还没有其他用户。'
            }
            action={
              isAdmin && !hasSearch ? (
                <button className="btn primary" onClick={openInvite}>
                  <UserPlus /> 邀请用户
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="page-scroll">
          <div className="utable">
            <div
              className="utable-head"
              style={{ gridTemplateColumns: '2.6fr 1fr 1.4fr 1fr 44px' }}
            >
              <div>用户</div>
              <div>角色</div>
              <div>群组</div>
              <div>状态</div>
              <div />
            </div>
            {visibleUsers.map((user) => {
              const status = statusOf(user);
              const isSelf = currentUser?.id === user.id;
              return (
                <div
                  className={'urow' + (user.disabled ? ' disabled' : '')}
                  key={user.id}
                  style={{ gridTemplateColumns: '2.6fr 1fr 1.4fr 1fr 44px' }}
                  onClick={() => !isAdmin && setViewTarget(user)}
                >
                  {/* User cell */}
                  <div className="ucell-user">
                    <Avatar
                      src={avatarUrl(user, 'small')}
                      firstName={user.profile?.first_name}
                      lastName={user.profile?.last_name}
                      name={user.username}
                      size={36}
                    />
                    <div className="un">
                      <div className="n">
                        {displayName(user)}
                        {isSelf && (
                          <span
                            className="chip blue"
                            style={{ padding: '1px 6px' }}
                          >
                            你
                          </span>
                        )}
                      </div>
                      <div className="e">{user.username}</div>
                    </div>
                  </div>

                  {/* Role cell */}
                  <div>
                    <RoleBadge roleName={user.role?.name} />
                  </div>

                  {/* Groups cell — the user object exposes no group names. */}
                  <div className="gchips">
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      —
                    </span>
                  </div>

                  {/* Status cell */}
                  <div className={'statuschip ' + status.tone}>
                    <span className="sd" /> {status.label}
                    <span
                      style={{
                        color: 'var(--text-3)',
                        fontSize: 11,
                        marginLeft: 2,
                      }}
                    >
                      · {formatDate(user.last_logged_in)}
                    </span>
                  </div>

                  {/* Actions cell (admin only) */}
                  {isAdmin ? (
                    <div
                      style={{
                        display: 'flex',
                        gap: '4px',
                        justifySelf: 'end',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className="rowmenu"
                        title="编辑资料"
                        aria-label={`编辑 ${displayName(user)}`}
                        onClick={() => openEdit(user)}
                      >
                        <Pencil />
                      </button>
                      <button
                        className="rowmenu"
                        title={
                          isSelf ? '无法删除自己的账户' : '删除用户'
                        }
                        aria-label={`删除 ${displayName(user)}`}
                        disabled={isSelf}
                        style={
                          isSelf
                            ? { opacity: 0.4, cursor: 'not-allowed' }
                            : { color: 'var(--red-text)' }
                        }
                        onClick={() => !isSelf && void beginDelete(user)}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  ) : (
                    <div />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Invite modal (admin) --------------------------------------------- */}
      <Modal
        open={inviteOpen}
        title="邀请用户"
        onClose={closeForm}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={closeForm}
              disabled={saving}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="invite-user-form"
              disabled={saving}
            >
              {saving ? '发送中…' : '发送邀请'}
            </button>
          </>
        }
      >
        {form && inviteOpen && (
          <form id="invite-user-form" onSubmit={submitInvite}>
            {formError && (
              <div
                className="warnbox"
                role="alert"
                style={{ marginBottom: '20px' }}
              >
                <ShieldAlert />
                <span>{formError}</span>
              </div>
            )}
            <p
              style={{
                color: 'var(--text-2)',
                fontSize: '13px',
                marginTop: 0,
                marginBottom: '20px',
                lineHeight: 1.5,
              }}
            >
              受邀用户将收到一封设置链接，并需在自己的设备上完成账户创建（生成 GPG
              密钥对）后才能登录，私钥永不经过服务器。
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="invite-username">
                用户名（邮箱）
              </label>
              <input
                id="invite-username"
                type="email"
                className="form-control"
                value={form.username}
                onChange={(e) =>
                  setForm({ ...form, username: e.target.value })
                }
                placeholder="person@example.com"
                autoFocus
                required
              />
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label" htmlFor="invite-first">
                  名字
                </label>
                <input
                  id="invite-first"
                  type="text"
                  className="form-control"
                  value={form.first_name}
                  onChange={(e) =>
                    setForm({ ...form, first_name: e.target.value })
                  }
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label" htmlFor="invite-last">
                  姓氏
                </label>
                <input
                  id="invite-last"
                  type="text"
                  className="form-control"
                  value={form.last_name}
                  onChange={(e) =>
                    setForm({ ...form, last_name: e.target.value })
                  }
                  required
                />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="invite-role">
                角色
              </label>
              <select
                id="invite-role"
                className="form-control"
                value={form.role_id}
                onChange={(e) =>
                  setForm({ ...form, role_id: e.target.value })
                }
                required
              >
                {roles.length === 0 && <option value="">加载角色中…</option>}
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
          </form>
        )}
      </Modal>

      {/* Edit modal (admin) ----------------------------------------------- */}
      <Modal
        open={!!editTarget}
        title="编辑用户"
        onClose={closeForm}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={closeForm}
              disabled={saving}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="edit-user-form"
              disabled={saving}
            >
              {saving ? '保存中…' : '保存更改'}
            </button>
          </>
        }
      >
        {form && editTarget && (
          <form id="edit-user-form" onSubmit={submitEdit}>
            {formError && (
              <div
                className="warnbox"
                role="alert"
                style={{ marginBottom: '20px' }}
              >
                <ShieldAlert />
                <span>{formError}</span>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">用户名</label>
              <input
                type="text"
                className="form-control"
                value={form.username}
                disabled
                style={{ opacity: 0.6 }}
              />
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label" htmlFor="edit-first">
                  名字
                </label>
                <input
                  id="edit-first"
                  type="text"
                  className="form-control"
                  value={form.first_name}
                  onChange={(e) =>
                    setForm({ ...form, first_name: e.target.value })
                  }
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label" htmlFor="edit-last">
                  姓氏
                </label>
                <input
                  id="edit-last"
                  type="text"
                  className="form-control"
                  value={form.last_name}
                  onChange={(e) =>
                    setForm({ ...form, last_name: e.target.value })
                  }
                  required
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="edit-role">
                角色
              </label>
              <select
                id="edit-role"
                className="form-control"
                value={form.role_id}
                onChange={(e) =>
                  setForm({ ...form, role_id: e.target.value })
                }
                required
              >
                {roles.length === 0 && (
                  <option value={form.role_id}>
                    {editTarget.role?.name ?? '当前角色'}
                  </option>
                )}
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '14px',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={form.disabled}
                  onChange={(e) =>
                    setForm({ ...form, disabled: e.target.checked })
                  }
                />
                <span>
                  禁用此账户
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--text-3)',
                      fontSize: '12px',
                    }}
                  >
                    被禁用的用户保留其数据，但无法登录。
                  </span>
                </span>
              </label>
            </div>
          </form>
        )}
      </Modal>

      {/* Read-only profile detail (non-admin) ----------------------------- */}
      <Modal
        open={!!viewTarget}
        title="用户资料"
        onClose={() => setViewTarget(null)}
        maxWidth={420}
        footer={
          <button
            className="btn btn-secondary"
            onClick={() => setViewTarget(null)}
          >
            关闭
          </button>
        }
      >
        {viewTarget && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '14px' }}
            >
              <Avatar
                src={avatarUrl(viewTarget, 'medium')}
                firstName={viewTarget.profile?.first_name}
                lastName={viewTarget.profile?.last_name}
                name={viewTarget.username}
                size={56}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '16px' }}>
                  {displayName(viewTarget)}
                </div>
                <div
                  style={{
                    color: 'var(--text-2)',
                    fontSize: '13px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {viewTarget.username}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Badge variant={roleVariant(viewTarget.role?.name)}>
                {viewTarget.role?.name === 'admin' ? '管理员' : '成员'}
              </Badge>
              <Badge variant={statusOf(viewTarget).variant}>
                {statusOf(viewTarget).label}
              </Badge>
            </div>
            <dl style={{ margin: 0, fontSize: '13px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <dt style={{ color: 'var(--text-2)' }}>加入时间</dt>
                <dd style={{ margin: 0 }}>{formatDate(viewTarget.created)}</dd>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <dt style={{ color: 'var(--text-2)' }}>最近登录</dt>
                <dd style={{ margin: 0 }}>
                  {formatDate(viewTarget.last_logged_in)}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </Modal>

      {/* Delete confirm (admin) ------------------------------------------- */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除用户"
        danger={!deleteBlocked}
        loading={deleting || deleteChecking}
        confirmLabel={deleteBlocked ? '知道了' : '删除'}
        cancelLabel={deleteBlocked ? '关闭' : '取消'}
        message={
          deleteChecking ? (
            <span
              style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
            >
              正在检查该用户是否可以删除…
            </span>
          ) : deleteBlocked ? (
            <span style={{ color: 'var(--red-text)' }}>
              {deleteBlocked}
            </span>
          ) : (
            <>
              确定要永久删除{' '}
              <strong>
                {deleteTarget ? displayName(deleteTarget) : '该用户'}
              </strong>
              吗？此操作不可撤销，其访问权限将立即被吊销。
            </>
          )
        }
        // When blocked, the confirm button just dismisses the dialog.
        onConfirm={deleteBlocked ? cancelDelete : confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
