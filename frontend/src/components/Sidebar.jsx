import { NavLink } from "react-router-dom";
import { LayoutDashboard, ShieldAlert, Gavel, X } from "lucide-react";

export function Sidebar({ isMobileMenuOpen, onClose }) {
    const links = [
        { to: "/", label: "Dashboard", icon: LayoutDashboard },
        { to: "/alerts", label: "Alerts", icon: ShieldAlert },
        { to: "/decisions", label: "Decisions", icon: Gavel },
    ];

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
            <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <p className="text-xs text-center text-gray-400 dark:text-gray-500">
                    v1.0.0
                </p>
            </div>
        </aside>
    );
}
