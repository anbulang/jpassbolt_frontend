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
  variant: BadgeVariant;
}

/** Derives the status badge from a user's active / disabled flags. */
function statusOf(user: User): UserStatus {
  if (user.disabled) return { label: 'Disabled', variant: 'danger' };
  if (user.active) return { label: 'Active', variant: 'success' };
  return { label: 'Pending', variant: 'muted' };
}

/** Maps a role name to a badge variant. */
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

const DANGER_BANNER: React.CSSProperties = {
  background: 'rgba(248, 81, 73, 0.1)',
  border: '1px solid rgba(248, 81, 73, 0.3)',
  color: 'var(--danger-color)',
  borderRadius: 'var(--radius-sm)',
  padding: '12px 16px',
  fontSize: '14px',
  marginBottom: '20px',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
};

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
        setLoadError(errorMessage(err, 'Failed to load the user directory.'));
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
        setFormError('A username (email) is required.');
        return;
      }
      if (!form.role_id) {
        setFormError('Please select a role.');
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
          'User invited. They must complete account setup from their email before they can sign in.'
        );
        closeForm();
        await fetchUsers();
      } catch (err) {
        const msg = isForbidden(err)
          ? 'You do not have permission to invite users.'
          : errorMessage(err, 'Failed to invite the user.');
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
        toast.success('User updated.');
        closeForm();
        await fetchUsers();
      } catch (err) {
        const msg = isForbidden(err)
          ? 'You do not have permission to edit this user.'
          : errorMessage(err, 'Failed to update the user.');
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
        setDeleteBlocked('You do not have permission to delete this user.');
      } else {
        // A 400 here means the user solely owns content that must be
        // transferred first; surface the backend's explanation verbatim.
        setDeleteBlocked(
          errorMessage(
            err,
            'This user cannot be deleted yet — they solely own shared passwords or are the only manager of a group. Transfer ownership first.'
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
      toast.success(`${displayName(deleteTarget)} was deleted.`);
      cancelDelete();
      await fetchUsers();
    } catch (err) {
      // The backend may still reject with a transfer requirement at commit time.
      const msg = isForbidden(err)
        ? 'You do not have permission to delete this user.'
        : errorMessage(
            err,
            'Failed to delete the user. They may solely own content that must be transferred first.'
          );
      setDeleteBlocked(msg);
      setDeleting(false);
    }
  }, [deleteTarget, deleteBlocked, toast, cancelDelete, fetchUsers]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const hasSearch = search.length > 0;

  return (
    <div className="container animate-fade-in">
      {/* Header ----------------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '8px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600 }}>Users</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            {isAdmin
              ? 'Manage the people in your organization.'
              : 'The people in your organization.'}
          </p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={openInvite}>
            <UserPlus size={16} /> Invite User
          </button>
        )}
      </div>

      {/* Toolbar: search + active filter ---------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          margin: '20px 0',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
          <Search
            size={16}
            color="var(--text-muted)"
            style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            className="form-control"
            placeholder="Search by name, username, or email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ paddingLeft: '36px' }}
            aria-label="Search users"
          />
        </div>
        {isAdmin && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '14px',
              color: 'var(--text-secondary)',
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
            Active only
          </label>
        )}
      </div>

      {/* Load error banner ------------------------------------------------ */}
      {loadError && (
        <div style={DANGER_BANNER} role="alert">
          <ShieldAlert size={18} />
          <span>{loadError}</span>
        </div>
      )}

      {/* Body: loading / empty / table ------------------------------------ */}
      {loading ? (
        <div className="glass-panel">
          <FullSpinner label="Loading users…" />
        </div>
      ) : users.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="No users found"
          description={
            hasSearch
              ? 'No users match your search. Try a different name or email.'
              : isAdmin
                ? 'Invite your first teammate to get started.'
                : 'There are no other users in your organization yet.'
          }
          action={
            isAdmin && !hasSearch ? (
              <button className="btn btn-primary" onClick={openInvite}>
                <UserPlus size={16} /> Invite User
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="glass-panel" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last logged in</th>
                  {isAdmin && (
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const status = statusOf(user);
                  const isSelf = currentUser?.id === user.id;
                  return (
                    <tr
                      key={user.id}
                      onClick={() => !isAdmin && setViewTarget(user)}
                      style={{ cursor: isAdmin ? 'default' : 'pointer' }}
                    >
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                          }}
                        >
                          <Avatar
                            src={avatarUrl(user, 'small')}
                            firstName={user.profile?.first_name}
                            lastName={user.profile?.last_name}
                            name={user.username}
                            size={34}
                          />
                          <span style={{ fontWeight: 500 }}>
                            {displayName(user)}
                            {isSelf && (
                              <span
                                style={{
                                  color: 'var(--text-muted)',
                                  fontWeight: 400,
                                  marginLeft: '6px',
                                  fontSize: '12px',
                                }}
                              >
                                (you)
                              </span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-secondary)' }}>
                        {user.username}
                      </td>
                      <td>
                        <Badge variant={roleVariant(user.role?.name)}>
                          {user.role?.name ?? 'user'}
                        </Badge>
                      </td>
                      <td>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </td>
                      <td style={{ color: 'var(--text-secondary)' }}>
                        {formatDate(user.last_logged_in)}
                      </td>
                      {isAdmin && (
                        <td>
                          <div
                            style={{
                              display: 'flex',
                              gap: '8px',
                              justifyContent: 'flex-end',
                            }}
                          >
                            <button
                              className="icon-btn"
                              title="Edit user"
                              aria-label={`Edit ${displayName(user)}`}
                              onClick={() => openEdit(user)}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="icon-btn danger"
                              title={
                                isSelf
                                  ? 'You cannot delete your own account'
                                  : 'Delete user'
                              }
                              aria-label={`Delete ${displayName(user)}`}
                              disabled={isSelf}
                              style={
                                isSelf
                                  ? { opacity: 0.4, cursor: 'not-allowed' }
                                  : undefined
                              }
                              onClick={() => !isSelf && void beginDelete(user)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Invite modal (admin) --------------------------------------------- */}
      <Modal
        open={inviteOpen}
        title="Invite User"
        onClose={closeForm}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={closeForm}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="invite-user-form"
              disabled={saving}
            >
              {saving ? 'Inviting…' : 'Send Invite'}
            </button>
          </>
        }
      >
        {form && inviteOpen && (
          <form id="invite-user-form" onSubmit={submitInvite}>
            {formError && (
              <div style={DANGER_BANNER} role="alert">
                <ShieldAlert size={18} />
                <span>{formError}</span>
              </div>
            )}
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '13px',
                marginTop: 0,
                marginBottom: '20px',
                lineHeight: 1.5,
              }}
            >
              The invited user receives a setup link and must complete account
              creation (generating their GPG key) before they can sign in.
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="invite-username">
                Username (email)
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
                  First name
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
                  Last name
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
                Role
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
                {roles.length === 0 && <option value="">Loading roles…</option>}
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
        title="Edit User"
        onClose={closeForm}
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={closeForm}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="edit-user-form"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </>
        }
      >
        {form && editTarget && (
          <form id="edit-user-form" onSubmit={submitEdit}>
            {formError && (
              <div style={DANGER_BANNER} role="alert">
                <ShieldAlert size={18} />
                <span>{formError}</span>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Username</label>
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
                  First name
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
                  Last name
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
                Role
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
                    {editTarget.role?.name ?? 'current role'}
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
                  Disable this account
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--text-muted)',
                      fontSize: '12px',
                    }}
                  >
                    Disabled users keep their data but cannot sign in.
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
        title="User Profile"
        onClose={() => setViewTarget(null)}
        maxWidth={420}
        footer={
          <button
            className="btn btn-secondary"
            onClick={() => setViewTarget(null)}
          >
            Close
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
                    color: 'var(--text-secondary)',
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
                {viewTarget.role?.name ?? 'user'}
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
                  borderBottom: '1px solid var(--panel-border)',
                }}
              >
                <dt style={{ color: 'var(--text-secondary)' }}>Member since</dt>
                <dd style={{ margin: 0 }}>{formatDate(viewTarget.created)}</dd>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <dt style={{ color: 'var(--text-secondary)' }}>
                  Last logged in
                </dt>
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
        title="Delete User"
        danger={!deleteBlocked}
        loading={deleting || deleteChecking}
        confirmLabel={deleteBlocked ? 'OK' : 'Delete'}
        cancelLabel={deleteBlocked ? 'Close' : 'Cancel'}
        message={
          deleteChecking ? (
            <span
              style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
            >
              Checking whether this user can be deleted…
            </span>
          ) : deleteBlocked ? (
            <span style={{ color: 'var(--danger-color)' }}>
              {deleteBlocked}
            </span>
          ) : (
            <>
              Permanently delete{' '}
              <strong>
                {deleteTarget ? displayName(deleteTarget) : 'this user'}
              </strong>
              ? This cannot be undone. Their access is revoked immediately.
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
