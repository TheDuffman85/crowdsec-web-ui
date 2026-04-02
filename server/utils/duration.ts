export function parseGoDuration(value: string | undefined | null): number {
  if (!value) return 0;

  let multiplier = 1;
  let source = value.trim();

  if (source.startsWith('-')) {
    multiplier = -1;
    source = source.slice(1);
  }

  const regex = /(\d+)(h|m|s)/g;
  let totalMs = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];

    if (unit === 'h') totalMs += amount * 3_600_000;
    if (unit === 'm') totalMs += amount * 60_000;
    if (unit === 's') totalMs += amount * 1_000;
  }

  return totalMs * multiplier;
}

export function toDuration(timestampMs: number, nowMs = Date.now()): string {
  const diffMs = nowMs - timestampMs;
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const seconds = Math.floor((diffMs % 60_000) / 1_000);
  return `${hours}h${minutes}m${seconds}s`;
}
