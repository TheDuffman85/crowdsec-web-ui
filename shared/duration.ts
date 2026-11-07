const DURATION_UNITS_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses a whole-number duration such as `500ms`, `30s`, `5m`, `1h` or `7d`; returns null when invalid. */
export function parseDurationMs(value: string): number | null {
  const match = /^(\d+)(ms|[smhd])$/.exec(value.toLowerCase());
  return match ? Number.parseInt(match[1], 10) * DURATION_UNITS_MS[match[2]] : null;
}
