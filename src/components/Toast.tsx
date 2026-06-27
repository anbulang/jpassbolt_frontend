import {
    useCallback,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import {
    ToastContext,
    type ToastContextValue,
    type ToastVariant,
} from './toastContext';

interface ToastItem {
    id: number;
    message: string;
    variant: ToastVariant;
}

const ICONS: Record<ToastVariant, ReactNode> = {
    success: <CheckCircle2 size={18} className="toast-icon-success" />,
    error: <AlertCircle size={18} className="toast-icon-error" />,
    info: <Info size={18} className="toast-icon-info" />,
};

/**
 * Wrap the app (inside protected routes) to enable `useToast()`. Renders a
 * fixed top-right stack of transient, auto-dismissing toasts.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const idRef = useRef(0);

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const show = useCallback(
        (message: string, variant: ToastVariant = 'info', duration = 4000) => {
            const id = ++idRef.current;
            setToasts((prev) => [...prev, { id, message, variant }]);
            if (duration > 0) {
                window.setTimeout(() => dismiss(id), duration);
            }
        },
        [dismiss]
    );

    const value: ToastContextValue = {
        show,
        success: (m, d) => show(m, 'success', d),
        error: (m, d) => show(m, 'error', d),
        info: (m, d) => show(m, 'info', d),
    };

    return (
        <ToastContext.Provider value={value}>
            {children}
            <ToastContainer toasts={toasts} onDismiss={dismiss} />
        </ToastContext.Provider>
    );
}

function ToastContainer({
    toasts,
    onDismiss,
}: {
    toasts: ToastItem[];
    onDismiss: (id: number) => void;
}) {
    const { t: tr } = useTranslation('components');
    if (toasts.length === 0) return null;
    return createPortal(
        <div className="toast-container">
            {toasts.map((t) => (
                <div key={t.id} className={`toast toast-${t.variant} animate-fade-in`} role="status">
                    {ICONS[t.variant]}
                    <span className="toast-message">{t.message}</span>
                    <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label={tr('toast.dismiss')}>
                        <X size={14} />
                    </button>
                </div>
            ))}
        </div>,
        document.body
    );
}

export default ToastProvider;
