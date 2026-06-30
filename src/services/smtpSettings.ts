/**
 * SMTP (email server) settings transport — admin Administration console.
 *
 * Pure transport, NO business logic. Mirrors orgPolicies.ts / mfa.ts: unwrap the
 * standard Passbolt envelope (`res.data.body`) and fall back to a well-formed
 * default when the body is null, so callers never crash on an absent payload.
 * Errors propagate (axios throws); the panel catches them via describeApiError().
 *
 * Backend (admin-gated): SmtpSettingsController.
 *   GET  /smtp/settings.json -> resolved transport config + `source` (db/env/undefined)
 *   POST /smtp/settings.json -> validate, GPG-encrypt, persist; returns the rendered settings
 *   POST /smtp/email.json     -> send a test email through the POSTED config; returns a
 *                                credentials-masked SMTP wire trace ({ debug: [...] })
 *
 * The password is GPG-encrypted at rest in organization_settings; the admin-only
 * GET returns it decrypted so the form can show and re-submit it.
 */
import { api } from '../api';
import type { ApiResponse } from '../types';

/**
 * Effective SMTP config as rendered by SmtpSettingsService.get(). `source` says
 * where it came from: 'db' (saved here, carries id/audit columns), 'env' (from
 * environment / yaml — a read-only origin a DB override supersedes), or
 * 'undefined' (nothing configured). `tls`/`port` are permissively typed because
 * the backend coerces JSON number/bool/string; the form normalizes them.
 */
export interface SmtpSettings {
  sender_name: string;
  sender_email: string;
  host: string;
  port: number | string | null;
  tls: boolean | number | string | null;
  client: string | null;
  username: string | null;
  password: string | null;
  source?: string | null;
  // Present only when source === 'db'.
  id?: string;
  created?: string;
  modified?: string;
  created_by?: string;
  modified_by?: string;
}

/** The write payload (POST /smtp/settings.json) — no `source` / audit columns. */
export interface SmtpSettingsWrite {
  sender_name: string;
  sender_email: string;
  host: string;
  port: number;
  tls: boolean;
  client: string;
  username: string;
  password: string;
}

/** A blank, source-less config used as the fallback when nothing is configured. */
export const EMPTY_SMTP_SETTINGS: SmtpSettings = {
  sender_name: '',
  sender_email: '',
  host: '',
  port: 587,
  tls: true,
  client: '',
  username: '',
  password: '',
  source: 'undefined',
};

/** GET /smtp/settings.json — the resolved SMTP config (admin only). */
export async function getSmtpSettings(signal?: AbortSignal): Promise<SmtpSettings> {
  const res = await api.get<ApiResponse<SmtpSettings>>('/smtp/settings.json', { signal });
  return { ...EMPTY_SMTP_SETTINGS, ...(res.data.body ?? {}) };
}

/** POST /smtp/settings.json — validate + GPG-encrypt + persist (admin only). */
export async function saveSmtpSettings(payload: SmtpSettingsWrite): Promise<SmtpSettings> {
  const res = await api.post<ApiResponse<SmtpSettings>>('/smtp/settings.json', payload);
  return { ...EMPTY_SMTP_SETTINGS, ...(res.data.body ?? payload) };
}

/** The masked SMTP wire trace returned by the test-email endpoint. */
export interface SmtpTestResult {
  debug: string[];
}

/**
 * POST /smtp/email.json — send a test email through the POSTED config (not the
 * saved one), so an admin can verify a draft before persisting. Returns the
 * masked SMTP trace. On a delivery/validation failure the backend answers 400
 * with the SAME { debug } shape in the body — the caller reads it off the thrown
 * error's response to still surface the trace.
 */
export async function sendTestEmail(
  payload: SmtpSettingsWrite & { email_test_to: string },
): Promise<SmtpTestResult> {
  const res = await api.post<ApiResponse<SmtpTestResult>>('/smtp/email.json', payload);
  return (res.data.body ?? { debug: [] }) as SmtpTestResult;
}
