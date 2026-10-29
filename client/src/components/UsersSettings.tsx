import { Fragment, useEffect, useRef, useState } from "react";
import { Eye, KeyRound, LockKeyhole, MoreVertical, ShieldCheck, ShieldOff, Trash2, UserCheck, UserPlus, UserX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { Modal } from "./ui/Modal";
import { Badge } from "./ui/Badge";
import { apiUrl } from "../lib/basePath";
import { sessionFetch } from "../lib/sessionFetch";
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/dateTime";

type UserRole = 'admin' | 'read-only';

export interface ManagedUser {
    id: number;
    username: string;
    role: UserRole;
    source: 'local' | 'oidc';
    disabled: boolean;
    passwordChangeRequired: boolean;
    totpEnabled: boolean;
    passkeyCount: number;
    createdAt: string;
    current: boolean;
}

type ConfirmAction = 'delete' | 'reset-mfa' | 'disable';

interface UserAction {
    key: string;
    icon: LucideIcon;
    label: string;
    onSelect: () => void;
    disabled: boolean;
    danger?: boolean;
}

interface UsersSettingsProps {
    canManage: boolean;
    inputClass: string;
    labelClass: string;
    showToast: (message: string, type?: 'success' | 'danger' | 'info') => void;
}

const primaryButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass = "inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800";
const dangerButtonClass = "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60";

async function readError(response: Response, fallback: string): Promise<string> {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    return payload.error || fallback;
}

export function UsersSettings({ canManage, inputClass, labelClass, showToast }: UsersSettingsProps) {
    const { t } = useI18n();
    const { formatDate } = useDateTime();
    const [users, setUsers] = useState<ManagedUser[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [busyUserId, setBusyUserId] = useState<number | null>(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState({ username: '', password: '', role: 'read-only' as UserRole, requirePasswordChange: true });
    const [isCreating, setIsCreating] = useState(false);
    const [passwordUser, setPasswordUser] = useState<ManagedUser | null>(null);
    const [passwordForm, setPasswordForm] = useState({ password: '', requirePasswordChange: true });
    const [isResettingPassword, setIsResettingPassword] = useState(false);
    const [confirm, setConfirm] = useState<{ action: ConfirmAction; user: ManagedUser } | null>(null);

    // The parent passes a new toast callback on every render; loading must not depend on it.
    const showToastRef = useRef(showToast);
    useEffect(() => {
        showToastRef.current = showToast;
    });

    useEffect(() => {
        let cancelled = false;
        void sessionFetch(apiUrl('/api/auth/users'))
            .then(async (response) => {
                if (!response.ok) throw new Error(await readError(response, 'Failed to load users'));
                return response.json() as Promise<{ users: ManagedUser[] }>;
            })
            .then((payload) => {
                if (!cancelled) setUsers(payload.users);
            })
            .catch((error) => {
                console.error("Failed to load users", error);
                if (!cancelled) showToastRef.current(t("pages.settings.failedToLoadUsers"), "danger");
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [t]);

    const replaceUser = (user: ManagedUser) => {
        setUsers((current) => current.map((candidate) => candidate.id === user.id ? user : candidate));
    };

    const activeAdminCount = users.filter((user) => user.role === 'admin' && !user.disabled).length;
    // Mirrors the server rule so the controls that would remove the last administrator are disabled.
    const isLastActiveAdmin = (user: ManagedUser) => user.role === 'admin' && !user.disabled && activeAdminCount <= 1;

    // Runs an action on one user and applies the returned account, or removes it when none is returned.
    const runUserAction = async (
        user: ManagedUser,
        request: { path: string; method: string; body?: unknown },
        successMessage: string,
        failureMessage: string,
    ): Promise<boolean> => {
        setBusyUserId(user.id);
        try {
            const response = await sessionFetch(apiUrl(`/api/auth/users/${user.id}${request.path}`), {
                method: request.method,
                headers: request.body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: request.body === undefined ? undefined : JSON.stringify(request.body),
            });
            if (!response.ok) throw new Error(await readError(response, failureMessage));
            const payload = await response.json().catch(() => ({})) as { user?: ManagedUser };
            if (payload.user) {
                replaceUser(payload.user);
            } else {
                setUsers((current) => current.filter((candidate) => candidate.id !== user.id));
            }
            showToast(successMessage, "success");
            return true;
        } catch (error) {
            console.error(failureMessage, error);
            showToast(error instanceof Error ? error.message : failureMessage, "danger");
            return false;
        } finally {
            setBusyUserId(null);
        }
    };

    const openCreate = () => {
        setCreateForm({ username: '', password: '', role: 'read-only', requirePasswordChange: true });
        setCreateOpen(true);
    };

    const createUser = async () => {
        setIsCreating(true);
        try {
            const response = await sessionFetch(apiUrl('/api/auth/users'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createForm),
            });
            if (!response.ok) throw new Error(await readError(response, t("pages.settings.failedToCreateUser")));
            const payload = await response.json() as { user: ManagedUser };
            setUsers((current) => [...current, payload.user].sort((left, right) => left.username.localeCompare(right.username)));
            setCreateOpen(false);
            showToast(t("pages.settings.userCreated", { username: payload.user.username }), "success");
        } catch (error) {
            console.error("Failed to create user", error);
            showToast(error instanceof Error ? error.message : t("pages.settings.failedToCreateUser"), "danger");
        } finally {
            setIsCreating(false);
        }
    };

    const openPasswordReset = (user: ManagedUser) => {
        setPasswordForm({ password: '', requirePasswordChange: true });
        setPasswordUser(user);
    };

    const resetPassword = async () => {
        if (!passwordUser) return;
        setIsResettingPassword(true);
        const reset = await runUserAction(
            passwordUser,
            { path: '/password', method: 'POST', body: passwordForm },
            t("pages.settings.userPasswordReset", { username: passwordUser.username }),
            t("pages.settings.failedToResetUserPassword"),
        );
        setIsResettingPassword(false);
        if (reset) setPasswordUser(null);
    };

    const runConfirmedAction = async () => {
        if (!confirm) return;
        const { action, user } = confirm;
        const done = action === 'delete'
            ? await runUserAction(user, { path: '', method: 'DELETE' }, t("pages.settings.userDeleted", { username: user.username }), t("pages.settings.failedToUpdateUser"))
            : action === 'reset-mfa'
                ? await runUserAction(user, { path: '/reset-mfa', method: 'POST' }, t("pages.settings.userMfaReset", { username: user.username }), t("pages.settings.failedToUpdateUser"))
                : await runUserAction(user, { path: '', method: 'PATCH', body: { disabled: true } }, t("pages.settings.userDisabled", { username: user.username }), t("pages.settings.failedToUpdateUser"));
        if (done) setConfirm(null);
    };

    const confirmTitle = confirm?.action === 'delete'
        ? t("pages.settings.deleteUserTitle")
        : confirm?.action === 'reset-mfa'
            ? t("pages.settings.resetUserMfaTitle")
            : t("pages.settings.disableUserTitle");
    const confirmDescription = !confirm ? '' : confirm.action === 'delete'
        ? t(confirm.user.source === 'oidc' ? "pages.settings.deleteOidcUserDescription" : "pages.settings.deleteUserDescription", { username: confirm.user.username })
        : confirm.action === 'reset-mfa'
            ? t("pages.settings.resetUserMfaDescription", { username: confirm.user.username })
            : t("pages.settings.disableUserDescription", { username: confirm.user.username });

    return (
        <Card className="overflow-visible">
            <CardHeader className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <CardTitle>{t("pages.settings.users")}</CardTitle>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("pages.settings.usersDescription")}</p>
                </div>
                <button type="button" onClick={openCreate} disabled={!canManage} className={primaryButtonClass}>
                    <UserPlus className="h-4 w-4" />
                    {t("pages.settings.addUser")}
                </button>
            </CardHeader>
            <CardContent className="space-y-3">
                {isLoading ? (
                    <div className="flex justify-center py-8">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
                    </div>
                ) : users.map((user) => {
                    const local = user.source === 'local';
                    const busy = busyUserId === user.id;
                    const editable = canManage && local && !user.current && !busy;
                    const lastAdmin = isLastActiveAdmin(user);
                    const actions: UserAction[] = [
                        ...(local ? [
                            {
                                key: 'password',
                                icon: KeyRound,
                                label: t("pages.settings.resetUserPassword"),
                                onSelect: () => openPasswordReset(user),
                                disabled: !editable,
                            },
                            {
                                key: 'reset-mfa',
                                icon: ShieldOff,
                                label: t("pages.settings.resetUserMfa"),
                                onSelect: () => setConfirm({ action: 'reset-mfa' as const, user }),
                                disabled: !editable || (!user.totpEnabled && user.passkeyCount === 0),
                            },
                            user.disabled ? {
                                key: 'enable',
                                icon: UserCheck,
                                label: t("pages.settings.enableUser"),
                                onSelect: () => void runUserAction(
                                    user,
                                    { path: '', method: 'PATCH', body: { disabled: false } },
                                    t("pages.settings.userEnabled", { username: user.username }),
                                    t("pages.settings.failedToUpdateUser"),
                                ),
                                disabled: !editable,
                            } : {
                                key: 'disable',
                                icon: UserX,
                                label: t("pages.settings.disableUser"),
                                onSelect: () => setConfirm({ action: 'disable' as const, user }),
                                disabled: !editable || lastAdmin,
                            },
                        ] : []),
                        {
                            key: 'delete',
                            icon: Trash2,
                            label: t("pages.settings.deleteUser"),
                            onSelect: () => setConfirm({ action: 'delete', user }),
                            disabled: busy || lastAdmin,
                            danger: true,
                        },
                    ];
                    // Your own account is managed under My account, so it has no actions here.
                    const showActions = canManage && !user.current;
                    return (
                        <div
                            key={user.id}
                            data-testid={`settings-user-${user.username}`}
                            className={`flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50 sm:flex-row sm:items-center sm:gap-4 ${user.disabled ? 'opacity-70' : ''}`}
                        >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                                <span
                                    aria-hidden="true"
                                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-sm font-semibold uppercase text-primary-700 dark:bg-primary-900/40 dark:text-primary-300"
                                >
                                    {user.username.charAt(0)}
                                </span>
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{user.username}</span>
                                        {user.current && <Badge variant="info">{t("pages.settings.userYou")}</Badge>}
                                        <Badge variant="outline">{local ? t("pages.settings.userSourceLocal") : t("pages.settings.userSourceOidc")}</Badge>
                                        {user.disabled && <Badge variant="danger">{t("common.disabled")}</Badge>}
                                        {user.passwordChangeRequired && <Badge variant="warning">{t("pages.settings.userPasswordChangePending")}</Badge>}
                                        {user.totpEnabled && <Badge variant="secondary">{t("pages.settings.userTotp")}</Badge>}
                                        {user.passkeyCount > 0 && (
                                            <Badge variant="secondary">{t("pages.settings.userPasskeyCount", { count: user.passkeyCount })}</Badge>
                                        )}
                                    </div>
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        {local
                                            ? t("pages.settings.userCreatedAt", { date: formatDate(user.createdAt) })
                                            : t("pages.settings.userOidcHint", { date: formatDate(user.createdAt) })}
                                    </p>
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
                                <div className="w-36">
                                    {canManage && local && !user.current ? (
                                        <>
                                            <label htmlFor={`settings-user-role-${user.id}`} className="sr-only">
                                                {t("pages.settings.userRoleFor", { username: user.username })}
                                            </label>
                                            <select
                                                id={`settings-user-role-${user.id}`}
                                                value={user.role}
                                                onChange={(event) => void runUserAction(
                                                    user,
                                                    { path: '', method: 'PATCH', body: { role: event.target.value } },
                                                    t("pages.settings.userRoleChanged", { username: user.username }),
                                                    t("pages.settings.failedToUpdateUser"),
                                                )}
                                                disabled={busy || lastAdmin}
                                                className={inputClass}
                                            >
                                                <option value="admin">{t("pages.settings.userRoleAdmin")}</option>
                                                <option value="read-only">{t("pages.settings.userRoleReadOnly")}</option>
                                            </select>
                                        </>
                                    ) : (
                                        <span
                                            data-testid={`settings-user-role-${user.username}`}
                                            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200"
                                        >
                                            {user.role === 'admin'
                                                ? <ShieldCheck className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                                                : <Eye className="h-4 w-4 text-gray-500 dark:text-gray-400" aria-hidden="true" />}
                                            {user.role === 'admin' ? t("pages.settings.userRoleAdmin") : t("pages.settings.userRoleReadOnly")}
                                        </span>
                                    )}
                                </div>
                                <div className="w-9">
                                    {showActions && (
                                        <UserActionsMenu
                                            label={t("pages.settings.userActionsFor", { username: user.username })}
                                            actions={actions}
                                            disabled={busy}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {!canManage && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{t("pages.settings.readOnlyUsers")}</span>
                    </div>
                )}
            </CardContent>

            <Modal isOpen={createOpen} onClose={() => !isCreating && setCreateOpen(false)} title={t("pages.settings.addUser")}>
                <form
                    className="space-y-5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void createUser();
                    }}
                >
                    <div className="space-y-2">
                        <label htmlFor="new-user-username" className={labelClass}>{t("pages.login.username")}</label>
                        <input
                            id="new-user-username"
                            value={createForm.username}
                            onChange={(event) => setCreateForm((current) => ({ ...current, username: event.target.value }))}
                            disabled={isCreating}
                            autoComplete="off"
                            maxLength={128}
                            className={inputClass}
                            autoFocus
                        />
                    </div>
                    <div className="space-y-2">
                        <label htmlFor="new-user-password" className={labelClass}>{t("pages.settings.initialPassword")}</label>
                        <input
                            id="new-user-password"
                            type="password"
                            value={createForm.password}
                            onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
                            disabled={isCreating}
                            autoComplete="new-password"
                            className={inputClass}
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.passwordRequirements")}</p>
                    </div>
                    <div className="space-y-2">
                        <label htmlFor="new-user-role" className={labelClass}>{t("pages.settings.userRole")}</label>
                        <select
                            id="new-user-role"
                            value={createForm.role}
                            onChange={(event) => setCreateForm((current) => ({ ...current, role: event.target.value as UserRole }))}
                            disabled={isCreating}
                            className={inputClass}
                        >
                            <option value="read-only">{t("pages.settings.userRoleReadOnly")}</option>
                            <option value="admin">{t("pages.settings.userRoleAdmin")}</option>
                        </select>
                    </div>
                    <RequirePasswordChangeCheckbox
                        id="new-user-require-change"
                        checked={createForm.requirePasswordChange}
                        onChange={(checked) => setCreateForm((current) => ({ ...current, requirePasswordChange: checked }))}
                        disabled={isCreating}
                        label={t("pages.settings.requirePasswordChange")}
                    />
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button type="button" onClick={() => setCreateOpen(false)} disabled={isCreating} className={secondaryButtonClass}>
                            {t("common.cancel")}
                        </button>
                        <button
                            type="submit"
                            disabled={isCreating || !createForm.username.trim() || !createForm.password}
                            className={primaryButtonClass}
                        >
                            <UserPlus className="h-4 w-4" />
                            {isCreating ? t("common.saving") : t("pages.settings.createUser")}
                        </button>
                    </div>
                </form>
            </Modal>

            <Modal
                isOpen={passwordUser !== null}
                onClose={() => !isResettingPassword && setPasswordUser(null)}
                title={t("pages.settings.resetUserPassword")}
            >
                <form
                    className="space-y-5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void resetPassword();
                    }}
                >
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t("pages.settings.resetUserPasswordDescription", { username: passwordUser?.username ?? '' })}
                    </p>
                    <div className="space-y-2">
                        <label htmlFor="reset-user-password" className={labelClass}>{t("pages.settings.newPassword")}</label>
                        <input
                            id="reset-user-password"
                            type="password"
                            value={passwordForm.password}
                            onChange={(event) => setPasswordForm((current) => ({ ...current, password: event.target.value }))}
                            disabled={isResettingPassword}
                            autoComplete="new-password"
                            className={inputClass}
                            autoFocus
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t("pages.settings.passwordRequirements")}</p>
                    </div>
                    <RequirePasswordChangeCheckbox
                        id="reset-user-require-change"
                        checked={passwordForm.requirePasswordChange}
                        onChange={(checked) => setPasswordForm((current) => ({ ...current, requirePasswordChange: checked }))}
                        disabled={isResettingPassword}
                        label={t("pages.settings.requirePasswordChange")}
                    />
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button type="button" onClick={() => setPasswordUser(null)} disabled={isResettingPassword} className={secondaryButtonClass}>
                            {t("common.cancel")}
                        </button>
                        <button type="submit" disabled={isResettingPassword || !passwordForm.password} className={primaryButtonClass}>
                            <KeyRound className="h-4 w-4" />
                            {isResettingPassword ? t("common.saving") : t("pages.settings.resetUserPassword")}
                        </button>
                    </div>
                </form>
            </Modal>

            <Modal isOpen={confirm !== null} onClose={() => busyUserId === null && setConfirm(null)} title={confirmTitle}>
                <div className="space-y-5">
                    <p className="text-sm text-gray-500 dark:text-gray-400">{confirmDescription}</p>
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button type="button" onClick={() => setConfirm(null)} disabled={busyUserId !== null} className={secondaryButtonClass}>
                            {t("common.cancel")}
                        </button>
                        <button type="button" onClick={() => void runConfirmedAction()} disabled={busyUserId !== null} className={dangerButtonClass}>
                            {confirm?.action === 'delete' && <Trash2 className="h-4 w-4" />}
                            {confirm?.action === 'reset-mfa' && <ShieldOff className="h-4 w-4" />}
                            {confirm?.action === 'disable' && <UserX className="h-4 w-4" />}
                            {confirm?.action === 'delete'
                                ? t("common.delete")
                                : confirm?.action === 'reset-mfa'
                                    ? t("pages.settings.resetUserMfa")
                                    : t("pages.settings.disableUser")}
                        </button>
                    </div>
                </div>
            </Modal>
        </Card>
    );
}

function RequirePasswordChangeCheckbox({ id, checked, onChange, disabled, label }: {
    id: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled: boolean;
    label: string;
}) {
    return (
        <label htmlFor={id} className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-200">
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                disabled={disabled}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <span>{label}</span>
        </label>
    );
}

function UserActionsMenu({ label, actions, disabled }: { label: string; actions: UserAction[]; disabled: boolean }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', closeOnOutsideClick);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOnOutsideClick);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [open]);

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                disabled={disabled}
                className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <MoreVertical className="h-4 w-4" />
            </button>
            {open && (
                <div
                    role="menu"
                    aria-label={label}
                    className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
                >
                    {actions.map(({ key, icon: Icon, label: actionLabel, onSelect, disabled: actionDisabled, danger }) => (
                        <Fragment key={key}>
                            {danger && <div role="separator" className="my-1 border-t border-gray-100 dark:border-gray-700" />}
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setOpen(false);
                                    onSelect();
                                }}
                                disabled={actionDisabled}
                                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${danger
                                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
                                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'}`}
                            >
                                <Icon className="h-4 w-4 shrink-0" />
                                {actionLabel}
                            </button>
                        </Fragment>
                    ))}
                </div>
            )}
        </div>
    );
}
