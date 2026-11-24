import { isIP } from 'node:net';
import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';
import { checkOffender } from './repeat-offenders';

export const SCORE_WINDOW_DAYS = 30;
const MAX_BATCH = 100;

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';
export type FactorKey = 'volume' | 'severity' | 'repeat' | 'reputation';

export interface ThreatFactor {
  key: FactorKey;
  points: number;
  max: number;
  /** Raw numbers behind the points, for the tooltip. */
  value: number | null;
}

export interface ThreatScore {
  ip: string;
  score: number;
  level: ThreatLevel;
  factors: ThreatFactor[];
  /** False when no reputation source had data, so the score was scaled over the remaining factors. */
  reputation_available: boolean;
}

export interface ThreatInputs {
  alerts: number;
  scenarios: string[];
  /** Separate ban episodes (see repeat offenders). */
  episodes: number;
  /** AbuseIPDB confidence score 0-100, or null when unconfigured or not looked up. */
  abuseScore: number | null;
}

const MAXIMUM = { volume: 35, severity: 25, repeat: 20, reputation: 20 } as const;

/** How dangerous a scenario is on a 0-1 scale, from its name. */
export function scenarioSeverity(scenario: string): number {
  const name = scenario.toLowerCase();
  if (/(cve-|vpatch|exploit|backdoor|log4j|shellshock|rce|webshell)/.test(name)) return 1;
  if (/(bf|brute|credential|stuffing|password|ssh-slow|admin-interface)/.test(name)) return 0.8;
  if (/(sqli|xss|traversal|injection|crawl-non[-_]statics|sensitive-files)/.test(name)) return 0.7;
  if (/(scan|probing|probe|enum|crawl|bad-user-agent|nikto|fingerprint)/.test(name)) return 0.4;
  return 0.5;
}

export function levelOf(score: number): ThreatLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Combines the factors into a 0-100 score. Pure so it can be tested without a database. */
export function computeThreatScore(ip: string, inputs: ThreatInputs): ThreatScore {
  const volume = inputs.alerts > 0
    ? Math.min(MAXIMUM.volume, (MAXIMUM.volume * Math.log10(1 + inputs.alerts)) / Math.log10(1 + 100))
    : 0;
  const worst = inputs.scenarios.reduce((max, scenario) => Math.max(max, scenarioSeverity(scenario)), 0);
  const variety = inputs.scenarios.length > 1 ? Math.min(1, (inputs.scenarios.length - 1) / 4) : 0;
  const severity = inputs.scenarios.length > 0 ? 20 * worst + 5 * variety : 0;
  const repeat = inputs.episodes >= 5 ? 20 : inputs.episodes >= 3 ? 16 : inputs.episodes >= 2 ? 12 : inputs.episodes >= 1 ? 5 : 0;
  const reputationAvailable = inputs.abuseScore !== null;
  const reputation = reputationAvailable ? (MAXIMUM.reputation * Math.min(100, Math.max(0, inputs.abuseScore!))) / 100 : 0;

  const factors: ThreatFactor[] = [
    { key: 'volume', points: round1(volume), max: MAXIMUM.volume, value: inputs.alerts },
    { key: 'severity', points: round1(severity), max: MAXIMUM.severity, value: inputs.scenarios.length },
    { key: 'repeat', points: round1(repeat), max: MAXIMUM.repeat, value: inputs.episodes },
    { key: 'reputation', points: round1(reputation), max: MAXIMUM.reputation, value: inputs.abuseScore },
  ];
  const available = reputationAvailable ? 100 : 100 - MAXIMUM.reputation;
  const score = Math.min(100, Math.round(((volume + severity + repeat + reputation) / available) * 100));
  return { ip, score, level: levelOf(score), factors, reputation_available: reputationAvailable };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Reads what the cache knows about an address and scores it. */
export function scoreAddress(
  database: CrowdsecDatabase,
  ip: string,
  options: { now?: number; abuseScore?: number | null } = {},
): ThreatScore {
  const now = options.now ?? Date.now();
  const since = new Date(now - SCORE_WINDOW_DAYS * 86_400_000).toISOString();
  const row = database.db.query(`
    SELECT COUNT(*) AS alerts FROM alerts WHERE source_ip = ? AND simulated = 0 AND created_at >= ?
  `).get(ip, since) as { alerts: number };
  const scenarios = (database.db.query(`
    SELECT DISTINCT scenario FROM alerts WHERE source_ip = ? AND simulated = 0 AND created_at >= ? AND scenario IS NOT NULL AND scenario <> ''
  `).all(ip, since) as Array<{ scenario: string }>).map((entry) => entry.scenario);
  const offender = checkOffender(database, ip, { now });
  return computeThreatScore(ip, {
    alerts: row.alerts,
    scenarios,
    episodes: offender?.episodes ?? 0,
    abuseScore: options.abuseScore ?? null,
  });
}

export function registerThreatScoreRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  abuseScore: (ip: string) => number | null;
}): void {
  const { app, basePath, database, auth, abuseScore } = options;
  const valid = (ip: string) => isIP(ip) !== 0;

  app.get(`${basePath}/api/threat-score`, auth.ensureAuth, (context) => {
    const ip = context.req.query('ip')?.trim().toLowerCase() ?? '';
    if (!valid(ip)) return context.json({ error: 'A valid IP address is required' }, 400);
    return context.json(scoreAddress(database, ip, { abuseScore: abuseScore(ip) }));
  });

  app.get(`${basePath}/api/threat-scores`, auth.ensureAuth, (context) => {
    const ips = [...new Set((context.req.query('ips') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
    if (ips.length === 0 || ips.length > MAX_BATCH || !ips.every(valid)) {
      return context.json({ error: `Provide 1-${MAX_BATCH} valid IP addresses` }, 400);
    }
    return context.json({ scores: ips.map((ip) => scoreAddress(database, ip, { abuseScore: abuseScore(ip) })) });
  });
}
