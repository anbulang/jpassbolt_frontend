/**
 * Groups — master/detail page.
 *
 * Left: a glass-panel list of groups (name + member-count Badge).
 * Right: the selected group's detail — members rendered as Avatar + name +
 * Manager/Member Badge (from groups_users.is_admin).
 *
 * Admins and group managers can:
 *   - Create a group (admin only)
 *   - Rename a group
 *   - Add / remove members, toggle the manager (is_admin) flag
 *   - Delete a group (ConfirmDialog, backed by the sole-owner dry-run)
 *
 * RE-ENCRYPTION (the E2EE crux):
 *   Adding a member to a group that already has shared resources means that
 *   member needs a Secret encrypted with THEIR public key for every resource
 *   the group can access. We do NOT guess which resources — the backend tells
 *   us via PUT /groups/{id}/dry-run.json:
 *     - dry-run.SecretsNeeded[] = the (resource_id, user_id) pairs that need a secret
 *     - dry-run.Secrets[]       = the operator's OWN secret per resource (to decrypt)
 *   For each needed pair we: decrypt the operator secret with the in-memory
 *   private key (useKey().decrypt), then re-encrypt the plaintext for the new
 *   member's armored public key (useKey().encryptFor) and include the result in
 *   the final PUT's `secrets[]`.
 *
 *   Correctness invariant (prevents silent lockout): we REFUSE to submit if a
 *   needed member has no resolvable public key. The new member's public key is
 *   resolved from the user object's gpgkey.armored_key (fetched fresh from the
 *   users service when not already present on the picked ARO).
 *
 * All decrypt/encrypt goes through useKey() — never gpg.ts directly.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UsersRound,
  Plus,
  Trash2,
  Pencil,
  ShieldCheck,
  X as XIcon,
  Search,
  UserPlus,
  AlertTriangle,
} from 'lucide-react';
import axios from 'axios';

import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FullSpinner, Spinner } from '../components/Spinner';
import { EmptyState } from '../components/EmptyState';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { useToast } from '../components/toastContext';
import { useKey } from '../crypto/KeyContext';

import * as groupsService from '../services/groups';
import { listUsers, getUser } from '../services/users';
import { verifyArmoredKeyFingerprint } from '../gpg';
import type {
  Group,
  GroupUser,
  User,
  GroupUserChange,
  GroupUpdateRequest,
  SecretWrite,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the current user object (for admin gating + self-protection). */
function readCurrentUser(): User | null {
  try {
    const raw = localStorage.getItem('jpassbolt_user');
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

/** Best-effort display name for a user (falls back to username). */
function userName(u?: User | null): string {
  if (!u) return 'Unknown user';
  const full = [u.profile?.first_name, u.profile?.last_name].filter(Boolean).join(' ');
  return full || u.username || 'Unknown user';
}

/** Extract a human message from any thrown error (Passbolt envelope or generic). */
function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const headerMsg = (err.response?.data as { header?: { message?: string } } | undefined)?.header
      ?.message;
    if (headerMsg) return headerMsg;
    if (err.response?.status === 403) return 'You do not have permission to perform this action.';
    if (err.message) return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

const sharedBannerStyle: React.CSSProperties = {
  padding: '12px 16px',
  background: 'rgba(248, 81, 73, 0.1)',
  border: '1px solid var(--danger-color)',
  color: 'var(--danger-color)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '14px',
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
};

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={sharedBannerStyle} role="alert">
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
      <span>{message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draft membership state used by the Manage Members modal
// ---------------------------------------------------------------------------

/**
 * A row in the membership draft. Mirrors a GroupUser when it already exists
 * (`groupUserId` set) or describes a brand-new member (`groupUserId` undefined).
 */
interface MemberDraft {
  /** groups_users.id when this is an existing membership; undefined when new. */
  groupUserId?: string;
  user: User;
  isAdmin: boolean;
  /** Marked for removal (existing members only). */
  markedDelete: boolean;
  /** True when added in this editing session (no existing groups_users row). */
  isNew: boolean;
}

// ===========================================================================
// Page
// ===========================================================================

export default function Groups() {
  const toast = useToast();
  const { isLocked, decrypt, encryptFor } = useKey();

  const currentUser = useMemo(() => readCurrentUser(), []);
  const isAdmin = currentUser?.role?.name === 'admin';

  // ---- list state
  const [groups, setGroups] = useState<Group[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // ---- detail state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Group | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // ---- modals
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------
  const loadGroups = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const list = await groupsService.listGroups({ containMyGroupUser: true });
      setGroups(list);
      // Keep / clear the selection sensibly.
      setSelectedId((prev) => {
        if (prev && list.some((g) => g.id === prev)) return prev;
        return list.length > 0 ? list[0].id : null;
      });
    } catch (err) {
      setListError(errorMessage(err, 'Failed to load groups.'));
      setGroups([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (groupId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const g = await groupsService.getGroup(groupId, {
        containUsers: true,
        containUserProfile: true,
        containUserGpgkey: true,
        containMyGroupUser: true,
      });
      setDetail(g);
    } catch (err) {
      setDetailError(errorMessage(err, 'Failed to load group members.'));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setDetail(null);
    }
  }, [selectedId, loadDetail]);

  // -------------------------------------------------------------------------
  // Permission: can the current user manage the selected group?
  // (admins always; otherwise only if they are a manager of this group)
  // -------------------------------------------------------------------------
  const canManageSelected = useMemo(() => {
    if (isAdmin) return true;
    const myGu = detail?.my_group_user;
    return Boolean(myGu?.is_admin);
  }, [isAdmin, detail]);

  const sortedMembers = useMemo(() => {
    const members: GroupUser[] = detail?.groups_users ?? [];
    return [...members].sort((a, b) => {
      // Managers first, then alphabetical by display name.
      if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
      return userName(a.user).localeCompare(userName(b.user));
    });
  }, [detail]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const selectedGroup = groups.find((g) => g.id === selectedId) ?? detail ?? null;

  return (
    <>
      <div className="container" style={{ maxWidth: '1100px' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '24px',
            gap: '16px',
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontWeight: 600, letterSpacing: '-0.5px' }}>Groups</h1>
            <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0' }}>
              Organize users into groups to share passwords at scale.
            </p>
          </div>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> New Group
            </button>
          )}
        </div>

        {listError && (
          <div style={{ marginBottom: '20px' }}>
            <ErrorBanner message={listError} />
          </div>
        )}

        {listLoading ? (
          <FullSpinner label="Loading groups..." />
        ) : groups.length === 0 && !listError ? (
          <EmptyState
            icon={UsersRound}
            title="No groups yet"
            description={
              isAdmin
                ? 'Create a group to share passwords with a set of users at once.'
                : 'You are not a member of any group yet.'
            }
            action={
              isAdmin ? (
                <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} /> New Group
                </button>
              ) : undefined
            }
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '320px 1fr',
              gap: '20px',
              alignItems: 'start',
            }}
          >
            {/* Master list */}
            <div className="glass-panel" style={{ overflow: 'hidden' }}>
              <div
                style={{
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--panel-border)',
                  fontSize: '13px',
                  color: 'var(--text-secondary)',
                  fontWeight: 500,
                }}
              >
                {groups.length} {groups.length === 1 ? 'group' : 'groups'}
              </div>
              <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                {groups.map((g) => {
                  const active = g.id === selectedId;
                  const count = g.groups_users?.length ?? g.user_count;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setSelectedId(g.id)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        padding: '12px 16px',
                        background: active ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                        borderLeft: active
                          ? '2px solid var(--primary-color)'
                          : '2px solid transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--panel-border)',
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all var(--transition-fast)',
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          minWidth: 0,
                        }}
                      >
                        <UsersRound size={16} style={{ flexShrink: 0 }} />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontWeight: 500,
                          }}
                        >
                          {g.name}
                        </span>
                      </span>
                      {count !== undefined && (
                        <Badge variant={active ? 'primary' : 'default'}>{count}</Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Detail */}
            <div className="glass-panel" style={{ minHeight: '320px' }}>
              {selectedGroup ? (
                <GroupDetail
                  group={selectedGroup}
                  members={sortedMembers}
                  loading={detailLoading}
                  error={detailError}
                  canManage={canManageSelected}
                  onManage={() => setManageOpen(true)}
                  onRename={() => setRenameOpen(true)}
                  onDelete={() => setDeleteOpen(true)}
                />
              ) : (
                <div style={{ padding: '60px 20px' }}>
                  <EmptyState
                    icon={UsersRound}
                    title="Select a group"
                    description="Pick a group on the left to view its members."
                    panel={false}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---- Create group ---- */}
      {createOpen && (
        <CreateGroupModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (newId) => {
            setCreateOpen(false);
            toast.success('Group created.');
            await loadGroups();
            setSelectedId(newId);
          }}
          onError={(m) => toast.error(m)}
        />
      )}

      {/* ---- Rename group ---- */}
      {renameOpen && selectedGroup && (
        <RenameGroupModal
          group={selectedGroup}
          onClose={() => setRenameOpen(false)}
          onRenamed={async () => {
            setRenameOpen(false);
            toast.success('Group renamed.');
            await loadGroups();
            if (selectedId) await loadDetail(selectedId);
          }}
          onError={(m) => toast.error(m)}
        />
      )}

      {/* ---- Manage members (with re-encryption) ---- */}
      {manageOpen && detail && (
        <ManageMembersModal
          group={detail}
          isLocked={isLocked}
          decrypt={decrypt}
          encryptFor={encryptFor}
          onClose={() => setManageOpen(false)}
          onSaved={async () => {
            setManageOpen(false);
            toast.success('Membership updated.');
            await loadGroups();
            if (selectedId) await loadDetail(selectedId);
          }}
          onError={(m) => toast.error(m)}
        />
      )}

      {/* ---- Delete group ---- */}
      {deleteOpen && selectedGroup && (
        <DeleteGroupDialog
          group={selectedGroup}
          onClose={() => setDeleteOpen(false)}
          onDeleted={async () => {
            setDeleteOpen(false);
            toast.success('Group deleted.');
            setSelectedId(null);
            await loadGroups();
          }}
          onError={(m) => toast.error(m)}
        />
      )}
    </>
  );
}

// ===========================================================================
// Detail panel
// ===========================================================================

function GroupDetail({
  group,
  members,
  loading,
  error,
  canManage,
  onManage,
  onRename,
  onDelete,
}: {
  group: Group;
  members: GroupUser[];
  loading: boolean;
  error: string | null;
  canManage: boolean;
  onManage: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div>
      {/* Detail header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '20px 24px',
          borderBottom: '1px solid var(--panel-border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <span
            style={{
              display: 'inline-flex',
              padding: '10px',
              background: 'rgba(0, 112, 243, 0.12)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <UsersRound size={20} color="var(--primary-color)" />
          </span>
          <div style={{ minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: '18px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {group.name}
            </h2>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </span>
          </div>
        </div>

        {canManage && (
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              className="btn btn-secondary"
              style={{ padding: '8px 12px' }}
              onClick={onManage}
              title="Add or remove members"
            >
              <UserPlus size={16} /> Members
            </button>
            <button
              className="icon-btn"
              onClick={onRename}
              title="Rename group"
              aria-label="Rename group"
            >
              <Pencil size={16} />
            </button>
            <button
              className="icon-btn danger"
              onClick={onDelete}
              title="Delete group"
              aria-label="Delete group"
            >
              <Trash2 size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Detail body */}
      <div style={{ padding: '8px 0' }}>
        {error && (
          <div style={{ padding: '16px 24px' }}>
            <ErrorBanner message={error} />
          </div>
        )}

        {loading ? (
          <FullSpinner label="Loading members..." />
        ) : members.length === 0 && !error ? (
          <div style={{ padding: '40px 20px' }}>
            <EmptyState
              icon={UsersRound}
              title="No members"
              description={
                canManage
                  ? 'Add users to this group to start sharing.'
                  : 'This group has no members yet.'
              }
              panel={false}
            />
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {members.map((gu) => (
              <li
                key={gu.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  padding: '12px 24px',
                  borderBottom: '1px solid var(--panel-border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    minWidth: 0,
                  }}
                >
                  <Avatar
                    src={gu.user?.profile?.avatar?.url?.small ?? null}
                    firstName={gu.user?.profile?.first_name}
                    lastName={gu.user?.profile?.last_name}
                    name={gu.user?.username}
                    size={36}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {userName(gu.user)}
                    </div>
                    {gu.user?.username && (
                      <div
                        style={{
                          fontSize: '13px',
                          color: 'var(--text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {gu.user.username}
                      </div>
                    )}
                  </div>
                </div>
                {gu.is_admin ? (
                  <Badge
                    variant="primary"
                    icon={<ShieldCheck size={12} />}
                    title="Group manager"
                  >
                    Manager
                  </Badge>
                ) : (
                  <Badge variant="muted">Member</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Create group modal (admin only)
// ===========================================================================

function CreateGroupModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (newId: string) => void;
  onError: (m: string) => void;
}) {
  const currentUser = useMemo(() => readCurrentUser(), []);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please enter a group name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // The creator must be a member-manager of a new group (Passbolt rule).
      const created = await groupsService.createGroup({
        name: trimmed,
        groups_users: currentUser
          ? [{ user_id: currentUser.id, is_admin: true }]
          : undefined,
      });
      onCreated(created.id);
    } catch (err) {
      const m = errorMessage(err, 'Failed to create group.');
      setError(m);
      onError(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title="New group"
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Creating...' : 'Create group'}
          </button>
        </>
      }
    >
      {error && (
        <div style={{ marginBottom: '16px' }}>
          <ErrorBanner message={error} />
        </div>
      )}
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label" htmlFor="group-name">
          Group name
        </label>
        <input
          id="group-name"
          className="form-control"
          autoFocus
          value={name}
          placeholder="e.g. Engineering"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          disabled={saving}
        />
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '12px' }}>
        You will be added as the group's first manager. Add more members from the group detail.
      </p>
    </Modal>
  );
}

// ===========================================================================
// Rename group modal
// ===========================================================================

function RenameGroupModal({
  group,
  onClose,
  onRenamed,
  onError,
}: {
  group: Group;
  onClose: () => void;
  onRenamed: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please enter a group name.');
      return;
    }
    if (trimmed === group.name) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await groupsService.updateGroup(group.id, { name: trimmed });
      onRenamed();
    } catch (err) {
      const m = errorMessage(err, 'Failed to rename group.');
      setError(m);
      onError(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title="Rename group"
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </>
      }
    >
      {error && (
        <div style={{ marginBottom: '16px' }}>
          <ErrorBanner message={error} />
        </div>
      )}
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label" htmlFor="rename-group">
          Group name
        </label>
        <input
          id="rename-group"
          className="form-control"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          disabled={saving}
        />
      </div>
    </Modal>
  );
}

// ===========================================================================
// Manage members modal (the re-encryption flow lives here)
// ===========================================================================

function ManageMembersModal({
  group,
  isLocked,
  decrypt,
  encryptFor,
  onClose,
  onSaved,
  onError,
}: {
  group: Group;
  isLocked: boolean;
  decrypt: (armored: string) => Promise<string>;
  encryptFor: (plaintext: string, armoredPublicKeys: string[]) => Promise<string>;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  // Seed the draft from the group's current members.
  const [drafts, setDrafts] = useState<MemberDraft[]>(() =>
    (group.groups_users ?? []).map((gu) => ({
      groupUserId: gu.id,
      user: gu.user ?? ({ id: gu.user_id, username: gu.user_id } as User),
      isAdmin: gu.is_admin,
      markedDelete: false,
      isNew: false,
    })),
  );

  // User picker
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);

  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounced search of the user directory.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const users = await listUsers({ search: q });
        if (!cancelled) setResults(users);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Failed to search users.'));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [search]);

  const draftedUserIds = useMemo(
    () => new Set(drafts.filter((d) => !d.markedDelete).map((d) => d.user.id)),
    [drafts],
  );

  const addMember = (u: User) => {
    setError(null);
    setDrafts((prev) => {
      // Re-adding a member previously marked for deletion just un-marks it.
      const existing = prev.find((d) => d.user.id === u.id);
      if (existing) {
        return prev.map((d) => (d.user.id === u.id ? { ...d, markedDelete: false } : d));
      }
      return [
        ...prev,
        { user: u, isAdmin: false, markedDelete: false, isNew: true },
      ];
    });
    setSearch('');
    setResults([]);
  };

  const toggleManager = (userId: string) => {
    setDrafts((prev) =>
      prev.map((d) => (d.user.id === userId ? { ...d, isAdmin: !d.isAdmin } : d)),
    );
  };

  const removeMember = (userId: string) => {
    setDrafts((prev) =>
      prev
        // New (unsaved) members are dropped entirely; existing ones are marked for delete.
        .filter((d) => !(d.isNew && d.user.id === userId))
        .map((d) => (d.user.id === userId ? { ...d, markedDelete: true } : d)),
    );
  };

  /** Build the groups_users[] change list for the final PUT. */
  const buildChanges = useCallback((): GroupUserChange[] => {
    const changes: GroupUserChange[] = [];
    for (const d of drafts) {
      if (d.isNew) {
        if (d.markedDelete) continue; // added then removed in the same session — noop
        changes.push({ user_id: d.user.id, is_admin: d.isAdmin });
      } else if (d.markedDelete) {
        changes.push({ id: d.groupUserId, user_id: d.user.id, delete: true });
      } else {
        // Existing member — include only when the manager flag changed.
        const original = group.groups_users?.find((gu) => gu.id === d.groupUserId);
        if (original && original.is_admin !== d.isAdmin) {
          changes.push({ id: d.groupUserId, user_id: d.user.id, is_admin: d.isAdmin });
        }
      }
    }
    return changes;
  }, [drafts, group.groups_users]);

  /**
   * Resolve a usable armored PUBLIC key for a (newly added) member, VERIFIED
   * against the server-reported fingerprint. Uses the gpgkey already on the
   * picked user when present, otherwise fetches the full user (contains gpgkey)
   * from the users service. Returns null when no key can be resolved OR the
   * fingerprint does not verify — the caller then refuses to submit, which
   * prevents both silent lockout AND silently encrypting to an attacker-supplied
   * key (the server is untrusted on key distribution in this E2EE model).
   */
  const resolvePublicKey = useCallback(async (userId: string): Promise<string | null> => {
    const draft = drafts.find((d) => d.user.id === userId);
    const who = draft ? userName(draft.user) : userId;

    const verify = async (
      armored: string | undefined | null,
      fingerprint: string | undefined | null,
    ): Promise<string | null> => {
      if (!armored) return null;
      try {
        await verifyArmoredKeyFingerprint(armored, fingerprint, who);
        return armored;
      } catch {
        return null;
      }
    };

    const inline = await verify(draft?.user.gpgkey?.armored_key, draft?.user.gpgkey?.fingerprint);
    if (inline) return inline;
    try {
      const full = await getUser(userId);
      return await verify(full.gpgkey?.armored_key, full.gpgkey?.fingerprint);
    } catch {
      return null;
    }
  }, [drafts]);

  const save = async () => {
    const changes = buildChanges();
    if (changes.length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    setProgress(null);

    try {
      // ---- Step 1: dry-run to discover which secrets must be re-encrypted.
      // (Only relevant when we are ADDING members; removals/flag-flips need no secrets.)
      const addingMembers = changes.some((c) => !c.delete && !c.id);

      const secrets: SecretWrite[] = [];

      if (addingMembers) {
        if (isLocked) {
          throw new Error(
            'Your vault is locked. Unlock with your passphrase before adding members — new members need their secrets re-encrypted.',
          );
        }

        setProgress('Checking which secrets need re-encryption...');
        const dryRun = await groupsService.updateGroupDryRun(group.id, {
          groups_users: changes,
        });

        const needed = dryRun['dry-run']?.SecretsNeeded ?? [];
        const operatorSecrets = dryRun['dry-run']?.Secrets ?? [];

        if (needed.length > 0) {
          // Index the operator's own ciphertext by resource_id for decryption.
          const operatorByResource = new Map<string, string>();
          for (const entry of operatorSecrets) {
            const inner = entry.Secret?.[0];
            if (inner?.resource_id && inner.data) {
              operatorByResource.set(inner.resource_id, inner.data);
            }
          }

          // Cache decrypted plaintexts + resolved recipient keys to avoid rework.
          const plaintextByResource = new Map<string, string>();
          const keyByUser = new Map<string, string | null>();

          // Validate up-front that every needed recipient has a resolvable key.
          const neededUserIds = Array.from(new Set(needed.map((n) => n.Secret.user_id)));
          setProgress('Resolving recipient keys...');
          for (const uid of neededUserIds) {
            const key = await resolvePublicKey(uid);
            keyByUser.set(uid, key);
          }
          const missing = neededUserIds.filter((uid) => !keyByUser.get(uid));
          if (missing.length > 0) {
            const names = missing
              .map((uid) => {
                const d = drafts.find((x) => x.user.id === uid);
                return d ? userName(d.user) : uid;
              })
              .join(', ');
            throw new Error(
              `Cannot add ${names}: no public key is available, so their secrets cannot be encrypted. They must finish account setup first. No changes were made.`,
            );
          }

          setProgress(`Re-encrypting ${needed.length} secret(s) for new members...`);
          for (const item of needed) {
            const { resource_id, user_id } = item.Secret;

            // Decrypt the operator's own secret for this resource (cached).
            let plaintext = plaintextByResource.get(resource_id);
            if (plaintext === undefined) {
              const cipher = operatorByResource.get(resource_id);
              if (!cipher) {
                // Backend said a secret is needed but didn't supply the source
                // ciphertext to decrypt from. We cannot safely synthesize it.
                throw new Error(
                  `The server did not provide your own secret for resource ${resource_id}, so it cannot be re-encrypted for the new member. No changes were made.`,
                );
              }
              plaintext = await decrypt(cipher);
              plaintextByResource.set(resource_id, plaintext);
            }

            const recipientKey = keyByUser.get(user_id);
            if (!recipientKey) {
              // Already validated above; defensive guard.
              throw new Error(
                'A recipient key went missing during encryption. No changes were made.',
              );
            }

            const encrypted = await encryptFor(plaintext, [recipientKey]);
            secrets.push({ resource_id, user_id, data: encrypted });
          }
        }
      }

      // ---- Step 2: commit the membership change + any re-encrypted secrets.
      setProgress('Saving membership...');
      const payload: GroupUpdateRequest = { groups_users: changes };
      if (secrets.length > 0) payload.secrets = secrets;
      await groupsService.updateGroup(group.id, payload);

      onSaved();
    } catch (err) {
      const m = errorMessage(err, 'Failed to update membership.');
      setError(m);
      onError(m);
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const visibleDrafts = drafts.filter((d) => !d.markedDelete);
  const pendingRemovals = drafts.filter((d) => d.markedDelete && !d.isNew);

  return (
    <Modal
      open
      title={`Manage members — ${group.name}`}
      onClose={saving ? () => undefined : onClose}
      maxWidth={560}
      closeOnBackdrop={!saving}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && (
        <div style={{ marginBottom: '16px' }}>
          <ErrorBanner message={error} />
        </div>
      )}

      {saving && progress && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 14px',
            marginBottom: '16px',
            background: 'rgba(0, 112, 243, 0.1)',
            border: '1px solid rgba(0, 112, 243, 0.3)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '13px',
            color: 'var(--primary-hover)',
          }}
        >
          <Spinner size={16} />
          <span>{progress}</span>
        </div>
      )}

      {/* Add-member search */}
      <div className="form-group">
        <label className="form-label" htmlFor="member-search">
          Add a member
        </label>
        <div style={{ position: 'relative' }}>
          <Search
            size={16}
            style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            id="member-search"
            className="form-control"
            style={{ paddingLeft: '36px' }}
            placeholder="Search users by name or username"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={saving}
            autoComplete="off"
          />
        </div>

        {(searching || results.length > 0) && search.trim().length > 0 && (
          <div
            style={{
              marginTop: '8px',
              border: '1px solid var(--panel-border)',
              borderRadius: 'var(--radius-sm)',
              maxHeight: '220px',
              overflowY: 'auto',
              background: 'rgba(0, 0, 0, 0.2)',
            }}
          >
            {searching ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px 14px',
                  color: 'var(--text-muted)',
                  fontSize: '13px',
                }}
              >
                <Spinner size={14} /> Searching...
              </div>
            ) : (
              results.map((u) => {
                const already = draftedUserIds.has(u.id);
                const hasKey = Boolean(u.gpgkey?.armored_key);
                return (
                  <button
                    key={u.id}
                    onClick={() => !already && addMember(u)}
                    disabled={already}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '10px 14px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--panel-border)',
                      color: 'var(--text-primary)',
                      cursor: already ? 'default' : 'pointer',
                      opacity: already ? 0.5 : 1,
                      textAlign: 'left',
                    }}
                  >
                    <Avatar
                      src={u.profile?.avatar?.url?.small ?? null}
                      firstName={u.profile?.first_name}
                      lastName={u.profile?.last_name}
                      name={u.username}
                      size={28}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: '14px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {userName(u)}
                      </span>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {u.username}
                      </span>
                    </span>
                    {already ? (
                      <Badge variant="muted">Added</Badge>
                    ) : !hasKey && !u.active ? (
                      <Badge variant="danger" title="User has not completed setup">
                        No key
                      </Badge>
                    ) : (
                      <Plus size={16} color="var(--text-secondary)" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Current/draft membership */}
      <div style={{ marginTop: '8px' }}>
        <div
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            fontWeight: 500,
            marginBottom: '8px',
          }}
        >
          Members ({visibleDrafts.length})
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {visibleDrafts.map((d) => (
            <li
              key={d.user.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 0',
                borderBottom: '1px solid var(--panel-border)',
              }}
            >
              <Avatar
                src={d.user.profile?.avatar?.url?.small ?? null}
                firstName={d.user.profile?.first_name}
                lastName={d.user.profile?.last_name}
                name={d.user.username}
                size={32}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '14px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {userName(d.user)}
                  {d.isNew && (
                    <span style={{ marginLeft: '8px' }}>
                      <Badge variant="success">New</Badge>
                    </span>
                  )}
                </div>
                {d.user.username && (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {d.user.username}
                  </div>
                )}
              </div>

              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '13px',
                  color: 'var(--text-secondary)',
                  cursor: saving ? 'default' : 'pointer',
                  userSelect: 'none',
                }}
                title="Group managers can edit membership"
              >
                <input
                  type="checkbox"
                  checked={d.isAdmin}
                  onChange={() => toggleManager(d.user.id)}
                  disabled={saving}
                />
                Manager
              </label>

              <button
                className="icon-btn danger"
                style={{ width: 28, height: 28 }}
                onClick={() => removeMember(d.user.id)}
                disabled={saving}
                title="Remove member"
                aria-label={`Remove ${userName(d.user)}`}
              >
                <XIcon size={14} />
              </button>
            </li>
          ))}
        </ul>

        {pendingRemovals.length > 0 && (
          <div style={{ marginTop: '12px', fontSize: '13px', color: 'var(--text-muted)' }}>
            {pendingRemovals.length} member(s) will be removed on save.
          </div>
        )}
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '16px' }}>
        New members automatically receive re-encrypted copies of every secret this group can
        access. You must keep your vault unlocked while saving.
      </p>
    </Modal>
  );
}

// ===========================================================================
// Delete group dialog (sole-owner dry-run guard)
// ===========================================================================

function DeleteGroupDialog({
  group,
  onClose,
  onDeleted,
  onError,
}: {
  group: Group;
  onClose: () => void;
  onDeleted: () => void;
  onError: (m: string) => void;
}) {
  const [checking, setChecking] = useState(true);
  const [blocking, setBlocking] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Run the sole-owner dry-run as soon as the dialog opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setChecking(true);
      setError(null);
      setBlocking(null);
      try {
        await groupsService.deleteGroupDryRun(group.id);
        if (!cancelled) setBlocking([]); // safe to delete
      } catch (err) {
        if (cancelled) return;
        // A 400 typically carries the sole-owner blocking resource list.
        let names: string[] | null = null;
        if (axios.isAxiosError(err) && err.response?.status === 400) {
          const body = err.response?.data as
            | { body?: unknown; header?: { message?: string } }
            | undefined;
          const list = body?.body;
          if (Array.isArray(list)) {
            names = list
              .map((r) => (r as { name?: string })?.name)
              .filter((n): n is string => Boolean(n));
          }
        }
        if (names && names.length > 0) {
          setBlocking(names);
        } else {
          setError(errorMessage(err, 'Cannot delete this group right now.'));
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  const confirmDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await groupsService.deleteGroup(group.id);
      onDeleted();
    } catch (err) {
      const m = errorMessage(err, 'Failed to delete group.');
      setError(m);
      onError(m);
    } finally {
      setDeleting(false);
    }
  };

  const isBlocked = (blocking?.length ?? 0) > 0;
  const canDelete = !checking && !isBlocked && !error;

  return (
    <ConfirmDialog
      open
      danger
      title={`Delete "${group.name}"?`}
      confirmLabel="Delete group"
      loading={deleting}
      onCancel={onClose}
      // When blocked or still checking, the confirm button is a no-op guard.
      onConfirm={canDelete ? confirmDelete : onClose}
      message={
        checking ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <Spinner size={16} /> Checking whether this group can be safely deleted...
          </span>
        ) : isBlocked ? (
          <div>
            <p style={{ marginTop: 0 }}>
              This group cannot be deleted because it is the sole owner of the following
              password(s). Transfer ownership first, then try again:
            </p>
            <ul
              style={{
                margin: '8px 0 0',
                paddingLeft: '18px',
                color: 'var(--danger-color)',
                maxHeight: '160px',
                overflowY: 'auto',
              }}
            >
              {blocking!.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        ) : error ? (
          <ErrorBanner message={error} />
        ) : (
          <span>
            Deleting this group removes it for all members and revokes the access it granted to
            shared passwords. This action cannot be undone.
          </span>
        )
      }
      extra={
        isBlocked ? (
          <button className="btn btn-secondary" style={{ width: '100%' }} onClick={onClose}>
            Close
          </button>
        ) : undefined
      }
    />
  );
}
