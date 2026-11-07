import type { Hono } from 'hono';
import type { RuntimeConfig } from '../config';
import type { StatisticsService } from '../statistics-service';
import { canonicalStatisticsIP } from '../statistics-store';
import type { StatisticsFilters } from '../../shared/statistics';

export function registerStatisticsRoutes(options: {
  app: Hono; config: RuntimeConfig; statistics: StatisticsService;
  ensureAuth: any; ensureCanManageSettings: (context: any) => Response | null | undefined;
}): void {
  const { app, config, statistics, ensureAuth, ensureCanManageSettings } = options;
  app.get(`${config.basePath}/api/statistics`, ensureAuth, async (context) => {
    const q = context.req.query();
    const today = new Date().toISOString().slice(0, 10);
    // Tolerate a browser clock that has already reached the next UTC day.
    const latestTo = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
    const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    const filters: StatisticsFilters = {
      from: q.from || new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10),
      to: q.to || today, instance: q.instance || 'all', simulation: (q.simulation || 'live') as StatisticsFilters['simulation'],
      limit: Number(q.limit || 10) as StatisticsFilters['limit'], ...(q.ip ? { ip: q.ip } : {}), ...(q.machine ? { machine: q.machine } : {}),
    };
    if (!date(filters.from) || !date(filters.to) || filters.from > filters.to || filters.to > latestTo
      || Date.parse(filters.to) - Date.parse(filters.from) >= 3650 * 86_400_000) return context.json({ error: 'Choose a valid UTC date range of at most 3650 days, ending no later than today' }, 400);
    if (!['all', ...config.instances.map((i) => i.id)].includes(filters.instance)) return context.json({ error: 'Unknown instance' }, 400);
    if (!['all', 'live', 'simulated'].includes(filters.simulation) || ![10, 20, 50].includes(filters.limit)) return context.json({ error: 'Invalid simulation filter or ranking limit' }, 400);
    if (filters.ip && !canonicalStatisticsIP(filters.ip)) return context.json({ error: 'ip must be an IPv4 or IPv6 address' }, 400);
    if (filters.machine) {
      try {
        const key = JSON.parse(filters.machine);
        if (!Array.isArray(key) || key.length !== 2 || !key.every((v) => typeof v === 'string') || !config.instances.some((i) => i.id === key[0])) throw new Error();
      } catch { return context.json({ error: 'Invalid machine identity' }, 400); }
    }
    try { return context.json(await statistics.query(filters)); }
    catch (error) {
      console.warn('Statistics request failed:', error instanceof Error ? error.message : String(error));
      return context.json({ error: 'Statistics are temporarily unavailable', retryAfterMs: 30_000 }, 503);
    }
  });

  app.put(`${config.basePath}/api/config/statistics`, ensureAuth, async (context) => {
    const denied = ensureCanManageSettings(context);
    if (denied) return denied;
    try { return context.json({ success: true, statistics: await statistics.update(await context.req.json()) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid statistics settings';
      return context.json({ error: message, ...(message.startsWith('MANAGED_BY_CONFIG') ? { code: 'MANAGED_BY_CONFIG' } : {}) }, message.startsWith('MANAGED_BY_CONFIG') ? 409 : 400);
    }
  });
}
