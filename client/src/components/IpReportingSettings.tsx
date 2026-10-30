import { useEffect, useRef, useState } from "react";
import { History, Play, Plus, RotateCcw, SquarePen, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { Modal } from "./ui/Modal";
import { Badge } from "./ui/Badge";
import { Switch } from "./ui/Switch";
import { deleteIpReporter, fetchIpReporters, fetchIpReportRuns, previewIpReports, runIpReporter, saveIpReporter } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/dateTime";
import {
    ABUSEIPDB_CATEGORIES,
    DEFAULT_IP_REPORT_CATEGORY_RULES,
    IP_REPORT_COMMENT_VARIABLES,
    defaultIpReporterConfig,
} from "../../../shared/ip-reporting";
import type { IpReporter, IpReportPreview, IpReportRun, IpReportRunStatus, IpReportSubmitMode, UpsertIpReporterRequest } from "../types";

interface IpReportingSettingsProps {
    instances: Array<{ id: string; name: string }>;
    inputClass: string;
    labelClass: string;
    showToast: (message: string, type?: 'success' | 'danger' | 'info') => void;
}

interface ReporterForm {
    name: string;
    enabled: boolean;
    apiKey: string;
    submitMode: IpReportSubmitMode;
    intervalMinutes: number;
    cooldownHours: string;
    maxReportsPerRun: string;
    minAlerts: string;
    includeSimulated: boolean;
    instanceIds: string[];
    includeScenarios: string;
    excludeScenarios: string;
    categoryRules: Array<{ pattern: string; categories: string }>;
    defaultCategories: string;
    commentTemplate: string;
}

const INTERVAL_PRESETS = [15, 30, 60, 120, 240, 360, 720, 1440];
const STATUS_VARIANTS: Record<IpReportRunStatus, 'success' | 'warning' | 'danger' | 'secondary'> = {
    success: 'success',
    partial: 'warning',
    failed: 'danger',
    empty: 'secondary',
};

const primaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800";
const iconButtonClass = "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800";
const dangerButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60";

const splitPatterns = (value: string) => value.split('\n').map((entry) => entry.trim()).filter(Boolean);
const parseCategories = (value: string) => value
    .split(/[\s,]+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 23);

function toForm(reporter: IpReporter | null): ReporterForm {
    const config = reporter?.config ?? defaultIpReporterConfig();
    return {
        name: reporter?.name ?? 'AbuseIPDB',
        enabled: reporter?.enabled ?? true,
        apiKey: config.apiKey,
        submitMode: config.submitMode,
        intervalMinutes: config.intervalMinutes,
        cooldownHours: String(config.cooldownHours),
        maxReportsPerRun: String(config.maxReportsPerRun),
        minAlerts: String(config.minAlerts),
        includeSimulated: config.includeSimulated,
        instanceIds: config.instanceIds,
        includeScenarios: config.includeScenarios.join('\n'),
        excludeScenarios: config.excludeScenarios.join('\n'),
        categoryRules: config.categoryRules.map((rule) => ({ pattern: rule.pattern, categories: rule.categories.join(', ') })),
        defaultCategories: config.defaultCategories.join(', '),
        commentTemplate: config.commentTemplate,
    };
}

function fromForm(form: ReporterForm): UpsertIpReporterRequest {
    return {
        name: form.name,
        provider: 'abuseipdb',
        enabled: form.enabled,
        config: {
            apiKey: form.apiKey,
            submitMode: form.submitMode,
            intervalMinutes: form.intervalMinutes,
            cooldownHours: Number(form.cooldownHours),
            maxReportsPerRun: Number(form.maxReportsPerRun),
            minAlerts: Number(form.minAlerts),
            includeSimulated: form.includeSimulated,
            instanceIds: form.instanceIds,
            includeScenarios: splitPatterns(form.includeScenarios),
            excludeScenarios: splitPatterns(form.excludeScenarios),
            categoryRules: form.categoryRules.map((rule) => ({ pattern: rule.pattern.trim(), categories: parseCategories(rule.categories) })),
            defaultCategories: parseCategories(form.defaultCategories),
            commentTemplate: form.commentTemplate,
        },
    };
}

export function IpReportingSettings({ instances, inputClass, labelClass, showToast }: IpReportingSettingsProps) {
    const { t } = useI18n();
    const { formatDateTime } = useDateTime();
    const [reporters, setReporters] = useState<IpReporter[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [editing, setEditing] = useState<{ reporter: IpReporter | null; form: ReporterForm } | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [preview, setPreview] = useState<IpReportPreview | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [runningId, setRunningId] = useState<string | null>(null);
    const [history, setHistory] = useState<{ reporter: IpReporter; runs: IpReportRun[] | null } | null>(null);
    const [deleting, setDeleting] = useState<IpReporter | null>(null);

    const showToastRef = useRef(showToast);
    useEffect(() => {
        showToastRef.current = showToast;
    });

    useEffect(() => {
        let cancelled = false;
        void fetchIpReporters()
            .then((items) => {
                if (!cancelled) setReporters(items);
            })
            .catch((error) => {
                console.error("Failed to load IP reporters", error);
                if (!cancelled) showToastRef.current(t("pages.settings.ipReports.loadFailed"), "danger");
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [t]);

    const replaceReporter = (reporter: IpReporter) => {
        setReporters((current) => current.some((item) => item.id === reporter.id)
            ? current.map((item) => item.id === reporter.id ? reporter : item)
            : [reporter, ...current]);
    };

    const updateForm = (patch: Partial<ReporterForm>) => {
        setEditing((current) => current ? { ...current, form: { ...current.form, ...patch } } : current);
    };

    const openEditor = (reporter: IpReporter | null) => {
        setPreview(null);
        setEditing({ reporter, form: toForm(reporter) });
    };

    const save = async () => {
        if (!editing) return;
        setIsSaving(true);
        try {
            replaceReporter(await saveIpReporter(editing.reporter?.id ?? null, fromForm(editing.form)));
            setEditing(null);
            showToast(t("pages.settings.ipReports.saved"), "success");
        } catch (error) {
            showToast(error instanceof Error ? error.message : t("pages.settings.ipReports.saveFailed"), "danger");
        } finally {
            setIsSaving(false);
        }
    };

    const runPreview = async () => {
        if (!editing) return;
        setIsPreviewing(true);
        try {
            setPreview(await previewIpReports({ ...fromForm(editing.form), id: editing.reporter?.id }));
        } catch (error) {
            setPreview(null);
            showToast(error instanceof Error ? error.message : t("pages.settings.ipReports.previewFailed"), "danger");
        } finally {
            setIsPreviewing(false);
        }
    };

    const runNow = async (reporter: IpReporter) => {
        setRunningId(reporter.id);
        try {
            const run = await runIpReporter(reporter.id);
            replaceReporter({ ...reporter, last_run: run, last_attempt_at: run.started_at });
            if (run.status === 'failed') {
                showToast(run.error || t("pages.settings.ipReports.runFailed"), "danger");
            } else {
                showToast(t("pages.settings.ipReports.runResult", { saved: run.saved, rejected: run.rejected.length }), run.status === 'partial' ? 'info' : 'success');
            }
            setReporters(await fetchIpReporters());
        } catch (error) {
            showToast(error instanceof Error ? error.message : t("pages.settings.ipReports.runFailed"), "danger");
        } finally {
            setRunningId(null);
        }
    };

    const openHistory = async (reporter: IpReporter) => {
        setHistory({ reporter, runs: null });
        try {
            const runs = await fetchIpReportRuns(reporter.id);
            setHistory((current) => current?.reporter.id === reporter.id ? { reporter, runs } : current);
        } catch (error) {
            setHistory(null);
            showToast(error instanceof Error ? error.message : t("pages.settings.ipReports.loadFailed"), "danger");
        }
    };

    const confirmDelete = async () => {
        if (!deleting) return;
        try {
            await deleteIpReporter(deleting.id);
            setReporters((current) => current.filter((item) => item.id !== deleting.id));
            showToast(t("pages.settings.ipReports.deleted"), "success");
        } catch (error) {
            showToast(error instanceof Error ? error.message : t("pages.settings.ipReports.deleteFailed"), "danger");
        } finally {
            setDeleting(null);
        }
    };

    const formatInterval = (minutes: number) => minutes % 60 === 0
        ? t("pages.settings.ipReports.hours", { count: minutes / 60 })
        : t("pages.settings.ipReports.minutes", { count: minutes });

    const runSummary = (run: IpReportRun) => (
        <span className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANTS[run.status]}>{t(`pages.settings.ipReports.status.${run.status}`)}</Badge>
            <span>{t("pages.settings.ipReports.runResult", { saved: run.saved, rejected: run.rejected.length })}</span>
            <span className="text-gray-400 dark:text-gray-500">·</span>
            <span>{formatDateTime(run.started_at)}</span>
        </span>
    );

    const form = editing?.form;
    const intervalOptions = form && !INTERVAL_PRESETS.includes(form.intervalMinutes)
        ? [...INTERVAL_PRESETS, form.intervalMinutes].sort((left, right) => left - right)
        : INTERVAL_PRESETS;

    return (
        <Card>
            <CardHeader className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <CardTitle>{t("pages.settings.ipReports.title")}</CardTitle>
                    <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.ipReports.description")}</p>
                </div>
                <button type="button" onClick={() => openEditor(null)} className={primaryButtonClass}>
                    <Plus className="h-4 w-4" />
                    {t("pages.settings.ipReports.add")}
                </button>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.ipReports.sourceNote")}</p>
                {!isLoading && reporters.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.ipReports.empty")}</p>
                )}
                {reporters.map((reporter) => (
                    <div
                        key={reporter.id}
                        data-testid={`ip-reporter-${reporter.id}`}
                        className={`flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50 sm:flex-row sm:items-center ${reporter.enabled ? '' : 'opacity-70'}`}
                    >
                        <div className="min-w-0 flex-1 space-y-1 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-gray-900 dark:text-gray-100">{reporter.name}</span>
                                <Badge variant="outline">{t(`pages.settings.ipReports.modes.${reporter.config.submitMode}`)}</Badge>
                                {!reporter.enabled && <Badge variant="secondary">{t("common.disabled")}</Badge>}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t("pages.settings.ipReports.every", { interval: formatInterval(reporter.config.intervalMinutes) })}
                                {reporter.enabled && (
                                    <>
                                        {' · '}
                                        {reporter.next_run_at
                                            ? t("pages.settings.ipReports.nextRun", { time: formatDateTime(reporter.next_run_at) })
                                            : t("pages.settings.ipReports.nextRunSoon")}
                                    </>
                                )}
                            </p>
                            {reporter.last_run && (
                                <div className="text-xs text-gray-600 dark:text-gray-300">{runSummary(reporter.last_run)}</div>
                            )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <button type="button" onClick={() => void runNow(reporter)} disabled={runningId !== null} className={secondaryButtonClass}>
                                <Play className="h-4 w-4" />
                                {runningId === reporter.id ? t("pages.settings.ipReports.running") : t("pages.settings.ipReports.runNow")}
                            </button>
                            <button type="button" onClick={() => void openHistory(reporter)} className={iconButtonClass} aria-label={t("pages.settings.ipReports.history")} title={t("pages.settings.ipReports.history")}>
                                <History className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={() => openEditor(reporter)} className={iconButtonClass} aria-label={t("pages.settings.ipReports.edit")} title={t("pages.settings.ipReports.edit")}>
                                <SquarePen className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={() => setDeleting(reporter)} className={iconButtonClass} aria-label={t("common.delete")} title={t("common.delete")}>
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ))}
            </CardContent>

            <Modal
                isOpen={editing !== null}
                onClose={() => !isSaving && setEditing(null)}
                title={editing?.reporter ? t("pages.settings.ipReports.editTitle") : t("pages.settings.ipReports.newTitle")}
                maxWidth="max-w-3xl"
            >
                {form && (
                    <form
                        className="space-y-5"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                        }}
                    >
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-name" className={labelClass}>{t("common.name")}</label>
                                <input id="ip-reporter-name" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} className={inputClass} autoComplete="off" />
                            </div>
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-api-key" className={labelClass}>{t("pages.settings.ipReports.apiKey")}</label>
                                <input
                                    id="ip-reporter-api-key"
                                    type="password"
                                    value={form.apiKey === '(stored)' ? '' : form.apiKey}
                                    placeholder={form.apiKey === '(stored)' ? t("pages.notifications.unchanged") : undefined}
                                    onChange={(event) => updateForm({ apiKey: event.target.value || (editing?.reporter?.configured_secrets.includes('apiKey') ? '(stored)' : '') })}
                                    className={inputClass}
                                    autoComplete="new-password"
                                />
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    {t("pages.settings.ipReports.apiKeyHelp")}{' '}
                                    <a href="https://www.abuseipdb.com/account/api" target="_blank" rel="noreferrer" className="text-primary-600 hover:underline dark:text-primary-400">abuseipdb.com/account/api</a>
                                </p>
                            </div>
                        </div>

                        <label className="flex items-center gap-3 text-sm font-medium">
                            <Switch id="ip-reporter-enabled" checked={form.enabled} onCheckedChange={(checked) => updateForm({ enabled: checked })} />
                            {t("common.enabled")}
                        </label>

                        <fieldset className="space-y-2">
                            <legend className={labelClass}>{t("pages.settings.ipReports.submitMode")}</legend>
                            <div className="grid gap-3 md:grid-cols-2">
                                {(['bulk', 'single'] as const).map((mode) => (
                                    <label
                                        key={mode}
                                        className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${form.submitMode === mode
                                            ? 'border-primary-500 bg-primary-50 dark:border-primary-400 dark:bg-primary-900/20'
                                            : 'border-gray-200 dark:border-gray-700'}`}
                                    >
                                        <input
                                            type="radio"
                                            name="ip-reporter-mode"
                                            value={mode}
                                            checked={form.submitMode === mode}
                                            onChange={() => updateForm({
                                                submitMode: mode,
                                                maxReportsPerRun: mode === 'single' && Number(form.maxReportsPerRun) > 1000 ? '1000' : form.maxReportsPerRun,
                                            })}
                                            className="mt-1"
                                        />
                                        <span>
                                            <span className="block font-medium">{t(`pages.settings.ipReports.modes.${mode}`)}</span>
                                            <span className="block text-xs text-gray-500 dark:text-gray-400">{t(`pages.settings.ipReports.modes.${mode}Help`)}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-interval" className={labelClass}>{t("pages.settings.ipReports.interval")}</label>
                                <select id="ip-reporter-interval" value={form.intervalMinutes} onChange={(event) => updateForm({ intervalMinutes: Number(event.target.value) })} className={inputClass}>
                                    {intervalOptions.map((minutes) => <option key={minutes} value={minutes}>{formatInterval(minutes)}</option>)}
                                </select>
                            </div>
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-cooldown" className={labelClass}>{t("pages.settings.ipReports.cooldownHours")}</label>
                                <input id="ip-reporter-cooldown" type="number" min={1} max={720} value={form.cooldownHours} onChange={(event) => updateForm({ cooldownHours: event.target.value })} className={inputClass} />
                            </div>
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-max" className={labelClass}>{t("pages.settings.ipReports.maxReportsPerRun")}</label>
                                <input id="ip-reporter-max" type="number" min={1} max={form.submitMode === 'single' ? 1000 : 9999} value={form.maxReportsPerRun} onChange={(event) => updateForm({ maxReportsPerRun: event.target.value })} className={inputClass} />
                            </div>
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-min-alerts" className={labelClass}>{t("pages.settings.ipReports.minAlerts")}</label>
                                <input id="ip-reporter-min-alerts" type="number" min={1} max={1000} value={form.minAlerts} onChange={(event) => updateForm({ minAlerts: event.target.value })} className={inputClass} />
                            </div>
                        </div>

                        {instances.length > 1 && (
                            <fieldset className="space-y-2">
                                <legend className={labelClass}>{t("pages.settings.ipReports.instances")}</legend>
                                <div className="flex flex-wrap gap-3">
                                    {instances.map((instance) => (
                                        <label key={instance.id} className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={form.instanceIds.includes(instance.id)}
                                                onChange={(event) => updateForm({
                                                    instanceIds: event.target.checked
                                                        ? [...form.instanceIds, instance.id]
                                                        : form.instanceIds.filter((id) => id !== instance.id),
                                                })}
                                            />
                                            {instance.name}
                                        </label>
                                    ))}
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.ipReports.instancesHelp")}</p>
                            </fieldset>
                        )}

                        <div className="grid gap-4 md:grid-cols-2">
                            {(['includeScenarios', 'excludeScenarios'] as const).map((field) => (
                                <div key={field} className="space-y-2">
                                    <label htmlFor={`ip-reporter-${field}`} className={labelClass}>{t(`pages.settings.ipReports.${field}`)}</label>
                                    <textarea
                                        id={`ip-reporter-${field}`}
                                        rows={3}
                                        value={form[field]}
                                        onChange={(event) => updateForm({ [field]: event.target.value })}
                                        placeholder={field === 'includeScenarios' ? 'crowdsecurity/*' : 'crowdsecurity/http-crawl-*'}
                                        className={`${inputClass} font-mono`}
                                    />
                                </div>
                            ))}
                            <p className="text-xs text-gray-500 md:col-span-2 dark:text-gray-400">{t("pages.settings.ipReports.scenarioPatternsHelp")}</p>
                        </div>

                        <label className="flex items-center gap-3 text-sm font-medium">
                            <Switch id="ip-reporter-simulated" checked={form.includeSimulated} onCheckedChange={(checked) => updateForm({ includeSimulated: checked })} />
                            {t("pages.settings.ipReports.includeSimulated")}
                        </label>

                        <div className="space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <p className={labelClass}>{t("pages.settings.ipReports.categoryRules")}</p>
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.ipReports.categoryRulesHelp")}</p>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => updateForm({ categoryRules: DEFAULT_IP_REPORT_CATEGORY_RULES.map((rule) => ({ pattern: rule.pattern, categories: rule.categories.join(', ') })) })}
                                        className={secondaryButtonClass}
                                    >
                                        <RotateCcw className="h-4 w-4" />
                                        {t("pages.settings.ipReports.resetRules")}
                                    </button>
                                    <button type="button" onClick={() => updateForm({ categoryRules: [...form.categoryRules, { pattern: '', categories: '' }] })} className={secondaryButtonClass}>
                                        <Plus className="h-4 w-4" />
                                        {t("pages.settings.ipReports.addRule")}
                                    </button>
                                </div>
                            </div>
                            <div className="space-y-2">
                                {form.categoryRules.map((rule, index) => (
                                    <div key={index} className="flex items-center gap-2">
                                        <input
                                            aria-label={t("pages.settings.ipReports.pattern")}
                                            value={rule.pattern}
                                            placeholder="*ssh*"
                                            onChange={(event) => updateForm({ categoryRules: form.categoryRules.map((entry, current) => current === index ? { ...entry, pattern: event.target.value } : entry) })}
                                            className={`${inputClass} font-mono`}
                                        />
                                        <input
                                            aria-label={t("pages.settings.ipReports.categories")}
                                            value={rule.categories}
                                            placeholder="18, 22"
                                            onChange={(event) => updateForm({ categoryRules: form.categoryRules.map((entry, current) => current === index ? { ...entry, categories: event.target.value } : entry) })}
                                            className={`${inputClass} max-w-40 font-mono`}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => updateForm({ categoryRules: form.categoryRules.filter((_, current) => current !== index) })}
                                            className={iconButtonClass}
                                            aria-label={t("common.delete")}
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <div className="space-y-2">
                                <label htmlFor="ip-reporter-default-categories" className={labelClass}>{t("pages.settings.ipReports.defaultCategories")}</label>
                                <input id="ip-reporter-default-categories" value={form.defaultCategories} onChange={(event) => updateForm({ defaultCategories: event.target.value })} className={`${inputClass} max-w-40 font-mono`} />
                            </div>
                            <details className="text-xs text-gray-500 dark:text-gray-400">
                                <summary className="cursor-pointer">{t("pages.settings.ipReports.categoryList")}</summary>
                                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                                    {ABUSEIPDB_CATEGORIES.map((category) => (
                                        <li key={category.id}><span className="font-mono">{category.id}</span> {category.name}</li>
                                    ))}
                                </ul>
                            </details>
                        </div>

                        <div className="space-y-2">
                            <label htmlFor="ip-reporter-comment" className={labelClass}>{t("pages.settings.ipReports.comment")}</label>
                            <textarea id="ip-reporter-comment" rows={2} value={form.commentTemplate} onChange={(event) => updateForm({ commentTemplate: event.target.value })} className={`${inputClass} font-mono`} />
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t("pages.settings.ipReports.commentHelp", { variables: IP_REPORT_COMMENT_VARIABLES.map((name) => `{{${name}}}`).join(' ') })}
                            </p>
                        </div>

                        {preview && (
                            <div className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
                                <p className="font-medium">
                                    {t("pages.settings.ipReports.previewSummary", {
                                        total: preview.total,
                                        start: formatDateTime(preview.window_start),
                                        end: formatDateTime(preview.window_end),
                                    })}
                                </p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    {t("pages.settings.ipReports.previewSkipped", {
                                        cooldown: preview.skipped.cooldown,
                                        allowlisted: preview.skipped.allowlisted,
                                        notPublic: preview.skipped.not_public,
                                        belowThreshold: preview.skipped.below_threshold,
                                        overLimit: preview.skipped.over_limit,
                                    })}
                                </p>
                                {preview.rows.length > 0 && (
                                    <div className="max-h-64 overflow-auto">
                                        <table className="w-full text-left text-xs">
                                            <thead className="text-gray-500 dark:text-gray-400">
                                                <tr>
                                                    <th className="py-1 pr-3 font-medium">IP</th>
                                                    <th className="py-1 pr-3 font-medium">{t("pages.settings.ipReports.categories")}</th>
                                                    <th className="py-1 pr-3 font-medium">{t("pages.settings.ipReports.alerts")}</th>
                                                    <th className="py-1 font-medium">{t("pages.settings.ipReports.comment")}</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                                {preview.rows.map((row) => (
                                                    <tr key={row.ip}>
                                                        <td className="py-1 pr-3 font-mono">{row.ip}</td>
                                                        <td className="py-1 pr-3 font-mono">{row.categories.join(', ')}</td>
                                                        <td className="py-1 pr-3">{row.alerts}</td>
                                                        <td className="py-1 text-gray-600 dark:text-gray-300">{row.comment}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                            <button type="button" onClick={() => void runPreview()} disabled={isPreviewing || isSaving} className={secondaryButtonClass}>
                                {isPreviewing ? t("pages.settings.ipReports.previewing") : t("pages.settings.ipReports.preview")}
                            </button>
                            <div className="flex flex-col-reverse gap-3 sm:flex-row">
                                <button type="button" onClick={() => setEditing(null)} disabled={isSaving} className={secondaryButtonClass}>
                                    {t("common.cancel")}
                                </button>
                                <button type="submit" disabled={isSaving || !form.name.trim()} className={primaryButtonClass}>
                                    {isSaving ? t("common.saving") : t("common.save")}
                                </button>
                            </div>
                        </div>
                    </form>
                )}
            </Modal>

            <Modal
                isOpen={history !== null}
                onClose={() => setHistory(null)}
                title={history ? t("pages.settings.ipReports.historyTitle", { name: history.reporter.name }) : null}
                maxWidth="max-w-2xl"
            >
                {history && (
                    <div className="space-y-2 text-sm">
                        {history.runs?.length === 0 && <p className="text-gray-500 dark:text-gray-400">{t("pages.settings.ipReports.noRuns")}</p>}
                        {history.runs?.map((run) => (
                            <div key={run.id} className="space-y-1 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
                                    {runSummary(run)}
                                    <span className="text-gray-500 dark:text-gray-400">{t(`pages.settings.ipReports.trigger.${run.trigger}`)}</span>
                                </div>
                                {run.error && <p className="text-xs text-red-600 dark:text-red-400">{run.error}</p>}
                                {run.rejected.length > 0 && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        {run.rejected.slice(0, 5).map((entry) => `${entry.ip}: ${entry.error}`).join(' · ')}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Modal>

            <Modal isOpen={deleting !== null} onClose={() => setDeleting(null)} title={t("pages.settings.ipReports.deleteTitle")}>
                <div className="space-y-5">
                    <p className="text-sm text-gray-600 dark:text-gray-300">{t("pages.settings.ipReports.deleteConfirm", { name: deleting?.name ?? '' })}</p>
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button type="button" onClick={() => setDeleting(null)} className={secondaryButtonClass}>{t("common.cancel")}</button>
                        <button type="button" onClick={() => void confirmDelete()} className={dangerButtonClass}>
                            <Trash2 className="h-4 w-4" />
                            {t("common.delete")}
                        </button>
                    </div>
                </div>
            </Modal>
        </Card>
    );
}
