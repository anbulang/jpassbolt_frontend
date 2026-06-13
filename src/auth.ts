import * as openpgp from 'openpgp';
import { api } from './api';
import { decryptMessage, extractKeyId, fingerprintOf } from './gpg';
import { getMe } from './services/profile';
import {
    LS_JWT,
    LS_USER,
    LS_PRIVATE_KEY,
    LS_PUBLIC_KEY,
} from './crypto/KeyContext';
import type { User } from './types';

/** Narrow an unknown thrown value into a best-effort axios-ish error shape for messaging. */
interface ApiErrorLike {
    response?: { status?: number; data?: { header?: { message?: string } } };
    message?: string;
}

function asApiError(err: unknown): ApiErrorLike {
    return (err ?? {}) as ApiErrorLike;
}

/**
 * Derive the armored PUBLIC key for the current user.
 *
 * The local private key is the trusted source of truth for one's OWN key, so we
 * always derive the public key (and its fingerprint) from it. We then OPTIONALLY
 * prefer the server-provided armored public key — but only if it verifies against
 * the locally-derived fingerprint. This prevents a compromised server from
 * substituting a foreign public key for our own account (which could later be used
 * to mislead the owner or seed downstream trust decisions).
 *
 * Preference order:
 *   1. Locally derive the public key + fingerprint from the armored private key.
 *   2. If the server's gpgkey.armored_key parses to the SAME fingerprint, use it
 *      verbatim (it may carry richer self-certifications / user IDs).
 *   3. Otherwise fall back to the locally-derived public key.
 *
 * Returns null only if the private key itself cannot be parsed (callers then fall
 * back to deriving on unlock()).
 */
async function deriveOwnPublicKey(
    user: unknown,
    armoredPrivateKey: string
): Promise<string | null> {
    // 1. Derive locally from the private key (does NOT require the passphrase).
    let localPublic: string;
    let localFingerprint: string;
    try {
        const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
        localPublic = privateKey.toPublic().armor();
        localFingerprint = privateKey.getFingerprint().toLowerCase();
    } catch {
        return null;
    }

    // 2. Prefer the server-provided public key only if it verifies to the SAME fingerprint.
    const serverArmored =
        (user as { gpgkey?: { armored_key?: string } } | null)?.gpgkey?.armored_key;
    if (serverArmored && serverArmored.includes('BEGIN PGP PUBLIC KEY')) {
        try {
            const serverFingerprint = await fingerprintOf(serverArmored);
            if (serverFingerprint === localFingerprint) {
                return serverArmored;
            }
        } catch {
            // Unparseable server key — ignore it and use the local one.
        }
    }

    // 3. Fall back to the locally-derived public key.
    return localPublic;
}

/**
 * Perform the 3-stage Passbolt GPG Authentication flow
 *
 * @param armoredPrivateKey The user's armored private key string
 * @param passphrase The passphrase to unlock the private key
 * @returns The authenticated user object
 */
export async function loginWithGpg(
    armoredPrivateKey: string,
    passphrase?: string
): Promise<User> {
    let fingerprint;
    try {
        fingerprint = await extractKeyId(armoredPrivateKey);
    } catch {
        throw new Error('Invalid GPG Private Key.');
    }

    // Refuse an UNPROTECTED (passphrase-less) private key. The whole
    // "passphrase stays in memory only" protection collapses if the key stored in
    // localStorage carries no passphrase: after a refresh anyone with access to the
    // browser profile could unlock the vault with any (even empty) passphrase. We
    // require a passphrase-protected key so persisting it at rest stays meaningful.
    try {
        const parsed = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
        if (parsed.isDecrypted()) {
            throw new Error(
                'This private key is not protected by a passphrase. For your security, JPassbolt requires a passphrase-protected key. Add a passphrase to your key and try again.',
            );
        }
    } catch (err: unknown) {
        // Re-throw our explicit refusal; treat any parse failure as an invalid key.
        if (err instanceof Error && err.message.startsWith('This private key is not protected')) {
            throw err;
        }
        throw new Error('Invalid GPG Private Key.');
    }

    // Stage 1: Request authentication challenge
    let stage1Response;
    try {
        stage1Response = await api.post('/auth/login.json', {
            data: {
                gpg_auth: {
                    keyid: fingerprint,
                },
            },
        });
    } catch (err: unknown) {
        const e = asApiError(err);
        if (e.response?.status === 404) {
            throw new Error('User not found for the provided GPG Key.');
        }
        throw new Error('GPG Auth Stage 1 Failed: ' + (e.response?.data?.header?.message || e.message));
    }

    // The encrypted nonce is returned in the custom header
    const encryptedToken = stage1Response.headers['x-gpgauth-user-auth-token'];
    if (!encryptedToken) {
        throw new Error('Server did not return a challenge token (X-GPGAuth-User-Auth-Token header missing)');
    }

    // Decode the URL-encoded armored PGP message
    const decodedToken = decodeURIComponent(encryptedToken);

    // Decrypt the challenge using our private key
    let decryptedNonce;
    try {
        decryptedNonce = await decryptMessage(decodedToken, armoredPrivateKey, passphrase);
    } catch (err: unknown) {
        throw new Error(asApiError(err).message || 'Failed to decrypt the server challenge. Is your passphrase correct?');
    }

    // Stage 2: Return the decrypted nonce to complete authentication
    let stage2Response;
    try {
        stage2Response = await api.post('/auth/login.json', {
            data: {
                gpg_auth: {
                    keyid: fingerprint,
                    user_token_result: decryptedNonce,
                },
            },
        });
    } catch (err: unknown) {
        const e = asApiError(err);
        throw new Error('GPG Auth Stage 2 Failed: ' + (e.response?.data?.header?.message || e.message));
    }

    // Extract the JWT Bearer token from the Authorization header
    const authHeader = stage2Response.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('Authentication completed but no JWT token was returned in the headers.');
    }

    const jwt = authHeader.substring(7);
    // The stage-2 challenge body only carries a slim user ({id, username, active}) — it
    // lacks role/profile/gpgkey, so admin-gated UI would never appear. Persist the JWT first
    // so the api interceptor authenticates the follow-up GET /users/me.json, then hydrate the
    // FULL user (role + profile + gpgkey) into LS_USER.
    const challengeUser = stage2Response.data.body.user as User;

    // Store credentials (JWT must be present before getMe() so it is authenticated).
    localStorage.setItem(LS_JWT, jwt);

    let user = challengeUser;
    try {
        // Re-hydrate the full user object (role/profile/gpgkey) used by admin gating + display.
        user = await getMe();
    } catch {
        // Non-fatal: fall back to the slim challenge user. Admin controls may be hidden until
        // the next /users/me.json succeeds, but the session is still valid.
    }
    localStorage.setItem(LS_USER, JSON.stringify(user));

    // Persist the passphrase-PROTECTED armored private key (still encrypted at rest by its
    // passphrase) so a later hard-refresh can re-unlock against it via LockGate. The decrypted
    // key and passphrase are NEVER persisted — only KeyContext holds them in memory.
    localStorage.setItem(LS_PRIVATE_KEY, armoredPrivateKey);

    // Persist the user's own armored PUBLIC key (from the server gpgkey, else derived locally)
    // so encryptForSelf works immediately on unlock without an extra round-trip.
    try {
        const ownPublicKey = await deriveOwnPublicKey(user, armoredPrivateKey);
        if (ownPublicKey) {
            localStorage.setItem(LS_PUBLIC_KEY, ownPublicKey);
        }
    } catch {
        // Non-fatal: KeyContext.unlock() will derive the public key from the private key if absent.
    }

    return user;
}

/**
 * Log out the current user.
 *
 * Clears ALL credentials and key material from localStorage (JWT, user, the
 * passphrase-protected armored private key, and the own armored public key).
 * The in-memory decrypted key in KeyContext is wiped here too: removing
 * LS_PRIVATE_KEY makes hasStoredKey false so LockGate would redirect to /login,
 * and the hard navigation below tears down the React tree (and its in-memory
 * PrivateKey) entirely. KeyContext also exposes clear()/lock() for in-app use.
 */
export function logout() {
    localStorage.removeItem(LS_JWT);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_PRIVATE_KEY);
    localStorage.removeItem(LS_PUBLIC_KEY);
    window.location.href = '/login';
}
