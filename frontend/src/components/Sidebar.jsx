import { NavLink } from "react-router-dom";
import { LayoutDashboard, ShieldAlert, Gavel } from "lucide-react";

export function Sidebar() {
    const links = [
        { to: "/", label: "Dashboard", icon: LayoutDashboard },
        { to: "/alerts", label: "Alerts", icon: ShieldAlert },
        { to: "/decisions", label: "Decisions", icon: Gavel },
    ];

    return (
        <aside className="w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col h-full bg-opacity-50 backdrop-blur-xl">
            <div className="p-6">
                <h1 className="text-2xl font-bold bg-gradient-to-r from-primary-600 to-primary-400 bg-clip-text text-transparent">
                    CrowdSec
                </h1>
            </div>
            <nav className="flex-1 px-4 space-y-2">
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={link.to}
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
