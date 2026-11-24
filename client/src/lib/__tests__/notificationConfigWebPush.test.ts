import { describe, expect, test } from 'vitest';
import { coerceWebPushConfig, defaultChannelConfig, validateNotificationChannelConfig } from '../notification-config';

describe('Web Push channel config', () => {
  test('has its own default and coerces odd input', () => {
    expect(defaultChannelConfig('webpush')).toEqual({ webpushSubject: '' });
    expect(coerceWebPushConfig({ webpushSubject: 5 })).toEqual({ webpushSubject: '' });
    expect(coerceWebPushConfig(null)).toEqual({ webpushSubject: '' });
  });

  test('accepts no contact, a mailto: address or an https URL', () => {
    expect(validateNotificationChannelConfig('webpush', {})).toBeNull();
    expect(validateNotificationChannelConfig('webpush', { webpushSubject: 'mailto:ops@example.com' })).toBeNull();
    expect(validateNotificationChannelConfig('webpush', { webpushSubject: 'https://soc.example.com' })).toBeNull();
  });

  test('rejects anything else', () => {
    expect(validateNotificationChannelConfig('webpush', { webpushSubject: 'ops@example.com' })).toMatch(/mailto/);
    expect(validateNotificationChannelConfig('webpush', { webpushSubject: 'http://soc.example.com' })).toMatch(/mailto/);
    expect(validateNotificationChannelConfig('webpush', { webpushSubject: `mailto:${'a'.repeat(210)}@x.io` })).toMatch(/200/);
  });
});
