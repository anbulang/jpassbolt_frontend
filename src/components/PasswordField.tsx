import { useState } from 'react';
import { Eye, EyeOff, Copy, Check, RefreshCw } from 'lucide-react';

interface PasswordFieldProps {
    value: string;
    /** When provided, the field is editable and changes are reported here. */
    onChange?: (value: string) => void;
    /** Force read-only display even if onChange is given. */
    readOnly?: boolean;
    label?: string;
    placeholder?: string;
    /** Show the length/char-class strength bar. */
    showStrength?: boolean;
    /** Show a generate-password button (edit mode only). */
    showGenerate?: boolean;
    /** Called after a successful copy-to-clipboard (e.g. to fire a "Copied" toast). */
    onCopy?: () => void;
}

function strength(pw: string): { score: number; label: string; color: string } {
    if (!pw) return { score: 0, label: '', color: 'var(--text-muted)' };
    let classes = 0;
    if (/[a-z]/.test(pw)) classes++;
    if (/[A-Z]/.test(pw)) classes++;
    if (/[0-9]/.test(pw)) classes++;
    if (/[^a-zA-Z0-9]/.test(pw)) classes++;
    const lengthScore = pw.length >= 16 ? 2 : pw.length >= 10 ? 1 : 0;
    const raw = classes + lengthScore; // 0..6
    if (raw >= 5) return { score: 100, label: 'Strong', color: 'var(--success-color)' };
    if (raw >= 3) return { score: 66, label: 'Fair', color: 'var(--primary-color)' };
    return { score: 33, label: 'Weak', color: 'var(--danger-color)' };
}

function generatePassword(length = 20): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}';
    const out = new Uint32Array(length);
    crypto.getRandomValues(out);
    return Array.from(out, (n) => chars[n % chars.length]).join('');
}

/**
 * Masked secret display/input with reveal toggle, copy-to-clipboard, an optional
 * strength meter, and an optional generate button. Read and edit modes.
 * Presentational only — crypto/persistence belong to the owning page.
 */
export function PasswordField({
    value,
    onChange,
    readOnly,
    label,
    placeholder = 'Password',
    showStrength = false,
    showGenerate = false,
    onCopy,
}: PasswordFieldProps) {
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState(false);
    const editable = !!onChange && !readOnly;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            onCopy?.();
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable — ignore silently */
        }
    };

    const s = strength(value);

    return (
        <div className="form-group" style={{ marginBottom: showStrength ? '12px' : '20px' }}>
            {label && <label className="form-label">{label}</label>}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <input
                    type={revealed ? 'text' : 'password'}
                    className="form-control"
                    value={value}
                    placeholder={placeholder}
                    readOnly={!editable}
                    onChange={editable ? (e) => onChange!(e.target.value) : undefined}
                    style={{ fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace", flex: 1 }}
                />
                <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 42, height: 'auto' }}
                    onClick={() => setRevealed((r) => !r)}
                    aria-label={revealed ? 'Hide' : 'Reveal'}
                    title={revealed ? 'Hide' : 'Reveal'}
                >
                    {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 42, height: 'auto' }}
                    onClick={handleCopy}
                    aria-label="Copy"
                    title="Copy to clipboard"
                >
                    {copied ? <Check size={16} color="var(--success-color)" /> : <Copy size={16} />}
                </button>
                {editable && showGenerate && (
                    <button
                        type="button"
                        className="icon-btn"
                        style={{ width: 42, height: 'auto' }}
                        onClick={() => onChange!(generatePassword())}
                        aria-label="Generate"
                        title="Generate password"
                    >
                        <RefreshCw size={16} />
                    </button>
                )}
            </div>
            {showStrength && value && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
                    <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', overflow: 'hidden' }}>
                        <div style={{ width: `${s.score}%`, height: '100%', background: s.color, transition: 'width var(--transition-normal)' }} />
                    </div>
                    <span style={{ fontSize: '12px', color: s.color, minWidth: '44px' }}>{s.label}</span>
                </div>
            )}
        </div>
    );
}

export default PasswordField;
