import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
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
import { describeApiError } from '../i18n/errors';

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

/** True when the error is an HTTP 403 (forbidden). */
function isForbidden(err: unknown): boolean {
  return err instanceof AxiosError && err.response?.status === 403;
}

interface UserStatus {
  /** i18n key under directory:users.status for the chip label. */
  labelKey: 'disabled' | 'active' | 'pending';
  /** Aegis statuschip variant: active / disabled / pending. */
  tone: 'active' | 'disabled' | 'pending';
  variant: BadgeVariant;
}

/** Derives the status from a user's active / disabled flags. */
function statusOf(user: User): UserStatus {
  if (user.disabled) return { labelKey: 'disabled', tone: 'disabled', variant: 'danger' };
  if (user.active) return { labelKey: 'active', tone: 'active', variant: 'success' };
  return { labelKey: 'pending', tone: 'pending', variant: 'muted' };
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
  const { t } = useTranslation('directory');
  if (roleName === 'admin') {
    return (
      <span className="rolebadge admin">
        <ShieldCheck /> {t('users.role.admin')}
      </span>
    );
  }
  return <span className="rolebadge">{t('users.role.member')}</span>;
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
  const { t } = useTranslation('directory');
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
        setLoadError(describeApiError(err));
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
        setFormError(t('users.form.usernameRequired'));
        return;
      }
      if (!form.role_id) {
        setFormError(t('users.form.roleRequired'));
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
        toast.success(t('users.toast.inviteSent'));
        closeForm();
        await fetchUsers();
      } catch (err) {
        const msg = isForbidden(err)
          ? t('users.error.inviteForbidden')
          : describeApiError(err);
        setFormError(msg);
        setSaving(false);
      }
    },
    [form, toast, closeForm, fetchUsers, t]
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
        toast.success(t('users.toast.updated'));
        closeForm();
        await fetchUsers();
      } catch (err) {
        const msg = isForbidden(err)
          ? t('users.error.editForbidden')
          : describeApiError(err);
        setFormError(msg);
        setSaving(false);
      }
    },
    [form, editTarget, toast, closeForm, fetchUsers, t]
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
        setDeleteBlocked(t('users.error.deleteForbidden'));
      } else {
        // A 400 here means the user solely owns content that must be
        // transferred first; surface the backend's explanation verbatim.
        setDeleteBlocked(describeApiError(err));
      }
    } finally {
      setDeleteChecking(false);
    }
  }, [t]);

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
      toast.success(t('users.toast.deleted', { name: displayName(deleteTarget) }));
      cancelDelete();
      await fetchUsers();
    } catch (err) {
      // The backend may still reject with a transfer requirement at commit time.
      const msg = isForbidden(err)
        ? t('users.error.deleteForbidden')
        : describeApiError(err);
      setDeleteBlocked(msg);
      setDeleting(false);
    }
  }, [deleteTarget, deleteBlocked, toast, cancelDelete, fetchUsers, t]);

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
          <h2>{t('users.head.title')}</h2>
          <p>
            {isAdmin
              ? t('users.head.subtitleAdmin', { count: users.length })
              : t('users.head.subtitleMember', { count: users.length })}
          </p>
        </div>
        <div className="ph-spacer" />
        {isAdmin && (
          <button className="btn primary" onClick={openInvite}>
            <UserPlus /> {t('users.invite')}
          </button>
        )}
      </div>

      {/* Toolbar: search + segmented filter ------------------------------- */}
      <div className="page-toolbar">
        <div className="searchbox">
          <Search />
          <input
            type="text"
            placeholder={t('users.toolbar.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label={t('users.toolbar.searchAria')}
          />
        </div>
        <div className="seg">
          <button
            className={segment === 'all' ? 'on' : ''}
            onClick={() => setSegment('all')}
          >
            {t('users.segment.all', { count: counts.all })}
          </button>
          <button
            className={segment === 'admin' ? 'on' : ''}
            onClick={() => setSegment('admin')}
          >
            {t('users.segment.admin', { count: counts.admin })}
          </button>
          <button
            className={segment === 'pending' ? 'on' : ''}
            onClick={() => setSegment('pending')}
          >
            {t('users.segment.pending', { count: counts.pending })}
          </button>
          <button
            className={segment === 'disabled' ? 'on' : ''}
            onClick={() => setSegment('disabled')}
          >
            {t('users.segment.disabled', { count: counts.disabled })}
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
            {t('users.toolbar.activeOnly')}
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
        <FullSpinner label={t('users.loading')} />
      ) : visibleUsers.length === 0 ? (
        <div className="page-scroll">
          <EmptyState
            icon={UsersIcon}
            title={t('users.empty.title')}
            description={
              hasSearch
                ? t('users.empty.descSearch')
                : isAdmin
                  ? t('users.empty.descAdmin')
                  : t('users.empty.descMember')
            }
            action={
              isAdmin && !hasSearch ? (
                <button className="btn primary" onClick={openInvite}>
                  <UserPlus /> {t('users.invite')}
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
              <div>{t('users.table.user')}</div>
              <div>{t('users.table.role')}</div>
              <div>{t('users.table.groups')}</div>
              <div>{t('users.table.status')}</div>
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
                            {t('users.you')}
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
                    <span className="sd" /> {t(`users.status.${status.labelKey}`)}
                    <span
                      style={{
                        color: 'var(--text-3)',
                        fontSize: 11,
                        marginLeft: 2,
                      }}
                    >
                      {t('users.lastLogin', { date: formatDate(user.last_logged_in) })}
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
                        title={t('users.actions.editTitle')}
                        aria-label={t('users.actions.editAria', { name: displayName(user) })}
                        onClick={() => openEdit(user)}
                      >
                        <Pencil />
                      </button>
                      <button
                        className="rowmenu"
                        title={
                          isSelf
                            ? t('users.actions.deleteSelfTitle')
                            : t('users.actions.deleteTitle')
                        }
                        aria-label={t('users.actions.deleteAria', { name: displayName(user) })}
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
        title={t('users.inviteModal.title')}
        onClose={closeForm}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={closeForm}
              disabled={saving}
            >
              {t('common:actions.cancel')}
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="invite-user-form"
              disabled={saving}
            >
              {saving ? t('users.inviteModal.sending') : t('users.inviteModal.send')}
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
              {t('users.inviteModal.hint')}
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="invite-username">
                {t('users.inviteModal.usernameLabel')}
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
                  {t('users.inviteModal.firstNameLabel')}
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
                  {t('users.inviteModal.lastNameLabel')}
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
                {t('users.inviteModal.roleLabel')}
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
                {roles.length === 0 && <option value="">{t('users.inviteModal.roleLoading')}</option>}
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
        title={t('users.editModal.title')}
        onClose={closeForm}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={closeForm}
              disabled={saving}
            >
              {t('common:actions.cancel')}
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="edit-user-form"
              disabled={saving}
            >
              {saving ? t('common:actions.saving') : t('common:actions.save')}
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
              <label className="form-label">{t('users.editModal.usernameLabel')}</label>
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
                  {t('users.editModal.firstNameLabel')}
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
                  {t('users.editModal.lastNameLabel')}
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
                {t('users.editModal.roleLabel')}
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
                    {editTarget.role?.name ?? t('users.editModal.currentRole')}
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
                  {t('users.editModal.disableLabel')}
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--text-3)',
                      fontSize: '12px',
                    }}
                  >
                    {t('users.editModal.disableHint')}
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
        title={t('users.viewModal.title')}
        onClose={() => setViewTarget(null)}
        maxWidth={420}
        footer={
          <button
            className="btn btn-secondary"
            onClick={() => setViewTarget(null)}
          >
            {t('common:actions.close')}
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
                {viewTarget.role?.name === 'admin'
                  ? t('users.role.admin')
                  : t('users.role.member')}
              </Badge>
              <Badge variant={statusOf(viewTarget).variant}>
                {t(`users.status.${statusOf(viewTarget).labelKey}`)}
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
                <dt style={{ color: 'var(--text-2)' }}>{t('users.viewModal.joined')}</dt>
                <dd style={{ margin: 0 }}>{formatDate(viewTarget.created)}</dd>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <dt style={{ color: 'var(--text-2)' }}>{t('users.viewModal.lastLogin')}</dt>
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
        title={t('users.deleteDialog.title')}
        danger={!deleteBlocked}
        loading={deleting || deleteChecking}
        confirmLabel={deleteBlocked ? t('users.deleteDialog.ack') : t('common:actions.delete')}
        cancelLabel={deleteBlocked ? t('common:actions.close') : t('common:actions.cancel')}
        message={
          deleteChecking ? (
            <span
              style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
            >
              {t('users.deleteDialog.checking')}
            </span>
          ) : deleteBlocked ? (
            <span style={{ color: 'var(--red-text)' }}>
              {deleteBlocked}
            </span>
          ) : (
            <>
              {t('users.deleteDialog.confirmPrefix')}
              <strong>
                {deleteTarget ? displayName(deleteTarget) : t('users.deleteDialog.confirmFallbackName')}
              </strong>
              {t('users.deleteDialog.confirmSuffix')}
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
