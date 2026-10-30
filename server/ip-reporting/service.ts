import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type {
  IpReportCategoryRule,
  IpReporter,
  IpReporterConfig,
  IpReportPreview,
  IpReportPreviewRequest,
  IpReportPreviewRow,
  IpReportRun,
  IpReportRunStatus,
  IpReportRunTrigger,
  IpReportSkipCounts,
  UpsertIpReporterRequest,
} from '../../shared/contracts';
import { defaultIpReporterConfig, IP_REPORT_COMMENT_VARIABLES } from '../../shared/ip-reporting';
import type { CrowdsecDatabase, IpReporterRow, IpReportRunRow } from '../database';
import { classifyAddress } from '../notifications/outbound-guard';
import type { NotificationSecretStore } from '../notifications/secret-store';
import type { DatabaseQueryWorker } from '../query-worker-client';
import type { DatabaseWrite } from '../sync-worker-client';
import {
  ABUSEIPDB_BULK_MAX_ROWS,
  ABUSEIPDB_CATEGORY_IDS,
  ABUSEIPDB_COMMENT_MAX_BYTES,
  submitBulkReport,
  submitSingleReports,
  truncateUtf8,
  type AbuseIpdbReportRow,
  type AbuseIpdbSubmitResult,
} from './abuseipdb';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const STORED_API_KEY_SENTINEL = '(stored)';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LOOKBACK_MS = 7 * 24 * HOUR_MS;
const BUCKET_ALLOWANCE_MS = 24 * HOUR_MS;
const MAX_COOLDOWN_HOURS = 720;
const HISTORY_RETENTION_MS = (MAX_COOLDOWN_HOURS + 24) * HOUR_MS;
const SINGLE_MAX_ROWS = 1000;
const RUN_HISTORY_LIMIT = 50;
const PREVIEW_ROW_LIMIT = 200;
const ALERT_PAGE_SIZE = 1000;
const MAX_PATTERNS = 100;
const TEMPLATE_TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const TEMPLATE_VARIABLES = new Set<string>(IP_REPORT_COMMENT_VARIABLES);
const COMMUNITY_BLOCKLIST_SOURCE_SCOPE = 'crowdsecurity/community-blocklist';
const LIST_SOURCE_SCOPE_PREFIX = 'lists:';

export interface IpReportingServiceOptions {
  database: CrowdsecDatabase;
  queryWorker?: Pick<DatabaseQueryWorker, 'all'>;
  writeDatabase?: DatabaseWrite;
  secretStore: NotificationSecretStore;
  fetchImpl?: FetchLike;
  instances: ReadonlyArray<{ id: string; name: string }>;
  onReportersChanged?: () => void;
}

export type IpReportingService = ReturnType<typeof createIpReportingService>;

interface StoredReporter {
  id: string;
  name: string;
  enabled: boolean;
  config: IpReporterConfig;
  created_at: string;
  updated_at: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
}

interface ReportAlertRow {
  id: number;
  instance_id: string | null;
  created_at: string;
  stop_at: string | null;
  scenario: string | null;
  record_scenario: string | null;
  kind: string | null;
  source_ip: string | null;
  source_scope: string | null;
  origins: string | null;
}

interface IpGroup {
  ip: string;
  alerts: number;
  scenarios: Set<string>;
  instances: Set<string>;
  firstSeen: number;
  lastSeen: number;
}

interface ReportSelection {
  rows: AbuseIpdbReportRow[];
  previewRows: IpReportPreviewRow[];
  skipped: IpReportSkipCounts;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(values)).slice(0, MAX_PATTERNS);
}

function normalizeCategories(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const categories = value
    .map((entry) => Number(entry))
    .filter((entry) => ABUSEIPDB_CATEGORY_IDS.includes(entry));
  return Array.from(new Set(categories)).sort((left, right) => left - right);
}

function normalizeCategoryRules(value: unknown, fallback: IpReportCategoryRule[]): IpReportCategoryRule[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .map(asRecord)
    .map((entry) => ({
      pattern: typeof entry.pattern === 'string' ? entry.pattern.trim() : '',
      categories: normalizeCategories(entry.categories),
    }))
    .filter((rule) => rule.pattern || rule.categories.length > 0)
    .slice(0, MAX_PATTERNS);
}

export function normalizeIpReporterConfig(
  input: unknown,
  existing?: IpReporterConfig,
  knownInstanceIds?: ReadonlySet<string>,
): IpReporterConfig {
  const raw = asRecord(input);
  const base = existing ?? defaultIpReporterConfig();
  const incomingKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : undefined;
  const submitMode = raw.submitMode === 'single' || raw.submitMode === 'bulk' ? raw.submitMode : base.submitMode;
  const maxRows = submitMode === 'single' ? SINGLE_MAX_ROWS : ABUSEIPDB_BULK_MAX_ROWS;
  const instanceIds = normalizeStringList(raw.instanceIds, base.instanceIds);

  return {
    apiKey: incomingKey === undefined || incomingKey === '' || incomingKey === STORED_API_KEY_SENTINEL
      ? base.apiKey
      : incomingKey,
    submitMode,
    intervalMinutes: clampInteger(raw.intervalMinutes, base.intervalMinutes, 15, 10_080),
    cooldownHours: clampInteger(raw.cooldownHours, base.cooldownHours, 1, MAX_COOLDOWN_HOURS),
    maxReportsPerRun: clampInteger(raw.maxReportsPerRun, Math.min(base.maxReportsPerRun, maxRows), 1, maxRows),
    minAlerts: clampInteger(raw.minAlerts, base.minAlerts, 1, 1000),
    includeSimulated: typeof raw.includeSimulated === 'boolean' ? raw.includeSimulated : base.includeSimulated,
    instanceIds: knownInstanceIds ? instanceIds.filter((id) => knownInstanceIds.has(id)) : instanceIds,
    includeScenarios: normalizeStringList(raw.includeScenarios, base.includeScenarios),
    excludeScenarios: normalizeStringList(raw.excludeScenarios, base.excludeScenarios),
    categoryRules: normalizeCategoryRules(raw.categoryRules, base.categoryRules),
    defaultCategories: raw.defaultCategories === undefined ? base.defaultCategories : normalizeCategories(raw.defaultCategories),
    commentTemplate: typeof raw.commentTemplate === 'string' ? raw.commentTemplate : base.commentTemplate,
  };
}

export function validateCommentTemplate(template: string): string | null {
  for (const match of template.matchAll(TEMPLATE_TAG_RE)) {
    const tag = String(match[1] || '').trim();
    if (!TEMPLATE_VARIABLES.has(tag)) {
      return `Unknown comment variable: {{${tag}}}`;
    }
  }
  return null;
}

export function validateIpReporterConfig(config: IpReporterConfig, requireApiKey = true): string | null {
  if (requireApiKey && !config.apiKey) return 'AbuseIPDB API key is required';
  if (config.defaultCategories.length === 0) return 'At least one default category is required';
  for (const rule of config.categoryRules) {
    if (!rule.pattern) return 'Every category rule needs a scenario pattern';
    if (rule.categories.length === 0) return `Category rule "${rule.pattern}" needs at least one category`;
  }
  return validateCommentTemplate(config.commentTemplate);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function resolveReportCategories(
  scenarios: Iterable<string>,
  rules: IpReportCategoryRule[],
  defaultCategories: number[],
): number[] {
  const compiled = rules.map((rule) => ({ pattern: globToRegExp(rule.pattern), categories: rule.categories }));
  const categories = new Set<number>();
  for (const scenario of scenarios) {
    const rule = compiled.find((candidate) => candidate.pattern.test(scenario));
    for (const category of rule ? rule.categories : defaultCategories) categories.add(category);
  }
  if (categories.size === 0) for (const category of defaultCategories) categories.add(category);
  return Array.from(categories).sort((left, right) => left - right);
}

export function renderReportComment(template: string, values: Record<string, string>): string {
  const rendered = template.replace(TEMPLATE_TAG_RE, (_full, rawTag) => values[String(rawTag || '').trim()] ?? '');
  return truncateUtf8(rendered.trim(), ABUSEIPDB_COMMENT_MAX_BYTES);
}

function isLocalDetection(row: ReportAlertRow): boolean {
  const scope = (row.source_scope || '').trim();
  if (scope === COMMUNITY_BLOCKLIST_SOURCE_SCOPE || scope.startsWith(LIST_SOURCE_SCOPE_PREFIX)) return false;
  if (scope && scope.toLowerCase() !== 'ip') return false;
  if ((row.kind || '').toLowerCase() === 'capi') return false;
  const origins = (row.origins || '').split(/\s+/).filter(Boolean);
  return origins.length === 0 || origins.some((origin) => origin.toLowerCase() === 'crowdsec');
}

function addToBlockList(list: net.BlockList, value: string): void {
  const [address, prefixText] = value.trim().split('/');
  const version = net.isIP(address);
  if (version === 0) return;
  const type = version === 6 ? 'ipv6' : 'ipv4';
  try {
    if (prefixText === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefixText), type);
  } catch {
    // Ignore malformed allowlist values; LAPI validated them already.
  }
}

function emptySkipCounts(): IpReportSkipCounts {
  return { cooldown: 0, allowlisted: 0, not_public: 0, below_threshold: 0, over_limit: 0 };
}

function parseRun(row: IpReportRunRow): IpReportRun {
  let result: Record<string, unknown> = {};
  try {
    result = asRecord(JSON.parse(row.result_json));
  } catch {
    result = {};
  }
  return {
    id: row.id,
    reporter_id: row.reporter_id,
    trigger: row.run_trigger === 'manual' ? 'manual' : 'schedule',
    status: row.status as IpReportRunStatus,
    started_at: row.started_at,
    finished_at: row.finished_at,
    window_start: typeof result.window_start === 'string' ? result.window_start : row.started_at,
    window_end: typeof result.window_end === 'string' ? result.window_end : row.started_at,
    candidates: Number(result.candidates) || 0,
    submitted: Number(result.submitted) || 0,
    saved: Number(result.saved) || 0,
    rejected: Array.isArray(result.rejected) ? result.rejected as IpReportRun['rejected'] : [],
    skipped: { ...emptySkipCounts(), ...asRecord(result.skipped) } as IpReportSkipCounts,
    ...(typeof result.error === 'string' ? { error: result.error } : {}),
  };
}

export function createIpReportingService(options: IpReportingServiceOptions) {
  const { database, secretStore } = options;
  const writeDatabase: DatabaseWrite = options.writeDatabase ?? (async (operation) => operation());
  const fetchImpl = options.fetchImpl || fetch;
  const instanceNames = new Map(options.instances.map((instance) => [instance.id, instance.name]));
  const knownInstanceIds = new Set(instanceNames.keys());
  const runsInFlight = new Map<string, Promise<IpReportRun>>();
  let dueRun: Promise<void> | null = null;

  async function queryAll<T>(sql: string, params: unknown[]): Promise<T[]> {
    if (options.queryWorker) return options.queryWorker.all<T>(sql, params);
    return database.db.prepare(sql).all(...params) as T[];
  }

  function hydrate(row: IpReporterRow): StoredReporter {
    const parsed = secretStore.parseConfig(String(row.config_json || '{}'));
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      config: normalizeIpReporterConfig(parsed.config),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_attempt_at: row.last_attempt_at,
      last_success_at: row.last_success_at,
    };
  }

  function getStored(id: string): StoredReporter | null {
    const row = database.getIpReporterById(id);
    return row ? hydrate(row) : null;
  }

  function toPublic(reporter: StoredReporter): IpReporter {
    const lastRunRow = database.listIpReportRuns(reporter.id, 1)[0];
    const lastAttempt = reporter.last_attempt_at ? Date.parse(reporter.last_attempt_at) : NaN;
    return {
      id: reporter.id,
      name: reporter.name,
      provider: 'abuseipdb',
      enabled: reporter.enabled,
      config: { ...reporter.config, apiKey: reporter.config.apiKey ? STORED_API_KEY_SENTINEL : '' },
      configured_secrets: reporter.config.apiKey ? ['apiKey'] : [],
      created_at: reporter.created_at,
      updated_at: reporter.updated_at,
      last_attempt_at: reporter.last_attempt_at,
      last_success_at: reporter.last_success_at,
      next_run_at: reporter.enabled && Number.isFinite(lastAttempt)
        ? new Date(lastAttempt + reporter.config.intervalMinutes * MINUTE_MS).toISOString()
        : null,
      last_run: lastRunRow ? parseRun(lastRunRow) : null,
    };
  }

  function normalizeInput(input: UpsertIpReporterRequest, existing: StoredReporter | null) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('Reporter name is required');
    if (input.provider !== undefined && input.provider !== 'abuseipdb') throw new Error('Unsupported reporting provider');
    const config = normalizeIpReporterConfig(input.config, existing?.config, knownInstanceIds);
    return { name, enabled: input.enabled !== false, config };
  }

  async function save(reporter: StoredReporter): Promise<void> {
    await writeDatabase(() => database.upsertIpReporter({
      $id: reporter.id,
      $created_at: reporter.created_at,
      $updated_at: reporter.updated_at,
      $name: reporter.name,
      $provider: 'abuseipdb',
      $enabled: reporter.enabled ? 1 : 0,
      $config_json: secretStore.serializeConfig(reporter.config as unknown as Record<string, unknown>, Boolean(reporter.config.apiKey)),
    }));
    options.onReportersChanged?.();
  }

  function hasEnabledReporters(): boolean {
    return database.listIpReporters().some((row) => row.enabled === 1);
  }

  function listReporters(): IpReporter[] {
    return database.listIpReporters().map((row) => toPublic(hydrate(row)));
  }

  async function createReporter(input: UpsertIpReporterRequest): Promise<IpReporter> {
    const normalized = normalizeInput(input, null);
    const error = validateIpReporterConfig(normalized.config);
    if (error) throw new Error(error);
    const now = new Date().toISOString();
    const reporter: StoredReporter = {
      id: randomUUID(),
      ...normalized,
      created_at: now,
      updated_at: now,
      last_attempt_at: null,
      last_success_at: null,
    };
    await save(reporter);
    return toPublic(reporter);
  }

  async function updateReporter(id: string, input: UpsertIpReporterRequest): Promise<IpReporter> {
    const existing = getStored(id);
    if (!existing) throw new Error('IP reporter not found');
    const normalized = normalizeInput(input, existing);
    const error = validateIpReporterConfig(normalized.config);
    if (error) throw new Error(error);
    const reporter: StoredReporter = { ...existing, ...normalized, updated_at: new Date().toISOString() };
    await save(reporter);
    return toPublic(reporter);
  }

  async function deleteReporter(id: string): Promise<void> {
    await writeDatabase(() => database.transaction(() => database.deleteIpReporter(id))(undefined));
  }

  function listRuns(id: string, limit = RUN_HISTORY_LIMIT): IpReportRun[] {
    if (!database.getIpReporterById(id)) throw new Error('IP reporter not found');
    return database.listIpReportRuns(id, Math.min(Math.max(1, limit), RUN_HISTORY_LIMIT)).map(parseRun);
  }

  // A new reporter starts one interval back instead of sending the whole lookback at once.
  function windowStartFor(config: IpReporterConfig, createdAt: string | null, now: number): number {
    const created = createdAt ? Date.parse(createdAt) : NaN;
    const base = Number.isFinite(created) ? Math.min(created, now) : now;
    return Math.max(now - LOOKBACK_MS, base - config.intervalMinutes * MINUTE_MS);
  }

  async function loadAllowlistMatcher(now: number): Promise<net.BlockList> {
    const rows = await queryAll<{ value: string }>(
      'SELECT DISTINCT value FROM allowlist_items WHERE expiration IS NULL OR expiration > ?',
      [new Date(now).toISOString()],
    );
    const list = new net.BlockList();
    for (const row of rows) addToBlockList(list, String(row.value || ''));
    return list;
  }

  async function collectGroups(
    config: IpReporterConfig,
    windowStart: number,
    windowEnd: number,
    reportedUntil: ReadonlyMap<string, number>,
  ): Promise<Map<string, IpGroup>> {
    const include = config.includeScenarios.map(globToRegExp);
    const exclude = config.excludeScenarios.map(globToRegExp);
    const instanceIds = config.instanceIds.filter((id) => knownInstanceIds.has(id));
    const conditions = ['created_at >= ?', 'created_at < ?'];
    const params: unknown[] = [
      new Date(windowStart - BUCKET_ALLOWANCE_MS).toISOString(),
      new Date(windowEnd).toISOString(),
    ];
    if (!config.includeSimulated) conditions.push('simulated = 0');
    if (instanceIds.length > 0) {
      conditions.push(`instance_id IN (${instanceIds.map(() => '?').join(', ')})`);
      params.push(...instanceIds);
    }

    const groups = new Map<string, IpGroup>();
    let lastId = 0;
    for (;;) {
      const rows = await queryAll<ReportAlertRow>(
        `SELECT id, instance_id, created_at, stop_at, scenario, record_scenario, kind, source_ip, source_scope, origins
         FROM alerts
         WHERE ${conditions.join(' AND ')} AND id > ?
         ORDER BY id ASC
         LIMIT ${ALERT_PAGE_SIZE}`,
        [...params, lastId],
      );
      for (const row of rows) {
        const ip = (row.source_ip || '').trim();
        if (!ip || net.isIP(ip) === 0 || !isLocalDetection(row)) continue;
        const startedAt = Date.parse(row.created_at);
        const detectedAt = Date.parse(row.stop_at || row.created_at);
        if (!Number.isFinite(detectedAt) || detectedAt < windowStart || detectedAt >= windowEnd) continue;
        if (detectedAt <= (reportedUntil.get(ip) ?? Number.NEGATIVE_INFINITY)) continue;
        const scenario = (row.record_scenario ?? row.scenario ?? '').trim();
        if (!scenario) continue;
        if (include.length > 0 && !include.some((pattern) => pattern.test(scenario))) continue;
        if (exclude.some((pattern) => pattern.test(scenario))) continue;

        const group = groups.get(ip) ?? {
          ip,
          alerts: 0,
          scenarios: new Set<string>(),
          instances: new Set<string>(),
          firstSeen: Number.POSITIVE_INFINITY,
          lastSeen: 0,
        };
        group.alerts += 1;
        group.scenarios.add(scenario);
        group.instances.add(row.instance_id || 'default');
        group.firstSeen = Math.min(group.firstSeen, Number.isFinite(startedAt) ? startedAt : detectedAt);
        group.lastSeen = Math.max(group.lastSeen, detectedAt);
        groups.set(ip, group);
      }
      if (rows.length < ALERT_PAGE_SIZE) break;
      lastId = Number(rows[rows.length - 1].id);
    }
    return groups;
  }

  async function selectReports(
    reporterId: string | null,
    config: IpReporterConfig,
    windowStart: number,
    windowEnd: number,
  ): Promise<ReportSelection> {
    const history = reporterId ? database.listIpReportHistory(reporterId) : [];
    const reportedUntil = new Map(history.map((entry) => [entry.ip, Date.parse(entry.last_seen_at)]));
    const cooldownStart = windowEnd - config.cooldownHours * HOUR_MS;
    const recentlyReported = new Set(history
      .filter((entry) => Date.parse(entry.reported_at) >= cooldownStart)
      .map((entry) => entry.ip));
    const groups = await collectGroups(config, windowStart, windowEnd, reportedUntil);
    const skipped = emptySkipCounts();
    const allowlist = groups.size > 0 ? await loadAllowlistMatcher(windowEnd) : null;

    const eligible: IpGroup[] = [];
    for (const group of groups.values()) {
      const type = net.isIP(group.ip) === 6 ? 'ipv6' : 'ipv4';
      if (classifyAddress(group.ip) !== 'public') skipped.not_public += 1;
      else if (allowlist?.check(group.ip, type)) skipped.allowlisted += 1;
      else if (group.alerts < config.minAlerts) skipped.below_threshold += 1;
      else if (recentlyReported.has(group.ip)) skipped.cooldown += 1;
      else eligible.push(group);
    }
    eligible.sort((left, right) => right.alerts - left.alerts || right.lastSeen - left.lastSeen || left.ip.localeCompare(right.ip));
    const selected = eligible.slice(0, config.maxReportsPerRun);
    skipped.over_limit = eligible.length - selected.length;

    const previewRows = selected.map((group): IpReportPreviewRow => {
      const scenarios = Array.from(group.scenarios).sort();
      const reportDate = new Date(group.lastSeen).toISOString();
      const comment = renderReportComment(config.commentTemplate, {
        ip: group.ip,
        scenarios: scenarios.join(', '),
        alerts: String(group.alerts),
        first_seen: new Date(group.firstSeen).toISOString(),
        last_seen: reportDate,
        instances: Array.from(group.instances).map((id) => instanceNames.get(id) || id).sort().join(', '),
      });
      return {
        ip: group.ip,
        categories: resolveReportCategories(scenarios, config.categoryRules, config.defaultCategories),
        report_date: reportDate,
        comment,
        alerts: group.alerts,
        scenarios,
      };
    });

    return {
      rows: previewRows.map((row) => ({ ip: row.ip, categories: row.categories, reportDate: row.report_date, comment: row.comment })),
      previewRows,
      skipped,
    };
  }

  async function preview(input: IpReportPreviewRequest, now = new Date()): Promise<IpReportPreview> {
    const existing = typeof input.id === 'string' && input.id ? getStored(input.id) : null;
    const config = normalizeIpReporterConfig(input.config, existing?.config, knownInstanceIds);
    const error = validateIpReporterConfig(config, false);
    if (error) throw new Error(error);
    const windowEnd = now.getTime();
    const windowStart = windowStartFor(config, existing?.created_at ?? null, windowEnd);
    const selection = await selectReports(existing?.id ?? null, config, windowStart, windowEnd);
    return {
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
      total: selection.previewRows.length,
      rows: selection.previewRows.slice(0, PREVIEW_ROW_LIMIT),
      skipped: selection.skipped,
    };
  }

  async function executeRun(reporter: StoredReporter, trigger: IpReportRunTrigger, now: Date): Promise<IpReportRun> {
    const startedAt = new Date().toISOString();
    const windowEnd = now.getTime();
    const windowStart = windowStartFor(reporter.config, reporter.created_at, windowEnd);
    let selection: ReportSelection = { rows: [], previewRows: [], skipped: emptySkipCounts() };
    let result: AbuseIpdbSubmitResult = { saved: [], rejected: [], unsent: [] };

    try {
      selection = await selectReports(reporter.id, reporter.config, windowStart, windowEnd);
      if (selection.rows.length > 0) {
        result = reporter.config.submitMode === 'single'
          ? await submitSingleReports(reporter.config.apiKey, selection.rows, fetchImpl)
          : await submitBulkReport(reporter.config.apiKey, selection.rows, fetchImpl);
      }
    } catch (error) {
      result = {
        saved: [],
        rejected: [],
        unsent: selection.rows.map((row) => row.ip),
        error: error instanceof Error ? error.message : 'IP report failed',
      };
    }

    let status: IpReportRunStatus;
    if (selection.rows.length === 0 && !result.error) status = 'empty';
    else if (result.unsent.length === 0 && result.rejected.length === 0 && !result.error) status = 'success';
    else status = result.saved.length > 0 ? 'partial' : 'failed';

    const completed = result.unsent.length === 0 && !result.error;
    const run: IpReportRun = {
      id: randomUUID(),
      reporter_id: reporter.id,
      trigger,
      status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
      candidates: selection.rows.length,
      submitted: selection.rows.length - result.unsent.length,
      saved: result.saved.length,
      rejected: result.rejected.slice(0, 50),
      skipped: selection.skipped,
      ...(result.error ? { error: result.error } : {}),
    };

    if (status === 'failed' || status === 'partial') {
      console.warn(`IP report "${reporter.name}" ${status}: ${result.error || `${result.rejected.length} report(s) rejected`}`);
    }

    await writeDatabase(() => database.transaction(() => {
      if (!database.getIpReporterById(reporter.id)) return;
      const lastSeenByIp = new Map(selection.rows.map((row) => [row.ip, row.reportDate]));
      database.recordIpReportHistory(
        reporter.id,
        result.saved.map((ip) => ({ ip, lastSeenAt: lastSeenByIp.get(ip) ?? run.window_end })),
        run.finished_at,
        new Date(windowEnd - HISTORY_RETENTION_MS).toISOString(),
      );
      const { id, reporter_id, trigger: runTrigger, status: runStatus, started_at, finished_at, ...details } = run;
      database.insertIpReportRun({
        $id: id,
        $reporter_id: reporter_id,
        $started_at: started_at,
        $finished_at: finished_at,
        $run_trigger: runTrigger,
        $status: runStatus,
        $result_json: JSON.stringify(details),
      }, RUN_HISTORY_LIMIT);
      database.updateIpReporterRunState(
        reporter.id,
        startedAt,
        completed ? run.finished_at : reporter.last_success_at,
      );
    })(undefined));

    return run;
  }

  function runReporter(id: string, trigger: IpReportRunTrigger = 'manual', now = new Date()): Promise<IpReportRun> {
    const inFlight = runsInFlight.get(id);
    if (inFlight) return inFlight;
    const reporter = getStored(id);
    if (!reporter) return Promise.reject(new Error('IP reporter not found'));
    if (!reporter.config.apiKey) return Promise.reject(new Error('AbuseIPDB API key is required'));
    const promise = executeRun(reporter, trigger, now).finally(() => runsInFlight.delete(id));
    runsInFlight.set(id, promise);
    return promise;
  }

  function isDue(reporter: StoredReporter, now: number): boolean {
    if (!reporter.enabled || !reporter.config.apiKey) return false;
    const lastAttempt = reporter.last_attempt_at ? Date.parse(reporter.last_attempt_at) : NaN;
    return !Number.isFinite(lastAttempt) || now - lastAttempt >= reporter.config.intervalMinutes * MINUTE_MS;
  }

  function runDueReporters(now = new Date()): Promise<void> {
    if (dueRun) return dueRun;
    dueRun = (async () => {
      for (const row of database.listIpReporters()) {
        let reporter: StoredReporter;
        try {
          reporter = hydrate(row);
        } catch (error) {
          console.error(`Failed to load IP reporter "${row.name}":`, error);
          continue;
        }
        if (!isDue(reporter, now.getTime())) continue;
        try {
          await runReporter(reporter.id, 'schedule', now);
        } catch (error) {
          console.error(`IP report "${reporter.name}" failed:`, error);
        }
      }
    })().finally(() => {
      dueRun = null;
    });
    return dueRun;
  }

  return {
    listReporters,
    createReporter,
    updateReporter,
    deleteReporter,
    listRuns,
    preview,
    runReporter,
    runDueReporters,
    hasEnabledReporters,
  };
}
