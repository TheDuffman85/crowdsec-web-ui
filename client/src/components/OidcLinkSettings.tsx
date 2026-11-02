import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Info, Link2, TriangleAlert, Unlink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { Modal } from "./ui/Modal";
import { Badge } from "./ui/Badge";
import { apiUrl, withBasePath } from "../lib/basePath";
import { sessionFetch } from "../lib/sessionFetch";
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/dateTime";

type UserRole = 'admin' | 'read-only';

interface OidcLinkStatus {
    /** OIDC is configured and this account has local credentials to link it to. */
    available: boolean;
    /** Links can only be changed from a password or passkey session. */
    canManage: boolean;
    username: string;
    totpEnabled: boolean;
    passwordLoginDisabled: boolean;
    link: {
        issuer: string;
        username: string | null;
        /** null: the provider denied the identity at its last sign-in. */
        role: UserRole | null;
        method: 'verified' | 'username';
        linkedAt: string;
        /** "changed": this identity can no longer sign in. "unavailable": SSO is off until the provider responds. */
        provider: 'current' | 'changed' | 'unavailable';
    } | null;
    /** An identity the provider confirmed, waiting for the account holder to confirm the link. */
    pending: {
        /** Sent back on confirmation, so only what this form showed can be linked. */
        id: string;
        issuer: string;
        username: string;
        role: UserRole;
        merge: { username: string } | null;
    } | null;
}

interface AccountHolderProof {
    password: string;
    totpCode?: string;
}

interface OidcLinkSettingsProps {
    inputClass: string;
    labelClass: string;
    showToast: (message: string, type?: 'success' | 'danger' | 'info') => void;
}

const OUTCOME_PARAM = 'oidcLink';
const ERROR_OUTCOMES: Record<string, string> = {
    denied: "pages.settings.oidcLink.errorDenied",
    taken: "pages.settings.oidcLink.errorTaken",
    disabled: "pages.settings.oidcLink.errorDisabled",
    session: "pages.settings.oidcLink.errorSession",
    failed: "pages.settings.oidcLink.errorFailed",
};

const PROVIDER_STATUS = {
    current: { badge: 'success', label: "pages.settings.oidcLink.statusLinked" },
    changed: { badge: 'warning', label: "pages.settings.oidcLink.statusStale" },
    unavailable: { badge: 'secondary', label: "pages.settings.oidcLink.statusUnavailable" },
} as const;

const primaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800";
const dangerButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60";

const NOTICE_STYLES = {
    info: {
        box: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800/60 dark:bg-blue-950/30 dark:text-blue-100",
        icon: Info,
    },
    warning: {
        box: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100",
        icon: TriangleAlert,
    },
};

function issuerHost(issuer: string): string {
    try {
        return new URL(issuer).host;
    } catch {
        return issuer;
    }
}

function Notice({ variant, title, children }: { variant: keyof typeof NOTICE_STYLES; title?: string; children: ReactNode }) {
    const { box, icon: Icon } = NOTICE_STYLES[variant];
    return (
        <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${box}`}>
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
                {title && <p className="font-medium">{title}</p>}
                <div className="opacity-90">{children}</div>
            </div>
        </div>
    );
}

// Asks for the local password and authenticator code before a sign-in method changes.
function AccountHolderForm({ totpEnabled, danger = false, submitLabel, busy, inputClass, labelClass, onSubmit, onCancel }: {
    totpEnabled: boolean;
    danger?: boolean;
    submitLabel: string;
    busy: boolean;
    inputClass: string;
    labelClass: string;
    onSubmit: (proof: AccountHolderProof) => Promise<string | null>;
    onCancel: () => void;
}) {
    const { t } = useI18n();
    const [password, setPassword] = useState('');
    const [totpCode, setTotpCode] = useState('');
    const [error, setError] = useState('');

    return (
        <form
            className="space-y-5"
            onSubmit={(event) => {
                event.preventDefault();
                setError('');
                void onSubmit({ password, ...(totpEnabled ? { totpCode } : {}) }).then((message) => {
                    if (!message) return;
                    setError(message);
                    setTotpCode('');
                });
            }}
        >
            {error && (
                <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                    {error}
                </div>
            )}
            <div className="space-y-2">
                <label htmlFor="oidc-link-password" className={labelClass}>{t("pages.settings.currentPassword")}</label>
                <input
                    id="oidc-link-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                    autoComplete="current-password"
                    className={inputClass}
                    autoFocus
                />
            </div>
            {totpEnabled && (
                <div className="space-y-2">
                    <label htmlFor="oidc-link-totp" className={labelClass}>{t("pages.settings.authenticatorCode")}</label>
                    <input
                        id="oidc-link-totp"
                        value={totpCode}
                        onChange={(event) => setTotpCode(event.target.value)}
                        disabled={busy}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        className={inputClass}
                    />
                </div>
            )}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" onClick={onCancel} disabled={busy} className={secondaryButtonClass}>
                    {t("common.cancel")}
                </button>
                <button
                    type="submit"
                    disabled={busy || !password || (totpEnabled && !totpCode)}
                    className={danger ? dangerButtonClass : primaryButtonClass}
                >
                    {busy ? t("common.saving") : submitLabel}
                </button>
            </div>
        </form>
    );
}

export function OidcLinkSettings({ inputClass, labelClass, showToast }: OidcLinkSettingsProps) {
    const { t } = useI18n();
    const { formatDate } = useDateTime();
    const [searchParams, setSearchParams] = useSearchParams();
    const [status, setStatus] = useState<OidcLinkStatus | null>(null);
    const [isStarting, setIsStarting] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [unlinkOpen, setUnlinkOpen] = useState(false);
    const outcome = searchParams.get(OUTCOME_PARAM);

    // The parent passes a new toast callback on every render; effects must not depend on it.
    const showToastRef = useRef(showToast);
    useEffect(() => {
        showToastRef.current = showToast;
    });

    const loadStatus = useCallback(async () => {
        const response = await sessionFetch(apiUrl('/api/auth/oidc/link'));
        if (!response.ok) throw new Error('Failed to load the SSO link');
        return await response.json() as OidcLinkStatus;
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadStatus()
            .then((payload) => {
                if (!cancelled) setStatus(payload);
            })
            .catch((error) => {
                console.error("Failed to load the SSO link", error);
            });
        return () => {
            cancelled = true;
        };
    }, [loadStatus]);

    const clearOutcome = useCallback(() => {
        setSearchParams((current) => {
            const next = new URLSearchParams(current);
            next.delete(OUTCOME_PARAM);
            return next;
        }, { replace: true });
    }, [setSearchParams]);

    // The identity provider returns here with the outcome of the link in the URL.
    // The confirmation stays open until it is answered; everything else is a failure to report.
    const pending = status?.pending ?? null;
    const statusLoaded = status !== null;
    const confirmOpen = outcome === 'confirm' && pending !== null;
    useEffect(() => {
        if (!outcome || !statusLoaded || confirmOpen) return;
        showToastRef.current(t(ERROR_OUTCOMES[outcome] ?? "pages.settings.oidcLink.errorSession"), "danger");
        clearOutcome();
    }, [clearOutcome, confirmOpen, outcome, statusLoaded, t]);

    if (!status || (!status.available && !status.link)) return null;

    const { link } = status;
    const roleLabel = (role: UserRole) => role === 'admin' ? t("pages.settings.userRoleAdmin") : t("pages.settings.userRoleReadOnly");
    const loginUrl = `${window.location.origin}${withBasePath('/login?local=1')}`;

    const startLink = async () => {
        setIsStarting(true);
        try {
            const response = await sessionFetch(apiUrl('/api/auth/oidc/link/start'), { method: 'POST' });
            const payload = await response.json().catch(() => ({})) as { error?: string; redirectUrl?: string };
            if (!response.ok || !payload.redirectUrl) throw new Error(payload.error || t("pages.settings.oidcLink.errorFailed"));
            window.location.assign(payload.redirectUrl);
        } catch (error) {
            console.error("Failed to start the SSO link", error);
            showToast(error instanceof Error ? error.message : t("pages.settings.oidcLink.errorFailed"), "danger");
            setIsStarting(false);
        }
    };

    // Returns the message to show in the form, or null once the change is done.
    const changeLink = async (
        path: string,
        method: 'POST' | 'DELETE',
        proof: AccountHolderProof & { confirmationId?: string },
        successMessage: string,
        close: () => void,
    ): Promise<string | null> => {
        setIsSubmitting(true);
        try {
            const response = await sessionFetch(apiUrl(path), {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(proof),
            }, { ignoredUnauthorizedErrors: ['Current password is incorrect'] });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
                if (payload.code !== 'OIDC_LINK_CHANGED') return payload.error || t("pages.settings.oidcLink.errorSession");
                // What this form shows is out of date, so asking again here cannot help.
                showToast(t("pages.settings.oidcLink.errorChanged"), "danger");
                close();
                setStatus(await loadStatus());
                return null;
            }
            showToast(successMessage, "success");
            close();
            setStatus(await loadStatus());
            return null;
        } catch (error) {
            console.error("Failed to change the SSO link", error);
            return error instanceof Error ? error.message : t("pages.settings.oidcLink.errorSession");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("pages.settings.oidcLink.title")}</CardTitle>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t(link ? "pages.settings.oidcLink.descriptionLinked" : "pages.settings.oidcLink.description")}
                </p>
            </CardHeader>
            <CardContent className="space-y-4">
                {link ? (
                    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{link.username}</span>
                                <Badge variant={PROVIDER_STATUS[link.provider].badge}>{t(PROVIDER_STATUS[link.provider].label)}</Badge>
                            </div>
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                {[
                                    issuerHost(link.issuer),
                                    t("pages.settings.oidcLink.ssoAccess", { role: link.role ? roleLabel(link.role) : t("pages.settings.oidcLink.roleDenied") }),
                                    t("pages.settings.oidcLink.linkedOn", { date: formatDate(link.linkedAt) }),
                                ].join(" · ")}
                            </p>
                        </div>
                        {status.canManage && (
                            <button type="button" onClick={() => setUnlinkOpen(true)} className={`shrink-0 self-start sm:self-auto ${secondaryButtonClass}`}>
                                <Unlink className="h-4 w-4" />
                                {t("pages.settings.oidcLink.unlink")}
                            </button>
                        )}
                    </div>
                ) : status.canManage && (
                    <button type="button" onClick={() => void startLink()} disabled={isStarting} className={primaryButtonClass}>
                        <Link2 className="h-4 w-4" />
                        {t("pages.settings.oidcLink.link")}
                    </button>
                )}

                {link?.provider === 'changed' && (
                    <Notice variant="warning" title={t("pages.settings.oidcLink.staleTitle")}>
                        {t("pages.settings.oidcLink.stale")}
                    </Notice>
                )}
                {link?.provider === 'unavailable' && (
                    <Notice variant="info" title={t("pages.settings.oidcLink.unavailableTitle")}>
                        {t("pages.settings.oidcLink.unavailable")}
                    </Notice>
                )}
                {link?.method === 'username' && (
                    <Notice variant="warning" title={t("pages.settings.oidcLink.unverifiedTitle")}>
                        {t("pages.settings.oidcLink.unverified")}
                    </Notice>
                )}
                {status.canManage && !status.totpEnabled && (
                    <Notice variant="warning" title={t("pages.settings.oidcLink.totpWarningTitle")}>
                        {t("pages.settings.oidcLink.totpWarning")}
                    </Notice>
                )}
                {status.canManage && status.passwordLoginDisabled && (
                    <Notice variant="warning" title={t("pages.settings.oidcLink.passwordLoginWarningTitle")}>
                        {t("pages.settings.oidcLink.passwordLoginWarning")}
                    </Notice>
                )}
                {link && (
                    <Notice variant="info" title={t("pages.settings.oidcLink.recoveryTitle")}>
                        <p>{t("pages.settings.oidcLink.recovery")}</p>
                        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                            <dt className="opacity-75">{t("pages.login.username")}</dt>
                            <dd className="break-all font-medium">{status.username}</dd>
                            <dt className="opacity-75">{t("pages.settings.oidcLink.recoveryPage")}</dt>
                            <dd className="break-all">
                                <a href={loginUrl} className="underline underline-offset-2 hover:opacity-80">{loginUrl}</a>
                            </dd>
                        </dl>
                    </Notice>
                )}
                {!status.canManage && (
                    <Notice variant="info" title={t("pages.settings.oidcLink.ssoSessionHintTitle")}>
                        {t("pages.settings.oidcLink.ssoSessionHint")}
                    </Notice>
                )}
            </CardContent>

            <Modal
                isOpen={confirmOpen}
                onClose={() => !isSubmitting && clearOutcome()}
                title={t("pages.settings.oidcLink.confirmTitle")}
            >
                {pending && (
                    <div className="space-y-4">
                        <p className="text-sm text-gray-700 dark:text-gray-200">
                            {t("pages.settings.oidcLink.confirmMessage", {
                                identity: pending.username,
                                issuer: issuerHost(pending.issuer),
                                username: status.username,
                            })}
                        </p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {t("pages.settings.oidcLink.confirmRole", { role: roleLabel(pending.role) })}
                        </p>
                        {pending.merge && (
                            <Notice variant="warning">
                                {t("pages.settings.oidcLink.mergeWarning", { username: pending.merge.username })}
                            </Notice>
                        )}
                        <AccountHolderForm
                            totpEnabled={status.totpEnabled}
                            submitLabel={t("pages.settings.oidcLink.confirm")}
                            busy={isSubmitting}
                            inputClass={inputClass}
                            labelClass={labelClass}
                            onCancel={clearOutcome}
                            onSubmit={(proof) => changeLink('/api/auth/oidc/link/confirm', 'POST', { ...proof, confirmationId: pending.id }, t("pages.settings.oidcLink.linked"), clearOutcome)}
                        />
                    </div>
                )}
            </Modal>

            <Modal
                isOpen={unlinkOpen}
                onClose={() => !isSubmitting && setUnlinkOpen(false)}
                title={t("pages.settings.oidcLink.unlinkTitle")}
            >
                <div className="space-y-4">
                    <p className="text-sm text-gray-700 dark:text-gray-200">{t("pages.settings.oidcLink.unlinkMessage")}</p>
                    <AccountHolderForm
                        totpEnabled={status.totpEnabled}
                        danger
                        submitLabel={t("pages.settings.oidcLink.unlink")}
                        busy={isSubmitting}
                        inputClass={inputClass}
                        labelClass={labelClass}
                        onCancel={() => setUnlinkOpen(false)}
                        onSubmit={(proof) => changeLink('/api/auth/oidc/link', 'DELETE', proof, t("pages.settings.oidcLink.unlinked"), () => setUnlinkOpen(false))}
                    />
                </div>
            </Modal>
        </Card>
    );
}
