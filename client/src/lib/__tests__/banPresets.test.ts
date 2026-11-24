import { describe, expect, test } from 'vitest';
import { BAN_DURATION_PRESETS, findDurationPreset, findReasonPreset } from '../banPresets';

describe('ban presets', () => {
  test('every duration preset uses a format the server accepts', () => {
    for (const preset of BAN_DURATION_PRESETS) {
      expect(preset.duration).toMatch(/^\d+[smhd]$/);
    }
    expect(BAN_DURATION_PRESETS.map((preset) => preset.id)).toEqual(['1h', '24h', '7d', 'permanent']);
  });

  test('finds presets by their current value', () => {
    expect(findDurationPreset('24h')?.id).toBe('24h');
    expect(findDurationPreset('4h')).toBeUndefined();
    expect(findDurationPreset(undefined)).toBeUndefined();

    const translate = (key: string) => (key === 'components.banPresets.reasonSpam' ? 'Spam' : key);
    expect(findReasonPreset('Spam', translate)?.id).toBe('spam');
    expect(findReasonPreset('  Spam ', translate)?.id).toBe('spam');
    expect(findReasonPreset('other', translate)).toBeUndefined();
    expect(findReasonPreset('', translate)).toBeUndefined();
  });
});
