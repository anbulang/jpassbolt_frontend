// Setup.tsx — the public account-onboarding flow (邀请 → 密钥 → 口令 → 完成).
//
// Reached via an emailed setup link, BEFORE the user has any session. It validates
// the link (startSetup), generates OR imports a passphrase-protected OpenPGP key
// entirely in-browser, uploads ONLY the armored PUBLIC key (completeSetup), then
// performs the exact post-credential handoff Login.tsx uses (setArmoredKeys +
// unlock + navigate('/')).
//
// SECURITY: the armored PRIVATE key + passphrase live in component state ONLY and
// never touch the network. The server receives only the public key.

import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as openpgp from 'openpgp';
import {
  Vault,
  KeyRound,
  Lock,
  Check,
  Download,
  ShieldCheck,
  AlertTriangle,
  Eye,
  EyeOff,
  Unlock,
  Fingerprint,
  User as UserIcon,
  Users,
  Globe,
  Mail,
} from 'lucide-react';
import { generateKeyPair, fingerprintOf } from '../gpg';
import { useKey } from '../crypto/KeyContext';
import { loginWithGpg } from '../auth';
import { startSetup, completeSetup } from '../services/setup';
import { Stepper, KeyGen, ppScore, PP_LABEL, downloadRecoveryKit } from './flowHelpers';
import KeyFileButton from '../components/KeyFileButton';
import type { User } from '../types';

const STEPS = ['邀请', '密钥', '口令', '完成'];
const BASE_URL = 'http://localhost:8080/api';

type KeyMode = 'gen' | 'import';

/** Pretty-print an armored fingerprint into the spaced 4-char groups Aegis shows. */
function formatFingerprint(fp: string): string {
  const up = fp.toUpperCase().replace(/\s+/g, '');
  return up.replace(/(.{4})/g, '$1 ').trim();
}

/** Best-effort error message extraction (axios envelope -> Error -> string). */
function errMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { header?: { message?: string } } }; message?: string };
  return e?.response?.data?.header?.message || e?.message || fallback;
}

/** Full display name from a profile, falling back to the username. */
function fullName(user: User | null): string {
  const f = user?.profile?.first_name?.trim() ?? '';
  const l = user?.profile?.last_name?.trim() ?? '';
  return [f, l].filter(Boolean).join(' ') || user?.username || '新成员';
}

export default function Setup() {
  const navigate = useNavigate();
  const { setArmoredKeys, unlock } = useKey();

  // Accept BOTH /setup/:userId/:tokenId AND /setup?user_id=...&token=...
  const params = useParams<{ userId?: string; tokenId?: string }>();
  const [search] = useSearchParams();
  const userId = params.userId ?? search.get('user_id') ?? '';
  const token = params.tokenId ?? search.get('token') ?? '';

  // Flow state
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 0 — invited user
  const [user, setUser] = useState<User | null>(null);
  const [inviteLoaded, setInviteLoaded] = useState(false);

  // Step 1 — key choice
  const [keyMode, setKeyMode] = useState<KeyMode>('gen');
  const [importArmored, setImportArmored] = useState('');
  const [generating, setGenerating] = useState(false);

  // Step 2 — passphrase
  const [pf, setPf] = useState('');
  const [pf2, setPf2] = useState('');
  const [show, setShow] = useState(false);

  // Derived key material (client-side ONLY — never uploaded as private key)
  const [armoredPrivateKey, setArmoredPrivateKey] = useState('');
  const [armoredPublicKey, setArmoredPublicKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');

  const score = ppScore(pf);
  const match = pf.length > 0 && pf === pf2;
  const ppOk = score >= 3 && match;

  // ---- Step 0: validate the invite link ----
  const acceptInvite = async () => {
    if (loading) return;
    if (!userId || !token) {
      setError('链接无效：缺少 user_id 或 token。请使用邮件中的完整邀请链接。');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const u = await startSetup(userId, token);
      setUser(u);
      setInviteLoaded(true);
      setStep(1);
    } catch (err: unknown) {
      setError(errMessage(err, '邀请链接无效或已过期，请联系管理员重新邀请。'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Step 2 -> Step 3: produce the key material behind the KeyGen animation ----
  // For generate-mode we run generateKeyPair(passphrase) here (the passphrase is now
  // known). For import-mode we verify the pasted private key unlocks with the
  // passphrase, then derive its public key + fingerprint. Either way we then advance.
  const produceKeyAndAdvance = async () => {
    if (loading) return;
    setError('');

    if (keyMode === 'gen') {
      setGenerating(true);
      try {
        const { armoredPrivateKey: priv, armoredPublicKey: pub, fingerprint: fp } =
          await generateKeyPair({
            name: fullName(user),
            email: user?.username ?? '',
            passphrase: pf,
          });
        setArmoredPrivateKey(priv);
        setArmoredPublicKey(pub);
        setFingerprint(fp);
        setGenerating(false);
        setStep(3);
      } catch (err: unknown) {
        setGenerating(false);
        setError(errMessage(err, '密钥生成失败，请重试。'));
      }
      return;
    }

    // import-mode: verify the pasted private key unlocks with this passphrase.
    setLoading(true);
    try {
      const armored = importArmored.trim();
      if (!armored) {
        throw new Error('请先粘贴你的 OpenPGP 私钥（.asc）。');
      }
      const parsed = await openpgp.readPrivateKey({ armoredKey: armored });
      if (parsed.isDecrypted()) {
        throw new Error(
          '该私钥未受 passphrase 保护。为了安全，JPassbolt 要求使用受 passphrase 保护的私钥。',
        );
      }
      // Throws if the passphrase is wrong.
      await openpgp.decryptKey({ privateKey: parsed, passphrase: pf });
      const pub = parsed.toPublic().armor();
      const fp = await fingerprintOf(pub);
      setArmoredPrivateKey(armored);
      setArmoredPublicKey(pub);
      setFingerprint(fp);
      setStep(3);
    } catch (err: unknown) {
      setError(errMessage(err, '无法用该 passphrase 解锁导入的私钥，请检查私钥与 passphrase。'));
    } finally {
      setLoading(false);
    }
  };

  // ---- Step 3: complete setup + the proven post-credential handoff ----
  const enterVault = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      // Upload ONLY the armored PUBLIC key; activate the account.
      await completeSetup(userId, { token, armoredPublicKey });

      // setup/complete activates the account but issues NO JWT (matching PHP).
      // So perform a real GpgAuth login with the just-created key to obtain a
      // session JWT — otherwise ProtectedRoute (JWT gate) bounces us to /login.
      await loginWithGpg(armoredPrivateKey, pf);

      // Then the proven Login.tsx in-memory handoff: persist the passphrase-
      // protected private key, unlock it in memory, and enter the vault unlocked.
      setArmoredKeys(armoredPrivateKey, armoredPublicKey);
      await unlock(pf);
      navigate('/');
    } catch (err: unknown) {
      setError(errMessage(err, '激活失败，请重试或联系管理员。'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flow-overlay">
      <div className="flow-card">
        <div className="flow-top">
          <div className="flow-brand">
            <span className="lg">
              <Vault />
            </span>
            <span className="bn">JPassbolt</span>
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

          {/* 0 · invite */}
          {step === 0 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <Vault />
                </div>
                <h2>你被邀请加入 JPassbolt</h2>
                <p>接受邀请后，将在本设备生成你的端到端加密密钥对。私钥永不离开此浏览器。</p>
              </div>

              {inviteLoaded && user && (
                <div className="invite-meta" style={{ marginBottom: 18 }}>
                  <div className="invite-line">
                    <UserIcon />
                    <span className="k">姓名</span>
                    <span className="v">{fullName(user)}</span>
                  </div>
                  <div className="invite-line">
                    <Mail />
                    <span className="k">用户名</span>
                    <span className="v mono" style={{ fontSize: 12.5 }}>
                      {user.username}
                    </span>
                  </div>
                  <div className="invite-line">
                    <Users />
                    <span className="k">角色</span>
                    <span className="v">{user.role?.name ?? 'user'}</span>
                  </div>
                  <div className="invite-line">
                    <Globe />
                    <span className="k">服务器</span>
                    <span className="v mono" style={{ fontSize: 12.5 }}>
                      {BASE_URL}
                    </span>
                  </div>
                </div>
              )}

              <button
                className="btn primary"
                style={{ width: '100%', height: 44, fontSize: 14 }}
                onClick={acceptInvite}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spin-ring" /> 正在校验邀请…
                  </>
                ) : (
                  '接受邀请并开始'
                )}
              </button>
              <div className="flow-note">
                <ShieldCheck /> 接受后将在本设备生成你的密钥对
              </div>
            </>
          )}

          {/* 1 · key */}
          {step === 1 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <KeyRound />
                </div>
                <h2>创建你的加密身份</h2>
                <p>你的私钥永远只存在于本设备，服务器只保存公钥。</p>
              </div>

              <div
                className={'opt-card' + (keyMode === 'gen' ? ' sel' : '')}
                onClick={() => setKeyMode('gen')}
              >
                <span className="oc-ico">
                  <KeyRound />
                </span>
                <div className="oc-t">
                  <div className="a">
                    生成新密钥对 <span className="recommend">推荐</span>
                  </div>
                  <div className="b">在本设备创建全新的 OpenPGP 密钥（RSA-3072），几秒即可完成。</div>
                </div>
                <span className="oc-radio" />
              </div>

              <div
                className={'opt-card' + (keyMode === 'import' ? ' sel' : '')}
                onClick={() => setKeyMode('import')}
              >
                <span className="oc-ico">
                  <Download />
                </span>
                <div className="oc-t">
                  <div className="a">导入已有密钥</div>
                  <div className="b">已有受 passphrase 保护的 OpenPGP 私钥？粘贴 .asc 内容继续使用。</div>
                </div>
                <span className="oc-radio" />
              </div>

              {keyMode === 'import' && (
                <>
                  <div
                    className="pf-label"
                    style={{ display: 'flex', alignItems: 'center', margin: '4px 0 6px' }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <KeyRound size={15} /> 粘贴或选择 .asc 私钥
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      {/* 可选：选择本地 .asc 私钥文件填入下方文本框；仍可直接粘贴。文件仅在浏览器内读取。 */}
                      <KeyFileButton onLoaded={(t) => setImportArmored(t)} />
                    </span>
                  </div>
                  <textarea
                    className="flow-textarea"
                    placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                    value={importArmored}
                    onChange={(e) => setImportArmored(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    style={{ marginTop: 4 }}
                  />
                </>
              )}

              <div className="flow-foot">
                <button className="btn" onClick={() => setStep(0)}>
                  上一步
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  onClick={() => setStep(2)}
                  disabled={keyMode === 'import' && importArmored.trim().length === 0}
                >
                  下一步
                </button>
              </div>
            </>
          )}

          {/* 2 · passphrase */}
          {step === 2 && (
            <>
              <div className="flow-h">
                <div className="flow-badge">
                  <Lock />
                </div>
                <h2>设置 passphrase</h2>
                <p>用于在本设备解锁私钥。它本身永不离开设备，也无法被找回。</p>
              </div>

              {generating ? (
                <KeyGen onDone={() => { /* real key is produced by produceKeyAndAdvance */ }} />
              ) : (
                <>
                  <div className="pp-fields">
                    <div>
                      <div className="pf-label">
                        <KeyRound size={15} /> passphrase
                      </div>
                      <div className="pf-input">
                        <Lock size={17} />
                        <input
                          type={show ? 'text' : 'password'}
                          autoFocus
                          value={pf}
                          placeholder="••••••••••••"
                          onChange={(e) => setPf(e.target.value)}
                        />
                        <button type="button" className="pf-eye" onClick={() => setShow((s) => !s)}>
                          {show ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </div>
                      {pf && (
                        <>
                          <div className={'pp-meter s' + score} style={{ marginTop: 10 }}>
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                          <div className="pp-meter-row">
                            <span style={{ color: 'var(--text-3)' }}>强度</span>
                            <span
                              style={{
                                color: score >= 3 ? 'var(--green-text)' : 'var(--amber-text)',
                                fontWeight: 500,
                              }}
                            >
                              {PP_LABEL[score]}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    <div>
                      <div className="pf-label">
                        <Check size={15} /> 再次输入
                      </div>
                      <div className={'pf-input' + (pf2 && !match ? ' err' : '')}>
                        <Lock size={17} />
                        <input
                          type={show ? 'text' : 'password'}
                          value={pf2}
                          placeholder="••••••••••••"
                          onChange={(e) => setPf2(e.target.value)}
                        />
                      </div>
                      {pf2 && !match && (
                        <div className="pf-err">
                          <AlertTriangle size={13} /> 两次输入不一致
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="req-list">
                    <div className={'req' + (pf.length >= 8 ? ' ok' : '')}>
                      <span className="rc">{pf.length >= 8 && <Check />}</span> 至少 8 个字符
                    </div>
                    <div
                      className={
                        'req' +
                        (/[A-Z]/.test(pf) && /[a-z]/.test(pf) && /\d/.test(pf) ? ' ok' : '')
                      }
                    >
                      <span className="rc">
                        {/[A-Z]/.test(pf) && /[a-z]/.test(pf) && /\d/.test(pf) && <Check />}
                      </span>{' '}
                      含大小写字母与数字
                    </div>
                    <div className={'req' + (/[^A-Za-z0-9]/.test(pf) ? ' ok' : '')}>
                      <span className="rc">{/[^A-Za-z0-9]/.test(pf) && <Check />}</span> 含符号更佳
                    </div>
                  </div>

                  <div className="warn-soft">
                    <AlertTriangle /> JPassbolt 无法重置 passphrase。请务必牢记，或在下一步保存恢复套件。
                  </div>

                  <div className="flow-foot">
                    <button className="btn" onClick={() => setStep(1)}>
                      上一步
                    </button>
                    <span className="spacer" />
                    <button
                      className="btn primary"
                      disabled={!ppOk || loading}
                      onClick={produceKeyAndAdvance}
                    >
                      {loading ? (
                        <>
                          <span className="spin-ring" /> 处理中…
                        </>
                      ) : keyMode === 'gen' ? (
                        <>
                          <KeyRound size={16} /> 生成密钥
                        </>
                      ) : (
                        '下一步'
                      )}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* 3 · done */}
          {step === 3 && (
            <>
              <div className="flow-h">
                <div className="flow-badge green">
                  <ShieldCheck />
                </div>
                <h2>身份已就绪</h2>
                <p>你的密钥已生成并在本地加密。点击进入保险库以激活账户。</p>
              </div>

              <div className="done-fp">
                <div className="dfp-l">
                  <Fingerprint /> 你的公钥指纹
                </div>
                <div className="dfp-v">{formatFingerprint(fingerprint)}</div>
              </div>

              <div className="kit-row">
                <span className="kr-ico">
                  <Download />
                </span>
                <div className="kr-t">
                  <div className="a">下载恢复套件</div>
                  <div className="b">丢失设备时用于找回访问权 · 请离线保存</div>
                </div>
                <button
                  className="btn sm"
                  onClick={() =>
                    downloadRecoveryKit(
                      `jpassbolt-${user?.username ?? 'key'}-private.asc`,
                      armoredPrivateKey,
                    )
                  }
                >
                  <Download /> 下载
                </button>
              </div>

              <button
                className="btn primary"
                style={{ width: '100%', height: 44, fontSize: 14 }}
                onClick={enterVault}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spin-ring" /> 正在激活…
                  </>
                ) : (
                  <>
                    <Unlock size={16} /> 进入保险库
                  </>
                )}
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
