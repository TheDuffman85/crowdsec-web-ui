import { createPortal } from "react-dom";
import { RefreshCw, Database } from "lucide-react";
import type { SyncStatus } from "../types";
import { useI18n } from "../lib/i18n";

interface SyncOverlayProps {
    syncStatus: SyncStatus | null;
}

function translateSyncMessage(message: string | undefined, t: (key: string, values?: Record<string, string | number>) => string) {
    if (!message) {
        return t('components.syncOverlay.synchronizing');
    }

    if (message === 'Starting historical data sync...') {
        return t('components.syncOverlay.statusStarting');
    }

    if (message === 'Syncing active decisions...') {
        return t('components.syncOverlay.statusActiveDecisions');
    }

    const removedMatch = message.match(/^Removed (\d+) stale cached alerts and (\d+) stale cached decisions before sync\.$/);
    if (removedMatch) {
        return t('components.syncOverlay.statusRemovedStale', {
            alerts: Number(removedMatch[1]),
            decisions: Number(removedMatch[2]),
        });
    }

    const syncingMatch = message.match(/^Syncing: (.+) \((\d+) alerts, (\d+) decisions\)$/);
    if (syncingMatch) {
        return t('components.syncOverlay.statusSyncingWindow', {
            window: syncingMatch[1],
            alerts: Number(syncingMatch[2]),
            decisions: Number(syncingMatch[3]),
        });
    }

    return message;
}

export function SyncOverlay({ syncStatus }: SyncOverlayProps) {
    const { t } = useI18n();

    if (!syncStatus?.isSyncing) return null;

    const progress = syncStatus.progress || 0;
    const statusMessage = translateSyncMessage(syncStatus.message, t);

    return createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
                    {t('components.syncOverlay.title')}
                </h2>
                <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">
                    {t('components.syncOverlay.description')}
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
                        {statusMessage}
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
