import { createContext, useContext } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastContextValue {
    /** Show a toast. Returns nothing; auto-dismisses after `duration` ms (default 4000). */
    show: (message: string, variant?: ToastVariant, duration?: number) => void;
    success: (message: string, duration?: number) => void;
    error: (message: string, duration?: number) => void;
    info: (message: string, duration?: number) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/** Hook returning the toast API. Throws if used outside a ToastProvider. */
export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return ctx;
}
