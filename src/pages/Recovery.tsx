// Recovery.tsx — the public account-recovery flow (账户 → 验证 → 重设 → 完成).
//
// CE recovery semantics (parity with the PHP Recover controller): recovery does
// NOT mint a NEW key. The user RE-IMPORTS their EXISTING passphrase-protected
// private-key backup; the server checks that the submitted PUBLIC key's
// fingerprint matches the key it already has on file for this account. A
// fingerprint mismatch is rejected by the backend (surfaced verbatim).
//
// Two entry modes (both reached via /recover, with or without a token):
//   * Request mode (no userId+token in the URL): step 0 collects the account
//     email and calls requestRecovery({ username }); the backend emails/logs a
//     recover link. We then show a "查收邮件" confirmation.
//   * Complete mode (URL carries userId+token): startRecovery validates the link
//     and returns the identity; the user imports their existing .asc private key
//     backup + passphrase (verified locally via openpgp.decryptKey to derive the
//     public key + fingerprint); completeRecovery uploads ONLY the public key
//     (the server enforces the fingerprint match), then the standard post-
//     credential handoff: setArmoredKeys(privateKey) + unlock(passphrase) + '/'.
//
// SECURITY: the armored PRIVATE key + passphrase live in component state ONLY and
// never touch the network. completeRecovery sends ONLY the armored public key.

import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as openpgp from 'openpgp';
import {
  KeyRound,
  Lock,
  Download,
  Users,
  ShieldCheck,
  AlertTriangle,
  Eye,
  EyeOff,
  Unlock,
  Fingerprint,
  RefreshCw,
  User as UserIcon,
  Mail,
  CheckCircle2,
  X,
} from 'lucide-react';
import { fingerprintOf } from '../gpg';
import { useKey } from '../crypto/KeyContext';
import { requestRecovery, startRecovery, completeRecovery } from '../services/setup';
import { Stepper } from './flowHelpers';
import type { User } from '../types';

const STEPS = ['账户', '验证', '重设', '完成'];

/** The supported recovery method (CE): re-import the existing key backup. */
type VerifyMethod = 'backup' | 'code' | 'admin';

/** Pretty-print an armored fingerprint into spaced 4-char groups. */
function formatFingerprint(fp: string): string {
  const up = fp.toUpperCase().replace(/\s+/g, '');
  return up.replace(/(.{4})/g, '$1 ').trim();
}

/** Best-effort error message extraction (axios envelope -> Error -> string). */
function errMessage(err: unknown, fallback: string): string {
  const e = err as {
    response?: { data?: { header?: { message?: string } } };
    message?: string;
  };
  return e?.response?.data?.header?.message || e?.message || fallback;
}

/** Full display name from a profile, falling back to the username. */
function fullName(user: User | null): string {
  const f = user?.profile?.first_name?.trim() ?? '';
  const l = user?.profile?.last_name?.trim() ?? '';
  return [f, l].filter(Boolean).join(' ') || user?.username || '账户';
}

export default function Recovery() {
  const navigate = useNavigate();
  const { setArmoredKeys, unlock } = useKey();

  // Accept BOTH /recover/:userId/:tokenId AND /recover?user_id=...&token=...
  const params = useParams<{ userId?: string; tokenId?: string }>();
  const [search] = useSearchParams();
  const userId = params.userId ?? search.get('user_id') ?? '';
  const token = params.tokenId ?? search.get('token') ?? '';
  // Complete mode iff the link carries both a user id and a token.
  const isComplete = Boolean(userId && token);

  // Flow state. In complete mode we land directly on step 1 (验证) after the link
  // validates; in request mode we stay on step 0 (账户) to collect the email.
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Request mode — email + "email sent" confirmation.
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  // Complete mode — validated identity + import method.
  const [user, setUser] = useState<User | null>(null);
  const [linkValidated, setLinkValidated] = useState(false);
  const [method, setMethod] = useState<VerifyMethod>('backup');
  const [importArmored, setImportArmored] = useState('');

  // Passphrase (used to unlock the imported private key — NOT a new passphrase).
  const [pf, setPf] = useState('');
  const [showPf, setShowPf] = useState(false);

  // Derived key material (client-side ONLY — only the PUBLIC key is uploaded).
  const [armoredPrivateKey, setArmoredPrivateKey] = useState('');
  const [armoredPublicKey, setArmoredPublicKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');

  const emailOk = /\S+@\S+\.\S+/.test(email);

  // ---- Request mode (step 0): ask the backend to email a recover link ----
  const sendRecoveryEmail = async () => {
    if (loading || !emailOk) return;
    setLoading(true);
    setError('');
    try {
      await requestRecovery({ username: email.trim() });
      setSent(true);
    } catch (err: unknown) {
      // Backends often respond 200 regardless (to avoid account enumeration); if
      // a real error comes back, surface it verbatim.
      setError(errMessage(err, '无法发送恢复邮件，请稍后重试或联系管理员。'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Complete mode: validate the recover link, then enter the verify step ----
  const validateLink = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const u = await startRecovery(userId, token);
      setUser(u);
      setLinkValidated(true);
      setStep(1);
    } catch (err: unknown) {
      setError(errMessage(err, '恢复链接无效或已过期，请重新发起账户恢复。'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Complete mode (step 1 -> 2): verify the imported private key unlocks ----
  // We do NOT generate a key. We read the pasted .asc backup, confirm it is
  // passphrase-protected and that THIS passphrase unlocks it, then derive its
  // public key + fingerprint to upload (the server checks the fingerprint match).
  const verifyImportAndAdvance = async () => {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const armored = importArmored.trim();
      if (!armored) {
        throw new Error('请先粘贴你之前导出的 OpenPGP 私钥备份（.asc）。');
      }
      const parsed = await openpgp.readPrivateKey({ armoredKey: armored });
      if (parsed.isDecrypted()) {
        throw new Error(
          '该私钥未受 passphrase 保护。为了安全，JPassbolt 要求使用受 passphrase 保护的私钥。',
        );
      }
      // Throws if the passphrase is wrong (verified entirely client-side).
      await openpgp.decryptKey({ privateKey: parsed, passphrase: pf });
      const pub = parsed.toPublic().armor();
      const fp = await fingerprintOf(pub);
      setArmoredPrivateKey(armored);
      setArmoredPublicKey(pub);
      setFingerprint(fp);
      setStep(2);
    } catch (err: unknown) {
      setError(
        errMessage(err, '无法用该 passphrase 解锁导入的私钥，请检查私钥备份与 passphrase。'),
      );
    } finally {
      setLoading(false);
    }
  };

  // ---- Complete mode (step 2 -> 3): finalize recovery + post-credential handoff ----
  const finishRecovery = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      // Upload ONLY the armored PUBLIC key. The server enforces that its
      // fingerprint matches the key already on file for this account; on
      // mismatch it rejects (surfaced verbatim, e.g. "该密钥不属于此用户").
      await completeRecovery(userId, { token, armoredPublicKey });
      // Standard Login/Setup handoff: persist the passphrase-protected private
      // key, unlock it in memory with the just-entered passphrase, enter vault.
      setArmoredKeys(armoredPrivateKey, armoredPublicKey);
      await unlock(pf);
      setStep(3);
    } catch (err: unknown) {
      setError(errMessage(err, '账户恢复失败，请检查私钥是否属于此账户后重试。'));
    } finally {
      setLoading(false);
    }
  };

  // File picker -> read a .asc backup into the textarea.
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportArmored(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <div className="flow-overlay">
      <div className="flow-card">
        <div className="flow-top">
          <div className="flow-brand">
            <span className="lg">
              <KeyRound />
            </span>
            <span className="bn">账户恢复</span>
            <button
              className="iconbtn bx"
              onClick={() => navigate('/login')}
              title="返回登录"
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: 'none',
                color: 'var(--text-3)',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <X size={18} />
            </button>
          </div>
          <Stepper steps={STEPS} cur={step} />
        </div>

        <div className="flow-body">
          {error && (
            <div className="warnbox" style={{ marginBottom: 16 }}>
              <AlertTriangle />
              <div>{error}</div>
            </div>
          )}

          {/* 0 · account (request mode: email; complete mode: validate link) */}
          {step === 0 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <RefreshCw />
                </div>
                <h2>找回你的账户</h2>
                <p>
                  丢失了设备或忘记如何登录？验证身份后，用你保存的密钥备份重新获得保险库访问权。
                </p>
              </div>

              {isComplete ? (
                <>
                  <div className="invite-meta" style={{ marginBottom: 18 }}>
                    <div className="invite-line">
                      <Mail />
                      <span className="k">恢复链接</span>
                      <span className="v" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
                        待校验
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn primary"
                    style={{ width: '100%', height: 44, fontSize: 14 }}
                    onClick={validateLink}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <span className="spin-ring" /> 正在校验恢复链接…
                      </>
                    ) : (
                      '校验链接并继续'
                    )}
                  </button>
                  <div className="flow-note">
                    <ShieldCheck /> 恢复不会暴露你的私钥或 passphrase
                  </div>
                </>
              ) : sent ? (
                <>
                  <div className="kit-row" style={{ marginTop: 2 }}>
                    <span
                      className="kr-ico"
                      style={{ background: 'var(--green-soft)', color: 'var(--green-text)' }}
                    >
                      <CheckCircle2 />
                    </span>
                    <div className="kr-t">
                      <div className="a">请查收邮件</div>
                      <div className="b">
                        若该邮箱对应一个账户，我们已发送一封含恢复链接的邮件。
                      </div>
                    </div>
                  </div>
                  <div className="warn-soft">
                    <Mail /> 请从邮件中打开恢复链接以继续（链接含一次性恢复令牌）。
                  </div>
                  <div className="flow-note">
                    <ShieldCheck /> 恢复不会暴露你的私钥或 passphrase
                  </div>
                </>
              ) : (
                <>
                  <div className="pf-label">
                    <UserIcon size={15} /> 账户邮箱
                  </div>
                  <div className="pf-input">
                    <Mail size={17} />
                    <input
                      type="email"
                      autoFocus
                      value={email}
                      placeholder="you@acme.io"
                      style={{ letterSpacing: 0, fontFamily: 'var(--sans)' }}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <button
                    className="btn primary"
                    style={{ width: '100%', height: 44, marginTop: 18, fontSize: 14 }}
                    disabled={!emailOk || loading}
                    onClick={sendRecoveryEmail}
                  >
                    {loading ? (
                      <>
                        <span className="spin-ring" /> 正在发送…
                      </>
                    ) : (
                      '继续'
                    )}
                  </button>
                  <div className="flow-note">
                    <ShieldCheck /> 恢复不会暴露你旧的私钥或 passphrase
                  </div>
                </>
              )}
            </>
          )}

          {/* 1 · verify (complete mode): import the existing key backup + passphrase */}
          {step === 1 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <ShieldCheck />
                </div>
                <h2>验证身份</h2>
                <p>
                  导入你之前导出的密钥备份并输入其 passphrase。服务器将校验该密钥确属
                  {linkValidated && user ? ` ${fullName(user)} ` : '你的账户'}。
                </p>
              </div>

              {/* Supported method: import an existing key backup. */}
              <div
                className={'opt-card' + (method === 'backup' ? ' sel' : '')}
                onClick={() => setMethod('backup')}
              >
                <span className="oc-ico">
                  <Download />
                </span>
                <div className="oc-t">
                  <div className="a">
                    导入密钥备份 <span className="recommend">支持</span>
                  </div>
                  <div className="b">上传你之前导出的受 passphrase 保护的私钥备份（.asc）。</div>
                </div>
                <span className="oc-radio" />
              </div>

              {/* Present-but-unsupported methods (honest: disabled / 暂未支持). */}
              <div
                className="opt-card"
                style={{ opacity: 0.55, cursor: 'not-allowed' }}
                title="暂未支持"
              >
                <span className="oc-ico">
                  <KeyRound />
                </span>
                <div className="oc-t">
                  <div className="a">
                    恢复码 <span className="recommend" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>暂未支持</span>
                  </div>
                  <div className="b">使用注册时保存的一次性恢复码（当前版本暂未支持）。</div>
                </div>
                <span className="oc-radio" />
              </div>
              <div
                className="opt-card"
                style={{ opacity: 0.55, cursor: 'not-allowed' }}
                title="暂未支持"
              >
                <span className="oc-ico">
                  <Users />
                </span>
                <div className="oc-t">
                  <div className="a">
                    管理员协助 <span className="recommend" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>暂未支持</span>
                  </div>
                  <div className="b">由组织管理员审批为你重建访问权（当前版本暂未支持）。</div>
                </div>
                <span className="oc-radio" />
              </div>

              {method === 'backup' && (
                <>
                  <textarea
                    className="flow-textarea"
                    placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                    value={importArmored}
                    onChange={(e) => setImportArmored(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    style={{ marginTop: 6 }}
                  />
                  <label
                    className="flow-note"
                    style={{ cursor: 'pointer', justifyContent: 'flex-start', marginTop: 8 }}
                  >
                    <Download /> 或从文件选择 .asc 备份
                    <input
                      type="file"
                      accept=".asc,.txt,.gpg,.key,application/pgp-keys"
                      onChange={onPickFile}
                      style={{ display: 'none' }}
                    />
                  </label>

                  <div className="pf-label" style={{ marginTop: 14 }}>
                    <KeyRound size={15} /> 该备份的 passphrase
                  </div>
                  <div className="pf-input">
                    <Lock size={17} />
                    <input
                      type={showPf ? 'text' : 'password'}
                      value={pf}
                      placeholder="••••••••••••"
                      onChange={(e) => setPf(e.target.value)}
                    />
                    <button
                      type="button"
                      className="pf-eye"
                      onClick={() => setShowPf((s) => !s)}
                    >
                      {showPf ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </>
              )}

              <div className="flow-foot">
                <button className="btn" onClick={() => navigate('/login')}>
                  返回登录
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  disabled={
                    method !== 'backup' ||
                    importArmored.trim().length === 0 ||
                    pf.length === 0 ||
                    loading
                  }
                  onClick={verifyImportAndAdvance}
                >
                  {loading ? (
                    <>
                      <span className="spin-ring" /> 校验密钥…
                    </>
                  ) : (
                    '下一步'
                  )}
                </button>
              </div>
            </>
          )}

          {/* 2 · reset (complete mode): confirm + submit to the server */}
          {step === 2 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <Lock />
                </div>
                <h2>确认并恢复访问权</h2>
                <p>
                  你的密钥备份已在本地通过 passphrase 解锁。提交后服务器将校验指纹一致并恢复你的访问权。
                </p>
              </div>

              <div className="done-fp">
                <div className="dfp-l">
                  <Fingerprint /> 待校验的公钥指纹
                </div>
                <div className="dfp-v">{formatFingerprint(fingerprint)}</div>
              </div>

              <div className="invite-meta" style={{ marginBottom: 18 }}>
                <div className="invite-line">
                  <UserIcon />
                  <span className="k">账户</span>
                  <span className="v">{fullName(user)}</span>
                </div>
                <div className="invite-line">
                  <Mail />
                  <span className="k">用户名</span>
                  <span className="v mono" style={{ fontSize: 12.5 }}>
                    {user?.username ?? ''}
                  </span>
                </div>
              </div>

              <div className="warn-soft">
                <AlertTriangle /> 服务器仅接受与此账户既有密钥指纹一致的密钥；若不一致将被拒绝。
              </div>

              <div className="flow-foot">
                <button className="btn" onClick={() => setStep(1)} disabled={loading}>
                  上一步
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  disabled={loading}
                  onClick={finishRecovery}
                >
                  {loading ? (
                    <>
                      <span className="spin-ring" /> 正在恢复…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={16} /> 恢复账户
                    </>
                  )}
                </button>
              </div>
            </>
          )}

          {/* 3 · done (complete mode): recovered, enter the vault */}
          {step === 3 && (
            <>
              <div className="flow-h">
                <div className="flow-badge green">
                  <ShieldCheck />
                </div>
                <h2>账户已恢复</h2>
                <p>你的密钥已重新验证，你重新获得了对保险库的访问权。</p>
              </div>

              <div className="invite-meta" style={{ marginBottom: 18 }}>
                <div className="invite-line">
                  <CheckCircle2 />
                  <span className="k">身份验证</span>
                  <span className="v" style={{ marginLeft: 'auto', color: 'var(--green-text)' }}>
                    已通过
                  </span>
                </div>
                <div className="invite-line">
                  <KeyRound />
                  <span className="k">密钥指纹</span>
                  <span className="v" style={{ marginLeft: 'auto', color: 'var(--green-text)' }}>
                    已匹配
                  </span>
                </div>
                <div className="invite-line">
                  <Unlock />
                  <span className="k">保险库</span>
                  <span className="v" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
                    已解锁
                  </span>
                </div>
              </div>

              <button
                className="btn primary"
                style={{ width: '100%', height: 44, fontSize: 14 }}
                onClick={() => navigate('/')}
              >
                <Unlock size={16} /> 进入保险库
              </button>
              <div className="flow-note">
                <ShieldCheck /> 私钥与 passphrase 从未离开此设备
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
