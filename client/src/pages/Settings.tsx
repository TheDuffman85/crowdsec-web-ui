import { useEffect, useState } from "react";
import { LockKeyhole, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { useRefresh } from "../contexts/useRefresh";
import { fetchConfig } from "../lib/api";
import {
    BROWSER_LANGUAGE_SETTING,
    SUPPORTED_LANGUAGES,
    getLanguageLabelKey,
    useI18n,
    type LanguagePreference,
} from "../lib/i18n";
import type { ConfigResponse } from "../types";

const REFRESH_OPTIONS = [
    { value: 0, labelKey: "components.sidebar.refresh.off" },
    { value: 5000, labelKey: "components.sidebar.refresh.every5Seconds" },
    { value: 30000, labelKey: "components.sidebar.refresh.every30Seconds" },
    { value: 60000, labelKey: "components.sidebar.refresh.every1Minute" },
    { value: 300000, labelKey: "components.sidebar.refresh.every5Minutes" },
] as const;

export function Settings() {
    const { intervalMs, setIntervalMs } = useRefresh();
    const { browserLanguage, preference, setLanguagePreference, t } = useI18n();
    const [config, setConfig] = useState<ConfigResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [languagePreference, setLanguagePreferenceValue] = useState<LanguagePreference>(preference);
    const [refreshInterval, setRefreshInterval] = useState(intervalMs);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void fetchConfig()
            .then((nextConfig) => {
                if (!cancelled) {
                    setConfig(nextConfig);
                    setRefreshInterval(nextConfig.refresh_interval);
                }
            })
            .catch((error) => {
                console.error("Failed to load settings", error);
            })
            .finally(() => {
                if (!cancelled) {
                    setIsLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [t]);

    const canManageSettings = config ? config.permissions?.can_manage_settings !== false : false;
    const hasLanguageChange = languagePreference !== preference;
    const hasRefreshChange = refreshInterval !== intervalMs;
    const canSave = hasLanguageChange || (canManageSettings && hasRefreshChange);

    const inputClass = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-500";
    const labelClass = "block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";

    const handleSave = async () => {
        setIsSaving(true);
        try {
            if (canManageSettings && hasRefreshChange) {
                await setIntervalMs(refreshInterval);
            }
            if (hasLanguageChange) {
                setLanguagePreference(languagePreference);
            }
        } catch (error) {
            console.error("Failed to save settings", error);
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex justify-center py-16">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t("pages.settings.general")}</CardTitle>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.generalDescription")}</p>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-6 xl:grid-cols-2">
                        <div className="space-y-2">
                            <label htmlFor="settings-language" className={labelClass}>
                                {t("pages.settings.language")}
                            </label>
                            <select
                                id="settings-language"
                                value={languagePreference}
                                onChange={(event) => setLanguagePreferenceValue(event.target.value as LanguagePreference)}
                                className={inputClass}
                            >
                                <option value={BROWSER_LANGUAGE_SETTING}>
                                    {t("pages.settings.browserDefaultLanguage", { language: t(getLanguageLabelKey(browserLanguage)) })}
                                </option>
                                {SUPPORTED_LANGUAGES.map((language) => (
                                    <option key={language.code} value={language.code}>
                                        {t(language.labelKey)}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.languageHelp")}</p>
                        </div>

                        <div className="space-y-2">
                            <label htmlFor="settings-refresh" className={labelClass}>
                                {t("pages.settings.refreshInterval")}
                            </label>
                            <select
                                id="settings-refresh"
                                value={refreshInterval}
                                onChange={(event) => setRefreshInterval(Number(event.target.value))}
                                disabled={!canManageSettings || isSaving}
                                className={inputClass}
                            >
                                {REFRESH_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {t(option.labelKey)}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.refreshHelp")}</p>
                        </div>
                    </div>

                    {!canManageSettings && (
                        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{t("pages.settings.readOnlyRefresh")}</span>
                        </div>
                    )}

                    <div className="mt-6 flex justify-end">
                        <button
                            type="button"
                            onClick={() => void handleSave()}
                            disabled={!canSave || isSaving}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <Save className="h-4 w-4" />
                            {isSaving ? t("common.saving") : t("common.save")}
                        </button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
