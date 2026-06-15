import type { ReactNode } from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Renders the confirm button in danger styling (destructive actions). */
    danger?: boolean;
    /** Disables/spins the confirm button while an async action runs. */
    loading?: boolean;
    /** Optional extra content above the buttons (e.g. FolderTree's "delete contents" checkbox). */
    extra?: ReactNode;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Confirmation modal built on Modal. Title + message + confirm/cancel buttons,
 * optional danger styling and an `extra` slot. Presentational only.
 */
export function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = '确认',
    cancelLabel = '取消',
    danger = false,
    loading = false,
    extra,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    return (
        <Modal
            open={open}
            title={title}
            onClose={onCancel}
            maxWidth={440}
            footer={
                <>
                    <button className="btn btn-secondary" onClick={onCancel} disabled={loading}>
                        {cancelLabel}
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={onConfirm}
                        disabled={loading}
                        style={
                            danger
                                ? { backgroundColor: 'var(--danger-color)', boxShadow: '0 4px 14px 0 rgba(248,81,73,0.4)' }
                                : undefined
                        }
                    >
                        {loading ? '处理中…' : confirmLabel}
                    </button>
                </>
            }
        >
            <div style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>{message}</div>
            {extra && <div style={{ marginTop: '16px' }}>{extra}</div>}
        </Modal>
    );
}

export default ConfirmDialog;
