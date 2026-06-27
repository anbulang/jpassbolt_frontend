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
import { useTranslation } from 'react-i18next';
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
import { describeApiError } from '../i18n/errors';
import i18n from '../i18n';

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

/**
 * Message for a caught error: a locally-thrown Error (e.g. the re-encryption
 * guards) carries its own already-localized message, so surface it verbatim;
 * anything from the network goes through describeApiError for the
 * unreachable / session-expired / forbidden distinction.
 */
function describeError(err: unknown): string {
  if (!axios.isAxiosError(err) && err instanceof Error && err.message) {
    return err.message;
  }
  return describeApiError(err);
}

/** Best-effort display name for a user (falls back to username). */
function userName(u?: User | null): string {
  if (!u) return i18n.t('directory:groups.unknownUser');
  const full = [u.profile?.first_name, u.profile?.last_name].filter(Boolean).join(' ');
  return full || u.username || i18n.t('directory:groups.unknownUser');
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
  const { t } = useTranslation('directory');
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
      setListError(describeApiError(err));
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
      setDetailError(describeApiError(err));
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
          <FullSpinner label={t('groups.loadingGroups')} />
        ) : groups.length === 0 && !listError ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="ico">
              <UsersRound />
            </div>
            <h3>{t('groups.emptyList.title')}</h3>
            <p>
              {isAdmin
                ? t('groups.emptyList.descAdmin')
                : t('groups.emptyList.descMember')}
            </p>
            {isAdmin && (
              <button className="btn primary" onClick={() => setCreateOpen(true)}>
                <Plus /> {t('groups.newGroup')}
              </button>
            )}
          </div>
        ) : (
          <div className="glayout">
            {/* Master list */}
            <div className="glist">
              <div className="glist-head">
                <h3>{t('groups.list.heading', { count: groups.length })}</h3>
                {isAdmin && (
                  <button className="btn sm primary" onClick={() => setCreateOpen(true)}>
                    <Plus /> {t('groups.list.new')}
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
                          {count !== undefined
                            ? t('groups.list.memberCount', { count })
                            : t('groups.list.members')}
                        </div>
                      </div>
                      {manages && (
                        <span className="admin-badge" title={t('groups.list.managerTitle')}>
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
                  <h3>{t('groups.selectPrompt.title')}</h3>
                  <p>{t('groups.selectPrompt.desc')}</p>
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
            toast.success(t('groups.toast.created'));
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
            toast.success(t('groups.toast.renamed'));
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
            toast.success(t('groups.toast.membersUpdated'));
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
            toast.success(t('groups.toast.deleted'));
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
  const { t } = useTranslation('directory');
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
              <UsersRound /> {t('groups.detail.memberCount', { count: members.length })}
            </span>
            {canManage && (
              <span className="chip green">
                <ShieldCheck /> {t('groups.detail.youAreManager')}
              </span>
            )}
          </div>
        </div>

        {canManage && (
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              className="btn primary"
              onClick={onManage}
              title={t('groups.detail.manageTitle')}
            >
              <UserPlus /> {t('groups.detail.members')}
            </button>
            <button
              className="iconbtn"
              onClick={onRename}
              title={t('groups.detail.renameTitle')}
              aria-label={t('groups.detail.renameAria')}
            >
              <Pencil />
            </button>
            <button
              className="iconbtn"
              onClick={onDelete}
              title={t('groups.detail.deleteTitle')}
              aria-label={t('groups.detail.deleteAria')}
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
        <FullSpinner label={t('groups.detail.loadingMembers')} />
      ) : members.length === 0 && !error ? (
        <div className="empty" style={{ padding: '48px 20px' }}>
          <div className="ico">
            <UsersRound />
          </div>
          <h3>{t('groups.detail.emptyTitle')}</h3>
          <p>{canManage ? t('groups.detail.emptyDescManage') : t('groups.detail.emptyDescMember')}</p>
        </div>
      ) : (
        <div className="gd-section">
          <h4>
            {t('groups.detail.membersHeading')} <span className="ct">{members.length}</span>
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
                    <span className="admin-badge" title={t('groups.detail.managerBadge')}>
                      <ShieldCheck /> {t('groups.detail.managerBadge')}
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
  const { t } = useTranslation('directory');
  const currentUser = useMemo(() => readCurrentUser(), []);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('groups.form.nameRequired'));
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
      const m = describeApiError(err);
      setError(m);
      onError(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t('groups.createModal.title')}
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? t('groups.createModal.creating') : t('groups.createModal.create')}
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
          {t('groups.createModal.nameLabel')}
        </label>
        <input
          id="group-name"
          className="form-control"
          autoFocus
          value={name}
          placeholder={t('groups.createModal.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          disabled={saving}
        />
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: '13px', marginTop: '12px' }}>
        {t('groups.createModal.hint')}
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
  const { t } = useTranslation('directory');
  const [name, setName] = useState(group.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('groups.form.nameRequired'));
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
      const m = describeApiError(err);
      setError(m);
      onError(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={t('groups.renameModal.title')}
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? t('groups.renameModal.saving') : t('common:actions.save')}
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
          {t('groups.renameModal.nameLabel')}
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
  const { t } = useTranslation('directory');
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
        if (!cancelled) setError(describeApiError(err));
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
          throw new Error(t('groups.error.vaultLocked'));
        }

        setProgress(t('groups.progress.checkingSecrets'));
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
          setProgress(t('groups.progress.resolvingKeys'));
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
            throw new Error(t('groups.error.cannotAddMembers', { names }));
          }

          setProgress(t('groups.progress.reencrypting', { count: needed.length }));
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
                  t('groups.error.missingOperatorSecret', { resourceId: resource_id }),
                );
              }
              plaintext = await decrypt(cipher);
              plaintextByResource.set(resource_id, plaintext);
            }

            const recipientKey = keyByUser.get(user_id);
            if (!recipientKey) {
              // Already validated above; defensive guard.
              throw new Error(t('groups.error.recipientKeyMissing'));
            }

            const encrypted = await encryptFor(plaintext, [recipientKey]);
            secrets.push({ resource_id, user_id, data: encrypted });
          }
        }
      }

      // ---- Step 2: commit the membership change + any re-encrypted secrets.
      setProgress(t('groups.progress.savingMembership'));
      const payload: GroupUpdateRequest = { groups_users: changes };
      if (secrets.length > 0) payload.secrets = secrets;
      await groupsService.updateGroup(group.id, payload);

      onSaved();
    } catch (err) {
      const m = describeError(err);
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
      title={t('groups.manageModal.title', { name: group.name })}
      onClose={saving ? () => undefined : onClose}
      maxWidth={560}
      closeOnBackdrop={!saving}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? t('groups.manageModal.saving') : t('groups.manageModal.saveChanges')}
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
            <b>{t('groups.manageModal.reencrypting')}</b>
            <div className="s">{t('groups.manageModal.reencryptHint', { progress })}</div>
          </div>
        </div>
      )}

      {/* Add-member search */}
      <div className="form-group">
        <label className="form-label" htmlFor="member-search">
          {t('groups.manageModal.addMember')}
        </label>
        <div className="searchbox">
          <Search />
          <input
            id="member-search"
            placeholder={t('groups.manageModal.searchPlaceholder')}
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
                <Spinner size={14} /> {t('groups.manageModal.searching')}
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
                      <Badge variant="muted">{t('groups.manageModal.added')}</Badge>
                    ) : !hasKey && !u.active ? (
                      <Badge variant="danger" title={t('groups.manageModal.noKeyTitle')}>
                        {t('groups.manageModal.noKey')}
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
          {t('groups.manageModal.membersCount', { count: visibleDrafts.length })}
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
                      <Badge variant="success">{t('groups.manageModal.new')}</Badge>
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
                  title={t('groups.manageModal.managerLabelTitle')}
                >
                  <input
                    type="checkbox"
                    checked={d.isAdmin}
                    onChange={() => toggleManager(d.user.id)}
                    disabled={saving}
                  />
                  {t('groups.manageModal.manager')}
                </label>

                <button
                  className="rowmenu"
                  onClick={() => removeMember(d.user.id)}
                  disabled={saving}
                  title={t('groups.manageModal.removeTitle')}
                  aria-label={t('groups.manageModal.removeAria', { name: userName(d.user) })}
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
            {t('groups.manageModal.pendingRemovals', { count: pendingRemovals.length })}
          </div>
        )}
      </div>

      <p style={{ color: 'var(--text-3)', fontSize: '12px', marginTop: '16px' }}>
        {t('groups.manageModal.footnote')}
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
  const { t } = useTranslation('directory');
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
          setError(describeApiError(err));
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
      const m = describeApiError(err);
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
      title={t('groups.deleteDialog.title', { name: group.name })}
      confirmLabel={t('groups.deleteDialog.confirm')}
      loading={deleting}
      onCancel={onClose}
      // When blocked or still checking, the confirm button is a no-op guard.
      onConfirm={canDelete ? confirmDelete : onClose}
      message={
        checking ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <Spinner size={16} /> {t('groups.deleteDialog.checking')}
          </span>
        ) : isBlocked ? (
          <div>
            <p style={{ marginTop: 0 }}>
              {t('groups.deleteDialog.blockedIntro')}
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
            {t('groups.deleteDialog.warning')}
          </span>
        )
      }
      extra={
        isBlocked ? (
          <button className="btn btn-secondary" style={{ width: '100%' }} onClick={onClose}>
            {t('common:actions.close')}
          </button>
        ) : undefined
      }
    />
  );
}
