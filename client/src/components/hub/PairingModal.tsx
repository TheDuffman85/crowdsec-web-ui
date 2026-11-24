import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { fetchHubServers, startHubPairing, type HubPairing, type HubProfile, type HubServer, type HubServers } from '../../lib/insightsApi';
import { useI18n } from '../../lib/i18n';
import { CommandBlock } from './CopyCommand';

const INPUT = 'w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800';
const POLL_MS = 4000;

interface PairingModalProps {
  /** The machine to set up. Null closes the dialog. */
  machine: HubServer | null;
  profiles: HubProfile[];
  ttlMinutes: number;
  uninstallCommand: string;
  profileLabel: (id: string) => string;
  onClose: () => void;
  /** Called with the latest server list each time it is polled while a command is waiting to be used. */
  onServers: (servers: HubServers) => void;
}

/** Creates the one-time install command for a machine and waits for it to report in. */
export function PairingModal({ machine, profiles, ttlMinutes, uninstallCommand, profileLabel, onClose, onServers }: PairingModalProps) {
  const { t, language } = useI18n();
  // The form restarts for each machine because the parent remounts it with a key.
  const [name, setName] = useState(machine?.name ?? '');
  const [from, setFrom] = useState('');
  const [profile, setProfile] = useState('');
  const [applyProfile, setApplyProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<HubPairing | null>(null);
  const [paired, setPaired] = useState(false);

  const serverId = pairing?.server.id ?? null;
  useEffect(() => {
    if (!serverId || paired) return;
    const timer = window.setInterval(() => {
      void fetchHubServers().then((servers) => {
        onServers(servers);
        const current = servers.servers.find((server) => server.id === serverId);
        if (current && current.status !== 'pending') setPaired(true);
      }).catch(() => { /* Keep waiting; the next poll may work. */ });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [serverId, paired, onServers]);

  if (!machine) return null;
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await startHubPairing({
        machine: machine.machine ?? machine.name,
        name: name.trim() && name.trim() !== machine.name ? name.trim() : undefined,
        from: from.trim() || undefined,
        profile: profile || undefined,
        applyProfile,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('tools.hub.pair.failed'));
    } finally {
      setBusy(false);
    }
  };

  const insecure = typeof window !== 'undefined' && window.location.protocol === 'http:';
  return (
    <Modal isOpen onClose={onClose} title={t('tools.hub.pair.title', { name: machine.name })} maxWidth="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-700 dark:text-gray-300">{t('tools.hub.pair.intro')}</p>
        {!pairing && (
          <div className="space-y-3">
            <label className="block text-sm"><span className="mb-1 block text-gray-700 dark:text-gray-300">{t('tools.hub.pair.name')}</span>
              <input className={INPUT} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block text-sm"><span className="mb-1 block text-gray-700 dark:text-gray-300">{t('tools.hub.pair.from')}</span>
              <input className={INPUT} value={from} placeholder="192.168.0.200" onChange={(event) => setFrom(event.target.value)} />
              <span className="mt-1 block text-xs text-gray-500">{t('tools.hub.pair.fromHint')}</span>
            </label>
            <label className="block text-sm"><span className="mb-1 block text-gray-700 dark:text-gray-300">{t('tools.hub.pair.profile')}</span>
              <select className={INPUT} value={profile} onChange={(event) => { setProfile(event.target.value); if (!event.target.value) setApplyProfile(false); }}>
                <option value="">{t('tools.hub.pair.profileNone')}</option>
                {profiles.map((item) => <option key={item.id} value={item.id}>{profileLabel(item.id)}</option>)}
              </select>
            </label>
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" className="mt-1" checked={applyProfile} disabled={!profile} onChange={(event) => setApplyProfile(event.target.checked)} />
              <span>{t('tools.hub.pair.applyProfile')}<span className="block text-xs text-gray-500">{t('tools.hub.pair.applyHint')}</span></span>
            </label>
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">{t('tools.hub.cancel')}</button>
              <button type="button" disabled={busy} onClick={() => { void generate(); }} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {busy ? t('tools.hub.pair.generating') : t('tools.hub.pair.generate')}
              </button>
            </div>
          </div>
        )}
        {pairing && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('tools.hub.pair.commandLabel', { name: pairing.server.name })}</p>
            <CommandBlock command={pairing.command} label={t('tools.hub.pair.copyCommand')} />
            <p className="text-xs text-gray-500">{t('tools.hub.pair.expires', { minutes: ttlMinutes, time: new Date(pairing.token_expires_at).toLocaleTimeString(language) })}</p>
            {insecure && <p className="text-xs text-amber-700 dark:text-amber-300">{t('tools.hub.pair.httpWarning')}</p>}
            <p role="status" className={`text-sm font-medium ${paired ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-600 dark:text-gray-300'}`} data-testid="hub-pair-status">
              {paired ? t('tools.hub.pair.done', { name: pairing.server.name }) : t('tools.hub.pair.waiting')}
            </p>
            <div className="space-y-1 border-t border-gray-200 pt-3 dark:border-gray-700">
              <p className="text-xs text-gray-500">{t('tools.hub.pair.uninstallTitle')}</p>
              <CommandBlock command={uninstallCommand} label={t('tools.hub.pair.copyUninstall')} />
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">{t('tools.hub.pair.close')}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
