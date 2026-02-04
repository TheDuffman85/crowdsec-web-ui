import { NavLink } from "react-router-dom";
import { LayoutDashboard, ShieldAlert, Gavel, X, Sun, Moon, ArrowUpCircle, Menu, PanelLeftClose } from "lucide-react";
import { useRefresh } from "../contexts/RefreshContext";
import { useState, useEffect } from "react";
import { apiUrl, assetUrl } from "../lib/basePath";

export function Sidebar({ isOpen, onClose, onToggle, theme, toggleTheme }) {
    const { intervalMs, setIntervalMs, lastUpdated, refreshSignal } = useRefresh();
    const [updateStatus, setUpdateStatus] = useState(null);

    const links = [
        { to: "/", label: "Dashboard", icon: LayoutDashboard },
        { to: "/alerts", label: "Alerts", icon: ShieldAlert },
        { to: "/decisions", label: "Decisions", icon: Gavel },
    ];

    useEffect(() => {
        const checkUpdates = async () => {
            try {
                const response = await fetch(apiUrl('/api/update-check'));
                if (response.ok) {
                    setUpdateStatus(await response.json());
                }
            } catch (error) {
                console.error("Failed to check for updates", error);
            }
        };

        checkUpdates();
        // Check on mount and when refresh signal triggers
    }, [refreshSignal]);

    const formatTime = (date) => {
        if (!date) return "";
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
                    <img
                        src={assetUrl('/logo.svg')}
                        alt="CrowdSec Logo"
                        className="w-10 h-10 flex-shrink-0"
                    />
                    <h1 className="text-xl lg:text-2xl font-bold bg-gradient-to-r from-primary-600 to-primary-400 bg-clip-text text-transparent leading-tight whitespace-nowrap">
                        CrowdSec Web UI
                    </h1>
                </div>
                {/* Close button on mobile */}
                <button
                    onClick={onClose}
                    className="lg:hidden p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 flex-shrink-0"
                    aria-label="Close Menu"
                >
                    <X size={20} />
                </button>
                {/* Collapse button on desktop */}
                <button
                    onClick={onToggle}
                    className="hidden lg:flex p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 flex-shrink-0"
                    aria-label="Collapse Menu"
                >
                    <PanelLeftClose size={20} />
                </button>
            </div>
            <nav className="flex-1 px-4 space-y-2">
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={link.to}
                        onClick={() => {
                            if (window.innerWidth < 1024) {
                                onClose && onClose();
                            }
                        }}
                        className={({ isActive }) =>
                            `flex items-center px-4 py-3 rounded-lg transition-all duration-200 group ${isActive
                                ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-gray-200"
                            }`
                        }
                    >
                        <link.icon className="w-5 h-5 mr-3" />
                        <span className="font-medium">{link.label}</span>
                    </NavLink>
                ))}
            </nav>
            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-4">

                {/* Refresh Settings */}
                <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                            Refresh
                        </label>
                        {lastUpdated && (
                            <span className="text-[10px] items-center text-gray-400 font-mono">
                                {formatTime(lastUpdated)}
                            </span>
                        )}
                    </div>
                    <select
                        value={intervalMs}
                        onChange={(e) => setIntervalMs(Number(e.target.value))}
                        className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
                    >
                        <option value={0}>Off</option>
                        <option value={5000}>Every 5s</option>
                        <option value={30000}>Every 30s</option>
                        <option value={60000}>Every 1m</option>
                        <option value={300000}>Every 5m</option>
                    </select>
                </div>
                <button
                    onClick={toggleTheme}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                    {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
                    <span className="text-sm font-medium">
                        {theme === "light" ? "Dark Mode" : "Light Mode"}
                    </span>
                </button>

                {/* Update Notification */}
                {updateStatus?.update_available && (
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                        <div className="flex items-start gap-3">
                            <ArrowUpCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">
                                    Update Available
                                </p>
                                <p className="text-xs text-blue-600 dark:text-blue-400">
                                    New version available for tag <span className="font-mono bg-blue-100 dark:bg-blue-800 px-1 rounded">{updateStatus.tag}</span>
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                <p className="text-xs text-center text-gray-400 dark:text-gray-500 flex flex-col items-center gap-1">
                    <span>{import.meta.env.VITE_BRANCH === 'dev' ? 'Dev Build' : 'Build'} {import.meta.env.VITE_BUILD_DATE}</span>
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
                </p>
            </div>
        </aside>

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
                <img
                    src={assetUrl('/logo.svg')}
                    alt="CrowdSec Logo"
                    className="w-8 h-8"
                />
                <button
                    onClick={onToggle}
                    className="p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                    aria-label="Expand Menu"
                    title="Expand Menu"
                >
                    <Menu size={20} />
                </button>
            </div>

            {/* Nav icons */}
            <nav className="flex-1 px-2 space-y-2">
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={link.to}
                        className={({ isActive }) =>
                            `flex items-center justify-center p-3 rounded-lg transition-all duration-200 group ${isActive
                                ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-gray-200"
                            }`
                        }
                        title={link.label}
                    >
                        <link.icon className="w-5 h-5" />
                    </NavLink>
                ))}
            </nav>
        </aside>
    </>
    );
}
