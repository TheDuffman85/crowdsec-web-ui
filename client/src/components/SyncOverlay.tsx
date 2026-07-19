import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, Database, RefreshCw } from "lucide-react";
import type { InstanceSyncStatus, SyncStatus } from "../types";
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

    const fixedMessages: Record<string, string> = {
        'Finalizing decision data...': 'components.syncOverlay.statusFinalizingDecisions',
        'Building search indexes...': 'components.syncOverlay.statusBuildingIndexes',
        'Preparing dashboard data...': 'components.syncOverlay.statusPreparingDashboard',
    };
    if (fixedMessages[message]) {
        return t(fixedMessages[message]);
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

    const fetchingMatch = message.match(/^Fetching: (.+) \((\d+) alerts and (\d+) decisions cached so far\)$/);
    if (fetchingMatch) {
        return t('components.syncOverlay.statusFetchingWindow', {
            window: fetchingMatch[1],
            alerts: Number(fetchingMatch[2]),
            decisions: Number(fetchingMatch[3]),
        });
    }

    const processingMatch = message.match(/^Processing (\d+) alerts and (\d+) decisions from (.+)\.\.\.$/);
    if (processingMatch) {
        return t('components.syncOverlay.statusProcessingWindow', {
            alerts: Number(processingMatch[1]),
            decisions: Number(processingMatch[2]),
            window: processingMatch[3],
        });
    }

    return message;
}

function instanceStatusMessage(
    instance: InstanceSyncStatus,
    t: (key: string, values?: Record<string, string | number>) => string,
) {
    if (instance.state === 'failed') {
        return instance.errors?.[0] || instance.message;
    }
    if (instance.state === 'complete' && instance.progress === 100) {
        return t('components.syncOverlay.statusComplete');
    }
    if (!instance.startedAt && !instance.completedAt && !instance.isSyncing && instance.progress === 0) {
        return t('components.syncOverlay.statusWaiting');
    }
    return translateSyncMessage(instance.message, t);
}

export function SyncOverlay({ syncStatus }: SyncOverlayProps) {
    const { t } = useI18n();

    if (!syncStatus?.isSyncing) return null;

    const progress = syncStatus.progress || 0;
    const statusMessage = translateSyncMessage(syncStatus.message, t);
    const instances = syncStatus.instances?.length && syncStatus.instances.length > 1
        ? syncStatus.instances
        : null;
    const finishedInstances = instances?.filter((instance) => Boolean(instance.completedAt)).length || 0;

    return createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className={`bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8 ${instances ? 'max-w-lg' : 'max-w-md'} w-full mx-4 text-center`}>
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
                <div className="flex justify-between items-start gap-3 text-sm" aria-live="polite">
                    <span className="min-w-0 flex-1 text-left text-gray-500 dark:text-gray-400 flex items-start gap-2">
                        <RefreshCw className="w-4 h-4 mt-0.5 shrink-0 animate-spin" />
                        {statusMessage}
                    </span>
                    <span className="shrink-0 font-semibold text-blue-600 dark:text-blue-400">
                        {progress}%
                    </span>
                </div>

                {instances && (
                    <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4 text-left">
                        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                            {t('components.syncOverlay.instancesProgress', {
                                completed: finishedInstances,
                                total: instances.length,
                            })}
                        </p>
                        <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                            {instances.map((instance) => {
                                const failed = instance.state === 'failed';
                                const complete = instance.state === 'complete' && instance.progress === 100;
                                return (
                                    <div key={instance.instance_id} className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
                                        <div className="flex items-center gap-2 text-sm">
                                            <span aria-hidden="true">{instance.icon || '▪'}</span>
                                            <span className="min-w-0 flex-1 truncate font-medium text-gray-800 dark:text-gray-100">
                                                {instance.instance_name}
                                            </span>
                                            {failed ? (
                                                <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                                            ) : complete ? (
                                                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                                            ) : instance.isSyncing ? (
                                                <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
                                            ) : null}
                                            <span className="w-10 shrink-0 text-right text-xs font-semibold text-gray-600 dark:text-gray-300">
                                                {instance.progress}%
                                            </span>
                                        </div>
                                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                                            <div
                                                className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-red-500' : complete ? 'bg-emerald-500' : 'bg-blue-500'}`}
                                                style={{ width: `${instance.progress}%` }}
                                            />
                                        </div>
                                        <p className={`mt-1.5 truncate text-xs ${failed ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                                            {instanceStatusMessage(instance, t)}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
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
