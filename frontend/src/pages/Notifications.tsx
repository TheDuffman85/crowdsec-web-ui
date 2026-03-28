import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useState } from 'react';
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
import { useRefresh } from '../contexts/useRefresh';
import { Badge } from '../components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Switch } from '../components/ui/Switch';
import type { NotificationChannel, NotificationChannelType, NotificationItem, NotificationRule, NotificationRuleType, NotificationSeverity, UpsertNotificationRuleRequest } from '../types';

type ChannelFormState = { name: string; type: NotificationChannelType; enabled: boolean; config: Record<string, string | boolean>; };
type RuleFormState = {
    name: string;
    type: NotificationRuleType;
    enabled: boolean;
    severity: NotificationSeverity;
    cooldown_minutes: string;
    channel_ids: string[];
    filters: { scenario: string; target: string; include_simulated: boolean };
    config: Record<string, string>;
};

const CHANNEL_DEFAULTS: Record<NotificationChannelType, Record<string, string | boolean>> = {
    ntfy: { server_url: 'https://ntfy.sh', topic: '', title_prefix: 'CrowdSec', priority: 'default', tags: 'warning,shield', token: '', username: '', password: '' },
    gotify: { server_url: '', token: '', priority: '5' },
    email: { host: '', port: '587', secure: false, username: '', password: '', from: '', to: '', subject_prefix: '[CrowdSec]' },
    webhook: { url: '', method: 'POST', authorization_header: '' },
};

const RULE_DEFAULTS: Record<NotificationRuleType, Record<string, string>> = {
    'alert-spike': { window_minutes: '60', percent_increase: '100', minimum_current_alerts: '10' },
    'alert-threshold': { window_minutes: '60', alert_threshold: '25' },
    'new-cve': { max_cve_age_days: '14' },
};

const defaultChannelForm = (type: NotificationChannelType = 'ntfy'): ChannelFormState => ({ name: '', type, enabled: true, config: { ...CHANNEL_DEFAULTS[type] } });
const defaultRuleForm = (type: NotificationRuleType = 'alert-spike'): RuleFormState => ({
    name: '', type, enabled: true, severity: 'warning', cooldown_minutes: '60', channel_ids: [], filters: { scenario: '', target: '', include_simulated: false }, config: { ...RULE_DEFAULTS[type] },
});

function buildRulePayload(ruleForm: RuleFormState): UpsertNotificationRuleRequest {
    const basePayload = {
        name: ruleForm.name,
        type: ruleForm.type,
        enabled: ruleForm.enabled,
        severity: ruleForm.severity,
        cooldown_minutes: Number(ruleForm.cooldown_minutes || '0'),
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
    const [saving, setSaving] = useState(false);

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

    useEffect(() => { void loadData(); }, [loadData]);
    useEffect(() => { if (refreshSignal > 0) void loadData(); }, [refreshSignal, loadData]);

    const openCreateChannel = () => { setEditingChannel(null); setChannelForm(defaultChannelForm()); setChannelModalOpen(true); };
    const openCreateRule = () => { setEditingRule(null); setRuleForm(defaultRuleForm()); setRuleModalOpen(true); };

    const openEditChannel = (channel: NotificationChannel) => {
        setEditingChannel(channel);
        setChannelForm({ name: channel.name, type: channel.type, enabled: channel.enabled, config: Object.fromEntries(Object.entries(channel.config).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v ?? '')])) });
        setChannelModalOpen(true);
    };

    const openEditRule = (rule: NotificationRule) => {
        setEditingRule(rule);
        setRuleForm({
            name: rule.name,
            type: rule.type,
            enabled: rule.enabled,
            severity: rule.severity,
            cooldown_minutes: String(rule.cooldown_minutes),
            channel_ids: [...rule.channel_ids],
            filters: { scenario: rule.config.filters?.scenario || '', target: rule.config.filters?.target || '', include_simulated: rule.config.filters?.include_simulated === true },
            config: Object.fromEntries(Object.entries(rule.config).filter(([key]) => key !== 'filters').map(([key, value]) => [key, String(value ?? '')])),
        });
        setRuleModalOpen(true);
    };

    const saveChannel = async () => {
        try {
            setSaving(true);
            const payload = { name: channelForm.name, type: channelForm.type, enabled: channelForm.enabled, config: channelForm.config };
            if (editingChannel) await updateNotificationChannel(editingChannel.id, payload); else await createNotificationChannel(payload);
            setChannelModalOpen(false);
            await loadData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save destination');
        } finally {
            setSaving(false);
        }
    };

    const saveRule = async () => {
        try {
            setSaving(true);
            const payload = buildRulePayload(ruleForm);
            if (editingRule) await updateNotificationRule(editingRule.id, payload); else await createNotificationRule(payload);
            setRuleModalOpen(false);
            await loadData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save rule');
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="text-center p-8 text-gray-500">Loading notifications...</div>;

    return (
        <div className="space-y-6">
            {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
            <div className="grid gap-6 lg:grid-cols-3">
                <SummaryCard icon={<Bell className="h-6 w-6" />} label="Unread Notifications" value={String(unreadCount)} />
                <SummaryCard icon={<Send className="h-6 w-6" />} label="Destinations" value={String(channels.length)} sublabel={`${channels.filter((channel) => channel.enabled).length} active`} />
                <SummaryCard icon={<CheckCheck className="h-6 w-6" />} label="Rules" value={String(rules.length)} sublabel={`${rules.filter((rule) => rule.enabled).length} active`} />
            </div>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Recent Notifications</CardTitle>
                    <button onClick={() => void markAllNotificationsRead().then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to mark notifications as read'))} className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"><CheckCheck className="h-4 w-4" />Mark All Read</button>
                </CardHeader>
                <CardContent className="space-y-4">
                    {notifications.length === 0 ? <p className="text-sm text-gray-500 dark:text-gray-400">No notifications yet.</p> : notifications.map((item) => <NotificationRow key={item.id} item={item} onMarkRead={() => void markNotificationRead(item.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to mark notification as read'))} />)}
                </CardContent>
            </Card>
            <div className="grid gap-6 xl:grid-cols-2">
                <ResourceCard title="Destinations" actionLabel="Add Destination" onAction={openCreateChannel}>
                    {channels.length === 0 ? <p className="text-sm text-gray-500 dark:text-gray-400">No outbound destinations configured yet.</p> : channels.map((channel) => <ChannelRow key={channel.id} channel={channel} onEdit={() => openEditChannel(channel)} onTest={() => void testNotificationChannel(channel.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to send test notification'))} onDelete={() => void deleteNotificationChannel(channel.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to delete destination'))} />)}
                </ResourceCard>
                <ResourceCard title="Rules" actionLabel="Add Rule" onAction={openCreateRule}>
                    {rules.length === 0 ? <p className="text-sm text-gray-500 dark:text-gray-400">No notification rules configured yet.</p> : rules.map((rule) => <RuleRow key={rule.id} rule={rule} channels={channels} onEdit={() => openEditRule(rule)} onDelete={() => void deleteNotificationRule(rule.id).then(loadData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to delete rule'))} />)}
                </ResourceCard>
            </div>
            <ChannelModal open={channelModalOpen} editingChannel={editingChannel} form={channelForm} saving={saving} onClose={() => setChannelModalOpen(false)} onSave={() => void saveChannel()} onSetForm={setChannelForm} />
            <RuleModal open={ruleModalOpen} editingRule={editingRule} form={ruleForm} channels={channels} saving={saving} onClose={() => setRuleModalOpen(false)} onSave={() => void saveRule()} onSetForm={setRuleForm} />
        </div>
    );
}

function SummaryCard({ icon, label, value, sublabel }: { icon: ReactNode; label: string; value: string; sublabel?: string }) {
    return <Card><CardContent className="flex items-center gap-4 p-6"><div className="rounded-full bg-blue-100 p-3 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{icon}</div><div><p className="text-sm text-gray-500 dark:text-gray-400">{label}</p><p className="text-3xl font-bold">{value}</p>{sublabel && <p className="text-xs text-gray-500 dark:text-gray-400">{sublabel}</p>}</div></CardContent></Card>;
}

function ResourceCard({ title, actionLabel, onAction, children }: { title: string; actionLabel: string; onAction: () => void; children: ReactNode }) {
    return <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>{title}</CardTitle><button onClick={onAction} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700"><Plus className="h-4 w-4" />{actionLabel}</button></CardHeader><CardContent className="space-y-4">{children}</CardContent></Card>;
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
        neutral: 'border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600',
        danger: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-900/30',
        accent: 'border-blue-200 bg-white text-blue-700 hover:bg-blue-100 dark:border-blue-900/40 dark:bg-gray-800 dark:text-blue-300 dark:hover:bg-gray-700',
    } satisfies Record<'neutral' | 'danger' | 'accent', string>;

    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${styles[variant]}`}
        >
            {icon}
        </button>
    );
}

function NotificationRow({ item, onMarkRead }: { item: NotificationItem; onMarkRead: () => void }) {
    return <div className={`rounded-xl border p-4 ${item.read_at ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800' : 'border-blue-200 bg-blue-50/70 dark:border-blue-900/40 dark:bg-blue-950/20'}`}><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div className="space-y-2"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.title}</h3><Badge variant={item.severity === 'critical' ? 'danger' : item.severity === 'warning' ? 'warning' : 'info'}>{item.severity}</Badge>{!item.read_at && <Badge variant="secondary">Unread</Badge>}</div><p className="text-sm text-gray-700 dark:text-gray-300">{item.message}</p><p className="text-xs text-gray-500 dark:text-gray-400">Rule: {item.rule_name} • {new Date(item.created_at).toLocaleString()}</p><div className="flex flex-wrap gap-2">{item.deliveries.map((delivery, index) => <Badge key={`${delivery.channel_id}-${index}`} variant={delivery.status === 'delivered' ? 'success' : 'danger'}>{delivery.channel_name}: {delivery.status}</Badge>)}</div></div>{!item.read_at && <ActionIconButton label="Mark read" icon={<Check className="h-4 w-4" />} onClick={onMarkRead} variant="accent" />}</div></div>;
}

function ChannelRow({ channel, onEdit, onTest, onDelete }: { channel: NotificationChannel; onEdit: () => void; onTest: () => void; onDelete: () => void }) {
    return <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700"><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div className="space-y-2"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{channel.name}</h3><Badge variant={channel.enabled ? 'success' : 'secondary'}>{channel.enabled ? 'Enabled' : 'Disabled'}</Badge><Badge variant="outline">{channel.type}</Badge></div><p className="text-xs text-gray-500 dark:text-gray-400">Updated {new Date(channel.updated_at).toLocaleString()}</p>{channel.configured_secrets.length > 0 && <p className="text-xs text-gray-500 dark:text-gray-400">Saved secrets: {channel.configured_secrets.join(', ')}</p>}</div><div className="flex flex-wrap gap-2 md:self-start"><ActionIconButton label="Send test notification" icon={<SendHorizontal className="h-4 w-4" />} onClick={onTest} /><ActionIconButton label="Edit destination" icon={<SquarePen className="h-4 w-4" />} onClick={onEdit} /><ActionIconButton label="Delete destination" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete} variant="danger" /></div></div></div>;
}

function RuleRow({ rule, channels, onEdit, onDelete }: { rule: NotificationRule; channels: NotificationChannel[]; onEdit: () => void; onDelete: () => void }) {
    return <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700"><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div className="space-y-2"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{rule.name}</h3><Badge variant={rule.enabled ? 'success' : 'secondary'}>{rule.enabled ? 'Enabled' : 'Disabled'}</Badge><Badge variant="outline">{rule.type}</Badge><Badge variant={rule.severity === 'critical' ? 'danger' : rule.severity === 'warning' ? 'warning' : 'info'}>{rule.severity}</Badge></div><p className="text-sm text-gray-600 dark:text-gray-300">Cooldown: {rule.cooldown_minutes} minutes</p><p className="text-xs text-gray-500 dark:text-gray-400">Channels: {rule.channel_ids.map((id) => channels.find((channel) => channel.id === id)?.name || id).join(', ') || 'In-app only'}</p></div><div className="flex flex-wrap gap-2 md:self-start"><ActionIconButton label="Edit rule" icon={<SquarePen className="h-4 w-4" />} onClick={onEdit} /><ActionIconButton label="Delete rule" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete} variant="danger" /></div></div></div>;
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
        <Modal isOpen={open} onClose={onClose} title={editingChannel ? 'Edit Destination' : 'New Destination'} maxWidth="max-w-2xl">
            <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                    <LabeledInput label="Name" value={form.name} onChange={(value) => onSetForm((current) => ({ ...current, name: value }))} />
                    <label className="space-y-2 text-sm">
                        <span className="font-medium">Type</span>
                        <select value={form.type} onChange={(event) => onSetForm((current) => ({ ...current, type: event.target.value as NotificationChannelType, config: { ...CHANNEL_DEFAULTS[event.target.value as NotificationChannelType] } }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                            <option value="ntfy">ntfy</option>
                            <option value="gotify">Gotify</option>
                            <option value="email">Email</option>
                            <option value="webhook">Webhook</option>
                        </select>
                    </label>
                </div>
                <div className="flex items-center gap-3">
                    <Switch id="channel-enabled" checked={form.enabled} onCheckedChange={(checked) => onSetForm((current) => ({ ...current, enabled: checked }))} />
                    <label htmlFor="channel-enabled" className="text-sm font-medium">Enabled</label>
                </div>
                <ChannelConfigFields form={form} configuredSecrets={editingChannel?.configured_secrets || []} onChange={(key, value) => onSetForm((current) => ({ ...current, config: { ...current.config, [key]: value } }))} />
                <div className="flex justify-end gap-3">
                    <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-700">Cancel</button>
                    <button onClick={onSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60">{saving ? 'Saving...' : 'Save Destination'}</button>
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
    return (
        <Modal isOpen={open} onClose={onClose} title={editingRule ? 'Edit Rule' : 'New Rule'} maxWidth="max-w-3xl">
            <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                    <LabeledInput label="Name" value={form.name} onChange={(value) => onSetForm((current) => ({ ...current, name: value }))} />
                    <label className="space-y-2 text-sm">
                        <span className="font-medium">Rule Type</span>
                        <select value={form.type} onChange={(event) => onSetForm((current) => ({ ...current, type: event.target.value as NotificationRuleType, config: { ...RULE_DEFAULTS[event.target.value as NotificationRuleType] } }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                            <option value="alert-spike">Alert Spike</option>
                            <option value="alert-threshold">Alert Threshold</option>
                            <option value="new-cve">Recent CVE</option>
                        </select>
                    </label>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                    <label className="space-y-2 text-sm">
                        <span className="font-medium">Severity</span>
                        <select value={form.severity} onChange={(event) => onSetForm((current) => ({ ...current, severity: event.target.value as NotificationSeverity }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                            <option value="info">Info</option>
                            <option value="warning">Warning</option>
                            <option value="critical">Critical</option>
                        </select>
                    </label>
                    <LabeledInput label="Cooldown (minutes)" value={form.cooldown_minutes} onChange={(value) => onSetForm((current) => ({ ...current, cooldown_minutes: value }))} />
                    <div className="flex items-center gap-3 pt-7">
                        <Switch id="rule-enabled" checked={form.enabled} onCheckedChange={(checked) => onSetForm((current) => ({ ...current, enabled: checked }))} />
                        <label htmlFor="rule-enabled" className="text-sm font-medium">Enabled</label>
                    </div>
                </div>
                <div className="space-y-3">
                    <p className="text-sm font-medium">Outbound Destinations</p>
                    <div className="grid gap-2 md:grid-cols-2">
                        {channels.map((channel) => (
                            <label key={channel.id} className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
                                <input type="checkbox" checked={form.channel_ids.includes(channel.id)} onChange={(event) => onSetForm((current) => ({ ...current, channel_ids: event.target.checked ? [...current.channel_ids, channel.id] : current.channel_ids.filter((value) => value !== channel.id) }))} />
                                <span>{channel.name}</span>
                            </label>
                        ))}
                    </div>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                    <LabeledInput label="Scenario Contains" value={form.filters.scenario} onChange={(value) => onSetForm((current) => ({ ...current, filters: { ...current.filters, scenario: value } }))} />
                    <LabeledInput label="Target Contains" value={form.filters.target} onChange={(value) => onSetForm((current) => ({ ...current, filters: { ...current.filters, target: value } }))} />
                    <div className="flex items-center gap-3 pt-7">
                        <Switch id="rule-include-simulated" checked={form.filters.include_simulated} onCheckedChange={(checked) => onSetForm((current) => ({ ...current, filters: { ...current.filters, include_simulated: checked } }))} />
                        <label htmlFor="rule-include-simulated" className="text-sm font-medium">Include simulated alerts</label>
                    </div>
                </div>
                <RuleConfigFields form={form} onChange={(key, value) => onSetForm((current) => ({ ...current, config: { ...current.config, [key]: value } }))} />
                <div className="flex justify-end gap-3">
                    <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-700">Cancel</button>
                    <button onClick={onSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60">{saving ? 'Saving...' : 'Save Rule'}</button>
                </div>
            </div>
        </Modal>
    );
}

function LabeledInput({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string }) {
    return <label className="space-y-2 text-sm"><span className="font-medium">{label}</span><input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900" /></label>;
}

function ChannelConfigFields({ form, configuredSecrets, onChange }: { form: ChannelFormState; configuredSecrets: string[]; onChange: (key: string, value: string | boolean) => void }) {
    const input = (key: string, label: string, type = 'text') => <LabeledInput key={key} label={label} type={type} value={typeof form.config[key] === 'boolean' ? '' : String(form.config[key] ?? '')} placeholder={configuredSecrets.includes(key) ? 'Saved value' : undefined} onChange={(value) => onChange(key, value)} />;
    if (form.type === 'ntfy') return <div className="grid gap-4 md:grid-cols-2">{['server_url', 'topic', 'title_prefix', 'priority', 'tags', 'token', 'username', 'password'].map((key) => input(key, key.replace(/_/g, ' '), key === 'password' ? 'password' : 'text'))}</div>;
    if (form.type === 'gotify') return <div className="grid gap-4 md:grid-cols-2">{['server_url', 'token', 'priority'].map((key) => input(key, key.replace(/_/g, ' '), key === 'token' ? 'password' : 'text'))}</div>;
    if (form.type === 'webhook') return <div className="grid gap-4 md:grid-cols-2">{['url', 'method', 'authorization_header'].map((key) => input(key, key.replace(/_/g, ' '), key === 'authorization_header' ? 'password' : 'text'))}</div>;
    return <div className="grid gap-4 md:grid-cols-2">{['host', 'port', 'username', 'password', 'from', 'to', 'subject_prefix'].map((key) => input(key, key.replace(/_/g, ' '), key === 'password' ? 'password' : 'text'))}<label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"><Switch id="email-secure" checked={form.config.secure === true} onCheckedChange={(checked) => onChange('secure', checked)} /><span className="font-medium">Use TLS</span></label></div>;
}

function RuleConfigFields({ form, onChange }: { form: RuleFormState; onChange: (key: string, value: string) => void }) {
    const input = (key: string, label: string) => <LabeledInput key={key} label={label} value={form.config[key] || ''} onChange={(value) => onChange(key, value)} />;
    if (form.type === 'alert-spike') return <div className="grid gap-4 md:grid-cols-3">{input('window_minutes', 'Window Minutes')}{input('percent_increase', 'Percent Increase')}{input('minimum_current_alerts', 'Minimum Alerts')}</div>;
    if (form.type === 'alert-threshold') return <div className="grid gap-4 md:grid-cols-2">{input('window_minutes', 'Window Minutes')}{input('alert_threshold', 'Alert Threshold')}</div>;
    return <div className="grid gap-4 md:grid-cols-2">{input('max_cve_age_days', 'Maximum CVE Age (days)')}</div>;
}
