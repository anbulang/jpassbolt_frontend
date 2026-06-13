/**
 * SecretPanel — right slide-in drawer that fetches and decrypts a single
 * resource's secret in-memory and renders it in a PasswordField (masked, reveal,
 * copy). Plaintext is NEVER logged and is cleared from state on close / auto-clear.
 *
 * On open: GET /secrets/resource/{id}.json -> useKey().decrypt(secret.data).
 * If the vault is locked, shows an inline Unlock prompt instead of decrypting.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X, Lock, Globe, FileText, Clock, Share2, Pencil } from 'lucide-react';
import type { Resource, ResourceType } from '../../types';
import { getSecretForResource } from '../../services/secrets';
import { useKey } from '../../crypto/KeyContext';
import { useToast } from '../../components/toastContext';
import { Spinner } from '../../components/Spinner';
import { PasswordField } from '../../components/PasswordField';
import { decodeSecret, isEncryptedDescriptionType } from './secretFormat';

interface SecretPanelProps {
  resource: Resource | null;
  resourceTypes: ResourceType[];
  open: boolean;
  onClose: () => void;
  onEdit: (resource: Resource) => void;
  onShare: (resource: Resource) => void;
}

/** Clear copied plaintext from the clipboard after this many ms (best-effort). */
const CLIPBOARD_AUTO_CLEAR_MS = 30_000;

const labelStyle: CSSProperties = {
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-muted)',
  marginBottom: '4px',
};

const rowStyle: CSSProperties = { marginBottom: '18px' };

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function SecretPanel({
  resource,
  resourceTypes,
  open,
  onClose,
  onEdit,
  onShare,
}: SecretPanelProps) {
  const { decrypt, isLocked } = useKey();
  const toast = useToast();

  const [password, setPassword] = useState('');
  const [encDescription, setEncDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = resourceTypes.find((rt) => rt.id === resource?.resource_type_id)?.slug;
  const usesEncryptedDescription = isEncryptedDescriptionType(slug);

  const wipe = useCallback(() => {
    setPassword('');
    setEncDescription('');
    setError(null);
  }, []);

  useEffect(() => {
    if (!open || !resource) return;
    if (isLocked) {
      wipe();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const secret = await getSecretForResource(resource.id);
        const plaintext = await decrypt(secret.data);
        if (cancelled) return;
        const content = decodeSecret(slug, plaintext);
        setPassword(content.password);
        setEncDescription(content.description);
      } catch (err) {
        if (cancelled) return;
        const apiMsg = (err as { response?: { data?: { header?: { message?: string } } } })
          ?.response?.data?.header?.message;
        setError(apiMsg || (err instanceof Error ? err.message : 'Failed to decrypt secret.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, resource, isLocked, decrypt, slug, wipe]);

  // Wipe in-memory plaintext when the drawer is dismissed.
  useEffect(() => {
    if (!open) wipe();
  }, [open, wipe]);

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleCopied = useCallback(() => {
    toast.success('Password copied — clears in 30s');
    window.setTimeout(() => {
      // Best-effort clipboard clear; ignore if the clipboard API rejects.
      navigator.clipboard?.writeText('').catch(() => {});
    }, CLIPBOARD_AUTO_CLEAR_MS);
  }, [toast]);

  if (!open || !resource) return null;

  const description = usesEncryptedDescription ? encDescription : resource.description;

  return createPortal(
    <>
      <div className="drawer-overlay" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Resource details">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px',
            borderBottom: '1px solid var(--panel-border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <Lock size={18} color="var(--primary-color)" />
            <h3
              style={{
                margin: 0,
                fontSize: '17px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={resource.name}
            >
              {resource.name}
            </h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div
              style={{
                background: 'rgba(248, 81, 73, 0.1)',
                color: 'var(--danger-color)',
                border: '1px solid var(--danger-color)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 14px',
                marginBottom: '18px',
                fontSize: '13px',
              }}
            >
              {error}
            </div>
          )}

          {isLocked ? (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '24px 8px' }}>
              <Lock size={36} style={{ opacity: 0.5, marginBottom: '12px' }} />
              <p style={{ margin: 0 }}>Your vault is locked. Unlock it to reveal this secret.</p>
            </div>
          ) : (
            <>
              <div style={rowStyle}>
                <div style={labelStyle}>Username</div>
                <div style={{ wordBreak: 'break-all' }}>{resource.username || '—'}</div>
              </div>

              <div style={rowStyle}>
                <div style={labelStyle}>Password</div>
                {loading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)' }}>
                    <Spinner size={16} /> Decrypting…
                  </div>
                ) : (
                  <PasswordField value={password} readOnly onCopy={handleCopied} />
                )}
              </div>

              <div style={rowStyle}>
                <div style={labelStyle}>
                  <Globe size={12} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
                  URI
                </div>
                {resource.uri ? (
                  <a
                    href={resource.uri}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ color: 'var(--primary-hover)', wordBreak: 'break-all' }}
                  >
                    {resource.uri}
                  </a>
                ) : (
                  <div>—</div>
                )}
              </div>

              <div style={rowStyle}>
                <div style={labelStyle}>
                  <FileText size={12} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
                  Description
                </div>
                <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                  {loading && usesEncryptedDescription ? '…' : description || '—'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '24px', marginTop: '24px' }}>
                <div>
                  <div style={labelStyle}>
                    <Clock size={12} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
                    Created
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {formatDate(resource.created)}
                  </div>
                </div>
                <div>
                  <div style={labelStyle}>
                    <Clock size={12} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
                    Modified
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {formatDate(resource.modified)}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: '12px',
            padding: '16px 24px',
            borderTop: '1px solid var(--panel-border)',
          }}
        >
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => onShare(resource)}>
            <Share2 size={16} /> Share
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => onEdit(resource)}>
            <Pencil size={16} /> Edit
          </button>
        </div>
      </aside>
    </>,
    document.body
  );
}

export default SecretPanel;
