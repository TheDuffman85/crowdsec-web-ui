import { useState, type FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { addDecision } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { AddDecisionRequest, ApiPermissionError, InstanceOperationResult, MultiInstanceOperationResponse } from '../types';
import { Modal } from './ui/Modal';

interface AddDecisionModalProps {
    initialDecision: AddDecisionRequest;
    multipleInstances: boolean;
    currentInstanceId?: string;
    currentInstanceName?: string;
    defaultAllInstances: boolean;
    onClose: () => void;
    onDecisionAdded: () => Promise<void>;
}

interface ErrorInfo {
    message: string;
    helpLink?: string;
    helpText?: string;
}

export function AddDecisionModal({
    initialDecision,
    multipleInstances,
    currentInstanceId,
    currentInstanceName,
    defaultAllInstances,
    onClose,
    onDecisionAdded,
}: AddDecisionModalProps) {
    const { t } = useI18n();
    const [decision, setDecision] = useState<AddDecisionRequest>(() => ({ ...initialDecision }));
    const [allInstances, setAllInstances] = useState(defaultAllInstances || !currentInstanceId);
    const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
    const [inProgress, setInProgress] = useState(false);
    const [retryInstances, setRetryInstances] = useState<InstanceOperationResult[]>([]);

    const close = () => {
        if (!inProgress) onClose();
    };

    const updateDecision = (change: Partial<AddDecisionRequest>) => {
        setDecision((current) => ({ ...current, ...change }));
        setRetryInstances([]);
        setErrorInfo(null);
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const request: AddDecisionRequest = !multipleInstances
            ? { ...decision }
            : allInstances
                ? { ...decision, scope: 'all' }
                : { ...decision, scope: 'instance', instance_id: currentInstanceId };
        setInProgress(true);
        setErrorInfo(null);
        try {
            const response = retryInstances.length > 0
                ? {
                    results: await Promise.all(retryInstances.map(async (failedInstance): Promise<InstanceOperationResult> => {
                        try {
                            const retryResponse = await addDecision({
                                ...decision,
                                scope: 'instance',
                                instance_id: failedInstance.instance_id,
                            }) as MultiInstanceOperationResponse;
                            return retryResponse?.results?.[0] || { ...failedInstance, success: true, error: undefined };
                        } catch (error) {
                            return {
                                ...failedInstance,
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                    })),
                }
                : await addDecision(request) as MultiInstanceOperationResponse | undefined;

            if (response && Array.isArray(response.results)) {
                const failedInstances = response.results.filter((result) => !result.success);
                if (failedInstances.length > 0) {
                    const succeededNames = response.results.filter((result) => result.success).map((result) => result.instance_name);
                    const failedNames = failedInstances.map((result) => result.instance_name);
                    setRetryInstances(failedInstances);
                    setErrorInfo({
                        message: `${succeededNames.length > 0 ? `Succeeded: ${succeededNames.join(', ')}. ` : ''}Failed: ${failedNames.join(', ')}.`,
                    });
                    await onDecisionAdded();
                    return;
                }
            }

            await onDecisionAdded();
            onClose();
        } catch (error) {
            console.error('Failed to add decision', error);
            const apiError = error as Partial<ApiPermissionError> | undefined;
            setErrorInfo({
                message: typeof apiError?.message === 'string' ? apiError.message : t('pages.decisions.addFailed'),
                helpLink: typeof apiError?.helpLink === 'string' ? apiError.helpLink : undefined,
                helpText: typeof apiError?.helpText === 'string' ? apiError.helpText : undefined,
            });
        } finally {
            setInProgress(false);
        }
    };

    return (
        <Modal isOpen onClose={close} title={t('pages.decisions.addManualDecision')} maxWidth="max-w-md">
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label htmlFor="add-decision-ip" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('tableColumns.source')}</label>
                    <input
                        id="add-decision-ip"
                        type="text"
                        required
                        disabled={inProgress}
                        className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        placeholder="1.2.3.4"
                        value={decision.ip}
                        onChange={(event) => updateDecision({ ip: event.target.value })}
                    />
                </div>
                <div>
                    <label htmlFor="add-decision-duration" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('pages.decisions.duration')}</label>
                    <input
                        id="add-decision-duration"
                        type="text"
                        disabled={inProgress}
                        className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        placeholder="4h"
                        value={decision.duration}
                        onChange={(event) => updateDecision({ duration: event.target.value })}
                    />
                    <p className="text-xs text-gray-500 mt-1">{t('pages.decisions.durationHint')}</p>
                </div>
                <div>
                    <label htmlFor="add-decision-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('pages.decisions.reason')}</label>
                    <input
                        id="add-decision-reason"
                        type="text"
                        disabled={inProgress}
                        className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        placeholder={t('pages.decisions.placeholderReason')}
                        value={decision.reason}
                        onChange={(event) => updateDecision({ reason: event.target.value })}
                    />
                </div>
                {multipleInstances && (
                    <div className="space-y-1">
                        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                            <input
                                type="checkbox"
                                checked={allInstances}
                                disabled={inProgress || !currentInstanceId}
                                onChange={(event) => {
                                    setAllInstances(event.target.checked);
                                    setRetryInstances([]);
                                    setErrorInfo(null);
                                }}
                            />
                            {t('pages.decisions.allInstances')}
                        </label>
                        {currentInstanceId && !allInstances && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t('pages.decisions.currentInstance', { name: currentInstanceName || currentInstanceId })}
                            </p>
                        )}
                    </div>
                )}
                {errorInfo && (
                    <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 flex items-center gap-2 text-red-700 dark:text-red-300">
                        <AlertCircle size={16} className="flex-shrink-0" />
                        <span className="text-sm">
                            {errorInfo.message}
                            {errorInfo.helpLink && (
                                <>
                                    {' '}{t('common.seeReadme')}{' '}
                                    <a href={errorInfo.helpLink} target="_blank" rel="noopener noreferrer" className="underline hover:text-red-900 dark:hover:text-red-100">
                                        {errorInfo.helpText || t('common.learnMore')}
                                    </a>
                                </>
                            )}
                        </span>
                    </div>
                )}
                <div className="flex justify-end gap-3 mt-6">
                    <button type="button" onClick={close} disabled={inProgress} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50">
                        {t('common.cancel')}
                    </button>
                    <button type="submit" disabled={inProgress} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50">
                        {inProgress ? t('pages.decisions.adding') : retryInstances.length > 0 ? 'Retry failed instances' : t('pages.decisions.addDecision')}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
