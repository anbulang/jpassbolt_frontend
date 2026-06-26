/**
 * Centralized, localized API-error description.
 *
 * Turns any thrown request error into a message that distinguishes the failure
 * CLASS the user actually cares about — instead of axios's raw
 * "Request failed with status code 403":
 *
 *   - no HTTP response (server down / CORS / DNS / timeout) → "can't reach server"
 *   - 401, or a bare 403 with no Passbolt envelope (anonymous request denied by
 *     Spring Security) → "session expired, sign in again"
 *   - 403 WITH an envelope (an authenticated caller lacking permission) → the
 *     backend's own message, else "no permission"
 *   - 5xx → "server problem"
 *   - otherwise → backend header.message, else a generic fallback
 *
 * Pairs with api.ts, which independently tears down a dead session on the same
 * 401/bare-403 signal; this helper is purely for what the UI SHOWS.
 */
import i18n from './index';

interface AxiosLikeError {
  response?: { status?: number; data?: unknown };
  code?: string;
  message?: string;
}

export function describeApiError(err: unknown): string {
  const t = i18n.t.bind(i18n);
  const e = (err ?? {}) as AxiosLikeError;
  const res = e.response;

  // No response object at all → the request never reached a live server.
  if (!res) {
    if (e.code === 'ECONNABORTED') return t('common:errors.timeout');
    return t('common:errors.network');
  }

  const status = res.status ?? 0;
  const data = res.data as
    | { header?: { message?: string }; body?: { mfa_providers?: unknown[] } }
    | undefined;
  const hasEnvelope = !!(data && typeof data === 'object' && 'header' in data);
  const backendMsg = data?.header?.message;
  const mfaRequired =
    Array.isArray(data?.body?.mfa_providers) && data!.body!.mfa_providers!.length > 0;

  if (status === 401 || (status === 403 && !hasEnvelope && !mfaRequired)) {
    return t('common:errors.sessionExpired');
  }
  if (status === 403) return backendMsg || t('common:errors.forbidden');
  if (status === 404) return backendMsg || t('common:errors.notFound');
  if (status >= 500) return t('common:errors.server');
  return backendMsg || e.message || t('common:errors.unknown');
}
