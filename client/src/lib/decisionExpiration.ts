import type { DecisionListItem } from '../types';

export interface DecisionExpirationState {
  isExpired: boolean;
  label: string;
  expiresAtMs: number | null;
}

export function formatRemainingDuration(remainingMs: number): string {
  const clampedMs = Math.max(0, remainingMs);
  const totalSeconds = clampedMs > 0 ? Math.ceil(clampedMs / 1_000) : 0;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours > 0 ? `${hours}h` : ''}${minutes > 0 || hours > 0 ? `${minutes}m` : ''}${seconds}s`;
}

export function getDecisionExpirationState(decision: DecisionListItem, nowMs = Date.now()): DecisionExpirationState {
  const expiresAtMs = decision.detail.expiration ? Date.parse(decision.detail.expiration) : Number.NaN;

  if (Number.isFinite(expiresAtMs)) {
    const remainingMs = expiresAtMs - nowMs;
    return {
      isExpired: remainingMs <= 0,
      label: formatRemainingDuration(remainingMs),
      expiresAtMs,
    };
  }

  if (decision.expired) {
    return {
      isExpired: true,
      label: '0s',
      expiresAtMs: null,
    };
  }

  return {
    isExpired: false,
    label: decision.detail.duration || 'N/A',
    expiresAtMs: null,
  };
}
