import type { AlertMetaValue } from '../../shared/contracts';

const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ALLOWED_TAG_RE = /^event(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

interface WebhookTemplateEvent {
  title: string;
  message: string;
  severity: string;
  metadata: Record<string, AlertMetaValue>;
  sent_at: string;
  channel_id: string;
  channel_name: string;
  channel_type: string;
  rule_id: string | null;
  rule_name: string | null;
  rule_type: string | null;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function getPathValue(source: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function validateTemplate(template: string): string | null {
  if (/\{\{\s*[#/^>!]/.test(template)) {
    return 'Templates only support simple variable tags';
  }

  const matches = template.matchAll(TAG_RE);
  for (const match of matches) {
    const tag = String(match[1] || '').trim();
    if (!ALLOWED_TAG_RE.test(tag)) {
      return 'Templates may only reference dotted event paths';
    }
  }

  return null;
}

export function buildWebhookTemplateView(event: WebhookTemplateEvent): { event: Record<string, unknown> } {
  return {
    event: {
      ...event,
      titleJson: json(event.title),
      messageJson: json(event.message),
      severityJson: json(event.severity),
      metadataJson: json(event.metadata),
      sent_atJson: json(event.sent_at),
      channel_idJson: json(event.channel_id),
      channel_nameJson: json(event.channel_name),
      channel_typeJson: json(event.channel_type),
      rule_idJson: json(event.rule_id),
      rule_nameJson: json(event.rule_name),
      rule_typeJson: json(event.rule_type),
      json: json(event),
    },
  };
}

export function renderTemplate(template: string, event: WebhookTemplateEvent): string {
  const validationError = validateTemplate(template);
  if (validationError) {
    throw new Error(validationError);
  }

  const view = buildWebhookTemplateView(event);
  return template.replace(TAG_RE, (_full, rawTag) => {
    const tag = String(rawTag || '').trim();
    return stringify(getPathValue(view, tag));
  });
}
