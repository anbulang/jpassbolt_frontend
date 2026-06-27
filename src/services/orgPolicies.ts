/**
 * Organization-level policy transport (admin Settings surface).
 *
 * Pure transport — NO crypto, NO business logic. Mirrors settings.ts / metadata.ts:
 * each function unwraps the standard Passbolt envelope (`response.data.body`) and
 * falls back to a well-formed default when the body is null, so callers never crash
 * on an absent/incomplete payload. Errors propagate (axios throws); the Settings
 * page catches and renders them via describeApiError().
 *
 * Endpoints (admin-gated except password policies, which any user may READ):
 *   GET  /settings/emails/notifications.json  -> 25 snake_case boolean toggles [ADMIN]
 *   POST /settings/emails/notifications.json   -> persist a PARTIAL set, returns the full set [ADMIN]
 *   GET  /password-policies/settings.json      -> read-only generator policy summary [any user]
 *
 * The admin GET endpoints are only ever invoked from an admin-gated section, so a
 * non-admin browser never issues these requests (see Settings.tsx OrgPoliciesTab).
 */
import { api } from '../api';
import type {
  ApiResponse,
  EmailNotificationSettings,
  PasswordPolicies,
} from '../types';

/**
 * Out-of-the-box backend defaults for the 25 email-notification toggles. Used as
 * the fallback so callers always receive a fully-populated object even if the
 * settings row is absent (body === null). Mirrors Passbolt's shipped defaults:
 * every event notification on, every "show_*" content flag on, purify_subject off.
 */
export const DEFAULT_EMAIL_NOTIFICATION_SETTINGS: EmailNotificationSettings = {
  show_comment: true,
  show_description: true,
  show_secret: true,
  show_uri: true,
  show_username: true,
  send_password_create: true,
  send_password_update: true,
  send_password_delete: true,
  send_password_share: true,
  send_comment_add: true,
  send_comment_update: true,
  send_comment_delete: true,
  send_folder_create: true,
  send_folder_update: true,
  send_folder_delete: true,
  send_folder_share: true,
  send_group_delete: true,
  send_group_user_add: true,
  send_group_user_delete: true,
  send_group_user_update: true,
  send_group_manager_update: true,
  send_user_create: true,
  send_user_recover: true,
  send_admin_user_setup_completed: true,
  send_admin_user_recover_complete: true,
};

/** The seeded backend default for the read-only password policy summary. */
export const DEFAULT_PASSWORD_POLICIES: PasswordPolicies = {
  default_generator: 'password',
  external_dictionary_check: false,
  password_generator_settings: {
    length: 18,
  },
  passphrase_generator_settings: {
    words: 9,
    word_separator: ' ',
    word_case: 'lowercase',
  },
  source: 'default',
};

/**
 * GET /settings/emails/notifications.json — the org email-notification policy
 * (admin only). Falls back to the shipped defaults if the body is null.
 */
export async function getEmailNotificationSettings(
  signal?: AbortSignal
): Promise<EmailNotificationSettings> {
  const res = await api.get<ApiResponse<EmailNotificationSettings>>(
    '/settings/emails/notifications.json',
    { signal }
  );
  return { ...DEFAULT_EMAIL_NOTIFICATION_SETTINGS, ...(res.data.body ?? {}) };
}

/**
 * POST /settings/emails/notifications.json — persist a PARTIAL set of toggles
 * (admin only). The backend merges the partial into the stored policy and
 * returns the full updated set, which we normalize over the defaults so the
 * caller always receives every key.
 */
export async function setEmailNotificationSettings(
  partial: Partial<EmailNotificationSettings>
): Promise<EmailNotificationSettings> {
  const res = await api.post<ApiResponse<EmailNotificationSettings>>(
    '/settings/emails/notifications.json',
    partial
  );
  return { ...DEFAULT_EMAIL_NOTIFICATION_SETTINGS, ...(res.data.body ?? partial) };
}

/**
 * GET /password-policies/settings.json — the org password/passphrase generator
 * policy. Readable by any authenticated user; CE cannot edit it (the Settings
 * card is read-only). Falls back to the shipped defaults if the body is null.
 */
export async function getPasswordPolicies(
  signal?: AbortSignal
): Promise<PasswordPolicies> {
  const res = await api.get<ApiResponse<PasswordPolicies>>(
    '/password-policies/settings.json',
    { signal }
  );
  return res.data.body ?? DEFAULT_PASSWORD_POLICIES;
}
