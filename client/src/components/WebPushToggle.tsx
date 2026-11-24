import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { disablePush, enablePush, fetchPushStatus, pushSupport, type PushStatus } from '../lib/webPush';

interface Loaded { status: PushStatus; permission: NotificationPermission; browserSubscribed: boolean }

/** Turns Web Push on or off for the browser being used, and says plainly when that is not possible. */
export function WebPushToggle() {
  const { t } = useI18n();
  const support = pushSupport();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoaded(await fetchPushStatus());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('pages.notifications.webpush.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (support !== 'ok') return;
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [support, refresh]);

  if (support === 'insecure') return <p role="note" className="text-sm text-amber-700 dark:text-amber-400">{t('pages.notifications.webpush.needsHttps')}</p>;
  if (support === 'unsupported') return <p role="note" className="text-sm text-gray-500 dark:text-gray-400">{t('pages.notifications.webpush.unsupported')}</p>;

  const toggle = async () => {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      if (loaded.browserSubscribed) await disablePush();
      else await enablePush(loaded.status.public_key);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error && failure.message === 'permission-denied'
        ? t('pages.notifications.webpush.denied')
        : failure instanceof Error ? failure.message : t('pages.notifications.webpush.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="webpush-toggle">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {loaded ? t('pages.notifications.webpush.count', { count: loaded.status.subscriptions }) : t('app.loading')}
      </p>
      {loaded?.permission === 'denied' && <p role="note" className="text-sm text-amber-700 dark:text-amber-400">{t('pages.notifications.webpush.blocked')}</p>}
      <button
        type="button"
        onClick={() => { void toggle(); }}
        disabled={!loaded || busy || loaded.permission === 'denied'}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
      >
        {loaded?.browserSubscribed ? t('pages.notifications.webpush.disable') : t('pages.notifications.webpush.enable')}
      </button>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
