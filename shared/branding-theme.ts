/**
 * Branding color theme shared by the server (injected into the SPA shell) and
 * the client (applied live and previewed in settings).
 *
 * Every value is either a strict `#rrggbb` hex color or a known preset name,
 * so the generated CSS can never contain anything an admin typed verbatim.
 */

/** Id of the `<style>` element holding the theme overrides in the page head. */
export const BRANDING_THEME_STYLE_ID = 'branding-theme';

export const THEME_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type ThemeShade = typeof THEME_SHADES[number];
export type ThemeScale = Record<ThemeShade, string>;

export const NEUTRAL_TONES = ['gray', 'slate', 'zinc', 'neutral', 'stone'] as const;
export type NeutralTone = typeof NEUTRAL_TONES[number];
export const DEFAULT_NEUTRAL_TONE: NeutralTone = 'gray';

export const THEME_MODES = ['light', 'dark'] as const;
export type ThemeModeName = typeof THEME_MODES[number];

export interface ThemeModeColors {
  /** Accent color as `#rrggbb`, or null for the default (or, in dark mode, the light mode setting). */
  accent: string | null;
  /** Neutral tone preset, or null for the default (or, in dark mode, the light mode setting). */
  neutral: NeutralTone | null;
}

export interface BrandingTheme {
  light: ThemeModeColors;
  dark: ThemeModeColors;
}

export const DEFAULT_BRANDING_THEME: BrandingTheme = {
  light: { accent: null, neutral: null },
  dark: { accent: null, neutral: null },
};

/** The built-in accent palette; keep in sync with `@theme` in client/src/index.css. */
export const DEFAULT_ACCENT_SCALE: ThemeScale = {
  50: '#f0f9ff',
  100: '#e0f2fe',
  200: '#bae6fd',
  300: '#7dd3fc',
  400: '#38bdf8',
  500: '#0ea5e9',
  600: '#0284c7',
  700: '#0369a1',
  800: '#075985',
  900: '#0c4a6e',
  950: '#082f49',
};

/** Accent shade 600 of the built-in palette; used as the color picker's starting value. */
export const DEFAULT_ACCENT_COLOR = DEFAULT_ACCENT_SCALE[600];

/** WCAG AA contrast for normal text; below it the settings page warns that the accent may be hard to read. */
export const MIN_ACCENT_CONTRAST = 4.5;

export class BrandingThemeValidationError extends Error {}

// Tailwind's neutral palettes, in OKLCH [lightness, chroma, hue].
const NEUTRAL_PALETTES: Record<NeutralTone, Array<[number, number, number]>> = {
  gray: [[0.985, 0.002, 247.839], [0.967, 0.003, 264.542], [0.928, 0.006, 264.531], [0.872, 0.01, 258.338], [0.707, 0.022, 261.325], [0.551, 0.027, 264.364], [0.446, 0.03, 256.802], [0.373, 0.034, 259.733], [0.278, 0.033, 256.848], [0.21, 0.034, 264.665], [0.13, 0.028, 261.692]],
  slate: [[0.984, 0.003, 247.858], [0.968, 0.007, 247.896], [0.929, 0.013, 255.508], [0.869, 0.022, 252.894], [0.704, 0.04, 256.788], [0.554, 0.046, 257.417], [0.446, 0.043, 257.281], [0.372, 0.044, 257.287], [0.279, 0.041, 260.031], [0.208, 0.042, 265.755], [0.129, 0.042, 264.695]],
  zinc: [[0.985, 0, 0], [0.967, 0.001, 286.375], [0.92, 0.004, 286.32], [0.871, 0.006, 286.286], [0.705, 0.015, 286.067], [0.552, 0.016, 285.938], [0.442, 0.017, 285.786], [0.37, 0.013, 285.805], [0.274, 0.006, 286.033], [0.21, 0.006, 285.885], [0.141, 0.005, 285.823]],
  neutral: [[0.985, 0, 0], [0.97, 0, 0], [0.922, 0, 0], [0.87, 0, 0], [0.708, 0, 0], [0.556, 0, 0], [0.439, 0, 0], [0.371, 0, 0], [0.269, 0, 0], [0.205, 0, 0], [0.145, 0, 0]],
  stone: [[0.985, 0.001, 106.423], [0.97, 0.001, 106.424], [0.923, 0.003, 48.717], [0.869, 0.005, 56.366], [0.709, 0.01, 56.259], [0.553, 0.013, 58.071], [0.444, 0.011, 73.639], [0.374, 0.01, 67.558], [0.268, 0.007, 34.298], [0.216, 0.006, 56.043], [0.147, 0.004, 49.25]],
};

// Lightness and relative chroma of each generated accent shade, modelled on Tailwind's palettes.
const ACCENT_LIGHTNESS = [0.977, 0.951, 0.901, 0.828, 0.746, 0.685, 0.588, 0.5, 0.443, 0.391, 0.293];
const ACCENT_CHROMA_PROFILE = [0.08, 0.15, 0.34, 0.65, 0.94, 1, 0.94, 0.8, 0.66, 0.55, 0.39];
const MAX_ACCENT_CHROMA = 0.37;

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Returns the color as lowercase `#rrggbb`, or null when it is not a hex color. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = HEX_PATTERN.exec(value.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  return `#${digits.toLowerCase()}`;
}

function isNeutralTone(value: unknown): value is NeutralTone {
  return typeof value === 'string' && (NEUTRAL_TONES as readonly string[]).includes(value);
}

/** Lenient normalization for stored or received themes: invalid values fall back to the default. */
export function normalizeBrandingTheme(value: unknown): BrandingTheme {
  const candidate = value && typeof value === 'object' ? value as Partial<Record<ThemeModeName, unknown>> : {};
  const normalizeMode = (mode: unknown): ThemeModeColors => {
    const colors = mode && typeof mode === 'object' ? mode as Partial<Record<keyof ThemeModeColors, unknown>> : {};
    return {
      accent: normalizeHexColor(colors.accent),
      neutral: isNeutralTone(colors.neutral) ? colors.neutral : null,
    };
  };
  return { light: normalizeMode(candidate.light), dark: normalizeMode(candidate.dark) };
}

/** Strict validation for admin input: rejects anything that is not empty, a hex color, or a known preset. */
export function parseBrandingThemeInput(value: unknown): BrandingTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrandingThemeValidationError('Theme must be an object');
  }
  const input = value as Partial<Record<ThemeModeName, unknown>>;
  const parseMode = (modeName: ThemeModeName): ThemeModeColors => {
    const mode = input[modeName] ?? {};
    if (typeof mode !== 'object' || Array.isArray(mode)) {
      throw new BrandingThemeValidationError(`Theme ${modeName} colors must be an object`);
    }
    const { accent, neutral } = mode as Partial<Record<keyof ThemeModeColors, unknown>>;
    const normalizedAccent = accent === null || accent === undefined || accent === '' ? null : normalizeHexColor(accent);
    if (normalizedAccent === null && accent !== null && accent !== undefined && accent !== '') {
      throw new BrandingThemeValidationError(`Theme ${modeName} accent must be a hex color such as #0284c7`);
    }
    if (neutral !== null && neutral !== undefined && neutral !== '' && !isNeutralTone(neutral)) {
      throw new BrandingThemeValidationError(`Theme ${modeName} neutral tone must be one of: ${NEUTRAL_TONES.join(', ')}`);
    }
    return { accent: normalizedAccent, neutral: isNeutralTone(neutral) ? neutral : null };
  };
  return { light: parseMode('light'), dark: parseMode('dark') };
}

export function isDefaultBrandingTheme(theme: BrandingTheme): boolean {
  return THEME_MODES.every((mode) => theme[mode].accent === null && theme[mode].neutral === null);
}

/** Resolves a mode's effective colors: dark mode falls back to light mode, which falls back to the defaults. */
export function resolveThemeMode(theme: BrandingTheme, mode: ThemeModeName): { accent: string | null; neutral: NeutralTone } {
  const fallback = mode === 'dark' ? theme.light : DEFAULT_BRANDING_THEME.light;
  return {
    accent: theme[mode].accent ?? fallback.accent,
    neutral: theme[mode].neutral ?? fallback.neutral ?? DEFAULT_NEUTRAL_TONE,
  };
}

// --- Color math (OKLCH <-> sRGB) ---

type Rgb = [number, number, number];

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToOklch([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bAxis, a) * 180) / Math.PI;
  return [lightness, Math.hypot(a, bAxis), hue < 0 ? hue + 360 : hue];
}

/** Converts OKLCH to linear sRGB, which may fall outside [0, 1] when out of gamut. */
function oklchToLinearRgb(lightness: number, chroma: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

/** Converts OKLCH to hex, reducing chroma until the color fits into sRGB. */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  let low = 0;
  let high = chroma;
  if (!inGamut(oklchToLinearRgb(lightness, high, hue))) {
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinearRgb(lightness, mid, hue))) low = mid;
      else high = mid;
    }
    high = low;
  }
  const linear = oklchToLinearRgb(lightness, high, hue);
  return rgbToHex(linear.map((channel) => linearToSrgb(Math.min(1, Math.max(0, channel)))) as Rgb);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1 to 21). */
export function getContrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Generates a 50-950 accent scale from one color. The chosen color is kept
 * exactly at the shade closest to its lightness; the other shades share its
 * hue and follow a Tailwind-like lightness and chroma curve.
 */
export function generateAccentScale(color: string): ThemeScale {
  const hex = normalizeHexColor(color) ?? DEFAULT_ACCENT_COLOR;
  const [lightness, chroma, hue] = rgbToOklch(hexToRgb(hex));
  let anchor = 0;
  ACCENT_LIGHTNESS.forEach((target, index) => {
    if (Math.abs(target - lightness) < Math.abs(ACCENT_LIGHTNESS[anchor] - lightness)) anchor = index;
  });
  const peakChroma = Math.min(MAX_ACCENT_CHROMA, chroma / ACCENT_CHROMA_PROFILE[anchor]);

  const scale = Object.fromEntries(THEME_SHADES.map((shade, index) => [
    shade,
    index === anchor ? hex : oklchToHex(ACCENT_LIGHTNESS[index], peakChroma * ACCENT_CHROMA_PROFILE[index], hue),
  ])) as ThemeScale;

  // Shade 600 carries white button text and light mode links: darken a generated
  // one until it meets WCAG AA, staying lighter than shade 700.
  const buttonIndex = THEME_SHADES.indexOf(600);
  if (buttonIndex !== anchor) {
    let buttonLightness = ACCENT_LIGHTNESS[buttonIndex];
    const minLightness = ACCENT_LIGHTNESS[buttonIndex + 1] + 0.01;
    while (getContrastRatio('#ffffff', scale[600]) < MIN_ACCENT_CONTRAST && buttonLightness > minLightness) {
      buttonLightness = Math.max(minLightness, buttonLightness - 0.005);
      scale[600] = oklchToHex(buttonLightness, peakChroma * ACCENT_CHROMA_PROFILE[buttonIndex], hue);
    }
  }
  return scale;
}

export function getNeutralScale(tone: NeutralTone): ThemeScale {
  return Object.fromEntries(THEME_SHADES.map((shade, index) => {
    const [lightness, chroma, hue] = NEUTRAL_PALETTES[tone][index];
    return [shade, oklchToHex(lightness, chroma, hue)];
  })) as ThemeScale;
}

function formatNeutral(tone: NeutralTone, index: number): string {
  const [lightness, chroma, hue] = NEUTRAL_PALETTES[tone][index];
  return `oklch(${Math.round(lightness * 1000) / 10}% ${chroma} ${hue})`;
}

function getAccentScale(accent: string | null): ThemeScale {
  return accent ? generateAccentScale(accent) : DEFAULT_ACCENT_SCALE;
}

function getThemeVariables(accentScale: ThemeScale | null, neutral: NeutralTone | null): Record<string, string> {
  const variables: Record<string, string> = {};
  if (accentScale) {
    for (const shade of THEME_SHADES) variables[`--color-primary-${shade}`] = accentScale[shade];
  }
  if (neutral) {
    THEME_SHADES.forEach((shade, index) => {
      variables[`--color-gray-${shade}`] = formatNeutral(neutral, index);
    });
  }
  return variables;
}

/** CSS custom properties overriding the Tailwind colors for one mode's explicit settings. */
export function getThemeModeVariables(colors: ThemeModeColors): Record<string, string> {
  return getThemeVariables(colors.accent ? generateAccentScale(colors.accent) : null, colors.neutral);
}

/** Variables for every color of a mode's effective palette, including defaults; used to render previews. */
export function getResolvedThemeModeVariables(theme: BrandingTheme, mode: ThemeModeName): Record<string, string> {
  const resolved = resolveThemeMode(theme, mode);
  return getThemeVariables(getAccentScale(resolved.accent), resolved.neutral);
}

/**
 * Builds the stylesheet applied on top of the default palette. Light mode
 * settings apply to both modes, so dark mode inherits them unless overridden.
 */
export function buildBrandingThemeCss(theme: BrandingTheme): string {
  const block = (selector: string, variables: Record<string, string>) => {
    const declarations = Object.entries(variables).map(([name, value]) => `${name}:${value};`).join('');
    return declarations ? `${selector}{${declarations}}` : '';
  };
  return block(':root', getThemeModeVariables(theme.light)) + block(':root.dark', getThemeModeVariables(theme.dark));
}

export interface AccentContrast {
  /** White button text on the accent (shade 600). */
  buttonText: number;
  /** Accent text on the mode's page background (600 on white, or 400 on neutral 900). */
  accentText: number;
}

/** Contrast of a mode's custom accent, or null when the built-in palette is used. */
export function getAccentContrast(theme: BrandingTheme, mode: ThemeModeName): AccentContrast | null {
  const resolved = resolveThemeMode(theme, mode);
  if (!resolved.accent) return null;
  const accent = generateAccentScale(resolved.accent);
  const neutral = getNeutralScale(resolved.neutral);
  return {
    buttonText: getContrastRatio('#ffffff', accent[600]),
    accentText: mode === 'light' ? getContrastRatio(accent[600], '#ffffff') : getContrastRatio(accent[400], neutral[900]),
  };
}
