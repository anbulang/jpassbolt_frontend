import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SpinnerProps {
    /** Diameter in px. */
    size?: number;
    color?: string;
}

/**
 * Lightweight inline loading indicator (CSS spin on a lucide Loader2).
 * Presentational only.
 */
export function Spinner({ size = 20, color = 'var(--primary-color)' }: SpinnerProps) {
    const { t } = useTranslation('common');
    return <Loader2 className="spin" size={size} color={color} aria-label={t('state.loading')} />;
}

interface FullSpinnerProps {
    /** Optional copy shown beneath the spinner, e.g. "Decrypting your vault...". */
    label?: string;
    size?: number;
}

/**
 * Centered loading block with an optional label. Use for whole-view loading states.
 */
export function FullSpinner({ label, size = 32 }: FullSpinnerProps) {
    return (
        <div className="spinner-full">
            <Spinner size={size} />
            {label && <span style={{ fontSize: '14px' }}>{label}</span>}
        </div>
    );
}

export default Spinner;
