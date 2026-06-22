import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithGpg } from '../auth';
import { useKey } from '../crypto/KeyContext';
import { probeMfaRequired } from '../services/mfa';
import MfaChallenge from '../components/MfaChallenge';
import { Vault, KeyRound, Lock, Eye, EyeOff, ShieldCheck, AlertTriangle, LogIn, Puzzle, X } from 'lucide-react';
import KeyFileButton from '../components/KeyFileButton';

export default function Login() {
    const [pgpKey, setPgpKey] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [show, setShow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    // When the backend enforces MFA after login, we hold the unlocked session and
    // render <MfaChallenge> instead of navigating; cleared on success/cancel.
    const [mfaRequired, setMfaRequired] = useState(false);
    const navigate = useNavigate();
    const { setArmoredKeys, unlock } = useKey();

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
            setError('请粘贴你的 GPG 私钥。');
            return;
        }

        setLoading(true);
        setError('');

        try {
            // 1. 2-stage GPG login: validates the key, gets a JWT, and (in auth.ts) persists
            //    the passphrase-protected armored private key + own armored public key.
            //    UNCHANGED — the auth/loginWithGpg contract is not touched by the MFA branch.
            await loginWithGpg(armoredPrivateKey, passphrase);

            // 2. Persist the armored keys into KeyContext's localStorage contract (idempotent
            //    with auth.ts; ensures setArmoredKeys-driven state/hasStoredKey is current) and
            //    unlock the in-memory PrivateKey with the just-entered passphrase so the session
            //    starts UNLOCKED — no LockGate prompt right after a successful login.
            setArmoredKeys(armoredPrivateKey);
            await unlock(passphrase);

            // 3. Post-login MFA gate (additive, non-blocking on the happy path): probe whether
            //    the backend requires a second factor for this session. If it does, render the
            //    TOTP challenge instead of navigating; otherwise enter the vault as before.
            const required = await probeMfaRequired();
            if (required) {
                setMfaRequired(true);
                return; // <MfaChallenge> takes over; onVerified() navigates to '/'.
            }

            // 4. Enter the vault (no MFA, or probe inconclusive — happy path unchanged).
            navigate('/');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '';
            setError(message || '登录失败，请检查你的私钥与 passphrase。');
        } finally {
            setLoading(false);
        }
    };

    // MFA gate active: the JWT session exists + the key is unlocked, but the backend
    // requires a TOTP code before the vault is reachable. Render the challenge.
    if (mfaRequired) {
        return (
            <MfaChallenge
                onVerified={() => navigate('/')}
                onCancel={() => {
                    setMfaRequired(false);
                    setError('已取消两步验证，可重新登录。');
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
                        <span className="bn">JPassbolt</span>
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
                                <strong>安装 JPassbolt 浏览器扩展</strong>
                                <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>
                                    网页版功能完整、可直接登录；安装扩展可获得跨站自动填表与更强的密钥隔离（可选）。
                                </div>
                            </div>
                            <button
                                type="button"
                                className="pf-eye"
                                onClick={() => setExtDismissed(true)}
                                title="忽略"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    )}
                    <div className="flow-h">
                        <div className="flow-badge">
                            <Lock />
                        </div>
                        <h2>登录端到端加密保险库</h2>
                        <p>用你的 OpenPGP 私钥发起零知识质询-响应认证。私钥永不离开此浏览器。</p>
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
                                <KeyRound size={15} /> 你的 GPG 私钥
                            </span>
                            <span style={{ marginLeft: 'auto' }}>
                                {/* 可选：选择本地 .asc 私钥文件填入下方文本框；仍可直接粘贴。文件仅在浏览器内读取。 */}
                                <KeyFileButton onLoaded={(t) => setPgpKey(t)} />
                            </span>
                        </div>
                        <textarea
                            className="flow-textarea"
                            placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                            value={pgpKey}
                            onChange={(e) => setPgpKey(e.target.value)}
                            required
                            rows={7}
                            spellCheck={false}
                        />

                        <div className="pf-label" style={{ margin: '16px 0 7px' }}>
                            <Lock size={15} /> passphrase（若私钥已加密）
                        </div>
                        <div className="pf-input">
                            <Lock size={17} />
                            <input
                                type={show ? 'text' : 'password'}
                                placeholder="••••••••••••"
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
                                    <span className="spin-ring" /> 正在认证…
                                </>
                            ) : (
                                <>
                                    <LogIn size={16} /> 安全登录
                                </>
                            )}
                        </button>

                        <div className="flow-note">
                            <ShieldCheck size={13} /> 私钥与 passphrase 仅在本地使用，绝不上传服务器
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
