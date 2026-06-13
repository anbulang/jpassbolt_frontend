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
