/**
 * SecretPanel — the Aegis vault's third column (inline, not a drawer).
 *
 * Encrypted-by-default: the password shows as •••••• until the user clicks 显示,
 * which fetches the armored ciphertext (GET /secrets/resource/{id}.json) and
 * decrypts it IN MEMORY with the unlocked private key (useKey().decrypt). The
 * "decrypting" animation runs for the real async decrypt. A revealed secret
 * auto re-locks after `revealSecs`; copying it best-effort clears the clipboard
 * after `burnSecs`. Plaintext is never logged and is wiped on re-lock / unmount /
 * resource change.
 *
 * Three tabs: 凭据 (details + secret) · 共享 (current ACL) · 评论 (threaded notes).
 * The component is keyed by resource.id in Vault, so switching rows remounts it
 * and resets all reveal state.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import {
  Lock,
  Unlock,
  Eye,
  Copy,
  Check,
  Link as LinkIcon,
  Share2,
  Pencil,
  Move as MoveIcon,
  Star,
  KeyRound,
  Clock,
  AlertTriangle,
  User as UserIcon,
  MessageSquare,
  Users as UsersIcon,
  Plus,
  Trash2,
} from 'lucide-react';
import type { PermissionWithAro, Resource, ResourceType, Comment } from '../../types';
import { getSecretForResource } from '../../services/secrets';
import { getResourcePermissions } from '../../services/permissions';
import { listComments, addComment } from '../../services/comments';
import { useKey } from '../../crypto/KeyContext';
import { useToast } from '../../components/toastContext';
import { useTheme } from '../../theme';
import i18n from '../../i18n';
import { describeApiError } from '../../i18n/errors';
import { decodeSecret, isEncryptedDescriptionType } from './secretFormat';
import { isV5Resource } from './resourceMetadata';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}
function tileColor(seed: string): string {
  return `oklch(0.58 0.15 ${hashHue(seed)})`;
}
function tileLetter(name: string): string {
  return name.replace(/^[^A-Za-z一-龥]*/, '').slice(0, 1).toUpperCase() || '•';
}
function initialsFrom(first?: string | null, last?: string | null, fallback?: string | null): string {
  const f = (first || '').trim();
  const l = (last || '').trim();
  if (f || l) return `${f.charAt(0)}${l.charAt(0)}`.toUpperCase() || '?';
  const n = (fallback || '').trim();
  if (!n) return '?';
  const parts = n.split(/[\s@._-]+/).filter(Boolean);
  return (parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : n.slice(0, 2)).toUpperCase();
}

interface ExpiryInfo {
  state: 'expired' | 'soon' | 'ok';
  label: string;
  chip: 'red' | 'amber' | 'neutral';
}
function expiryInfo(iso: string | null | undefined): ExpiryInfo | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { state: 'expired', label: i18n.t('vault:expiry.expired'), chip: 'red' };
  if (days <= 14)
    return {
      state: 'soon',
      label: days === 0 ? i18n.t('vault:expiry.today') : i18n.t('vault:expiry.inDays', { days }),
      chip: 'amber',
    };
  return { state: 'ok', label: i18n.t('vault:expiry.inDays', { days }), chip: 'neutral' };
}

function pwStrength(pw: string): 1 | 2 | 3 | 4 {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const lenScore = pw.length >= 16 ? 2 : pw.length >= 10 ? 1 : 0;
  const raw = classes + lenScore;
  if (raw >= 5) return 4;
  if (raw >= 4) return 3;
  if (raw >= 2) return 2;
  return 1;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

const PERM_LABEL_KEY: Record<number, string> = { 15: 'perm.owner', 7: 'perm.edit', 1: 'perm.read' };

// ---------------------------------------------------------------------------
// Encrypted secret field — the E2EE reveal moment
// ---------------------------------------------------------------------------
function SecretField({
  resource,
  slug,
  isV5,
  onDecrypted,
}: {
  resource: Resource;
  slug: string | undefined;
  isV5: boolean;
  onDecrypted: (content: { password: string; description: string }) => void;
}) {
  const { t } = useTranslation('vault');
  const { decrypt, isLocked } = useKey();
  const toast = useToast();
  const { prefs } = useTheme();

  const [state, setState] = useState<'locked' | 'decrypting' | 'open'>('locked');
  const [password, setPassword] = useState('');
  const [remain, setRemain] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const relockRef = useRef<number | null>(null);

  const relock = useCallback(() => {
    if (relockRef.current) window.clearInterval(relockRef.current);
    relockRef.current = null;
    setPassword('');
    setRemain(0);
    setState('locked');
  }, []);

  // Wipe plaintext + timers on unmount.
  useEffect(
    () => () => {
      if (relockRef.current) window.clearInterval(relockRef.current);
    },
    [],
  );

  const reveal = useCallback(async () => {
    if (state !== 'locked' || isLocked) return;
    setState('decrypting');
    setError(null);
    try {
      const secret = await getSecretForResource(resource.id);
      const plaintext = await decrypt(secret.data);
      const content = decodeSecret(slug, plaintext);
      setPassword(content.password);
      onDecrypted(content);
      setState('open');
      // Auto re-lock countdown.
      const secs = Math.max(1, prefs.revealSecs);
      setRemain(secs);
      relockRef.current = window.setInterval(() => {
        setRemain((r) => {
          if (r <= 1) {
            relock();
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    } catch (err) {
      setError(describeApiError(err));
      setState('locked');
    }
  }, [state, isLocked, resource.id, decrypt, slug, prefs.revealSecs, relock, onDecrypted]);

  const copyBurn = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success(t('secret.copiedBurn', { seconds: prefs.burnSecs }));
      window.setTimeout(() => {
        navigator.clipboard?.writeText('').catch(() => {});
      }, prefs.burnSecs * 1000);
    } catch {
      toast.error(t('secret.clipboardError'));
    }
  }, [password, prefs.burnSecs, toast, t]);

  const open = state === 'open';
  const dots = '•'.repeat(12);
  const strength = open ? pwStrength(password) : 3;

  return (
    <div className={`field secret-field${open ? ' unlocked' : ''}${state === 'decrypting' ? ' decrypting' : ''}`}>
      <div className="field-label">
        {open ? <Unlock /> : <Lock />}
        {t('secret.passwordLabel')} · {open ? t('secret.decryptedLocal') : t('secret.encryptedStored')}
      </div>
      <div className="field-row">
        {open ? (
          <div className="secret-plain mono">{password}</div>
        ) : (
          <div className={`secret-cipher${state === 'decrypting' ? ' scramble' : ''}`}>
            <Lock className="lk" />
            {state === 'decrypting' ? t('secret.decrypting') : dots}
          </div>
        )}
        {open ? (
          <button className="copybtn" title={t('actions.copyPassword')} onClick={() => void copyBurn()}>
            <Copy />
          </button>
        ) : (
          <button className="btn sm" onClick={() => void reveal()} disabled={state === 'decrypting' || isLocked}>
            <Eye /> {state === 'decrypting' ? t('secret.decryptingShort') : t('secret.reveal')}
          </button>
        )}
      </div>

      {state === 'decrypting' && (
        <div className="decrypt-bar">
          <i />
        </div>
      )}

      {error && (
        <div className="pf-err" style={{ marginTop: 9 }}>
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      {open && (
        <div className="relock-note">
          <Clock /> {t('secret.relockNote', { seconds: remain })}{' '}
          <button onClick={relock} type="button">
            {t('actions.lockNow')}
          </button>
        </div>
      )}

      <div className="field-foot">
        <div className={`strength s${strength}`}>
          {t('secret.strength')}
          <div className="bars">
            <i />
            <i />
            <i />
            <i />
          </div>
          {open && (
            <span
              style={{
                color: strength >= 4 ? 'var(--green-text)' : strength <= 2 ? 'var(--amber-text)' : 'var(--text-3)',
              }}
            >
              {strength >= 4 ? t('secret.strengthStrong') : strength === 3 ? t('secret.strengthGood') : t('secret.strengthWeak')}
            </span>
          )}
        </div>
        <span>·</span>
        <span>{isV5 ? t('secret.v5MetadataEncrypted') : t('secret.e2ee')}</span>
      </div>
    </div>
  );
}

function PlainField({ label, icon, value }: { label: string; icon: ReactNode; value: string }) {
  const { t } = useTranslation('vault');
  const toast = useToast();
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setOk(true);
      toast.success(t('copy.copied', { label }));
      window.setTimeout(() => setOk(false), 1400);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="field">
      <div className="field-label">
        {icon} {label}
      </div>
      <div className="field-row">
        <div className="field-val mono">{value || '—'}</div>
        {value && (
          <button className={`copybtn${ok ? ' ok' : ''}`} title={t('common:actions.copy')} onClick={() => void copy()}>
            {ok ? <Check /> : <Copy />}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
interface SecretPanelProps {
  resource: Resource;
  resourceTypes: ResourceType[];
  onEdit: (resource: Resource) => void;
  onShare: (resource: Resource) => void;
  onToggleFavorite: (resource: Resource) => void;
  onDelete?: (resource: Resource) => void;
  /** Open the standalone "移动到…" dialog (folder change is separate from edit). */
  onMove?: (resource: Resource) => void;
  favBusy?: boolean;
}

export function SecretPanel({
  resource,
  resourceTypes,
  onEdit,
  onShare,
  onToggleFavorite,
  onDelete,
  onMove,
  favBusy,
}: SecretPanelProps) {
  const { t } = useTranslation('vault');
  const [tab, setTab] = useState<'detail' | 'shared' | 'comment'>('detail');

  const slug = resourceTypes.find((rt) => rt.id === resource.resource_type_id)?.slug;
  const isV5 = isV5Resource(resource);
  const usesEncryptedDescription = !isV5 && isEncryptedDescriptionType(slug);

  // Description shown in the detail tab. v5 / v4-cleartext descriptions come off
  // the (already-resolved) resource; the encrypted-description type fills in once
  // the secret is decrypted.
  const [encDescription, setEncDescription] = useState('');
  const description = usesEncryptedDescription ? encDescription : resource.description;

  // Current ACL (lazy: loaded once per resource for the access count + 共享 tab).
  const [perms, setPerms] = useState<PermissionWithAro[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPerms(null);
    (async () => {
      try {
        const p = (await getResourcePermissions(resource.id, {
          containUser: true,
          containUserProfile: true,
          containGroup: true,
        })) as PermissionWithAro[];
        if (!cancelled) setPerms(p);
      } catch {
        if (!cancelled) setPerms([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resource.id]);

  // Comments (lazy: loaded when the 评论 tab is first opened).
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const toast = useToast();
  const loadComments = useCallback(async () => {
    try {
      const list = await listComments(resource.id, { creator: true });
      setComments(list);
    } catch {
      setComments([]);
    }
  }, [resource.id]);
  useEffect(() => {
    if (tab === 'comment' && comments === null) void loadComments();
  }, [tab, comments, loadComments]);

  const submitComment = async () => {
    const content = draft.trim();
    if (!content) return;
    setPosting(true);
    try {
      await addComment(resource.id, { content });
      setDraft('');
      await loadComments();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setPosting(false);
    }
  };

  const exp = expiryInfo(resource.expired);
  const color = tileColor(resource.id);
  const accessCount = perms?.length;

  return (
    <div className="panel fadein">
      <div className="panel-scroll">
        {/* header */}
        <div className="panel-head">
          <div className="panel-ico" style={{ background: color }}>
            {tileLetter(resource.name)}
          </div>
          <div className="panel-htext">
            <h2>
              {resource.name}
              {resource.favorite && <Star size={17} style={{ color: 'var(--gold)', fill: 'var(--gold)' }} />}
            </h2>
            {resource.uri && (
              <div className="uri">
                <LinkIcon />
                <a
                  href={/^https?:\/\//.test(resource.uri) ? resource.uri : `https://${resource.uri}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {resource.uri}
                </a>
              </div>
            )}
            <div className="panel-meta-row">
              <span className="chip neutral">
                <Lock /> {t('panel.e2ee')}
              </span>
              {exp && (
                <span className={`chip ${exp.chip}`}>
                  {exp.state === 'expired' ? <AlertTriangle /> : <Clock />} {exp.label}
                </span>
              )}
              {accessCount !== undefined && (
                <span className="chip neutral">
                  <Share2 /> {t('panel.accessCount', { count: accessCount })}
                </span>
              )}
            </div>
          </div>
          <div className="panel-actions">
            <button
              className={`iconbtn${resource.favorite ? ' on' : ''}`}
              title={resource.favorite ? t('actions.unfavorite') : t('actions.favorite')}
              onClick={() => onToggleFavorite(resource)}
              disabled={favBusy}
            >
              <Star style={resource.favorite ? { fill: 'currentColor' } : undefined} />
            </button>
            <button className="iconbtn" title={t('common:actions.edit')} onClick={() => onEdit(resource)}>
              <Pencil />
            </button>
            {onMove && (
              <button className="iconbtn" title={t('actions.moveTo')} onClick={() => onMove(resource)}>
                <MoveIcon />
              </button>
            )}
            {onDelete && (
              <button
                className="iconbtn"
                title={t('common:actions.delete')}
                style={{ color: 'var(--red-text)' }}
                onClick={() => onDelete(resource)}
              >
                <Trash2 />
              </button>
            )}
            <button className="btn primary" onClick={() => onShare(resource)}>
              <Share2 /> {t('actions.share')}
            </button>
          </div>
        </div>

        {/* tabs */}
        <div className="panel-tabs">
          <button className={`ptab${tab === 'detail' ? ' active' : ''}`} onClick={() => setTab('detail')}>
            <KeyRound /> {t('panel.tabDetail')}
          </button>
          <button className={`ptab${tab === 'shared' ? ' active' : ''}`} onClick={() => setTab('shared')}>
            <Share2 /> {t('panel.tabShared')} {accessCount !== undefined && <span className="num">{accessCount}</span>}
          </button>
          <button className={`ptab${tab === 'comment' ? ' active' : ''}`} onClick={() => setTab('comment')}>
            <MessageSquare /> {t('panel.tabComment')} {comments && comments.length > 0 && <span className="num">{comments.length}</span>}
          </button>
        </div>

        {tab === 'detail' && (
          <div className="panel-body">
            <PlainField label={t('panel.fieldUsername')} icon={<UserIcon />} value={resource.username} />
            <SecretField
              resource={resource}
              slug={slug}
              isV5={isV5}
              onDecrypted={(c) => {
                if (usesEncryptedDescription) setEncDescription(c.description);
              }}
            />
            {description && (
              <div className="field">
                <div className="field-label">
                  <MessageSquare /> {t('panel.fieldDescription')}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {description}
                </div>
              </div>
            )}
            <div style={{ padding: '4px 2px' }}>
              <div className="drow">
                <div className="dk">{t('panel.lastModified')}</div>
                <div className="dv">{formatDate(resource.modified)}</div>
              </div>
              <div className="drow">
                <div className="dk">{t('panel.createdAt')}</div>
                <div className="dv">{formatDate(resource.created)}</div>
              </div>
              <div className="drow">
                <div className="dk">{t('panel.resourceId')}</div>
                <div className="dv mono">{resource.id.toUpperCase()}</div>
              </div>
            </div>
          </div>
        )}

        {tab === 'shared' && (
          <div className="panel-body">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                <Trans
                  i18nKey="panel.encryptedForCount"
                  t={t}
                  values={{ count: accessCount ?? '…' }}
                  components={[<span />, <b style={{ color: 'var(--text-2)' }} />]}
                />
              </span>
              <button className="btn sm" onClick={() => onShare(resource)}>
                <Plus /> {t('actions.add')}
              </button>
            </div>
            {perms === null ? (
              <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: '20px 0', fontSize: 13 }}>
                <span className="spin-ring" /> {t('panel.loadingAccess')}
              </div>
            ) : perms.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: '20px 0', fontSize: 13 }}>
                {t('panel.noOtherViewers')}
              </div>
            ) : (
              <div>
                {perms.map((p) => {
                  const isGroup = p.aro === 'Group';
                  const name = isGroup
                    ? p.group?.name ?? t('panel.groupFallback')
                    : [p.user?.profile?.first_name, p.user?.profile?.last_name].filter(Boolean).join(' ') ||
                      p.user?.username ||
                      t('panel.userFallback');
                  const email = isGroup ? t('panel.groupShare') : p.user?.username ?? '';
                  const av = isGroup ? (
                    <span className="aro-av" style={{ background: tileColor(p.aro_foreign_key) }}>
                      <UsersIcon size={15} />
                    </span>
                  ) : (
                    <span className="aro-av round" style={{ background: tileColor(p.aro_foreign_key) }}>
                      {initialsFrom(p.user?.profile?.first_name, p.user?.profile?.last_name, p.user?.username)}
                    </span>
                  );
                  return (
                    <div className="aro-line" key={p.id}>
                      {av}
                      <div className="aro-info">
                        <div className="an">{name}</div>
                        <div className="ae">{email}</div>
                      </div>
                      <span className={`perm-badge${p.type === 15 ? ' owner' : ''}`}>
                        {PERM_LABEL_KEY[p.type] ? t(PERM_LABEL_KEY[p.type]) : t('panel.permLevel', { level: p.type })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'comment' && (
          <div className="panel-body">
            {comments === null ? (
              <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: '20px 0', fontSize: 13 }}>
                <span className="spin-ring" /> {t('panel.loadingComments')}
              </div>
            ) : comments.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: '20px 0 8px', fontSize: 13 }}>
                {t('panel.noComments')}
              </div>
            ) : (
              comments.map((c) => {
                const author = c.creator;
                const name =
                  [author?.profile?.first_name, author?.profile?.last_name].filter(Boolean).join(' ') ||
                  author?.username ||
                  t('panel.userFallback');
                return (
                  <div className="comment" key={c.id}>
                    <div className="face" style={{ background: tileColor(c.user_id) }}>
                      {initialsFrom(author?.profile?.first_name, author?.profile?.last_name, author?.username)}
                    </div>
                    <div className="cbody">
                      <div className="chead">
                        <b>{name}</b>
                        <span className="t">{formatDate(c.created)}</span>
                      </div>
                      <div className="ctext">{c.content}</div>
                    </div>
                  </div>
                );
              })
            )}
            <div className="comment-box">
              <textarea
                placeholder={t('panel.commentPlaceholder')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) void submitComment();
                }}
              />
              <button
                className="btn primary sm"
                disabled={!draft.trim() || posting}
                style={{ alignSelf: 'flex-end' }}
                onClick={() => void submitComment()}
              >
                {posting ? t('panel.sendingComment') : t('panel.sendComment')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SecretPanel;
