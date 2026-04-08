type OriginCarrier = {
  origin?: unknown;
};

export function normalizeOrigin(origin: unknown): string | undefined {
  if (typeof origin !== 'string') return undefined;

  const trimmed = origin.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function collectDistinctOrigins(decisions: Array<OriginCarrier | null | undefined> | null | undefined): string[] {
  const origins = new Set<string>();

  for (const decision of decisions || []) {
    const normalizedOrigin = normalizeOrigin(decision?.origin);
    if (normalizedOrigin) {
      origins.add(normalizedOrigin);
    }
  }

  return [...origins].sort((left, right) => left.localeCompare(right));
}

export function getOriginDisplayValue(origins: string[]): string {
  if (origins.length === 0) return '-';
  if (origins.length === 1) return origins[0];
  return 'Mixed';
}

export function getOriginTitle(origins: string[]): string | undefined {
  if (origins.length === 0) return undefined;
  return origins.join(', ');
}
