import { describe, expect, test } from 'vitest';
import { prefixMultilineLogArguments } from '../../logging';

describe('timestamped logging', () => {
  test('prefixes every physical line in multiline string arguments', () => {
    expect(prefixMultilineLogArguments([
      'Cache initialized:\n  Alerts: 10\n  Status: complete',
      { count: 10 },
    ], '[timestamp]')).toEqual([
      'Cache initialized:\n[timestamp]   Alerts: 10\n[timestamp]   Status: complete',
      { count: 10 },
    ]);
  });
});
