const INDEX_HINT_PATTERN = /\s+INDEXED\s+BY\s+[A-Za-z_][A-Za-z0-9_]*/gi;

export function withoutUnavailableIndexHints(sql: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\bno such index:\s+/i.test(message)) return null;
  const fallbackSql = sql.replace(INDEX_HINT_PATTERN, '');
  return fallbackSql === sql ? null : fallbackSql;
}
