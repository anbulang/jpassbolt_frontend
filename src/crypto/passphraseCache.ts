// src/crypto/passphraseCache.ts — short-lived passphrase cache for survive-refresh UX.
//
// SECURITY TRADE-OFF (explicitly chosen by the operator):
//   The zero-knowledge default is "passphrase in memory only, never persisted"
//   (see KeyContext.tsx). To make an UNLOCKED vault survive a page refresh — the
//   way Passbolt's browser extension does via its Service Worker — a plain web SPA
//   must persist *something* across the reload. We persist the PASSPHRASE here in
//   sessionStorage, NOT localStorage:
//     - sessionStorage is scoped to the tab and is cleared when the tab/window
//       closes; it is generally memory-backed and not written to disk the way
//       localStorage is. So the exposure window is "this tab, while open".
//     - We additionally stamp an absolute expiry (tied to the idle-lock window)
//       so the cache self-destructs after inactivity even if lock() never ran.
//   The armored private key in localStorage is STILL passphrase-protected; this
//   cache only removes the re-typing step within an active session. On lock(),
//   clear(), logout(), and any 401 we wipe this cache.

const SS_KEY = 'jpassbolt_pp_cache';

interface CacheEntry {
    /** The passphrase. */
    p: string;
    /** Absolute expiry (epoch ms), or null for "no expiry" (auto-lock disabled). */
    e: number | null;
}

/**
 * Cache the passphrase for the current tab session.
 * @param passphrase the passphrase to remember
 * @param ttlSecs    seconds until expiry; <=0 or null means "no expiry" (used when
 *                   the user has disabled auto-lock, i.e. idleSecs === 0).
 */
export function cachePassphrase(passphrase: string, ttlSecs: number | null): void {
    try {
        const e = ttlSecs && ttlSecs > 0 ? Date.now() + ttlSecs * 1000 : null;
        const entry: CacheEntry = { p: passphrase, e };
        sessionStorage.setItem(SS_KEY, JSON.stringify(entry));
    } catch {
        /* sessionStorage unavailable (private mode / quota) — degrade to no cache */
    }
}

/**
 * Return the cached passphrase if present and not expired, else null.
 * Expired or malformed entries are cleared as a side effect.
 */
export function readCachedPassphrase(): string | null {
    try {
        const raw = sessionStorage.getItem(SS_KEY);
        if (!raw) return null;
        const { p, e } = JSON.parse(raw) as CacheEntry;
        if (typeof p !== 'string' || p.length === 0) {
            clearCachedPassphrase();
            return null;
        }
        if (e != null && Date.now() >= e) {
            clearCachedPassphrase();
            return null;
        }
        return p;
    } catch {
        // Malformed JSON or read failure — treat as no cache.
        clearCachedPassphrase();
        return null;
    }
}

/**
 * Slide the expiry of an existing cache entry forward by ttlSecs (called on user
 * activity so an actively-used session keeps surviving refreshes). No-op if there
 * is no entry. Does not create an entry from nothing.
 */
export function touchPassphraseCache(ttlSecs: number | null): void {
    try {
        const raw = sessionStorage.getItem(SS_KEY);
        if (!raw) return;
        const entry = JSON.parse(raw) as CacheEntry;
        if (typeof entry.p !== 'string' || entry.p.length === 0) {
            clearCachedPassphrase();
            return;
        }
        entry.e = ttlSecs && ttlSecs > 0 ? Date.now() + ttlSecs * 1000 : null;
        sessionStorage.setItem(SS_KEY, JSON.stringify(entry));
    } catch {
        /* ignore — sliding is best-effort */
    }
}

/** Wipe the cached passphrase. Safe to call when nothing is cached. */
export function clearCachedPassphrase(): void {
    try {
        sessionStorage.removeItem(SS_KEY);
    } catch {
        /* ignore */
    }
}
