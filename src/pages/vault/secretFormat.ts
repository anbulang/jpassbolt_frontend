/**
 * Secret payload (de)serialization per Passbolt v4 resource type.
 *
 * The server stores the secret `data` field as opaque OpenPGP ciphertext — it
 * never sees the plaintext. The *plaintext* shape is a client-side convention
 * that must match what the official Passbolt frontend produces so the two stay
 * interoperable:
 *
 *   - `password-string`            -> the decrypted text IS the raw password.
 *   - `password-and-description`   -> the decrypted text is JSON
 *                                     {"password": "...", "description": "..."}.
 *
 * These helpers convert between the in-app {password, description} model and the
 * decrypted plaintext for a given resource type slug, in both directions.
 *
 * NOTE: nothing here logs or persists plaintext — callers encrypt the result
 * immediately via useKey().encryptFor / decrypt the input from useKey().decrypt.
 */

/** Canonical seed ids for the two v4 password resource types (see backend seed). */
export const RESOURCE_TYPE_ID = {
  PASSWORD_STRING: '669f8c64-242a-59fb-92fc-81f660975fd3',
  PASSWORD_AND_DESCRIPTION: 'a28a04cd-6f53-518a-967c-9963bf9cec51',
} as const;

/** Resource-type slugs we know how to (de)serialize a password secret for. */
export const PASSWORD_SLUGS = ['password-string', 'password-and-description'] as const;

export interface SecretContent {
  password: string;
  /** The encrypted-side description (only used by `password-and-description`). */
  description: string;
}

/**
 * True when the given resource-type slug keeps the description *inside* the
 * encrypted secret (rather than as cleartext resource metadata).
 */
export function isEncryptedDescriptionType(slug: string | undefined): boolean {
  return slug === 'password-and-description' || slug === 'password-description-totp';
}

/**
 * Build the plaintext that should be encrypted for a secret, given the
 * resource-type slug and the in-app content. The returned string is what gets
 * passed to encryptFor() — it is never logged or stored in cleartext.
 */
export function encodeSecret(slug: string | undefined, content: SecretContent): string {
  if (isEncryptedDescriptionType(slug)) {
    return JSON.stringify({
      password: content.password,
      description: content.description ?? '',
    });
  }
  // password-string (and any unknown slug): the password is the whole secret.
  return content.password;
}

/**
 * Parse a decrypted secret plaintext back into the in-app content model, given
 * the resource-type slug. Tolerates a JSON body even for string types (some
 * historical resources store JSON regardless) and falls back to treating the
 * whole plaintext as the password.
 */
export function decodeSecret(slug: string | undefined, plaintext: string): SecretContent {
  const trimmed = plaintext.trim();
  if (isEncryptedDescriptionType(slug) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed) as { password?: unknown; description?: unknown };
      if (parsed && typeof parsed === 'object' && 'password' in parsed) {
        return {
          password: typeof parsed.password === 'string' ? parsed.password : '',
          description: typeof parsed.description === 'string' ? parsed.description : '',
        };
      }
    } catch {
      /* not JSON after all — fall through to raw string handling */
    }
  }
  return { password: plaintext, description: '' };
}
