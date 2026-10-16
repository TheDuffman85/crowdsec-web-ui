import {
  BRANDING_THEME_STYLE_ID,
  DEFAULT_BRANDING_THEME,
  buildBrandingThemeCss,
  normalizeBrandingTheme,
  type BrandingTheme,
} from '../../../shared/branding-theme';
import { apiUrl, assetUrl } from './basePath';
import { sessionFetch } from './sessionFetch';

export type AppLogoVariant = 'default' | 'dark';

export const DEFAULT_APP_NAME = 'CrowdSec Web UI';
export const DEFAULT_LOGO_PATH = '/logo-sidebar.png';
export const MAX_APP_NAME_LENGTH = 60;
export const MAX_APP_LOGO_BYTES = 512 * 1024;
export const ACCEPTED_APP_LOGO_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

export interface PublicBranding {
  appName: string;
  defaultAppName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  theme: BrandingTheme;
}

export const DEFAULT_BRANDING: PublicBranding = {
  appName: DEFAULT_APP_NAME,
  defaultAppName: DEFAULT_APP_NAME,
  logoUrl: null,
  logoDarkUrl: null,
  theme: DEFAULT_BRANDING_THEME,
};

export function normalizeBranding(value: unknown): PublicBranding {
  const candidate = value && typeof value === 'object' ? value as Partial<PublicBranding> : {};
  const defaultAppName = typeof candidate.defaultAppName === 'string' && candidate.defaultAppName
    ? candidate.defaultAppName
    : DEFAULT_APP_NAME;
  return {
    appName: typeof candidate.appName === 'string' && candidate.appName.trim() ? candidate.appName : defaultAppName,
    defaultAppName,
    logoUrl: typeof candidate.logoUrl === 'string' && candidate.logoUrl ? candidate.logoUrl : null,
    logoDarkUrl: typeof candidate.logoDarkUrl === 'string' && candidate.logoDarkUrl ? candidate.logoDarkUrl : null,
    theme: normalizeBrandingTheme(candidate.theme),
  };
}

/** Branding the server injected into index.html, so the first render is already branded. */
export function getInitialBranding(): PublicBranding {
  if (typeof window === 'undefined' || !window.__BRANDING__) return DEFAULT_BRANDING;
  return normalizeBranding(window.__BRANDING__);
}

export function getDefaultLogoUrl(): string {
  return assetUrl(DEFAULT_LOGO_PATH);
}

/** Keeps the browser tab title and icons in sync with the configured branding. */
export function applyDocumentBranding({ appName, logoUrl }: PublicBranding): void {
  document.title = appName;

  const links = document.querySelectorAll<HTMLLinkElement>(
    "link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']",
  );
  links.forEach((link) => {
    link.dataset.defaultHref ??= link.getAttribute('href') ?? '';
    link.dataset.defaultType ??= link.getAttribute('type') ?? '';

    if (logoUrl) {
      link.removeAttribute('type');
      if (link.getAttribute('href') !== logoUrl) link.setAttribute('href', logoUrl);
      return;
    }

    if (link.getAttribute('href') !== link.dataset.defaultHref) {
      link.setAttribute('href', link.dataset.defaultHref);
    }
    if (link.dataset.defaultType) link.setAttribute('type', link.dataset.defaultType);
  });
}

/** Applies the theme colors, replacing the stylesheet the server injected into the page shell. */
export function applyThemeBranding(theme: BrandingTheme): void {
  const css = buildBrandingThemeCss(theme);
  let style = document.getElementById(BRANDING_THEME_STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = BRANDING_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

async function readBrandingResponse(response: Response, fallbackMessage: string): Promise<PublicBranding> {
  const payload = await response.json().catch(() => null) as (PublicBranding & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return normalizeBranding(payload);
}

export async function fetchBranding(): Promise<PublicBranding> {
  const response = await fetch(apiUrl('/api/branding'), { cache: 'no-store' });
  return readBrandingResponse(response, 'Failed to load branding');
}

export async function updateAppName(appName: string): Promise<PublicBranding> {
  const response = await sessionFetch(apiUrl('/api/branding'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName }),
  });
  return readBrandingResponse(response, 'Failed to save the application name');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function logoApiPath(variant: AppLogoVariant): string {
  return variant === 'dark' ? '/api/branding/logo/dark' : '/api/branding/logo';
}

export async function uploadAppLogo(file: File, variant: AppLogoVariant = 'default'): Promise<PublicBranding> {
  const dataUrl = await readFileAsDataUrl(file);
  const response = await sessionFetch(apiUrl(logoApiPath(variant)), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  return readBrandingResponse(response, 'Failed to update the logo');
}

export async function resetAppLogo(variant: AppLogoVariant = 'default'): Promise<PublicBranding> {
  const response = await sessionFetch(apiUrl(logoApiPath(variant)), { method: 'DELETE' });
  return readBrandingResponse(response, 'Failed to update the logo');
}

export async function updateAppTheme(theme: BrandingTheme): Promise<PublicBranding> {
  const response = await sessionFetch(apiUrl('/api/branding/theme'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
  return readBrandingResponse(response, 'Failed to save the colors');
}
