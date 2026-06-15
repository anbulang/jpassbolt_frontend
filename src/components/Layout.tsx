import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type ComponentType,
    type ReactNode,
} from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
    Vault,
    Users,
    Settings,
    KeyRound,
    LogOut,
    Lock,
    Sun,
    Moon,
    User,
    type LucideProps,
} from 'lucide-react';
import { logout } from '../auth';
import { getMe } from '../services/profile';
import { useKey } from '../crypto/KeyContext';
import { useTheme } from '../theme';

interface NavItem {
    label: string;
    path: string;
    icon: ComponentType<LucideProps>;
}

/** Primary navigation, icon-only in the Aegis rail (tooltips carry the label). */
const NAV_ITEMS: NavItem[] = [
    { label: '保险库', path: '/', icon: Vault },
    { label: '用户', path: '/users', icon: User },
    { label: '群组', path: '/groups', icon: Users },
    { label: '设置', path: '/settings', icon: Settings },
];

/**
 * Admin-only rail entry for the encrypted-metadata config panel. Appended only
 * once the network role check (GET /users/me.json) confirms admin — the LS blob
 * is not a trusted role source, and the page itself also self-gates.
 */
const ADMIN_NAV_ITEM: NavItem = {
    label: '加密元数据',
    path: '/settings/encrypted-metadata',
    icon: KeyRound,
};

/** Route → topbar title (Chinese), matching the Aegis design crumbs. */
const TITLES: Record<string, string> = {
    '/': '保险库',
    '/users': '用户',
    '/groups': '群组',
    '/settings': '设置',
    '/settings/encrypted-metadata': '加密元数据',
};

interface CurrentUser {
    username?: string;
    profile?: {
        first_name?: string;
        last_name?: string;
        avatar?: { url?: { small?: string; medium?: string } } | null;
    } | null;
}

function readCurrentUser(): CurrentUser | null {
    try {
        const raw = localStorage.getItem('jpassbolt_user');
        return raw ? (JSON.parse(raw) as CurrentUser) : null;
    } catch {
        return null;
    }
}

/** Two-letter initials from names / username, for the rail avatar. */
function initialsOf(user: CurrentUser | null): string {
    const f = user?.profile?.first_name?.trim() ?? '';
    const l = user?.profile?.last_name?.trim() ?? '';
    if (f || l) return `${f.charAt(0)}${l.charAt(0)}`.toUpperCase() || 'U';
    const n = (user?.username ?? '').trim();
    if (n) {
        const parts = n.split(/[\s@._-]+/).filter(Boolean);
        if (parts.length >= 2) return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
        return n.slice(0, 2).toUpperCase();
    }
    return 'U';
}

/** A stable accent-family color derived from the username, for the avatar. */
function colorOf(seed: string): string {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `oklch(0.55 0.15 ${hue})`;
}

/** Lightweight SVG progress ring (used by the idle-lock pill). */
function Ring({ pct, color }: { pct: number; color: string }) {
    const size = 18;
    const stroke = 2.4;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
            <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={c}
                strokeDashoffset={c * (1 - pct)}
                style={{ transition: 'stroke-dashoffset .3s linear' }}
            />
        </svg>
    );
}

/**
 * Idle-lock pill. Owns its own per-second countdown so the rest of the shell
 * does not re-render every tick. Resets on user activity; at zero it locks the
 * vault (wiping the in-memory key, which makes LockGate show the unlock screen).
 * Clicking the pill locks immediately. When idleSecs is 0, auto-lock is off.
 */
function LockPill({ idleSecs, onLock }: { idleSecs: number; onLock: () => void }) {
    const [remain, setRemain] = useState(idleSecs);
    const lastActivity = useRef(0);

    useEffect(() => {
        if (idleSecs <= 0) return; // auto-lock disabled
        const iv = window.setInterval(() => {
            setRemain((s) => {
                if (s <= 1) {
                    onLock();
                    return idleSecs;
                }
                return s - 1;
            });
        }, 1000);
        const reset = () => {
            const now = Date.now();
            if (now - lastActivity.current > 800) {
                lastActivity.current = now;
                setRemain(idleSecs);
            }
        };
        window.addEventListener('mousemove', reset);
        window.addEventListener('keydown', reset);
        window.addEventListener('click', reset);
        return () => {
            window.clearInterval(iv);
            window.removeEventListener('mousemove', reset);
            window.removeEventListener('keydown', reset);
            window.removeEventListener('click', reset);
        };
    }, [idleSecs, onLock]);

    if (idleSecs <= 0) {
        return (
            <button className="lockpill" onClick={onLock} title="点击立即锁定" type="button">
                <span className="dot" />
                <span className="lbl">已解锁</span>
            </button>
        );
    }

    const mm = String(Math.floor(remain / 60));
    const ss = String(remain % 60).padStart(2, '0');
    const warn = remain <= 20;
    return (
        <button
            className={`lockpill${warn ? ' warn' : ''}`}
            onClick={onLock}
            title="点击立即锁定"
            type="button"
        >
            <span className="ring">
                <Ring pct={remain / idleSecs} color={warn ? 'var(--amber)' : 'var(--green)'} />
            </span>
            <span className="lbl">{warn ? '即将锁定' : '已解锁'}</span>
            <span className="time mono">
                {mm}:{ss}
            </span>
        </button>
    );
}

interface LayoutProps {
    /** Render explicit children instead of the router <Outlet/>. */
    children?: ReactNode;
}

/**
 * App shell (Aegis): a 60px icon nav rail (logo + primary nav + theme toggle +
 * avatar menu) and a main column with a top bar (page title + idle-lock pill +
 * immediate-lock button). Renders children when provided, else the router Outlet.
 *
 * The idle-lock pill and the lock button both call useKey().lock(), which wipes
 * the in-memory private key — LockGate then renders the passphrase Unlock screen.
 */
export function Layout({ children }: LayoutProps) {
    const user = readCurrentUser();
    const navigate = useNavigate();
    const location = useLocation();
    const { lock } = useKey();
    const { prefs, toggleTheme } = useTheme();

    const displayName =
        [user?.profile?.first_name, user?.profile?.last_name].filter(Boolean).join(' ') ||
        user?.username ||
        'Account';
    const initials = initialsOf(user);
    const avatarColor = colorOf(user?.username ?? displayName);

    const [avMenu, setAvMenu] = useState(false);

    // Resolve the admin rail entry from the NETWORK role (GET /users/me.json),
    // not the LS blob which is not a trusted role source.
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

    const title = TITLES[location.pathname] ?? '保险库';
    const dark = prefs.theme === 'dark';

    return (
        <div className={`app${prefs.density === 'compact' ? ' compact' : ''}`}>
            <div className="rail">
                <div className="rail-logo" title="JPassbolt">
                    <Vault />
                </div>
                {navItems.map(({ label, path, icon: Icon }) => (
                    <NavLink
                        key={path}
                        to={path}
                        end={path === '/'}
                        title={label}
                        className={({ isActive }) => `rail-btn${isActive ? ' active' : ''}`}
                    >
                        <Icon />
                    </NavLink>
                ))}
                <div className="rail-spacer" />
                <button
                    className="rail-btn"
                    title={dark ? '切换到浅色' : '切换到深色'}
                    onClick={toggleTheme}
                    type="button"
                >
                    {dark ? <Sun /> : <Moon />}
                </button>
                <div style={{ position: 'relative' }}>
                    <button
                        className="rail-avatar"
                        style={{ background: avatarColor }}
                        title={displayName}
                        onClick={() => setAvMenu((v) => !v)}
                        type="button"
                    >
                        {initials}
                    </button>
                    {avMenu && (
                        <div className="menu avatar-menu" onMouseLeave={() => setAvMenu(false)}>
                            <button
                                onClick={() => {
                                    setAvMenu(false);
                                    navigate('/settings');
                                }}
                            >
                                <User /> 个人资料
                            </button>
                            <button
                                onClick={() => {
                                    setAvMenu(false);
                                    lock();
                                }}
                            >
                                <Lock /> 锁定保险库
                            </button>
                            <div className="sep" />
                            <button className="danger" onClick={logout}>
                                <LogOut /> 退出登录
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <div className="main">
                <div className="topbar">
                    <h1>{title}</h1>
                    <div className="topbar-spacer" />
                    <LockPill key={prefs.idleSecs} idleSecs={prefs.idleSecs} onLock={lock} />
                    <button className="tb-btn tb-lock" title="立即锁定" onClick={lock} type="button">
                        <Lock />
                    </button>
                </div>

                <div className="main-scroll">{children ?? <Outlet />}</div>
            </div>
        </div>
    );
}

export default Layout;
