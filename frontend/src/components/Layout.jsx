import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useState, useEffect } from "react";

export function Layout() {
    const [theme, setTheme] = useState(() => {
        if (typeof window !== 'undefined') {
            const savedTheme = localStorage.getItem("theme");
            if (savedTheme) {
                return savedTheme;
            }
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                return "dark";
            }
        }
        return "light";
    });
    const [isMenuOpen, setIsMenuOpen] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem("menuOpen");
            if (saved !== null) {
                return saved === "true";
            }
            return window.innerWidth >= 1024;
        }
        return true;
    });

    useEffect(() => {
        if (theme === "dark") {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
        localStorage.setItem("theme", theme);
    }, [theme]);

    useEffect(() => {
        localStorage.setItem("menuOpen", isMenuOpen);
    }, [isMenuOpen]);

    const toggleTheme = () => {
        setTheme(theme === "light" ? "dark" : "light");
    };

    const toggleMenu = () => {
        setIsMenuOpen(!isMenuOpen);
    };

    const location = useLocation();
    
    const getPageTitle = () => {
        switch (location.pathname) {
            case '/':
                return 'Dashboard';
            case '/alerts':
                return 'Alerts';
            case '/decisions':
                return 'Decisions';
            default:
                return 'Dashboard';
        }
    };

    return (
        <div className="flex h-[100dvh] bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans">
            {/* Mobile Sidebar Overlay */}
            <div
                className={`fixed inset-0 bg-black/50 z-40 lg:hidden transition-opacity duration-300 ease-in-out ${isMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
                onClick={() => setIsMenuOpen(false)}
            />

            <Sidebar
                isOpen={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                theme={theme}
                toggleTheme={toggleTheme}
            />

            <main className={`flex-1 relative w-full z-0 isolate overflow-auto transition-[padding] duration-300 ease-in-out ${isMenuOpen ? 'lg:pl-72' : 'lg:pl-16'} ${isMenuOpen ? 'lg:overflow-auto overflow-hidden touch-none lg:touch-auto' : ''}`}>
                <div className="sticky top-0 z-30 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
                    <div className="container mx-auto px-4 lg:px-8 max-w-[1920px]">
                        <div className="flex items-center gap-4 h-16">
                            <button
                                onClick={toggleMenu}
                                className="p-2 rounded-lg bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 shadow-sm transition-colors border border-gray-200 dark:border-gray-700"
                                aria-label="Toggle Menu"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" /></svg>
                            </button>
                            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                {getPageTitle()}
                            </h1>
                        </div>
                    </div>
                </div>
                
                <div className="container mx-auto p-4 lg:p-8 max-w-[1920px]">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
