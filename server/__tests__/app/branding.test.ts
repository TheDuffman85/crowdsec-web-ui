import { writeFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  applyBrandingToIndexHtml,
  detectAppLogoContentType,
  normalizeAppName,
  parseAppLogoUpload,
  serializeBrandingForScript,
} from '../../branding';
import { createAuthSessionCookie, createController, tempDir } from './harness';
import {
  DEFAULT_BRANDING_THEME,
  buildBrandingThemeCss,
  generateAccentScale,
  getAccentContrast,
  getContrastRatio,
  getResolvedThemeModeVariables,
  normalizeBrandingTheme,
  parseBrandingThemeInput,
  resolveThemeMode,
} from '../../../shared/branding-theme';

const root = 'http://localhost/crowdsec/api/branding';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

async function request(controller: ReturnType<typeof createController>['controller'], pathName = '', options: {
  method?: string;
  cookie?: string;
  body?: unknown;
} = {}) {
  return await controller.fetch(new Request(`${root}${pathName}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }));
}

function createAuthenticatedController() {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
  const viewerId = controller.database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
  return {
    controller,
    admin: createAuthSessionCookie(controller.database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' }),
    viewer: createAuthSessionCookie(controller.database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' }),
  };
}

describe('branding helpers', () => {
  test('normalizes application names', () => {
    expect(normalizeAppName('  Acme\n\tSecurity  ')).toBe('Acme Security');
    expect(normalizeAppName('')).toBe('');
    expect(() => normalizeAppName('x'.repeat(61))).toThrow('60 characters or fewer');
    expect(() => normalizeAppName(42)).toThrow('must be a string');
  });

  test('detects logo types from content instead of the declared type', () => {
    expect(detectAppLogoContentType(PNG_BYTES)).toBe('image/png');
    expect(detectAppLogoContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectAppLogoContentType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(detectAppLogoContentType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectAppLogoContentType(Buffer.from(SVG))).toBe('image/svg+xml');
    expect(detectAppLogoContentType(Buffer.from('<html><body>nope</body></html>'))).toBeNull();

    expect(parseAppLogoUpload(`data:image/gif;base64,${PNG_BYTES.toString('base64')}`).contentType).toBe('image/png');
    expect(() => parseAppLogoUpload('https://example.com/logo.png')).toThrow('base64 data URL');
    expect(() => parseAppLogoUpload(`data:text/html;base64,${Buffer.from('<html></html>').toString('base64')}`))
      .toThrow('PNG, JPEG, GIF, WebP, or SVG');
    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(512 * 1024)]);
    expect(() => parseAppLogoUpload(`data:image/png;base64,${oversized.toString('base64')}`)).toThrow('512 KB or smaller');
  });

  test('injects an escaped title and branded icons into the SPA shell', () => {
    const html = [
      '<head>',
      '<link rel="icon" type="image/png" sizes="96x96" href="./favicon-96x96.png" />',
      '<link rel="shortcut icon" href="./favicon.ico" />',
      '<link rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon.png" />',
      '<link rel="manifest" href="./site.webmanifest" />',
      '<title>CrowdSec Web UI</title>',
      '</head>',
    ].join('\n');
    const branded = applyBrandingToIndexHtml(html, {
      appName: 'Acme <SOC> $&',
      defaultAppName: 'CrowdSec Web UI',
      logoUrl: '/api/branding/logo?v=abc',
      logoDarkUrl: null,
      theme: DEFAULT_BRANDING_THEME,
    });

    expect(branded).toContain('<title>Acme &lt;SOC&gt; $&amp;</title>');
    expect(branded).toContain('<link rel="icon" sizes="96x96" href="/api/branding/logo?v=abc" data-default-href="./favicon-96x96.png" data-default-type="image/png" />');
    expect(branded).toContain('<link rel="shortcut icon" href="/api/branding/logo?v=abc" data-default-href="./favicon.ico" data-default-type="" />');
    expect(branded).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/api/branding/logo?v=abc"');
    expect(branded).toContain('<link rel="manifest" href="./site.webmanifest" />');

    expect(applyBrandingToIndexHtml(html, { appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME }))
      .toContain('<link rel="icon" type="image/png" sizes="96x96" href="./favicon-96x96.png" />');
    expect(serializeBrandingForScript({ appName: '</script><script>', defaultAppName: 'x', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME }))
      .not.toContain('</script>');
  });
});

describe('branding theme', () => {
  test('validates theme input strictly and normalizes stored themes leniently', () => {
    expect(parseBrandingThemeInput({ light: { accent: '#E11D48', neutral: 'slate' } })).toEqual({
      light: { accent: '#e11d48', neutral: 'slate' },
      dark: { accent: null, neutral: null },
    });
    expect(parseBrandingThemeInput({ light: { accent: 'abc', neutral: '' }, dark: { accent: '', neutral: null } })).toEqual({
      light: { accent: '#aabbcc', neutral: null },
      dark: { accent: null, neutral: null },
    });
    expect(() => parseBrandingThemeInput(null)).toThrow('Theme must be an object');
    expect(() => parseBrandingThemeInput({ dark: [] })).toThrow('dark colors must be an object');
    expect(() => parseBrandingThemeInput({ light: { accent: 'red;}body{display:none' } })).toThrow('hex color');
    expect(() => parseBrandingThemeInput({ dark: { neutral: 'purple' } })).toThrow('neutral tone must be one of');

    expect(normalizeBrandingTheme({ light: { accent: 'red', neutral: 'zinc' }, dark: 'x' })).toEqual({
      light: { accent: null, neutral: 'zinc' },
      dark: { accent: null, neutral: null },
    });
    expect(normalizeBrandingTheme(undefined)).toEqual(DEFAULT_BRANDING_THEME);
  });

  test('generates an accent scale that keeps the chosen color and gets darker shade by shade', () => {
    const luminance = (hex: string) => getContrastRatio(hex, '#000000');
    for (const color of ['#e11d48', '#fde047', '#16a34a', '#808080', '#000000', '#ffffff']) {
      const scale = Object.values(generateAccentScale(color));
      expect(scale).toHaveLength(11);
      expect(scale).toContain(color);
      scale.forEach((hex) => expect(hex).toMatch(/^#[0-9a-f]{6}$/));
      for (let index = 1; index < scale.length; index += 1) {
        expect(luminance(scale[index])).toBeLessThanOrEqual(luminance(scale[index - 1]));
      }
    }
    expect(generateAccentScale('#e11d48')[600]).toBe('#e11d48');
  });

  test('builds CSS where dark mode inherits light mode unless it has its own colors', () => {
    expect(buildBrandingThemeCss(DEFAULT_BRANDING_THEME)).toBe('');

    const lightOnly = buildBrandingThemeCss({ light: { accent: '#e11d48', neutral: 'stone' }, dark: { accent: null, neutral: null } });
    expect(lightOnly).toMatch(/^:root\{--color-primary-50:#[0-9a-f]{6};/);
    expect(lightOnly).toContain('--color-primary-600:#e11d48;');
    expect(lightOnly).toContain('--color-gray-950:oklch(14.7% 0.004 49.25);');
    expect(lightOnly).not.toContain(':root.dark');

    const darkOnly = buildBrandingThemeCss({ light: { accent: null, neutral: null }, dark: { accent: null, neutral: 'zinc' } });
    expect(darkOnly).toMatch(/^:root\.dark\{--color-gray-50:/);
    expect(darkOnly).not.toContain('--color-primary');

    const theme = { light: { accent: '#e11d48', neutral: null }, dark: { accent: null, neutral: 'slate' as const } };
    expect(resolveThemeMode(theme, 'dark')).toEqual({ accent: '#e11d48', neutral: 'slate' });
    expect(resolveThemeMode(theme, 'light')).toEqual({ accent: '#e11d48', neutral: 'gray' });
    expect(getResolvedThemeModeVariables(DEFAULT_BRANDING_THEME, 'light')).toMatchObject({
      '--color-primary-600': '#0284c7',
      '--color-gray-50': 'oklch(98.5% 0.002 247.839)',
    });
  });

  test('keeps generated button shades readable and reports low contrast of exact colors', () => {
    const theme = (accent: string) => ({ light: { accent, neutral: null }, dark: { accent: null, neutral: null } });
    expect(getAccentContrast(DEFAULT_BRANDING_THEME, 'light')).toBeNull();

    // Bright colors are anchored at a light shade; the generated shade 600 is darkened to meet WCAG AA.
    for (const accent of ['#7fff00', '#fde047', '#22c55e', '#06b6d4']) {
      expect(generateAccentScale(accent)[600]).not.toBe(accent);
      expect(getAccentContrast(theme(accent), 'light')!.buttonText).toBeGreaterThanOrEqual(4.5);
    }

    // A color used as-is for buttons is never altered, so low contrast is reported instead.
    expect(generateAccentScale('#16a34a')[600]).toBe('#16a34a');
    expect(getAccentContrast(theme('#16a34a'), 'light')!.buttonText).toBeLessThan(4.5);
    // Dark mode inherits the light accent and checks shade 400 text on the dark background.
    expect(getAccentContrast(theme('#16a34a'), 'dark')!.accentText).toBeGreaterThan(4.5);
  });

  test('injects the theme stylesheet into the SPA shell only when colors are customized', () => {
    const html = '<head><title>CrowdSec Web UI</title></head>';
    const base = { appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null };
    expect(applyBrandingToIndexHtml(html, { ...base, theme: DEFAULT_BRANDING_THEME })).not.toContain('<style');
    const themed = applyBrandingToIndexHtml(html, {
      ...base,
      theme: { light: { accent: '#e11d48', neutral: null }, dark: { accent: null, neutral: 'zinc' } },
    });
    expect(themed).toMatch(/<style id="branding-theme">:root\{[^<]*\}:root\.dark\{[^<]*\}<\/style>\n<\/head>/);
  });
});

describe('branding routes', () => {
  test('serves default branding publicly before authentication', async () => {
    const { controller } = createAuthenticatedController();

    const response = await request(controller);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      appName: 'CrowdSec Web UI',
      defaultAppName: 'CrowdSec Web UI',
      logoUrl: null,
      logoDarkUrl: null,
      theme: DEFAULT_BRANDING_THEME,
    });
    expect((await request(controller, '/logo')).status).toBe(404);
  });

  test('lets admins change the name and logo while read-only users and guests are rejected', async () => {
    const { controller, admin, viewer } = createAuthenticatedController();

    expect((await request(controller, '', { method: 'PUT', body: { appName: 'Acme' } })).status).toBe(401);
    const readOnly = await request(controller, '', { method: 'PUT', cookie: viewer, body: { appName: 'Acme' } });
    expect(readOnly.status).toBe(403);
    expect(await readOnly.json()).toMatchObject({ code: 'READ_ONLY' });
    expect((await request(controller, '/logo', { method: 'PUT', cookie: viewer, body: { dataUrl: PNG_DATA_URL } })).status).toBe(403);
    expect((await request(controller, '/logo', { method: 'DELETE', cookie: viewer })).status).toBe(403);

    const invalidName = await request(controller, '', { method: 'PUT', cookie: admin, body: { appName: 'x'.repeat(61) } });
    expect(invalidName.status).toBe(400);

    const renamed = await request(controller, '', { method: 'PUT', cookie: admin, body: { appName: '  Acme   SOC ' } });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ appName: 'Acme SOC', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });

    const invalidLogo = await request(controller, '/logo', {
      method: 'PUT',
      cookie: admin,
      body: { dataUrl: `data:image/png;base64,${Buffer.from('<html></html>').toString('base64')}` },
    });
    expect(invalidLogo.status).toBe(400);

    const uploaded = await request(controller, '/logo', { method: 'PUT', cookie: admin, body: { dataUrl: PNG_DATA_URL } });
    expect(uploaded.status).toBe(200);
    const branding = await uploaded.json() as { appName: string; logoUrl: string };
    expect(branding.appName).toBe('Acme SOC');
    expect(branding.logoUrl).toMatch(/^\/crowdsec\/api\/branding\/logo\?v=[0-9a-f]{16}$/);

    const logo = await controller.fetch(new Request(`http://localhost${branding.logoUrl}`));
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(logo.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await logo.arrayBuffer())).toEqual(PNG_BYTES);

    const unversioned = await request(controller, '/logo');
    expect(unversioned.headers.get('cache-control')).toBe('no-cache');

    const reset = await request(controller, '/logo', { method: 'DELETE', cookie: admin });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ appName: 'Acme SOC', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    expect((await request(controller, '/logo')).status).toBe(404);

    const restored = await request(controller, '', { method: 'PUT', cookie: admin, body: { appName: '' } });
    expect(await restored.json()).toMatchObject({ appName: 'CrowdSec Web UI' });
  });

  test('stores the dark mode logo separately from the main logo', async () => {
    const { controller, admin, viewer } = createAuthenticatedController();
    const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;

    expect((await request(controller, '/logo/dark')).status).toBe(404);
    expect((await request(controller, '/logo/dark', { method: 'PUT', body: { dataUrl: PNG_DATA_URL } })).status).toBe(401);
    expect((await request(controller, '/logo/dark', { method: 'PUT', cookie: viewer, body: { dataUrl: PNG_DATA_URL } })).status).toBe(403);
    expect((await request(controller, '/logo/dark', { method: 'DELETE', cookie: viewer })).status).toBe(403);
    expect((await request(controller, '/logo/dark', { method: 'PUT', cookie: admin, body: { dataUrl: 'nope' } })).status).toBe(400);

    const uploaded = await request(controller, '/logo/dark', { method: 'PUT', cookie: admin, body: { dataUrl: svgDataUrl } });
    expect(uploaded.status).toBe(200);
    const branding = await uploaded.json() as { logoUrl: string | null; logoDarkUrl: string };
    expect(branding.logoUrl).toBeNull();
    expect(branding.logoDarkUrl).toMatch(/^\/crowdsec\/api\/branding\/logo\/dark\?v=[0-9a-f]{16}$/);
    expect((await request(controller, '/logo')).status).toBe(404);

    const darkLogo = await controller.fetch(new Request(`http://localhost${branding.logoDarkUrl}`));
    expect(darkLogo.status).toBe(200);
    expect(darkLogo.headers.get('content-type')).toBe('image/svg+xml');
    expect(darkLogo.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(darkLogo.headers.get('content-security-policy')).toContain('sandbox');

    await request(controller, '/logo', { method: 'PUT', cookie: admin, body: { dataUrl: PNG_DATA_URL } });
    const resetMain = await request(controller, '/logo', { method: 'DELETE', cookie: admin });
    expect(await resetMain.json()).toMatchObject({ logoUrl: null, logoDarkUrl: branding.logoDarkUrl });

    const removed = await request(controller, '/logo/dark', { method: 'DELETE', cookie: admin });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ logoDarkUrl: null });
    expect((await request(controller, '/logo/dark')).status).toBe(404);
  });

  test('lets admins save colors and restore the defaults', async () => {
    const { controller, admin, viewer } = createAuthenticatedController();
    const theme = { light: { accent: '#E11D48', neutral: 'slate' }, dark: { accent: null, neutral: 'zinc' } };

    expect((await request(controller, '/theme', { method: 'PUT', body: { theme } })).status).toBe(401);
    expect((await request(controller, '/theme', { method: 'PUT', cookie: viewer, body: { theme } })).status).toBe(403);
    expect((await request(controller, '/theme', { method: 'PUT', cookie: admin, body: [] })).status).toBe(400);
    const invalid = await request(controller, '/theme', {
      method: 'PUT',
      cookie: admin,
      body: { theme: { light: { accent: 'url(javascript:alert(1))' } } },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('hex color') });

    const saved = await request(controller, '/theme', { method: 'PUT', cookie: admin, body: { theme } });
    expect(saved.status).toBe(200);
    const expected = { light: { accent: '#e11d48', neutral: 'slate' }, dark: { accent: null, neutral: 'zinc' } };
    expect(await saved.json()).toMatchObject({ theme: expected });
    expect(await (await request(controller)).json()).toMatchObject({ theme: expected });

    const restored = await request(controller, '/theme', { method: 'PUT', cookie: admin, body: { theme: DEFAULT_BRANDING_THEME } });
    expect(await restored.json()).toMatchObject({ theme: DEFAULT_BRANDING_THEME });
  });

  test('serves SVG logos with a sandboxed policy', async () => {
    const { controller, admin } = createAuthenticatedController();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;
    expect((await request(controller, '/logo', { method: 'PUT', cookie: admin, body: { dataUrl } })).status).toBe(200);

    const logo = await request(controller, '/logo');
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(logo.headers.get('content-security-policy')).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('brands the SPA shell, web manifest, and authenticator names', async () => {
    const { controller, admin } = createAuthenticatedController();
    writeFileSync(
      path.join(tempDir, 'dist', 'index.html'),
      '<!doctype html><html><head><link rel="icon" type="image/png" href="./logo-sidebar.png" /><title>CrowdSec Web UI</title></head><body></body></html>',
    );
    await request(controller, '', { method: 'PUT', cookie: admin, body: { appName: 'Acme SOC' } });
    const uploaded = await request(controller, '/logo', { method: 'PUT', cookie: admin, body: { dataUrl: PNG_DATA_URL } });
    const { logoUrl } = await uploaded.json() as { logoUrl: string };

    const page = await controller.fetch(new Request('http://localhost/crowdsec/'));
    const html = await page.text();
    expect(html).toContain('<title>Acme SOC</title>');
    expect(html).toContain(`<link rel="icon" href="${logoUrl}" data-default-href="/crowdsec/logo-sidebar.png" data-default-type="image/png" />`);
    expect(html).toContain('window.__BRANDING__={"appName":"Acme SOC"');
    expect(html).not.toContain('<style id="branding-theme">');

    await request(controller, '/theme', { method: 'PUT', cookie: admin, body: { theme: { light: { accent: '#e11d48' } } } });
    const themedHtml = await (await controller.fetch(new Request('http://localhost/crowdsec/'))).text();
    expect(themedHtml).toContain('<style id="branding-theme">:root{--color-primary-50:');
    expect(themedHtml).toContain('"theme":{"light":{"accent":"#e11d48","neutral":null}');

    const manifest = await controller.fetch(new Request('http://localhost/crowdsec/site.webmanifest'));
    expect(await manifest.json()).toMatchObject({
      name: 'Acme SOC',
      short_name: 'Acme SOC',
      icons: [{ src: logoUrl, sizes: 'any' }],
    });

    const totp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
      method: 'POST',
      headers: { cookie: admin },
    }));
    expect(totp.status).toBe(200);
    const { otpauthUrl } = await totp.json() as { otpauthUrl: string };
    expect(otpauthUrl).toContain('issuer=Acme%20SOC');
  });
});
