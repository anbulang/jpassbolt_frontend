/**
 * Self-registration policy transport — admin Administration console.
 *
 * Pure transport. Mirrors orgPolicies.ts: unwrap the Passbolt envelope and fall
 * back to a well-formed default. Errors propagate; the panel renders them via
 * describeApiError().
 *
 * Backend (admin-gated): SelfRegistrationSettingsController.
 *   GET    /self-registration/settings.json      -> current policy or {provider:null,data:null}
 *   POST   /self-registration/settings.json       -> validate + persist; returns rendered settings
 *   DELETE /self-registration/settings/{id}.json  -> disable (delete the row)
 *
 * The only CE provider is 'email_domains' (an allow-list of email domains a guest
 * may self-register from). `provider === null` means self-registration is OFF.
 * NOTE: the public guest sign-up endpoints (/self-registration/dry-run.json,
 * /users/register.json) are a DIFFERENT, guest-only flow and intentionally live
 * elsewhere — this module is only the admin policy surface.
 */
import { api } from '../api';
import type { ApiResponse } from '../types';

export type SelfRegistrationProvider = 'email_domains' | null;

export interface SelfRegistrationSettings {
  provider: SelfRegistrationProvider;
  data: { allowed_domains: string[] } | null;
  // Present only when a policy row exists.
  id?: string;
  created?: string;
  modified?: string;
  created_by?: string;
  modified_by?: string;
}

/** The "off" shape the backend returns when no policy row exists. */
export const DISABLED_SELF_REGISTRATION: SelfRegistrationSettings = {
  provider: null,
  data: null,
};

/** GET /self-registration/settings.json (admin only). */
export async function getSelfRegistrationSettings(
  signal?: AbortSignal,
): Promise<SelfRegistrationSettings> {
  const res = await api.get<ApiResponse<SelfRegistrationSettings>>(
    '/self-registration/settings.json',
    { signal },
  );
  return res.data.body ?? DISABLED_SELF_REGISTRATION;
}

/** POST /self-registration/settings.json — enable / update the policy (admin only). */
export async function saveSelfRegistrationSettings(
  allowedDomains: string[],
): Promise<SelfRegistrationSettings> {
  const res = await api.post<ApiResponse<SelfRegistrationSettings>>(
    '/self-registration/settings.json',
    { provider: 'email_domains', data: { allowed_domains: allowedDomains } },
  );
  return res.data.body ?? DISABLED_SELF_REGISTRATION;
}

/**
 * DELETE /self-registration/settings/{id}.json — turn self-registration off.
 * Returns the disabled shape. Call only with a real settings id (the panel skips
 * this when nothing is configured).
 */
export async function disableSelfRegistration(
  id: string,
): Promise<SelfRegistrationSettings> {
  const res = await api.delete<ApiResponse<SelfRegistrationSettings>>(
    `/self-registration/settings/${id}.json`,
  );
  return res.data.body ?? DISABLED_SELF_REGISTRATION;
}
