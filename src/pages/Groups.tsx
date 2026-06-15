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

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="warnbox" role="alert">
      <AlertTriangle />
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
      <div className="page">
        {listError && (
          <div style={{ padding: '16px 28px 0' }}>
            <ErrorBanner message={listError} />
          </div>
        )}

        {listLoading ? (
          <FullSpinner label="正在加载群组…" />
        ) : groups.length === 0 && !listError ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="ico">
              <UsersRound />
            </div>
            <h3>还没有任何群组</h3>
            <p>
              {isAdmin
                ? '创建一个群组，即可一次性把密码共享给一组用户。'
                : '你还不是任何群组的成员。'}
            </p>
            {isAdmin && (
              <button className="btn primary" onClick={() => setCreateOpen(true)}>
                <Plus /> 新建群组
              </button>
            )}
          </div>
        ) : (
          <div className="glayout">
            {/* Master list */}
            <div className="glist">
              <div className="glist-head">
                <h3>群组 · {groups.length}</h3>
                {isAdmin && (
                  <button className="btn sm primary" onClick={() => setCreateOpen(true)}>
                    <Plus /> 新建
                  </button>
                )}
              </div>
              <div className="glist-scroll">
                {groups.map((g) => {
                  const active = g.id === selectedId;
                  const count = g.groups_users?.length ?? g.user_count;
                  const manages = isAdmin || Boolean(g.my_group_user?.is_admin);
                  return (
                    <button
                      key={g.id}
                      className={'gcard' + (active ? ' active' : '')}
                      onClick={() => setSelectedId(g.id)}
                    >
                      <Avatar name={g.name} size={38} />
                      <div className="gc-info">
                        <div className="gn">{g.name}</div>
                        <div className="gm">
                          {count !== undefined ? `${count} 名成员` : '成员'}
                        </div>
                      </div>
                      {manages && (
                        <span className="admin-badge" title="你是群管理员">
                          <ShieldCheck />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Detail */}
            <div className="gdetail">
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
                <div className="empty" style={{ flex: 1 }}>
                  <div className="ico">
                    <UsersRound />
                  </div>
                  <h3>选择一个群组</h3>
                  <p>在左侧挑选一个群组以查看其成员。</p>
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
            toast.success('群组已创建。');
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
            toast.success('群组已重命名。');
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
            toast.success('成员已更新。');
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
            toast.success('群组已删除。');
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
    <>
      {/* Detail header */}
      <div className="gd-head">
        <div className="gd-ico" style={{ background: 'var(--accent)' }}>
          <UsersRound />
        </div>
        <div className="gd-t">
          <h2>{group.name}</h2>
          <p>&nbsp;</p>
          <div className="gd-meta">
            <span className="chip neutral">
              <UsersRound /> {members.length} 名成员
            </span>
            {canManage && (
              <span className="chip green">
                <ShieldCheck /> 你是群管理员
              </span>
            )}
          </div>
        </div>

        {canManage && (
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              className="btn primary"
              onClick={onManage}
              title="添加或移除成员"
            >
              <UserPlus /> 成员
            </button>
            <button
              className="iconbtn"
              onClick={onRename}
              title="重命名群组"
              aria-label="重命名群组"
            >
              <Pencil />
            </button>
            <button
              className="iconbtn"
              onClick={onDelete}
              title="删除群组"
              aria-label="删除群组"
              style={{ color: 'var(--red-text)' }}
            >
              <Trash2 />
            </button>
          </div>
        )}
      </div>

      {/* Detail body */}
      {error && (
        <div style={{ padding: '16px 28px 0' }}>
          <ErrorBanner message={error} />
        </div>
      )}

      {loading ? (
        <FullSpinner label="正在加载成员…" />
      ) : members.length === 0 && !error ? (
        <div className="empty" style={{ padding: '48px 20px' }}>
          <div className="ico">
            <UsersRound />
          </div>
          <h3>暂无成员</h3>
          <p>{canManage ? '为该群组添加用户即可开始共享。' : '该群组还没有任何成员。'}</p>
        </div>
      ) : (
        <div className="gd-section">
          <h4>
            成员 <span className="ct">{members.length}</span>
            <span className="h4-spacer" />
          </h4>
          {members.map((gu) => (
            <div className="member-row" key={gu.id}>
              <Avatar
                src={gu.user?.profile?.avatar?.url?.small ?? null}
                firstName={gu.user?.profile?.first_name}
                lastName={gu.user?.profile?.last_name}
                name={gu.user?.username}
                size={38}
              />
              <div className="mr-info">
                <div className="mn">
                  {userName(gu.user)}
                  {gu.is_admin && (
                    <span className="admin-badge" title="群管理员">
                      <ShieldCheck /> 群管理员
                    </span>
                  )}
                </div>
                {gu.user?.username && <div className="me">{gu.user.username}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
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
      title="新建群组"
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? '正在创建…' : '创建群组'}
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
          群组名称
        </label>
        <input
          id="group-name"
          className="form-control"
          autoFocus
          value={name}
          placeholder="例如：工程团队"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          disabled={saving}
        />
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: '13px', marginTop: '12px' }}>
        你将作为该群组的首位管理员。可在群组详情中继续添加更多成员。
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
      title="重命名群组"
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? '正在保存…' : '保存'}
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
          群组名称
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
      title={`管理成员 · ${group.name}`}
      onClose={saving ? () => undefined : onClose}
      maxWidth={560}
      closeOnBackdrop={!saving}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? '正在保存…' : '保存更改'}
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
        <div className="reencrypt-banner" style={{ margin: '0 0 16px' }}>
          <Spinner size={16} />
          <div className="rb-text">
            <b>正在为新成员重新加密群密文…</b>
            <div className="s">{progress} · 私钥永不离开各自设备</div>
          </div>
        </div>
      )}

      {/* Add-member search */}
      <div className="form-group">
        <label className="form-label" htmlFor="member-search">
          添加成员
        </label>
        <div className="searchbox">
          <Search />
          <input
            id="member-search"
            placeholder="按姓名或用户名搜索用户"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={saving}
            autoComplete="off"
          />
        </div>

        {(searching || results.length > 0) && search.trim().length > 0 && (
          <div className="pick-target" style={{ marginTop: 8 }}>
            {searching ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px 11px',
                  color: 'var(--text-3)',
                  fontSize: '13px',
                }}
              >
                <Spinner size={14} /> 正在搜索…
              </div>
            ) : (
              results.map((u) => {
                const already = draftedUserIds.has(u.id);
                const hasKey = Boolean(u.gpgkey?.armored_key);
                return (
                  <button
                    key={u.id}
                    className="pick-opt"
                    onClick={() => !already && addMember(u)}
                    disabled={already}
                    style={{
                      cursor: already ? 'default' : 'pointer',
                      opacity: already ? 0.5 : 1,
                    }}
                  >
                    <Avatar
                      src={u.profile?.avatar?.url?.small ?? null}
                      firstName={u.profile?.first_name}
                      lastName={u.profile?.last_name}
                      name={u.username}
                      size={32}
                    />
                    <div className="aro-info">
                      <div className="an">{userName(u)}</div>
                      <div className="ae">{u.username}</div>
                    </div>
                    {already ? (
                      <Badge variant="muted">已添加</Badge>
                    ) : !hasKey && !u.active ? (
                      <Badge variant="danger" title="该用户尚未完成账户设置">
                        无密钥
                      </Badge>
                    ) : (
                      <span className="add" style={{ color: 'var(--accent-text)', display: 'inline-flex' }}>
                        <Plus size={16} />
                      </span>
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
            color: 'var(--text-2)',
            fontWeight: 500,
            marginBottom: '8px',
          }}
        >
          成员（{visibleDrafts.length}）
        </div>
        <div>
          {visibleDrafts.map((d) => (
            <div className="member-row" key={d.user.id}>
              <Avatar
                src={d.user.profile?.avatar?.url?.small ?? null}
                firstName={d.user.profile?.first_name}
                lastName={d.user.profile?.last_name}
                name={d.user.username}
                size={32}
              />
              <div className="mr-info">
                <div className="mn">
                  {userName(d.user)}
                  {d.isNew && (
                    <span style={{ marginLeft: '4px' }}>
                      <Badge variant="success">新增</Badge>
                    </span>
                  )}
                </div>
                {d.user.username && <div className="me">{d.user.username}</div>}
              </div>

              <div className="mr-actions">
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '13px',
                    color: 'var(--text-2)',
                    cursor: saving ? 'default' : 'pointer',
                    userSelect: 'none',
                  }}
                  title="群管理员可编辑成员"
                >
                  <input
                    type="checkbox"
                    checked={d.isAdmin}
                    onChange={() => toggleManager(d.user.id)}
                    disabled={saving}
                  />
                  管理员
                </label>

                <button
                  className="rowmenu"
                  onClick={() => removeMember(d.user.id)}
                  disabled={saving}
                  title="移除成员"
                  aria-label={`移除 ${userName(d.user)}`}
                  style={{ color: 'var(--text-3)' }}
                >
                  <XIcon size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {pendingRemovals.length > 0 && (
          <div style={{ marginTop: '12px', fontSize: '13px', color: 'var(--text-3)' }}>
            保存后将移除 {pendingRemovals.length} 名成员。
          </div>
        )}
      </div>

      <p style={{ color: 'var(--text-3)', fontSize: '12px', marginTop: '16px' }}>
        新成员会自动收到该群组可访问的每一份密文的重新加密副本。保存期间请保持密钥库解锁状态。
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
      title={`删除「${group.name}」？`}
      confirmLabel="删除群组"
      loading={deleting}
      onCancel={onClose}
      // When blocked or still checking, the confirm button is a no-op guard.
      onConfirm={canDelete ? confirmDelete : onClose}
      message={
        checking ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <Spinner size={16} /> 正在检查该群组能否安全删除…
          </span>
        ) : isBlocked ? (
          <div>
            <p style={{ marginTop: 0 }}>
              无法删除该群组，因为它是以下密码的唯一所有者。请先转移所有权后再试：
            </p>
            <ul
              style={{
                margin: '8px 0 0',
                paddingLeft: '18px',
                color: 'var(--red-text)',
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
            删除该群组会对所有成员移除它，并撤销它所授予的共享密码访问权。此操作不可撤销。
          </span>
        )
      }
      extra={
        isBlocked ? (
          <button className="btn btn-secondary" style={{ width: '100%' }} onClick={onClose}>
            关闭
          </button>
        ) : undefined
      }
    />
  );
}
