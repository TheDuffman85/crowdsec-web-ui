import { useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { addAllowlistEntries, createAllowlist } from '../lib/api';
import { trustedIpsHelpLink } from '../lib/helpLinks';
import { useI18n } from '../lib/i18n';
import type { AllowlistOperationResponse } from '../types';
import { Modal } from './ui/Modal';

interface OperationError {
    message: string;
    helpLink?: string;
}

const LABEL_CLASS_NAME = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const INPUT_CLASS_NAME = 'block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm';
const CANCEL_CLASS_NAME = 'px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50';
const SUBMIT_CLASS_NAME = 'px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_CLASS_NAME = 'px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50';

function failureOf(response: AllowlistOperationResponse): OperationError | null {
    const failed = response.results.filter((result) => !result.success);
    if (failed.length === 0) return null;
    const named = response.results.length > 1;
    return {
        message: failed.map((result) => (named ? `${result.instance_name}: ${result.error}` : result.error)).join('; '),
        ...(failed.some((result) => result.code === 'UNTRUSTED_IP') ? { helpLink: trustedIpsHelpLink() } : {}),
    };
}

/**
 * Runs one change. `onChanged` is called as soon as any instance accepted it; the promise
 * resolves to true only when every instance did, so a partly failed change keeps its dialog open.
 */
function useAllowlistChange(onChanged: () => void) {
    const { t } = useI18n();
    const [inProgress, setInProgress] = useState(false);
    const [error, setError] = useState<OperationError | null>(null);

    const run = async (change: () => Promise<AllowlistOperationResponse>): Promise<boolean> => {
        setInProgress(true);
        setError(null);
        try {
            const response = await change();
            if (response.succeeded > 0) onChanged();
            const failure = failureOf(response);
            setError(failure);
            return !failure;
        } catch (cause) {
            setError({ message: cause instanceof Error && cause.message ? cause.message : t('pages.allowlists.changeFailed') });
            return false;
        } finally {
            setInProgress(false);
        }
    };

    return { inProgress, error, run };
}

function ChangeError({ error }: { error: OperationError | null }) {
    const { t } = useI18n();
    if (!error) return null;
    return (
        <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span className="min-w-0 break-words text-sm">
                {error.message}
                {error.helpLink && (
                    <>
                        {' '}{t('common.seeReadme')}{' '}
                        <a href={error.helpLink} target="_blank" rel="noopener noreferrer" className="underline hover:text-red-900 dark:hover:text-red-100">
                            {t('common.learnMore')}
                        </a>
                    </>
                )}
            </span>
        </div>
    );
}

export function CreateAllowlistModal({
    instanceScope,
    targetNames,
    onClose,
    onChanged,
}: {
    instanceScope: string;
    /** Instances that will get the allowlist; shown when there is more than one instance. */
    targetNames: string[] | null;
    onClose: () => void;
    onChanged: (name: string) => void;
}) {
    const { t } = useI18n();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const { inProgress, error, run } = useAllowlistChange(() => onChanged(name.trim()));

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const created = await run(() => createAllowlist(instanceScope, {
            name: name.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
        }));
        if (created) onClose();
    };

    return (
        <Modal isOpen onClose={() => { if (!inProgress) onClose(); }} title={t('pages.allowlists.createTitle')}>
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label htmlFor="allowlist-name" className={LABEL_CLASS_NAME}>{t('common.name')}</label>
                    <input
                        id="allowlist-name"
                        type="text"
                        required
                        maxLength={255}
                        disabled={inProgress}
                        className={INPUT_CLASS_NAME}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
                <div>
                    <label htmlFor="allowlist-description" className={LABEL_CLASS_NAME}>{t('pages.allowlists.columns.description')}</label>
                    <input
                        id="allowlist-description"
                        type="text"
                        maxLength={255}
                        disabled={inProgress}
                        className={INPUT_CLASS_NAME}
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </div>
                {targetNames && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t('pages.allowlists.createdOn', { names: targetNames.join(', ') })}
                    </p>
                )}
                <ChangeError error={error} />
                <div className="flex justify-end gap-3 mt-6">
                    <button type="button" onClick={onClose} disabled={inProgress} className={CANCEL_CLASS_NAME}>{t('common.cancel')}</button>
                    <button type="submit" disabled={inProgress || !name.trim()} className={SUBMIT_CLASS_NAME}>
                        {inProgress ? t('pages.allowlists.creating') : t('pages.allowlists.create')}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

export function AddAllowlistEntriesModal({
    name,
    instanceScope,
    onClose,
    onChanged,
}: {
    name: string;
    instanceScope: string;
    onClose: () => void;
    onChanged: () => void;
}) {
    const { t } = useI18n();
    const [values, setValues] = useState('');
    const [description, setDescription] = useState('');
    const [duration, setDuration] = useState('');
    const { inProgress, error, run } = useAllowlistChange(onChanged);
    const parsedValues = [...new Set(values.split(/[\s,;]+/).filter(Boolean))];

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const added = await run(() => addAllowlistEntries(name, instanceScope, {
            values: parsedValues,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(duration.trim() ? { duration: duration.trim() } : {}),
        }));
        if (added) onClose();
    };

    return (
        <Modal isOpen onClose={() => { if (!inProgress) onClose(); }} title={t('pages.allowlists.addEntriesTitle', { name })}>
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label htmlFor="allowlist-entry-values" className={LABEL_CLASS_NAME}>{t('pages.allowlists.checkLabel')}</label>
                    <textarea
                        id="allowlist-entry-values"
                        rows={4}
                        required
                        disabled={inProgress}
                        className={`${INPUT_CLASS_NAME} font-mono`}
                        placeholder={t('pages.allowlists.checkPlaceholder')}
                        value={values}
                        onChange={(event) => setValues(event.target.value)}
                    />
                    <p className="text-xs text-gray-500 mt-1">{t('pages.allowlists.valuesHint')}</p>
                </div>
                <div>
                    <label htmlFor="allowlist-entry-description" className={LABEL_CLASS_NAME}>{t('pages.allowlists.columns.description')}</label>
                    <input
                        id="allowlist-entry-description"
                        type="text"
                        maxLength={255}
                        disabled={inProgress}
                        className={INPUT_CLASS_NAME}
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </div>
                <div>
                    <label htmlFor="allowlist-entry-duration" className={LABEL_CLASS_NAME}>{t('pages.allowlists.expiresAfter')}</label>
                    <input
                        id="allowlist-entry-duration"
                        type="text"
                        pattern="\d+[smhd]"
                        disabled={inProgress}
                        className={INPUT_CLASS_NAME}
                        placeholder={t('pages.allowlists.never')}
                        value={duration}
                        onChange={(event) => setDuration(event.target.value)}
                    />
                    <p className="text-xs text-gray-500 mt-1">{t('pages.allowlists.expiresAfterHint')}</p>
                </div>
                <ChangeError error={error} />
                <div className="flex justify-end gap-3 mt-6">
                    <button type="button" onClick={onClose} disabled={inProgress} className={CANCEL_CLASS_NAME}>{t('common.cancel')}</button>
                    <button type="submit" disabled={inProgress || parsedValues.length === 0} className={SUBMIT_CLASS_NAME}>
                        {inProgress ? t('pages.allowlists.adding') : t('pages.allowlists.addEntries')}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

/** Asks before a change that cannot be undone, such as deleting an allowlist or removing an entry. */
export function ConfirmAllowlistChangeModal({
    title,
    confirmLabel,
    change,
    onClose,
    onChanged,
    children,
}: {
    title: string;
    confirmLabel: string;
    change: () => Promise<AllowlistOperationResponse>;
    onClose: () => void;
    onChanged: () => void;
    children: ReactNode;
}) {
    const { t } = useI18n();
    const { inProgress, error, run } = useAllowlistChange(onChanged);

    const confirm = async () => {
        if (await run(change)) onClose();
    };

    return (
        <Modal isOpen onClose={() => { if (!inProgress) onClose(); }} title={title} maxWidth="max-w-sm" showCloseButton={false}>
            <p className="text-gray-600 dark:text-gray-300 mb-6 break-words">{children} {t('common.actionCannotBeUndone')}</p>
            {error && <div className="mb-6"><ChangeError error={error} /></div>}
            <div className="flex justify-end gap-3">
                <button type="button" onClick={onClose} disabled={inProgress} className={CANCEL_CLASS_NAME}>{t('common.cancel')}</button>
                <button type="button" onClick={() => void confirm()} disabled={inProgress} className={DANGER_CLASS_NAME}>
                    {inProgress ? t('common.deleting') : confirmLabel}
                </button>
            </div>
        </Modal>
    );
}
