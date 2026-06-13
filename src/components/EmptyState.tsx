import type { ComponentType, ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';

interface EmptyStateProps {
    /** A lucide-react icon component, e.g. `Lock`. */
    icon?: ComponentType<LucideProps>;
    title: string;
    description?: ReactNode;
    /** Optional CTA rendered below the copy (e.g. a <button className="btn btn-primary">). */
    action?: ReactNode;
    /** When false, drops the glass-panel wrapper for inline/compact contexts. */
    panel?: boolean;
}

/**
 * Centered empty state. Generalizes the Dashboard "empty vault" block:
 * icon + title + subtitle + optional action. Presentational only.
 */
export function EmptyState({ icon: Icon, title, description, action, panel = true }: EmptyStateProps) {
    return (
        <div className={panel ? 'glass-panel text-center' : 'text-center'} style={{ padding: panel ? '60px 20px' : '32px 20px' }}>
            {Icon && (
                <Icon size={48} color="var(--text-muted)" style={{ marginBottom: '16px', opacity: 0.5 }} />
            )}
            <h3 style={{ margin: 0 }}>{title}</h3>
            {description && (
                <p style={{ color: 'var(--text-secondary)', marginTop: '8px', marginBottom: action ? '24px' : 0 }}>
                    {description}
                </p>
            )}
            {action}
        </div>
    );
}

export default EmptyState;
