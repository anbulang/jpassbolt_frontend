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
    Search,
    Trash2,
    Users as UsersIcon,
    UserRound,
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
    { value: PERMISSION.READ, label: 'Can read' },
    { value: PERMISSION.UPDATE, label: 'Can update' },
    { value: PERMISSION.OWNER, label: 'Owner' },
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
        sublabel: typeof count === 'number' ? `${count} member${count === 1 ? '' : 's'}` : 'Group',
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
        isNew: false,
        deleted: false,
        // Default to the UUID as a placeholder; replaced below if we have an
        // embedded object, or later by the resolver effect (never show raw UUIDs).
        label: p.aro_foreign_key,
        sublabel: p.aro === 'Group' ? 'Group' : 'User',
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
        return { ...base, label: embedded.group.name, sublabel: 'Group' };
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
                    errMessage(err, 'Could not load the current access list for this resource.'),
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
                setSearchError(errMessage(err, 'Search failed. Please try again.'));
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
                    items.push({ id: row.permissionId, delete: true });
                } else {
                    // Send the (possibly changed) level for existing permissions.
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
        return rows.some((r) => (r.isNew && !r.deleted) || (r.permissionId && r.deleted));
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
            setApplyError(errMessage(err, 'Simulation failed.'));
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
            throw new Error(`No public key found for ${who}. They cannot be granted access yet.`);
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
            setApplyError('Your vault is locked. Unlock with your passphrase to share.');
            return;
        }
        if (!hasChanges) {
            setApplyError('No changes to apply.');
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
                        recipientErrors.push(errMessage(err, `Could not resolve key for ${row.label}.`));
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
                            errMessage(err, `Could not load members of group "${row.label}".`),
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
                                    errMessage(err, `Could not verify key for ${who} (group "${row.label}").`),
                                );
                                continue;
                            }
                        }
                        try {
                            const key = await resolveUserKey(memberId);
                            recipientKeys.set(memberId, key);
                        } catch (err: unknown) {
                            recipientErrors.push(
                                errMessage(err, `Could not resolve key for ${who} (group "${row.label}").`),
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
                    `Cannot share — missing recipient keys: ${recipientErrors.join(' ')}`,
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
                    throw new Error('Could not read the existing secret for this resource.');
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
                resourceName ? `"${resourceName}" shared successfully.` : 'Share updated successfully.',
            );
            onShared?.();
            onClose(true);
        } catch (err: unknown) {
            setApplyError(errMessage(err, 'Failed to apply share.'));
            toast.error('Could not apply the share.');
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
            title={resourceName ? `Share "${resourceName}"` : 'Share resource'}
            onClose={() => !busy && onClose(false)}
            maxWidth={620}
            closeOnBackdrop={!busy}
            footer={
                <>
                    <button className="btn btn-secondary" onClick={() => onClose(false)} disabled={busy}>
                        Close
                    </button>
                    <button
                        className="btn btn-secondary"
                        onClick={handleSimulate}
                        disabled={busy || simulating || !hasChanges}
                        title="Preview who would gain or lose access"
                    >
                        {simulating ? <Spinner size={16} /> : null}
                        {simulating ? 'Simulating…' : 'Simulate'}
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={handleApply}
                        disabled={busy || isLocked || !hasChanges}
                    >
                        {applying ? <Spinner size={16} color="#fff" /> : null}
                        {applying ? 'Sharing…' : 'Apply'}
                    </button>
                </>
            }
        >
            {isLocked && (
                <Banner variant="warning" icon={<LockIcon size={16} />}>
                    Your vault is locked. Unlock with your passphrase to share — re-encrypting the
                    secret for new recipients requires your private key in memory.
                </Banner>
            )}

            {applyError && (
                <Banner variant="error" icon={<AlertTriangle size={16} />}>
                    {applyError}
                </Banner>
            )}

            {/* ---- Search ---- */}
            <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label" htmlFor="share-search">
                    Add people or groups
                </label>
                <div style={{ position: 'relative' }}>
                    <Search
                        size={16}
                        color="var(--text-muted)"
                        style={{ position: 'absolute', left: 12, top: 14, pointerEvents: 'none' }}
                    />
                    <input
                        id="share-search"
                        className="form-control"
                        style={{ paddingLeft: 36 }}
                        placeholder="Search by name, username, or group…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        autoComplete="off"
                        disabled={busy}
                    />
                </div>

                {/* Search results dropdown */}
                {query.trim().length > 0 && (
                    <div
                        className="glass-panel"
                        style={{
                            marginTop: 6,
                            maxHeight: 220,
                            overflowY: 'auto',
                            padding: 4,
                        }}
                    >
                        {searching && (
                            <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                                <Spinner size={14} /> Searching…
                            </div>
                        )}
                        {!searching && searchError && (
                            <div style={{ padding: '12px', color: 'var(--danger-color)', fontSize: 13 }}>
                                {searchError}
                            </div>
                        )}
                        {!searching && !searchError && results.length === 0 && (
                            <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 13 }}>
                                No matches.
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
                                        onClick={() => addAro(aro)}
                                        style={searchRowStyle}
                                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                                    >
                                        {isUser ? (
                                            <Avatar
                                                size={28}
                                                src={profile?.avatar?.url?.small}
                                                firstName={profile?.first_name}
                                                lastName={profile?.last_name}
                                                name={label}
                                            />
                                        ) : (
                                            <span className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>
                                                <UsersIcon size={14} />
                                            </span>
                                        )}
                                        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                            <span style={{ display: 'block', fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {label}
                                            </span>
                                            {sublabel && (
                                                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                                                    {sublabel}
                                                </span>
                                            )}
                                        </span>
                                        <Badge variant={isUser ? 'primary' : 'default'} icon={isUser ? <UserRound size={11} /> : <UsersIcon size={11} />}>
                                            {isUser ? 'User' : 'Group'}
                                        </Badge>
                                        <Plus size={16} color="var(--text-muted)" />
                                    </button>
                                );
                            })}
                    </div>
                )}
            </div>

            {/* ---- Current / draft permissions ---- */}
            <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 8 }}>
                    Who has access
                </div>
                {permissionsError && (
                    <div style={{ marginBottom: 8 }}>
                        <Banner variant="error" icon={<AlertTriangle size={16} />}>
                            {permissionsError}
                        </Banner>
                    </div>
                )}
                {loadingPermissions ? (
                    <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13, border: '1px dashed var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
                        <Spinner size={14} /> Loading current access…
                    </div>
                ) : rows.length === 0 ? (
                    <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', border: '1px dashed var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
                        No one has access yet. Search above to share with people or groups.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {rows.map((row, idx) => (
                            <div
                                key={`${row.aro}-${row.aroForeignKey}-${row.permissionId ?? 'new'}`}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    padding: '8px 10px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: row.deleted ? 'rgba(248,81,73,0.06)' : 'rgba(255,255,255,0.03)',
                                    border: '1px solid var(--panel-border)',
                                    opacity: row.deleted ? 0.6 : 1,
                                }}
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
                                <span style={{ flex: 1, minWidth: 0 }}>
                                    <span style={{ display: 'block', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: row.deleted ? 'line-through' : 'none' }}>
                                        {row.label}
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                                        {row.sublabel}
                                        {row.isNew && !row.deleted && (
                                            <Badge variant="success">New</Badge>
                                        )}
                                        {row.deleted && <Badge variant="danger">Removing</Badge>}
                                    </span>
                                </span>

                                <select
                                    className="form-control"
                                    style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}
                                    value={row.type}
                                    disabled={busy || row.deleted}
                                    onChange={(e) => changeRowType(idx, Number(e.target.value) as PermissionType)}
                                >
                                    {PERMISSION_OPTIONS.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>

                                {row.deleted ? (
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        style={{ padding: '6px 12px', fontSize: 13 }}
                                        onClick={() => undoRemove(idx)}
                                        disabled={busy}
                                    >
                                        Undo
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="icon-btn danger"
                                        onClick={() => removeRow(idx)}
                                        disabled={busy}
                                        aria-label={`Remove ${row.label}`}
                                        title="Remove access"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

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
            className="glass-panel"
            style={{ marginTop: 12, padding: '12px 14px', fontSize: 13 }}
        >
            <div style={{ color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 8 }}>
                Simulation result
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>Gains access:</span>
                {added.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>none</span>
                ) : (
                    added.map((a) => (
                        <Badge key={`a-${a.User.id}`} variant="success">
                            {display(a.User.id)}
                        </Badge>
                    ))
                )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>Loses access:</span>
                {removed.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>none</span>
                ) : (
                    removed.map((r) => (
                        <Badge key={`r-${r.User.id}`} variant="danger">
                            {display(r.User.id)}
                        </Badge>
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
    const color = variant === 'error' ? 'var(--danger-color)' : '#d29922';
    const bg = variant === 'error' ? 'rgba(248, 81, 73, 0.1)' : 'rgba(210, 153, 34, 0.1)';
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                background: bg,
                color,
                border: `1px solid ${color}`,
                borderRadius: 'var(--radius-sm)',
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

const searchRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '8px 10px',
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
};

export default ShareDialog;
