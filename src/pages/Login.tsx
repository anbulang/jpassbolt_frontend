import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { loginWithGpg } from '../auth';
import { useKey, LS_PRIVATE_KEY, LS_JWT, LS_USER } from '../crypto/KeyContext';
import { probeMfaRequired } from '../services/mfa';
import MfaChallenge from '../components/MfaChallenge';
import { Vault, KeyRound, Lock, Eye, EyeOff, ShieldCheck, AlertTriangle, LogIn, Puzzle, X } from 'lucide-react';
import KeyFileButton from '../components/KeyFileButton';
import { describeApiError } from '../i18n/errors';

export default function Login() {
    const { t } = useTranslation('auth');
    // Pre-fill the key from the at-rest armored key (kept across a 401 session-expiry,
    // wiped on explicit logout). So re-login after expiry only needs the passphrase,
    // not a re-paste of the private key. Empty on a fresh browser / after logout.
    const [pgpKey, setPgpKey] = useState(() => localStorage.getItem(LS_PRIVATE_KEY) ?? '');
    const [passphrase, setPassphrase] = useState('');
    const [show, setShow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    // When the backend enforces MFA after login, we hold the unlocked session and
    // render <MfaChallenge> instead of navigating; cleared on success/cancel.
    const [mfaRequired, setMfaRequired] = useState(false);
    const navigate = useNavigate();
    const { setArmoredKeys, unlock, lock } = useKey();

    // Detect the JPassbolt browser extension. Its content script sets
    // <html data-jpassbolt-extension="version"> on load; the SPA works fully
    // WITHOUT it, so this only drives an optional, dismissible install prompt.
    // The extension injects asynchronously, so watch for the attribute appearing.
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

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        const armoredPrivateKey = pgpKey.trim();
        if (!armoredPrivateKey) {
            setError(t('login.errors.missingKey'));
            return;
        }

        setLoading(true);
        setError('');

        try {
            // 1. 2-stage GPG login: validates the key, gets a JWT, and (in auth.ts) persists
            //    the passphrase-protected armored private key + own armored public key.
            await loginWithGpg(armoredPrivateKey, passphrase);

            // 2. Persist the armored keys into KeyContext's localStorage contract (idempotent
            //    with auth.ts; ensures setArmoredKeys-driven state/hasStoredKey is current).
            setArmoredKeys(armoredPrivateKey);

            // 3. Probe MFA BEFORE unlocking/caching. An incomplete 2FA session must NOT leave
            //    the vault unlocked or the passphrase cached — that would auto-unlock across a
            //    refresh into an MFA-bypassed shell. So unlock only once the session is fully
            //    established: here for the no-MFA path, or in onVerified after MFA passes.
            const required = await probeMfaRequired();
            if (required) {
                setMfaRequired(true);
                return; // <MfaChallenge> takes over; onVerified() unlocks + navigates.
            }

            // 4. No MFA: unlock the in-memory key (this also caches the passphrase for
            //    survive-refresh) and enter the vault.
            await unlock(passphrase);
            navigate('/');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '';
            setError(describeApiError(err) || message || t('login.errors.loginFailed'));
        } finally {
            setLoading(false);
        }
    };

    // MFA gate active: the JWT session exists + the key is unlocked, but the backend
    // requires a TOTP code before the vault is reachable. Render the challenge.
    if (mfaRequired) {
        return (
            <MfaChallenge
                onVerified={async () => {
                    // 2FA passed → the session is now fully authenticated. Unlock the
                    // vault (and cache the passphrase for survive-refresh), then enter.
                    try {
                        await unlock(passphrase);
                        navigate('/');
                    } catch (err: unknown) {
                        setMfaRequired(false);
                        setError(err instanceof Error ? err.message : t('login.errors.unlockFailed'));
                    }
                }}
                onCancel={() => {
                    // Bailed before completing 2FA → tear down the half-established session
                    // so nothing lingers: lock() wipes the in-memory key + passphrase cache,
                    // and we drop the JWT/user so ProtectedRoute can't be entered. The
                    // armored key stays (textarea stays pre-filled) for an easy re-login.
                    lock();
                    localStorage.removeItem(LS_JWT);
                    localStorage.removeItem(LS_USER);
                    setMfaRequired(false);
                    setError(t('login.errors.mfaCancelled'));
                }}
            />
        );
    }

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
                                    {t('extPrompt.descLogin')}
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
                    <div className="flow-h">
                        <div className="flow-badge">
                            <Lock />
                        </div>
                        <h2>{t('login.title')}</h2>
                        <p>{t('login.subtitle')}</p>
                    </div>

                    <form onSubmit={handleLogin}>
                        {error && (
                            <div className="warnbox" style={{ marginBottom: 16 }}>
                                <AlertTriangle />
                                <div>{error}</div>
                            </div>
                        )}

                        <div
                            className="pf-label"
                            style={{ marginBottom: 7, display: 'flex', alignItems: 'center' }}
                        >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <KeyRound size={15} /> {t('login.privateKeyLabel')}
                            </span>
                            <span style={{ marginLeft: 'auto' }}>
                                {/* 可选：选择本地 .asc 私钥文件填入下方文本框；仍可直接粘贴。文件仅在浏览器内读取。 */}
                                <KeyFileButton onLoaded={(txt) => setPgpKey(txt)} />
                            </span>
                        </div>
                        <textarea
                            className="flow-textarea"
                            placeholder={t('login.privateKeyPlaceholder')}
                            value={pgpKey}
                            onChange={(e) => setPgpKey(e.target.value)}
                            required
                            rows={7}
                            spellCheck={false}
                        />

                        <div className="pf-label" style={{ margin: '16px 0 7px' }}>
                            <Lock size={15} /> {t('login.passphraseLabel')}
                        </div>
                        <div className="pf-input">
                            <Lock size={17} />
                            <input
                                type={show ? 'text' : 'password'}
                                placeholder={t('login.passphrasePlaceholder')}
                                value={passphrase}
                                onChange={(e) => setPassphrase(e.target.value)}
                            />
                            <button type="button" className="pf-eye" onClick={() => setShow((s) => !s)}>
                                {show ? <EyeOff size={17} /> : <Eye size={17} />}
                            </button>
                        </div>

                        <button
                            type="submit"
                            className="btn primary"
                            style={{ width: '100%', height: 44, marginTop: 18, fontSize: 14 }}
                            disabled={loading}
                        >
                            {loading ? (
                                <>
                                    <span className="spin-ring" /> {t('login.authenticating')}
                                </>
                            ) : (
                                <>
                                    <LogIn size={16} /> {t('login.submit')}
                                </>
                            )}
                        </button>

                        <div className="flow-note">
                            <ShieldCheck size={13} /> {t('login.note')}
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
