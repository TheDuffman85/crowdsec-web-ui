import type { LapiStatus } from '../../shared/contracts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
  user?: string;
  password?: string;
  simulationsEnabled?: boolean;
  lookbackPeriod: string;
  version: string;
  fetchImpl?: FetchLike;
}

export interface FetchAlertsFilters {
  origin?: string;
  scenario?: string;
}

export class LapiClient {
  private readonly crowdsecUrl: string;
  private readonly user?: string;
  private readonly password?: string;
  private readonly simulationsEnabled: boolean;
  private readonly version: string;
  private readonly fetchImpl: FetchLike;

  public readonly lookbackPeriod: string;
  private requestToken: string | null = null;
  private loginPromise: Promise<boolean> | null = null;
  private readonly lapiStatus: LapiStatus = {
    isConnected: false,
    lastCheck: null,
    lastError: null,
  };

  constructor(options: LapiClientOptions) {
    this.crowdsecUrl = options.crowdsecUrl;
    this.user = options.user;
    this.password = options.password;
    this.simulationsEnabled = options.simulationsEnabled ?? false;
    this.lookbackPeriod = options.lookbackPeriod;
    this.version = options.version;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  updateStatus(isConnected: boolean, error: { message?: string } | null = null): void {
    this.lapiStatus.isConnected = isConnected;
    this.lapiStatus.lastCheck = new Date().toISOString();
    this.lapiStatus.lastError = error?.message || null;
  }

  getStatus(): LapiStatus {
    return { ...this.lapiStatus };
  }

  hasCredentials(): boolean {
    return Boolean(this.user && this.password);
  }

  hasToken(): boolean {
    return Boolean(this.requestToken);
  }

  clearToken(): void {
    this.requestToken = null;
  }

  async fetchLapi<TData = unknown>(endpoint: string, options: FetchLapiOptions = {}, isRetry = false): Promise<FetchLapiResult<TData>> {
    const controller = new AbortController();
    const timeout = options.timeout || 30_000;
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
      });

      clearTimeout(timeoutId);

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
      clearTimeout(timeoutId);
      if (error?.name === 'AbortError') {
        const timeoutError = new Error('Request timeout') as Error & { code?: string };
        timeoutError.code = 'ETIMEDOUT';
        throw timeoutError;
      }
      throw error;
    }
  }

  async login(context = 'general'): Promise<boolean> {
    const contextLabel = context ? ` (${context})` : '';

    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
        const response = await this.fetchLapi<{ code?: number; token?: string }>('/v1/watchers/login', {
          method: 'POST',
          body: {
            machine_id: this.user,
            password: this.password,
            scenarios: ['manual/web-ui'],
          },
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

  async fetchAlerts(
    since: string | null = null,
    until: string | null = null,
    hasActiveDecision = false,
    filters: FetchAlertsFilters = {},
  ): Promise<unknown[]> {
    const sinceParam = since || this.lookbackPeriod;
    const params = new URLSearchParams();
    params.append('since', sinceParam);
    params.append('limit', '0');
    if (until) params.append('until', until);
    if (this.simulationsEnabled) params.append('simulated', 'true');
    if (hasActiveDecision) params.append('has_active_decision', 'true');
    if (filters.origin) params.append('origin', filters.origin);
    if (filters.scenario) params.append('scenario', filters.scenario);
    ['Ip', 'Range'].forEach((scope) => params.append('scope', scope));

    try {
      const response = await this.fetchLapi<unknown[]>(`/v1/alerts?${params.toString()}`);
      return Array.isArray(response.data) ? response.data : [];
    } catch (error: any) {
      console.error(`Failed to fetch alerts: ${error.message}`);
      return [];
    }
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
