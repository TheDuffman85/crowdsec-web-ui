import { createPortal } from "react-dom";
import { RefreshCw, Database } from "lucide-react";

export function SyncOverlay({ syncStatus }) {
    if (!syncStatus?.isSyncing) return null;

    const progress = syncStatus.progress || 0;

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 text-center">
                {/* Icon with animation */}
                <div className="relative inline-flex items-center justify-center mb-6">
                    <div className="absolute inset-0 animate-ping bg-blue-500/20 rounded-full" style={{ animationDuration: '2s' }}></div>
                    <div className="relative bg-gradient-to-br from-blue-500 to-indigo-600 p-4 rounded-full">
                        <Database className="w-8 h-8 text-white" />
                    </div>
                </div>

                {/* Title */}
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                    Syncing Historical Data
                </h2>
                <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">
                    Please wait while we fetch your security data...
                </p>

                {/* Progress bar */}
                <div className="relative w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-3">
                    <div
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${progress}%` }}
                    />
                    <div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"
                        style={{
                            backgroundSize: '200% 100%',
                            animation: 'shimmer 1.5s infinite'
                        }}
                    />
                </div>

                {/* Progress text */}
                <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        {syncStatus.message || 'Synchronizing...'}
                    </span>
                    <span className="font-semibold text-blue-600 dark:text-blue-400">
                        {progress}%
                    </span>
                </div>
            </div>

            <style>{`
                @keyframes shimmer {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                }
            `}</style>
        </div>,
        document.body
    );
}
