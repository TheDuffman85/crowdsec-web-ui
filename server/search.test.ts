import { describe, expect, test } from 'vitest';
import type { DecisionListItem, SlimAlert } from '../shared/contracts';
import { compileAlertSearch, compileDecisionSearch } from '../shared/search';

const baseAlert: SlimAlert = {
  id: 1,
  created_at: '2026-03-24T10:00:00.000Z',
  scenario: 'crowdsecurity/ssh-bf',
  message: 'SSH brute force detected',
  machine_id: 'machine-1',
  machine_alias: 'host-a',
  source: {
    ip: '1.2.3.4',
    value: '1.2.3.4',
    cn: 'DE',
    as_name: 'Hetzner',
  },
  target: 'ssh',
  meta_search: 'ssh brute force',
  decisions: [
    { id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false },
    { id: 11, value: '1.2.3.4', type: 'ban', origin: 'CAPI', simulated: false },
  ],
  simulated: false,
};

const baseDecision: DecisionListItem = {
  id: 10,
  created_at: '2026-03-24T10:00:00.000Z',
  machine: 'host-a',
  value: '1.2.3.4',
  expired: false,
  is_duplicate: false,
  simulated: false,
  detail: {
    origin: 'manual',
    type: 'ban',
    reason: 'crowdsecurity/ssh-bf',
    action: 'ban',
    country: 'DE',
    as: 'Hetzner',
    duration: '4h',
    alert_id: 123,
    target: 'ssh',
  },
};

describe('shared search compiler', () => {
  test('preserves free-text search for alerts', () => {
    const compiled = compileAlertSearch('ssh hetzner');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }

    expect(compiled.predicate(baseAlert)).toBe(true);
    expect(compiled.predicate({ ...baseAlert, source: { ...baseAlert.source, as_name: 'AWS' } })).toBe(false);
  });

  test('supports grouped field expressions and negation for alerts', () => {
    const compiled = compileAlertSearch('origin:(manual OR CAPI) AND -sim:simulated', {
      originEnabled: true,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }

    expect(compiled.predicate(baseAlert)).toBe(true);
    expect(compiled.predicate({ ...baseAlert, simulated: true })).toBe(false);
  });

  test('supports date comparison operators for alerts', () => {
    const compiled = compileAlertSearch('date>=2026-03-24 AND date<2026-03-25');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }

    expect(compiled.predicate(baseAlert)).toBe(true);
    expect(compiled.predicate({ ...baseAlert, created_at: '2026-03-23T23:59:59.000Z' })).toBe(false);
    expect(compiled.predicate({ ...baseAlert, created_at: '2026-03-25T00:00:00.000Z' })).toBe(false);
  });

  test('treats lowercase boolean keywords as operators when the query is clearly advanced', () => {
    const compiled = compileAlertSearch('origin:manual or country:us', {
      originEnabled: true,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }

    expect(compiled.predicate(baseAlert)).toBe(true);
    expect(compiled.predicate({ ...baseAlert, source: { ...baseAlert.source, cn: 'US' } })).toBe(true);
  });

  test('supports semantic decision fields', () => {
    const compiled = compileDecisionSearch('status:active AND action:ban AND alert:123 AND duplicate:false');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }

    expect(compiled.predicate(baseDecision)).toBe(true);
    expect(compiled.predicate({ ...baseDecision, expired: true })).toBe(false);
    expect(compiled.predicate({ ...baseDecision, is_duplicate: true })).toBe(false);
  });

  test('supports date equality and the => alias for decisions', () => {
    const compiled = compileDecisionSearch('date=>2026-03-24 AND date=2026-03-24');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }

    expect(compiled.predicate(baseDecision)).toBe(true);
    expect(compiled.predicate({ ...baseDecision, created_at: '2026-03-25T10:00:00.000Z' })).toBe(false);
  });

  test('returns parse errors for malformed expressions', () => {
    const compiled = compileDecisionSearch('origin:(manual OR', {
      originEnabled: true,
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) {
      return;
    }

    expect(compiled.error.message).toContain('Missing closing parenthesis');
    expect(compiled.error.position).toBeGreaterThanOrEqual(0);
  });

  test('returns parse errors for unknown fields', () => {
    const compiled = compileAlertSearch('hostname:web-1');
    expect(compiled.ok).toBe(false);
    if (compiled.ok) {
      return;
    }

    expect(compiled.error.message).toContain('Unknown field');
  });

  test('rejects ordered comparisons on non-date fields', () => {
    const compiled = compileAlertSearch('scenario>ssh');
    expect(compiled.ok).toBe(false);
    if (compiled.ok) {
      return;
    }

    expect(compiled.error.message).toContain('only supported for date fields');
  });
});
