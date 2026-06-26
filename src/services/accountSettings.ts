/**
 * Per-user account locale sync.
 *
 * The SPA's UI language is driven by local prefs (instant, offline-friendly).
 * We ALSO mirror the choice to the backend account settings so the server can
 * localize transactional emails per recipient — Passbolt stores this in
 * account_settings (property "locale") using BCP-47-ish codes like "zh-CN".
 *
 * Best-effort by contract: a failed sync (offline, or an older backend without
 * the endpoint) must never block the in-app language toggle.
 */
import { api } from '../api';
import type { AppLocale } from '../i18n';

/** Map the SPA's 2-letter UI locale to the Passbolt account-locale code. */
const APP_TO_PASSBOLT: Record<AppLocale, string> = {
  zh: 'zh-CN',
  en: 'en-UK',
};

/**
 * Persist the user's UI language to the backend account settings.
 * POST /account/settings/locales.json  { "value": "zh-CN" | "en-UK" }
 */
export async function setUserLocale(locale: AppLocale): Promise<void> {
  await api.post('/account/settings/locales.json', { value: APP_TO_PASSBOLT[locale] });
}

/** Map the SPA's light/dark theme to the Passbolt account-theme name. */
const APP_TO_PASSBOLT_THEME: Record<'light' | 'dark', string> = {
  light: 'default',
  dark: 'midgar',
};

/**
 * Persist the user's theme to the backend account settings (Passbolt parity,
 * cross-device sync). POST /account/settings/themes.json { "value": "default"|"midgar" }.
 * Best-effort by the same contract as setUserLocale — the UI itself stays driven
 * by local prefs, so a failed sync must never block the toggle.
 */
export async function setUserTheme(theme: 'light' | 'dark'): Promise<void> {
  await api.post('/account/settings/themes.json', { value: APP_TO_PASSBOLT_THEME[theme] });
}
