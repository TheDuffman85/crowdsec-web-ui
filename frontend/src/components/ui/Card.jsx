import { cn } from "../../lib/utils";

export function Card({ className, children }) {
    return (
        <div className={cn("bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden", className)}>
            {children}
        </div>
    );
}

export function CardHeader({ className, children }) {
    return (
        <div className={cn("px-6 py-4 border-b border-gray-100 dark:border-gray-700/50", className)}>
            {children}
        </div>
    );
}

export function CardTitle({ className, children }) {
    return (
        <h3 className={cn("text-lg font-semibold text-gray-900 dark:text-gray-100", className)}>
            {children}
        </h3>
    );
}

export function CardContent({ className, children }) {
    return (
        <div className={cn("p-6", className)}>
            {children}
        </div>
    );
}
