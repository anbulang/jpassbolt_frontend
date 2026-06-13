import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithGpg } from '../auth';
import { useKey } from '../crypto/KeyContext';
import { Shield, Key } from 'lucide-react';

export default function Login() {
    const [pgpKey, setPgpKey] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const navigate = useNavigate();
    const { setArmoredKeys, unlock } = useKey();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        const armoredPrivateKey = pgpKey.trim();
        if (!armoredPrivateKey) {
            setError('Please provide your GPG private key.');
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
            setError(message || 'Login failed. Please check your credentials.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container animate-fade-in" style={{ maxWidth: '500px', paddingTop: '8vh' }}>
            <div className="text-center mb-4">
                <div style={{ display: 'inline-flex', padding: '16px', background: 'var(--primary-glow)', borderRadius: '50%', marginBottom: '20px' }}>
                    <Shield size={48} color="var(--primary-color)" />
                </div>
                <h1 style={{ fontWeight: 600, letterSpacing: '-0.5px' }}>JPassbolt</h1>
                <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>
                    Secure OpenPGP Password Manager
                </p>
            </div>

            <div className="glass-panel" style={{ padding: '32px' }}>
                <form onSubmit={handleLogin}>
                    {error && (
                        <div style={{ padding: '12px', background: 'rgba(248, 81, 73, 0.1)', border: '1px solid var(--danger-color)', color: 'var(--danger-color)', borderRadius: '6px', marginBottom: '20px', fontSize: '14px' }}>
                            {error}
                        </div>
                    )}

                    <div className="form-group">
                        <label className="form-label" htmlFor="pgpkey">
                            <Key size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: '-2px' }} />
                            Your GPG Private Key
                        </label>
                        <textarea
                            id="pgpkey"
                            className="form-control"
                            placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                            value={pgpKey}
                            onChange={(e) => setPgpKey(e.target.value)}
                            required
                            rows={8}
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="passphrase">Passphrase (if encrypted)</label>
                        <input
                            id="passphrase"
                            type="password"
                            className="form-control"
                            placeholder="Enter your key phrase"
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                        />
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary"
                        style={{ width: '100%', marginTop: '10px', padding: '12px' }}
                        disabled={loading}
                    >
                        {loading ? 'Authenticating...' : 'Secure Login'}
                    </button>
                </form>
            </div>

            <p style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: 'var(--text-muted)' }}>
                Your private key never leaves the browser. Authentication happens via zero-knowledge challenge-response.
            </p>
        </div>
    );
}
