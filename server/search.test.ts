import { describe, expect, test } from 'vitest';
import type { DecisionListItem, SlimAlert } from '../shared/contracts';
import { analyzeSearchQuery, compileAlertSearch, compileDecisionSearch, getSearchHelpDefinition } from '../shared/search';

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

const secondAlert: SlimAlert = {
  ...baseAlert,
  id: 2,
  created_at: '2026-03-25T12:00:00.000Z',
  scenario: 'crowdsecurity/nginx-bf',
  source: {
    ip: '5.6.7.8',
    value: '5.6.7.8',
    cn: 'US',
    as_name: 'AWS',
  },
  target: 'nginx',
  meta_search: 'nginx brute force',
};

const secondDecision: DecisionListItem = {
  ...baseDecision,
  id: 20,
  created_at: '2026-03-25T12:00:00.000Z',
  value: '5.6.7.8',
  simulated: true,
  detail: {
    ...baseDecision.detail,
    reason: 'crowdsecurity/nginx-bf',
    country: 'US',
    as: 'AWS',
    alert_id: 456,
    target: 'nginx',
  },
};

const swedenAlert: SlimAlert = {
  ...baseAlert,
  id: 3,
  source: {
    ...baseAlert.source,
    cn: 'SE',
  },
};

const swedenDecision: DecisionListItem = {
  ...baseDecision,
  id: 30,
  detail: {
    ...baseDecision.detail,
    country: 'SE',
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

  test('matches country codes exactly for alerts while keeping country-name matching broad', () => {
    const codeSearch = compileAlertSearch('country:DE');
    expect(codeSearch.ok).toBe(true);
    if (!codeSearch.ok) {
      return;
    }

    expect(codeSearch.predicate(baseAlert)).toBe(true);
    expect(codeSearch.predicate(swedenAlert)).toBe(false);

    const nameSearch = compileAlertSearch('country:germ');
    expect(nameSearch.ok).toBe(true);
    if (!nameSearch.ok) {
      return;
    }

    expect(nameSearch.predicate(baseAlert)).toBe(true);
    expect(nameSearch.predicate(swedenAlert)).toBe(false);
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

  test('matches country codes exactly for decisions while keeping country-name matching broad', () => {
    const codeSearch = compileDecisionSearch('country:DE');
    expect(codeSearch.ok).toBe(true);
    if (!codeSearch.ok) {
      return;
    }

    expect(codeSearch.predicate(baseDecision)).toBe(true);
    expect(codeSearch.predicate(swedenDecision)).toBe(false);

    const nameSearch = compileDecisionSearch('country:germ');
    expect(nameSearch.ok).toBe(true);
    if (!nameSearch.ok) {
      return;
    }

    expect(nameSearch.predicate(baseDecision)).toBe(true);
    expect(nameSearch.predicate(swedenDecision)).toBe(false);
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

  test('analyzes advanced queries into highlightable tokens', () => {
    const analysis = analyzeSearchQuery('origin:manual or country:"germany"', 'alerts', {
      originEnabled: true,
    });

    expect(analysis.error).toBeNull();
    expect(analysis.tokens.map((token) => `${token.kind}:${token.value}`)).toEqual([
      'field:origin',
      'comparator::',
      'term:manual',
      'booleanOperator:OR',
      'field:country',
      'comparator::',
      'string:germany',
    ]);
  });

  test('keeps tokens when parsing fails and shifts raw-query error positions', () => {
    const analysis = analyzeSearchQuery('  origin:(manual OR', 'decisions', {
      originEnabled: true,
    });

    expect(analysis.tokens.map((token) => `${token.kind}:${token.start}`)).toEqual([
      'field:2',
      'comparator:8',
      'paren:9',
      'term:10',
      'booleanOperator:17',
    ]);
    expect(analysis.error).not.toBeNull();
    expect(analysis.error?.message).toContain('Missing closing parenthesis');
    expect(analysis.error?.position).toBe(9);
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

  test('builds alert help examples from provided alert rows', () => {
    const help = getSearchHelpDefinition('alerts', {}, { alerts: [baseAlert, secondAlert] });

    expect(help.examples.map((example) => example.query)).toEqual([
      'ssh hetzner',
      '"SSH brute force detected"',
      'country:Germany ssh',
      'date>=2026-03-24 AND date<2026-03-25',
      'country:(Germany OR "United States") AND -sim:simulated',
      'ip:1.2.3.4 AND target:ssh',
    ]);
    expect(help.examples.every((example) => !/\b(machine|origin)\b/i.test(example.query))).toBe(true);
  });

  test('builds decision help examples from provided decision rows', () => {
    const help = getSearchHelpDefinition('decisions', {}, { decisions: [baseDecision, secondDecision] });

    expect(help.examples.map((example) => example.query)).toEqual([
      'ssh bf',
      'status:active AND action:ban',
      'date>=2026-03-24 AND action:ban',
      'alert:123 OR ip:"1.2.3.4"',
      'country:(Germany OR "United States") AND -duplicate:true',
      'target:ssh AND sim:live',
    ]);
    expect(help.examples.every((example) => !/\b(machine|origin)\b/i.test(example.query))).toBe(true);
  });

  test('falls back to generic help examples when no sample rows are provided', () => {
    const alertHelp = getSearchHelpDefinition('alerts');
    const decisionHelp = getSearchHelpDefinition('decisions');

    expect(alertHelp.examples[4]?.query).toBe('country:(germany OR france) AND -sim:simulated');
    expect(decisionHelp.examples[5]?.query).toBe('target:ssh AND sim:live');
  });

  test('skips numeric-only chunks when building free-text alert examples', () => {
    const help = getSearchHelpDefinition('alerts', {}, {
      alerts: [{
        ...baseAlert,
        target: '85.215.176.66',
        source: { ...baseAlert.source, as_name: undefined },
        scenario: 'crowdsecurity/vpatch-CVE-2025-55182',
        meta_search: '85.215.176.66 vpatch CVE-2025-55182',
      }],
    });

    expect(help.examples[0]?.query).toBe('vpatch cve');
    expect(help.examples[2]?.query).toBe('country:Germany vpatch');
  });
});
