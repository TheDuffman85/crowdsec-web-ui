import { useState, type FormEvent } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../lib/basePath';
import { AppLogo } from '../components/AppLogo';
import { useBranding } from '../contexts/useBranding';
import { useI18n } from '../lib/i18n';

const inputClass = "w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/40";
const labelClass = "block text-xs font-semibold uppercase tracking-wide text-gray-400";

// Shown after signing in with a password an administrator set, until the user picks their own.
export function PasswordChange() {
  const { user, refresh, logout } = useAuth();
  const { t } = useI18n();
  const { appName } = useBranding();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (form.newPassword !== form.confirmPassword) {
      setError(t('pages.settings.passwordsDoNotMatch'));
      return;
    }
    if (form.newPassword === form.currentPassword) {
      setError(t('pages.settings.newPasswordMustDiffer'));
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch(apiUrl('/api/auth/change-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || t('pages.settings.failedToChangePassword'));
      }
      await refresh();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : t('pages.settings.failedToChangePassword'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4 text-gray-100">
      <div className="w-full max-w-sm rounded-xl border border-gray-800 bg-gray-900 p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <AppLogo className="mx-auto h-14 w-14" />
          <p className="mt-4 break-words text-sm font-medium text-gray-400">{appName}</p>
          <h1 className="mt-1 text-2xl font-bold">{t('pages.passwordChange.title')}</h1>
          <p className="mt-1 text-sm text-gray-400">{t('pages.passwordChange.subtitle', { username: user?.username ?? '' })}</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="password-change-current" className={labelClass}>{t('pages.settings.currentPassword')}</label>
            <input
              id="password-change-current"
              type="password"
              value={form.currentPassword}
              onChange={(event) => setForm((current) => ({ ...current, currentPassword: event.target.value }))}
              required
              autoComplete="current-password"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password-change-new" className={labelClass}>{t('pages.settings.newPassword')}</label>
            <input
              id="password-change-new"
              type="password"
              value={form.newPassword}
              onChange={(event) => setForm((current) => ({ ...current, newPassword: event.target.value }))}
              required
              autoComplete="new-password"
              className={inputClass}
            />
            <p className="text-xs text-gray-500">{t('pages.settings.passwordRequirements')}</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password-change-confirm" className={labelClass}>{t('pages.settings.confirmPassword')}</label>
            <input
              id="password-change-confirm"
              type="password"
              value={form.confirmPassword}
              onChange={(event) => setForm((current) => ({ ...current, confirmPassword: event.target.value }))}
              required
              autoComplete="new-password"
              className={inputClass}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <KeyRound className="h-4 w-4" />
            {t('pages.settings.changePassword')}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={isLoading}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 text-sm font-semibold text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" />
            {t('pages.passwordChange.signOut')}
          </button>
        </form>
      </div>
    </div>
  );
}
