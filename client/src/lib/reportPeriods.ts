/** The last twelve calendar months, newest first, as YYYY-MM. */
export function recentMonths(now = new Date()): string[] {
  const months: string[] = [];
  for (let offset = 1; offset <= 12; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    months.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}
