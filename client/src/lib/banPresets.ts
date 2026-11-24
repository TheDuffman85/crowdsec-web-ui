export interface BanDurationPreset {
  id: string;
  /** Value sent to the server, in the format it validates (`<number><s|m|h|d>`). */
  duration: string;
  labelKey: string;
}

export interface BanReasonPreset {
  id: string;
  labelKey: string;
}

export const BAN_DURATION_PRESETS: readonly BanDurationPreset[] = [
  { id: '1h', duration: '1h', labelKey: 'components.banPresets.duration1h' },
  { id: '24h', duration: '24h', labelKey: 'components.banPresets.duration24h' },
  { id: '7d', duration: '7d', labelKey: 'components.banPresets.duration7d' },
  // CrowdSec has no unlimited ban through this API, so "permanent" means ten years.
  { id: 'permanent', duration: '3650d', labelKey: 'components.banPresets.durationPermanent' },
];

export const BAN_REASON_PRESETS: readonly BanReasonPreset[] = [
  { id: 'bruteForce', labelKey: 'components.banPresets.reasonBruteForce' },
  { id: 'portScan', labelKey: 'components.banPresets.reasonPortScan' },
  { id: 'vulnScan', labelKey: 'components.banPresets.reasonVulnScan' },
  { id: 'abusive', labelKey: 'components.banPresets.reasonAbusive' },
  { id: 'spam', labelKey: 'components.banPresets.reasonSpam' },
  { id: 'manual', labelKey: 'components.banPresets.reasonManual' },
];

export function findDurationPreset(duration: string | undefined): BanDurationPreset | undefined {
  return BAN_DURATION_PRESETS.find((preset) => preset.duration === duration);
}

/** The reason preset whose translated label equals the current reason text, if any. */
export function findReasonPreset(
  reason: string | undefined,
  translate: (key: string) => string,
): BanReasonPreset | undefined {
  const text = (reason ?? '').trim();
  if (!text) return undefined;
  return BAN_REASON_PRESETS.find((preset) => translate(preset.labelKey) === text);
}
