/**
 * resourceFormat — the v4-vs-v5 create/update format decision, isolated so it is
 * pure, unit-testable, and provably non-dead.
 *
 * The UI must NEVER surface a v4/v5 toggle to the user (product directive). The
 * format is driven SOLELY by the org's metadata-types policy + metadata-key
 * availability. {@link decideResourceFormat} encapsulates that whole decision:
 * ResourceFormModal calls it once per submit and branches on the result.
 *
 * NON-DEAD PROOF: out of the box the backend ships
 *   default_resource_types = 'v4', allow_creation_of_v5_resources = false,
 * and no seeded metadata key, so this ALWAYS returns { format: 'v4' } today —
 * the v5 branch is reachable and correct but inert. The instant an admin enables
 * v5 in the EncryptedMetadataSettings panel AND an active metadata key exists,
 * the SAME create flow transparently produces v5 with zero UI change.
 */
import type { MetadataKeyType, MetadataTypesSettings, ResourceType } from '../../types';
import { V5_PASSWORD_SLUGS } from './secretFormat';

/** Inputs to the format decision. */
export interface DecideResourceFormatArgs {
  /** Org create-format policy (GET /metadata/types/settings.json), or null if not yet loaded. */
  typesSettings: MetadataTypesSettings | null;
  /** The resource type the user picked in the selector. */
  selectedResourceType: ResourceType;
  /**
   * True when an active, non-expired, non-deleted SHARED metadata key exists AND
   * its private half is decrypted in memory (MetadataKeyContext.available).
   */
  metadataKeyAvailable: boolean;
  /** Whether the org allows personal (user_key) metadata (allow_usage_of_personal_keys). */
  allowPersonalKeys: boolean;
}

/** The format decision. `metadataKeyType` is only meaningful for v5. */
export interface ResourceFormatDecision {
  format: 'v4' | 'v5';
  metadataKeyType?: MetadataKeyType;
}

/** True when a resource-type slug is one of the v5 password-shaped slugs. */
function isV5Slug(slug: string): boolean {
  return (V5_PASSWORD_SLUGS as readonly string[]).includes(slug);
}

/**
 * Decide whether to create/update a resource in v4 (cleartext columns) or v5
 * (encrypted metadata) form.
 *
 * Chooses v5 ONLY when ALL of:
 *   1. typesSettings.default_resource_types === 'v5'
 *   2. typesSettings.allow_creation_of_v5_resources === true
 *   3. the selected resource type is a v5 slug
 *   4. a usable shared metadata key exists (metadataKeyAvailable)
 *
 * Otherwise returns v4 — EXACTLY today's plaintext path.
 *
 * For v5, metadataKeyType defaults to 'shared_key'. A personal 'user_key' is
 * only chosen when the shared key is unavailable AND allowPersonalKeys is true —
 * but note condition (4) above already requires the shared key for v5, so in
 * practice v5 today always means 'shared_key'. The user_key branch is kept for
 * forward-compatibility with personal-key metadata.
 */
export function decideResourceFormat(args: DecideResourceFormatArgs): ResourceFormatDecision {
  const { typesSettings, selectedResourceType, metadataKeyAvailable, allowPersonalKeys } = args;

  const v5Selected =
    typesSettings != null &&
    typesSettings.default_resource_types === 'v5' &&
    typesSettings.allow_creation_of_v5_resources === true &&
    isV5Slug(selectedResourceType.slug) &&
    metadataKeyAvailable;

  if (!v5Selected) {
    return { format: 'v4' };
  }

  // v5: shared key is the normal case (and is required by condition 4 above).
  // A personal user_key is only viable when no shared key exists AND the org
  // permits personal keys — unreachable today given the shared-key gate, but
  // kept explicit so the rule reads correctly.
  const metadataKeyType: MetadataKeyType =
    !metadataKeyAvailable && allowPersonalKeys ? 'user_key' : 'shared_key';

  return { format: 'v5', metadataKeyType };
}
