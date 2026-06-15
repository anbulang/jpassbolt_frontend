// MfaChallenge.tsx — the login-time MFA (TOTP) challenge screen.
//
// Shown AFTER a successful GpgAuth login when the backend reports MFA is required
// (probeMfaRequired -> 403 { mfa_providers: ['totp'] }). It renders the Aegis
// lock-overlay/lock-card with a 6-digit code entry (mfa-dots / mfa-cell, driven
// by a single invisible numeric input, per /tmp/.../app/lock.jsx).
//
// On 6 digits it calls verifyMfaLogin('totp', code, remember); on success it calls
// the onVerified() prop (the caller then enters the vault). It NEVER touches the
// private key, the passphrase, or the auth/loginWithGpg flow — it only satisfies
// the server-side MFA gate for the already-issued JWT session.

import { useRef, useState, type JSX } from 'react';
import { Shield, ShieldCheck, KeyRound, AlertTriangle } from 'lucide-react';
import { verifyMfaLogin } from '../services/mfa';

interface Props {
  /** Called once the TOTP code is accepted by the backend. The caller enters the vault. */
  onVerified: () => void;
  /** Optional: render a "cancel / back to login" affordance. */
  onCancel?: () => void;
}

type Stage = 'mfa' | 'verifying';

/** Best-effort error message extraction (axios envelope -> Error -> string). */
function errMessage(err: unknown, fallback: string): string {
  const e = err as {
    response?: { status?: number; data?: { header?: { message?: string } } };
    message?: string;
  };
  return e?.response?.data?.header?.message || e?.message || fallback;
}

/** Pull the HTTP status off an axios-ish error, or undefined. */
function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

export default function MfaChallenge({ onVerified, onCancel }: Props): JSX.Element {
  const [stage, setStage] = useState<Stage>('mfa');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Drive the 6 cells from a single invisible numeric input. Once 6 digits are
  // entered, submit to the backend. `code` is the only source of truth.
  const onCodeChange = async (raw: string) => {
    if (stage === 'verifying') return;
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    setError('');
    setShake(false);
    if (digits.length < 6) return;

    setStage('verifying');
    try {
      // `remember=false` here: the login challenge is per-session. The "remember
      // this device" toggle is a Settings concern, not the login gate.
      await verifyMfaLogin('totp', digits, false);
      onVerified();
    } catch (err: unknown) {
      const st = statusOf(err);
      if (st === 429) {
        setError('尝试过于频繁，请稍后再试');
      } else if (st === 400 || st === 403) {
        setError('验证码错误，请重试');
      } else {
        setError(errMessage(err, '验证失败，请重试'));
      }
      // Reset for another attempt with the error shake.
      setStage('mfa');
      setShake(true);
      setCode('');
      // Re-focus the invisible input so the user can immediately retype.
      setTimeout(() => inputRef.current?.focus(), 60);
      // Clear the shake flag after the animation so it can replay next time.
      setTimeout(() => setShake(false), 600);
    }
  };

  const verifying = stage === 'verifying';

  return (
    <div className="lock-overlay">
      <div className="lock-card">
        <div
          className="lock-badge"
          style={{ background: verifying ? 'var(--green)' : 'var(--accent)' }}
        >
          {verifying ? <ShieldCheck size={28} /> : <Shield size={28} />}
        </div>
        <h2>{verifying ? '验证通过' : '两步验证'}</h2>
        <div className="who">
          {verifying ? '正在进入保险库…' : '输入身份验证器上的 6 位验证码'}
        </div>

        <div style={{ position: 'relative', marginTop: 22 }}>
          <div className={'mfa-dots' + (shake ? ' err' : '')}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className={
                  'mfa-cell' +
                  (code[i] ? ' filled' : '') +
                  (i === code.length && !verifying ? ' cur' : '') +
                  (shake ? ' err' : '')
                }
              >
                {code[i] || ''}
              </div>
            ))}
          </div>
          <input
            ref={inputRef}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            disabled={verifying}
            autoFocus
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'text' }}
          />
        </div>

        {error && (
          <div className="pf-err" style={{ justifyContent: 'center' }}>
            <AlertTriangle size={13} /> {error}
          </div>
        )}

        {verifying ? (
          <div className="lock-foot" style={{ marginTop: 10 }}>
            <span className="spin-ring" /> 校验挑战响应…
          </div>
        ) : (
          <div className="lock-foot">
            <KeyRound size={13} /> 打开身份验证器 App 获取动态验证码
          </div>
        )}

        {onCancel && !verifying && (
          <div className="lock-foot" style={{ marginTop: 10 }}>
            <button type="button" className="lock-link" onClick={onCancel}>
              返回登录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
