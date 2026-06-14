import * as openpgp from 'openpgp';

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Decrypt a PGP message using a private key and its passphrase.
 * This is used for both the auth token challenge (Stage 1) and decrypting password secrets.
 *
 * @param armoredMessage The PGP encrypted message string
 * @param armoredPrivateKey The user's armored private key string
 * @param passphrase The passphrase to unlock the private key
 * @returns The decrypted text
 */
export async function decryptMessage(
    armoredMessage: string,
    armoredPrivateKey: string,
    passphrase?: string
): Promise<string> {
    let privateKey;
    try {
        privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
    } catch (err: unknown) {
        throw new Error('Failed to read private key: ' + errorMessage(err));
    }

    // Decrypt the private key if a passphrase is provided and it's encrypted
    if (passphrase && !privateKey.isDecrypted()) {
        try {
            privateKey = await openpgp.decryptKey({
                privateKey,
                passphrase,
            });
        } catch {
            throw new Error('Failed to decrypt private key. Incorrect passphrase?');
        }
    }

    const message = await openpgp.readMessage({ armoredMessage });

    try {
        const { data: decrypted } = await openpgp.decrypt({
            message,
            decryptionKeys: privateKey,
        });
        return decrypted as string;
    } catch (err: unknown) {
        throw new Error('Failed to decrypt message: ' + errorMessage(err));
    }
}

/**
 * Extract the key ID (fingerprint) from an armored private key.
 * The backend expects a 40-character fingerprint or a 16-character key ID.
 *
 * @param armoredPrivateKey The user's armored private key string
 * @returns The key ID/fingerprint as a hex string
 */
export async function extractKeyId(armoredPrivateKey: string): Promise<string> {
    try {
        const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
        // openpgp.js returns fingerprint as a hex string
        return privateKey.getFingerprint();
    } catch (err: unknown) {
        throw new Error('Failed to extract key ID: ' + errorMessage(err));
    }
}

/** Normalize a fingerprint for comparison: strip whitespace, lowercase. */
function normalizeFingerprint(fp: string): string {
    return fp.replace(/\s+/g, '').toLowerCase();
}

/**
 * Compute the OpenPGP fingerprint (lowercase hex, no spaces) of an armored
 * PUBLIC (or private) key. Throws if the key cannot be parsed.
 */
export async function fingerprintOf(armoredKey: string): Promise<string> {
    const key = await openpgp.readKey({ armoredKey });
    return normalizeFingerprint(key.getFingerprint());
}

/**
 * Verify that an armored key the server returned actually matches the fingerprint
 * the server INDEPENDENTLY reported for that key (gpgkey.fingerprint).
 *
 * THREAT MODEL: in this zero-knowledge architecture the server is untrusted on key
 * distribution. A compromised backend could hand back an attacker-controlled public
 * key for a victim recipient; encrypting a secret to it would silently leak the
 * plaintext to the attacker (and lock the legitimate recipient out). Cross-checking
 * the armored body against the separately-reported fingerprint raises the bar:
 * to defeat it the server must lie consistently in two fields, and any out-of-band
 * pinned/known fingerprint can then be compared against this single value.
 *
 * @returns the verified (normalized) fingerprint.
 * @throws if the key is unparseable, the expected fingerprint is missing, or they differ.
 */
export async function verifyArmoredKeyFingerprint(
    armoredKey: string,
    expectedFingerprint: string | null | undefined,
    who: string
): Promise<string> {
    let actual: string;
    try {
        actual = await fingerprintOf(armoredKey);
    } catch {
        throw new Error(`The public key for ${who} could not be parsed and cannot be trusted.`);
    }
    if (!expectedFingerprint) {
        throw new Error(
            `No fingerprint was reported for ${who}, so their public key cannot be verified.`
        );
    }
    if (normalizeFingerprint(expectedFingerprint) !== actual) {
        throw new Error(
            `Public-key fingerprint mismatch for ${who}. The key returned by the server does not match its reported fingerprint; refusing to encrypt to an unverified key.`
        );
    }
    return actual;
}

/**
 * Generate a fresh RSA OpenPGP key pair for account setup / recovery.
 *
 * SECURITY: the generated private key is ALWAYS passphrase-protected. We THROW on
 * an empty passphrase — JPassbolt refuses to mint an unprotected key, because an
 * unprotected armored private key persisted in localStorage would let anyone with
 * access to the browser profile unlock the vault with any passphrase (the same
 * invariant enforced in auth.ts/loginWithGpg and KeyContext.unlock).
 *
 * The returned armoredPrivateKey + fingerprint stay CLIENT-SIDE; only the
 * armoredPublicKey is ever sent to the server (via setup/complete).
 *
 * @param opts.name        Full name for the key's user ID (from the profile).
 * @param opts.email       Email/username for the key's user ID (user.username).
 * @param opts.passphrase  Passphrase to protect the private key (required, non-empty).
 * @param opts.rsaBits     RSA key size; defaults to 3072 (faster in-browser; 4096 acceptable but slow).
 */
export async function generateKeyPair(opts: {
    name: string;
    email: string;
    passphrase: string;
    rsaBits?: number;
}): Promise<{ armoredPrivateKey: string; armoredPublicKey: string; fingerprint: string }> {
    if (!opts.passphrase || opts.passphrase.length === 0) {
        throw new Error(
            'A passphrase is required: JPassbolt refuses to create an unprotected (passphrase-less) private key.',
        );
    }

    const { privateKey, publicKey } = await openpgp.generateKey({
        type: 'rsa',
        rsaBits: opts.rsaBits ?? 3072,
        userIDs: [{ name: opts.name, email: opts.email }],
        passphrase: opts.passphrase,
        format: 'armored',
    });

    // Derive the fingerprint from the PUBLIC key via the existing helper
    // (normalized lowercase hex, no spaces).
    const fingerprint = await fingerprintOf(publicKey);

    return {
        armoredPrivateKey: privateKey,
        armoredPublicKey: publicKey,
        fingerprint,
    };
}

/**
 * Encrypt a text message using one or more public keys.
 * Used when creating/sharing secrets.
 *
 * @param text The plaintext to encrypt
 * @param armoredPublicKeys Array of public keys to encrypt for
 * @returns The armored PGP encrypted message
 */
export async function encryptMessage(
    text: string,
    armoredPublicKeys: string[]
): Promise<string> {
    const encryptionKeys = await Promise.all(
        armoredPublicKeys.map((key) => openpgp.readKey({ armoredKey: key }))
    );

    const message = await openpgp.createMessage({ text });

    const armoredMessage = await openpgp.encrypt({
        message,
        encryptionKeys,
    });

    return armoredMessage as string;
}
