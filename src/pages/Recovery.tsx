// Recovery.tsx — the public account-recovery flow (账户 → 验证 → 重设 → 完成).
//
// CE recovery semantics (parity with the PHP Recover controller): recovery does
// NOT mint a NEW key. The user RE-IMPORTS their EXISTING passphrase-protected
// private-key backup; the server checks that the submitted PUBLIC key's
// fingerprint matches the key it already has on file for this account. A
// fingerprint mismatch is rejected by the backend (surfaced verbatim).
//
// Two entry modes (both reached via /recover, with or without a token):
//   * Request mode (no userId+token in the URL): step 0 collects the account
//     email and calls requestRecovery({ username }); the backend emails/logs a
//     recover link. We then show a "查收邮件" confirmation.
//   * Complete mode (URL carries userId+token): startRecovery validates the link
//     and returns the identity; the user imports their existing .asc private key
//     backup + passphrase (verified locally via openpgp.decryptKey to derive the
//     public key + fingerprint); completeRecovery uploads ONLY the public key
//     (the server enforces the fingerprint match), then the standard post-
//     credential handoff: setArmoredKeys(privateKey) + unlock(passphrase) + '/'.
//
// SECURITY: the armored PRIVATE key + passphrase live in component state ONLY and
// never touch the network. completeRecovery sends ONLY the armored public key.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as openpgp from 'openpgp';
import {
  KeyRound,
  Lock,
  Download,
  Users,
  ShieldCheck,
  AlertTriangle,
  Eye,
  EyeOff,
  Unlock,
  Fingerprint,
  RefreshCw,
  User as UserIcon,
  Mail,
  CheckCircle2,
  X,
  Puzzle,
} from 'lucide-react';
import { fingerprintOf } from '../gpg';
import { useKey } from '../crypto/KeyContext';
import { loginWithGpg } from '../auth';
import { requestRecovery, startRecovery, completeRecovery } from '../services/setup';
import { Stepper } from './flowHelpers';
import KeyFileButton from '../components/KeyFileButton';
import { describeApiError } from '../i18n/errors';
import i18n from '../i18n';
import type { User } from '../types';

/** The supported recovery method (CE): re-import the existing key backup. */
type VerifyMethod = 'backup' | 'code' | 'admin';

/** Pretty-print an armored fingerprint into spaced 4-char groups. */
function formatFingerprint(fp: string): string {
  const up = fp.toUpperCase().replace(/\s+/g, '');
  return up.replace(/(.{4})/g, '$1 ').trim();
}

/** Full display name from a profile, falling back to the username. */
function fullName(user: User | null): string {
  const f = user?.profile?.first_name?.trim() ?? '';
  const l = user?.profile?.last_name?.trim() ?? '';
  return [f, l].filter(Boolean).join(' ') || user?.username || i18n.t('auth:recovery.accountFallback');
}

export default function Recovery() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const { setArmoredKeys, unlock } = useKey();
  const STEPS = [
    t('recovery.steps.account'),
    t('recovery.steps.verify'),
    t('recovery.steps.reset'),
    t('recovery.steps.done'),
  ];

  // Accept BOTH /recover/:userId/:tokenId AND /recover?user_id=...&token=...
  const params = useParams<{ userId?: string; tokenId?: string }>();
  const [search] = useSearchParams();
  const userId = params.userId ?? search.get('user_id') ?? '';
  const token = params.tokenId ?? search.get('token') ?? '';
  // Complete mode iff the link carries both a user id and a token.
  const isComplete = Boolean(userId && token);

  // Optional "install the extension" prompt (the recovery page works fully in the
  // web app without it — this mirrors official Passbolt's install hint). The
  // extension's content script sets <html data-jpassbolt-extension>; it injects
  // asynchronously, so watch for the attribute appearing.
  const [extInstalled, setExtInstalled] = useState(false);
  const [extDismissed, setExtDismissed] = useState(false);
  useEffect(() => {
    const has = () => Boolean(document.documentElement.getAttribute('data-jpassbolt-extension'));
    if (has()) {
      setExtInstalled(true);
      return;
    }
    const obs = new MutationObserver(() => {
      if (has()) {
        setExtInstalled(true);
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-jpassbolt-extension'],
    });
    const timer = window.setTimeout(() => obs.disconnect(), 3000);
    return () => {
      obs.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // Flow state. In complete mode we land directly on step 1 (验证) after the link
  // validates; in request mode we stay on step 0 (账户) to collect the email.
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Request mode — email + "email sent" confirmation.
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  // Complete mode — validated identity + import method.
  const [user, setUser] = useState<User | null>(null);
  const [linkValidated, setLinkValidated] = useState(false);
  const [method, setMethod] = useState<VerifyMethod>('backup');
  const [importArmored, setImportArmored] = useState('');

  // Passphrase (used to unlock the imported private key — NOT a new passphrase).
  const [pf, setPf] = useState('');
  const [showPf, setShowPf] = useState(false);

  // Derived key material (client-side ONLY — only the PUBLIC key is uploaded).
  const [armoredPrivateKey, setArmoredPrivateKey] = useState('');
  const [armoredPublicKey, setArmoredPublicKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');

  const emailOk = /\S+@\S+\.\S+/.test(email);

  // ---- Request mode (step 0): ask the backend to email a recover link ----
  const sendRecoveryEmail = async () => {
    if (loading || !emailOk) return;
    setLoading(true);
    setError('');
    try {
      await requestRecovery({ username: email.trim() });
      setSent(true);
    } catch (err: unknown) {
      // Backends often respond 200 regardless (to avoid account enumeration); if
      // a real error comes back, surface it verbatim.
      setError(describeApiError(err) || t('recovery.errors.sendFailed'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Complete mode: validate the recover link, then enter the verify step ----
  const validateLink = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const u = await startRecovery(userId, token);
      setUser(u);
      setLinkValidated(true);
      setStep(1);
    } catch (err: unknown) {
      setError(describeApiError(err) || t('recovery.errors.linkInvalid'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Complete mode (step 1 -> 2): verify the imported private key unlocks ----
  // We do NOT generate a key. We read the pasted .asc backup, confirm it is
  // passphrase-protected and that THIS passphrase unlocks it, then derive its
  // public key + fingerprint to upload (the server checks the fingerprint match).
  const verifyImportAndAdvance = async () => {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const armored = importArmored.trim();
      if (!armored) {
        throw new Error(t('recovery.errors.missingBackup'));
      }
      const parsed = await openpgp.readPrivateKey({ armoredKey: armored });
      if (parsed.isDecrypted()) {
        throw new Error(t('recovery.errors.keyNotProtected'));
      }
      // Throws if the passphrase is wrong (verified entirely client-side).
      await openpgp.decryptKey({ privateKey: parsed, passphrase: pf });
      const pub = parsed.toPublic().armor();
      const fp = await fingerprintOf(pub);
      setArmoredPrivateKey(armored);
      setArmoredPublicKey(pub);
      setFingerprint(fp);
      setStep(2);
    } catch (err: unknown) {
      setError(describeApiError(err) || t('recovery.errors.unlockFailed'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Complete mode (step 2 -> 3): finalize recovery + post-credential handoff ----
  const finishRecovery = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      // Upload ONLY the armored PUBLIC key. The server enforces that its
      // fingerprint matches the key already on file for this account; on
      // mismatch it rejects (surfaced verbatim, e.g. "该密钥不属于此用户").
      await completeRecovery(userId, { token, armoredPublicKey });
      // recover/complete issues NO JWT (matching PHP). Log in with the recovered
      // key to obtain a session token, else ProtectedRoute bounces us to /login.
      await loginWithGpg(armoredPrivateKey, pf);
      // Standard Login/Setup handoff: persist the passphrase-protected private
      // key, unlock it in memory with the just-entered passphrase, enter vault.
      setArmoredKeys(armoredPrivateKey, armoredPublicKey);
      await unlock(pf);
      setStep(3);
    } catch (err: unknown) {
      setError(describeApiError(err) || t('recovery.errors.recoverFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flow-overlay">
      <div className="flow-card">
        <div className="flow-top">
          <div className="flow-brand">
            <span className="lg">
              <KeyRound />
            </span>
            <span className="bn">{t('recovery.brand')}</span>
            <button
              className="iconbtn bx"
              onClick={() => navigate('/login')}
              title={t('recovery.backToLogin')}
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: 'none',
                color: 'var(--text-3)',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <X size={18} />
            </button>
          </div>
          <Stepper steps={STEPS} cur={step} />
        </div>

        <div className="flow-body">
          {!extInstalled && !extDismissed && (
            <div
              className="warnbox"
              style={{ marginBottom: 16, alignItems: 'flex-start', gap: 10 }}
            >
              <Puzzle />
              <div style={{ flex: 1 }}>
                <strong>{t('extPrompt.title')}</strong>
                <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>
                  {t('extPrompt.descRecovery')}
                </div>
              </div>
              <button
                type="button"
                className="pf-eye"
                onClick={() => setExtDismissed(true)}
                title={t('extPrompt.dismiss')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="warnbox" style={{ marginBottom: 16 }}>
              <AlertTriangle />
              <div>{error}</div>
            </div>
          )}

          {/* 0 · account (request mode: email; complete mode: validate link) */}
          {step === 0 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <RefreshCw />
                </div>
                <h2>{t('recovery.request.title')}</h2>
                <p>
                  {t('recovery.request.subtitle')}
                </p>
              </div>

              {isComplete ? (
                <>
                  <div className="invite-meta" style={{ marginBottom: 18 }}>
                    <div className="invite-line">
                      <Mail />
                      <span className="k">{t('recovery.request.linkLabel')}</span>
                      <span className="v" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
                        {t('recovery.request.linkPending')}
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn primary"
                    style={{ width: '100%', height: 44, fontSize: 14 }}
                    onClick={validateLink}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <span className="spin-ring" /> {t('recovery.request.validating')}
                      </>
                    ) : (
                      t('recovery.request.validateAndContinue')
                    )}
                  </button>
                  <div className="flow-note">
                    <ShieldCheck /> {t('recovery.request.noteNoExpose')}
                  </div>
                </>
              ) : sent ? (
                <>
                  <div className="kit-row" style={{ marginTop: 2 }}>
                    <span
                      className="kr-ico"
                      style={{ background: 'var(--green-soft)', color: 'var(--green-text)' }}
                    >
                      <CheckCircle2 />
                    </span>
                    <div className="kr-t">
                      <div className="a">{t('recovery.request.sentTitle')}</div>
                      <div className="b">
                        {t('recovery.request.sentDesc')}
                      </div>
                    </div>
                  </div>
                  <div className="warn-soft">
                    <Mail /> {t('recovery.request.sentHint')}
                  </div>
                  <div className="flow-note">
                    <ShieldCheck /> {t('recovery.request.noteNoExpose')}
                  </div>
                </>
              ) : (
                <>
                  <div className="pf-label">
                    <UserIcon size={15} /> {t('recovery.request.emailLabel')}
                  </div>
                  <div className="pf-input">
                    <Mail size={17} />
                    <input
                      type="email"
                      autoFocus
                      value={email}
                      placeholder={t('recovery.request.emailPlaceholder')}
                      style={{ letterSpacing: 0, fontFamily: 'var(--sans)' }}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <button
                    className="btn primary"
                    style={{ width: '100%', height: 44, marginTop: 18, fontSize: 14 }}
                    disabled={!emailOk || loading}
                    onClick={sendRecoveryEmail}
                  >
                    {loading ? (
                      <>
                        <span className="spin-ring" /> {t('recovery.request.sending')}
                      </>
                    ) : (
                      t('recovery.request.continue')
                    )}
                  </button>
                  <div className="flow-note">
                    <ShieldCheck /> {t('recovery.request.noteNoExposeOld')}
                  </div>
                </>
              )}
            </>
          )}

          {/* 1 · verify (complete mode): import the existing key backup + passphrase */}
          {step === 1 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <ShieldCheck />
                </div>
                <h2>{t('recovery.verify.title')}</h2>
                <p>
                  {t('recovery.verify.subtitlePrefix')}
                  {linkValidated && user ? ` ${fullName(user)} ` : ` ${t('recovery.verify.subtitleAccountFallback')}`}
                  {t('recovery.verify.subtitleSuffix')}
                </p>
              </div>

              {/* Supported method: import an existing key backup. */}
              <div
                className={'opt-card' + (method === 'backup' ? ' sel' : '')}
                onClick={() => setMethod('backup')}
              >
                <span className="oc-ico">
                  <Download />
                </span>
                <div className="oc-t">
                  <div className="a">
                    {t('recovery.verify.methodBackupTitle')} <span className="recommend">{t('recovery.verify.methodBackupBadge')}</span>
                  </div>
                  <div className="b">{t('recovery.verify.methodBackupDesc')}</div>
                </div>
                <span className="oc-radio" />
              </div>

              {/* Present-but-unsupported methods (honest: disabled / 暂未支持). */}
              <div
                className="opt-card"
                style={{ opacity: 0.55, cursor: 'not-allowed' }}
                title={t('recovery.verify.unsupportedTitle')}
              >
                <span className="oc-ico">
                  <KeyRound />
                </span>
                <div className="oc-t">
                  <div className="a">
                    {t('recovery.verify.methodCodeTitle')} <span className="recommend" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>{t('recovery.verify.unsupportedBadge')}</span>
                  </div>
                  <div className="b">{t('recovery.verify.methodCodeDesc')}</div>
                </div>
                <span className="oc-radio" />
              </div>
              <div
                className="opt-card"
                style={{ opacity: 0.55, cursor: 'not-allowed' }}
                title={t('recovery.verify.unsupportedTitle')}
              >
                <span className="oc-ico">
                  <Users />
                </span>
                <div className="oc-t">
                  <div className="a">
                    {t('recovery.verify.methodAdminTitle')} <span className="recommend" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>{t('recovery.verify.unsupportedBadge')}</span>
                  </div>
                  <div className="b">{t('recovery.verify.methodAdminDesc')}</div>
                </div>
                <span className="oc-radio" />
              </div>

              {method === 'backup' && (
                <>
                  <div
                    className="pf-label"
                    style={{ display: 'flex', alignItems: 'center', margin: '0 0 6px' }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Download size={15} /> {t('recovery.verify.pasteLabel')}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      {/* 可选：选择本地 .asc 私钥备份文件填入下方文本框；仍可直接粘贴。文件仅在浏览器内读取。 */}
                      <KeyFileButton onLoaded={(txt) => setImportArmored(txt)} label={t('recovery.verify.chooseBackup')} />
                    </span>
                  </div>
                  <textarea
                    className="flow-textarea"
                    placeholder={t('recovery.verify.keyPlaceholder')}
                    value={importArmored}
                    onChange={(e) => setImportArmored(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    style={{ marginTop: 6 }}
                  />

                  <div className="pf-label" style={{ marginTop: 14 }}>
                    <KeyRound size={15} /> {t('recovery.verify.passphraseLabel')}
                  </div>
                  <div className="pf-input">
                    <Lock size={17} />
                    <input
                      type={showPf ? 'text' : 'password'}
                      value={pf}
                      placeholder={t('recovery.verify.passphrasePlaceholder')}
                      onChange={(e) => setPf(e.target.value)}
                    />
                    <button
                      type="button"
                      className="pf-eye"
                      onClick={() => setShowPf((s) => !s)}
                    >
                      {showPf ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </>
              )}

              <div className="flow-foot">
                <button className="btn" onClick={() => navigate('/login')}>
                  {t('recovery.verify.backToLogin')}
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  disabled={
                    method !== 'backup' ||
                    importArmored.trim().length === 0 ||
                    pf.length === 0 ||
                    loading
                  }
                  onClick={verifyImportAndAdvance}
                >
                  {loading ? (
                    <>
                      <span className="spin-ring" /> {t('recovery.verify.verifyingKey')}
                    </>
                  ) : (
                    t('recovery.verify.next')
                  )}
                </button>
              </div>
            </>
          )}

          {/* 2 · reset (complete mode): confirm + submit to the server */}
          {step === 2 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <Lock />
                </div>
                <h2>{t('recovery.reset.title')}</h2>
                <p>
                  {t('recovery.reset.subtitle')}
                </p>
              </div>

              <div className="done-fp">
                <div className="dfp-l">
                  <Fingerprint /> {t('recovery.reset.fingerprintLabel')}
                </div>
                <div className="dfp-v">{formatFingerprint(fingerprint)}</div>
              </div>

              <div className="invite-meta" style={{ marginBottom: 18 }}>
                <div className="invite-line">
                  <UserIcon />
                  <span className="k">{t('recovery.reset.accountLabel')}</span>
                  <span className="v">{fullName(user)}</span>
                </div>
                <div className="invite-line">
                  <Mail />
                  <span className="k">{t('recovery.reset.usernameLabel')}</span>
                  <span className="v mono" style={{ fontSize: 12.5 }}>
                    {user?.username ?? ''}
                  </span>
                </div>
              </div>

              <div className="warn-soft">
                <AlertTriangle /> {t('recovery.reset.warning')}
              </div>

              <div className="flow-foot">
                <button className="btn" onClick={() => setStep(1)} disabled={loading}>
                  {t('recovery.reset.prev')}
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  disabled={loading}
                  onClick={finishRecovery}
                >
                  {loading ? (
                    <>
                      <span className="spin-ring" /> {t('recovery.reset.recovering')}
                    </>
                  ) : (
                    <>
                      <RefreshCw size={16} /> {t('recovery.reset.recover')}
                    </>
                  )}
                </button>
              </div>
            </>
          )}

          {/* 3 · done (complete mode): recovered, enter the vault */}
          {step === 3 && (
            <>
              <div className="flow-h">
                <div className="flow-badge green">
                  <ShieldCheck />
                </div>
                <h2>{t('recovery.done.title')}</h2>
                <p>{t('recovery.done.subtitle')}</p>
              </div>

              <div className="invite-meta" style={{ marginBottom: 18 }}>
                <div className="invite-line">
                  <CheckCircle2 />
                  <span className="k">{t('recovery.done.identityLabel')}</span>
                  <span className="v" style={{ marginLeft: 'auto', color: 'var(--green-text)' }}>
                    {t('recovery.done.identityValue')}
                  </span>
                </div>
                <div className="invite-line">
                  <KeyRound />
                  <span className="k">{t('recovery.done.fingerprintLabel')}</span>
                  <span className="v" style={{ marginLeft: 'auto', color: 'var(--green-text)' }}>
                    {t('recovery.done.fingerprintValue')}
                  </span>
                </div>
                <div className="invite-line">
                  <Unlock />
                  <span className="k">{t('recovery.done.vaultLabel')}</span>
                  <span className="v" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
                    {t('recovery.done.vaultValue')}
                  </span>
                </div>
              </div>

              <button
                className="btn primary"
                style={{ width: '100%', height: 44, fontSize: 14 }}
                onClick={() => navigate('/')}
              >
                <Unlock size={16} /> {t('recovery.done.enterVault')}
              </button>
              <div className="flow-note">
                <ShieldCheck /> {t('recovery.done.note')}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
