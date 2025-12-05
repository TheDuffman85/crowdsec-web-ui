import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Sun, Moon } from "lucide-react";
import { useState, useEffect } from "react";

export function Layout() {
    const [theme, setTheme] = useState(localStorage.getItem("theme") || "light");

    useEffect(() => {
        if (theme === "dark") {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
        localStorage.setItem("theme", theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(theme === "light" ? "dark" : "light");
    };

    return (
        <div className="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans">
            <Sidebar />
            <main className="flex-1 overflow-auto relative">
                <header className="absolute top-0 right-0 p-4 z-10">
                    <button
                        onClick={toggleTheme}
                        className="p-2 rounded-full bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 shadow-sm transition-colors border border-gray-200 dark:border-gray-700"
                        aria-label="Toggle Theme"
                    >
                        {theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
                    </button>
                </header>
                <div className="container mx-auto p-8 max-w-7xl pt-20">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
