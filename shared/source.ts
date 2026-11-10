// Blocklist importers that push many decisions as one alert set the alert's
// source to an unspecified address as a placeholder. No attacker can send from
// one, so it never names a real source.
const UNSPECIFIED_SOURCE_ADDRESSES = new Set([
  '0.0.0.0',
  '0.0.0.0/0',
  '0.0.0.0/32',
  '::',
  '::/0',
  '::/128',
]);

export function isUnspecifiedSourceAddress(value: string | null | undefined): boolean {
  return typeof value === 'string' && UNSPECIFIED_SOURCE_ADDRESSES.has(value.trim().toLowerCase());
}
