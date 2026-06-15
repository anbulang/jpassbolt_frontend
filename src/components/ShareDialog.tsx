/**
 * ShareDialog (smart component).
 *
 * Modal to share a single resource with users and groups. Flow:
 *   1. On open, LOAD the resource's current ACL itself via
 *      GET /permissions/resource/{id}.json (contain[user]/[user.profile]/[group]),
 *      so the draft starts from the real, human-readable access list — the
 *      caller (e.g. the Vault page) only needs to pass the resource. Embedded
 *      user/group display data is used directly; any ARO the endpoint could not
 *      embed is resolved via the users / groups service as a fallback. A caller
 *      MAY still pass `existingPermissions` to seed synchronously and skip the
 *      fetch (e.g. when it already holds them).
 *   2. Search AROs (users + groups) via GET /share/search-aros.json with a
 *      debounced query; clicking an ARO adds a draft row with a permission level
 *      (READ=1 / UPDATE=7 / OWNER=15).
 *   3. "Simulate" calls POST /share/simulate/resource/{id}.json and renders an
 *      informational preview of users that would be added / removed.
 *   4. "Apply": for every NEWLY ADDED user-type ARO, and every member of every
 *      NEWLY ADDED group-type ARO, re-encrypt the resource secret ONCE per
 *      recipient with THAT recipient's armored public key, then
 *      PUT /share/resource/{id}.json { permissions[], secrets[] }.
 *
 * E2EE CORRECTNESS INVARIANT (hard requirement):
 *   A recipient added to `permissions` MUST be matched by a `secret` encrypted
 *   with THAT recipient's own public key — never the owner's. The apply handler
 *   refuses to submit (and surfaces an error banner) if any added recipient
 *   lacks a resolvable public key, preventing silent lockout.
 *
 * This component OWNS ONLY this file. It imports everything else from the
 * foundation (types, services, KeyContext, shared components).
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import {
    AlertTriangle,
    Lock as LockIcon,
    Plus,
    RefreshCw,
    Search,
    Users as UsersIcon,
    X as XIcon,
} from 'lucide-react';

import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { Badge } from './Badge';
import { Avatar } from './Avatar';
import { useToast } from './toastContext';
import { useKey } from '../crypto/KeyContext';

import { searchAros, applyShare, simulateShare } from '../services/share';
import { getResourcePermissions } from '../services/permissions';
import { getSecretForResource } from '../services/secrets';
import { getUser } from '../services/users';
import { getGroup } from '../services/groups';
import { verifyArmoredKeyFingerprint } from '../gpg';

import {
    PERMISSION,
    isUserAro,
    type Aro,
    type Group,
    type Permission,
    type PermissionType,
    type PermissionWithAro,
    type Resource,
    type SecretWrite,
    type SharePermissionItem,
    type ShareSimulateResult,
    type User,
} from '../types';

// ---------------------------------------------------------------------------
// Props
//
// Supports both the named-prop shape from the task brief
// ({ resource, open, onClose, onShared }) AND the foundation stub's
// ({ resourceId, open, onClose(didChange?) }) shape so callers (the Vault page)
// can wire it either way without editing this file.
// ---------------------------------------------------------------------------
export interface ShareDialogProps {
    /** Whether the dialog is open. */
    open: boolean;
    /** The resource to share. Provide this OR `resourceId`. */
    resource?: Resource | null;
    /** The id of the resource to share. Provide this OR `resource`. */
    resourceId?: string;
    /**
     * Existing permissions for the resource, if the caller already loaded them
     * (e.g. resource.permissions). OPTIONAL — when provided, the dialog seeds
     * synchronously from these and SKIPS its own fetch; when omitted (the
     * preferred path), the dialog fetches the full ACL itself via
     * GET /permissions/resource/{id}.json on open. Pass either a plain
     * `Permission[]` or the enriched `PermissionWithAro[]` (embedded user/group
     * display objects are used when present).
     */
    existingPermissions?: Permission[] | PermissionWithAro[];
    /** Close handler. Receives whether a share was actually applied. */
    onClose: (didChange?: boolean) => void;
    /** Called after a successful share (in addition to onClose(true)). */
    onShared?: () => void;
}

// ---------------------------------------------------------------------------
// Internal draft model
// ---------------------------------------------------------------------------
interface DraftRow {
    /** Existing permission id (present only for already-shared AROs). */
    permissionId?: string;
    aro: 'User' | 'Group';
    aroForeignKey: string;
    type: PermissionType;
    /**
     * The permission level this existing row started with (undefined for rows
     * added in this session). Used to detect a level-only change so Apply is
     * enabled and the changed level is actually sent.
     */
    originalType?: PermissionType;
    /** True for AROs added in this session (need a re-encrypted secret on apply). */
    isNew: boolean;
    /** Marked for removal. */
    deleted: boolean;
    /** Display data. */
    label: string;
    sublabel?: string;
    avatarSrc?: string | null;
    firstName?: string | null;
    lastName?: string | null;
}

const DEBOUNCE_MS = 300;

const PERMISSION_OPTIONS: { value: PermissionType; label: string }[] = [
    { value: PERMISSION.READ, label: '只读' },
    { value: PERMISSION.UPDATE, label: '可编辑' },
    { value: PERMISSION.OWNER, label: '拥有者' },
];

function errMessage(err: unknown, fallback: string): string {
    if (err && typeof err === 'object' && 'response' in err) {
        // Axios error — prefer the Passbolt envelope message.
        const resp = (err as { response?: { data?: { header?: { message?: string } } } }).response;
        const msg = resp?.data?.header?.message;
        if (msg) return msg;
    }
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return fallback;
}

function aroDisplay(aro: Aro): { label: string; sublabel?: string } {
    if (isUserAro(aro)) {
        const p = aro.profile;
        const full = p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : '';
        return { label: full || aro.username, sublabel: aro.username };
    }
    const group = aro as Group;
    const count = group.user_count;
    return {
        label: group.name,
        sublabel: typeof count === 'number' ? `${count} 名成员` : '群组',
    };
}

/**
 * Build a seeded DraftRow from a permission row, using the ARO display objects
 * the permissions endpoint embedded when available (no extra round-trip), and
 * falling back to a UUID placeholder otherwise (the resolver effect replaces it
 * with a name). Always marked isNew:false / deleted:false — it's existing ACL.
 */
function seedRowFromPermission(p: Permission | PermissionWithAro): DraftRow {
    const embedded = p as PermissionWithAro;
    const base: DraftRow = {
        permissionId: p.id,
        aro: p.aro,
        aroForeignKey: p.aro_foreign_key,
        type: p.type,
        originalType: p.type,
        isNew: false,
        deleted: false,
        // Default to the UUID as a placeholder; replaced below if we have an
        // embedded object, or later by the resolver effect (never show raw UUIDs).
        label: p.aro_foreign_key,
        sublabel: p.aro === 'Group' ? '群组' : '用户',
    };

    if (p.aro === 'User' && embedded.user) {
        const { label, sublabel } = aroDisplay(embedded.user);
        const profile = embedded.user.profile;
        return {
            ...base,
            label,
            sublabel,
            avatarSrc: profile?.avatar?.url?.small ?? null,
            firstName: profile?.first_name ?? null,
            lastName: profile?.last_name ?? null,
        };
    }
    if (p.aro === 'Group' && embedded.group) {
        return { ...base, label: embedded.group.name, sublabel: '群组' };
    }
    return base;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function ShareDialog({
    open,
    resource,
    resourceId: resourceIdProp,
    existingPermissions,
    onClose,
    onShared,
}: ShareDialogProps) {
    const toast = useToast();
    const { isLocked, decrypt, encryptFor } = useKey();

    const resourceId = resource?.id ?? resourceIdProp ?? '';
    const resourceName = resource?.name;

    // --- search state ---
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [results, setResults] = useState<Aro[]>([]);

    // --- draft permission state ---
    const [rows, setRows] = useState<DraftRow[]>([]);
    // Loading / error state for the initial ACL fetch (when the dialog loads its
    // own permissions rather than receiving them via existingPermissions).
    const [loadingPermissions, setLoadingPermissions] = useState(false);
    const [permissionsError, setPermissionsError] = useState<string | null>(null);

    // --- simulate state ---
    const [simulating, setSimulating] = useState(false);
    const [simulation, setSimulation] = useState<ShareSimulateResult | null>(null);
    // userId -> display name, so the simulate preview shows names not truncated UUIDs.
    const [aroNames, setAroNames] = useState<Record<string, string>>({});

    // --- apply state ---
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);

    const searchSeq = useRef(0);

    // -----------------------------------------------------------------------
    // Reset everything when (re)opened, then seed the current ACL.
    //
    // Preferred path (caller passes only the resource): fetch the full ACL
    // ourselves via GET /permissions/resource/{id}.json with the user/group
    // contains, so we DISPLAY who already has access with human-readable names
    // and avatars straight from the embedded objects — no per-ARO round-trip in
    // the common case. Fallback: a caller MAY pass `existingPermissions` to seed
    // synchronously and skip the fetch entirely.
    //
    // Any ARO the endpoint could not embed (e.g. soft-deleted group, or a caller
    // that passed bare Permission[]) keeps a UUID placeholder that the resolver
    // effect below replaces with a name.
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!open) return;
        setQuery('');
        setResults([]);
        setSearchError(null);
        setSimulation(null);
        setApplyError(null);
        setSimulating(false);
        setApplying(false);
        setAroNames({});
        setPermissionsError(null);

        // Caller pre-loaded the ACL: seed synchronously and skip the fetch.
        if (existingPermissions) {
            setLoadingPermissions(false);
            setRows(existingPermissions.map(seedRowFromPermission));
            return;
        }

        // No id to fetch against: nothing to load (only additions are possible).
        if (!resourceId) {
            setLoadingPermissions(false);
            setRows([]);
            return;
        }

        // Fetch the full ACL ourselves.
        let cancelled = false;
        setLoadingPermissions(true);
        setRows([]);
        (async () => {
            try {
                const perms = await getResourcePermissions(resourceId, {
                    containUser: true,
                    containUserProfile: true,
                    containGroup: true,
                });
                if (cancelled) return;
                setRows(perms.map(seedRowFromPermission));
                setPermissionsError(null);
            } catch (err: unknown) {
                if (cancelled) return;
                // Don't block sharing if the ACL couldn't be read — the user can
                // still add people; we just couldn't show the current access.
                setPermissionsError(
                    errMessage(err, '无法加载该资源的当前访问列表。'),
                );
                setRows([]);
            } finally {
                if (!cancelled) setLoadingPermissions(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // Re-seed whenever the dialog opens for a (possibly) different resource or
        // a caller swaps in a different pre-loaded permission set.
    }, [open, resourceId, existingPermissions]);

    // -----------------------------------------------------------------------
    // Resolve human-readable names for any seeded existing-permission rows whose
    // label is still the raw aro_foreign_key UUID (i.e. the permissions endpoint
    // could not embed the ARO, or a caller passed bare Permission[]). Rows whose
    // names came from embedded objects are already resolved and skipped.
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!open) return;
        if (loadingPermissions) return; // wait for the ACL fetch to settle first
        const unresolved = rows.filter(
            (r) => !r.isNew && r.label === r.aroForeignKey,
        );
        if (unresolved.length === 0) return;
        let cancelled = false;
        (async () => {
            const resolved = new Map<string, { label: string; sublabel?: string }>();
            await Promise.all(
                unresolved.map(async (r) => {
                    try {
                        if (r.aro === 'User') {
                            const u = await getUser(r.aroForeignKey);
                            resolved.set(r.aroForeignKey, aroDisplay(u));
                        } else {
                            const g = await getGroup(r.aroForeignKey);
                            resolved.set(r.aroForeignKey, aroDisplay(g));
                        }
                    } catch {
                        // Leave the placeholder UUID if the lookup fails.
                    }
                }),
            );
            if (cancelled || resolved.size === 0) return;
            setRows((prev) =>
                prev.map((r) => {
                    const r2 = resolved.get(r.aroForeignKey);
                    return r2 && r.label === r.aroForeignKey
                        ? { ...r, label: r2.label, sublabel: r2.sublabel ?? r.sublabel }
                        : r;
                }),
            );
        })();
        return () => {
            cancelled = true;
        };
        // Runs after seeding settles; the guard (`label === aroForeignKey`)
        // prevents redundant work as the user edits rows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, loadingPermissions]);

    // -----------------------------------------------------------------------
    // Debounced ARO search.
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!open) return;
        const q = query.trim();
        if (q.length === 0) {
            setResults([]);
            setSearching(false);
            setSearchError(null);
            return;
        }
        setSearching(true);
        const seq = ++searchSeq.current;
        const handle = window.setTimeout(async () => {
            try {
                // Ask the backend to include each user's gpgkey so we can resolve
                // recipient public keys without an extra round-trip in the common case.
                const aros = await searchAros({ search: q, containGpgkey: true });
                if (seq !== searchSeq.current) return; // stale
                setResults(aros);
                setSearchError(null);
            } catch (err: unknown) {
                if (seq !== searchSeq.current) return;
                setSearchError(errMessage(err, '搜索失败，请重试。'));
                setResults([]);
            } finally {
                if (seq === searchSeq.current) setSearching(false);
            }
        }, DEBOUNCE_MS);
        return () => window.clearTimeout(handle);
    }, [query, open]);

    // -----------------------------------------------------------------------
    // Add an ARO from the search results to the draft.
    // -----------------------------------------------------------------------
    const addAro = useCallback((aro: Aro) => {
        const isUser = isUserAro(aro);
        const aroType: 'User' | 'Group' = isUser ? 'User' : 'Group';
        const aroForeignKey = aro.id;
        const { label, sublabel } = aroDisplay(aro);

        setRows((prev) => {
            // If it already exists in the draft, un-delete / focus it instead of duplicating.
            const idx = prev.findIndex((r) => r.aroForeignKey === aroForeignKey && r.aro === aroType);
            if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], deleted: false };
                return copy;
            }
            const profile = isUser ? (aro as User).profile : null;
            const next: DraftRow = {
                aro: aroType,
                aroForeignKey,
                type: PERMISSION.READ,
                isNew: true,
                deleted: false,
                label,
                sublabel,
                avatarSrc: profile?.avatar?.url?.small ?? null,
                firstName: profile?.first_name ?? null,
                lastName: profile?.last_name ?? null,
            };
            return [...prev, next];
        });
        setSimulation(null);
        setApplyError(null);
        setQuery('');
        setResults([]);
    }, []);

    const changeRowType = useCallback((idx: number, type: PermissionType) => {
        setRows((prev) => {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], type };
            return copy;
        });
        setSimulation(null);
    }, []);

    const removeRow = useCallback((idx: number) => {
        setRows((prev) => {
            const row = prev[idx];
            if (row.isNew && !row.permissionId) {
                // Never persisted — just drop it from the draft.
                return prev.filter((_, i) => i !== idx);
            }
            const copy = [...prev];
            copy[idx] = { ...copy[idx], deleted: true };
            return copy;
        });
        setSimulation(null);
    }, []);

    const undoRemove = useCallback((idx: number) => {
        setRows((prev) => {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], deleted: false };
            return copy;
        });
        setSimulation(null);
    }, []);

    // -----------------------------------------------------------------------
    // Build the SharePermissionItem[] payload from the draft.
    // -----------------------------------------------------------------------
    const buildPermissions = useCallback((): SharePermissionItem[] => {
        const items: SharePermissionItem[] = [];
        for (const row of rows) {
            if (row.isNew && !row.permissionId) {
                if (row.deleted) continue; // added then removed — no-op
                items.push({
                    aro: row.aro,
                    aro_foreign_key: row.aroForeignKey,
                    type: row.type,
                    is_new: true,
                });
            } else if (row.permissionId) {
                if (row.deleted) {
                    // Removal: id + delete flag (no re-encryption needed).
                    items.push({ id: row.permissionId, delete: true });
                } else if (row.originalType === undefined || row.type !== row.originalType) {
                    // Level change on an existing permission: id + the new type
                    // (lowering/raising a level needs no re-encryption). Unchanged
                    // existing permissions are intentionally omitted so the payload
                    // expresses only real changes (added / changed / removed).
                    items.push({
                        id: row.permissionId,
                        aro: row.aro,
                        aro_foreign_key: row.aroForeignKey,
                        type: row.type,
                    });
                }
            }
        }
        return items;
    }, [rows]);

    // The AROs that are genuinely newly added (need re-encrypted secrets).
    const newlyAdded = useMemo(
        () => rows.filter((r) => r.isNew && !r.permissionId && !r.deleted),
        [rows],
    );

    const hasChanges = useMemo(() => {
        return rows.some(
            (r) =>
                // a newly added ARO that is still present
                (r.isNew && !r.deleted) ||
                // an existing permission marked for removal
                (r.permissionId && r.deleted) ||
                // an existing permission whose level was changed
                (r.permissionId && !r.deleted && r.originalType !== undefined && r.type !== r.originalType),
        );
    }, [rows]);

    // -----------------------------------------------------------------------
    // Simulate.
    // -----------------------------------------------------------------------
    const handleSimulate = useCallback(async () => {
        if (!resourceId) return;
        setSimulating(true);
        setApplyError(null);
        try {
            const perms = buildPermissions();
            const result = await simulateShare(resourceId, perms);
            setSimulation(result);
        } catch (err: unknown) {
            setApplyError(errMessage(err, '模拟失败。'));
            setSimulation(null);
        } finally {
            setSimulating(false);
        }
    }, [resourceId, buildPermissions]);

    // -----------------------------------------------------------------------
    // Resolve display names for the user ids referenced by a simulation result,
    // so the preview shows names instead of truncated UUIDs. Seeds from draft
    // rows we already have names for, then fetches any remaining ids once.
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!simulation) return;
        const ids = new Set<string>();
        for (const a of simulation.changes?.added ?? []) ids.add(a.User.id);
        for (const r of simulation.changes?.removed ?? []) ids.add(r.User.id);

        // Seed from rows whose label is already a resolved (non-UUID) name.
        const seeded: Record<string, string> = {};
        for (const row of rows) {
            if (row.aro === 'User' && row.label && row.label !== row.aroForeignKey) {
                seeded[row.aroForeignKey] = row.label;
            }
        }

        let cancelled = false;
        (async () => {
            const next: Record<string, string> = { ...seeded };
            const missing = Array.from(ids).filter((id) => !next[id]);
            await Promise.all(
                missing.map(async (id) => {
                    try {
                        const u = await getUser(id);
                        next[id] = aroDisplay(u).label;
                    } catch {
                        // Leave it unresolved; the preview falls back to a short id.
                    }
                }),
            );
            if (!cancelled) setAroNames(next);
        })();
        return () => {
            cancelled = true;
        };
        // Keyed on the simulation result; rows are read only to seed names.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [simulation]);

    // -----------------------------------------------------------------------
    // Resolve the armored public key for a single recipient (user id).
    // Falls back to a fresh GET /users/{id}.json when the key wasn't already
    // resolved (e.g. group members not present in the search payload).
    // -----------------------------------------------------------------------
    const resolveUserKey = useCallback(async (userId: string): Promise<string> => {
        const user = await getUser(userId);
        const armored = user.gpgkey?.armored_key;
        const who = user.username || userId;
        if (!armored) {
            throw new Error(`未找到 ${who} 的公钥，暂时无法授予其访问权限。`);
        }
        // E2EE: verify the armored key matches the server-reported fingerprint before
        // we ever encrypt a secret to it (server is untrusted on key distribution).
        await verifyArmoredKeyFingerprint(armored, user.gpgkey?.fingerprint, who);
        return armored;
    }, []);

    // -----------------------------------------------------------------------
    // Apply: re-encrypt the secret once per recipient and PUT the share.
    // -----------------------------------------------------------------------
    const handleApply = useCallback(async () => {
        if (!resourceId) return;
        if (isLocked) {
            setApplyError('保险库已锁定。请用 passphrase 解锁后再共享。');
            return;
        }
        if (!hasChanges) {
            setApplyError('没有可应用的变更。');
            return;
        }

        setApplying(true);
        setApplyError(null);

        try {
            const permissions = buildPermissions();

            // Resolve the flat list of recipient userIds that need a secret.
            // For each new USER ARO: the user themself.
            // For each new GROUP ARO: every member of the group.
            // De-dupe by userId; map userId -> armored public key.
            const recipientKeys = new Map<string, string>();
            const recipientErrors: string[] = [];

            for (const row of newlyAdded) {
                if (row.aro === 'User') {
                    if (recipientKeys.has(row.aroForeignKey)) continue;
                    try {
                        const key = await resolveUserKey(row.aroForeignKey);
                        recipientKeys.set(row.aroForeignKey, key);
                    } catch (err: unknown) {
                        recipientErrors.push(errMessage(err, `无法获取 ${row.label} 的密钥。`));
                    }
                } else {
                    // Group: fetch members + their gpgkeys.
                    let group: Group;
                    try {
                        group = await getGroup(row.aroForeignKey, {
                            containUsers: true,
                            containUserProfile: true,
                            containUserGpgkey: true,
                        });
                    } catch (err: unknown) {
                        recipientErrors.push(
                            errMessage(err, `无法加载群组「${row.label}」的成员。`),
                        );
                        continue;
                    }
                    const members = group.groups_users ?? [];
                    if (members.length === 0) continue;
                    for (const gu of members) {
                        const memberId = gu.user_id;
                        if (recipientKeys.has(memberId)) continue;
                        const who = gu.user?.username ?? memberId;
                        const inlineKey = gu.user?.gpgkey?.armored_key;
                        if (inlineKey) {
                            try {
                                // Verify the inline key against its reported fingerprint
                                // before trusting it (server is untrusted on key dist.).
                                await verifyArmoredKeyFingerprint(
                                    inlineKey,
                                    gu.user?.gpgkey?.fingerprint,
                                    who,
                                );
                                recipientKeys.set(memberId, inlineKey);
                                continue;
                            } catch (err: unknown) {
                                recipientErrors.push(
                                    errMessage(err, `无法验证 ${who} 的密钥（群组「${row.label}」）。`),
                                );
                                continue;
                            }
                        }
                        try {
                            const key = await resolveUserKey(memberId);
                            recipientKeys.set(memberId, key);
                        } catch (err: unknown) {
                            recipientErrors.push(
                                errMessage(err, `无法获取 ${who} 的密钥（群组「${row.label}」）。`),
                            );
                        }
                    }
                }
            }

            // CORRECTNESS INVARIANT: refuse to proceed if any added recipient
            // lacks a resolvable public key — sending a permission without a
            // correctly-encrypted secret would silently lock that user out.
            if (recipientErrors.length > 0) {
                setApplyError(
                    `无法共享 — 缺少收件人密钥：${recipientErrors.join(' ')}`,
                );
                setApplying(false);
                return;
            }

            // Build the secret payload only when there are recipients to add.
            let secrets: SecretWrite[] | null = null;
            if (recipientKeys.size > 0) {
                // 1. Fetch + decrypt the existing secret with the in-memory private key.
                const existing = await getSecretForResource(resourceId);
                if (!existing?.data) {
                    throw new Error('无法读取该资源现有的密文。');
                }
                const plaintext = await decrypt(existing.data);

                // 2. Re-encrypt ONCE per recipient with THAT recipient's public key.
                const built: SecretWrite[] = [];
                for (const [userId, armoredPublicKey] of recipientKeys.entries()) {
                    // encryptFor enforces a non-empty recipient key list.
                    const data = await encryptFor(plaintext, [armoredPublicKey]);
                    built.push({ user_id: userId, resource_id: resourceId, data });
                }
                secrets = built;
            }

            // 3. PUT /share/resource/{id}.json { permissions[], secrets[] }
            await applyShare('resource', resourceId, { permissions, secrets });

            toast.success(
                resourceName ? `「${resourceName}」已成功共享。` : '共享已成功更新。',
            );
            onShared?.();
            onClose(true);
        } catch (err: unknown) {
            setApplyError(errMessage(err, '应用共享失败。'));
            toast.error('无法应用此次共享。');
        } finally {
            setApplying(false);
        }
    }, [
        resourceId,
        resourceName,
        isLocked,
        hasChanges,
        newlyAdded,
        buildPermissions,
        resolveUserKey,
        decrypt,
        encryptFor,
        toast,
        onShared,
        onClose,
    ]);

    if (!open) return null;

    const busy = applying;

    return (
        <Modal
            open={open}
            title={resourceName ? `共享「${resourceName}」` : '共享资源'}
            onClose={() => !busy && onClose(false)}
            maxWidth={620}
            closeOnBackdrop={!busy}
            footer={
                <>
                    <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 'auto' }}>
                        {rows.filter((r) => !r.deleted).length} 个访问者
                    </span>
                    <button className="btn" onClick={() => onClose(false)} disabled={busy}>
                        取消
                    </button>
                    <button
                        className="btn"
                        onClick={handleSimulate}
                        disabled={busy || simulating || !hasChanges}
                        title="预览谁将获得或失去访问权限"
                    >
                        {simulating ? <Spinner size={16} /> : null}
                        {simulating ? '模拟中…' : '模拟'}
                    </button>
                    <button
                        className="btn primary"
                        onClick={handleApply}
                        disabled={busy || isLocked || !hasChanges}
                    >
                        {applying ? (
                            <Spinner size={16} color="#fff" />
                        ) : newlyAdded.length > 0 ? (
                            <RefreshCw size={16} />
                        ) : null}
                        {applying ? '加密并共享中…' : newlyAdded.length > 0 ? '加密并共享' : '保存'}
                    </button>
                </>
            }
        >
            {isLocked && (
                <Banner variant="warning" icon={<LockIcon size={16} />}>
                    保险库已锁定。请用 passphrase 解锁后再共享 —— 为新收件人重新加密密文需要你的私钥保留在内存中。
                </Banner>
            )}

            {applyError && (
                <Banner variant="error" icon={<AlertTriangle size={16} />}>
                    {applyError}
                </Banner>
            )}

            {/* ---- Search ---- */}
            <div className="aro-search" style={{ marginBottom: 16 }}>
                <div className="searchbox">
                    <Search />
                    <input
                        id="share-search"
                        placeholder="按姓名、用户名或群组搜索…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        autoComplete="off"
                        disabled={busy}
                    />
                </div>

                {/* Search results dropdown */}
                {query.trim().length > 0 && (
                    <div className="aro-results">
                        {searching && (
                            <div style={{ padding: '11px 12px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
                                <Spinner size={14} /> 搜索中…
                            </div>
                        )}
                        {!searching && searchError && (
                            <div style={{ padding: '11px 12px', color: 'var(--red-text)', fontSize: 13 }}>
                                {searchError}
                            </div>
                        )}
                        {!searching && !searchError && results.length === 0 && (
                            <div style={{ padding: '11px 12px', color: 'var(--text-3)', fontSize: 13 }}>
                                没有匹配项。
                            </div>
                        )}
                        {!searching &&
                            !searchError &&
                            results.map((aro) => {
                                const isUser = isUserAro(aro);
                                const { label, sublabel } = aroDisplay(aro);
                                const profile = isUser ? (aro as User).profile : null;
                                return (
                                    <button
                                        key={`${isUser ? 'u' : 'g'}-${aro.id}`}
                                        type="button"
                                        className="aro-opt"
                                        onClick={() => addAro(aro)}
                                    >
                                        {isUser ? (
                                            <Avatar
                                                size={30}
                                                src={profile?.avatar?.url?.small}
                                                firstName={profile?.first_name}
                                                lastName={profile?.last_name}
                                                name={label}
                                            />
                                        ) : (
                                            <span className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>
                                                <UsersIcon size={15} />
                                            </span>
                                        )}
                                        <span className="aro-info">
                                            <span className="an" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {label}
                                            </span>
                                            {sublabel && <span className="ae">{sublabel}</span>}
                                        </span>
                                        <Badge variant={isUser ? 'primary' : 'default'} icon={<UsersIcon size={11} />}>
                                            {isUser ? '用户' : '群组'}
                                        </Badge>
                                        <span className="add">
                                            <Plus />
                                        </span>
                                    </button>
                                );
                            })}
                    </div>
                )}
            </div>

            {/* ---- Current / draft permissions ---- */}
            <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500, marginBottom: 8 }}>
                    谁有访问权限
                </div>
                {permissionsError && (
                    <div style={{ marginBottom: 8 }}>
                        <Banner variant="error" icon={<AlertTriangle size={16} />}>
                            {permissionsError}
                        </Banner>
                    </div>
                )}
                {loadingPermissions ? (
                    <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13, border: '1px dashed var(--border)', borderRadius: 'var(--r)' }}>
                        <Spinner size={14} /> 正在加载当前访问列表…
                    </div>
                ) : rows.length === 0 ? (
                    <div style={{ padding: '16px', color: 'var(--text-3)', fontSize: 13, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 'var(--r)' }}>
                        目前还没有人拥有访问权限。在上方搜索以与成员或群组共享。
                    </div>
                ) : (
                    <div className="matrix">
                        {rows.map((row, idx) => (
                            <div
                                className="matrix-row"
                                key={`${row.aro}-${row.aroForeignKey}-${row.permissionId ?? 'new'}`}
                                style={row.deleted ? { background: 'var(--red-soft)', opacity: 0.7 } : undefined}
                            >
                                {row.aro === 'User' ? (
                                    <Avatar
                                        size={30}
                                        src={row.avatarSrc}
                                        firstName={row.firstName}
                                        lastName={row.lastName}
                                        name={row.label}
                                    />
                                ) : (
                                    <span className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>
                                        <UsersIcon size={15} />
                                    </span>
                                )}
                                <span className="aro-info">
                                    <span
                                        className="an"
                                        style={{
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            textDecoration: row.deleted ? 'line-through' : 'none',
                                        }}
                                    >
                                        {row.label}
                                        {row.isNew && !row.deleted && (
                                            <span className="chip green" style={{ padding: '1px 6px' }}>
                                                新增
                                            </span>
                                        )}
                                        {row.deleted && (
                                            <span className="chip red" style={{ padding: '1px 6px' }}>
                                                移除
                                            </span>
                                        )}
                                    </span>
                                    <span className="ae">{row.sublabel}</span>
                                </span>

                                <div className="perm-select">
                                    {PERMISSION_OPTIONS.map((opt) => (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            className={
                                                (row.type === opt.value ? 'sel' : '') +
                                                (opt.value === PERMISSION.OWNER ? ' owner' : '')
                                            }
                                            disabled={busy || row.deleted}
                                            onClick={() => changeRowType(idx, opt.value)}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>

                                {row.deleted ? (
                                    <button
                                        type="button"
                                        className="btn sm"
                                        onClick={() => undoRemove(idx)}
                                        disabled={busy}
                                    >
                                        撤销
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="rm-aro"
                                        onClick={() => removeRow(idx)}
                                        disabled={busy}
                                        aria-label={`移除 ${row.label}`}
                                        title="移除访问权限"
                                    >
                                        <XIcon />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ---- Re-encrypt summary (only when there are newly-added recipients) ---- */}
            {newlyAdded.length > 0 && (
                <div className="reencrypt">
                    <div className="re-head">
                        <RefreshCw /> 将为这些新收件人重新加密密文
                    </div>
                    <div className="re-sub">
                        新增 {newlyAdded.length} 个对象 · 每份密文都使用收件人自己的公钥单独封装，你的私钥与 passphrase 始终留在本地，永不离开设备。
                    </div>
                </div>
            )}

            {/* ---- Simulation preview ---- */}
            {simulation && <SimulationPreview result={simulation} names={aroNames} />}
        </Modal>
    );
}

// ---------------------------------------------------------------------------
// Simulation preview (informational only).
// ---------------------------------------------------------------------------
function SimulationPreview({
    result,
    names,
}: {
    result: ShareSimulateResult;
    names: Record<string, string>;
}) {
    const added = result.changes?.added ?? [];
    const removed = result.changes?.removed ?? [];
    // Prefer a resolved display name; fall back to a short id only when unknown.
    const display = (id: string) => names[id] ?? id.slice(0, 8);
    return (
        <div
            className="reencrypt"
            style={{ marginTop: 12, fontSize: 13 }}
        >
            <div style={{ color: 'var(--text-2)', fontWeight: 500, marginBottom: 10 }}>
                模拟结果
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ color: 'var(--text-3)', marginRight: 4 }}>获得访问：</span>
                {added.length === 0 ? (
                    <span style={{ color: 'var(--text-3)' }}>无</span>
                ) : (
                    added.map((a) => (
                        <span key={`a-${a.User.id}`} className="chip green">
                            {display(a.User.id)}
                        </span>
                    ))
                )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--text-3)', marginRight: 4 }}>失去访问：</span>
                {removed.length === 0 ? (
                    <span style={{ color: 'var(--text-3)' }}>无</span>
                ) : (
                    removed.map((r) => (
                        <span key={`r-${r.User.id}`} className="chip red">
                            {display(r.User.id)}
                        </span>
                    ))
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Small inline banner (matches the danger-banner tone used across the app).
// ---------------------------------------------------------------------------
function Banner({
    children,
    variant,
    icon,
}: {
    children: ReactNode;
    variant: 'error' | 'warning';
    icon?: ReactNode;
}) {
    const color = variant === 'error' ? 'var(--red-text)' : 'var(--amber-text)';
    const bg = variant === 'error' ? 'var(--red-soft)' : 'var(--amber-soft)';
    const borderColor =
        variant === 'error'
            ? 'color-mix(in oklch, var(--red) 30%, transparent)'
            : 'color-mix(in oklch, var(--amber) 35%, transparent)';
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                background: bg,
                color,
                border: `1px solid ${borderColor}`,
                borderRadius: 'var(--r)',
                padding: '10px 12px',
                fontSize: 13,
                lineHeight: 1.5,
                marginBottom: 16,
            }}
        >
            {icon && <span style={{ marginTop: 1, flexShrink: 0 }}>{icon}</span>}
            <span>{children}</span>
        </div>
    );
}

export default ShareDialog;
