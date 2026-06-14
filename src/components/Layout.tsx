import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
    ShieldCheck,
    Lock,
    Users,
    UsersRound,
    Settings,
    KeyRound,
    LogOut,
    type LucideProps,
} from 'lucide-react';
import { logout } from '../auth';
import { getMe } from '../services/profile';
import { Avatar } from './Avatar';

interface NavItem {
    label: string;
    path: string;
    icon: ComponentType<LucideProps>;
}

/** Hardcoded primary navigation (from the blueprint navItems). */
const NAV_ITEMS: NavItem[] = [
    { label: 'Vault', path: '/', icon: Lock },
    { label: 'Users', path: '/users', icon: Users },
    { label: 'Groups', path: '/groups', icon: UsersRound },
    { label: 'Settings', path: '/settings', icon: Settings },
];

/**
 * Admin-only nav entry for the encrypted-metadata config panel. Appended to
 * NAV_ITEMS only once the network role check confirms admin (the LS blob is not
 * a trusted role source). Plain label — no v4/v5 badge in the main nav.
 */
const ADMIN_NAV_ITEM: NavItem = {
    label: 'Encrypted metadata',
    path: '/settings/encrypted-metadata',
    icon: KeyRound,
};

interface CurrentUser {
    username?: string;
    profile?: { first_name?: string; last_name?: string; avatar?: { url?: { small?: string; medium?: string } } } | null;
}

function readCurrentUser(): CurrentUser | null {
    try {
        const raw = localStorage.getItem('jpassbolt_user');
        return raw ? (JSON.parse(raw) as CurrentUser) : null;
    } catch {
        return null;
    }
}

interface LayoutProps {
    /** Render explicit children instead of the router <Outlet/>. */
    children?: ReactNode;
    /** Slot rendered between search/title and the user menu in the top bar. */
    topbarSlot?: ReactNode;
}

/**
 * App shell: fixed left sidebar (brand + nav with active highlight via NavLink,
 * current user + logout at the bottom) and a scrollable main region with a
 * sticky top bar. Renders children when provided, else the router Outlet.
 * Presentational only.
 */
export function Layout({ children, topbarSlot }: LayoutProps) {
    const user = readCurrentUser();
    const displayName =
        [user?.profile?.first_name, user?.profile?.last_name].filter(Boolean).join(' ') ||
        user?.username ||
        'Account';
    const avatarUrl = user?.profile?.avatar?.url?.small ?? null;

    // Resolve the admin nav entry from the NETWORK role (GET /users/me.json),
    // not the LS blob which is not a trusted role source. The page itself also
    // self-gates, so a momentary missing entry never grants access.
    const [isAdmin, setIsAdmin] = useState(false);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const me = await getMe();
                if (!cancelled) setIsAdmin(me.role?.name === 'admin');
            } catch {
                if (!cancelled) setIsAdmin(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const navItems = useMemo(
        () => (isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS),
        [isAdmin],
    );

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="sidebar-brand">
                    <ShieldCheck size={24} color="var(--primary-color)" />
                    <span>JPassbolt</span>
                </div>

                <nav className="sidebar-nav">
                    {navItems.map(({ label, path, icon: Icon }) => (
                        <NavLink
                            key={path}
                            to={path}
                            end={path === '/'}
                            className={({ isActive }) =>
                                `sidebar-nav-item${isActive ? ' active' : ''}`
                            }
                        >
                            <Icon size={18} />
                            <span>{label}</span>
                        </NavLink>
                    ))}
                </nav>

                <div className="sidebar-footer">
                    <Avatar src={avatarUrl} firstName={user?.profile?.first_name} lastName={user?.profile?.last_name} name={user?.username} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {displayName}
                        </div>
                        {user?.username && (
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {user.username}
                            </div>
                        )}
                    </div>
                </div>
            </aside>

            <div className="app-main">
                <header className="app-topbar">
                    <div style={{ flex: 1, minWidth: 0 }}>{topbarSlot}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{user?.username}</span>
                        <button onClick={logout} className="btn btn-secondary" style={{ padding: '6px 12px' }}>
                            <LogOut size={16} /> Logout
                        </button>
                    </div>
                </header>

                <main className="animate-fade-in">{children ?? <Outlet />}</main>
            </div>
        </div>
    );
}

export default Layout;
