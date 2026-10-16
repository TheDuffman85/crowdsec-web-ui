import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrandingProvider } from '../../contexts/BrandingContext';
import { useBranding } from '../../contexts/useBranding';
import { AppLogo } from '../../components/AppLogo';
import { applyDocumentBranding, applyThemeBranding, getInitialBranding, normalizeBranding } from '../branding';
import { DEFAULT_BRANDING_THEME } from '../../../../shared/branding-theme';

function BrandingProbe() {
  const { appName } = useBranding();
  return (
    <>
      <span>{appName}</span>
      <AppLogo alt="logo" />
    </>
  );
}

function addIconLink(rel: string, href: string, type?: string): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = rel;
  link.setAttribute('href', href);
  if (type) link.setAttribute('type', type);
  document.head.appendChild(link);
  return link;
}

afterEach(() => {
  delete window.__BRANDING__;
  document.getElementById('branding-theme')?.remove();
  document.head.querySelectorAll('link').forEach((link) => link.remove());
  document.title = '';
  vi.unstubAllGlobals();
});

describe('branding', () => {
  test('normalizes partial or invalid payloads to the default branding', () => {
    expect(normalizeBranding(null)).toEqual({ appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    expect(normalizeBranding({ appName: '  ', logoUrl: '', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME })).toEqual({ appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    window.__BRANDING__ = { appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: '/logo?v=1', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME };
    expect(getInitialBranding()).toEqual({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: '/logo?v=1', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
  });

  test('switches the document title and icons to the custom logo and back', () => {
    const icon = addIconLink('icon', './logo-sidebar.png', 'image/png');
    const apple = addIconLink('apple-touch-icon', './apple-touch-icon.png');
    const manifest = addIconLink('manifest', './site.webmanifest');

    applyDocumentBranding({ appName: 'Acme SOC', defaultAppName: 'CrowdSec Web UI', logoUrl: '/api/branding/logo?v=1', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    expect(document.title).toBe('Acme SOC');
    expect(icon.getAttribute('href')).toBe('/api/branding/logo?v=1');
    expect(icon.hasAttribute('type')).toBe(false);
    expect(apple.getAttribute('href')).toBe('/api/branding/logo?v=1');
    expect(manifest.getAttribute('href')).toBe('./site.webmanifest');

    applyDocumentBranding({ appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    expect(document.title).toBe('CrowdSec Web UI');
    expect(icon.getAttribute('href')).toBe('./logo-sidebar.png');
    expect(icon.getAttribute('type')).toBe('image/png');
    expect(apple.getAttribute('href')).toBe('./apple-touch-icon.png');
  });

  test('restores the original icons injected by the server', () => {
    const icon = addIconLink('icon', '/api/branding/logo?v=1');
    icon.dataset.defaultHref = '/crowdsec/logo-sidebar.png';
    icon.dataset.defaultType = 'image/png';

    applyDocumentBranding({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    expect(icon.getAttribute('href')).toBe('/crowdsec/logo-sidebar.png');
    expect(icon.getAttribute('type')).toBe('image/png');
  });

  test('provider starts from injected branding and refreshes from the API', async () => {
    window.__BRANDING__ = { appName: 'Injected', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME };
    let resolveFetch: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    render(<BrandingProvider><BrandingProbe /></BrandingProvider>);
    expect(screen.getByText('Injected')).toBeInTheDocument();
    expect(screen.getByAltText('logo')).toHaveAttribute('src', '/logo-sidebar.png');

    resolveFetch(new Response(JSON.stringify({ appName: 'Acme SOC', defaultAppName: 'CrowdSec Web UI', logoUrl: '/api/branding/logo?v=2', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME })));
    await waitFor(() => expect(screen.getByText('Acme SOC')).toBeInTheDocument());
    expect(screen.getByAltText('logo')).toHaveAttribute('src', '/api/branding/logo?v=2');
    // document.title is applied in a passive effect, which can flush after the re-render is visible.
    await waitFor(() => expect(document.title).toBe('Acme SOC'));
  });

  test('normalizes dark logos and themes from the API', () => {
    expect(normalizeBranding({
      appName: 'Acme',
      logoDarkUrl: '/api/branding/logo/dark?v=1',
      theme: { light: { accent: '#E11D48', neutral: 'bogus' }, dark: { neutral: 'zinc' } },
    })).toEqual({
      appName: 'Acme',
      defaultAppName: 'CrowdSec Web UI',
      logoUrl: null,
      logoDarkUrl: '/api/branding/logo/dark?v=1',
      theme: { light: { accent: '#e11d48', neutral: null }, dark: { accent: null, neutral: 'zinc' } },
    });
  });

  test('replaces the injected theme stylesheet and removes it for the default colors', () => {
    const injected = document.createElement('style');
    injected.id = 'branding-theme';
    injected.textContent = ':root{--color-primary-600:#000000;}';
    document.head.appendChild(injected);

    applyThemeBranding({ light: { accent: '#e11d48', neutral: null }, dark: { accent: null, neutral: 'slate' } });
    const style = document.getElementById('branding-theme');
    expect(style).toBe(injected);
    expect(style?.textContent).toContain('--color-primary-600:#e11d48;');
    expect(style?.textContent).toContain(':root.dark{--color-gray-50:');

    applyThemeBranding(DEFAULT_BRANDING_THEME);
    expect(document.getElementById('branding-theme')).toBeNull();

    applyThemeBranding({ light: { accent: null, neutral: 'stone' }, dark: { accent: null, neutral: null } });
    expect(document.getElementById('branding-theme')?.textContent).toMatch(/^:root\{--color-gray-50:/);
  });

  test('renders the dark mode logo only while the dark theme is active and falls back when it fails', async () => {
    window.__BRANDING__ = {
      appName: 'Acme',
      defaultAppName: 'CrowdSec Web UI',
      logoUrl: '/api/branding/logo?v=1',
      logoDarkUrl: '/api/branding/logo/dark?v=2',
    };
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    render(<BrandingProvider><AppLogo alt="logo" className="h-8 w-8" /><AppLogo alt="dark preview" variant="dark" /></BrandingProvider>);
    const [light, dark] = screen.getAllByAltText('logo');
    expect(light).toHaveAttribute('src', '/api/branding/logo?v=1');
    expect(light).toHaveClass('h-8', 'dark:hidden');
    expect(dark).toHaveAttribute('src', '/api/branding/logo/dark?v=2');
    expect(dark).toHaveClass('h-8', 'hidden', 'dark:block');

    const preview = screen.getByAltText('dark preview');
    fireEvent.error(preview);
    await waitFor(() => expect(preview).toHaveAttribute('src', '/api/branding/logo?v=1'));
    fireEvent.error(preview);
    await waitFor(() => expect(preview).toHaveAttribute('src', '/logo-sidebar.png'));
  });
});
