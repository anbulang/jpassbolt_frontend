import type { ReactNode } from 'react';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'danger' | 'muted';

interface BadgeProps {
    children: ReactNode;
    variant?: BadgeVariant;
    /** Optional leading icon (lucide element). */
    icon?: ReactNode;
    title?: string;
}

/**
 * Small pill label. Used for roles, statuses, permission levels,
 * user/group type, and member counts. Variants map to theme colors.
 */
export function Badge({ children, variant = 'default', icon, title }: BadgeProps) {
    return (
        <span className={`badge badge-${variant}`} title={title}>
            {icon}
            {children}
        </span>
    );
}

/** Maps a Passbolt permission level (1 / 7 / 15) to a labelled Badge. */
export function PermissionBadge({ type }: { type: number }) {
    const map: Record<number, { label: string; variant: BadgeVariant }> = {
        1: { label: 'Read', variant: 'muted' },
        7: { label: 'Can update', variant: 'primary' },
        15: { label: 'Owner', variant: 'success' },
    };
    const entry = map[type] ?? { label: `Level ${type}`, variant: 'default' as BadgeVariant };
    return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

export default Badge;
