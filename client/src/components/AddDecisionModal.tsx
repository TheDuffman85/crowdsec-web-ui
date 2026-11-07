import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { DEFAULT_MANUAL_DECISION_SCENARIO } from '../../../shared/contracts';
import { addDecision, addDecisions, checkAllowlist } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type {
    AddDecisionRequest,
    AllowlistCheckResponse,
    AllowlistedDecisionError,
    AllowlistMatch,
    ApiPermissionError,
    BulkAddDecisionRequest,
    BulkAddDecisionResponse,
    InstanceOperationResult,
    InstanceSummary,
    MultiInstanceOperationResponse,
} from '../types';
import { Modal } from './ui/Modal';

interface AddDecisionModalProps {
    /** In bulk mode (`values` set), `ip` is ignored. */
    initialDecision: AddDecisionRequest;
    /** Adds the same decision for each of these values instead of the single `ip`. */
    values?: string[];
    instances: InstanceSummary[];
    multipleInstances: boolean;
    currentInstanceId?: string;
    currentInstanceName?: string;
    defaultAllInstances: boolean;
    onClose: () => void;
    /** Receives the values that were added. */
    onDecisionAdded: (values: string[]) => Promise<void>;
}

const DECISION_TYPES: Array<{ value: NonNullable<AddDecisionRequest['type']>; labelKey: string }> = [
    { value: 'ban', labelKey: 'pages.decisions.typeBan' },
    { value: 'captcha', labelKey: 'pages.decisions.typeCaptcha' },
];

const scenarioListKey = (scenarios: string[]) => [...scenarios].sort().join('\n');
const ALLOWLIST_CHECK_DELAY_MS = 400;

interface AllowlistCheckState {
    value: string;
    scope: string;
    matches: AllowlistMatch[];
}

function allowlistMatchesFrom(response: AllowlistCheckResponse | undefined): AllowlistMatch[] {
    if (!Array.isArray(response?.results)) return [];
    return response.results
        .filter((result) => result.allowlisted)
        .map(({ instance_id, instance_name, reason }) => ({ instance_id, instance_name, reason }));
}

function isAllowlistedDecisionError(error: unknown): error is AllowlistedDecisionError {
    return (error as Partial<AllowlistedDecisionError> | null)?.code === 'ALLOWLISTED'
        && Array.isArray((error as Partial<AllowlistedDecisionError>).allowlisted);
}

interface ErrorInfo {
    message: string;
    helpLink?: string;
    helpText?: string;
}

export function AddDecisionModal({
    initialDecision,
    values,
    instances,
    multipleInstances,
    currentInstanceId,
    currentInstanceName,
    defaultAllInstances,
    onClose,
    onDecisionAdded,
}: AddDecisionModalProps) {
    const { t } = useI18n();
    const [decision, setDecision] = useState<AddDecisionRequest>(() => ({ type: 'ban', ...initialDecision }));
    const [allInstances, setAllInstances] = useState(defaultAllInstances || !currentInstanceId);
    const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
    const [inProgress, setInProgress] = useState(false);
    const [retryInstances, setRetryInstances] = useState<InstanceOperationResult[]>([]);
    const [allowlistCheck, setAllowlistCheck] = useState<AllowlistCheckState | null>(null);
    const [bypassAllowlist, setBypassAllowlist] = useState(false);
    const bulk = values !== undefined;
    /** Bulk mode: values the next submission sends. */
    const [bulkValues, setBulkValues] = useState<string[]>(() => values ?? []);
    /** Bulk mode: values the server skipped as allowlisted. */
    const [bulkAllowlisted, setBulkAllowlisted] = useState<BulkAddDecisionResponse['allowlisted']>([]);
    const [bulkAddedCount, setBulkAddedCount] = useState(0);

    const targetInstances = !multipleInstances || allInstances
        ? instances
        : instances.filter((instance) => instance.id === currentInstanceId);
    const targetScenarioLists = targetInstances.map((instance) => (
        instance.manual_decision_scenarios?.length ? instance.manual_decision_scenarios : [DEFAULT_MANUAL_DECISION_SCENARIO]
    ));
    // Instances with different lists fall back to the default scenario that every instance offers.
    const scenarioOptions = targetScenarioLists.length > 0
        && targetScenarioLists.every((list) => scenarioListKey(list) === scenarioListKey(targetScenarioLists[0]))
        ? targetScenarioLists[0]
        : [DEFAULT_MANUAL_DECISION_SCENARIO];
    const selectedScenario = decision.scenario && scenarioOptions.includes(decision.scenario)
        ? decision.scenario
        : scenarioOptions[0];
    const decisionValue = (decision.ip || '').trim();
    const allowlistScope = multipleInstances && !allInstances && currentInstanceId ? currentInstanceId : 'all';
    // A result only applies to the value and instances it was checked for.
    const allowlistMatches = allowlistCheck?.value === decisionValue && allowlistCheck.scope === allowlistScope
        ? allowlistCheck.matches
        : [];
    const blockedByAllowlist = bulk
        ? retryInstances.length === 0 && bulkAllowlisted.length > 0 && !bypassAllowlist
        : allowlistMatches.length > 0 && !bypassAllowlist;

    // Warn before submitting; the server repeats the check and refuses without a bypass.
    useEffect(() => {
        if (!decisionValue) return;
        let cancelled = false;
        const timeoutId = window.setTimeout(async () => {
            try {
                const response = await checkAllowlist(decisionValue, allowlistScope);
                if (!cancelled) {
                    setAllowlistCheck({ value: decisionValue, scope: allowlistScope, matches: allowlistMatchesFrom(response) });
                }
            } catch {
                // Invalid or unreachable values are reported by the submission itself.
            }
        }, ALLOWLIST_CHECK_DELAY_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [allowlistScope, decisionValue]);

    const close = () => {
        if (!inProgress) onClose();
    };

    const updateDecision = (change: Partial<AddDecisionRequest>) => {
        setDecision((current) => ({ ...current, ...change }));
        setRetryInstances([]);
        setErrorInfo(null);
        if ('ip' in change) setBypassAllowlist(false);
    };

    const reportError = (error: unknown) => {
        console.error('Failed to add decision', error);
        const apiError = error as Partial<ApiPermissionError> | undefined;
        setErrorInfo({
            message: typeof apiError?.message === 'string' ? apiError.message : t('pages.decisions.addFailed'),
            helpLink: typeof apiError?.helpLink === 'string' ? apiError.helpLink : undefined,
            helpText: typeof apiError?.helpText === 'string' ? apiError.helpText : undefined,
        });
    };

    const failureMessage = (results: InstanceOperationResult[]) => {
        const succeededNames = results.filter((result) => result.success).map((result) => result.instance_name);
        const failedNames = results.filter((result) => !result.success).map((result) => result.instance_name);
        return `${succeededNames.length > 0 ? `Succeeded: ${succeededNames.join(', ')}. ` : ''}Failed: ${failedNames.join(', ')}.`;
    };

    const submitBulk = async (settings: Omit<AddDecisionRequest, 'ip'>) => {
        const base: BulkAddDecisionRequest = { ...settings, values: bulkValues };
        const retrying = retryInstances.length > 0;
        setInProgress(true);
        setErrorInfo(null);
        try {
            let response: BulkAddDecisionResponse;
            if (retrying) {
                const results = await Promise.all(retryInstances.map(async (failedInstance): Promise<InstanceOperationResult> => {
                    try {
                        const retryResponse = await addDecisions({ ...base, scope: 'instance', instance_id: failedInstance.instance_id });
                        return retryResponse.results[0] || { ...failedInstance, success: true, error: undefined };
                    } catch (error) {
                        return { ...failedInstance, success: false, error: error instanceof Error ? error.message : String(error) };
                    }
                }));
                const succeeded = results.filter((result) => result.success).length;
                response = { added: bulkValues, allowlisted: [], results, succeeded, failed: results.length - succeeded };
            } else {
                response = await addDecisions(!multipleInstances
                    ? base
                    : allInstances
                        ? { ...base, scope: 'all' }
                        : { ...base, scope: 'instance', instance_id: currentInstanceId });
            }
            if (response.added.length > 0 && response.results.some((result) => result.success)) {
                setBulkAddedCount((count) => count + response.added.length);
                await onDecisionAdded(response.added);
            }
            if (response.results.some((result) => !result.success)) {
                // Failed instances are retried with the values that were sent; skipped values follow afterwards.
                setRetryInstances(response.results.filter((result) => !result.success));
                setBulkValues(response.added);
                if (!retrying) setBulkAllowlisted(response.allowlisted);
                setErrorInfo({ message: failureMessage(response.results) });
                return;
            }
            setRetryInstances([]);
            const remaining = retrying ? bulkAllowlisted : response.allowlisted;
            if (remaining.length > 0) {
                setBulkAllowlisted(remaining);
                setBulkValues(remaining.map((entry) => entry.value));
                setBypassAllowlist(false);
                return;
            }
            onClose();
        } catch (error) {
            reportError(error);
        } finally {
            setInProgress(false);
        }
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const payload: AddDecisionRequest = {
            ...decision,
            scenario: selectedScenario,
            ...(bypassAllowlist ? { bypass_allowlist: true } : {}),
        };
        if (bulk) {
            const { ip: _ip, ...settings } = payload;
            await submitBulk(settings);
            return;
        }
        const request: AddDecisionRequest = !multipleInstances
            ? payload
            : allInstances
                ? { ...payload, scope: 'all' }
                : { ...payload, scope: 'instance', instance_id: currentInstanceId };
        setInProgress(true);
        setErrorInfo(null);
        try {
            const response = retryInstances.length > 0
                ? {
                    results: await Promise.all(retryInstances.map(async (failedInstance): Promise<InstanceOperationResult> => {
                        try {
                            const retryResponse = await addDecision({
                                ...payload,
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
                    setRetryInstances(failedInstances);
                    setErrorInfo({ message: failureMessage(response.results) });
                    await onDecisionAdded([decisionValue]);
                    return;
                }
            }

            await onDecisionAdded([decisionValue]);
            onClose();
        } catch (error) {
            if (isAllowlistedDecisionError(error)) {
                setAllowlistCheck({ value: decisionValue, scope: allowlistScope, matches: error.allowlisted });
                return;
            }
            reportError(error);
        } finally {
            setInProgress(false);
        }
    };

    return (
        <Modal isOpen onClose={close} title={t(bulk ? 'pages.decisions.addManualDecisions' : 'pages.decisions.addManualDecision')} maxWidth="max-w-md">
            <form onSubmit={submit} className="space-y-4">
                {bulk ? (
                    <div>
                        <p className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('pages.decisions.bulkValues', { count: bulkValues.length })}</p>
                        <ul className="max-h-32 overflow-y-auto rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900/40 dark:text-gray-100">
                            {bulkValues.map((value) => <li key={value} className="break-all">{value}</li>)}
                        </ul>
                        {bulkAddedCount > 0 && (
                            <p role="status" className="mt-1 text-xs text-green-700 dark:text-green-400">{t('pages.decisions.bulkAdded', { count: bulkAddedCount })}</p>
                        )}
                    </div>
                ) : (
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
                )}
                <div>
                    <label htmlFor="add-decision-type" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('tableColumns.type')}</label>
                    <select
                        id="add-decision-type"
                        disabled={inProgress}
                        className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        value={decision.type}
                        onChange={(event) => updateDecision({ type: event.target.value as AddDecisionRequest['type'] })}
                    >
                        {DECISION_TYPES.map((option) => (
                            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                        ))}
                    </select>
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
                {scenarioOptions.length > 1 && (
                    <div>
                        <label htmlFor="add-decision-scenario" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('tableColumns.scenario')}</label>
                        <select
                            id="add-decision-scenario"
                            disabled={inProgress}
                            className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm disabled:cursor-not-allowed disabled:opacity-60"
                            value={selectedScenario}
                            onChange={(event) => updateDecision({ scenario: event.target.value })}
                        >
                            {scenarioOptions.map((scenario) => (
                                <option key={scenario} value={scenario}>{scenario}</option>
                            ))}
                        </select>
                    </div>
                )}
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
                                    setBypassAllowlist(false);
                                    // Skipped values are checked again for the new instances.
                                    setBulkAllowlisted([]);
                                }}
                            />
                            {t('pages.decisions.allInstances')}
                        </label>
                        {currentInstanceId && !allInstances && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t('pages.decisions.currentInstance', { name: currentInstanceName || currentInstanceId })}
                            </p>
                        )}
                        {allInstances && targetInstances.length > 0 && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t('pages.decisions.targetInstances', { names: targetInstances.map((instance) => instance.name).join(', ') })}
                            </p>
                        )}
                    </div>
                )}
                {bulk && retryInstances.length === 0 && bulkAllowlisted.length > 0 && (
                    <div role="alert" className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                        <ShieldCheck size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <div className="min-w-0 space-y-2 text-sm">
                            <p className="font-medium">{t('pages.decisions.bulkAllowlistedTitle', { count: bulkAllowlisted.length })}</p>
                            <ul className="max-h-32 list-disc space-y-1 overflow-y-auto pl-4 text-xs break-words">
                                {bulkAllowlisted.map((entry) => (
                                    <li key={entry.value}>
                                        <span className="font-mono">{entry.value}</span>
                                        {': '}
                                        {entry.allowlisted.map((match) => (multipleInstances
                                            ? t('pages.decisions.allowlistedOn', { instance: match.instance_name, reason: match.reason || t('pages.decisions.allowlistedNoReason') })
                                            : match.reason || t('pages.decisions.allowlistedNoReason'))).join('; ')}
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs">{t('pages.decisions.bulkAllowlistedHint')}</p>
                            <label className="flex items-center gap-2 font-medium">
                                <input
                                    type="checkbox"
                                    checked={bypassAllowlist}
                                    disabled={inProgress}
                                    onChange={(event) => setBypassAllowlist(event.target.checked)}
                                />
                                {t('pages.decisions.bypassAllowlist')}
                            </label>
                        </div>
                    </div>
                )}
                {allowlistMatches.length > 0 && (
                    <div role="alert" className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                        <ShieldCheck size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <div className="min-w-0 space-y-2 text-sm">
                            <p className="font-medium">{t('pages.decisions.allowlistedTitle', { value: decisionValue })}</p>
                            <ul className="list-disc space-y-1 pl-4 text-xs break-words">
                                {allowlistMatches.map((match) => (
                                    <li key={match.instance_id}>
                                        {multipleInstances
                                            ? t('pages.decisions.allowlistedOn', { instance: match.instance_name, reason: match.reason || t('pages.decisions.allowlistedNoReason') })
                                            : match.reason || t('pages.decisions.allowlistedNoReason')}
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs">{t('pages.decisions.allowlistedHint')}</p>
                            <label className="flex items-center gap-2 font-medium">
                                <input
                                    type="checkbox"
                                    checked={bypassAllowlist}
                                    disabled={inProgress}
                                    onChange={(event) => setBypassAllowlist(event.target.checked)}
                                />
                                {t('pages.decisions.bypassAllowlist')}
                            </label>
                        </div>
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
                    <button type="submit" disabled={inProgress || blockedByAllowlist} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50">
                        {inProgress ? t('pages.decisions.adding') : retryInstances.length > 0 ? 'Retry failed instances' : bulk ? t('pages.decisions.addDecisionsCount', { count: bulkValues.length }) : t('pages.decisions.addDecision')}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
