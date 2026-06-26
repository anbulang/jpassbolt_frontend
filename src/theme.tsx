/* eslint-disable react-refresh/only-export-components */
/**
 * Theme + security-behaviour preferences (the Aegis "Tweaks" surface, made real).
 *
 * Holds a small, persisted preferences object that drives the design's
 * cross-cutting UX:
 *   - theme        — 'light' (default, per the Aegis design) | 'dark'. Applied
 *                    as `data-theme` on <html>, which flips the oklch token set.
 *   - density      — 'comfortable' | 'compact'. Toggles `.app.compact` (denser
 *                    folder rows + resource cards).
 *   - revealSecs   — auto re-lock a revealed secret after N seconds.
 *   - burnSecs     — clear the clipboard N seconds after copying a password.
 *   - idleSecs     — auto-lock the vault after N seconds of no interaction.
 *
 * Persisted to localStorage so the choice survives reloads. This is pure UI
 * preference state — it never touches keys, passphrases, or ciphertext.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export interface Prefs {
  theme: ThemeMode;
  density: Density;
  /** Seconds a revealed secret stays decrypted before auto re-locking. */
  revealSecs: number;
  /** Seconds after a copy before the clipboard is best-effort cleared. */
  burnSecs: number;
  /** Seconds of inactivity before the vault auto-locks (0 = never). */
  idleSecs: number;
}

const DEFAULTS: Prefs = {
  theme: 'light',
  density: 'comfortable',
  revealSecs: 20,
  burnSecs: 30,
  // 30 minutes — aligns the vault auto-lock window with Passbolt's ~half-hour
  // passphrase/session feel (was 300s = 5 min, which users read as "logged out").
  idleSecs: 1800,
};

export const LS_PREFS = 'jpassbolt_prefs';

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Read the configured idle-lock seconds from persisted prefs, for non-React
 * callers (e.g. the passphrase cache TTL in KeyContext). Returns the same value
 * the live ThemeProvider would expose. 0 means "auto-lock disabled".
 */
export function readIdleSecs(): number {
  return readPrefs().idleSecs;
}

interface ThemeContextValue {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);

  // Apply the theme to <html> so the token override in index.css takes effect,
  // and persist the whole prefs object on every change.
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    try {
      localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
    } catch {
      /* storage unavailable (private mode); prefs stay in-memory only */
    }
  }, [prefs]);

  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleTheme = useCallback(() => {
    setPrefs((prev) => ({ ...prev, theme: prev.theme === 'dark' ? 'light' : 'dark' }));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ prefs, setPref, toggleTheme }),
    [prefs, setPref, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Hook for the theme/preferences context. Throws outside a ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be used within a <ThemeProvider>.');
  }
  return ctx;
}
