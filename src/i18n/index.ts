/**
 * react-i18next bootstrap for the SPA.
 *
 * Chinese ('zh') is the default UI language; English ('en') is the fallback.
 * The user's choice lives in the persisted Prefs (localStorage 'jpassbolt_prefs'
 * .locale) and is mirrored to the backend account locale (account_settings
 * 'locale' = 'zh-CN' | 'en-UK', see services/accountSettings.ts) so the backend
 * can localize transactional emails per recipient.
 *
 * Namespace resources are auto-discovered with Vite's import.meta.glob: every
 * file at `locales/<lng>/<ns>.json` becomes resources[lng][ns]. A migration that
 * adds a new namespace just drops a JSON pair under locales/ — this config file
 * never has to change, which keeps parallel string-migration work conflict-free.
 */
import i18n from 'i18next';
import type { Resource, ResourceLanguage } from 'i18next';
import { initReactI18next } from 'react-i18next';

export type AppLocale = 'zh' | 'en';
export const SUPPORTED_LOCALES: AppLocale[] = ['zh', 'en'];
export const DEFAULT_LOCALE: AppLocale = 'zh';

/**
 * Initial language from persisted prefs. Read straight from localStorage (not
 * via theme.tsx) so this module has no import cycle with the ThemeProvider that
 * imports it back to drive changeLanguage().
 */
function initialLocale(): AppLocale {
  try {
    const raw = localStorage.getItem('jpassbolt_prefs');
    const loc = raw ? (JSON.parse(raw) as { locale?: string }).locale : undefined;
    if (loc === 'zh' || loc === 'en') return loc;
  } catch {
    /* storage unavailable (private mode) — fall through to the default */
  }
  return DEFAULT_LOCALE;
}

// Eagerly load every `locales/<lng>/<ns>.json` into resources[lng][ns].
const modules = import.meta.glob('./locales/*/*.json', { eager: true });
const resources: Resource = {};
for (const path in modules) {
  const match = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!match) continue;
  const [, lng, ns] = match;
  const lang: ResourceLanguage = (resources[lng] ??= {});
  lang[ns] = (modules[path] as { default: Record<string, unknown> }).default;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale(),
  fallbackLng: 'en',
  defaultNS: 'common',
  // React escapes by default, so i18next must not double-escape interpolations.
  interpolation: { escapeValue: false },
  // Treat a missing key as "fall back to the key/English", never render null.
  returnNull: false,
});

export default i18n;
