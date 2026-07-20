import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, ShieldAlert, Gavel, Bell, X, Sun, Moon, ArrowUpCircle, BarChart3, Menu, PanelLeftClose, Settings as SettingsIcon, LogOut, RefreshCw, ChevronDown, Boxes } from "lucide-react";
import { Badge } from "./ui/Badge";
import { useAuth } from "../contexts/AuthContext";
import { useNotificationUnreadCount } from "../contexts/useNotificationUnreadCount";
import { useRefresh } from "../contexts/useRefresh";
import { useState, useEffect, useRef } from "react";
import { apiUrl, assetUrl } from "../lib/basePath";
import { fetchConfig } from "../lib/api";
import type { InstanceSummary, UpdateCheckResponse } from '../types';
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/dateTime";
import { useOptionalToast } from "../contexts/useToast";
import { Modal } from "./ui/Modal";
import { DropdownSelect } from "./ui/DropdownSelect";
import type { ManualRefreshMode } from "../types";

type ThemeMode = 'light' | 'dark';
const METRICS_SIDEBAR_PREFERENCE_EVENT = 'metrics-sidebar-preference-changed';
const MANUAL_REFRESH_SETTING_EVENT = 'manual-refresh-setting-changed';

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
    onToggle: () => void;
    theme: ThemeMode;
    toggleTheme: () => void;
}

function normalizeUpdateStatus(status: UpdateCheckResponse): UpdateCheckResponse {
    if (!status.update_available || !status.remote_version) {
        return status;
    }

    const currentVersion = import.meta.env.VITE_VERSION?.replace(/^v/i, '').trim();
    const remoteVersion = status.remote_version.replace(/^v/i, '').trim();
    if (!currentVersion || compareReleaseVersions(remoteVersion, currentVersion) > 0) {
        return status;
    }

    return {
        ...status,
        update_available: false,
    };
}

function compareReleaseVersions(left: string, right: string): number {
    const leftParts = left.split('.').map((part) => Number(part));
    const rightParts = right.split('.').map((part) => Number(part));
    const canCompareNumerically = leftParts.every(Number.isFinite) && rightParts.every(Number.isFinite);

    if (!canCompareNumerically) {
        return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    }

    const maxLength = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < maxLength; index += 1) {
        const leftPart = leftParts[index] || 0;
        const rightPart = rightParts[index] || 0;
        if (leftPart !== rightPart) {
            return leftPart > rightPart ? 1 : -1;
        }
    }

    return 0;
}

export function Sidebar({ isOpen, onClose, onToggle, theme, toggleTheme }: SidebarProps) {
    const { authEnabled, logout, user } = useAuth();
    const { lastUpdated, refreshSignal, syncStatus, refreshNow } = useRefresh();
    const { unreadCount } = useNotificationUnreadCount();
    const { t } = useI18n();
    const { formatTime } = useDateTime();
    const [updateStatus, setUpdateStatus] = useState<UpdateCheckResponse | null>(null);
    const [showMetricsNav, setShowMetricsNav] = useState(false);
    const [loadTestProfile, setLoadTestProfile] = useState<string | null>(null);
    const [manualRefreshEnabled, setManualRefreshEnabled] = useState(false);
    const [refreshMenuOpen, setRefreshMenuOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [confirmFullRefresh, setConfirmFullRefresh] = useState(false);
    const refreshMenuRef = useRef<HTMLDivElement>(null);
    const toast = useOptionalToast();
    const location = useLocation();
    const navigate = useNavigate();
    const [instances, setInstances] = useState<InstanceSummary[]>([]);
    const requestedInstance = new URLSearchParams(location.search).get('instance');
    const currentInstance = requestedInstance
        || (instances.length > 1 ? 'all' : instances[0]?.id || 'all');

    const scopedLink = (path: string) => {
        if (!['/', '/alerts', '/decisions', '/metrics'].includes(path) || instances.length <= 1) return path;
        return `${path}?instance=${encodeURIComponent(currentInstance)}`;
    };

    const changeInstance = (instanceId: string) => {
        window.localStorage.setItem('crowdsec-web-ui:instance-scope', instanceId);
        const params = new URLSearchParams(location.search);
        params.set('instance', instanceId);
        navigate(`${location.pathname}?${params.toString()}`);
    };

    useEffect(() => {
        if (instances.length <= 1 || requestedInstance) return;
        const stored = window.localStorage.getItem('crowdsec-web-ui:instance-scope');
        const restored = stored && (stored === 'all' || instances.some((instance) => instance.id === stored)) ? stored : 'all';
        const params = new URLSearchParams(location.search);
        params.set('instance', restored);
        navigate(`${location.pathname}?${params.toString()}`, { replace: true });
    }, [instances, location.pathname, location.search, navigate, requestedInstance]);

    const links = [
        { to: "/", label: "components.sidebar.nav.dashboard", icon: LayoutDashboard },
        { to: "/alerts", label: "components.sidebar.nav.alerts", icon: ShieldAlert },
        { to: "/decisions", label: "components.sidebar.nav.decisions", icon: Gavel },
        { to: "/notifications", label: "components.sidebar.nav.notifications", icon: Bell },
        ...(showMetricsNav ? [{ to: "/metrics", label: "components.sidebar.nav.metrics", icon: BarChart3 }] : []),
        { to: "/settings", label: "components.sidebar.nav.settings", icon: SettingsIcon },
    ];

    useEffect(() => {
        let cancelled = false;

        const checkUpdates = async () => {
            try {
                const params = new URLSearchParams();
                if (import.meta.env.VITE_VERSION) params.set('version', import.meta.env.VITE_VERSION);
                if (import.meta.env.VITE_BRANCH) params.set('branch', import.meta.env.VITE_BRANCH);
                if (import.meta.env.VITE_COMMIT_HASH) params.set('commit_hash', import.meta.env.VITE_COMMIT_HASH);
                const response = await fetch(apiUrl(`/api/update-check${params.size ? `?${params.toString()}` : ''}`), { cache: 'no-store' });
                if (!response.ok || cancelled) {
                    return;
                }

                const status: UpdateCheckResponse = await response.json();
                if (!cancelled) {
                    setUpdateStatus(normalizeUpdateStatus(status));
                }
            } catch (error) {
                if (!cancelled) {
                    console.error("Failed to check for updates", error);
                }
            }
        };

        void checkUpdates();
        // Check on mount and when refresh signal triggers
        return () => {
            cancelled = true;
        };
    }, [refreshSignal]);

    useEffect(() => {
        let cancelled = false;

        const loadSidebarConfig = async () => {
            try {
                const config = await fetchConfig();
                if (!cancelled) {
                    setShowMetricsNav(config.metrics_sidebar_visible !== false);
                    setManualRefreshEnabled(config.manual_refresh_enabled === true);
                    if (config.manual_refresh_enabled !== true) {
                        setRefreshMenuOpen(false);
                        setConfirmFullRefresh(false);
                    }
                    setLoadTestProfile(config.deployment_mode === 'load-test'
                        ? config.load_test_profile || 'default'
                        : null);
                    setInstances(config.instances || []);
                }
            } catch (error) {
                if (!cancelled) {
                    console.error("Failed to check metrics availability", error);
                }
            }
        };

        void loadSidebarConfig();
        window.addEventListener(METRICS_SIDEBAR_PREFERENCE_EVENT, loadSidebarConfig);
        window.addEventListener(MANUAL_REFRESH_SETTING_EVENT, loadSidebarConfig);

        return () => {
            cancelled = true;
            window.removeEventListener(METRICS_SIDEBAR_PREFERENCE_EVENT, loadSidebarConfig);
            window.removeEventListener(MANUAL_REFRESH_SETTING_EVENT, loadSidebarConfig);
        };
    }, []);

    useEffect(() => {
        if (!refreshMenuOpen) return;

        const closeMenu = (event: MouseEvent) => {
            if (!refreshMenuRef.current?.contains(event.target as Node)) setRefreshMenuOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setRefreshMenuOpen(false);
        };
        document.addEventListener('mousedown', closeMenu);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeMenu);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [refreshMenuOpen]);

    useEffect(() => {
        if (isOpen) return;
        const timeoutId = window.setTimeout(() => setRefreshMenuOpen(false), 0);
        return () => window.clearTimeout(timeoutId);
    }, [isOpen]);

    const runRefresh = async (mode: ManualRefreshMode) => {
        setRefreshMenuOpen(false);
        setRefreshing(true);
        try {
            if (refreshNow) {
                await refreshNow(mode);
            } else {
                const response = await fetch(apiUrl('/api/cache/refresh'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                const data = await response.json().catch(() => ({})) as { error?: string };
                if (!response.ok) throw new Error(data.error || t('components.sidebar.refresh.failed'));
            }
            toast?.addToast(t('components.sidebar.refresh.completed'), 'success');
        } catch (error) {
            toast?.addToast(error instanceof Error ? error.message : t('components.sidebar.refresh.failed'), 'danger');
        } finally {
            setRefreshing(false);
        }
    };

    const refreshBusy = refreshing || Boolean(syncStatus?.isSyncing);

    const formatLastUpdatedTime = (date: Date | null) => {
        if (!date) return "";
        return formatTime(date, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    const logo = (
        <img
            src={assetUrl('/logo-sidebar.png')}
            alt={t('components.sidebar.logoAlt')}
            className="h-10 w-10 flex-shrink-0"
        />
    );

    const renderUnreadBadge = (compact = false) => {
        if (unreadCount <= 0) {
            return null;
        }

        return (
            <Badge
                aria-label={t('components.sidebar.unreadNotifications', { count: unreadCount })}
                className={compact
                    ? "absolute right-1.5 top-1.5 min-h-5 min-w-5 justify-center rounded-full bg-primary-500 px-1.5 text-white dark:bg-primary-500 dark:text-white"
                    : "ml-auto min-w-6 justify-center rounded-full bg-primary-500 text-white dark:bg-primary-500 dark:text-white"
                }
            >
                {unreadCount}
            </Badge>
        );
    };

    return (
        <>
            {/* Full Sidebar */}
            <aside
                className={`
                    fixed top-0 left-0 z-[9999]
                    w-[340px] h-[100dvh]
                    bg-white dark:bg-gray-800 
                    border-r border-gray-200 dark:border-gray-700 
                    flex flex-col 
                    bg-opacity-95 lg:bg-opacity-50 backdrop-blur-xl
                    transition-transform duration-300 ease-in-out
                    ${isOpen ? "translate-x-0" : "-translate-x-full"}
                `}
            >
            <div className="p-4 lg:p-5 flex justify-between items-center gap-2">
                <div className="flex items-center gap-2 lg:gap-3">
                    {isOpen ? logo : null}
                    <h1 className="text-xl lg:text-2xl font-bold bg-gradient-to-r from-primary-600 to-primary-400 bg-clip-text text-transparent leading-tight whitespace-nowrap">
                        CrowdSec Web UI
                    </h1>
                </div>
                {/* Close button on mobile */}
                <button
                    onClick={onClose}
                    className="lg:hidden p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 flex-shrink-0"
                    aria-label={t('components.sidebar.aria.closeMenu')}
                >
                    <X size={20} />
                </button>
                {/* Collapse button on desktop */}
                <button
                    onClick={onToggle}
                    className="hidden lg:flex p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 flex-shrink-0"
                    aria-label={t('components.sidebar.aria.collapseMenu')}
                >
                    <PanelLeftClose size={20} />
                </button>
            </div>
            {instances.length > 1 && (
                <div className="px-4 pb-3">
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500" htmlFor="crowdsec-instance-selector">
                        {t('components.sidebar.instance')}
                    </label>
                    <DropdownSelect
                        id="crowdsec-instance-selector"
                        label={t('components.sidebar.instance')}
                        value={currentInstance}
                        onChange={changeInstance}
                        options={[
                            {
                                value: 'all',
                                label: t('components.sidebar.allInstances'),
                                icon: <Boxes className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />,
                            },
                            ...instances.map((instance) => ({
                                value: instance.id,
                                label: instance.name,
                                icon: instance.icon ? <span aria-hidden="true">{instance.icon}</span> : undefined,
                            })),
                        ]}
                    />
                </div>
            )}
            <nav className="flex-1 px-4 space-y-2">
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={scopedLink(link.to)}
                        onClick={() => {
                            if (window.innerWidth < 1024) {
                                if (onClose) {
                                    onClose();
                                }
                            }
                        }}
                        className={({ isActive }) =>
                            `flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group ${isActive
                                ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-gray-200"
                            }`
                        }
                    >
                        <div className="flex min-w-0 items-center gap-3">
                            <link.icon className="w-5 h-5" />
                            <span className="font-medium">{t(link.label)}</span>
                        </div>
                        {link.to === "/notifications" ? renderUnreadBadge() : null}
                    </NavLink>
                ))}
            </nav>
            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                            {t('components.sidebar.lastRefresh')}
                        </p>
                        <p className="mt-1 truncate font-mono text-xs text-gray-400 dark:text-gray-500">
                            {lastUpdated ? formatLastUpdatedTime(lastUpdated) : t('components.sidebar.lastRefreshNever')}
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {manualRefreshEnabled && <div ref={refreshMenuRef} className="relative flex items-center">
                            <button
                                type="button"
                                onClick={() => void runRefresh('delta')}
                                disabled={refreshBusy}
                                className="flex min-h-11 min-w-11 items-center justify-center rounded-l-md text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 disabled:cursor-wait disabled:opacity-60 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
                                aria-label={t('components.sidebar.refresh.deltaNow')}
                                title={t('components.sidebar.refresh.deltaNow')}
                            >
                                <RefreshCw size={18} className={refreshBusy ? 'animate-spin' : undefined} />
                            </button>
                            <button
                                type="button"
                                onClick={() => setRefreshMenuOpen((open) => !open)}
                                disabled={refreshBusy}
                                className="flex min-h-11 min-w-9 items-center justify-center rounded-r-md border-l border-gray-200 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 disabled:cursor-wait disabled:opacity-60 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
                                aria-label={t('components.sidebar.refresh.chooseType')}
                                aria-haspopup="menu"
                                aria-expanded={refreshMenuOpen}
                            >
                                <ChevronDown size={15} />
                            </button>
                            {refreshMenuOpen && (
                                <div
                                    role="menu"
                                    className="absolute bottom-full right-0 z-20 mb-2 w-52 overflow-hidden rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
                                >
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => void runRefresh('latest')}
                                        className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                                    >
                                        {t('components.sidebar.refresh.latestNow')}
                                    </button>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setRefreshMenuOpen(false);
                                            setConfirmFullRefresh(true);
                                        }}
                                        className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                                    >
                                        {t('components.sidebar.refresh.fullNow')}
                                    </button>
                                </div>
                            )}
                        </div>}
                        <button
                            onClick={toggleTheme}
                            className="flex min-h-11 min-w-9 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
                            aria-label={theme === "light" ? t('components.sidebar.darkMode') : t('components.sidebar.lightMode')}
                            title={theme === "light" ? t('components.sidebar.darkMode') : t('components.sidebar.lightMode')}
                        >
                            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
                        </button>
                    </div>
                </div>

                {authEnabled && user && (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
                        <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-gray-700 dark:text-gray-200">{user.username}</p>
                            <p className="text-xs text-gray-500">{user.role === 'read-only' ? 'Read-only' : 'Admin'}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void logout()}
                            className="shrink-0 rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
                            aria-label="Sign out"
                            title="Sign out"
                        >
                            <LogOut size={18} />
                        </button>
                    </div>
                )}

                {/* Update Notification */}
                {updateStatus?.update_available && (
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                        <div className="flex items-start gap-3">
                            <ArrowUpCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">
                                    {t('components.sidebar.updateAvailable')}
                                </p>
                                <p className="text-xs text-blue-600 dark:text-blue-400">
                                    {updateStatus.release_url ? (
                                        <a
                                            href={updateStatus.release_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="underline hover:text-blue-800 dark:hover:text-blue-200"
                                        >
                                            v{updateStatus.remote_version}
                                        </a>
                                    ) : updateStatus.remote_version ? (
                                        <>{t('components.sidebar.newVersion')}: <span className="font-mono bg-blue-100 dark:bg-blue-800 px-1 rounded">dev-{updateStatus.remote_version}</span></>
                                    ) : (
                                        <>{t('components.sidebar.newVersionAvailableForTag')} <span className="font-mono bg-blue-100 dark:bg-blue-800 px-1 rounded">{updateStatus.tag}</span></>
                                    )}
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                <p className="text-xs text-center text-gray-400 dark:text-gray-500 flex flex-col items-center gap-1">
                    {loadTestProfile ? (
                        <span>
                            {t('components.sidebar.loadTest')}: <span className="font-mono">{loadTestProfile}</span>
                        </span>
                    ) : import.meta.env.VITE_VERSION ? (
                        <>
                            <a
                                href={
                                    import.meta.env.VITE_BRANCH === 'dev'
                                        ? `${import.meta.env.VITE_REPO_URL}/commit/${import.meta.env.VITE_COMMIT_HASH}`
                                        : `${import.meta.env.VITE_REPO_URL}/releases/tag/${import.meta.env.VITE_VERSION}`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-primary-500 transition-colors font-mono"
                            >
                                {import.meta.env.VITE_BRANCH === 'dev' ? 'dev-' : 'v'}{import.meta.env.VITE_VERSION}
                            </a>
                            <span>{import.meta.env.VITE_BUILD_DATE}</span>
                        </>
                    ) : (
                        <>
                            <span>{t('components.sidebar.development')}</span>
                            {import.meta.env.VITE_COMMIT_HASH && (
                                <a
                                    href={`${import.meta.env.VITE_REPO_URL}/commit/${import.meta.env.VITE_COMMIT_HASH}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:text-primary-500 transition-colors font-mono"
                                >
                                    ({import.meta.env.VITE_COMMIT_HASH})
                                </a>
                            )}
                        </>
                    )}
                </p>
            </div>
        </aside>

        <Modal
            isOpen={manualRefreshEnabled && confirmFullRefresh}
            onClose={() => setConfirmFullRefresh(false)}
            title={t('components.sidebar.refresh.fullConfirmTitle')}
        >
            <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">
                {t('components.sidebar.refresh.fullConfirmDescription')}
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                    type="button"
                    onClick={() => setConfirmFullRefresh(false)}
                    className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                    {t('common.cancel')}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setConfirmFullRefresh(false);
                        void runRefresh('full');
                    }}
                    className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700"
                >
                    {t('components.sidebar.refresh.confirmFull')}
                </button>
            </div>
        </Modal>

        {/* Collapsed sidebar desktop and tablet */}
        <aside
            className={`
                hidden lg:flex
                fixed top-0 left-0 z-[9998]
                w-16 h-[100dvh]
                bg-white dark:bg-gray-800
                border-r border-gray-200 dark:border-gray-700
                flex-col
                bg-opacity-50 backdrop-blur-xl
                transition-transform duration-300 ease-in-out
                ${isOpen ? "-translate-x-full" : "translate-x-0"}
            `}
        >
            {/* Logo mini and expand button */}
            <div className="p-4 flex flex-col items-center gap-3">
                {!isOpen ? (
                    <img
                        src={assetUrl('/logo-sidebar.png')}
                        alt={t('components.sidebar.logoAlt')}
                        className="h-8 w-8"
                    />
                ) : null}
                <button
                    onClick={onToggle}
                    className="p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                    aria-label={t('components.sidebar.aria.expandMenu')}
                    title={t('components.sidebar.aria.expandMenu')}
                >
                    <Menu size={20} />
                </button>
            </div>

            {/* Nav icons */}
            <nav className="flex-1 px-2 space-y-2">
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={scopedLink(link.to)}
                        className={({ isActive }) =>
                            `relative flex items-center justify-center p-3 rounded-lg transition-all duration-200 group ${isActive
                                ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-gray-200"
                            }`
                        }
                        title={t(link.label)}
                    >
                        <link.icon className="w-5 h-5" />
                        {link.to === "/notifications" ? renderUnreadBadge(true) : null}
                    </NavLink>
                ))}
            </nav>
        </aside>
    </>
    );
}
