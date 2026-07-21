import { describe, expect, test } from 'vitest';
import type { DecisionListItem } from '../../types';
import { formatRemainingDuration, getDecisionExpirationState } from '../decisionExpiration';

function createDecision(overrides: Partial<DecisionListItem> = {}): DecisionListItem {
  const base: DecisionListItem = {
    id: 1,
    created_at: '2026-07-05T12:00:00.000Z',
    value: '1.2.3.4',
    expired: false,
    is_duplicate: false,
    detail: {
      origin: 'manual',
      duration: '4h',
      expiration: '2026-07-05T16:00:00.000Z',
    },
  };

  return {
    ...base,
    ...overrides,
    detail: {
      ...base.detail,
      ...overrides.detail,
    },
  };
}

describe('decision expiration formatting', () => {
  test('formats remaining milliseconds as CrowdSec-style duration text', () => {
    expect(formatRemainingDuration(3 * 3_600_000 + 10 * 60_000 + 20_000)).toBe('3h10m20s');
    expect(formatRemainingDuration(6_000)).toBe('6s');
    expect(formatRemainingDuration(1)).toBe('1s');
    expect(formatRemainingDuration(-1_000)).toBe('0s');
  });

  test('calculates live remaining time from the absolute expiration timestamp', () => {
    const state = getDecisionExpirationState(
      createDecision(),
      Date.parse('2026-07-05T12:21:15.000Z'),
    );

    expect(state).toMatchObject({
      isExpired: false,
      label: '3h38m45s',
      expiresAtMs: Date.parse('2026-07-05T16:00:00.000Z'),
    });
  });

  test('marks decisions expired once the expiration timestamp passes', () => {
    const state = getDecisionExpirationState(
      createDecision(),
      Date.parse('2026-07-05T16:00:01.000Z'),
    );

    expect(state.isExpired).toBe(true);
    expect(state.label).toBe('0s');
  });

  test('falls back to server duration when no absolute expiration is available', () => {
    const state = getDecisionExpirationState(createDecision({
      detail: { origin: 'manual', duration: '44m40s', expiration: undefined },
    }));

    expect(state).toEqual({
      isExpired: false,
      label: '44m40s',
      expiresAtMs: null,
    });
  });
});
