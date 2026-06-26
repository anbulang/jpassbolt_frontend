/* eslint-disable react-refresh/only-export-components */
// This file co-locates the MetadataKeyProvider with the useMetadataKey() hook (per blueprint),
// so the react-refresh "only export components" rule is disabled here by design.
//
// src/crypto/MetadataKeyContext.tsx — in-memory cache of the SHARED v5 metadata key.
//
// SECURITY MODEL (mirrors KeyContext.tsx EXACTLY):
//   The decrypted SHARED metadata PRIVATE key lives ONLY in a useRef — never serialized,
//   never logged, never persisted to localStorage/sessionStorage. The active MetadataKey
//   record (its PUBLIC armored_key + fingerprint + id, used to ENCRYPT) lives in a ref too.
//   Both refs are wiped when the vault locks (useKey().isLocked flips true) and on unmount.
//
//   localStorage may hold ONLY the 4 KeyContext keys — this provider writes NONE.
//
// LIFECYCLE: this provider is a CHILD of KeyProvider so it can call useKey(). An effect
// watches useKey().isLocked: on false it runs load() (fetch the active metadata key, decrypt
// the user's metadata_private_keys[].data with the in-memory GPG key, recover the shared
// private key into a ref); on true it runs wipe().
//
// TWO-HOP DECRYPT CHAIN (shared_key):
//   GET /metadata/keys.json?contain[metadata_private_keys]=1
//     -> pick the active key (deleted == null && expired == null)
//     -> find the current user's metadata_private_keys[].data
//     -> useKey().decrypt(data)                          (hop 1: own GPG key)
//     -> JSON.parse + narrow to PASSBOLT_METADATA_PRIVATE_KEY
//     -> openpgp.readPrivateKey({ armoredKey: blob.armored_key })
//     -> if blob.passphrase non-empty: openpgp.decryptKey(...)
//     -> cache the PrivateKey + the active MetadataKey record in refs.
//   Later, decryptResourceMetadata(blob) uses the cached shared PrivateKey (hop 2).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import * as openpgp from 'openpgp';
import type { PrivateKey } from 'openpgp';
import i18n from '../i18n';
import { useKey, LS_USER } from './KeyContext';
import { encryptMessage, fingerprintOf, verifyArmoredKeyFingerprint } from '../gpg';
import { listMetadataKeys } from '../services/metadata';
import type { MetadataKey, MetadataKeyType } from '../types';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------
export interface MetadataKeyContextValue {
  /** True after a load() attempt has settled (success OR a tolerated empty/no-key state). */
  ready: boolean;
  /**
   * True when an ACTIVE (non-expired, non-deleted) shared metadata key exists AND its
   * private half is decrypted into memory. Gates v5 create/update. False for v4-only orgs.
   */
  available: boolean;
  /** id of the active metadata_keys row (for metadata_key_id on writes), or null. */
  activeKeyId: string | null;
  /** Last load error (null when none). A load failure degrades to available=false, no throw. */
  loadError: string | null;

  /**
   * Decrypt a v5 resource `metadata` blob that was encrypted to the SHARED metadata key.
   * Throws if not ready / the vault is locked / no shared private key is cached.
   * (user_key resources do NOT use this — the resolver decrypts those via KeyContext.)
   */
  decryptResourceMetadata: (armoredMetadata: string) => Promise<string>;

  /**
   * Encrypt a v5 metadata JSON blob to the active SHARED metadata key. FIRST verifies the
   * active key's armored PUBLIC key against its reported fingerprint (server-substitution
   * defence), then encrypts. Returns the v5 write triple. Throws if not available.
   */
  encryptResourceMetadata: (plaintextJson: string) => Promise<{
    metadata: string;
    metadata_key_id: string;
    metadata_key_type: MetadataKeyType;
  }>;

  /** Manual re-fetch of the shared metadata key (e.g. after an admin rotates keys). */
  reload: () => Promise<void>;
}

const MetadataKeyContext = createContext<MetadataKeyContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/** Localized crypto-layer message helper (uses the i18n singleton, like i18n/errors.ts). */
function tc(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(`crypto:${key}`, opts ?? {});
}

/** Resolve the current user's id from the cached LS_USER blob (best-effort). */
function readCurrentUserId(): string | null {
  try {
    const raw = localStorage.getItem(LS_USER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

/** The decrypted PASSBOLT_METADATA_PRIVATE_KEY cleartext shape (narrowed at runtime). */
interface MetadataPrivateKeyBlob {
  armored_key: string;
  fingerprint: string;
  passphrase: string;
}

/**
 * Runtime-narrow a decrypted metadata_private_keys[].data blob to the
 * PASSBOLT_METADATA_PRIVATE_KEY shape (idiom borrowed from decodeSecret). Returns
 * null when the blob does not match (so load() can degrade to available=false).
 */
function narrowPrivateKeyBlob(plaintext: string): MetadataPrivateKeyBlob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.object_type !== 'PASSBOLT_METADATA_PRIVATE_KEY') return null;
  if (typeof obj.armored_key !== 'string' || obj.armored_key.length === 0) return null;
  return {
    armored_key: obj.armored_key,
    // fingerprint/passphrase: present per spec; tolerate missing by coercing.
    fingerprint: typeof obj.fingerprint === 'string' ? obj.fingerprint : '',
    passphrase: typeof obj.passphrase === 'string' ? obj.passphrase : '',
  };
}

/** Pick the ACTIVE shared metadata key (deleted == null && expired == null). */
function pickActiveKey(keys: MetadataKey[]): MetadataKey | null {
  return keys.find((k) => k.deleted == null && k.expired == null) ?? null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export function MetadataKeyProvider({ children }: { children: ReactNode }): JSX.Element {
  const { isLocked, decrypt } = useKey();

  // The decrypted SHARED metadata PRIVATE key — IN MEMORY ONLY, never persisted.
  const sharedPrivateKeyRef = useRef<PrivateKey | null>(null);
  // The active MetadataKey record (carries the PUBLIC armored_key + fingerprint + id).
  const activeKeyRef = useRef<MetadataKey | null>(null);
  // Generation token: bumped by wipe()/each load() entry so an in-flight load()
  // started before a lock can never resurrect the decrypted shared private key into
  // memory after wipe() ran. Every ref/state write after an await re-checks this.
  const genRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [activeKeyId, setActiveKeyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const wipe = useCallback(() => {
    // Invalidate any in-flight load() so it cannot write the decrypted shared
    // private key back into memory after this wipe (the lock-mid-flight race).
    genRef.current += 1;
    sharedPrivateKeyRef.current = null;
    activeKeyRef.current = null;
    setReady(false);
    setAvailable(false);
    setActiveKeyId(null);
    setLoadError(null);
  }, []);

  const load = useCallback(async () => {
    // Capture a per-invocation generation token. wipe()/lock bumps genRef, so once
    // this load is superseded (e.g. the vault locked mid-flight) every guarded write
    // below is skipped — the decrypted shared private key can never be resurrected
    // into memory after wipe(). Mirrors the cancelled-flag pattern in SecretPanel.
    const myGen = (genRef.current += 1);
    const isCurrent = () => genRef.current === myGen;

    // Reset the error from any prior attempt; keep refs until we succeed/fail.
    setLoadError(null);
    try {
      const keys = await listMetadataKeys({ containPrivateKeys: true });
      if (!isCurrent()) return;
      const active = pickActiveKey(keys);

      // No active shared metadata key configured (the default state today): tolerate it.
      // ready=true (load settled) but available=false (v4-only orgs see no errors).
      if (!active) {
        sharedPrivateKeyRef.current = null;
        activeKeyRef.current = null;
        setAvailable(false);
        setActiveKeyId(null);
        setReady(true);
        return;
      }

      // Find the current user's encrypted copy of this key's private half.
      const myId = readCurrentUserId();
      const privCopies = active.metadata_private_keys ?? [];
      const myCopy =
        (myId ? privCopies.find((p) => p.user_id === myId) : undefined) ??
        // The server already scopes these to the current user, so a single entry
        // is the user's own copy even if LS_USER.id was unavailable.
        privCopies[0];

      if (!myCopy) {
        // Active key exists but the user has no private-key copy: cannot decrypt
        // shared metadata. Degrade to available=false (v4 fallback), no throw.
        sharedPrivateKeyRef.current = null;
        activeKeyRef.current = active;
        setAvailable(false);
        setActiveKeyId(active.id);
        setReady(true);
        return;
      }

      // Hop 1: decrypt the user's copy with their own GPG key (KeyContext).
      const cleartext = await decrypt(myCopy.data);
      if (!isCurrent()) return;
      const blob = narrowPrivateKeyBlob(cleartext);
      if (!blob) {
        throw new Error(tc('metadata.errors.blobMalformed'));
      }

      // Read the shared key's PRIVATE half, decrypting it if it carries a passphrase.
      let priv = await openpgp.readPrivateKey({ armoredKey: blob.armored_key });
      if (!priv.isDecrypted() && blob.passphrase.length > 0) {
        priv = await openpgp.decryptKey({ privateKey: priv, passphrase: blob.passphrase });
      } else if (!priv.isDecrypted() && blob.passphrase.length === 0) {
        // Encrypted private half but an empty passphrase: try empty, else fail soft.
        try {
          priv = await openpgp.decryptKey({ privateKey: priv, passphrase: '' });
        } catch {
          throw new Error(tc('metadata.errors.requiresPassphrase'));
        }
      }

      // READ-side key-substitution defence (symmetric to the ENCRYPT path's
      // verifyArmoredKeyFingerprint): a compromised backend could swap in an
      // attacker-controlled shared private key. Recompute the recovered private
      // key's fingerprint and require it to match (a) the fingerprint the blob
      // itself declares AND (b) the active public MetadataKey record's fingerprint
      // (public-half identity). Any mismatch FAILS CLOSED below (catch -> degrade
      // to available=false, set loadError, never cache, never throw uncaught).
      const recoveredFp = await fingerprintOf(blob.armored_key);
      if (!isCurrent()) return;
      const declaredFp = blob.fingerprint.replace(/\s+/g, '').toLowerCase();
      if (!declaredFp || declaredFp !== recoveredFp) {
        throw new Error(tc('metadata.errors.fingerprintMismatchDeclared'));
      }
      const activeFp = active.fingerprint
        ? active.fingerprint.replace(/\s+/g, '').toLowerCase()
        : '';
      if (!activeFp || activeFp !== recoveredFp) {
        throw new Error(tc('metadata.errors.fingerprintMismatchActive'));
      }

      // The vault may have locked while the readPrivateKey/decryptKey/fingerprint
      // steps above ran (those do NOT depend on KeyContext). If so, wipe() already
      // nulled the refs and bumped genRef — do NOT write the decrypted key back.
      if (!isCurrent()) return;

      // Cache the decrypted PRIVATE key + the active record (PUBLIC armored + fp + id).
      sharedPrivateKeyRef.current = priv;
      activeKeyRef.current = active;
      setAvailable(true);
      setActiveKeyId(active.id);
      setReady(true);
    } catch (err: unknown) {
      // A superseded load must not touch state (wipe() already left it locked/clean).
      if (!isCurrent()) return;
      // A failure here MUST degrade to available=false (v4 fallback), never crash the vault.
      sharedPrivateKeyRef.current = null;
      activeKeyRef.current = null;
      setAvailable(false);
      setActiveKeyId(null);
      setReady(true);
      setLoadError(errMessage(err, tc('metadata.errors.loadFailed')));
    }
  }, [decrypt]);

  const reload = useCallback(async () => {
    if (isLocked) return;
    await load();
  }, [isLocked, load]);

  // Bootstrap: load when the vault unlocks, wipe when it locks. Also wipe on unmount.
  useEffect(() => {
    if (isLocked) {
      wipe();
      return;
    }
    void load();
    return () => {
      wipe();
    };
  }, [isLocked, load, wipe]);

  const decryptResourceMetadata = useCallback(
    async (armoredMetadata: string): Promise<string> => {
      const priv = sharedPrivateKeyRef.current;
      if (!priv) {
        throw new Error(tc('metadata.errors.keyUnavailable'));
      }
      const message = await openpgp.readMessage({ armoredMessage: armoredMetadata });
      try {
        const { data } = await openpgp.decrypt({ message, decryptionKeys: priv });
        return data as string;
      } catch (err: unknown) {
        throw new Error(errMessage(err, tc('metadata.errors.decryptMetadata')));
      }
    },
    []
  );

  const encryptResourceMetadata = useCallback(
    async (
      plaintextJson: string
    ): Promise<{ metadata: string; metadata_key_id: string; metadata_key_type: MetadataKeyType }> => {
      const active = activeKeyRef.current;
      if (!active || !sharedPrivateKeyRef.current) {
        throw new Error(tc('metadata.errors.noUsableKey'));
      }
      // Server-substitution defence: verify the PUBLIC armored key against its
      // reported fingerprint BEFORE encrypting to it (identical to ShareDialog).
      await verifyArmoredKeyFingerprint(
        active.armored_key,
        active.fingerprint,
        tc('metadata.errors.sharedKeyName')
      );
      const metadata = await encryptMessage(plaintextJson, [active.armored_key]);
      return {
        metadata,
        metadata_key_id: active.id,
        metadata_key_type: 'shared_key',
      };
    },
    []
  );

  const value = useMemo<MetadataKeyContextValue>(
    () => ({
      ready,
      available,
      activeKeyId,
      loadError,
      decryptResourceMetadata,
      encryptResourceMetadata,
      reload,
    }),
    [
      ready,
      available,
      activeKeyId,
      loadError,
      decryptResourceMetadata,
      encryptResourceMetadata,
      reload,
    ]
  );

  return (
    <MetadataKeyContext.Provider value={value}>{children}</MetadataKeyContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
/** Hook returning MetadataKeyContextValue. Throws if used outside MetadataKeyProvider. */
export function useMetadataKey(): MetadataKeyContextValue {
  const ctx = useContext(MetadataKeyContext);
  if (!ctx) {
    throw new Error('useMetadataKey() must be used within a <MetadataKeyProvider>.');
  }
  return ctx;
}
