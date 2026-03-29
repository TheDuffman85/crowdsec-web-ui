import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, CheckCheck, Plus, Send, SendHorizontal, SquarePen, Trash2 } from 'lucide-react';
import {
  createNotificationChannel,
  createNotificationRule,
  deleteNotificationChannel,
  deleteNotificationRule,
  fetchNotifications,
  fetchNotificationSettings,
  markAllNotificationsRead,
  markNotificationRead,
  testNotificationChannel,
  updateNotificationChannel,
  updateNotificationRule,
} from '../lib/api';
import {
  coerceEmailConfig,
  coerceGotifyConfig,
  coerceMqttConfig,
  coerceNtfyConfig,
  coerceWebhookConfig,
  defaultChannelConfig,
  hasStoredSecret,
  STORED_SECRET_SENTINEL,
  validateNotificationChannelConfig,
  type EmailConfig,
  type GotifyConfig,
  type MqttConfig,
  type NtfyConfig,
  type WebhookAuthConfig,
  type WebhookBodyConfig,
  type WebhookConfig,
  type WebhookField,
} from '../lib/notification-config';
import { useRefresh } from '../contexts/useRefresh';
import { Badge } from '../components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Switch } from '../components/ui/Switch';
import type {
  AlertMetaValue,
  NotificationChannel,
  NotificationChannelType,
  NotificationItem,
  NotificationRule,
  NotificationRuleType,
  NotificationSeverity,
  UpsertNotificationRuleRequest,
} from '../types';

type ChannelFormState = {
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, AlertMetaValue>;
};

type RuleFormState = {
  name: string;
  type: NotificationRuleType;
  enabled: boolean;
  severity: NotificationSeverity;
  channel_ids: string[];
  filters: { scenario: string; target: string; include_simulated: boolean };
  config: Record<string, string>;
};

type ToastState = {
  message: string;
  tone: 'error' | 'success';
} | null;

const RULE_DEFAULTS: Record<NotificationRuleType, Record<string, string>> = {
  'alert-spike': { window_minutes: '60', percent_increase: '100', minimum_current_alerts: '10' },
  'alert-threshold': { window_minutes: '60', alert_threshold: '25' },
  'new-cve': { max_cve_age_days: '14' },
  'application-update': {},
};

const defaultChannelForm = (type: NotificationChannelType = 'ntfy'): ChannelFormState => ({
  name: '',
  type,
  enabled: true,
  config: cloneConfig(defaultChannelConfig(type)),
});

const defaultRuleForm = (type: NotificationRuleType = 'alert-spike'): RuleFormState => ({
  name: '',
  type,
  enabled: true,
  severity: 'warning',
  channel_ids: [],
  filters: { scenario: '', target: '', include_simulated: false },
  config: { ...RULE_DEFAULTS[type] },
});

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildRulePayload(ruleForm: RuleFormState): UpsertNotificationRuleRequest {
  const basePayload = {
    name: ruleForm.name,
    type: ruleForm.type,
    enabled: ruleForm.enabled,
    severity: ruleForm.severity,
    channel_ids: ruleForm.channel_ids,
  } as const;
  const filters = {
    scenario: ruleForm.filters.scenario.trim(),
    target: ruleForm.filters.target.trim(),
    include_simulated: ruleForm.filters.include_simulated,
  };

  if (ruleForm.type === 'alert-spike') {
    return {
      ...basePayload,
      type: 'alert-spike',
      config: {
        window_minutes: Number(ruleForm.config.window_minutes || '0'),
        percent_increase: Number(ruleForm.config.percent_increase || '0'),
        minimum_current_alerts: Number(ruleForm.config.minimum_current_alerts || '0'),
        filters,
      },
    };
  }

  if (ruleForm.type === 'alert-threshold') {
    return {
      ...basePayload,
      type: 'alert-threshold',
      config: {
        window_minutes: Number(ruleForm.config.window_minutes || '0'),
        alert_threshold: Number(ruleForm.config.alert_threshold || '0'),
        filters,
      },
    };
  }

  if (ruleForm.type === 'application-update') {
    return {
      ...basePayload,
      type: 'application-update',
      config: {},
    };
  }

  return {
    ...basePayload,
    type: 'new-cve',
    config: {
      max_cve_age_days: Number(ruleForm.config.max_cve_age_days || '0'),
      filters,
    },
  };
}

export function Notifications() {
  const { refreshSignal } = useRefresh();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null);
  const [editingRule, setEditingRule] = useState<NotificationRule | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelFormState>(defaultChannelForm());
  const [ruleForm, setRuleForm] = useState<RuleFormState>(defaultRuleForm());
  const [toast, setToast] = useState<ToastState>(null);
  const [saving, setSaving] = useState(false);
  const linkedChannelIds = new Set(rules.flatMap((rule) => rule.channel_ids));

  const showToast = useCallback((message: string, tone: 'error' | 'success' = 'error') => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 3500);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [settings, notificationList] = await Promise.all([fetchNotificationSettings(), fetchNotifications()]);
      setChannels(settings.channels);
      setRules(settings.rules);
      setNotifications(notificationList.notifications);
      setUnreadCount(notificationList.unread_count);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (refreshSignal > 0) {
      void loadData();
    }
  }, [refreshSignal, loadData]);

  const openCreateChannel = () => {
    setEditingChannel(null);
    setChannelForm(defaultChannelForm());
    setChannelModalOpen(true);
  };

  const openCreateRule = () => {
    setEditingRule(null);
    setRuleForm(defaultRuleForm());
    setRuleModalOpen(true);
  };

  const openEditChannel = (channel: NotificationChannel) => {
    setEditingChannel(channel);
    setChannelForm({
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
      config: cloneConfig(channel.config),
    });
    setChannelModalOpen(true);
  };

  const openEditRule = (rule: NotificationRule) => {
    setEditingRule(rule);
    const filters = 'filters' in rule.config && rule.config.filters ? rule.config.filters : undefined;
    setRuleForm({
      name: rule.name,
      type: rule.type,
      enabled: rule.enabled,
      severity: rule.severity,
      channel_ids: [...rule.channel_ids],
      filters: {
        scenario: filters?.scenario || '',
        target: filters?.target || '',
        include_simulated: filters?.include_simulated === true,
      },
      config: Object.fromEntries(
        Object.entries(rule.config)
          .filter(([key]) => key !== 'filters')
          .map(([key, value]) => [key, String(value ?? '')]),
      ),
    });
    setRuleModalOpen(true);
  };

  const saveChannel = async () => {
    try {
      setSaving(true);
      const validationError = validateNotificationChannelConfig(channelForm.type, channelForm.config);
      if (validationError) {
        throw new Error(validationError);
      }

      const payload = {
        name: channelForm.name,
        type: channelForm.type,
        enabled: channelForm.enabled,
        config: channelForm.config,
      };

      if (editingChannel) {
        await updateNotificationChannel(editingChannel.id, payload);
      } else {
        await createNotificationChannel(payload);
      }

      setChannelModalOpen(false);
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save destination');
    } finally {
      setSaving(false);
    }
  };

  const saveRule = async () => {
    try {
      setSaving(true);
      const payload = buildRulePayload(ruleForm);
      if (editingRule) {
        await updateNotificationRule(editingRule.id, payload);
      } else {
        await createNotificationRule(payload);
      }
      setRuleModalOpen(false);
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const sendTestNotification = async (channel: NotificationChannel) => {
    try {
      await testNotificationChannel(channel.id);
      await loadData();
      showToast(`Test notification sent to ${channel.name}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to send test notification');
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading notifications...</div>;
  }

  return (
    <div className="space-y-6">
      {toast && <ToastBanner toast={toast} onClose={() => setToast(null)} />}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <SummaryCard icon={<Bell className="h-6 w-6" />} label="Unread Notifications" value={String(unreadCount)} />
        <SummaryCard
          icon={<Send className="h-6 w-6" />}
          label="Destinations"
          value={String(channels.length)}
          sublabel={`${channels.filter((channel) => channel.enabled).length} active`}
        />
        <SummaryCard
          icon={<CheckCheck className="h-6 w-6" />}
          label="Rules"
          value={String(rules.length)}
          sublabel={`${rules.filter((rule) => rule.enabled).length} active`}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent Notifications</CardTitle>
          <button
            onClick={() => void markAllNotificationsRead().then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to mark notifications as read'))}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
          >
            <CheckCheck className="h-4 w-4" />
            Mark All Read
          </button>
        </CardHeader>
        <CardContent className="space-y-4">
          {notifications.length === 0
            ? <p className="text-sm text-gray-500 dark:text-gray-400">No notifications yet.</p>
            : notifications.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                onMarkRead={() => void markNotificationRead(item.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to mark notification as read'))}
              />
            ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <ResourceCard title="Destinations" actionLabel="Add Destination" onAction={openCreateChannel}>
          {channels.length === 0
            ? <p className="text-sm text-gray-500 dark:text-gray-400">No outbound destinations configured yet.</p>
            : channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                hasAttachedRule={linkedChannelIds.has(channel.id)}
                onEdit={() => openEditChannel(channel)}
                onTest={() => void sendTestNotification(channel)}
                onDelete={() => void deleteNotificationChannel(channel.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to delete destination'))}
              />
            ))}
        </ResourceCard>

        <ResourceCard title="Rules" actionLabel="Add Rule" onAction={openCreateRule}>
          {rules.length === 0
            ? <p className="text-sm text-gray-500 dark:text-gray-400">No notification rules configured yet.</p>
            : rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                channels={channels}
                hasDestinations={rule.channel_ids.length > 0}
                onEdit={() => openEditRule(rule)}
                onDelete={() => void deleteNotificationRule(rule.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to delete rule'))}
              />
            ))}
        </ResourceCard>
      </div>

      <ChannelModal
        open={channelModalOpen}
        editingChannel={editingChannel}
        form={channelForm}
        saving={saving}
        onClose={() => setChannelModalOpen(false)}
        onSave={() => void saveChannel()}
        onSetForm={setChannelForm}
      />
      <RuleModal
        open={ruleModalOpen}
        editingRule={editingRule}
        form={ruleForm}
        channels={channels}
        saving={saving}
        onClose={() => setRuleModalOpen(false)}
        onSave={() => void saveRule()}
        onSetForm={setRuleForm}
      />
    </div>
  );
}

function SummaryCard({ icon, label, value, sublabel }: { icon: ReactNode; label: string; value: string; sublabel?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-6">
        <div className="rounded-full bg-blue-100 p-3 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{icon}</div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
          <p className="text-3xl font-bold">{value}</p>
          {sublabel && <p className="text-xs text-gray-500 dark:text-gray-400">{sublabel}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function ResourceCard({ title, actionLabel, onAction, children }: { title: string; actionLabel: string; onAction: () => void; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <button onClick={onAction} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700">
          <Plus className="h-4 w-4" />
          {actionLabel}
        </button>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function NotificationRow({ item, onMarkRead }: { item: NotificationItem; onMarkRead: () => void }) {
  return (
    <div className={`rounded-xl border p-4 ${item.read_at ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800' : 'border-blue-200 bg-blue-50/70 dark:border-blue-900/40 dark:bg-blue-950/20'}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{item.title}</h3>
            <Badge variant={item.severity === 'critical' ? 'danger' : item.severity === 'warning' ? 'warning' : 'info'}>{item.severity}</Badge>
            {!item.read_at && <Badge variant="secondary">Unread</Badge>}
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">{item.message}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">Rule: {item.rule_name} • {new Date(item.created_at).toLocaleString()}</p>
          <div className="flex flex-wrap gap-2">
            {item.deliveries.map((delivery, index) => (
              <Badge key={`${delivery.channel_id}-${index}`} variant={delivery.status === 'delivered' ? 'success' : 'danger'}>
                {delivery.channel_name}: {delivery.status}
              </Badge>
            ))}
          </div>
        </div>
        {!item.read_at && <ActionIconButton label="Mark read" icon={<Check className="h-4 w-4" />} onClick={onMarkRead} variant="accent" />}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  hasAttachedRule,
  onEdit,
  onTest,
  onDelete,
}: {
  channel: NotificationChannel;
  hasAttachedRule: boolean;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{channel.name}</h3>
            <Badge variant={channel.enabled ? 'success' : 'secondary'}>{channel.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <Badge variant="outline">{channel.type}</Badge>
            {!hasAttachedRule && <Badge variant="warning">No rule attached</Badge>}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Updated {new Date(channel.updated_at).toLocaleString()}</p>
          {channel.configured_secrets.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Saved secrets: {channel.configured_secrets.join(', ')}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 md:self-start">
          <ActionIconButton label="Send test notification" icon={<SendHorizontal className="h-4 w-4" />} onClick={onTest} />
          <ActionIconButton label="Edit destination" icon={<SquarePen className="h-4 w-4" />} onClick={onEdit} />
          <ActionIconButton label="Delete destination" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete} variant="danger" />
        </div>
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  channels,
  hasDestinations,
  onEdit,
  onDelete,
}: {
  rule: NotificationRule;
  channels: NotificationChannel[];
  hasDestinations: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{rule.name}</h3>
            <Badge variant={rule.enabled ? 'success' : 'secondary'}>{rule.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <Badge variant="outline">{rule.type}</Badge>
            <Badge variant={rule.severity === 'critical' ? 'danger' : rule.severity === 'warning' ? 'warning' : 'info'}>{rule.severity}</Badge>
            {!hasDestinations && <Badge variant="warning">No destinations</Badge>}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Channels: {rule.channel_ids.map((id) => channels.find((channel) => channel.id === id)?.name || id).join(', ') || 'In-app only'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 md:self-start">
          <ActionIconButton label="Edit rule" icon={<SquarePen className="h-4 w-4" />} onClick={onEdit} />
          <ActionIconButton label="Delete rule" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete} variant="danger" />
        </div>
      </div>
    </div>
  );
}

function ActionIconButton({
  label,
  icon,
  onClick,
  variant = 'neutral',
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'neutral' | 'danger' | 'accent';
}) {
  const styles = {
    neutral: 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700/60',
    danger: 'text-red-600 hover:text-red-900 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20',
    accent: 'text-blue-600 hover:text-blue-800 hover:bg-blue-50 dark:text-blue-400 dark:hover:text-blue-300 dark:hover:bg-blue-900/20',
  } satisfies Record<'neutral' | 'danger' | 'accent', string>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${styles[variant]}`}
    >
      {icon}
    </button>
  );
}

function ToastBanner({ toast, onClose }: { toast: NonNullable<ToastState>; onClose: () => void }) {
  const styles = toast.tone === 'success'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/60 dark:text-emerald-200'
    : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/40 dark:bg-red-950/60 dark:text-red-200';

  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[11000]">
      <div className={`pointer-events-auto flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl ${styles}`}>
        <p className="flex-1">{toast.message}</p>
        <button type="button" onClick={onClose} className="rounded-md px-1 text-current/70 hover:bg-black/5 hover:text-current dark:hover:bg-white/10">
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}

function ChannelModal({
  open,
  editingChannel,
  form,
  saving,
  onClose,
  onSave,
  onSetForm,
}: {
  open: boolean;
  editingChannel: NotificationChannel | null;
  form: ChannelFormState;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  onSetForm: Dispatch<SetStateAction<ChannelFormState>>;
}) {
  return (
    <Modal isOpen={open} onClose={onClose} title={editingChannel ? 'Edit Destination' : 'New Destination'} maxWidth="max-w-4xl">
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <LabeledInput label="Name" value={form.name} onChange={(value) => onSetForm((current) => ({ ...current, name: value }))} />
          <label className="space-y-2 text-sm">
            <span className="font-medium">Type</span>
            <select
              value={form.type}
              onChange={(event) => onSetForm((current) => ({ ...current, type: event.target.value as NotificationChannelType, config: cloneConfig(defaultChannelConfig(event.target.value as NotificationChannelType)) }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="ntfy">ntfy</option>
              <option value="gotify">Gotify</option>
              <option value="email">Email</option>
              <option value="mqtt">MQTT</option>
              <option value="webhook">Webhook</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Switch id="channel-enabled" checked={form.enabled} onCheckedChange={(checked) => onSetForm((current) => ({ ...current, enabled: checked }))} />
          <label htmlFor="channel-enabled" className="text-sm font-medium">Enabled</label>
        </div>

        <ChannelConfigFields form={form} onSetForm={onSetForm} />

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-700">Cancel</button>
          <button onClick={onSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60">
            {saving ? 'Saving...' : 'Save Destination'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RuleModal({
  open,
  editingRule,
  form,
  channels,
  saving,
  onClose,
  onSave,
  onSetForm,
}: {
  open: boolean;
  editingRule: NotificationRule | null;
  form: RuleFormState;
  channels: NotificationChannel[];
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  onSetForm: Dispatch<SetStateAction<RuleFormState>>;
}) {
  const supportsAlertFilters = form.type !== 'application-update';

  return (
    <Modal isOpen={open} onClose={onClose} title={editingRule ? 'Edit Rule' : 'New Rule'} maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <LabeledInput label="Name" value={form.name} onChange={(value) => onSetForm((current) => ({ ...current, name: value }))} />
          <label className="space-y-2 text-sm">
            <span className="font-medium">Rule Type</span>
            <select
              value={form.type}
              onChange={(event) => onSetForm((current) => ({ ...current, type: event.target.value as NotificationRuleType, config: { ...RULE_DEFAULTS[event.target.value as NotificationRuleType] } }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="alert-spike">Alert Spike</option>
              <option value="alert-threshold">Alert Threshold</option>
              <option value="new-cve">Recent CVE</option>
              <option value="application-update">Application Update</option>
            </select>
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-medium">Severity</span>
            <select value={form.severity} onChange={(event) => onSetForm((current) => ({ ...current, severity: event.target.value as NotificationSeverity }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <div className="flex items-center gap-3 pt-7">
            <Switch id="rule-enabled" checked={form.enabled} onCheckedChange={(checked) => onSetForm((current) => ({ ...current, enabled: checked }))} />
            <label htmlFor="rule-enabled" className="text-sm font-medium">Enabled</label>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-medium">Outbound Destinations</p>
          {channels.length === 0
            ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200">
                No outbound destinations exist yet. Create a destination first if this rule should deliver outside the in-app notification list.
              </div>
            )
            : (
              <>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Select one or more destinations. If none are selected, alerts from this rule stay in-app only.
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  {channels.map((channel) => (
                    <label key={channel.id} className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
                      <input
                        type="checkbox"
                        checked={form.channel_ids.includes(channel.id)}
                        onChange={(event) => onSetForm((current) => ({ ...current, channel_ids: event.target.checked ? [...current.channel_ids, channel.id] : current.channel_ids.filter((value) => value !== channel.id) }))}
                      />
                      <span>{channel.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
        </div>
        {supportsAlertFilters && (
          <div className="grid gap-4 md:grid-cols-3">
            <LabeledInput label="Scenario Contains" value={form.filters.scenario} onChange={(value) => onSetForm((current) => ({ ...current, filters: { ...current.filters, scenario: value } }))} />
            <LabeledInput label="Target Contains" value={form.filters.target} onChange={(value) => onSetForm((current) => ({ ...current, filters: { ...current.filters, target: value } }))} />
            <div className="flex items-center gap-3 pt-7">
              <Switch id="rule-include-simulated" checked={form.filters.include_simulated} onCheckedChange={(checked) => onSetForm((current) => ({ ...current, filters: { ...current.filters, include_simulated: checked } }))} />
              <label htmlFor="rule-include-simulated" className="text-sm font-medium">Include simulated alerts</label>
            </div>
          </div>
        )}
        <RuleConfigFields form={form} onChange={(key, value) => onSetForm((current) => ({ ...current, config: { ...current.config, [key]: value } }))} />
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-700">Cancel</button>
          <button onClick={onSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60">{saving ? 'Saving...' : 'Save Rule'}</button>
        </div>
      </div>
    </Modal>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete = 'off',
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const id = useId();
  const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id.replace(/:/g, '');

  return (
    <label className="space-y-2 text-sm" htmlFor={id}>
      <span className="font-medium">{label}</span>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
      />
    </label>
  );
}

function LabeledTextArea({
  label,
  value,
  onChange,
  rows = 6,
  placeholder,
  autoComplete = 'off',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  autoComplete?: string;
}) {
  const id = useId();
  const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id.replace(/:/g, '');

  return (
    <label className="space-y-2 text-sm" htmlFor={id}>
      <span className="font-medium">{label}</span>
      <textarea
        id={id}
        name={name}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
      />
    </label>
  );
}

function SecretInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <LabeledInput
      label={label}
      type="password"
      value={hasStoredSecret(value) ? '' : value}
      placeholder={hasStoredSecret(value) ? '(unchanged)' : undefined}
      autoComplete="new-password"
      onChange={(next) => onChange(next || (hasStoredSecret(value) ? STORED_SECRET_SENTINEL : next))}
    />
  );
}

function updateChannelConfig<T>(
  onSetForm: Dispatch<SetStateAction<ChannelFormState>>,
  buildNext: (current: T) => T,
) {
  onSetForm((current) => ({
    ...current,
    config: buildNext(cloneConfig(current.config) as T) as unknown as Record<string, AlertMetaValue>,
  }));
}

function ChannelConfigFields({
  form,
  onSetForm,
}: {
  form: ChannelFormState;
  onSetForm: Dispatch<SetStateAction<ChannelFormState>>;
}) {
  if (form.type === 'email') {
    const email = coerceEmailConfig(form.config);
    return <EmailChannelFields config={email} onSetForm={onSetForm} />;
  }
  if (form.type === 'gotify') {
    const gotify = coerceGotifyConfig(form.config);
    return <GotifyChannelFields config={gotify} onSetForm={onSetForm} />;
  }
  if (form.type === 'mqtt') {
    const mqtt = coerceMqttConfig(form.config);
    return <MqttChannelFields config={mqtt} onSetForm={onSetForm} />;
  }
  if (form.type === 'webhook') {
    const webhook = coerceWebhookConfig(form.config);
    return <WebhookChannelFields config={webhook} onSetForm={onSetForm} />;
  }
  const ntfy = coerceNtfyConfig(form.config);
  return <NtfyChannelFields config={ntfy} onSetForm={onSetForm} />;
}

function EmailChannelFields({ config, onSetForm }: { config: EmailConfig; onSetForm: Dispatch<SetStateAction<ChannelFormState>> }) {
  return (
    <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="grid gap-4 md:grid-cols-2">
        <LabeledInput label="SMTP Host" value={config.smtpHost} onChange={(value) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), smtpHost: value }))} />
        <LabeledInput label="SMTP Port" type="number" value={config.smtpPort} onChange={(value) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), smtpPort: Number(value || '0') }))} />
        <label className="space-y-2 text-sm">
          <span className="font-medium">SMTP Security</span>
          <select value={config.smtpTlsMode} onChange={(event) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), smtpTlsMode: event.target.value as EmailConfig['smtpTlsMode'] }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="plain">Plain SMTP</option>
            <option value="starttls">STARTTLS</option>
            <option value="tls">SMTPS / Implicit TLS</option>
          </select>
        </label>
        <LabeledInput label="SMTP User" value={config.smtpUser} onChange={(value) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), smtpUser: value }))} />
        <SecretInput label="SMTP Password" value={config.smtpPassword} onChange={(value) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), smtpPassword: value || current.smtpPassword }))} />
        <LabeledInput label="From Address" value={config.smtpFrom} onChange={(value) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), smtpFrom: value }))} />
        <LabeledInput label="To Address(es)" value={config.emailTo} onChange={(value) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), emailTo: value }))} />
        <label className="space-y-2 text-sm">
          <span className="font-medium">Importance</span>
          <select value={config.emailImportanceOverride} onChange={(event) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), emailImportanceOverride: event.target.value as EmailConfig['emailImportanceOverride'] }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="auto">Auto</option>
            <option value="normal">Normal</option>
            <option value="important">Important</option>
          </select>
        </label>
      </div>
      {config.smtpTlsMode !== 'plain' && (
        <label className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800/60 dark:bg-amber-950/20">
          <Switch id="email-allow-insecure-tls" checked={config.allowInsecureTls} onCheckedChange={(checked) => updateChannelConfig<EmailConfig>(onSetForm, (current) => ({ ...coerceEmailConfig(current), allowInsecureTls: checked }))} />
          <span className="font-medium">Allow insecure TLS for trusted self-signed SMTP endpoints</span>
        </label>
      )}
    </div>
  );
}

function GotifyChannelFields({ config, onSetForm }: { config: GotifyConfig; onSetForm: Dispatch<SetStateAction<ChannelFormState>> }) {
  return (
    <div className="grid gap-4 rounded-xl border border-gray-200 p-4 md:grid-cols-2 dark:border-gray-700">
      <LabeledInput label="Gotify URL" value={config.gotifyUrl} onChange={(value) => updateChannelConfig<GotifyConfig>(onSetForm, (current) => ({ ...coerceGotifyConfig(current), gotifyUrl: value }))} />
      <label className="space-y-2 text-sm">
        <span className="font-medium">Priority</span>
        <select value={config.gotifyPriorityOverride} onChange={(event) => updateChannelConfig<GotifyConfig>(onSetForm, (current) => ({ ...coerceGotifyConfig(current), gotifyPriorityOverride: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
          <option value="auto">Auto</option>
          {[0, 1, 3, 5, 7, 8, 10].map((value) => <option key={value} value={String(value)}>{value}</option>)}
        </select>
      </label>
      <div className="md:col-span-2">
        <SecretInput label="App Token" value={config.gotifyToken} onChange={(value) => updateChannelConfig<GotifyConfig>(onSetForm, (current) => ({ ...coerceGotifyConfig(current), gotifyToken: value || current.gotifyToken }))} />
      </div>
    </div>
  );
}

function NtfyChannelFields({ config, onSetForm }: { config: NtfyConfig; onSetForm: Dispatch<SetStateAction<ChannelFormState>> }) {
  return (
    <div className="grid gap-4 rounded-xl border border-gray-200 p-4 md:grid-cols-2 dark:border-gray-700">
      <LabeledInput label="Server URL" value={config.ntfyUrl} onChange={(value) => updateChannelConfig<NtfyConfig>(onSetForm, (current) => ({ ...coerceNtfyConfig(current), ntfyUrl: value }))} />
      <LabeledInput label="Topic" value={config.ntfyTopic} onChange={(value) => updateChannelConfig<NtfyConfig>(onSetForm, (current) => ({ ...coerceNtfyConfig(current), ntfyTopic: value }))} />
      <SecretInput label="Access Token" value={config.ntfyToken} onChange={(value) => updateChannelConfig<NtfyConfig>(onSetForm, (current) => ({ ...coerceNtfyConfig(current), ntfyToken: value || current.ntfyToken }))} />
      <label className="space-y-2 text-sm">
        <span className="font-medium">Priority</span>
        <select value={config.ntfyPriorityOverride} onChange={(event) => updateChannelConfig<NtfyConfig>(onSetForm, (current) => ({ ...coerceNtfyConfig(current), ntfyPriorityOverride: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
          {['auto', 'min', 'low', 'default', 'high', 'urgent'].map((priority) => <option key={priority} value={priority}>{priority}</option>)}
        </select>
      </label>
    </div>
  );
}

function MqttChannelFields({ config, onSetForm }: { config: MqttConfig; onSetForm: Dispatch<SetStateAction<ChannelFormState>> }) {
  return (
    <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <LabeledInput label="Broker URL" value={config.brokerUrl} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), brokerUrl: value }))} placeholder="mqtt://broker.example.com:1883" />
        </div>
        <LabeledInput label="Username" value={config.username} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), username: value }))} />
        <SecretInput label="Password" value={config.password} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), password: value || current.password }))} />
        <LabeledInput label="Client ID" value={config.clientId} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), clientId: value }))} />
        <label className="space-y-2 text-sm">
          <span className="font-medium">QoS</span>
          <select value={String(config.qos)} onChange={(event) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), qos: event.target.value === '0' ? 0 : 1 }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="0">0</option>
            <option value="1">1</option>
          </select>
        </label>
        <LabeledInput label="Keepalive (seconds)" type="number" value={config.keepaliveSeconds} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), keepaliveSeconds: Number(value || '0') }))} />
        <LabeledInput label="Connect Timeout (ms)" type="number" value={config.connectTimeoutMs} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), connectTimeoutMs: Number(value || '0') }))} />
        <div className="md:col-span-2">
          <LabeledInput label="Topic" value={config.topic} onChange={(value) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), topic: value }))} placeholder="crowdsec/notifications" />
        </div>
      </div>
      <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
        <Switch id="mqtt-retain-events" checked={config.retainEvents} onCheckedChange={(checked) => updateChannelConfig<MqttConfig>(onSetForm, (current) => ({ ...coerceMqttConfig(current), retainEvents: checked }))} />
        <span className="font-medium">Retain MQTT payloads</span>
      </label>
    </div>
  );
}

function WebhookChannelFields({ config, onSetForm }: { config: WebhookConfig; onSetForm: Dispatch<SetStateAction<ChannelFormState>> }) {
  const bearerAuth = config.auth.mode === 'bearer' ? config.auth : null;
  const basicAuth = config.auth.mode === 'basic' ? config.auth : null;
  const formBody = config.body.mode === 'form' ? config.body : null;
  const templateBody = config.body.mode === 'form' ? null : config.body;

  const setWebhookConfig = (next: WebhookConfig) => {
    updateChannelConfig<WebhookConfig>(onSetForm, () => cloneConfig(next));
  };

  const updateHeader = (index: number, field: Partial<WebhookField>) => {
    const headers = [...config.headers];
    headers[index] = { ...headers[index], ...field };
    setWebhookConfig({ ...config, headers });
  };

  const updateQuery = (index: number, field: Partial<{ name: string; value: string }>) => {
    const query = [...config.query];
    query[index] = { ...query[index], ...field };
    setWebhookConfig({ ...config, query });
  };

  const updateFormField = (index: number, field: Partial<WebhookField>) => {
    if (!formBody) return;
    const fields = [...formBody.fields];
    fields[index] = { ...fields[index], ...field };
    setWebhookConfig({ ...config, body: { mode: 'form', fields } });
  };

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Method</span>
          <select value={config.method} onChange={(event) => setWebhookConfig({ ...config, method: event.target.value as WebhookConfig['method'] })} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
        </label>
        <LabeledInput label="URL" value={config.url} onChange={(value) => setWebhookConfig({ ...config, url: value })} />
      </div>

      <SectionHeader
        title="Query Parameters"
        actionLabel="Add query"
        onAction={() => setWebhookConfig({ ...config, query: [...config.query, { name: '', value: '' }] })}
      />
      <div className="space-y-3">
        {config.query.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No query parameters.</p>}
        {config.query.map((entry, index) => (
          <RowEditor key={`query-${index}`} onRemove={() => setWebhookConfig({ ...config, query: config.query.filter((_, currentIndex) => currentIndex !== index) })}>
            <LabeledInput label="Name" value={entry.name} onChange={(value) => updateQuery(index, { name: value })} />
            <LabeledInput label="Value" value={entry.value} onChange={(value) => updateQuery(index, { value })} />
          </RowEditor>
        ))}
      </div>

      <SectionHeader
        title="Headers"
        actionLabel="Add header"
        onAction={() => setWebhookConfig({ ...config, headers: [...config.headers, { name: '', value: '', sensitive: false }] })}
      />
      <div className="space-y-3">
        {config.headers.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No headers.</p>}
        {config.headers.map((header, index) => (
          <RowEditor key={`header-${index}`} onRemove={() => setWebhookConfig({ ...config, headers: config.headers.filter((_, currentIndex) => currentIndex !== index) })}>
            <LabeledInput label="Name" value={header.name} onChange={(value) => updateHeader(index, { name: value })} />
            <SecretInput label="Value" value={header.value} onChange={(value) => updateHeader(index, { value: value || header.value })} />
            <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
              <Switch id={`header-sensitive-${index}`} checked={header.sensitive} onCheckedChange={(checked) => updateHeader(index, { sensitive: checked })} />
              <span className="font-medium">Sensitive</span>
            </label>
          </RowEditor>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Authentication</span>
          <select value={config.auth.mode} onChange={(event) => {
            const mode = event.target.value as WebhookAuthConfig['mode'];
            if (mode === 'bearer') {
              setWebhookConfig({ ...config, auth: { mode: 'bearer', token: '' } });
            } else if (mode === 'basic') {
              setWebhookConfig({ ...config, auth: { mode: 'basic', username: '', password: '' } });
            } else {
              setWebhookConfig({ ...config, auth: { mode: 'none' } });
            }
          }} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="none">None</option>
            <option value="bearer">Bearer</option>
            <option value="basic">Basic</option>
          </select>
        </label>
        {bearerAuth && (
          <div className="md:col-span-2">
            <SecretInput label="Bearer Token" value={bearerAuth.token} onChange={(value) => setWebhookConfig({ ...config, auth: { mode: 'bearer', token: value || bearerAuth.token } })} />
          </div>
        )}
        {basicAuth && (
          <>
            <LabeledInput label="Username" value={basicAuth.username} onChange={(value) => setWebhookConfig({ ...config, auth: { mode: 'basic', username: value, password: basicAuth.password } })} />
            <SecretInput label="Password" value={basicAuth.password} onChange={(value) => setWebhookConfig({ ...config, auth: { mode: 'basic', username: basicAuth.username, password: value || basicAuth.password } })} />
          </>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Body Mode</span>
          <select value={config.body.mode} onChange={(event) => {
            const mode = event.target.value as WebhookBodyConfig['mode'];
            if (mode === 'form') {
              setWebhookConfig({ ...config, body: { mode: 'form', fields: [] } });
            } else {
              setWebhookConfig({ ...config, body: { mode: mode === 'json' ? 'json' : 'text', template: config.body.mode === 'form' ? '' : config.body.template } });
            }
          }} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="json">JSON</option>
            <option value="text">Text</option>
            <option value="form">Form</option>
          </select>
        </label>

        {formBody ? (
          <div className="space-y-3">
            <div className="pt-2">
              <SectionHeader title="Form Fields" actionLabel="Add field" onAction={() => setWebhookConfig({ ...config, body: { mode: 'form', fields: [...formBody.fields, { name: '', value: '', sensitive: false }] } })} />
            </div>
            {formBody.fields.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No form fields.</p>}
            {formBody.fields.map((field, index) => (
              <RowEditor key={`form-field-${index}`} onRemove={() => setWebhookConfig({ ...config, body: { mode: 'form', fields: formBody.fields.filter((_, currentIndex: number) => currentIndex !== index) } })}>
                <LabeledInput label="Name" value={field.name} onChange={(value) => updateFormField(index, { name: value })} />
                <SecretInput label="Value" value={field.value} onChange={(value) => updateFormField(index, { value: value || field.value })} />
                <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
                  <Switch id={`body-field-sensitive-${index}`} checked={field.sensitive} onCheckedChange={(checked) => updateFormField(index, { sensitive: checked })} />
                  <span className="font-medium">Sensitive</span>
                </label>
              </RowEditor>
            ))}
          </div>
        ) : (
          <LabeledTextArea label="Body Template" rows={8} value={templateBody?.template || ''} onChange={(value) => setWebhookConfig({ ...config, body: { mode: templateBody?.mode === 'json' ? 'json' : 'text', template: value } })} />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <LabeledInput label="Timeout (ms)" type="number" value={config.timeoutMs} onChange={(value) => setWebhookConfig({ ...config, timeoutMs: Number(value || '0') })} />
        <LabeledInput label="Retry Attempts" type="number" value={config.retryAttempts} onChange={(value) => setWebhookConfig({ ...config, retryAttempts: Number(value || '0') })} />
        <LabeledInput label="Retry Delay (ms)" type="number" value={config.retryDelayMs} onChange={(value) => setWebhookConfig({ ...config, retryDelayMs: Number(value || '0') })} />
      </div>

      <label className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800/60 dark:bg-amber-950/20">
        <Switch id="webhook-allow-insecure-tls" checked={config.allowInsecureTls} onCheckedChange={(checked) => setWebhookConfig({ ...config, allowInsecureTls: checked })} />
        <span className="font-medium">Allow insecure TLS for trusted self-signed webhook endpoints</span>
      </label>
    </div>
  );
}

function SectionHeader({ title, actionLabel, onAction }: { title: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-medium">{title}</p>
      <button
        type="button"
        onClick={onAction}
        className="relative z-10 shrink-0 cursor-pointer rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function RowEditor({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <div className="grid gap-3 rounded-lg border border-gray-200 p-3 md:grid-cols-[1fr_1fr_auto_auto] dark:border-gray-700">
      {children}
      <button
        type="button"
        onClick={onRemove}
        className="relative z-10 self-end rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-950/30"
      >
        Remove
      </button>
    </div>
  );
}

function RuleConfigFields({ form, onChange }: { form: RuleFormState; onChange: (key: string, value: string) => void }) {
  const input = (key: string, label: string) => <LabeledInput key={key} label={label} value={form.config[key] || ''} onChange={(value) => onChange(key, value)} />;
  if (form.type === 'alert-spike') return <div className="grid gap-4 md:grid-cols-3">{input('window_minutes', 'Window Minutes')}{input('percent_increase', 'Percent Increase')}{input('minimum_current_alerts', 'Minimum Alerts')}</div>;
  if (form.type === 'alert-threshold') return <div className="grid gap-4 md:grid-cols-2">{input('window_minutes', 'Window Minutes')}{input('alert_threshold', 'Alert Threshold')}</div>;
  if (form.type === 'application-update') {
    return (
      <div className="rounded-xl border border-blue-200 bg-blue-50/80 p-4 text-sm text-blue-900 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-200">
        This rule uses the built-in update check and fires when a newer CrowdSec Web UI version is available.
      </div>
    );
  }
  return <div className="grid gap-4 md:grid-cols-2">{input('max_cve_age_days', 'Maximum CVE Age (days)')}</div>;
}
