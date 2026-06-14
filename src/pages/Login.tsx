import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithGpg } from '../auth';
import { useKey } from '../crypto/KeyContext';
import { Vault, KeyRound, Lock, Eye, EyeOff, ShieldCheck, AlertTriangle, LogIn } from 'lucide-react';

export default function Login() {
    const [pgpKey, setPgpKey] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [show, setShow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const navigate = useNavigate();
    const { setArmoredKeys, unlock } = useKey();

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
            await loginWithGpg(armoredPrivateKey, passphrase);

            // 2. Persist the armored keys into KeyContext's localStorage contract (idempotent
            //    with auth.ts; ensures setArmoredKeys-driven state/hasStoredKey is current) and
            //    unlock the in-memory PrivateKey with the just-entered passphrase so the session
            //    starts UNLOCKED — no LockGate prompt right after a successful login.
            setArmoredKeys(armoredPrivateKey);
            await unlock(passphrase);

            // 3. Enter the vault.
            navigate('/');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '';
            setError(message || '登录失败，请检查你的私钥与 passphrase。');
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
                        <span className="bn">JPassbolt</span>
                    </div>
                </div>

                <div className="flow-body">
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

                        <div className="pf-label" style={{ marginBottom: 7 }}>
                            <KeyRound size={15} /> 你的 GPG 私钥
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
