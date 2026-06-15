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

// ---------------------------------------------------------------------------
// Error helpers (mirror Settings.tsx)
// ---------------------------------------------------------------------------
interface ApiErrorLike {
    response?: { status?: number; data?: { header?: { message?: string } } };
    message?: string;
}

function asApiError(err: unknown): ApiErrorLike {
    return (err ?? {}) as ApiErrorLike;
}

function errMessage(err: unknown, fallback: string): string {
    const e = asApiError(err);
    return e.response?.data?.header?.message || e.message || fallback;
}

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
    return (
        <Badge variant={value ? 'success' : 'muted'}>
            {value ? <Check size={12} /> : <X size={12} />} {value ? '是' : '否'}
        </Badge>
    );
}

// ===========================================================================
// Page
// ===========================================================================
type GateState = 'loading' | 'admin' | 'denied';

export default function EncryptedMetadataSettings() {
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
                    <FullSpinner label="正在校验权限……" />
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
            setError(errMessage(err, '加载加密元数据设置失败。'));
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
                <h1 style={{ margin: 0, fontSize: '26px' }}>加密元数据</h1>
                <p style={{ color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                    用于加密（v5）资源元数据的组织策略与密钥。
                </p>
            </div>

            {loading ? (
                <div className="glass-panel" style={{ padding: '48px 20px' }}>
                    <FullSpinner label="正在加载加密元数据设置……" />
                </div>
            ) : error ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <ErrorBanner>{error}</ErrorBanner>
                    <button type="button" className="btn btn-secondary" onClick={() => void load()}>
                        重试
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
const TYPE_ENTITIES: { key: keyof MetadataTypesSettings; label: string }[] = [
    { key: 'default_resource_types', label: '资源' },
    { key: 'default_folder_type', label: '文件夹' },
    { key: 'default_tag_type', label: '标签' },
    { key: 'default_comment_type', label: '评论' },
];

const V5_CREATE_FLAGS: { key: keyof MetadataTypesSettings; label: string }[] = [
    { key: 'allow_creation_of_v5_resources', label: '允许创建 v5 资源' },
    { key: 'allow_creation_of_v5_folders', label: '允许创建 v5 文件夹' },
    { key: 'allow_creation_of_v5_tags', label: '允许创建 v5 标签' },
    { key: 'allow_creation_of_v5_comments', label: '允许创建 v5 评论' },
];

const V4_CREATE_FLAGS: { key: keyof MetadataTypesSettings; label: string }[] = [
    { key: 'allow_creation_of_v4_resources', label: '允许创建 v4 资源' },
    { key: 'allow_creation_of_v4_folders', label: '允许创建 v4 文件夹' },
    { key: 'allow_creation_of_v4_tags', label: '允许创建 v4 标签' },
    { key: 'allow_creation_of_v4_comments', label: '允许创建 v4 评论' },
];

const MIGRATION_FLAGS: { key: keyof MetadataTypesSettings; label: string }[] = [
    { key: 'allow_v4_v5_upgrade', label: '允许 v4 → v5 升级' },
    { key: 'allow_v5_v4_downgrade', label: '允许 v5 → v4 降级' },
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
            setError(
                '启用 v5 需要一个处于激活状态的组织元数据密钥，请先创建元数据密钥。',
            );
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const updated = await updateMetadataTypesSettings(draft);
            onSaved(updated);
            setEditing(false);
            toast.success('元数据格式策略已更新。');
        } catch (err: unknown) {
            // The backend 400s when a v5 flag is enabled without an active key —
            // surface its message verbatim instead of failing silently.
            const msg = errMessage(err, '更新元数据格式策略失败。');
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
                <h2 style={{ margin: 0, fontSize: '18px', flex: 1 }}>元数据格式策略</h2>
                {!editing && (
                    <button type="button" className="btn btn-secondary" onClick={beginEdit}>
                        <Pencil size={16} /> 编辑
                    </button>
                )}
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                控制新建项目使用的格式，以及是否允许在组织范围内创建和迁移 v4/v5。
            </p>

            {!hasActiveKey && (
                <div style={{ marginBottom: '16px' }}>
                    <WarnBanner>
                        目前尚无处于激活状态的组织元数据密钥。启用任何 v5 选项都需要一个激活的元数据密钥——
                        在创建之前，服务器将拒绝相关更改。
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
                默认格式
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <tbody>
                    {TYPE_ENTITIES.map(({ key, label }) => (
                        <tr key={key} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                            <td style={{ padding: '10px 12px 10px 0', color: 'var(--text-secondary)' }}>
                                {label}
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
                title="v5 创建"
                flags={V5_CREATE_FLAGS}
                editing={editing}
                saving={saving}
                settings={settings}
                draft={draft}
                onToggle={setBool}
                disabledWhenNoKey={!hasActiveKey}
            />
            <BoolFlagGroup
                title="v4 创建"
                flags={V4_CREATE_FLAGS}
                editing={editing}
                saving={saving}
                settings={settings}
                draft={draft}
                onToggle={setBool}
            />
            <BoolFlagGroup
                title="迁移"
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
                        {saving ? '正在保存……' : '保存策略'}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={cancelEdit}
                        disabled={saving}
                    >
                        取消
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
    flags: { key: keyof MetadataTypesSettings; label: string }[];
    editing: boolean;
    saving: boolean;
    settings: MetadataTypesSettings;
    draft: MetadataTypesSettings;
    onToggle: (key: keyof MetadataTypesSettings, value: boolean) => void;
    /** Subset of flags that depend on an active key (disabled when none). */
    disabledKeys?: (keyof MetadataTypesSettings)[];
    disabledWhenNoKey?: boolean;
}) {
    // When the group itself is v5-dependent (no explicit subset), all rows gate.
    const allGate = disabledWhenNoKey && disabledKeys.length === 0;

    return (
        <>
            <h3 style={{ fontSize: '14px', margin: '20px 0 10px', color: 'var(--text-secondary)' }}>
                {title}
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <tbody>
                    {flags.map(({ key, label }) => {
                        const gated =
                            disabledWhenNoKey && (allGate || disabledKeys.includes(key));
                        const current = settings[key] as boolean;
                        const drafted = draft[key] as boolean;
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
                                            （需要一个激活的元数据密钥）
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
            toast.success('元数据密钥设置已更新。');
        } catch (err: unknown) {
            const msg = errMessage(err, '更新元数据密钥设置失败。');
            setError(msg);
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    const rows: { key: keyof MetadataKeysSettings; label: string; help: string }[] = [
        {
            key: 'allow_usage_of_personal_keys',
            label: '允许使用个人密钥',
            help: '允许个人项目的元数据使用用户自己的 GPG 密钥（user_key）加密。',
        },
        {
            key: 'zero_knowledge_key_share',
            label: '零知识密钥共享',
            help: '在服务器始终不持有元数据密钥私钥部分的前提下共享该密钥。',
        },
    ];

    return (
        <div className="glass-panel" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                <ShieldCheck size={20} color="var(--primary-color)" />
                <h2 style={{ margin: 0, fontSize: '18px', flex: 1 }}>元数据密钥设置</h2>
                {!editing && (
                    <button type="button" className="btn btn-secondary" onClick={beginEdit}>
                        <Pencil size={16} /> 编辑
                    </button>
                )}
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                管理元数据密钥在组织范围内的使用与共享方式。
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
                        {saving ? '正在保存……' : '保存设置'}
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={cancelEdit}
                        disabled={saving}
                    >
                        取消
                    </button>
                </div>
            )}
        </div>
    );
}

// ===========================================================================
// Section 3 — Org metadata keys (read-only)
// ===========================================================================
function keyStatus(k: MetadataKey): { label: string; variant: 'success' | 'muted' | 'danger' } {
    if (k.deleted !== null) return { label: '已删除', variant: 'danger' };
    if (k.expired !== null) return { label: '已过期', variant: 'muted' };
    return { label: '激活', variant: 'success' };
}

function OrgKeysSection({
    keys,
    userCount,
}: {
    keys: MetadataKey[];
    userCount: number | null;
}) {
    return (
        <div className="glass-panel" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                <KeyRound size={20} color="var(--primary-color)" />
                <h2 style={{ margin: 0, fontSize: '18px' }}>组织元数据密钥</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                用于加密资源元数据的共享密钥。分发情况显示有多少用户持有每个密钥私钥部分的加密副本。
                此处暂不支持创建和轮换密钥。
            </p>

            {keys.length === 0 ? (
                <EmptyState
                    icon={KeyRound}
                    title="暂无元数据密钥"
                    description="尚未创建任何组织元数据密钥。在创建之前，v5 加密元数据将保持禁用。"
                    panel={false}
                />
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                            <th style={thStyle}>指纹</th>
                            <th style={thStyle}>状态</th>
                            <th style={thStyle}>创建时间</th>
                            <th style={thStyle}>分发情况</th>
                        </tr>
                    </thead>
                    <tbody>
                        {keys.map((k) => {
                            const status = keyStatus(k);
                            const distributed = k.metadata_private_keys?.length ?? 0;
                            const distLabel =
                                userCount != null
                                    ? `${distributed} / ${userCount} 位用户`
                                    : `${distributed} 位用户`;
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
                                        <Badge variant={status.variant}>{status.label}</Badge>
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
