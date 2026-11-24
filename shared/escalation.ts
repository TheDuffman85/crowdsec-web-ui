import { parseDurationMs } from './duration';

export const DEFAULT_ESCALATION_BASE = '4h';
export const DEFAULT_ESCALATION_MAX = '30d';

/** Formats milliseconds as the largest whole unit the ban API accepts (`<number><s|m|h|d>`). */
export function formatDurationMs(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Doubles the ban for every earlier ban episode of the same address, up to a
 * cap: with a 4h base, a third offence gets 16h. Returns the base when there
 * were no earlier bans or when a duration cannot be parsed.
 */
export function escalateDuration(
  previousBans: number,
  base: string = DEFAULT_ESCALATION_BASE,
  max: string = DEFAULT_ESCALATION_MAX,
): string {
  const baseMs = parseDurationMs(base);
  const maxMs = parseDurationMs(max);
  if (baseMs === null || baseMs <= 0) return DEFAULT_ESCALATION_BASE;
  const ceiling = maxMs !== null && maxMs >= baseMs ? maxMs : baseMs;
  const steps = Math.max(0, Math.min(Math.floor(previousBans), 30));
  return formatDurationMs(Math.min(baseMs * 2 ** steps, ceiling));
}
