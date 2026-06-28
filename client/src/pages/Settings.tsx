import { useEffect, useState, type FormEvent } from "react";
import i18next from "i18next";
import { KeyRound, LockKeyhole, Plus, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { Switch } from "../components/ui/Switch";
import { useRefresh } from "../contexts/useRefresh";
import { useOptionalToast } from "../contexts/useToast";
import { fetchConfig, updateMetricsSidebarPreference } from "../lib/api";
import { apiUrl } from "../lib/basePath";
import { useAuth } from "../contexts/AuthContext";
import {
    serializeRegistrationCredential,
    toPublicKeyCredentialCreationOptions,
} from "../lib/webauthn";
import {
    BROWSER_LANGUAGE_SETTING,
    SUPPORTED_LANGUAGES,
    getLanguageLabelKey,
    resolveLanguagePreference,
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

const METRICS_SIDEBAR_PREFERENCE_EVENT = 'metrics-sidebar-preference-changed';

interface PasskeySummary {
    id: number;
    name: string | null;
    createdAt: string;
}

interface AuthSettings {
    disablePasswordLogin: boolean;
    oidcIssuerUrl: string;
    oidcClientId: string;
    hasOidcClientSecret: boolean;
    oidcGroupsClaim: string;
    oidcAdminGroups: string;
    oidcReadOnlyGroups: string;
    hasPassword: boolean;
    authMethod: 'password' | 'passkey' | 'oidc' | null;
}

function parseGroupList(value: string): string[] {
    return value
        .split(',')
        .map((group) => group.trim())
        .filter(Boolean);
}

function serializeGroupList(groups: string[]): string {
    return groups.map((group) => group.trim()).filter(Boolean).join(',');
}

export function Settings() {
    const { intervalMs, setIntervalMs } = useRefresh();
    const { authEnabled, refresh: refreshAuth } = useAuth();
    const { browserLanguage, preference, setLanguagePreference, t } = useI18n();
    const toast = useOptionalToast();
    const [config, setConfig] = useState<ConfigResponse | null>(null);
    const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
    const [authSettings, setAuthSettings] = useState<AuthSettings | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [languagePreference, setLanguagePreferenceValue] = useState<LanguagePreference>(preference);
    const [refreshInterval, setRefreshInterval] = useState(intervalMs);
    const [metricsSidebarVisible, setMetricsSidebarVisible] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [disablePasswordLogin, setDisablePasswordLogin] = useState(false);
    const [isSavingPasswordLogin, setIsSavingPasswordLogin] = useState(false);
    const [passkeyModalOpen, setPasskeyModalOpen] = useState(false);
    const [passkeyName, setPasskeyName] = useState('');
    const [isRegisteringPasskey, setIsRegisteringPasskey] = useState(false);
    const [isSavingOidc, setIsSavingOidc] = useState(false);
    const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
    const [oidcForm, setOidcForm] = useState({
        issuerUrl: '',
        clientId: '',
        clientSecret: '',
        groupsClaim: 'groups',
        adminGroups: [] as string[],
        readOnlyGroups: [] as string[],
    });
    const [oidcGroupDrafts, setOidcGroupDrafts] = useState({
        adminGroups: '',
        readOnlyGroups: '',
    });

    useEffect(() => {
        let cancelled = false;
        void fetchConfig()
            .then((nextConfig) => {
                if (!cancelled) {
                    setConfig(nextConfig);
                    setRefreshInterval(nextConfig.refresh_interval);
                    setMetricsSidebarVisible(nextConfig.metrics_sidebar_visible !== false);
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

        if (authEnabled) {
            void fetch(apiUrl('/api/auth/passkeys'))
                .then(async (response) => {
                    if (!response.ok) throw new Error('Failed to load passkeys');
                    return response.json() as Promise<{ passkeys: PasskeySummary[] }>;
                })
                .then((payload) => {
                    if (!cancelled) setPasskeys(payload.passkeys);
                })
                .catch((error) => {
                    console.error("Failed to load passkeys", error);
                });
            void fetch(apiUrl('/api/auth/settings'))
                .then(async (response) => {
                    if (!response.ok) throw new Error('Failed to load authentication settings');
                    return response.json() as Promise<AuthSettings>;
                })
                .then((payload) => {
                    if (!cancelled) {
                        setAuthSettings(payload);
                        setDisablePasswordLogin(payload.disablePasswordLogin);
                        setOidcForm({
                            issuerUrl: payload.oidcIssuerUrl,
                            clientId: payload.oidcClientId,
                            clientSecret: '',
                            groupsClaim: payload.oidcGroupsClaim || 'groups',
                            adminGroups: parseGroupList(payload.oidcAdminGroups || ''),
                            readOnlyGroups: parseGroupList(payload.oidcReadOnlyGroups || ''),
                        });
                    }
                })
                .catch((error) => {
                    console.error("Failed to load authentication settings", error);
                });
        }

        return () => {
            cancelled = true;
        };
    }, [authEnabled, t]);

    const canManageSettings = config ? config.permissions?.can_manage_settings !== false : false;
    const hasLanguageChange = languagePreference !== preference;
    const hasRefreshChange = refreshInterval !== intervalMs;
    const savedMetricsSidebarVisible = config?.metrics_sidebar_visible !== false;
    const hasMetricsSidebarChange = metricsSidebarVisible !== savedMetricsSidebarVisible;
    const canManageAuthSettings = canManageSettings;
    const canChangePassword = authSettings?.hasPassword === true && authSettings.authMethod === 'password';

    const inputClass = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-500";
    const labelClass = "block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";
    const showToast = (message: string, type: 'success' | 'danger' | 'info' = 'info') => {
        toast?.addToast(message, type);
    };
    const getSettingsSavedMessage = () => {
        if (!hasLanguageChange) {
            return t("pages.settings.settingsSaved");
        }
        return String(i18next.getFixedT(resolveLanguagePreference(languagePreference))("pages.settings.settingsSaved"));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            if (canManageSettings && hasRefreshChange) {
                await setIntervalMs(refreshInterval);
            }
            if (hasLanguageChange) {
                setLanguagePreference(languagePreference);
            }
            if (hasMetricsSidebarChange) {
                const payload = await updateMetricsSidebarPreference({ visible: metricsSidebarVisible });
                setConfig((current) => current ? {
                    ...current,
                    metrics_sidebar_visible: payload.metrics_sidebar_visible,
                } : current);
                window.dispatchEvent(new Event(METRICS_SIDEBAR_PREFERENCE_EVENT));
            }
            showToast(getSettingsSavedMessage(), "success");
        } catch (error) {
            console.error("Failed to save settings", error);
            showToast(t("pages.settings.failedToSaveSettings"), "danger");
        } finally {
            setIsSaving(false);
        }
    };

    const openPasskeyModal = () => {
        setPasskeyName(t('pages.settings.passkeyNameDefault'));
        setPasskeyModalOpen(true);
    };

    const closePasskeyModal = () => {
        if (isRegisteringPasskey) return;
        setPasskeyModalOpen(false);
    };

    const registerPasskey = async () => {
        setIsRegisteringPasskey(true);
        try {
            if (!window.isSecureContext || !navigator.credentials) {
                throw new Error('Passkeys require HTTPS or localhost');
            }
            const name = passkeyName.trim() || null;
            const optionsResponse = await fetch(apiUrl('/api/auth/webauthn/register/options'), { method: 'POST' });
            if (!optionsResponse.ok) throw new Error('Failed to start passkey registration');
            const options = toPublicKeyCredentialCreationOptions(await optionsResponse.json() as Record<string, unknown>);
            const credential = await navigator.credentials.create({ publicKey: options }) as PublicKeyCredential | null;
            if (!credential) throw new Error('No passkey credential returned');

            const verifyResponse = await fetch(apiUrl('/api/auth/webauthn/register/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(serializeRegistrationCredential(credential, name)),
            });
            if (!verifyResponse.ok) {
                const payload = await verifyResponse.json().catch(() => ({})) as { error?: string };
                throw new Error(payload.error || 'Failed to register passkey');
            }
            const listResponse = await fetch(apiUrl('/api/auth/passkeys'));
            const payload = await listResponse.json() as { passkeys: PasskeySummary[] };
            setPasskeys(payload.passkeys);
            setPasskeyModalOpen(false);
            showToast(t("pages.settings.passkeyRegistered"), "success");
        } catch (error) {
            console.error("Failed to register passkey", error);
            showToast(t("pages.settings.failedToRegisterPasskey"), "danger");
        } finally {
            setIsRegisteringPasskey(false);
        }
    };

    const removePasskey = async (id: number) => {
        const response = await fetch(apiUrl(`/api/auth/passkeys/${id}`), { method: 'DELETE' });
        if (!response.ok) {
            console.error("Failed to remove passkey");
            showToast(t("pages.settings.failedToRemovePasskey"), "danger");
            return;
        }
        setPasskeys((current) => current.filter((passkey) => passkey.id !== id));
        showToast(t("pages.settings.passkeyRemoved"), "success");
    };

    const savePasswordLoginSetting = async () => {
        setIsSavingPasswordLogin(true);
        try {
            const response = await fetch(apiUrl('/api/auth/settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ disablePasswordLogin }),
            });
            const payload = await response.json().catch(() => ({})) as { error?: string; settings?: Partial<AuthSettings> };
            if (!response.ok) {
                console.error(payload.error || 'Failed to update password login setting');
                showToast(payload.error || t("pages.settings.failedToSavePasswordLogin"), "danger");
                return;
            }
            const savedValue = payload.settings?.disablePasswordLogin ?? disablePasswordLogin;
            setAuthSettings((current) => current ? { ...current, disablePasswordLogin: savedValue } : current);
            setDisablePasswordLogin(savedValue);
            await refreshAuth();
            showToast(t("pages.settings.passwordLoginSaved"), "success");
        } catch (error) {
            console.error("Failed to update password login setting", error);
            showToast(t("pages.settings.failedToSavePasswordLogin"), "danger");
        } finally {
            setIsSavingPasswordLogin(false);
        }
    };

    const changePassword = async () => {
        if (passwordForm.newPassword !== passwordForm.confirmPassword) {
            console.error('New passwords do not match.');
            showToast(t("pages.settings.passwordsDoNotMatch"), "danger");
            return;
        }
        const response = await fetch(apiUrl('/api/auth/change-password'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentPassword: passwordForm.currentPassword,
                newPassword: passwordForm.newPassword,
            }),
        });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) {
            console.error(payload.error || 'Failed to change password');
            showToast(payload.error || t("pages.settings.failedToChangePassword"), "danger");
            return;
        }
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
        showToast(t("pages.settings.passwordChanged"), "success");
    };

    const saveOidcSettings = async () => {
        setIsSavingOidc(true);
        const adminGroups = serializeGroupList(oidcForm.adminGroups);
        const readOnlyGroups = serializeGroupList(oidcForm.readOnlyGroups);
        try {
            const response = await fetch(apiUrl('/api/auth/settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    oidcIssuerUrl: oidcForm.issuerUrl,
                    oidcClientId: oidcForm.clientId,
                    oidcClientSecret: oidcForm.clientSecret,
                    oidcGroupsClaim: oidcForm.groupsClaim,
                    oidcAdminGroups: adminGroups,
                    oidcReadOnlyGroups: readOnlyGroups,
                }),
            });
            const payload = await response.json().catch(() => ({})) as {
                error?: string;
                oidcError?: string;
                settings?: Partial<AuthSettings>;
            };
            if (!response.ok) {
                console.error(payload.error || 'Failed to save OIDC settings');
                showToast(payload.error || t("pages.settings.failedToSaveOidcSettings"), "danger");
                return;
            }
            setAuthSettings((current) => current ? {
                ...current,
                oidcIssuerUrl: oidcForm.issuerUrl.trim(),
                oidcClientId: oidcForm.clientId.trim(),
                hasOidcClientSecret: Boolean(oidcForm.clientSecret.trim()) || current.hasOidcClientSecret,
                oidcGroupsClaim: oidcForm.groupsClaim.trim() || 'groups',
                oidcAdminGroups: adminGroups,
                oidcReadOnlyGroups: readOnlyGroups,
            } : current);
            setOidcForm((current) => ({ ...current, clientSecret: '' }));
            if (payload.oidcError) {
                console.error(`OIDC settings saved, but discovery failed: ${payload.oidcError}`);
                showToast(t("pages.settings.oidcSettingsSavedButDiscoveryFailed", { error: payload.oidcError }), "danger");
            } else {
                showToast(t("pages.settings.oidcSettingsSaved"), "success");
            }
        } catch (error) {
            console.error("Failed to save OIDC settings", error);
            showToast(t("pages.settings.failedToSaveOidcSettings"), "danger");
        } finally {
            setIsSavingOidc(false);
        }
    };

    const addOidcGroup = (field: 'adminGroups' | 'readOnlyGroups') => {
        const group = oidcGroupDrafts[field].trim();
        if (!group) return;

        setOidcForm((current) => {
            if (current[field].includes(group)) return current;
            return { ...current, [field]: [...current[field], group] };
        });
        setOidcGroupDrafts((current) => ({ ...current, [field]: '' }));
    };

    const removeOidcGroup = (field: 'adminGroups' | 'readOnlyGroups', group: string) => {
        setOidcForm((current) => ({
            ...current,
            [field]: current[field].filter((candidate) => candidate !== group),
        }));
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

                        <div className="space-y-2 xl:col-span-2">
                            <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                                <div className="min-w-0">
                                    <label htmlFor="settings-metrics-sidebar" className={labelClass}>
                                        {t("pages.settings.showMetricsInSidebar")}
                                    </label>
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        {t("pages.settings.showMetricsInSidebarHelp")}
                                    </p>
                                </div>
                                <Switch
                                    id="settings-metrics-sidebar"
                                    checked={metricsSidebarVisible}
                                    onCheckedChange={setMetricsSidebarVisible}
                                />
                            </div>
                        </div>
                    </div>

                    {!canManageSettings && (
                        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{t("pages.settings.readOnlyRefresh")}</span>
                        </div>
                    )}

                    <div className="mt-6 flex justify-start">
                        <button
                            type="button"
                            onClick={() => void handleSave()}
                            disabled={isSaving}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <Save className="h-4 w-4" />
                            {isSaving ? t("common.saving") : t("common.save")}
                        </button>
                    </div>
                </CardContent>
            </Card>

            {!authEnabled && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                    <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t("pages.settings.authDisabledHint")}</span>
                </div>
            )}

            {authEnabled && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t("pages.settings.authentication")}</CardTitle>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.authenticationDescription")}</p>
                    </CardHeader>
                    <CardContent className="space-y-8">
                        <div className="space-y-4">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("pages.settings.password")}</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.passwordDescription")}</p>
                            </div>
                            <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-200">
                                <input
                                    type="checkbox"
                                    checked={disablePasswordLogin}
                                    onChange={(event) => setDisablePasswordLogin(event.target.checked)}
                                    disabled={!canManageAuthSettings || isSavingPasswordLogin}
                                    className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                                <span>
                                    <span className="block font-medium">{t("pages.settings.disablePasswordLogin")}</span>
                                    <span className="block text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.disablePasswordLoginDescription")}</span>
                                </span>
                            </label>
                            <button
                                type="button"
                                onClick={() => void savePasswordLoginSetting()}
                                disabled={!canManageAuthSettings || isSavingPasswordLogin}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <Save className="h-4 w-4" />
                                {isSavingPasswordLogin ? t("common.saving") : t("common.save")}
                            </button>

                            {canChangePassword && (
                                <div className="grid gap-4 lg:grid-cols-3">
                                    <div className="space-y-2">
                                        <label htmlFor="current-password" className={labelClass}>{t("pages.settings.currentPassword")}</label>
                                        <input
                                            id="current-password"
                                            type="password"
                                            value={passwordForm.currentPassword}
                                            onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                                            className={inputClass}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="new-password" className={labelClass}>{t("pages.settings.newPassword")}</label>
                                        <input
                                            id="new-password"
                                            type="password"
                                            value={passwordForm.newPassword}
                                            onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))}
                                            className={inputClass}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="confirm-password" className={labelClass}>{t("pages.settings.confirmPassword")}</label>
                                        <input
                                            id="confirm-password"
                                            type="password"
                                            value={passwordForm.confirmPassword}
                                            onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                                            className={inputClass}
                                        />
                                    </div>
                                    <div className="lg:col-span-3">
                                        <button
                                            type="button"
                                            onClick={() => void changePassword()}
                                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
                                        >
                                            <Save className="h-4 w-4" />
                                            {t("pages.settings.changePassword")}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="space-y-4 border-t border-gray-200 pt-6 dark:border-gray-700">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("pages.settings.passkeys")}</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.passkeysDescription")}</p>
                            </div>
                            <div className="space-y-3">
                                {passkeys.length === 0 ? (
                                    <p className="text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.noPasskeys")}</p>
                                ) : (
                                    passkeys.map((passkey) => (
                                        <div
                                            key={passkey.id}
                                            className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50"
                                        >
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                                                    {passkey.name || t("pages.settings.passkey")}
                                                </p>
                                                <p className="text-xs text-gray-500">
                                                    {t("pages.settings.passkeyAdded", { date: new Date(passkey.createdAt).toLocaleDateString() })}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => void removePasskey(passkey.id)}
                                                className="rounded-md p-2 text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                                                aria-label={t("pages.settings.removePasskey")}
                                                title={t("pages.settings.removePasskey")}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={openPasskeyModal}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
                            >
                                <KeyRound className="h-4 w-4" />
                                {t("pages.settings.registerNewPasskey")}
                            </button>
                        </div>

                        <div className="space-y-4 border-t border-gray-200 pt-6 dark:border-gray-700">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("pages.settings.oidcSso")}</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.oidcDescription")}</p>
                            </div>
                            <div className="grid gap-4 lg:grid-cols-2">
                                <div className="space-y-2 lg:col-span-2">
                                    <label htmlFor="oidc-issuer" className={labelClass}>{t("pages.settings.oidcIssuerUrl")}</label>
                                    <input
                                        id="oidc-issuer"
                                        value={oidcForm.issuerUrl}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, issuerUrl: event.target.value }))}
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-client-id" className={labelClass}>{t("pages.settings.oidcClientId")}</label>
                                    <input
                                        id="oidc-client-id"
                                        value={oidcForm.clientId}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, clientId: event.target.value }))}
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-client-secret" className={labelClass}>{t("pages.settings.oidcClientSecret")}</label>
                                    <input
                                        id="oidc-client-secret"
                                        type="password"
                                        value={oidcForm.clientSecret}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, clientSecret: event.target.value }))}
                                        placeholder={authSettings?.hasOidcClientSecret ? t("pages.settings.unchanged") : ''}
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-groups-claim" className={labelClass}>{t("pages.settings.oidcGroupsClaim")}</label>
                                    <input
                                        id="oidc-groups-claim"
                                        value={oidcForm.groupsClaim}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, groupsClaim: event.target.value }))}
                                        placeholder="groups"
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <GroupListEditor
                                    id="oidc-admin-groups"
                                    label={t("pages.settings.oidcAdminGroups")}
                                    groups={oidcForm.adminGroups}
                                    draft={oidcGroupDrafts.adminGroups}
                                    onDraftChange={(value) => setOidcGroupDrafts((current) => ({ ...current, adminGroups: value }))}
                                    onAdd={() => addOidcGroup('adminGroups')}
                                    onRemove={(group) => removeOidcGroup('adminGroups', group)}
                                    disabled={!canManageAuthSettings}
                                    placeholder="crowdsec-admins"
                                    addLabel={t("pages.settings.addGroup")}
                                    emptyLabel={t("pages.settings.noGroupsConfigured")}
                                    removeLabel={(group) => t("pages.settings.removeGroup", { group })}
                                    labelClass={labelClass}
                                />
                                <div className="space-y-2 lg:col-span-2">
                                    <GroupListEditor
                                        id="oidc-read-only-groups"
                                        label={t("pages.settings.oidcReadOnlyGroups")}
                                        groups={oidcForm.readOnlyGroups}
                                        draft={oidcGroupDrafts.readOnlyGroups}
                                        onDraftChange={(value) => setOidcGroupDrafts((current) => ({ ...current, readOnlyGroups: value }))}
                                        onAdd={() => addOidcGroup('readOnlyGroups')}
                                        onRemove={(group) => removeOidcGroup('readOnlyGroups', group)}
                                        disabled={!canManageAuthSettings}
                                        placeholder="crowdsec-viewers"
                                        addLabel={t("pages.settings.addGroup")}
                                        emptyLabel={t("pages.settings.noGroupsConfigured")}
                                        removeLabel={(group) => t("pages.settings.removeGroup", { group })}
                                        labelClass={labelClass}
                                    />
                                    <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.oidcGroupsHelp")}</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => void saveOidcSettings()}
                                disabled={!canManageAuthSettings || isSavingOidc}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
                            >
                                <ShieldCheck className="h-4 w-4" />
                                {isSavingOidc ? t("common.saving") : t("pages.settings.saveOidcSettings")}
                            </button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Modal
                isOpen={passkeyModalOpen}
                onClose={closePasskeyModal}
                title={t("pages.settings.registerPasskeyTitle")}
            >
                <form
                    className="space-y-5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void registerPasskey();
                    }}
                >
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t("pages.settings.registerPasskeyDescription")}
                    </p>
                    <div className="space-y-2">
                        <label htmlFor="passkey-name" className={labelClass}>{t("pages.settings.passkeyNamePrompt")}</label>
                        <input
                            id="passkey-name"
                            value={passkeyName}
                            onChange={(event) => setPasskeyName(event.target.value)}
                            disabled={isRegisteringPasskey}
                            className={inputClass}
                            autoFocus
                        />
                    </div>
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button
                            type="button"
                            onClick={closePasskeyModal}
                            disabled={isRegisteringPasskey}
                            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            type="submit"
                            disabled={isRegisteringPasskey}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <KeyRound className="h-4 w-4" />
                            {isRegisteringPasskey ? t("common.saving") : t("pages.settings.registerPasskeySubmit")}
                        </button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}

function GroupListEditor({
    id,
    label,
    groups,
    draft,
    onDraftChange,
    onAdd,
    onRemove,
    disabled,
    placeholder,
    addLabel,
    emptyLabel,
    removeLabel,
    labelClass,
}: {
    id: string;
    label: string;
    groups: string[];
    draft: string;
    onDraftChange: (value: string) => void;
    onAdd: () => void;
    onRemove: (group: string) => void;
    disabled: boolean;
    placeholder: string;
    addLabel: string;
    emptyLabel: string;
    removeLabel: (group: string) => string;
    labelClass: string;
}) {
    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        onAdd();
    };

    return (
        <div className="space-y-2">
            <label htmlFor={id} className={labelClass}>{label}</label>
            <form
                className="flex min-h-11 overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:ring-2 focus-within:ring-primary-500 dark:border-gray-700 dark:bg-gray-900"
                onSubmit={handleSubmit}
            >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-2 py-1.5">
                    {groups.map((group) => (
                        <span
                            key={group}
                            className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary-50 px-2 py-1 text-sm font-medium text-primary-800 dark:bg-primary-900/40 dark:text-primary-100"
                        >
                            <span className="truncate">{group}</span>
                            <button
                                type="button"
                                onClick={() => onRemove(group)}
                                disabled={disabled}
                                className="rounded p-0.5 text-primary-700 hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-primary-200 dark:hover:bg-primary-800"
                                aria-label={removeLabel(group)}
                                title={removeLabel(group)}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </span>
                    ))}
                    {groups.length === 0 && !draft.trim() && (
                        <span className="px-1 py-1 text-sm text-gray-500 dark:text-gray-400">{emptyLabel}</span>
                    )}
                    <input
                        id={id}
                        value={draft}
                        onChange={(event) => onDraftChange(event.target.value)}
                        placeholder={groups.length === 0 ? placeholder : ''}
                        disabled={disabled}
                        className="min-w-48 flex-1 border-0 bg-transparent px-1 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed disabled:text-gray-500 dark:text-gray-100 dark:placeholder:text-gray-500 dark:disabled:text-gray-500"
                    />
                </div>
                <button
                    type="submit"
                    disabled={disabled || !draft.trim()}
                    className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 border-l border-gray-300 bg-gray-100 px-3 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                    <Plus className="h-4 w-4" />
                    <span>{addLabel}</span>
                </button>
            </form>
        </div>
    );
}
