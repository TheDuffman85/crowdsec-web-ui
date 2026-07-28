import { describe, expect, test } from 'vitest';
import { compileDecisionSearch } from '../../../shared/search';
import { decisionSearchCanSplitDuplicateGroup } from '../../app/search-sql';

function compile(query: string) {
  const result = compileDecisionSearch(query, {
    machineEnabled: true,
    originEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.ast;
}

describe('decision duplicate-group query planning', () => {
  test.each([
    'ip:198.51.100.7',
    'sim:live',
    'instance:primary',
    'status:active',
    'ip:198.51.100.7 AND sim:live AND status:active',
    '(instance:primary OR instance:edge) AND -sim:simulated',
    'NOT ip:203.0.113.10',
  ])('keeps invariant search "%s" on persisted duplicate primaries', (query) => {
    expect(decisionSearchCanSplitDuplicateGroup(compile(query), false)).toBe(false);
  });

  test.each([
    'scenario:crowdsecurity/ssh-bf',
    'country:DE',
    'region:berlin',
    'city:berlin',
    'as:hetzner',
    'target:ssh',
    'date>=2026-01-01',
    'action:ban',
    'type:ban',
    'machine:host-a',
    'origin:lists',
    'id:10',
    'alert:20',
    'duplicate:false',
    'free-text',
    'ip:198.51.100.7 AND (scenario:ssh OR origin:lists)',
  ])('uses filtered promotion when search "%s" can split a group', (query) => {
    expect(decisionSearchCanSplitDuplicateGroup(compile(query), false)).toBe(true);
  });

  test('treats status as group-splitting only when expired history is included', () => {
    const ast = compile('status:expired');
    expect(decisionSearchCanSplitDuplicateGroup(ast, false)).toBe(false);
    expect(decisionSearchCanSplitDuplicateGroup(ast, true)).toBe(true);
  });
});
