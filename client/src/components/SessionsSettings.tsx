import { useCallback, useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Badge } from './ui/Badge';
import { apiUrl } from '../lib/basePath';
import { sessionFetch } from '../lib/sessionFetch';
import { useI18n } from '../lib/i18n';
import { useDateTime } from '../lib/dateTime';

export interface ActiveSession {
  id: string;
  user_id: number;
  username: string;
  method: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

interface SessionsSettingsProps {
  /** Administrators see everyone's sessions and can end any of them. */
  canManage: boolean;
  showToast: (message: string, type?: 'success' | 'danger' | 'info') => void;
}

const METHOD_LABEL_KEYS: Record<string, string> = {
  password: 'components.sessions.methodPassword',
  passkey: 'components.sessions.methodPasskey',
  oidc: 'components.sessions.methodOidc',
};

/** Signed-in sessions with the device and address they came from, and a button to end them. */
export function SessionsSettings({ canManage, showToast }: SessionsSettingsProps) {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await sessionFetch(apiUrl(`/api/auth/sessions${canManage ? '?all=1' : ''}`));
      if (!response.ok) throw new Error('failed');
      setSessions((await response.json() as { sessions: ActiveSession[] }).sessions);
    } catch {
      setSessions([]);
      showToast(t('components.sessions.loadFailed'), 'danger');
    }
  }, [canManage, showToast, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const revoke = async (session: ActiveSession) => {
    setBusyId(session.id);
    try {
      const response = await sessionFetch(apiUrl(`/api/auth/sessions/${encodeURIComponent(session.id)}`), { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || t('components.sessions.revokeFailed'));
      }
      showToast(t('components.sessions.revoked'), 'success');
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('components.sessions.revokeFailed'), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('components.sessions.title')}</CardTitle>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {canManage ? t('components.sessions.descriptionAdmin') : t('components.sessions.description')}
        </p>
      </CardHeader>
      <CardContent>
        {sessions === null && <p className="text-sm text-gray-500 dark:text-gray-400">{t('app.loading')}</p>}
        {sessions?.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">{t('components.sessions.empty')}</p>}
        <ul className="divide-y divide-gray-200 dark:divide-gray-700" data-testid="sessions-list">
          {sessions?.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{session.username}</span>
                  {session.current && <Badge variant="info">{t('components.sessions.thisSession')}</Badge>}
                  {session.method && <Badge variant="outline">{t(METHOD_LABEL_KEYS[session.method] ?? 'components.sessions.methodOther')}</Badge>}
                </div>
                <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400" title={session.user_agent ?? undefined}>
                  {session.user_agent ?? t('components.sessions.unknownDevice')}{session.ip ? ` · ${session.ip}` : ''}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('components.sessions.times', { started: formatDateTime(session.created_at), active: formatDateTime(session.last_seen_at) })}
                </p>
              </div>
              <button
                type="button"
                disabled={busyId === session.id}
                onClick={() => void revoke(session)}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                aria-label={t('components.sessions.revokeLabel', { user: session.username })}
              >
                <LogOut size={16} aria-hidden="true" />
                {session.current ? t('components.sessions.signOut') : t('components.sessions.revoke')}
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
