import crypto from 'node:crypto';
import type { Hono } from 'hono';
import type { LapiStatus } from '../../shared/contracts';

export const STATUS_TOKEN_MIN_LENGTH = 16;

export interface StatusInstance {
  id: string;
  name: string;
  status: LapiStatus;
}

export interface StatusDataSource {
  instances: () => StatusInstance[];
  countAlertsSince: (since: string) => number;
  countActiveDecisions: (now: string) => number;
  cacheReady: () => boolean;
  lastUpdate: () => string | null;
  version: string;
  now?: () => number;
}

export type OverallStatus = 'ok' | 'degraded' | 'down';

export function summarizeStatus(instances: StatusInstance[], cacheReady: boolean): OverallStatus {
  if (instances.length === 0) return 'down';
  const connected = instances.filter((instance) => instance.status.isConnected).length;
  if (connected === 0) return 'down';
  if (connected < instances.length || !cacheReady) return 'degraded';
  return 'ok';
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Constant-time comparison that does not leak the token length. */
export function tokensMatch(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

export function readBearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}

/**
 * Read-only summary for dashboards such as Uptime Kuma or Homepage.
 * Disabled (404) unless a token of at least 16 characters is configured, and
 * it only accepts `Authorization: Bearer <token>`, never a query string, so
 * the token cannot end up in access logs.
 */
export function registerStatusRoutes(options: {
  app: Hono;
  basePath: string;
  token: string | undefined;
  data: StatusDataSource;
}): boolean {
  const { app, basePath, token, data } = options;
  if (!token) return false;
  if (token.length < STATUS_TOKEN_MIN_LENGTH) {
    console.warn(`STATUS_API_TOKEN is shorter than ${STATUS_TOKEN_MIN_LENGTH} characters; the status endpoint stays disabled.`);
    return false;
  }

  app.get(`${basePath}/api/status`, (context) => {
    const provided = readBearerToken(context.req.header('authorization'));
    if (!provided || !tokensMatch(provided, token)) {
      context.header('WWW-Authenticate', 'Bearer');
      return context.json({ error: 'Unauthorized' }, 401);
    }

    const now = data.now ? data.now() : Date.now();
    const instances = data.instances();
    const cacheReady = data.cacheReady();
    const status = summarizeStatus(instances, cacheReady);
    const body = {
      status,
      version: data.version,
      cache_ready: cacheReady,
      last_update: data.lastUpdate(),
      instances: instances.map((instance) => ({
        id: instance.id,
        name: instance.name,
        connected: instance.status.isConnected,
        last_check: instance.status.lastCheck,
        offline_since: instance.status.offline_since,
      })),
      alerts_last_24h: data.countAlertsSince(new Date(now - 24 * 3_600_000).toISOString()),
      active_decisions: data.countActiveDecisions(new Date(now).toISOString()),
    };
    // 503 lets plain HTTP monitors such as Uptime Kuma alert without reading the body.
    return context.json(body, status === 'down' ? 503 : 200);
  });
  return true;
}
