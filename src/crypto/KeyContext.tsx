/* eslint-disable react-refresh/only-export-components */
// This file is the single-source crypto contract: it intentionally co-locates the KeyProvider/
// LockGate components with the useKey() hook and localStorage key constants (per blueprint), so
// the react-refresh "only export components" rule is disabled here by design.
//
// src/crypto/KeyContext.tsx — the in-memory unlocked-key contract for JPassbolt's E2EE model.
//
// SECURITY MODEL (the crux of the app):
//   The server is zero-knowledge. All decrypt/encrypt happens ONLY here, in the browser.
//   This context holds the UNLOCKED openpgp PrivateKey object IN MEMORY ONLY (React state).
//   The decrypted PrivateKey and the passphrase are NEVER persisted to localStorage/sessionStorage.
//
//   localStorage may hold ONLY:
//     - jpassbolt_jwt                  (the JWT, managed by auth.ts/api.ts)
//     - jpassbolt_user                 (the user object)
//     - jpassbolt_private_key_armored  (passphrase-PROTECTED armored private key — still encrypted at rest)
//     - jpassbolt_public_key_armored   (own armored PUBLIC key)
//
//   Unlock-on-refresh: after a hard refresh the JWT survives (ProtectedRoute passes) but the
//   in-memory decrypted key is gone. LockGate detects authenticated-but-locked and shows a
//   passphrase-only Unlock prompt that re-decrypts the armored private key from localStorage.
//   If no armored private key exists (hasStoredKey === false), it redirects to full /login.

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type JSX,
    type ReactNode,
} from 'react';
import * as openpgp from 'openpgp';
import type { PrivateKey } from 'openpgp';
import { useTranslation } from 'react-i18next';
import { Lock, KeyRound, Eye, EyeOff, ShieldCheck, Unlock, AlertTriangle } from 'lucide-react';
import i18n from '../i18n';
import { encryptMessage } from '../gpg';
import { readIdleSecs } from '../theme';
import {
    cachePassphrase,
    clearCachedPassphrase,
    readCachedPassphrase,
} from './passphraseCache';

// ---------------------------------------------------------------------------
// localStorage key constants (single source of truth for the crypto layer)
// ---------------------------------------------------------------------------
export const LS_JWT = 'jpassbolt_jwt';
export const LS_USER = 'jpassbolt_user';
export const LS_PRIVATE_KEY = 'jpassbolt_private_key_armored';
export const LS_PUBLIC_KEY = 'jpassbolt_public_key_armored';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------
export interface KeyContextValue {
    /** True when authenticated (JWT present) but no decrypted key is in memory (e.g. after hard refresh). */
    isLocked: boolean;
    /**
     * True only during the brief window on mount when we are auto-unlocking from a
     * cached passphrase (survive-refresh). LockGate shows a neutral "restoring
     * session" spinner instead of the passphrase form while this is true, so a
     * refresh that will auto-unlock never flashes the unlock prompt.
     */
    isRestoring: boolean;
    /** Own armored public key from localStorage (jpassbolt_public_key_armored), or null if absent. */
    ownPublicKeyArmored: string | null;
    /** Fingerprint of the unlocked key (lowercase hex), or null while locked. */
    ownFingerprint: string | null;
    /** True only if an armored private key exists in localStorage to unlock against. If false, UI must fall back to full /login. */
    hasStoredKey: boolean;

    /**
     * Persist the passphrase-protected armored private key + own public key to localStorage so a
     * later hard-refresh can unlock against them. Called by Login.tsx right after a successful
     * loginWithGpg (alongside calling unlock(passphrase) to start the session unlocked).
     * The public key may be omitted; it will then be derived from the private key on unlock().
     */
    setArmoredKeys: (armoredPrivateKey: string, armoredPublicKey?: string | null) => void;

    /** Decrypt the armored private key from localStorage with the passphrase and hold the PrivateKey in memory. Throws on wrong passphrase / missing key. */
    unlock: (passphrase: string) => Promise<void>;
    /** Wipe the in-memory PrivateKey + passphrase (does NOT touch the JWT). Sets isLocked = true. */
    lock: () => void;
    /** Remove BOTH armored keys from localStorage and wipe in-memory state. Call on logout. Does NOT touch the JWT/user (auth.ts owns those). */
    clear: () => void;

    /** Decrypt an armored PGP message using the in-memory private key. Throws if isLocked. */
    decrypt: (armoredMessage: string) => Promise<string>;
    /** Encrypt plaintext for one or more recipient armored PUBLIC keys (used for share/create per recipient). */
    encryptFor: (plaintext: string, armoredPublicKeys: string[]) => Promise<string>;
    /** Convenience: encrypt plaintext for the current user's own public key only (creating a personal secret). */
    encryptForSelf: (plaintext: string) => Promise<string>;
}

const KeyContext = createContext<KeyContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function errMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return fallback;
}

/** Localized crypto-layer message helper (uses the i18n singleton, like i18n/errors.ts). */
function tc(key: string, opts?: Record<string, unknown>): string {
    return i18n.t(`crypto:${key}`, opts ?? {});
}

function readStoredPrivateKey(): string | null {
    return localStorage.getItem(LS_PRIVATE_KEY);
}

function readStoredPublicKey(): string | null {
    return localStorage.getItem(LS_PUBLIC_KEY);
}

/**
 * Synchronous, side-effect-light check for whether a page refresh can auto-unlock
 * the vault from the cached passphrase: we need to be authenticated (JWT present),
 * have a passphrase-protected armored key to decrypt, and hold a non-expired
 * cached passphrase. Used to initialize isRestoring so LockGate shows a spinner
 * (not the passphrase form) while the async unlock runs.
 */
function canAutoUnlock(): boolean {
    return (
        localStorage.getItem(LS_JWT) != null &&
        readStoredPrivateKey() != null &&
        readCachedPassphrase() != null
    );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export function KeyProvider({ children }: { children: ReactNode }): JSX.Element {
    // The decrypted private key lives ONLY in a ref — never serialized, never logged.
    const privateKeyRef = useRef<PrivateKey | null>(null);

    // Own armored public key mirrors localStorage but is held in state for reactivity.
    const [ownPublicKeyArmored, setOwnPublicKeyArmored] = useState<string | null>(
        () => readStoredPublicKey(),
    );
    const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);
    // `isLocked` flips to false only after a successful unlock; it is the single source of
    // truth the UI watches. We derive the initial value: locked if no key is in memory yet.
    const [isLocked, setIsLocked] = useState<boolean>(true);
    // True while the mount-time auto-unlock from the cached passphrase is in flight.
    // Initialized synchronously so the very first render already knows a refresh will
    // auto-unlock (LockGate then shows a spinner, never the passphrase form).
    const [isRestoring, setIsRestoring] = useState<boolean>(() => canAutoUnlock());
    // Bump to force a re-read of hasStoredKey after setArmoredKeys/clear.
    const [storedKeyVersion, setStoredKeyVersion] = useState(0);

    const hasStoredKey = useMemo(() => {
        // storedKeyVersion is a dependency so this recomputes after writes.
        void storedKeyVersion;
        return readStoredPrivateKey() != null;
    }, [storedKeyVersion]);

    const setArmoredKeys = useCallback(
        (armoredPrivateKey: string, armoredPublicKey?: string | null) => {
            // Persist ONLY the passphrase-protected private key (still encrypted at rest).
            localStorage.setItem(LS_PRIVATE_KEY, armoredPrivateKey);
            if (armoredPublicKey) {
                localStorage.setItem(LS_PUBLIC_KEY, armoredPublicKey);
                setOwnPublicKeyArmored(armoredPublicKey);
            }
            setStoredKeyVersion((v) => v + 1);
        },
        [],
    );

    const lock = useCallback(() => {
        // Locking the vault must also forget the cached passphrase, otherwise a
        // refresh right after an idle/manual lock would silently auto-unlock again.
        clearCachedPassphrase();
        privateKeyRef.current = null;
        setOwnFingerprint(null);
        setIsLocked(true);
    }, []);

    const clear = useCallback(() => {
        clearCachedPassphrase();
        privateKeyRef.current = null;
        localStorage.removeItem(LS_PRIVATE_KEY);
        localStorage.removeItem(LS_PUBLIC_KEY);
        setOwnPublicKeyArmored(null);
        setOwnFingerprint(null);
        setIsLocked(true);
        setStoredKeyVersion((v) => v + 1);
    }, []);

    const unlock = useCallback(async (passphrase: string) => {
        const armoredPrivateKey = readStoredPrivateKey();
        if (!armoredPrivateKey) {
            throw new Error(tc('errors.noStoredKey'));
        }

        // Read + decrypt the private key into memory.
        let encryptedKey: PrivateKey;
        try {
            encryptedKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
        } catch (err: unknown) {
            throw new Error(errMessage(err, tc('errors.readStoredKey')));
        }

        let decryptedKey: PrivateKey;
        if (encryptedKey.isDecrypted()) {
            // SECURITY: an unprotected (passphrase-less) key in localStorage would let
            // ANYONE with access to this browser profile "unlock" with any passphrase
            // after a refresh — defeating the whole in-memory-passphrase model. Login
            // refuses such keys up front; refuse here too as a defence-in-depth guard.
            throw new Error(tc('errors.keyNotProtected'));
        } else {
            try {
                decryptedKey = await openpgp.decryptKey({
                    privateKey: encryptedKey,
                    passphrase,
                });
            } catch {
                throw new Error(tc('errors.incorrectPassphrase'));
            }
        }

        // Hold the unlocked key in memory ONLY.
        privateKeyRef.current = decryptedKey;
        setOwnFingerprint(decryptedKey.getFingerprint().toLowerCase());

        // Ensure we have an own public key armored available for encryptForSelf.
        // Prefer the stored one; otherwise derive it from the (now unlocked) private key.
        let pub = readStoredPublicKey();
        if (!pub) {
            try {
                pub = decryptedKey.toPublic().armor();
                localStorage.setItem(LS_PUBLIC_KEY, pub);
            } catch {
                pub = null;
            }
        }
        if (pub) {
            setOwnPublicKeyArmored(pub);
        }

        setIsLocked(false);

        // Cache the passphrase so a page refresh can re-unlock without re-typing,
        // for as long as the idle-lock window (idleSecs). idleSecs === 0 ("never
        // auto-lock") caches with no expiry (cleared on tab close / lock / logout).
        const ttl = readIdleSecs();
        cachePassphrase(passphrase, ttl > 0 ? ttl : null);
    }, []);

    // On mount, if a non-expired cached passphrase exists (survive-refresh), unlock
    // automatically from it. Runs exactly once; guarded so React StrictMode's double
    // invoke in dev does not fire two concurrent unlocks. On failure the cache is
    // dropped and LockGate falls back to the passphrase form.
    const didBootstrap = useRef(false);
    useEffect(() => {
        if (didBootstrap.current) return;
        didBootstrap.current = true;
        if (!canAutoUnlock()) {
            setIsRestoring(false);
            return;
        }
        const cached = readCachedPassphrase();
        if (!cached) {
            setIsRestoring(false);
            return;
        }
        // No cancellation guard: didBootstrap already guarantees a single run, and
        // KeyProvider is the root provider that never unmounts mid-session. A guard
        // here would let StrictMode's throwaway-mount cleanup suppress the only real
        // completion and hang the spinner forever on the failure path. So ALWAYS
        // clear isRestoring in finally — on success LockGate passes through (isLocked
        // is false); on failure the cache is dropped and the passphrase form shows.
        void (async () => {
            try {
                await unlock(cached);
            } catch {
                clearCachedPassphrase();
            } finally {
                setIsRestoring(false);
            }
        })();
    }, [unlock]);

    const decrypt = useCallback(async (armoredMessage: string): Promise<string> => {
        const privateKey = privateKeyRef.current;
        if (!privateKey) {
            throw new Error(tc('errors.vaultLocked'));
        }

        const message = await openpgp.readMessage({ armoredMessage });
        try {
            const { data } = await openpgp.decrypt({
                message,
                decryptionKeys: privateKey,
            });
            return data as string;
        } catch (err: unknown) {
            throw new Error(errMessage(err, tc('errors.decryptMessage')));
        }
    }, []);

    const encryptFor = useCallback(
        async (plaintext: string, armoredPublicKeys: string[]): Promise<string> => {
            if (!armoredPublicKeys || armoredPublicKeys.length === 0) {
                // Guard against silent lockout: refuse to encrypt with no recipient key.
                throw new Error(tc('errors.noRecipientKey'));
            }
            // Delegate to the shared gpg.ts helper (reads keys + encrypts).
            return encryptMessage(plaintext, armoredPublicKeys);
        },
        [],
    );

    const encryptForSelf = useCallback(
        async (plaintext: string): Promise<string> => {
            const pub = ownPublicKeyArmored ?? readStoredPublicKey();
            if (!pub) {
                throw new Error(tc('errors.ownPublicKeyUnavailable'));
            }
            return encryptMessage(plaintext, [pub]);
        },
        [ownPublicKeyArmored],
    );

    const value = useMemo<KeyContextValue>(
        () => ({
            isLocked,
            isRestoring,
            ownPublicKeyArmored,
            ownFingerprint,
            hasStoredKey,
            setArmoredKeys,
            unlock,
            lock,
            clear,
            decrypt,
            encryptFor,
            encryptForSelf,
        }),
        [
            isLocked,
            isRestoring,
            ownPublicKeyArmored,
            ownFingerprint,
            hasStoredKey,
            setArmoredKeys,
            unlock,
            lock,
            clear,
            decrypt,
            encryptFor,
            encryptForSelf,
        ],
    );

    return <KeyContext.Provider value={value}>{children}</KeyContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
/** Hook returning KeyContextValue. Throws if used outside KeyProvider. */
export function useKey(): KeyContextValue {
    const ctx = useContext(KeyContext);
    if (!ctx) {
        throw new Error('useKey() must be used within a <KeyProvider>.');
    }
    return ctx;
}

// ---------------------------------------------------------------------------
// LockGate — passphrase-only unlock overlay for the authenticated-but-locked state.
// ---------------------------------------------------------------------------
/**
 * Renders an Unlock prompt overlay (passphrase-only) whenever the user is authenticated
 * (JWT present) but the in-memory key is locked AND a stored armored private key exists.
 * On successful unlock it continues to children. If no stored key exists, it redirects to /login.
 * If already unlocked (or not authenticated), it simply renders children.
 */
export function LockGate({ children }: { children: ReactNode }): JSX.Element | null {
    const { t } = useTranslation('crypto');
    const { isLocked, isRestoring, hasStoredKey, unlock } = useKey();
    const [passphrase, setPassphrase] = useState('');
    const [show, setShow] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Show the spinner card (not the passphrase form) both while a manual unlock is
    // in flight (busy) and while the mount-time auto-unlock from cache runs (isRestoring).
    const showSpinner = busy || isRestoring;

    const hasJwt = localStorage.getItem(LS_JWT) != null;

    // Authenticated but no stored key to unlock against -> full re-login required.
    // The redirect MUST be a post-render side effect (mutating location during render is
    // illegal in React, and doubly so under StrictMode). While this state holds we render
    // null below so the protected page never mounts or fires its data-loading effects.
    const needsRelogin = hasJwt && isLocked && !hasStoredKey;
    useEffect(() => {
        if (needsRelogin && window.location.pathname !== '/login') {
            window.location.href = '/login';
        }
    }, [needsRelogin]);

    // Not authenticated, or already unlocked -> pass through to the app.
    if (!hasJwt || !isLocked) {
        return <>{children}</>;
    }

    // Authenticated but no stored key to unlock against -> render nothing while redirecting.
    if (!hasStoredKey) {
        return null;
    }

    // Identity shown on the lock card (display only — the private key stays locked
    // in localStorage until the passphrase decrypts it into memory).
    const account = (() => {
        try {
            const raw = localStorage.getItem(LS_USER);
            const u = raw
                ? (JSON.parse(raw) as {
                      username?: string;
                      profile?: { first_name?: string; last_name?: string };
                  })
                : null;
            const f = u?.profile?.first_name?.trim() ?? '';
            const l = u?.profile?.last_name?.trim() ?? '';
            const name = [f, l].filter(Boolean).join(' ') || u?.username || t('lock.accountFallback');
            const username = u?.username ?? '';
            let initials = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase();
            if (!initials.trim()) initials = (username || 'U').slice(0, 2).toUpperCase();
            let h = 0;
            const seed = username || name;
            for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
            return { name, username, initials, color: `oklch(0.55 0.15 ${h % 360})` };
        } catch {
            return { name: t('lock.accountFallback'), username: '', initials: 'U', color: 'var(--accent)' };
        }
    })();

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setError(null);
        setBusy(true);
        try {
            await unlock(passphrase);
            setPassphrase('');
        } catch (err: unknown) {
            setError(errMessage(err, t('errors.incorrectPassphrase')));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="lock-overlay">
            <div className="lock-card">
                <div className="lock-badge">{showSpinner ? <KeyRound size={28} /> : <Lock size={28} />}</div>
                <h2>{isRestoring ? t('lock.titleRestoring') : busy ? t('lock.titleUnlocking') : t('lock.titleLocked')}</h2>
                <div className="who">
                    {isRestoring ? t('lock.subtitleRestoring') : t('lock.subtitleLocked')}
                </div>

                <div className="lock-id">
                    <span className="av" style={{ background: account.color }}>
                        {account.initials}
                    </span>
                    <div className="who2">
                        <div className="n">{account.name}</div>
                        {account.username && <div className="fp">{account.username}</div>}
                    </div>
                </div>

                {showSpinner ? (
                    <div style={{ padding: '8px 0 4px' }}>
                        <div className="decrypt-bar" style={{ height: 4 }}>
                            <i style={{ width: '100%', animation: 'decrypt 1s ease forwards' }} />
                        </div>
                        <div className="lock-foot" style={{ marginTop: 14 }}>
                            <span className="spin-ring" />{' '}
                            {isRestoring ? t('lock.spinnerRestoring') : t('lock.spinnerUnlocking')}
                        </div>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit}>
                        <div className="pf-label">
                            <KeyRound size={15} /> {t('lock.inputLabel')}
                        </div>
                        <div className={`pf-input${error ? ' err' : ''}`}>
                            <Lock size={17} />
                            <input
                                id="lockgate-passphrase"
                                type={show ? 'text' : 'password'}
                                autoFocus
                                autoComplete="current-password"
                                placeholder="••••••••••••"
                                value={passphrase}
                                onChange={(e) => {
                                    setPassphrase(e.target.value);
                                    setError(null);
                                }}
                            />
                            <button type="button" className="pf-eye" onClick={() => setShow((s) => !s)}>
                                {show ? <EyeOff size={17} /> : <Eye size={17} />}
                            </button>
                        </div>
                        {error && (
                            <div className="pf-err">
                                <AlertTriangle size={13} /> {error}
                            </div>
                        )}
                        <button
                            type="submit"
                            className="btn primary"
                            style={{ width: '100%', height: 44, marginTop: 16, fontSize: 14 }}
                            disabled={passphrase.length === 0}
                        >
                            <Unlock size={16} /> {t('lock.submit')}
                        </button>
                        <div className="lock-foot">
                            <ShieldCheck size={13} /> {t('lock.note')}
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
