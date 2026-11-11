import { BULK_ADD_DECISIONS_MAX } from '../../../shared/contracts';

/** Values a "Ban all" action covers: the listed ones without a decision, when there are at least two. */
export function pendingBanValues(values: string[], decided: Set<string>): string[] {
  const pending = values.filter((value) => !decided.has(value)).slice(0, BULK_ADD_DECISIONS_MAX);
  return pending.length < 2 ? [] : pending;
}
