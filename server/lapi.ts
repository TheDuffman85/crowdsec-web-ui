import fs from 'node:fs';
import os from 'node:os';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { LapiStatus } from '../shared/contracts';
import type { CrowdsecAuthConfig } from './auth';

export type LapiRequestInit = RequestInit & {
  dispatcher?: Dispatcher;
};

export type FetchLike = (input: string | URL | Request, init?: LapiRequestInit) => Promise<Response>;

export interface FetchLapiOptions {
  method?: string;
  body?: unknown;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface FetchLapiResult<TData = unknown> {
  data: TData;
  status: number;
  headers: Headers;
}

export interface LapiClientOptions {
  crowdsecUrl: string;
  auth: CrowdsecAuthConfig;
  simulationsEnabled?: boolean;
  lookbackPeriod: string;
  requestTimeoutMs?: number;
  version: string;
  machineInfo?: MachineInfo;
  fetchImpl?: FetchLike;
}

export interface FetchAlertsFilters {
  origin?: string;
  scenario?: string;
  includeCapi?: boolean;
  singleScopeOnly?: boolean;
  requireAllScopes?: boolean;
  relativeWindow?: {
    startMs: number;
    endMs: number;
    paddingMs: number;
  };
}

function formatRelativeDuration(milliseconds: number, round: 'up' | 'down'): string {
  const seconds = round === 'up'
    ? Math.ceil(Math.max(0, milliseconds) / 1_000)
    : Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h${minutes}m${seconds % 60}s`;
}

interface MachineInfo {
  os: {
    name: string;
    family?: string;
    version: string;
  };
}

function parseOsReleaseValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function parseOsRelease(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex);
    const value = parseOsReleaseValue(trimmed.slice(separatorIndex + 1));
    if (value) {
      values[key] = value;
    }
  }
  return values;
}

function detectMachineInfo(): MachineInfo {
  let osName: string = os.platform();
  let osFamily: string = os.type();
  let osVersion: string = os.release();

  try {
    const release = parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8'));
    osName = release.ID || release.NAME || osName;
    osFamily = release.ID_LIKE || release.ID || osFamily;
    osVersion = release.VERSION_ID || release.VERSION || osVersion;
  } catch {
    // Fall back to Node's platform details when distro metadata is unavailable.
  }

  if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) {
    osName = `${osName} (docker)`;
  }

  return {
    os: {
      name: osName,
      family: osFamily,
      version: osVersion,
    },
  };
}

export class LapiClient {
  private readonly crowdsecUrl: string;
  private readonly auth: CrowdsecAuthConfig;
  private readonly simulationsEnabled: boolean;
  private readonly version: string;
  private readonly machineInfo: MachineInfo;
  private readonly startupTimestamp: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly dispatcher?: Dispatcher;

  public readonly lookbackPeriod: string;
  private requestToken: string | null = null;
  private loginPromise: Promise<boolean> | null = null;
  private readonly lapiStatus: LapiStatus = {
    isConnected: false,
    lastCheck: null,
    lastError: null,
    offline_since: null,
  };

  constructor(options: LapiClientOptions) {
    this.crowdsecUrl = options.crowdsecUrl;
    this.auth = options.auth;
    this.simulationsEnabled = options.simulationsEnabled ?? false;
    this.lookbackPeriod = options.lookbackPeriod;
    this.version = options.version;
    this.machineInfo = options.machineInfo || detectMachineInfo();
    this.startupTimestamp = Math.floor(Date.now() / 1_000);
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    this.fetchImpl = options.fetchImpl || ((input, init) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        init as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>);
    this.dispatcher = this.auth.mode === 'mtls'
      ? new Agent({
          connect: {
            key: fs.readFileSync(this.auth.keyPath),
            cert: fs.readFileSync(this.auth.certPath),
            ...(this.auth.caCertPath ? { ca: fs.readFileSync(this.auth.caCertPath) } : {}),
          },
        })
      : undefined;
  }

  updateStatus(isConnected: boolean, error: { message?: string } | null = null): void {
    const now = new Date().toISOString();
    if (isConnected) {
      this.lapiStatus.offline_since = null;
    } else if (!this.lapiStatus.offline_since) {
      this.lapiStatus.offline_since = now;
    }
    this.lapiStatus.isConnected = isConnected;
    this.lapiStatus.lastCheck = now;
    this.lapiStatus.lastError = error?.message || null;
  }

  getStatus(): LapiStatus {
    return { ...this.lapiStatus };
  }

  hasAuthConfig(): boolean {
    return this.auth.mode !== 'none';
  }

  hasToken(): boolean {
    return Boolean(this.requestToken);
  }

  clearToken(): void {
    this.requestToken = null;
  }

  async fetchLapi<TData = unknown>(endpoint: string, options: FetchLapiOptions = {}, isRetry = false): Promise<FetchLapiResult<TData>> {
    const controller = new AbortController();
    const timeout = options.timeout ?? this.requestTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const url = `${this.crowdsecUrl}${endpoint}`;
    const isLoginRequest = endpoint.includes('/watchers/login');
    const headers: Record<string, string> = {
      'User-Agent': `crowdsec-web-ui/${this.version || '0.0.0'}`,
      Connection: 'close',
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.requestToken && !isLoginRequest) {
      headers.Authorization = `Bearer ${this.requestToken}`;
    }

    try {
      const response = await this.fetchImpl(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });

      if (response.status === 401 && !isRetry && !isLoginRequest) {
        const success = await this.login();
        if (success) {
          return this.fetchLapi<TData>(endpoint, options, true);
        }

        const error = new Error('HTTP 401: Re-authentication failed') as Error & { status?: number };
        error.status = 401;
        throw error;
      }

      const contentType = response.headers.get('content-type');
      const data = contentType?.includes('application/json')
        ? (await response.json()) as TData
        : (await response.text()) as TData;

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & {
          status?: number;
          response?: { data: TData; status: number; headers: Headers };
        };
        error.status = response.status;
        error.response = { data, status: response.status, headers: response.headers };
        throw error;
      }

      return { data, status: response.status, headers: response.headers };
    } catch (error: any) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        const timeoutError = new Error('Request timeout') as Error & { code?: string };
        timeoutError.code = 'ETIMEDOUT';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async login(context = 'general'): Promise<boolean> {
    const contextLabel = context ? ` (${context})` : '';

    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      if (this.auth.mode === 'none') {
        console.error(`Authentication failed${contextLabel}: CrowdSec LAPI authentication is not configured.`);
        this.updateStatus(false, { message: 'Authentication not configured' });
        return false;
      }

      try {
        const body: Record<string, unknown> = {
          scenarios: ['manual/web-ui'],
        };
        if (this.auth.mode === 'password') {
          body.machine_id = this.auth.user;
          body.password = this.auth.password;
        }

        const response = await this.fetchLapi<{ code?: number; token?: string }>('/v1/watchers/login', {
          method: 'POST',
          body,
        });

        if (response.data?.token) {
          this.requestToken = response.data.token;
          this.updateStatus(true);
          return true;
        }

        console.error(`Authentication failed${contextLabel}: login response did not contain a token.`);
        this.updateStatus(false, { message: 'Login response invalid' });
        return false;
      } catch (error: any) {
        this.requestToken = null;
        console.error(`Authentication failed${contextLabel}: ${error.message}`);
        this.updateStatus(false, error);
        return false;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  async heartbeat(): Promise<void> {
    try {
      await this.fetchLapi('/v1/heartbeat');
      this.updateStatus(true);
    } catch (error: any) {
      this.updateStatus(false, error);
      throw error;
    }
  }

  async sendUsageMetrics(): Promise<void> {
    const payload = {
      log_processors: [
        {
          version: this.version || '0.0.0',
          os: this.machineInfo.os,
          utc_startup_timestamp: this.startupTimestamp,
          metrics: [],
          feature_flags: [],
          datasources: {},
          hub_items: {},
        },
      ],
    };

    await this.fetchLapi('/v1/usage-metrics', {
      method: 'POST',
      body: payload,
    });
  }

  async fetchAlerts(
    since: string | null = null,
    until: string | null = null,
    filters: FetchAlertsFilters = {},
  ): Promise<unknown[]> {
    const sinceParam = since || this.lookbackPeriod;
    const normalizedOrigin = filters.origin?.trim();
    const isCapiOrigin = normalizedOrigin?.toUpperCase() === 'CAPI';
    const isListsOrigin = normalizedOrigin === 'lists';
    const includeCapi = filters.includeCapi ?? isCapiOrigin;
    const buildParams = (scope?: 'ip' | 'range'): URLSearchParams => {
      const relativeNow = Date.now();
      const relativeWindow = filters.relativeWindow;
      const resolvedSince = relativeWindow
        ? formatRelativeDuration(relativeNow - relativeWindow.startMs + relativeWindow.paddingMs, 'up')
        : sinceParam;
      const resolvedUntil = relativeWindow
        ? formatRelativeDuration(relativeNow - relativeWindow.endMs - relativeWindow.paddingMs, 'down')
        : until;
      const params = new URLSearchParams();
      params.append('since', resolvedSince);
      params.append('limit', '0');
      if (resolvedUntil) params.append('until', resolvedUntil);
      if (this.simulationsEnabled) params.append('simulated', 'true');
      if (filters.origin) params.append('origin', filters.origin);
      if (filters.scenario) params.append('scenario', filters.scenario);
      params.append('include_capi', String(includeCapi));
      if (scope) params.append('scope', scope);
      return params;
    };

    const singleScopeOnly = filters.singleScopeOnly ?? (isCapiOrigin || isListsOrigin);
    const scopes: Array<'ip' | 'range' | undefined> = singleScopeOnly
      ? [undefined]
      : [undefined, 'ip', 'range'];
    const merged = new Map<string, unknown>();
    let successfulScopes = 0;
    let lastError: Error | null = null;
    for (const scope of scopes) {
      const scopeLabel = scope || 'unscoped';
      try {
        const response = await this.fetchLapi<unknown[]>(`/v1/alerts?${buildParams(scope).toString()}`);
        successfulScopes += 1;
        const resultSet = Array.isArray(response.data) ? response.data : [];
        for (const alert of resultSet) {
          const id = typeof alert === 'object' && alert !== null && 'id' in alert ? String(alert.id) : null;
          if (!id) continue;
          merged.set(id, alert);
        }
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`Failed to fetch ${scopeLabel} alerts: ${error.message}`);
      }
    }

    if (successfulScopes === 0) {
      throw lastError || new Error('Failed to fetch alerts');
    }

    if (filters.requireAllScopes && successfulScopes !== scopes.length) {
      throw lastError || new Error('Failed to fetch all alert scopes');
    }

    return Array.from(merged.values());
  }

  async getAlertById(alertId: string | number): Promise<unknown> {
    const response = await this.fetchLapi(`/v1/alerts/${alertId}`);
    return response.data;
  }

  async addDecision(ip: string, type: string, duration: string, reason = 'Manual decision from Web UI'): Promise<unknown> {
    const now = new Date().toISOString();
    const payload = [
      {
        scenario: 'manual/web-ui',
        campaign_name: 'manual/web-ui',
        message: `Manual decision from Web UI: ${reason}`,
        events_count: 1,
        start_at: now,
        stop_at: now,
        capacity: 0,
        leakspeed: '0',
        simulated: false,
        events: [],
        scenario_hash: '',
        scenario_version: '',
        source: {
          scope: 'ip',
          value: ip,
        },
        decisions: [
          {
            type,
            duration,
            value: ip,
            origin: 'cscli',
            scenario: 'manual/web-ui',
            scope: 'ip',
          },
        ],
      },
    ];

    const response = await this.fetchLapi('/v1/alerts', {
      method: 'POST',
      body: payload,
    });

    return response.data;
  }

  async deleteDecision(decisionId: string | number): Promise<unknown> {
    const response = await this.fetchLapi(`/v1/decisions/${decisionId}`, { method: 'DELETE' });
    return response.data;
  }

  async deleteAlert(alertId: string | number): Promise<unknown> {
    const response = await this.fetchLapi(`/v1/alerts/${alertId}`, { method: 'DELETE' });
    return response.data;
  }
}
