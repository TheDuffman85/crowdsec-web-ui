import type { AlertMetaValue, NotificationSeverity } from '../../shared/contracts';

export interface DiscordEmbedInput {
  title: string;
  message: string;
  severity: NotificationSeverity;
  metadata: Record<string, AlertMetaValue>;
  sentAt: string;
  appName: string;
  ruleName: string | null;
  linkBaseUrl?: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp?: string;
  url?: string;
  fields: DiscordEmbedField[];
  footer: { text: string };
}

// Limits documented for Discord embeds.
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const FOOTER_LIMIT = 2048;
const MAX_FIELDS = 12;

const SEVERITY_COLORS: Record<NotificationSeverity, number> = {
  info: 0x3b82f6,
  warning: 0xf59e0b,
  critical: 0xef4444,
};

// Internal identifiers and bulky structures that add noise rather than context.
const HIDDEN_METADATA_KEYS = new Set([
  'filters',
  'kind',
  'test_source',
  'event_type',
  'instance_id',
  'instance_ids',
  'endpoint_id',
  'alert_id',
  'decision_id',
  'uuid',
  'message',
]);

// Shown first and in this order when present.
const PREFERRED_KEY_ORDER = [
  'source',
  'value',
  'scenario',
  'target',
  'machine',
  'country',
  'type',
  'origin',
  'instance_name',
  'instance_names',
];

const IP_OR_RANGE_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-f:]+(?:\/\d{1,3})?)$/i;

export function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function formatValue(value: AlertMetaValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .filter((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
      .map((entry) => String(entry));
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

export function normalizeLinkBaseUrl(value: string | undefined): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function findIp(metadata: Record<string, AlertMetaValue>): string | null {
  for (const key of ['source', 'value']) {
    const candidate = metadata[key];
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if ((trimmed.includes('.') || trimmed.includes(':')) && IP_OR_RANGE_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

export function buildDiscordEmbed(input: DiscordEmbedInput): DiscordEmbed {
  const fields: DiscordEmbedField[] = [];
  const keys = Object.keys(input.metadata).filter((key) => !HIDDEN_METADATA_KEYS.has(key));
  const ordered = [
    ...PREFERRED_KEY_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !PREFERRED_KEY_ORDER.includes(key)),
  ];
  for (const key of ordered) {
    if (fields.length >= MAX_FIELDS) break;
    const text = formatValue(input.metadata[key]);
    if (text === null) continue;
    fields.push({
      name: truncateText(humanizeKey(key), FIELD_NAME_LIMIT),
      value: truncateText(text, FIELD_VALUE_LIMIT),
      inline: text.length <= 40,
    });
  }

  const base = normalizeLinkBaseUrl(input.linkBaseUrl);
  const ip = findIp(input.metadata);
  let url: string | undefined;
  if (base && ip) {
    const query = encodeURIComponent(ip);
    const alertsUrl = `${base}/alerts?q=${query}`;
    const decisionsUrl = `${base}/decisions?q=${query}`;
    url = alertsUrl;
    fields.push({
      name: 'Open in Web UI',
      value: `[Alerts](${alertsUrl}) · [Decisions](${decisionsUrl})`,
    });
  }

  const footerParts = [input.appName, input.ruleName].filter((part): part is string => Boolean(part));
  const timestamp = Number.isNaN(Date.parse(input.sentAt)) ? undefined : new Date(input.sentAt).toISOString();

  return {
    title: truncateText(input.title, TITLE_LIMIT),
    description: truncateText(input.message, DESCRIPTION_LIMIT),
    color: SEVERITY_COLORS[input.severity] ?? SEVERITY_COLORS.info,
    ...(timestamp ? { timestamp } : {}),
    ...(url ? { url } : {}),
    fields,
    footer: { text: truncateText(footerParts.join(' · '), FOOTER_LIMIT) },
  };
}
