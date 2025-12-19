import { NavLink } from "react-router-dom";
import { LayoutDashboard, ShieldAlert, Gavel, X, Sun, Moon } from "lucide-react";
import { useRefresh } from "../contexts/RefreshContext";

export function Sidebar({ isMobileMenuOpen, onClose, theme, toggleTheme }) {
    const { intervalMs, setIntervalMs, lastUpdated } = useRefresh();
    const links = [
        { to: "/", label: "Dashboard", icon: LayoutDashboard },
        { to: "/alerts", label: "Alerts", icon: ShieldAlert },
        { to: "/decisions", label: "Decisions", icon: Gavel },
    ];

    const formatTime = (date) => {
        if (!date) return "";
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    return (
        <aside
            className={`
                fixed lg:static top-0 left-0 z-30
                w-72 h-full 
                bg-white dark:bg-gray-800 
                border-r border-gray-200 dark:border-gray-700 
                flex flex-col 
                bg-opacity-95 lg:bg-opacity-50 backdrop-blur-xl
                transition-transform duration-300 ease-in-out
                ${isMobileMenuOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
            `}
        >
            <div className="p-4 lg:p-6 flex justify-between items-center">
                <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
                    <img
                        src="/logo.svg"
                        alt="CrowdSec Logo"
                        className="w-8 h-8 lg:w-10 lg:h-10 flex-shrink-0"
                    />
                    <h1 className="text-sm lg:text-2xl font-bold bg-gradient-to-r from-primary-600 to-primary-400 bg-clip-text text-transparent leading-tight whitespace-nowrap">
                        CrowdSec Web UI
                    </h1>
                </div>
                <button
                    onClick={onClose}
                    className="lg:hidden p-1 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 flex-shrink-0 ml-2"
                >
                    <X size={20} />
                </button>
            </div>
            <nav className="flex-1 px-4 space-y-2">
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={link.to}
                        onClick={() => onClose && onClose()}
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
    );
}
