import { describe, expect, test } from 'vitest';
import { renderTemplate } from './notifications/webhook-template';

const baseEvent = {
  title: 'CrowdSec notification test',
  message: 'Test notification',
  severity: 'info',
  metadata: {},
  sent_at: '2026-05-05T20:52:40.526Z',
  channel_id: 'channel-1',
  channel_name: 'Webhook',
  channel_type: 'webhook',
  rule_id: null,
  rule_name: null,
  rule_type: null,
};

describe('webhook templates', () => {
  test('renders non-null fallback aliases for nullable rule fields', () => {
    expect(renderTemplate(
      '{{event.rule_idOrUnknown}}|{{event.rule_nameOrUnknown}}|{{event.rule_typeOrUnknown}}',
      baseEvent,
    )).toBe('unknown|unknown|unknown');

    expect(JSON.parse(renderTemplate(
      '{"rule_id":{{event.rule_idOrUnknownJson}},"rule_name":{{event.rule_nameOrUnknownJson}},"rule_type":{{event.rule_typeOrUnknownJson}}}',
      baseEvent,
    ))).toEqual({
      rule_id: 'unknown',
      rule_name: 'unknown',
      rule_type: 'unknown',
    });
  });

  test('fallback aliases preserve configured rule values', () => {
    expect(JSON.parse(renderTemplate(
      '{"rule_id":{{event.rule_idOrUnknownJson}},"rule_name":{{event.rule_nameOrUnknownJson}},"rule_type":{{event.rule_typeOrUnknownJson}}}',
      {
        ...baseEvent,
        rule_id: 'rule-1',
        rule_name: 'High volume',
        rule_type: 'alert-threshold',
      },
    ))).toEqual({
      rule_id: 'rule-1',
      rule_name: 'High volume',
      rule_type: 'alert-threshold',
    });
  });
});
