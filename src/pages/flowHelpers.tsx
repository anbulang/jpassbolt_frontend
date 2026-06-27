/* eslint-disable react-refresh/only-export-components */
// flowHelpers.tsx — shared primitives for the Setup AND Recovery onboarding flows.
//
// This module intentionally co-locates small pure helpers (ppScore / PP_LABEL /
// downloadRecoveryKit) with two presentational components (Stepper / KeyGen), so
// the react-refresh "only export components" rule is disabled here by design.
//
// The components mirror /tmp/design_extract/.../app/setup.jsx + flows.css visually,
// mapping the Aegis <Icon name> palette to lucide-react. KeyGen is JUST an animation:
// the CALLER runs the real openpgp.generateKeyPair() and decides when generation is
// truly done; KeyGen also calls onDone after its own animation as a fallback so the
// UI never hangs, but the real key is what matters.

import { useEffect, useState, type JSX } from 'react';
import { Check, KeyRound } from 'lucide-react';
import i18n from '../i18n';

// ---------------------------------------------------------------------------
// Passphrase strength
// ---------------------------------------------------------------------------

/**
 * Score a passphrase 0–4 (Aegis ppScore parity):
 *   +1 length >= 8, +1 length >= 14,
 *   +1 has lower AND upper AND digit, +1 has a symbol. Capped at 4.
 */
export function ppScore(p: string): number {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}

/** Strength labels indexed by ppScore() (0 = empty). Resolved via i18n so the
 *  label tracks the active language. */
export function PP_LABEL(score: number): string {
  const labels = [
    '',
    i18n.t('auth:keygen.strengthLabels.weak'),
    i18n.t('auth:keygen.strengthLabels.fair'),
    i18n.t('auth:keygen.strengthLabels.good'),
    i18n.t('auth:keygen.strengthLabels.strong'),
  ];
  return labels[score] ?? '';
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

/**
 * The flow header stepper (flow-steps / fstep / fs-dot / fs-l / fstep-line).
 * `cur` is the active step index; earlier steps render a Check icon (done).
 */
export function Stepper({ steps, cur }: { steps: string[]; cur: number }): JSX.Element {
  return (
    <div className="flow-steps">
      {steps.map((s, i) => (
        <span style={{ display: 'contents' }} key={i}>
          <div className={'fstep ' + (i === cur ? 'on' : i < cur ? 'done' : '')}>
            <span className="fs-dot">{i < cur ? <Check /> : i + 1}</span>
            <span className="fs-l">{s}</span>
          </div>
          {i < steps.length - 1 && (
            <span className={'fstep-line' + (i < cur ? ' done' : '')} />
          )}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeyGen (visual only)
// ---------------------------------------------------------------------------

/**
 * The key-generation animation (keygen / keygen-ring / keygen-spin / keygen-bits /
 * keygen-log). PURELY visual — the caller awaits the real generateKeyPair() and
 * calls onDone when the promise resolves. As a fallback (so the UI never stalls if
 * the caller forgets), KeyGen also fires onDone after its own animation completes.
 * onDone is therefore safe to call more than once and the caller must be idempotent.
 */
export function KeyGen({ onDone }: { onDone: () => void }): JSX.Element {
  const logs = [
    i18n.t('auth:keygen.logs.entropy'),
    i18n.t('auth:keygen.logs.generating'),
    i18n.t('auth:keygen.logs.deriving'),
    i18n.t('auth:keygen.logs.encrypting'),
    i18n.t('auth:keygen.logs.done'),
  ];
  const total = 36;
  const [li, setLi] = useState(0);
  const [bits, setBits] = useState(0);

  useEffect(() => {
    const bi = setInterval(() => setBits((b) => Math.min(total, b + 2)), 70);
    const ll = setInterval(
      () =>
        setLi((i) => {
          if (i >= logs.length - 1) {
            clearInterval(ll);
            return i;
          }
          return i + 1;
        }),
      520,
    );
    // Fallback completion so the UI never hangs; the caller's real onDone (fired
    // when generateKeyPair resolves) is the authoritative signal.
    const done = setTimeout(onDone, 2500);
    return () => {
      clearInterval(bi);
      clearInterval(ll);
      clearTimeout(done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="keygen">
      <div className="keygen-ring">
        <div className="keygen-spin" />
        <div className="kr-core">
          <KeyRound />
        </div>
      </div>
      <div className="keygen-bits">
        {Array.from({ length: total }).map((_, i) => (
          <i key={i} className={i < bits ? 'on' : ''} />
        ))}
      </div>
      <div className="keygen-log mono">{logs[li]}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recovery kit download
// ---------------------------------------------------------------------------

/**
 * Trigger a browser download of the user's armored PRIVATE key as a .asc file —
 * their offline recovery backup. This is the ONE place the private key leaves the
 * app, and it goes only to the user's local disk (never the network).
 */
export function downloadRecoveryKit(filename: string, armoredPrivateKey: string): void {
  const blob = new Blob([armoredPrivateKey], { type: 'application/pgp-keys' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.asc') ? filename : `${filename}.asc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the object URL on the next tick so the click has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
