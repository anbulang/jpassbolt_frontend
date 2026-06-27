import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface ModalProps {
    open: boolean;
    title?: ReactNode;
    onClose: () => void;
    children: ReactNode;
    /** Optional footer slot, typically action buttons. */
    footer?: ReactNode;
    /** Max width of the panel in px. */
    maxWidth?: number;
    /** When false, clicking the backdrop will not close the modal. */
    closeOnBackdrop?: boolean;
}

/**
 * Reusable centered glass-panel modal with a blurred backdrop, title, close (X)
 * button, ESC-to-close, and body/footer slots. Portals to document.body.
 * Presentational only — owners pass `open`/`onClose`.
 */
export function Modal({
    open,
    title,
    onClose,
    children,
    footer,
    maxWidth = 520,
    closeOnBackdrop = true,
}: ModalProps) {
    const { t } = useTranslation('common');
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    return createPortal(
        <div
            className="modal-backdrop"
            onMouseDown={(e) => {
                if (closeOnBackdrop && e.target === e.currentTarget) onClose();
            }}
        >
            <div className="modal animate-fade-in" style={{ maxWidth }} role="dialog" aria-modal="true">
                <div className="modal-header">
                    <h3 className="modal-title">{title}</h3>
                    <button className="modal-close" onClick={onClose} aria-label={t('actions.close')}>
                        <X size={18} />
                    </button>
                </div>
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-footer">{footer}</div>}
            </div>
        </div>,
        document.body
    );
}

export default Modal;
