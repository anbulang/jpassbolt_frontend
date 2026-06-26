/**
 * EncryptedMetadataSettings — admin-only "Encrypted metadata" config page.
 *
 * The ONLY legitimately v5-labelled surface in the app: genuine admin territory
 * (the rest of the UI is format-transparent and never surfaces a v4-vs-v5
 * distinction to users).
 *
 * Self-gates on the NETWORK truth (GET /users/me.json role), NOT the LS blob,
 * because the cached jpassbolt_user is not guaranteed to carry the role and the
 * server enforces admin on the POST endpoints regardless. Non-admins are
 * redirected to /settings; admins see three glass-panel sections:
 *
 *   1. Metadata types policy — view all 14 fields; EDIT the create-format policy
 *      (default_resource_types + the v4/v5 allow-creation booleans + up/downgrade)
 *      via POST /metadata/types/settings.json. Enabling a v5 flag requires an
 *      ACTIVE metadata key (backend 400s otherwise) — the form disables the v5
 *      toggles and shows an inline warning when no active key exists, and still
 *      surfaces the server 400 message if the write is rejected.
 *   2. Keys settings — view + edit allow_usage_of_personal_keys +
 *      zero_knowledge_key_share via POST /metadata/keys/settings.json.
 *   3. Org metadata keys — read-only table of each MetadataKey (fingerprint,
 *      created, active/expired/deleted status) plus per-user private-key
 *      distribution status derived from metadata_private_keys length vs the org
 *      user count. Key creation/rotation is backend-gated and out of scope here.
 *
 * E2EE invariant: this page only reads/writes settings + lists key METADATA
 * (fingerprints, public-key armored, distribution counts). It never decrypts a
 * private key or touches plaintext, and writes nothing to localStorage.
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
    type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import {
    KeyRound,
    Settings as SettingsIcon,
    ShieldCheck,
    AlertTriangle,
    Check,
    X,
    Pencil,
} from 'lucide-react';
import { getMe } from '../services/profile';
import { listUsers } from '../services/users';
import {
    listMetadataKeys,
    getMetadataTypesSettings,
    getMetadataKeysSettings,
    updateMetadataTypesSettings,
    updateMetadataKeysSettings,
} from '../services/metadata';
import type {
    MetadataDefaultType,
    MetadataKey,
    MetadataKeysSettings,
    MetadataTypesSettings,
} from '../types';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { FullSpinner, Spinner } from '../components/Spinner';
import { useToast } from '../components/toastContext';
import { describeApiError } from '../i18n/errors';

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------
const errorBannerStyle: CSSProperties = {
    background: 'rgba(248, 81, 73, 0.1)',
    color: 'var(--danger-color)',
    border: '1px solid var(--danger-color)',
    borderRadius: 'var(--radius-md)',
    padding: '12px 16px',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    lineHeight: 1.5,
};

const warnBannerStyle: CSSProperties = {
    background: 'rgba(210, 153, 34, 0.12)',
    color: 'var(--warning-color, #d29922)',
    border: '1px solid var(--warning-color, #d29922)',
    borderRadius: 'var(--radius-md)',
    padding: '12px 16px',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    lineHeight: 1.5,
};

function ErrorBanner({ children }: { children: ReactNode }) {
    return (
        <div style={errorBannerStyle} role="alert">
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{children}</span>
        </div>
    );
}

function WarnBanner({ children }: { children: ReactNode }) {
    return (
        <div style={warnBannerStyle}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{children}</span>
        </div>
    );
}

/** RFC3339 / ISO string -> human readable; passes through unparsable input. */
function formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
}

/** Group an OpenPGP fingerprint into 4-char blocks for readability. */
function formatFingerprint(fp: string): string {
    const clean = fp.replace(/\s+/g, '').toUpperCase();
    return clean.match(/.{1,4}/g)?.join(' ') ?? clean;
}

/** A read-only "yes / no" pill for boolean policy rows. */
function BoolBadge({ value }: { value: boolean }) {
    const { t } = useTranslation('settings');
    return (
        <Badge variant={value ? 'success' : 'muted'}>
            {value ? <Check size={12} /> : <X size={12} />}{' '}
            {value ? t('metadata.bool.yes') : t('metadata.bool.no')}
        </Badge>
    );
}

// ===========================================================================
// Page
// ===========================================================================
type GateState = 'loading' | 'admin' | 'denied';

export default function EncryptedMetadataSettings() {
    const { t } = useTranslation('settings');
    const [gate, setGate] = useState<GateState>('loading');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const me = await getMe();
                if (!cancelled) setGate(me.role?.name === 'admin' ? 'admin' : 'denied');
            } catch {
                // Fail closed (treat as non-admin) rather than leaking the page.
                if (!cancelled) setGate('denied');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    if (gate === 'loading') {
        return (
            <div className="container animate-fade-in">
                <div className="glass-panel" style={{ padding: '48px 20px' }}>
                    <FullSpinner label={t('metadata.verifyingAccess')} />
                </div>
            </div>
        );
    }

    if (gate === 'denied') {
        return <Navigate to="/settings" replace />;
    }

    return <AdminPanel />;
}

// ===========================================================================
// Admin panel — loads all three data sources, renders the three sections.
// ===========================================================================
function AdminPanel() {
    const { t } = useTranslation('settings');
    const [typesSettings, setTypesSettings] = useState<MetadataTypesSettings | null>(null);
    const [keysSettings, setKeysSettings] = useState<MetadataKeysSettings | null>(null);
    const [keys, setKeys] = useState<MetadataKey[]>([]);
    const [userCount, setUserCount] = useState<number | null>(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [types, keysCfg, keyList] = await Promise.all([
                getMetadataTypesSettings(),
                getMetadataKeysSettings(),
                listMetadataKeys({ containPrivateKeys: true }),
            ]);
            setTypesSettings(types);
            setKeysSettings(keysCfg);
            setKeys(keyList);
            // User count is best-effort: it only feeds the distribution display.
            try {
                const users = await listUsers();
                setUserCount(users.length);
            } catch {
                setUserCount(null);
            }
        } catch (err: unknown) {
            setError(describeApiError(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    /** An active metadata key exists when a row is neither expired nor deleted. */
    const hasActiveKey = useMemo(
        () => keys.some((k) => k.expired === null && k.deleted === null),
        [keys],
    );

    return (
        <div className="container animate-fade-in">
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ margin: 0, fontSize: '26px' }}>{t('metadata.title')}</h1>
                <p style={{ color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                    {t('metadata.subtitle')}
                </p>
            </div>

            {loading ? (
                <div className="glass-panel" style={{ padding: '48px 20px' }}>
                    <FullSpinner label={t('metadata.loading')} />
                </div>
            ) : error ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <ErrorBanner>{error}</ErrorBanner>
                    <button type="button" className="btn btn-secondary" onClick={() => void load()}>
                        {t('common:actions.retry')}
                    </button>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {typesSettings && (
                        <TypesPolicySection
                            settings={typesSettings}
                            hasActiveKey={hasActiveKey}
                            onSaved={setTypesSettings}
                        />
                    )}
                    {keysSettings && (
                        <KeysSettingsSection settings={keysSettings} onSaved={setKeysSettings} />
                    )}
                    <OrgKeysSection keys={keys} userCount={userCount} />
                </div>
            )}
        </div>
    );
}

// ===========================================================================
// Section 1 — Metadata types policy
// ===========================================================================
const TYPE_ENTITIES: { key: keyof MetadataTypesSettings; labelKey: string }[] = [
    { key: 'default_resource_types', labelKey: 'metadata.entities.resources' },
    { key: 'default_folder_type', labelKey: 'metadata.entities.folders' },
    { key: 'default_tag_type', labelKey: 'metadata.entities.tags' },
    { key: 'default_comment_type', labelKey: 'metadata.entities.comments' },
];

const V5_CREATE_FLAGS: { key: keyof MetadataTypesSettings; labelKey: string }[] = [
    { key: 'allow_creation_of_v5_resources', labelKey: 'metadata.v5Create.resources' },
    { key: 'allow_creation_of_v5_folders', labelKey: 'metadata.v5Create.folders' },
    { key: 'allow_creation_of_v5_tags', labelKey: 'metadata.v5Create.tags' },
    { key: 'allow_creation_of_v5_comments', labelKey: 'metadata.v5Create.comments' },
];

const V4_CREATE_FLAGS: { key: keyof MetadataTypesSettings; labelKey: string }[] = [
    { key: 'allow_creation_of_v4_resources', labelKey: 'metadata.v4Create.resources' },
    { key: 'allow_creation_of_v4_folders', labelKey: 'metadata.v4Create.folders' },
    { key: 'allow_creation_of_v4_tags', labelKey: 'metadata.v4Create.tags' },
    { key: 'allow_creation_of_v4_comments', labelKey: 'metadata.v4Create.comments' },
];

const MIGRATION_FLAGS: { key: keyof MetadataTypesSettings; labelKey: string }[] = [
    { key: 'allow_v4_v5_upgrade', labelKey: 'metadata.migration.upgrade' },
    { key: 'allow_v5_v4_downgrade', labelKey: 'metadata.migration.downgrade' },
];

/** The boolean fields that imply v5 is in use (blocked without an active key). */
const V5_DEPENDENT_KEYS: (keyof MetadataTypesSettings)[] = [
    'allow_creation_of_v5_resources',
    'allow_creation_of_v5_folders',
    'allow_creation_of_v5_tags',
    'allow_creation_of_v5_comments',
    'allow_v4_v5_upgrade',
];

function TypesPolicySection({
    settings,
    hasActiveKey,
    onSaved,
}: {
    settings: MetadataTypesSettings;
    hasActiveKey: boolean;
    onSaved: (next: MetadataTypesSettings) => void;
}) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<MetadataTypesSettings>(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const beginEdit = () => {
        setDraft(settings);
        setError(null);
        setEditing(true);
    };

    const cancelEdit = () => {
        setEditing(false);
        setError(null);
    };

    const setDefault = (key: keyof MetadataTypesSettings, value: MetadataDefaultType) =>
        setDraft((d) => ({ ...d, [key]: value }));

    const setBool = (key: keyof MetadataTypesSettings, value: boolean) =>
        setDraft((d) => ({ ...d, [key]: value }));

    /** Will this draft turn any v5-dependent setting ON? */
    const draftEnablesV5 = useMemo(() => {
        const v5DefaultSelected = TYPE_ENTITIES.some((e) => draft[e.key] === 'v5');
        const v5FlagOn = V5_DEPENDENT_KEYS.some((k) => draft[k] === true);
        return v5DefaultSelected || v5FlagOn;
    }, [draft]);

    const blockedNoKey = draftEnablesV5 && !hasActiveKey;

    const handleSave = async () => {
        if (blockedNoKey) {
            setError(t('metadata.typesPolicy.blockedNoKey'));
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const updated = await updateMetadataTypesSettings(draft);
            onSaved(updated);
            setEditing(false);
            toast.success(t('metadata.typesPolicy.updated'));
        } catch (err: unknown) {
            // The backend 400s when a v5 flag is enabled without an active key —
            // surface its message verbatim instead of failing silently.
            const msg = describeApiError(err);
            setError(msg);
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="glass-panel" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                <SettingsIcon size={20} color="var(--primary-color)" />
                <h2 style={{ margin: 0, fontSize: '18px', flex: 1 }}>
                    {t('metadata.typesPolicy.title')}
                </h2>
                {!editing && (
                    <button type="button" className="btn btn-secondary" onClick={beginEdit}>
                        <Pencil size={16} /> {t('common:actions.edit')}
                    </button>
                )}
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                {t('metadata.typesPolicy.subtitle')}
            </p>

            {!hasActiveKey && (
                <div style={{ marginBottom: '16px' }}>
                    <WarnBanner>
                        {t('metadata.typesPolicy.noActiveKeyWarn')}
                    </WarnBanner>
                </div>
            )}

            {error && (
                <div style={{ marginBottom: '16px' }}>
                    <ErrorBanner>{error}</ErrorBanner>
                </div>
            )}

            {/* Default formats per entity */}
            <h3 style={{ fontSize: '14px', margin: '0 0 10px', color: 'var(--text-secondary)' }}>
                {t('metadata.typesPolicy.defaultFormats')}
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <tbody>
                    {TYPE_ENTITIES.map(({ key, labelKey }) => (
                        <tr key={key} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                            <td style={{ padding: '10px 12px 10px 0', color: 'var(--text-secondary)' }}>
                                {t(labelKey)}
                            </td>
                            <td style={{ padding: '10px 0', textAlign: 'right' }}>
                                {editing ? (
                                    <select
                                        className="form-control"
                                        style={{ maxWidth: '120px', marginLeft: 'auto' }}
                                        value={draft[key] as MetadataDefaultType}
                                        onChange={(e) =>
                                            setDefault(key, e.target.value as MetadataDefaultType)
                                        }
                                        disabled={saving}
                                    >
                                        <option value="v4">v4</option>
                                        <option value="v5">v5</option>
                                    </select>
                                ) : (
                                    <Badge
                                        variant={settings[key] === 'v5' ? 'primary' : 'muted'}
                                    >
                                        {settings[key] as string}
                                    </Badge>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {/* Boolean policy groups */}
            <BoolFlagGroup
                title={t('metadata.typesPolicy.groupV5Create')}
                flags={V5_CREATE_FLAGS}
                editing={editing}
                saving={saving}
                settings={settings}
                draft={draft}
                onToggle={setBool}
                disabledWhenNoKey={!hasActiveKey}
            />
            <BoolFlagGroup
                title={t('metadata.typesPolicy.groupV4Create')}
                flags={V4_CREATE_FLAGS}
                editing={editing}
                saving={saving}
                settings={settings}
                draft={draft}
                onToggle={setBool}
            />
            <BoolFlagGroup
                title={t('metadata.typesPolicy.groupMigration')}
                flags={MIGRATION_FLAGS}
                editing={editing}
                saving={saving}
                settings={settings}
                draft={draft}
                onToggle={setBool}
                disabledKeys={['allow_v4_v5_upgrade']}
                disabledWhenNoKey={!hasActiveKey}
            />

            {editing && (
                <div style={{ marginTop: '24px', display: 'flex', gap: '12px' }}>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleSave()}
                        disabled={saving || blockedNoKey}
                    >
                        {saving ? <Spinner size={16} color="#fff" /> : null}
                        {saving
                            ? t('metadata.typesPolicy.saving')
                            : t('metadata.typesPolicy.savePolicy')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={cancelEdit}
                        disabled={saving}
                    >
                        {t('common:actions.cancel')}
                    </button>
                </div>
            )}
        </div>
    );
}

/** A labelled group of boolean policy rows (view = badge, edit = checkbox). */
function BoolFlagGroup({
    title,
    flags,
    editing,
    saving,
    settings,
    draft,
    onToggle,
    disabledKeys = [],
    disabledWhenNoKey = false,
}: {
    title: string;
    flags: { key: keyof MetadataTypesSettings; labelKey: string }[];
    editing: boolean;
    saving: boolean;
    settings: MetadataTypesSettings;
    draft: MetadataTypesSettings;
    onToggle: (key: keyof MetadataTypesSettings, value: boolean) => void;
    /** Subset of flags that depend on an active key (disabled when none). */
    disabledKeys?: (keyof MetadataTypesSettings)[];
    disabledWhenNoKey?: boolean;
}) {
    const { t } = useTranslation('settings');
    // When the group itself is v5-dependent (no explicit subset), all rows gate.
    const allGate = disabledWhenNoKey && disabledKeys.length === 0;

    return (
        <>
            <h3 style={{ fontSize: '14px', margin: '20px 0 10px', color: 'var(--text-secondary)' }}>
                {title}
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <tbody>
                    {flags.map(({ key, labelKey }) => {
                        const gated =
                            disabledWhenNoKey && (allGate || disabledKeys.includes(key));
                        const current = settings[key] as boolean;
                        const drafted = draft[key] as boolean;
                        const label = t(labelKey);
                        return (
                            <tr key={key} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                                <td
                                    style={{
                                        padding: '10px 12px 10px 0',
                                        color: 'var(--text-secondary)',
                                    }}
                                >
                                    {label}
                                    {editing && gated && (
                                        <span
                                            style={{
                                                marginLeft: '8px',
                                                fontSize: '12px',
                                                color: 'var(--text-muted)',
                                            }}
                                        >
                                            {t('metadata.typesPolicy.needsActiveKey')}
                                        </span>
                                    )}
                                </td>
                                <td style={{ padding: '10px 0', textAlign: 'right' }}>
                                    {editing ? (
                                        <input
                                            type="checkbox"
                                            checked={drafted}
                                            disabled={saving || gated}
                                            onChange={(e) => onToggle(key, e.target.checked)}
                                            aria-label={label}
                                        />
                                    ) : (
                                        <BoolBadge value={current} />
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </>
    );
}

// ===========================================================================
// Section 2 — Keys settings
// ===========================================================================
function KeysSettingsSection({
    settings,
    onSaved,
}: {
    settings: MetadataKeysSettings;
    onSaved: (next: MetadataKeysSettings) => void;
}) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<MetadataKeysSettings>(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const beginEdit = () => {
        setDraft(settings);
        setError(null);
        setEditing(true);
    };

    const cancelEdit = () => {
        setEditing(false);
        setError(null);
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            const updated = await updateMetadataKeysSettings(draft);
            onSaved(updated);
            setEditing(false);
            toast.success(t('metadata.keysSettings.updated'));
        } catch (err: unknown) {
            const msg = describeApiError(err);
            setError(msg);
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    const rows: { key: keyof MetadataKeysSettings; label: string; help: string }[] = [
        {
            key: 'allow_usage_of_personal_keys',
            label: t('metadata.keysSettings.allowPersonalKeys'),
            help: t('metadata.keysSettings.allowPersonalKeysHelp'),
        },
        {
            key: 'zero_knowledge_key_share',
            label: t('metadata.keysSettings.zeroKnowledge'),
            help: t('metadata.keysSettings.zeroKnowledgeHelp'),
        },
    ];

    return (
        <div className="glass-panel" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                <ShieldCheck size={20} color="var(--primary-color)" />
                <h2 style={{ margin: 0, fontSize: '18px', flex: 1 }}>
                    {t('metadata.keysSettings.title')}
                </h2>
                {!editing && (
                    <button type="button" className="btn btn-secondary" onClick={beginEdit}>
                        <Pencil size={16} /> {t('common:actions.edit')}
                    </button>
                )}
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                {t('metadata.keysSettings.subtitle')}
            </p>

            {error && (
                <div style={{ marginBottom: '16px' }}>
                    <ErrorBanner>{error}</ErrorBanner>
                </div>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <tbody>
                    {rows.map(({ key, label, help }) => (
                        <tr key={key} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                            <td style={{ padding: '12px 12px 12px 0' }}>
                                <div style={{ color: 'var(--text-primary)' }}>{label}</div>
                                <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                                    {help}
                                </div>
                            </td>
                            <td style={{ padding: '12px 0', textAlign: 'right', verticalAlign: 'top' }}>
                                {editing ? (
                                    <input
                                        type="checkbox"
                                        checked={draft[key]}
                                        disabled={saving}
                                        onChange={(e) =>
                                            setDraft((d) => ({ ...d, [key]: e.target.checked }))
                                        }
                                        aria-label={label}
                                    />
                                ) : (
                                    <BoolBadge value={settings[key]} />
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {editing && (
                <div style={{ marginTop: '24px', display: 'flex', gap: '12px' }}>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleSave()}
                        disabled={saving}
                    >
                        {saving ? <Spinner size={16} color="#fff" /> : null}
                        {saving
                            ? t('metadata.keysSettings.saving')
                            : t('metadata.keysSettings.saveSettings')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={cancelEdit}
                        disabled={saving}
                    >
                        {t('common:actions.cancel')}
                    </button>
                </div>
            )}
        </div>
    );
}

// ===========================================================================
// Section 3 — Org metadata keys (read-only)
// ===========================================================================
function keyStatus(k: MetadataKey): {
    labelKey: string;
    variant: 'success' | 'muted' | 'danger';
} {
    if (k.deleted !== null) return { labelKey: 'metadata.orgKeys.statusDeleted', variant: 'danger' };
    if (k.expired !== null) return { labelKey: 'metadata.orgKeys.statusExpired', variant: 'muted' };
    return { labelKey: 'metadata.orgKeys.statusActive', variant: 'success' };
}

function OrgKeysSection({
    keys,
    userCount,
}: {
    keys: MetadataKey[];
    userCount: number | null;
}) {
    const { t } = useTranslation('settings');
    return (
        <div className="glass-panel" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                <KeyRound size={20} color="var(--primary-color)" />
                <h2 style={{ margin: 0, fontSize: '18px' }}>{t('metadata.orgKeys.title')}</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                {t('metadata.orgKeys.subtitle')}
            </p>

            {keys.length === 0 ? (
                <EmptyState
                    icon={KeyRound}
                    title={t('metadata.orgKeys.emptyTitle')}
                    description={t('metadata.orgKeys.emptyDescription')}
                    panel={false}
                />
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                            <th style={thStyle}>{t('metadata.orgKeys.thFingerprint')}</th>
                            <th style={thStyle}>{t('metadata.orgKeys.thStatus')}</th>
                            <th style={thStyle}>{t('metadata.orgKeys.thCreated')}</th>
                            <th style={thStyle}>{t('metadata.orgKeys.thDistribution')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {keys.map((k) => {
                            const status = keyStatus(k);
                            const distributed = k.metadata_private_keys?.length ?? 0;
                            const distLabel =
                                userCount != null
                                    ? t('metadata.orgKeys.distWithTotal', {
                                          distributed,
                                          total: userCount,
                                      })
                                    : t('metadata.orgKeys.distNoTotal', { distributed });
                            return (
                                <tr
                                    key={k.id}
                                    style={{ borderBottom: '1px solid var(--panel-border)' }}
                                >
                                    <td
                                        style={{
                                            padding: '12px 12px 12px 0',
                                            fontFamily:
                                                "'SFMono-Regular', Consolas, Menlo, monospace",
                                            color: 'var(--text-primary)',
                                            wordBreak: 'break-all',
                                        }}
                                    >
                                        {formatFingerprint(k.fingerprint)}
                                    </td>
                                    <td style={{ padding: '12px' }}>
                                        <Badge variant={status.variant}>{t(status.labelKey)}</Badge>
                                    </td>
                                    <td style={{ padding: '12px', color: 'var(--text-secondary)' }}>
                                        {formatDate(k.created)}
                                    </td>
                                    <td style={{ padding: '12px', color: 'var(--text-secondary)' }}>
                                        {distLabel}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

const thStyle: CSSProperties = {
    textAlign: 'left',
    padding: '8px 12px 8px 0',
    color: 'var(--text-muted)',
    fontWeight: 500,
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
};
