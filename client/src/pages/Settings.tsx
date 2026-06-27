import { useEffect, useState } from "react";
import { KeyRound, LockKeyhole, Save, ShieldCheck, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { useRefresh } from "../contexts/useRefresh";
import { fetchConfig } from "../lib/api";
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
}

export function Settings() {
    const { intervalMs, setIntervalMs } = useRefresh();
    const { authEnabled } = useAuth();
    const { browserLanguage, preference, setLanguagePreference, t } = useI18n();
    const [config, setConfig] = useState<ConfigResponse | null>(null);
    const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
    const [authSettings, setAuthSettings] = useState<AuthSettings | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [languagePreference, setLanguagePreferenceValue] = useState<LanguagePreference>(preference);
    const [refreshInterval, setRefreshInterval] = useState(intervalMs);
    const [isSaving, setIsSaving] = useState(false);
    const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
    const [oidcForm, setOidcForm] = useState({
        issuerUrl: '',
        clientId: '',
        clientSecret: '',
        groupsClaim: 'groups',
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
                        setOidcForm({
                            issuerUrl: payload.oidcIssuerUrl,
                            clientId: payload.oidcClientId,
                            clientSecret: '',
                            groupsClaim: payload.oidcGroupsClaim || 'groups',
                            adminGroups: payload.oidcAdminGroups || '',
                            readOnlyGroups: payload.oidcReadOnlyGroups || '',
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
    const canManageAuthSettings = canManageSettings;

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

    const registerPasskey = async () => {
        try {
            if (!window.isSecureContext || !navigator.credentials) {
                throw new Error('Passkeys require HTTPS or localhost');
            }
            const name = window.prompt('Passkey name', 'Security key')?.trim() || null;
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
        } catch (error) {
            console.error("Failed to register passkey", error);
        }
    };

    const removePasskey = async (id: number) => {
        const response = await fetch(apiUrl(`/api/auth/passkeys/${id}`), { method: 'DELETE' });
        if (!response.ok) {
            console.error("Failed to remove passkey");
            return;
        }
        setPasskeys((current) => current.filter((passkey) => passkey.id !== id));
    };

    const savePasswordLoginSetting = async (disablePasswordLogin: boolean) => {
        const response = await fetch(apiUrl('/api/auth/settings'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disablePasswordLogin }),
        });
        const payload = await response.json().catch(() => ({})) as { error?: string; settings?: Partial<AuthSettings> };
        if (!response.ok) {
            console.error(payload.error || 'Failed to update password login setting');
            return;
        }
        setAuthSettings((current) => current ? { ...current, disablePasswordLogin } : current);
    };

    const changePassword = async () => {
        if (passwordForm.newPassword !== passwordForm.confirmPassword) {
            console.error('New passwords do not match.');
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
            return;
        }
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    };

    const saveOidcSettings = async () => {
        const response = await fetch(apiUrl('/api/auth/settings'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                oidcIssuerUrl: oidcForm.issuerUrl,
                oidcClientId: oidcForm.clientId,
                oidcClientSecret: oidcForm.clientSecret,
                oidcGroupsClaim: oidcForm.groupsClaim,
                oidcAdminGroups: oidcForm.adminGroups,
                oidcReadOnlyGroups: oidcForm.readOnlyGroups,
            }),
        });
        const payload = await response.json().catch(() => ({})) as {
            error?: string;
            oidcError?: string;
            settings?: Partial<AuthSettings>;
        };
        if (!response.ok) {
            console.error(payload.error || 'Failed to save OIDC settings');
            return;
        }
        setAuthSettings((current) => current ? {
            ...current,
            oidcIssuerUrl: oidcForm.issuerUrl.trim(),
            oidcClientId: oidcForm.clientId.trim(),
            hasOidcClientSecret: Boolean(oidcForm.clientSecret.trim()) || current.hasOidcClientSecret,
            oidcGroupsClaim: oidcForm.groupsClaim.trim() || 'groups',
            oidcAdminGroups: oidcForm.adminGroups.trim(),
            oidcReadOnlyGroups: oidcForm.readOnlyGroups.trim(),
        } : current);
        setOidcForm((current) => ({ ...current, clientSecret: '' }));
        if (payload.oidcError) {
            console.error(`OIDC settings saved, but discovery failed: ${payload.oidcError}`);
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

            {authEnabled && (
                <Card>
                    <CardHeader>
                        <CardTitle>Authentication</CardTitle>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Manage account sign-in methods.</p>
                    </CardHeader>
                    <CardContent className="space-y-8">
                        <div className="space-y-4">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Password</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Change your local password or disable password login after another sign-in method is configured.</p>
                            </div>
                            <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-200">
                                <input
                                    type="checkbox"
                                    checked={authSettings?.disablePasswordLogin === true}
                                    onChange={(event) => void savePasswordLoginSetting(event.target.checked)}
                                    disabled={!canManageAuthSettings}
                                    className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                                <span>
                                    <span className="block font-medium">Disable password login</span>
                                    <span className="block text-xs text-gray-500 dark:text-gray-400">When enabled, only passkeys and SSO can be used to sign in.</span>
                                </span>
                            </label>

                            {authSettings?.hasPassword && (
                                <div className="grid gap-4 lg:grid-cols-3">
                                    <div className="space-y-2">
                                        <label htmlFor="current-password" className={labelClass}>Current password</label>
                                        <input
                                            id="current-password"
                                            type="password"
                                            value={passwordForm.currentPassword}
                                            onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                                            className={inputClass}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="new-password" className={labelClass}>New password</label>
                                        <input
                                            id="new-password"
                                            type="password"
                                            value={passwordForm.newPassword}
                                            onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))}
                                            className={inputClass}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="confirm-password" className={labelClass}>Confirm password</label>
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
                                            Change Password
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="space-y-4 border-t border-gray-200 pt-6 dark:border-gray-700">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Passkeys</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Register hardware keys, platform authenticators, or synced passkeys for passwordless sign-in.</p>
                            </div>
                            <div className="space-y-3">
                                {passkeys.length === 0 ? (
                                    <p className="text-sm text-gray-500 dark:text-gray-400">No passkeys registered.</p>
                                ) : (
                                    passkeys.map((passkey) => (
                                        <div
                                            key={passkey.id}
                                            className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50"
                                        >
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                                                    {passkey.name || 'Passkey'}
                                                </p>
                                                <p className="text-xs text-gray-500">
                                                    Added {new Date(passkey.createdAt).toLocaleDateString()}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => void removePasskey(passkey.id)}
                                                className="rounded-md p-2 text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                                                aria-label="Remove passkey"
                                                title="Remove passkey"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => void registerPasskey()}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
                            >
                                <KeyRound className="h-4 w-4" />
                                Register New Passkey
                            </button>
                        </div>

                        <div className="space-y-4 border-t border-gray-200 pt-6 dark:border-gray-700">
                            <div>
                                <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">OIDC (SSO)</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Configure the provider connection and optional group mapping for admin and read-only access.</p>
                            </div>
                            <div className="grid gap-4 lg:grid-cols-2">
                                <div className="space-y-2 lg:col-span-2">
                                    <label htmlFor="oidc-issuer" className={labelClass}>Issuer URL</label>
                                    <input
                                        id="oidc-issuer"
                                        value={oidcForm.issuerUrl}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, issuerUrl: event.target.value }))}
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-client-id" className={labelClass}>Client ID</label>
                                    <input
                                        id="oidc-client-id"
                                        value={oidcForm.clientId}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, clientId: event.target.value }))}
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-client-secret" className={labelClass}>Client Secret</label>
                                    <input
                                        id="oidc-client-secret"
                                        type="password"
                                        value={oidcForm.clientSecret}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, clientSecret: event.target.value }))}
                                        placeholder={authSettings?.hasOidcClientSecret ? '(unchanged)' : ''}
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-groups-claim" className={labelClass}>Groups Claim</label>
                                    <input
                                        id="oidc-groups-claim"
                                        value={oidcForm.groupsClaim}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, groupsClaim: event.target.value }))}
                                        placeholder="groups"
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label htmlFor="oidc-admin-groups" className={labelClass}>Admin Groups</label>
                                    <input
                                        id="oidc-admin-groups"
                                        value={oidcForm.adminGroups}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, adminGroups: event.target.value }))}
                                        placeholder="crowdsec-admins,secops"
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                </div>
                                <div className="space-y-2 lg:col-span-2">
                                    <label htmlFor="oidc-read-only-groups" className={labelClass}>Read-only Groups</label>
                                    <input
                                        id="oidc-read-only-groups"
                                        value={oidcForm.readOnlyGroups}
                                        onChange={(event) => setOidcForm((current) => ({ ...current, readOnlyGroups: event.target.value }))}
                                        placeholder="crowdsec-viewers"
                                        disabled={!canManageAuthSettings}
                                        className={inputClass}
                                    />
                                    <p className="text-xs text-gray-500 dark:text-gray-400">Leave group lists empty to make all OIDC users admins. If any group is configured, unmatched OIDC users are read-only.</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => void saveOidcSettings()}
                                disabled={!canManageAuthSettings}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
                            >
                                <ShieldCheck className="h-4 w-4" />
                                Save OIDC Settings
                            </button>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
