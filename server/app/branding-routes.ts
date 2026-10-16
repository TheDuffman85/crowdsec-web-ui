import type { Hono } from 'hono';
import { BrandingThemeValidationError, parseBrandingThemeInput, type BrandingTheme } from '../../shared/branding-theme';
import type { DashboardAuth } from '../app-auth';
import {
  BrandingValidationError,
  clearAppLogo,
  getAppLogo,
  getPublicBranding,
  normalizeAppName,
  parseAppLogoUpload,
  saveAppLogo,
  saveAppName,
  saveAppTheme,
  type AppLogoVariant,
} from '../branding';
import type { CrowdsecDatabase } from '../database';

type HonoContext = any;

async function readBody(context: HonoContext): Promise<Record<string, unknown> | null> {
  const body = await context.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

export function registerBrandingRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  ensureCanManageSettings: (context: HonoContext) => Response | null;
  writeDatabase: <T>(operation: () => T) => Promise<T>;
}): void {
  const { app, basePath, database, auth, ensureCanManageSettings, writeDatabase } = options;
  const root = `${basePath}/api/branding`;
  const brandingResponse = (context: HonoContext) => context.json(getPublicBranding(database, basePath));

  // Public: the sign-in and setup pages are branded before authentication.
  app.get(root, (context) => brandingResponse(context));

  const logoRoutes: Array<[string, AppLogoVariant]> = [[`${root}/logo`, 'default'], [`${root}/logo/dark`, 'dark']];

  for (const [logoPath, variant] of logoRoutes) {
    app.get(logoPath, (context) => {
      const logo = getAppLogo(database, variant);
      if (!logo) return context.json({ error: 'No custom logo configured' }, 404);

      const versioned = context.req.query('v') === logo.version;
      context.header('Content-Type', logo.contentType);
      context.header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
      // SVG logos are rendered via <img>, but lock them down in case one is
      // opened directly so embedded scripts can never run on this origin.
      context.header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      context.header('Content-Disposition', 'inline');
      return context.body(new Uint8Array(logo.data));
    });

    app.put(logoPath, auth.ensureAuth, async (context) => {
      const readOnlyResponse = ensureCanManageSettings(context);
      if (readOnlyResponse) return readOnlyResponse;

      const body = await readBody(context);
      if (!body) return context.json({ error: 'Invalid request body' }, 400);
      let logo: ReturnType<typeof parseAppLogoUpload>;
      try {
        logo = parseAppLogoUpload(body.dataUrl);
      } catch (error) {
        if (error instanceof BrandingValidationError) return context.json({ error: error.message }, 400);
        throw error;
      }

      await writeDatabase(() => saveAppLogo(database, logo, variant));
      return brandingResponse(context);
    });

    app.delete(logoPath, auth.ensureAuth, async (context) => {
      const readOnlyResponse = ensureCanManageSettings(context);
      if (readOnlyResponse) return readOnlyResponse;

      await writeDatabase(() => clearAppLogo(database, variant));
      return brandingResponse(context);
    });
  }

  app.put(`${root}/theme`, auth.ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    const body = await readBody(context);
    if (!body) return context.json({ error: 'Invalid request body' }, 400);
    let theme: BrandingTheme;
    try {
      theme = parseBrandingThemeInput(body.theme);
    } catch (error) {
      if (error instanceof BrandingThemeValidationError) return context.json({ error: error.message }, 400);
      throw error;
    }

    await writeDatabase(() => saveAppTheme(database, theme));
    return brandingResponse(context);
  });

  app.put(root, auth.ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    const body = await readBody(context);
    if (!body) return context.json({ error: 'Invalid request body' }, 400);
    let appName: string;
    try {
      appName = normalizeAppName(body.appName);
    } catch (error) {
      if (error instanceof BrandingValidationError) return context.json({ error: error.message }, 400);
      throw error;
    }

    await writeDatabase(() => saveAppName(database, appName));
    return brandingResponse(context);
  });
}
