// Setup.tsx — the public account-onboarding flow (邀请 → 密钥 → 口令 → 完成).
//
// Reached via an emailed setup link, BEFORE the user has any session. It validates
// the link (startSetup), generates OR imports a passphrase-protected OpenPGP key
// entirely in-browser, uploads ONLY the armored PUBLIC key (completeSetup), then
// performs the exact post-credential handoff Login.tsx uses (setArmoredKeys +
// unlock + navigate('/')).
//
// SECURITY: the armored PRIVATE key + passphrase live in component state ONLY and
// never touch the network. The server receives only the public key.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as openpgp from 'openpgp';
import {
  Vault,
  KeyRound,
  Lock,
  Check,
  Download,
  ShieldCheck,
  AlertTriangle,
  Eye,
  EyeOff,
  Unlock,
  Fingerprint,
  User as UserIcon,
  Users,
  Globe,
  Mail,
  Puzzle,
  X,
} from 'lucide-react';
import { generateKeyPair, fingerprintOf } from '../gpg';
import { useKey } from '../crypto/KeyContext';
import { loginWithGpg } from '../auth';
import { startSetup, completeSetup } from '../services/setup';
import { Stepper, KeyGen, ppScore, PP_LABEL, downloadRecoveryKit } from './flowHelpers';
import KeyFileButton from '../components/KeyFileButton';
import { describeApiError } from '../i18n/errors';
import i18n from '../i18n';
import type { User } from '../types';

const BASE_URL = 'http://localhost:8080/api';

type KeyMode = 'gen' | 'import';

/** Pretty-print an armored fingerprint into the spaced 4-char groups Aegis shows. */
function formatFingerprint(fp: string): string {
  const up = fp.toUpperCase().replace(/\s+/g, '');
  return up.replace(/(.{4})/g, '$1 ').trim();
}

/** Full display name from a profile, falling back to the username. */
function fullName(user: User | null): string {
  const f = user?.profile?.first_name?.trim() ?? '';
  const l = user?.profile?.last_name?.trim() ?? '';
  return [f, l].filter(Boolean).join(' ') || user?.username || i18n.t('auth:setup.newMemberFallback');
}

export default function Setup() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const { setArmoredKeys, unlock } = useKey();
  const STEPS = [
    t('setup.steps.invite'),
    t('setup.steps.key'),
    t('setup.steps.passphrase'),
    t('setup.steps.done'),
  ];

  // Accept BOTH /setup/:userId/:tokenId AND /setup?user_id=...&token=...
  const params = useParams<{ userId?: string; tokenId?: string }>();
  const [search] = useSearchParams();
  const userId = params.userId ?? search.get('user_id') ?? '';
  const token = params.tokenId ?? search.get('token') ?? '';

  // Flow state
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 0 — invited user
  const [user, setUser] = useState<User | null>(null);
  const [inviteLoaded, setInviteLoaded] = useState(false);

  // Step 1 — key choice
  const [keyMode, setKeyMode] = useState<KeyMode>('gen');
  const [importArmored, setImportArmored] = useState('');
  const [generating, setGenerating] = useState(false);

  // Step 2 — passphrase
  const [pf, setPf] = useState('');
  const [pf2, setPf2] = useState('');
  const [show, setShow] = useState(false);

  // Derived key material (client-side ONLY — never uploaded as private key)
  const [armoredPrivateKey, setArmoredPrivateKey] = useState('');
  const [armoredPublicKey, setArmoredPublicKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');

  // Optional "install the extension" prompt (consistent with Login/Recovery; the
  // web app completes setup without it). The extension content script sets
  // <html data-jpassbolt-extension>; it injects async, so watch for it.
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

  const score = ppScore(pf);
  const match = pf.length > 0 && pf === pf2;
  const ppOk = score >= 3 && match;

  // ---- Step 0: validate the invite link ----
  const acceptInvite = async () => {
    if (loading) return;
    if (!userId || !token) {
      setError(t('setup.errors.missingLink'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const u = await startSetup(userId, token);
      setUser(u);
      setInviteLoaded(true);
      setStep(1);
    } catch (err: unknown) {
      setError(describeApiError(err) || t('setup.errors.inviteInvalid'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Step 2 -> Step 3: produce the key material behind the KeyGen animation ----
  // For generate-mode we run generateKeyPair(passphrase) here (the passphrase is now
  // known). For import-mode we verify the pasted private key unlocks with the
  // passphrase, then derive its public key + fingerprint. Either way we then advance.
  const produceKeyAndAdvance = async () => {
    if (loading) return;
    setError('');

    if (keyMode === 'gen') {
      setGenerating(true);
      try {
        const { armoredPrivateKey: priv, armoredPublicKey: pub, fingerprint: fp } =
          await generateKeyPair({
            name: fullName(user),
            email: user?.username ?? '',
            passphrase: pf,
          });
        setArmoredPrivateKey(priv);
        setArmoredPublicKey(pub);
        setFingerprint(fp);
        setGenerating(false);
        setStep(3);
      } catch (err: unknown) {
        setGenerating(false);
        setError(describeApiError(err) || t('setup.errors.genFailed'));
      }
      return;
    }

    // import-mode: verify the pasted private key unlocks with this passphrase.
    setLoading(true);
    try {
      const armored = importArmored.trim();
      if (!armored) {
        throw new Error(t('setup.errors.missingKey'));
      }
      const parsed = await openpgp.readPrivateKey({ armoredKey: armored });
      if (parsed.isDecrypted()) {
        throw new Error(t('setup.errors.keyNotProtected'));
      }
      // Throws if the passphrase is wrong.
      await openpgp.decryptKey({ privateKey: parsed, passphrase: pf });
      const pub = parsed.toPublic().armor();
      const fp = await fingerprintOf(pub);
      setArmoredPrivateKey(armored);
      setArmoredPublicKey(pub);
      setFingerprint(fp);
      setStep(3);
    } catch (err: unknown) {
      setError(describeApiError(err) || t('setup.errors.unlockFailed'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Step 3: complete setup + the proven post-credential handoff ----
  const enterVault = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      // Upload ONLY the armored PUBLIC key; activate the account.
      await completeSetup(userId, { token, armoredPublicKey });

      // setup/complete activates the account but issues NO JWT (matching PHP).
      // So perform a real GpgAuth login with the just-created key to obtain a
      // session JWT — otherwise ProtectedRoute (JWT gate) bounces us to /login.
      await loginWithGpg(armoredPrivateKey, pf);

      // Then the proven Login.tsx in-memory handoff: persist the passphrase-
      // protected private key, unlock it in memory, and enter the vault unlocked.
      setArmoredKeys(armoredPrivateKey, armoredPublicKey);
      await unlock(pf);
      navigate('/');
    } catch (err: unknown) {
      setError(describeApiError(err) || t('setup.errors.activateFailed'));
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
              <Vault />
            </span>
            <span className="bn">{t('brand')}</span>
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
                  {t('extPrompt.descSetup')}
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

          {/* 0 · invite */}
          {step === 0 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <Vault />
                </div>
                <h2>{t('setup.invite.title')}</h2>
                <p>{t('setup.invite.subtitle')}</p>
              </div>

              {inviteLoaded && user && (
                <div className="invite-meta" style={{ marginBottom: 18 }}>
                  <div className="invite-line">
                    <UserIcon />
                    <span className="k">{t('setup.invite.nameLabel')}</span>
                    <span className="v">{fullName(user)}</span>
                  </div>
                  <div className="invite-line">
                    <Mail />
                    <span className="k">{t('setup.invite.usernameLabel')}</span>
                    <span className="v mono" style={{ fontSize: 12.5 }}>
                      {user.username}
                    </span>
                  </div>
                  <div className="invite-line">
                    <Users />
                    <span className="k">{t('setup.invite.roleLabel')}</span>
                    <span className="v">{user.role?.name ?? 'user'}</span>
                  </div>
                  <div className="invite-line">
                    <Globe />
                    <span className="k">{t('setup.invite.serverLabel')}</span>
                    <span className="v mono" style={{ fontSize: 12.5 }}>
                      {BASE_URL}
                    </span>
                  </div>
                </div>
              )}

              <button
                className="btn primary"
                style={{ width: '100%', height: 44, fontSize: 14 }}
                onClick={acceptInvite}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spin-ring" /> {t('setup.invite.validating')}
                  </>
                ) : (
                  t('setup.invite.accept')
                )}
              </button>
              <div className="flow-note">
                <ShieldCheck /> {t('setup.invite.note')}
              </div>
            </>
          )}

          {/* 1 · key */}
          {step === 1 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <KeyRound />
                </div>
                <h2>{t('setup.key.title')}</h2>
                <p>{t('setup.key.subtitle')}</p>
              </div>

              <div
                className={'opt-card' + (keyMode === 'gen' ? ' sel' : '')}
                onClick={() => setKeyMode('gen')}
              >
                <span className="oc-ico">
                  <KeyRound />
                </span>
                <div className="oc-t">
                  <div className="a">
                    {t('setup.key.genTitle')} <span className="recommend">{t('setup.key.genBadge')}</span>
                  </div>
                  <div className="b">{t('setup.key.genDesc')}</div>
                </div>
                <span className="oc-radio" />
              </div>

              <div
                className={'opt-card' + (keyMode === 'import' ? ' sel' : '')}
                onClick={() => setKeyMode('import')}
              >
                <span className="oc-ico">
                  <Download />
                </span>
                <div className="oc-t">
                  <div className="a">{t('setup.key.importTitle')}</div>
                  <div className="b">{t('setup.key.importDesc')}</div>
                </div>
                <span className="oc-radio" />
              </div>

              {keyMode === 'import' && (
                <>
                  <div
                    className="pf-label"
                    style={{ display: 'flex', alignItems: 'center', margin: '4px 0 6px' }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <KeyRound size={15} /> {t('setup.key.pasteLabel')}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      {/* 可选：选择本地 .asc 私钥文件填入下方文本框；仍可直接粘贴。文件仅在浏览器内读取。 */}
                      <KeyFileButton onLoaded={(txt) => setImportArmored(txt)} />
                    </span>
                  </div>
                  <textarea
                    className="flow-textarea"
                    placeholder={t('setup.key.keyPlaceholder')}
                    value={importArmored}
                    onChange={(e) => setImportArmored(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    style={{ marginTop: 4 }}
                  />
                </>
              )}

              <div className="flow-foot">
                <button className="btn" onClick={() => setStep(0)}>
                  {t('setup.key.prev')}
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  onClick={() => setStep(2)}
                  disabled={keyMode === 'import' && importArmored.trim().length === 0}
                >
                  {t('setup.key.next')}
                </button>
              </div>
            </>
          )}

          {/* 2 · passphrase */}
          {step === 2 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <Lock />
                </div>
                <h2>{t('setup.passphrase.title')}</h2>
                <p>{t('setup.passphrase.subtitle')}</p>
              </div>

              {generating ? (
                <KeyGen onDone={() => { /* real key is produced by produceKeyAndAdvance */ }} />
              ) : (
                <>
                  <div className="pp-fields">
                    <div>
                      <div className="pf-label">
                        <KeyRound size={15} /> {t('setup.passphrase.label')}
                      </div>
                      <div className="pf-input">
                        <Lock size={17} />
                        <input
                          type={show ? 'text' : 'password'}
                          autoFocus
                          value={pf}
                          placeholder={t('setup.passphrase.placeholder')}
                          onChange={(e) => setPf(e.target.value)}
                        />
                        <button type="button" className="pf-eye" onClick={() => setShow((s) => !s)}>
                          {show ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </div>
                      {pf && (
                        <>
                          <div className={'pp-meter s' + score} style={{ marginTop: 10 }}>
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                          <div className="pp-meter-row">
                            <span style={{ color: 'var(--text-3)' }}>{t('setup.passphrase.strength')}</span>
                            <span
                              style={{
                                color: score >= 3 ? 'var(--green-text)' : 'var(--amber-text)',
                                fontWeight: 500,
                              }}
                            >
                              {PP_LABEL(score)}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    <div>
                      <div className="pf-label">
                        <Check size={15} /> {t('setup.passphrase.confirmLabel')}
                      </div>
                      <div className={'pf-input' + (pf2 && !match ? ' err' : '')}>
                        <Lock size={17} />
                        <input
                          type={show ? 'text' : 'password'}
                          value={pf2}
                          placeholder={t('setup.passphrase.placeholder')}
                          onChange={(e) => setPf2(e.target.value)}
                        />
                      </div>
                      {pf2 && !match && (
                        <div className="pf-err">
                          <AlertTriangle size={13} /> {t('setup.passphrase.mismatch')}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="req-list">
                    <div className={'req' + (pf.length >= 8 ? ' ok' : '')}>
                      <span className="rc">{pf.length >= 8 && <Check />}</span> {t('setup.passphrase.reqLength')}
                    </div>
                    <div
                      className={
                        'req' +
                        (/[A-Z]/.test(pf) && /[a-z]/.test(pf) && /\d/.test(pf) ? ' ok' : '')
                      }
                    >
                      <span className="rc">
                        {/[A-Z]/.test(pf) && /[a-z]/.test(pf) && /\d/.test(pf) && <Check />}
                      </span>{' '}
                      {t('setup.passphrase.reqMixed')}
                    </div>
                    <div className={'req' + (/[^A-Za-z0-9]/.test(pf) ? ' ok' : '')}>
                      <span className="rc">{/[^A-Za-z0-9]/.test(pf) && <Check />}</span> {t('setup.passphrase.reqSymbol')}
                    </div>
                  </div>

                  <div className="warn-soft">
                    <AlertTriangle /> {t('setup.passphrase.warning')}
                  </div>

                  <div className="flow-foot">
                    <button className="btn" onClick={() => setStep(1)}>
                      {t('setup.passphrase.prev')}
                    </button>
                    <span className="spacer" />
                    <button
                      className="btn primary"
                      disabled={!ppOk || loading}
                      onClick={produceKeyAndAdvance}
                    >
                      {loading ? (
                        <>
                          <span className="spin-ring" /> {t('setup.passphrase.processing')}
                        </>
                      ) : keyMode === 'gen' ? (
                        <>
                          <KeyRound size={16} /> {t('setup.passphrase.generateKey')}
                        </>
                      ) : (
                        t('setup.passphrase.next')
                      )}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* 3 · done */}
          {step === 3 && (
            <>
              <div className="flow-h">
                <div className="flow-badge green">
                  <ShieldCheck />
                </div>
                <h2>{t('setup.done.title')}</h2>
                <p>{t('setup.done.subtitle')}</p>
              </div>

              <div className="done-fp">
                <div className="dfp-l">
                  <Fingerprint /> {t('setup.done.fingerprintLabel')}
                </div>
                <div className="dfp-v">{formatFingerprint(fingerprint)}</div>
              </div>

              <div className="kit-row">
                <span className="kr-ico">
                  <Download />
                </span>
                <div className="kr-t">
                  <div className="a">{t('setup.done.kitTitle')}</div>
                  <div className="b">{t('setup.done.kitDesc')}</div>
                </div>
                <button
                  className="btn sm"
                  onClick={() =>
                    downloadRecoveryKit(
                      `jpassbolt-${user?.username ?? 'key'}-private.asc`,
                      armoredPrivateKey,
                    )
                  }
                >
                  <Download /> {t('setup.done.kitDownload')}
                </button>
              </div>

              <button
                className="btn primary"
                style={{ width: '100%', height: 44, fontSize: 14 }}
                onClick={enterVault}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spin-ring" /> {t('setup.done.activating')}
                  </>
                ) : (
                  <>
                    <Unlock size={16} /> {t('setup.done.enterVault')}
                  </>
                )}
              </button>
              <div className="flow-note">
                <ShieldCheck /> {t('setup.done.note')}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
