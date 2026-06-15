/**
 * MFA (TOTP) endpoints: per-user setup/verify/disable plus the admin org-level
 * settings. nullBody-aware (several of these return `body: null`).
 *
 * The backend never renders a QR image (otpQrCodeSvg is always ""); the
 * Settings page generates the QR client-side from otpProvisioningUri.
 */
import { api } from '../api';
import type { ApiResponse, MfaOrgSettings, MfaSetupState } from '../types';

/**
 * GET /mfa/setup/totp.json — when not configured returns
 * { otpProvisioningUri, otpQrCodeSvg: "" }; when configured returns
 * { verified }.
 */
export async function getTotpSetupState(): Promise<MfaSetupState> {
  const res = await api.get<ApiResponse<MfaSetupState>>('/mfa/setup/totp.json');
  return (res.data.body ?? {}) as MfaSetupState;
}

/**
 * GET /mfa/setup/totp/start.json — lightweight "is setup needed?" probe.
 * Returns { verified } when configured, or null (nullBody) when not.
 */
export async function startTotpSetup(): Promise<MfaSetupState | null> {
  const res = await api.get<ApiResponse<MfaSetupState>>(
    '/mfa/setup/totp/start.json'
  );
  return res.data.body;
}

/** POST /mfa/setup/totp.json — enable TOTP (validates the URI + a live code). */
export async function enableTotp(req: {
  otpProvisioningUri: string;
  totp: string;
}): Promise<MfaSetupState> {
  const res = await api.post<ApiResponse<MfaSetupState>>(
    '/mfa/setup/totp.json',
    req
  );
  return res.data.body as MfaSetupState;
}

/** DELETE /mfa/setup/totp.json — disable TOTP (idempotent). */
export async function disableTotp(): Promise<void> {
  await api.delete('/mfa/setup/totp.json');
}

/**
 * POST /mfa/verify/{provider}.json — submit an OTP code. `remember` is the
 * 0|1 integer enum the backend expects. nullBody response — resolves to void.
 */
export async function verifyTotp(
  provider: string,
  req: { totp: string; remember: 0 | 1 }
): Promise<void> {
  await api.post(`/mfa/verify/${provider}.json`, req);
}

/**
 * The shape the backend returns from the MFA-required gate (GET
 * /mfa/verify/error.json, 403): the providers the user may verify with.
 */
export interface MfaRequired {
  mfa_providers: string[];
  providers?: Record<string, unknown>;
}

/**
 * Probe whether MFA is required for the freshly-authenticated session.
 *
 * The backend enforces MFA AFTER GpgAuth login via the MfaEnforcementFilter: it
 * 302-redirects any NON-whitelisted protected request to /mfa/verify/error.json
 * (HTTP 403, body `{ mfa_providers: ['totp'], providers: {...} }`) ONLY when the
 * user has ≥1 enabled provider and no valid passbolt_mfa cookie. So we probe a
 * genuinely gated endpoint (GET /users/me.json — not whitelisted) with the JWT
 * already in localStorage (the api interceptor attaches it):
 *   - 2xx                                    -> MFA NOT enforced, return null.
 *   - 403 carrying a NON-EMPTY mfa_providers -> MFA required, return the providers.
 *   - anything else (401/network/empty list) -> do NOT block login, return null.
 *
 * IMPORTANT: we must NOT hit /mfa/verify/error.json directly — that endpoint
 * ALWAYS returns 403 (it is the redirect landing page), so it cannot distinguish
 * an MFA-required user from a normal one; only a non-empty provider list on a
 * gated endpoint's redirected 403 is a reliable "MFA required" signal. Probing a
 * gated endpoint also means a user WITHOUT MFA (200) is never forced to a
 * challenge they cannot answer.
 *
 * This is a READ-ONLY probe: it never submits a code and never mutates session
 * state, so it is safe to call right after loginWithGpg on the happy path.
 */
export async function probeMfaRequired(): Promise<MfaRequired | null> {
  try {
    await api.get('/users/me.json');
    // 200 means the MFA filter did not gate this request — no challenge needed.
    return null;
  } catch (err: unknown) {
    const e = err as {
      response?: { status?: number; data?: { body?: MfaRequired } & MfaRequired };
    };
    if (e.response?.status === 403) {
      // The MFA-required body may live at the envelope root or under `body`.
      const data = e.response.data;
      const required = (data?.body ?? data) as MfaRequired | undefined;
      const providers = required?.mfa_providers;
      if (Array.isArray(providers) && providers.length > 0) {
        return { mfa_providers: providers, providers: required?.providers };
      }
    }
    // A 2xx, a non-MFA 403, a 401, or a network error: never block login here.
    return null;
  }
}

/**
 * Submit a login-time MFA TOTP code to satisfy the post-login challenge.
 *
 * POST /mfa/verify/{provider}.json { totp, remember: 0|1 }. Delegates to the
 * existing verifyTotp() so the wire shape stays identical. On success the
 * backend marks the session as MFA-verified; resolves void. Throws on an invalid
 * code (400) or rate limiting (429) so the caller can surface the error.
 */
export async function verifyMfaLogin(
  provider: string,
  totp: string,
  remember: boolean
): Promise<void> {
  await verifyTotp(provider, { totp, remember: remember ? 1 : 0 });
}

/** GET /mfa/settings.json — org-level MFA config (admin only). */
export async function getOrgMfaSettings(): Promise<MfaOrgSettings> {
  const res = await api.get<ApiResponse<MfaOrgSettings>>('/mfa/settings.json');
  return (res.data.body ?? { providers: [] }) as MfaOrgSettings;
}

/**
 * POST /mfa/settings.json — set the org-level enabled providers (admin only).
 * Only "totp" is accepted; an empty array disables MFA org-wide.
 */
export async function updateOrgMfaSettings(
  providers: string[]
): Promise<MfaOrgSettings> {
  const res = await api.post<ApiResponse<MfaOrgSettings>>('/mfa/settings.json', {
    providers,
  });
  return (res.data.body ?? { providers: [] }) as MfaOrgSettings;
}
