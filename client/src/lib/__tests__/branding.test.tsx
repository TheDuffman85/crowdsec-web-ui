import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrandingProvider } from '../../contexts/BrandingContext';
import { useBranding } from '../../contexts/useBranding';
import { AppLogo } from '../../components/AppLogo';
import { applyDocumentBranding, getInitialBranding, normalizeBranding } from '../branding';

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
  document.head.querySelectorAll('link').forEach((link) => link.remove());
  document.title = '';
  vi.unstubAllGlobals();
});

describe('branding', () => {
  test('normalizes partial or invalid payloads to the default branding', () => {
    expect(normalizeBranding(null)).toEqual({ appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null });
    expect(normalizeBranding({ appName: '  ', logoUrl: '' })).toEqual({ appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null });
    window.__BRANDING__ = { appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: '/logo?v=1' };
    expect(getInitialBranding()).toEqual({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: '/logo?v=1' });
  });

  test('switches the document title and icons to the custom logo and back', () => {
    const icon = addIconLink('icon', './logo-sidebar.png', 'image/png');
    const apple = addIconLink('apple-touch-icon', './apple-touch-icon.png');
    const manifest = addIconLink('manifest', './site.webmanifest');

    applyDocumentBranding({ appName: 'Acme SOC', defaultAppName: 'CrowdSec Web UI', logoUrl: '/api/branding/logo?v=1' });
    expect(document.title).toBe('Acme SOC');
    expect(icon.getAttribute('href')).toBe('/api/branding/logo?v=1');
    expect(icon.hasAttribute('type')).toBe(false);
    expect(apple.getAttribute('href')).toBe('/api/branding/logo?v=1');
    expect(manifest.getAttribute('href')).toBe('./site.webmanifest');

    applyDocumentBranding({ appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null });
    expect(document.title).toBe('CrowdSec Web UI');
    expect(icon.getAttribute('href')).toBe('./logo-sidebar.png');
    expect(icon.getAttribute('type')).toBe('image/png');
    expect(apple.getAttribute('href')).toBe('./apple-touch-icon.png');
  });

  test('restores the original icons injected by the server', () => {
    const icon = addIconLink('icon', '/api/branding/logo?v=1');
    icon.dataset.defaultHref = '/crowdsec/logo-sidebar.png';
    icon.dataset.defaultType = 'image/png';

    applyDocumentBranding({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null });
    expect(icon.getAttribute('href')).toBe('/crowdsec/logo-sidebar.png');
    expect(icon.getAttribute('type')).toBe('image/png');
  });

  test('provider starts from injected branding and refreshes from the API', async () => {
    window.__BRANDING__ = { appName: 'Injected', defaultAppName: 'CrowdSec Web UI', logoUrl: null };
    let resolveFetch: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    render(<BrandingProvider><BrandingProbe /></BrandingProvider>);
    expect(screen.getByText('Injected')).toBeInTheDocument();
    expect(screen.getByAltText('logo')).toHaveAttribute('src', '/logo-sidebar.png');

    resolveFetch(new Response(JSON.stringify({ appName: 'Acme SOC', defaultAppName: 'CrowdSec Web UI', logoUrl: '/api/branding/logo?v=2' })));
    await waitFor(() => expect(screen.getByText('Acme SOC')).toBeInTheDocument());
    expect(screen.getByAltText('logo')).toHaveAttribute('src', '/api/branding/logo?v=2');
    // document.title is applied in a passive effect, which can flush after the re-render is visible.
    await waitFor(() => expect(document.title).toBe('Acme SOC'));
  });
});
