import type { Hono } from 'hono';
import type { RuntimeConfig } from '../config';
import type { StatisticsService } from '../statistics-service';
import { canonicalStatisticsSource } from '../statistics-store';
import {
  STATISTICS_DETAIL_MAX, STATISTICS_DETAIL_PAGE, addStatisticsDays, statisticsDay, type StatisticsDetailRequest, type StatisticsFilters,
} from '../../shared/statistics';

export function registerStatisticsRoutes(options: {
  app: Hono; config: RuntimeConfig; statistics: StatisticsService;
  ensureAuth: any; ensureCanManageSettings: (context: any) => Response | null | undefined;
}): void {
  const { app, config, statistics, ensureAuth, ensureCanManageSettings } = options;
  /** Parses the shared page filters, or returns an error message. */
  const parseFilters = (q: Record<string, string>): StatisticsFilters | string => {
    const today = statisticsDay(Date.now(), statistics.timeZone);
    // Tolerate a browser clock that has already reached the next day.
    const latestTo = addStatisticsDays(today, 1);
    const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    const filters: StatisticsFilters = {
      from: q.from || addStatisticsDays(today, -29),
      to: q.to || today, instance: q.instance || 'all',
      // Simulated activity is hidden everywhere while simulations are disabled.
      simulation: (config.simulationsEnabled ? q.simulation || 'live' : 'live') as StatisticsFilters['simulation'],
      limit: Number(q.limit || 10) as StatisticsFilters['limit'], ...(q.ip ? { ip: q.ip } : {}), ...(q.machine ? { machine: q.machine } : {}),
      ...(q.scenario ? { scenario: q.scenario } : {}),
      ...(q.country ? { country: q.country.toUpperCase() } : {}),
      ...(q.network ? { network: q.network } : {}), ...(q.target ? { target: q.target } : {}),
    };
    if (!date(filters.from) || !date(filters.to) || filters.from > filters.to || filters.to > latestTo
      || Date.parse(filters.to) - Date.parse(filters.from) >= 3650 * 86_400_000) return 'Choose a valid date range of at most 3650 days, ending no later than today';
    if (!['all', ...config.instances.map((i) => i.id)].includes(filters.instance)) return 'Unknown instance';
    if (!['all', 'live', 'simulated'].includes(filters.simulation) || ![10, 20, 50].includes(filters.limit)) return 'Invalid simulation filter or ranking limit';
    if (filters.ip && !canonicalStatisticsSource(filters.ip)) return 'ip must be an IPv4 or IPv6 address or range';
    if (filters.scenario !== undefined && (filters.scenario.length > 256 || !filters.scenario.trim())) return 'Invalid scenario';
    if (filters.machine && !isMachineKey(filters.machine)) return 'Invalid machine identity';
    if (filters.country && !/^[A-Z]{2}$/.test(filters.country)) return 'Invalid country';
    for (const field of ['network', 'target'] as const) {
      if (q[field] !== undefined && (!q[field].trim() || q[field].length > 256)) return `Invalid ${field}`;
    }
    return filters;
  };
  const isMachineKey = (value: unknown): boolean => {
    try {
      const key = typeof value === 'string' ? JSON.parse(value) : value;
      return Array.isArray(key) && key.length === 2 && key.every((v) => typeof v === 'string') && config.instances.some((i) => i.id === key[0]);
    } catch { return false; }
  };
  const unavailable = (context: any, error: unknown) => {
    console.warn('Statistics request failed:', error instanceof Error ? error.message : String(error));
    return context.json({ error: 'Statistics are temporarily unavailable', retryAfterMs: 30_000 }, 503);
  };

  app.get(`${config.basePath}/api/statistics`, ensureAuth, async (context) => {
    const filters = parseFilters(context.req.query());
    if (typeof filters === 'string') return context.json({ error: filters }, 400);
    try { return context.json(await statistics.query(filters)); }
    catch (error) { return unavailable(context, error); }
  });

  app.get(`${config.basePath}/api/statistics/details`, ensureAuth, async (context) => {
    const q = context.req.query();
    const filters = parseFilters(q);
    if (typeof filters === 'string') return context.json({ error: filters }, 400);
    let request: StatisticsDetailRequest;
    const size = q.size === undefined ? STATISTICS_DETAIL_PAGE : Number(q.size);
    if (!Number.isInteger(size) || size < 1 || size > STATISTICS_DETAIL_MAX) return context.json({ error: `size must be an integer between 1 and ${STATISTICS_DETAIL_MAX}` }, 400);
    if (q.kind === 'ips') {
      if (q.network !== undefined && (!q.network.trim() || q.network.length > 256)) return context.json({ error: 'Invalid network' }, 400);
      request = { kind: 'ips', ...(q.network ? { network: q.network } : {}), size };
    } else if (q.kind === 'returned') request = { kind: 'returned', history: q.history === '1', size };
    else if (q.kind === 'machines') {
      let machines: unknown;
      try { machines = JSON.parse(q.machines || '[]'); } catch { machines = null; }
      if (!Array.isArray(machines) || !machines.length || machines.length > 25 || !machines.every(isMachineKey)) return context.json({ error: 'Invalid machines' }, 400);
      request = { kind: 'machines', machines: machines as string[] };
    } else return context.json({ error: 'Invalid detail kind' }, 400);
    try { return context.json(await statistics.details(filters, request)); }
    catch (error) { return unavailable(context, error); }
  });

  app.delete(`${config.basePath}/api/statistics`, ensureAuth, async (context) => {
    const denied = ensureCanManageSettings(context);
    if (denied) return denied;
    try { return context.json({ success: true, statistics: await statistics.reset() }); }
    catch (error) {
      console.error('Deleting statistics failed:', error instanceof Error ? error.message : String(error));
      return context.json({ error: 'Statistics could not be deleted' }, 500);
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
