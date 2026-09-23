/** Date display patterns use day, month, and year tokens; `browser` keeps the locale default. */
export type DateFormat = string;

type DateToken = 'd' | 'dd' | 'm' | 'mm' | 'mmm' | 'mmmm' | 'yy' | 'yyyy';
type PatternPart = { token: DateToken } | { literal: string };
const TOKEN_PATTERN = /yyyy|mmmm|mmm|mm|dd|yy|m|d/iy;

function parsePattern(pattern: string): PatternPart[] | null {
  const parts: PatternPart[] = [];
  const used = new Set<'day' | 'month' | 'year'>();
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    if (char === "'") {
      let literal = '';
      index++;
      let closed = false;
      while (index < pattern.length) {
        if (pattern[index] === "'") {
          if (pattern[index + 1] === "'") {
            literal += "'";
            index += 2;
          } else {
            index++;
            closed = true;
            break;
          }
        } else {
          literal += pattern[index++];
        }
      }
      if (!closed) return null;
      parts.push({ literal });
    } else if (/[a-z]/i.test(char)) {
      TOKEN_PATTERN.lastIndex = index;
      const match = TOKEN_PATTERN.exec(pattern);
      if (!match) return null;
      const token = match[0].toLowerCase() as DateToken;
      const field = token.startsWith('d') ? 'day' : token.startsWith('m') ? 'month' : 'year';
      if (used.has(field)) return null;
      used.add(field);
      parts.push({ token });
      index = TOKEN_PATTERN.lastIndex;
    } else {
      if (/[\r\n\u0000-\u001f]/.test(char)) return null;
      parts.push({ literal: char });
      index++;
    }
  }
  return used.size === 3 ? parts : null;
}

export function isValidDateFormat(value: string): boolean {
  return value === 'browser' || parsePattern(value) !== null;
}

export function formatCustomDate(date: Date, pattern: string, timeZone: string | null): string {
  const parts = parsePattern(pattern);
  if (!parts) throw new Error(`Invalid date format pattern: ${pattern}`);
  const options = timeZone ? { timeZone } : {};
  const dateParts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    ...options, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date);
  const value = (type: 'day' | 'month' | 'year') => dateParts.find((part) => part.type === type)?.value ?? '';
  const day = value('day');
  const month = value('month');
  const year = value('year');
  return parts.map((part) => {
    if ('literal' in part) return part.literal;
    switch (part.token) {
      case 'd': return day;
      case 'dd': return day.padStart(2, '0');
      case 'm': return month;
      case 'mm': return month.padStart(2, '0');
      case 'mmm': return new Intl.DateTimeFormat(undefined, { ...options, month: 'short' }).format(date);
      case 'mmmm': return new Intl.DateTimeFormat(undefined, { ...options, month: 'long' }).format(date);
      case 'yy': return year.slice(-2).padStart(2, '0');
      case 'yyyy': return year.padStart(4, '0');
    }
  }).join('');
}
