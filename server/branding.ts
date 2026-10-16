import crypto from 'node:crypto';
import {
  BRANDING_THEME_STYLE_ID,
  buildBrandingThemeCss,
  DEFAULT_BRANDING_THEME,
  isDefaultBrandingTheme,
  normalizeBrandingTheme,
  type BrandingTheme,
} from '../shared/branding-theme';
import type { CrowdsecDatabase } from './database';

export const DEFAULT_APP_NAME = 'CrowdSec Web UI';
export const APP_NAME_META_KEY = 'branding_app_name';
export const APP_LOGO_META_KEY = 'branding_logo';
export const APP_LOGO_DARK_META_KEY = 'branding_logo_dark';
export const APP_THEME_META_KEY = 'branding_theme';
export const MAX_APP_NAME_LENGTH = 60;
export const MAX_APP_LOGO_BYTES = 512 * 1024;
export const APP_LOGO_PATH = '/api/branding/logo';
export const APP_LOGO_DARK_PATH = '/api/branding/logo/dark';

/** The main logo is used everywhere; the optional dark variant only replaces it while the dark theme is active. */
export type AppLogoVariant = 'default' | 'dark';

export type AppLogoContentType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/svg+xml';

export interface AppLogo {
  contentType: AppLogoContentType;
  data: Buffer;
  version: string;
}

export interface PublicBranding {
  appName: string;
  defaultAppName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  theme: BrandingTheme;
}

export class BrandingValidationError extends Error {}

const DATA_URL_PATTERN = /^data:[^,]*;base64,([A-Za-z0-9+/]+={0,2})$/;
const parsedLogoCache = new WeakMap<CrowdsecDatabase, Map<AppLogoVariant, { stored: string; logo: AppLogo | null }>>();

function logoMetaKey(variant: AppLogoVariant): string {
  return variant === 'dark' ? APP_LOGO_DARK_META_KEY : APP_LOGO_META_KEY;
}

/**
 * Normalizes an admin-provided application name. Control characters are
 * stripped and whitespace collapsed; an empty result restores the default.
 */
export function normalizeAppName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BrandingValidationError('Application name must be a string');
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length > MAX_APP_NAME_LENGTH) {
    throw new BrandingValidationError(`Application name must be ${MAX_APP_NAME_LENGTH} characters or fewer`);
  }
  return normalized;
}

export function getAppName(database: CrowdsecDatabase): string {
  try {
    return database.getMeta(APP_NAME_META_KEY)?.value?.trim() || DEFAULT_APP_NAME;
  } catch {
    // Branding is cosmetic; never let a database error break logins or notifications.
    return DEFAULT_APP_NAME;
  }
}

export function saveAppName(database: CrowdsecDatabase, appName: string): void {
  database.setMeta(APP_NAME_META_KEY, appName);
}

function startsWithBytes(data: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

/** Detects the image type from its content instead of trusting the client. */
export function detectAppLogoContentType(data: Buffer): AppLogoContentType | null {
  if (startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWithBytes(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const header = data.subarray(0, 12).toString('latin1');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';

  if (data.includes(0)) return null;
  const text = data.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text)) {
    return 'image/svg+xml';
  }
  return null;
}

/** Validates an uploaded logo (base64 data URL) and returns its decoded form. */
export function parseAppLogoUpload(dataUrl: unknown): { contentType: AppLogoContentType; data: Buffer } {
  const match = typeof dataUrl === 'string' ? DATA_URL_PATTERN.exec(dataUrl.trim()) : null;
  if (!match) {
    throw new BrandingValidationError('Logo must be provided as a base64 data URL');
  }
  const data = Buffer.from(match[1], 'base64');
  if (data.length === 0) {
    throw new BrandingValidationError('Logo file is empty');
  }
  if (data.length > MAX_APP_LOGO_BYTES) {
    throw new BrandingValidationError(`Logo must be ${MAX_APP_LOGO_BYTES / 1024} KB or smaller`);
  }
  const contentType = detectAppLogoContentType(data);
  if (!contentType) {
    throw new BrandingValidationError('Logo must be a PNG, JPEG, GIF, WebP, or SVG image');
  }
  return { contentType, data };
}

export function saveAppLogo(
  database: CrowdsecDatabase,
  logo: { contentType: AppLogoContentType; data: Buffer },
  variant: AppLogoVariant = 'default',
): void {
  database.setMeta(logoMetaKey(variant), `data:${logo.contentType};base64,${logo.data.toString('base64')}`);
}

export function clearAppLogo(database: CrowdsecDatabase, variant: AppLogoVariant = 'default'): void {
  database.setMeta(logoMetaKey(variant), '');
}

function parseStoredLogo(stored: string): AppLogo | null {
  const match = DATA_URL_PATTERN.exec(stored);
  if (!match) return null;
  const data = Buffer.from(match[1], 'base64');
  const contentType = detectAppLogoContentType(data);
  if (!contentType) return null;
  return {
    contentType,
    data,
    version: crypto.createHash('sha256').update(stored).digest('hex').slice(0, 16),
  };
}

export function getAppLogo(database: CrowdsecDatabase, variant: AppLogoVariant = 'default'): AppLogo | null {
  let stored: string;
  try {
    stored = database.getMeta(logoMetaKey(variant))?.value || '';
  } catch {
    return null;
  }
  if (!stored) return null;

  let cache = parsedLogoCache.get(database);
  if (!cache) {
    cache = new Map();
    parsedLogoCache.set(database, cache);
  }
  const cached = cache.get(variant);
  if (cached?.stored === stored) return cached.logo;
  const logo = parseStoredLogo(stored);
  cache.set(variant, { stored, logo });
  return logo;
}

export function getAppLogoUrl(logo: AppLogo, basePath: string, variant: AppLogoVariant = 'default'): string {
  return `${basePath}${variant === 'dark' ? APP_LOGO_DARK_PATH : APP_LOGO_PATH}?v=${logo.version}`;
}

export function getAppTheme(database: CrowdsecDatabase): BrandingTheme {
  try {
    const stored = database.getMeta(APP_THEME_META_KEY)?.value;
    return stored ? normalizeBrandingTheme(JSON.parse(stored)) : DEFAULT_BRANDING_THEME;
  } catch {
    return DEFAULT_BRANDING_THEME;
  }
}

export function saveAppTheme(database: CrowdsecDatabase, theme: BrandingTheme): void {
  database.setMeta(APP_THEME_META_KEY, isDefaultBrandingTheme(theme) ? '' : JSON.stringify(theme));
}

export function getPublicBranding(database: CrowdsecDatabase, basePath: string): PublicBranding {
  const logo = getAppLogo(database);
  const logoDark = getAppLogo(database, 'dark');
  return {
    appName: getAppName(database),
    defaultAppName: DEFAULT_APP_NAME,
    logoUrl: logo ? getAppLogoUrl(logo, basePath) : null,
    logoDarkUrl: logoDark ? getAppLogoUrl(logoDark, basePath, 'dark') : null,
    theme: getAppTheme(database),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Injects the configured name, logo, and colors into the SPA shell so the
 * browser tab, bookmarks, home screen icons, and palette are branded before
 * any JavaScript runs. Original icon URLs are kept in data attributes so the
 * client can restore them.
 */
export function applyBrandingToIndexHtml(html: string, branding: PublicBranding): string {
  // Function replacers keep "$&"-style sequences in the name literal.
  let branded = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(branding.appName)}</title>`);

  const { logoUrl } = branding;
  if (logoUrl) {
    branded = branded.replace(/<link\b[^>]*\brel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/gi, (tag) => {
      const rel = /\brel="([^"]*)"/i.exec(tag)?.[1] ?? 'icon';
      const sizes = /\bsizes="([^"]*)"/i.exec(tag)?.[1];
      const defaultHref = /\bhref="([^"]*)"/i.exec(tag)?.[1] ?? '';
      const defaultType = /\btype="([^"]*)"/i.exec(tag)?.[1] ?? '';
      const sizesAttribute = sizes ? ` sizes="${sizes}"` : '';
      return `<link rel="${rel}"${sizesAttribute} href="${escapeHtml(logoUrl)}" data-default-href="${defaultHref}" data-default-type="${defaultType}" />`;
    });
  }

  // The theme CSS is built only from validated hex colors and preset names.
  const themeCss = buildBrandingThemeCss(branding.theme);
  if (themeCss) {
    branded = branded.replace('</head>', () => `<style id="${BRANDING_THEME_STYLE_ID}">${themeCss}</style>\n</head>`);
  }

  return branded;
}

/** Serializes branding for an inline script without allowing it to close the tag. */
export function serializeBrandingForScript(branding: PublicBranding): string {
  return JSON.stringify(branding)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}
