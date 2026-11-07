// Synthetic attack patterns and a pre-built long-term archive for the
// `statistics` load-test profile. The same shape generates the cached alerts
// (imported through the normal sync and statistics capture) and the archive
// history before the cache window, so the two join without a visible seam.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { StatisticsStore } from '../server/statistics-store';
import { statisticsCutoff } from '../shared/statistics';

const DAY_MS = 86_400_000;
export const STATISTICS_DATABASE_FILE = 'statistics.db';

/**
 * Scenario mix with relative weights. `bans: false` scenarios never receive a
 * decision: AppSec virtual patches block in-band, and the custom scenario is
 * deliberately not covered by a profile (a remediation gap).
 */
const SCENARIOS: Array<{ name: string; reason: string; target: string; weight: number; bans: boolean; newWithinDays?: number }> = [
  { name: 'crowdsecurity/ssh-bf', reason: 'SSH brute force', target: 'ssh', weight: 22, bans: true },
  { name: 'crowdsecurity/http-probing', reason: 'HTTP probing', target: 'reverse-proxy', weight: 16, bans: true },
  { name: 'crowdsecurity/iptables-scan-multi_ports', reason: 'Port scan', target: 'firewall', weight: 8, bans: true },
  { name: 'crowdsecurity/http-crawl-non_statics', reason: 'Aggressive crawl', target: 'reverse-proxy', weight: 7, bans: true },
  { name: 'crowdsecurity/vpatch-env-access', reason: 'AppSec: .env access', target: 'appsec', weight: 8, bans: false },
  { name: 'crowdsecurity/vpatch-git-config', reason: 'AppSec: .git/config access', target: 'appsec', weight: 4, bans: false },
  { name: 'custom/http-admin-probing', reason: 'Admin panel probing (no profile)', target: 'reverse-proxy', weight: 5, bans: false },
  { name: 'crowdsecurity/http-cve-probing', reason: 'HTTP CVE probing', target: 'app', weight: 6, bans: true },
  { name: 'crowdsecurity/http-bad-user-agent', reason: 'Bad user agent', target: 'reverse-proxy', weight: 6, bans: true },
  { name: 'crowdsecurity/nginx-req-limit-exceeded', reason: 'HTTP rate limit exceeded', target: 'reverse-proxy', weight: 6, bans: true },
  { name: 'crowdsecurity/mysql-bf', reason: 'MySQL brute force', target: 'database', weight: 4, bans: true },
  { name: 'crowdsecurity/postfix-spam', reason: 'Postfix spam attempt', target: 'mail', weight: 4, bans: true },
  // New attack types that only appear in the last days.
  { name: 'crowdsecurity/http-generic-bf', reason: 'HTTP login brute force', target: 'app', weight: 10, bans: true, newWithinDays: 5 },
  { name: 'crowdsecurity/vpatch-CVE-2025-29927', reason: 'AppSec: Next.js middleware bypass', target: 'appsec', weight: 6, bans: false, newWithinDays: 5 },
];

const MACHINES = ['edge-gateway-01', 'edge-gateway-02', 'proxy-01', 'proxy-02', 'appsec-01', 'mail-01', 'database-01', 'dev-bastion'] as const;
/** Stops reporting this many days before the seed, like a stopped agent. */
const QUIET_MACHINE = 'dev-bastion';
const QUIET_DAYS = 12;
/** Receives a growing share of attacks in the last week. */
const SPIKE_MACHINE = 'proxy-02';
const SPIKE_DAYS = 7;

const OTHER_NETWORKS: ReadonlyArray<readonly [string, number]> = [
  ['DigitalOcean LLC', 14061], ['OVH SAS', 16276], ['Amazon.com, Inc.', 16509], ['Microsoft Corporation', 8075],
  ['Akamai Technologies', 20940], ['Comcast Cable', 7922], ['Telecom Italia', 3269], ['NTT Communications', 2914],
  ['Chinanet', 4134], ['Contabo GmbH', 51167],
];
const COUNTRIES = ['US', 'DE', 'NL', 'FR', 'GB', 'BR', 'IN', 'JP', 'SG', 'AU'] as const;

export interface StatisticsAlertShape {
  scenario: string;
  reason: string;
  target: string;
  machine: string;
  ip: string;
  country: string;
  asName: string;
  asNumber: number;
  simulated: boolean;
  /** Whether CrowdSec would issue a decision for this alert. */
  bans: boolean;
  decisionType: 'ban' | 'captcha';
  eventsCount: number;
}

function hash32(value: number, seed: number): number {
  let next = Math.imul(value ^ seed, 0x45d9f3b);
  next ^= next >>> 16;
  next = Math.imul(next, 0x45d9f3b);
  next ^= next >>> 16;
  return next >>> 0;
}

function fraction(value: number, seed: number, salt: number): number {
  return hash32(value + Math.imul(salt, 1_000_003), seed) / 0x1_0000_0000;
}

function weighted<T extends { weight: number }>(items: T[], value: number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let remaining = value * total;
  for (const item of items) {
    remaining -= item.weight;
    if (remaining < 0) return item;
  }
  return items[items.length - 1];
}

function ipv4(value: number): string {
  const first = [45, 62, 77, 91, 103, 185, 193, 212][value % 8];
  return `${first}.${1 + ((value >>> 8) % 254)}.${1 + ((value >>> 16) % 254)}.${1 + ((value >>> 24) % 254)}`;
}

/**
 * Sources mix four populations: a cloud provider with many IPs in a few /24s
 * (an AS worth blocking), a skewed pool of repeat attackers (recurring and
 * returning IPs, wide scanners), one-off addresses (high cardinality) and IPv6
 * hosts in a few /64s.
 */
function source(index: number, seed: number): Pick<StatisticsAlertShape, 'ip' | 'country' | 'asName' | 'asNumber'> {
  const population = fraction(index, seed, 101);
  if (population < 0.35) {
    const range = hash32(index, seed + 7) % 60;
    const host = 1 + (hash32(index, seed + 11) % 40);
    return { ip: `34.${64 + (range % 40)}.${1 + ((range * 37) % 250)}.${host}`, country: 'US', asName: 'Google LLC', asNumber: 15169 };
  }
  const network = (value: number) => OTHER_NETWORKS[value % OTHER_NETWORKS.length];
  const country = (value: number) => COUNTRIES[value % COUNTRIES.length];
  if (population < 0.65) {
    // Cubic skew: a few attackers produce most of the pool's alerts.
    const attacker = Math.floor(15_000 * fraction(index, seed, 103) ** 3);
    const value = hash32(attacker, seed + 13);
    const [asName, asNumber] = network(value);
    return { ip: ipv4(value), country: country(value >>> 4), asName, asNumber };
  }
  if (population < 0.95) {
    const value = hash32(index, seed + 17);
    const [asName, asNumber] = network(value);
    return { ip: ipv4(value ^ 0x5bd1e995), country: country(value >>> 4), asName, asNumber };
  }
  const range = hash32(index, seed + 19) % 20;
  const host = 1 + (hash32(index, seed + 23) % 30);
  return { ip: `2a01:4f8:${(0x1000 + range).toString(16)}:${((range * 13) % 0xffff).toString(16)}::${host.toString(16)}`, country: 'DE', asName: 'Hetzner Online GmbH', asNumber: 24940 };
}

/** Whether CrowdSec issues a decision for alerts of this statistics-profile scenario. */
export function statisticsScenarioBans(scenario: string | undefined): boolean {
  return SCENARIOS.find((item) => item.name === scenario)?.bans ?? true;
}

/**
 * Deterministic alert attributes for alert `index` created at `atMs`. Instances
 * share `sourceSeed`, so their attacker pools overlap like real attackers that
 * reach several sites.
 */
export function statisticsAlertShape(index: number, atMs: number, nowMs: number, seed: number, sourceSeed = seed): StatisticsAlertShape {
  const daysAgo = (nowMs - atMs) / DAY_MS;
  const scenario = weighted(SCENARIOS.filter((item) => item.newWithinDays === undefined || daysAgo < item.newWithinDays), fraction(index, seed, 107));
  let machine: string = MACHINES[hash32(index, seed + 29) % MACHINES.length];
  if (machine === QUIET_MACHINE && daysAgo < QUIET_DAYS) machine = 'edge-gateway-01';
  if (daysAgo < SPIKE_DAYS && fraction(index, seed, 109) < 0.3) machine = SPIKE_MACHINE;
  return {
    scenario: scenario.name,
    reason: scenario.reason,
    target: scenario.target,
    machine,
    ...source(index, sourceSeed),
    simulated: fraction(index, seed, 113) < 0.05,
    bans: scenario.bans,
    decisionType: fraction(index, seed, 127) < 0.05 ? 'captcha' : 'ban',
    eventsCount: 1 + Math.floor(fraction(index, seed, 131) * 60),
  };
}

export function removeStatisticsDatabase(dbDir: string): void {
  for (const suffix of ['', '-shm', '-wal', '-journal']) rmSync(path.join(dbDir, `${STATISTICS_DATABASE_FILE}${suffix}`), { force: true });
}

/**
 * Builds the archive for history older than the cache window through the real
 * consolidation code, then records it as covered. Coverage overlaps the start
 * of the cache window by one day, so the first collection job joins both spans.
 */
export function seedStatisticsArchive(options: {
  dbDir: string; instanceId: string; seed: number; sourceSeed?: number; nowMs: number;
  historyDays: number; cacheStartMs: number; dailyAlerts: number; retentionDays: number;
  log: (message: string) => void;
}): { alerts: number; decisions: number } {
  const { dbDir, instanceId, seed, sourceSeed = seed, nowMs, historyDays, cacheStartMs, dailyAlerts, retentionDays, log } = options;
  const store = new StatisticsStore(path.join(dbDir, STATISTICS_DATABASE_FILE));
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = statisticsCutoff(retentionDays, nowMs);
  const historyStartMs = Math.max(Date.parse(`${cutoff}T00:00:00.000Z`), nowMs - historyDays * DAY_MS);
  const context = { cutoff, epoch: 'loadtest-archive', enabled: false, caughtUp: false, coverageFrom: {}, instances: [instanceId], now: nowIso };
  let rows: Array<{ seq: number; identity: string; day: string; payload: string }> = [];
  let sequence = 0;
  let alerts = 0;
  let decisions = 0;
  const flush = () => { if (rows.length) store.consolidate(rows, context); rows = []; };
  try {
    const totalDays = Math.max(0, Math.ceil((cacheStartMs - historyStartMs) / DAY_MS));
    for (let dayIndex = 0; dayIndex < totalDays; dayIndex += 1) {
      const dayStartMs = historyStartMs + dayIndex * DAY_MS;
      const dayEndMs = Math.min(cacheStartMs, dayStartMs + DAY_MS);
      const weekday = new Date(dayStartMs).getUTCDay();
      // Day-to-day noise plus slightly busier weekends.
      const count = Math.round(dailyAlerts * (dayEndMs - dayStartMs) / DAY_MS * (0.8 + 0.4 * fraction(dayIndex, seed, 137)) * (weekday === 0 || weekday === 6 ? 1.1 : 1));
      for (let item = 0; item < count; item += 1) {
        // Archive indexes stay clear of the cached alert indexes.
        const index = 50_000_000 + alerts;
        const atMs = dayStartMs + Math.floor(fraction(index, seed, 139) * (dayEndMs - dayStartMs));
        const at = new Date(atMs).toISOString();
        const shape = statisticsAlertShape(index, atMs, nowMs, seed, sourceSeed);
        const identity = ['loadtest-archive', instanceId, index];
        rows.push({ seq: ++sequence, identity: JSON.stringify(identity), day: at.slice(0, 10), payload: JSON.stringify([1, 'a', at, instanceId, shape.ip,
          shape.country, shape.asNumber, shape.asName, shape.machine, shape.machine, shape.scenario, shape.simulated ? 1 : 0, shape.eventsCount]) });
        alerts += 1;
        if (shape.bans) {
          rows.push({ seq: ++sequence, identity: JSON.stringify(['loadtest-archive-decision', instanceId, index]), day: at.slice(0, 10), payload: JSON.stringify([1, 'd', at, instanceId,
            shape.ip, shape.country, shape.asNumber, shape.asName, shape.machine, shape.machine, shape.scenario, shape.simulated ? 1 : 0,
            at, shape.simulated ? 1 : 0, shape.decisionType, 'crowdsec', identity]) });
          decisions += 1;
        }
        if (rows.length >= 20_000) flush();
      }
      if (dayIndex % 30 === 29 || dayIndex === totalDays - 1) log(`statistics archive: ${dayIndex + 1}/${totalDays} days, ${alerts.toLocaleString('en-US')} alerts`);
    }
    flush();
    if (alerts > 0) {
      store.db.prepare('INSERT OR REPLACE INTO coverage(epoch, instance, start, through) VALUES (?, ?, ?, ?)')
        .run('loadtest-archive', instanceId, new Date(historyStartMs).toISOString(), new Date(Math.min(nowMs, cacheStartMs + DAY_MS)).toISOString());
    }
  } finally {
    store.close();
  }
  return { alerts, decisions };
}
