import { describe, expect, test } from 'vitest';
import { compileAlertSearch } from '../../../../shared/search';
import {
  getQuickFilterCompatibility,
  type QuickFilterIncompatibilityReason,
} from '../quickFilterCompatibility';
import { ALERT_QUICK_FILTER_FIELDS } from '../quickFilters';

function compatibility(query: string) {
  const compiled = compileAlertSearch(query, { machineEnabled: true, originEnabled: true });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return getQuickFilterCompatibility(compiled.ast, ALERT_QUICK_FILTER_FIELDS);
}

test.each([
  '',
  'target=abc',
  'target<>abc',
  'NOT target=abc',
  'target=abc OR target=def',
  '(target=abc OR target=def) AND country<>DE',
  'date>=2026-03-24 AND date<=2026-03-25',
])('accepts a safely representable search: %s', (query) => {
  expect(compatibility(query)).toEqual({ compatible: true });
});

describe.each<[string, QuickFilterIncompatibilityReason]>([
  ['target:abc', 'broad-match'],
  ['ssh', 'free-text'],
  ['date>2026-03-24', 'strict-date'],
  ['message=blocked', 'unsupported-field'],
  ['target=abc OR country=DE', 'boolean-logic'],
  ['target=abc OR target:def', 'boolean-logic'],
  ['NOT (target=abc AND country=DE)', 'boolean-logic'],
  ['target=abc AND target=def', 'conflicting-filter'],
  ['(target=abc OR target=def) AND target<>def', 'conflicting-filter'],
  ['sim=live OR sim=invalid', 'conflicting-filter'],
])('rejects an unsafe search', (query, reason) => {
  test(`${query} as ${reason}`, () => {
    expect(compatibility(query)).toEqual({ compatible: false, reason });
  });
});
