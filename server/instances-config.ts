import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { CrowdsecAuthConfig } from './auth';

export interface EndpointTlsConfig {
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}

export type PrometheusAuthConfig =
  | { type: 'none' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };

export interface PrometheusEndpointConfig {
  id: string;
  name: string;
  url: string;
  auth: PrometheusAuthConfig;
  tls: EndpointTlsConfig;
  requestTimeoutMs?: number;
}

export interface InstanceSyncOverrides {
  lookbackPeriod?: string;
  refreshIntervalMs?: number;
  idleRefreshIntervalMs?: number;
  idleThresholdMs?: number;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  alertSyncChunkMs?: number;
  alertSyncMinChunkMs?: number;
  reconcileWindowMs?: number;
  reconcileRecentAgeMs?: number;
  reconcileRecentIntervalMs?: number;
  reconcileActiveIntervalMs?: number;
  reconcileOldIntervalMs?: number;
  reconcileWindowsPerRefresh?: number;
  bootstrapRetryDelayMs?: number;
  bootstrapRetryEnabled?: boolean;
  bouncerPropagationDelayMs?: number;
}

export interface CrowdsecInstanceConfig {
  id: string;
  name: string;
  icon?: string;
  lapiUrl: string;
  lapiAuth: CrowdsecAuthConfig;
  lapiTls: EndpointTlsConfig;
  prometheus: PrometheusEndpointConfig[];
  sync: InstanceSyncOverrides;
}

type UnknownRecord = Record<string, unknown>;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Configuration error: ${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function knownKeys(input: UnknownRecord, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Configuration error: unknown ${label} setting(s): ${unknown.join(', ')}.`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Configuration error: ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalIcon(value: unknown, label: string): string | undefined {
  const icon = optionalString(value, label);
  if (!icon) return undefined;
  if (Array.from(icon).length > 8 || /[\p{Cc}\p{Cs}\r\n]/u.test(icon)) {
    throw new Error(`Configuration error: ${label} must be a short text or emoji icon without control characters.`);
  }
  return icon;
}

function endpointId(value: unknown, label: string): string {
  const id = string(value, label);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Configuration error: ${label} must match ${ID_PATTERN}.`);
  }
  return id;
}

function endpointUrl(value: unknown, label: string, options: { allowPath: boolean }): string {
  const raw = string(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Configuration error: ${label} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Configuration error: ${label} must be an HTTP(S) URL without credentials or a fragment.`);
  }
  if (!options.allowPath && parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`Configuration error: ${label} must be a LAPI base URL without a path.`);
  }
  return raw.replace(/\/$/, '');
}

function readableFile(value: unknown, label: string): string | undefined {
  const file = optionalString(value, label);
  if (!file) return undefined;
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: ${label} is not readable at "${file}": ${message}`);
  }
  return file;
}

function secret(
  value: unknown,
  env: NodeJS.ProcessEnv,
  label: string,
): string {
  if (typeof value === 'string') {
    if (value.length === 0) throw new Error(`Configuration error: ${label} must be a non-empty string.`);
    return value;
  }
  const reference = record(value, label);
  knownKeys(reference, ['env', 'file'], label);
  const envKey = optionalString(reference.env, `${label}.env`);
  const file = optionalString(reference.file, `${label}.file`);
  if ((envKey ? 1 : 0) + (file ? 1 : 0) !== 1) {
    throw new Error(`Configuration error: ${label} must set exactly one of env or file.`);
  }
  if (envKey) {
    const value = env[envKey];
    if (!value) throw new Error(`Configuration error: ${label}.env references missing or empty ${envKey}.`);
    return value;
  }
  const readable = readableFile(file, `${label}.file`)!;
  return fs.readFileSync(readable, 'utf8').replace(/[\r\n]+$/g, '');
}

function parseTls(value: unknown, label: string): EndpointTlsConfig {
  if (value === undefined) return {};
  const input = record(value, label);
  if ('insecureSkipVerify' in input) {
    throw new Error(`Configuration error: ${label}.insecureSkipVerify is not supported; configure caFile instead.`);
  }
  const tls = {
    caFile: readableFile(input.caFile, `${label}.caFile`),
    certFile: readableFile(input.certFile, `${label}.certFile`),
    keyFile: readableFile(input.keyFile, `${label}.keyFile`),
  };
  if (Boolean(tls.certFile) !== Boolean(tls.keyFile)) {
    throw new Error(`Configuration error: ${label} requires both certFile and keyFile.`);
  }
  return tls;
}

function parseLapiAuth(value: unknown, env: NodeJS.ProcessEnv, label: string): { auth: CrowdsecAuthConfig; tlsClient: EndpointTlsConfig } {
  const input = record(value, label);
  const type = string(input.type, `${label}.type`);
  if (type === 'none') {
    knownKeys(input, ['type'], label);
    return { auth: { mode: 'none' }, tlsClient: {} };
  }
  if (type === 'password') {
    knownKeys(input, ['type', 'username', 'password'], label);
    return {
      auth: {
        mode: 'password',
        user: string(input.username, `${label}.username`),
        password: secret(input.password, env, `${label}.password`),
      },
      tlsClient: {},
    };
  }
  if (type === 'mtls') {
    knownKeys(input, ['type', 'certFile', 'keyFile'], label);
    const certPath = readableFile(input.certFile, `${label}.certFile`);
    const keyPath = readableFile(input.keyFile, `${label}.keyFile`);
    if (!certPath || !keyPath) throw new Error(`Configuration error: ${label} requires certFile and keyFile.`);
    return { auth: { mode: 'mtls', certPath, keyPath }, tlsClient: { certFile: certPath, keyFile: keyPath } };
  }
  throw new Error(`Configuration error: ${label}.type must be none, password, or mtls.`);
}

function parsePrometheusAuth(value: unknown, env: NodeJS.ProcessEnv, label: string): PrometheusAuthConfig {
  if (value === undefined) return { type: 'none' };
  const input = record(value, label);
  const type = string(input.type, `${label}.type`);
  if (type === 'none') {
    knownKeys(input, ['type'], label);
    return { type: 'none' };
  }
  if (type === 'basic') {
    knownKeys(input, ['type', 'username', 'password'], label);
    return {
      type: 'basic',
      username: string(input.username, `${label}.username`),
      password: secret(input.password, env, `${label}.password`),
    };
  }
  if (type === 'bearer') {
    knownKeys(input, ['type', 'token'], label);
    return { type: 'bearer', token: secret(input.token, env, `${label}.token`) };
  }
  throw new Error(`Configuration error: ${label}.type must be none, basic, or bearer.`);
}

function parseDuration(value: unknown, label: string, allowZero = false): number | undefined {
  if (value === undefined) return undefined;
  const raw = string(value, label).toLowerCase();
  if (allowZero && (raw === '0' || raw === 'manual')) return 0;
  const match = raw.match(/^(\d+)(ms|[smhd])$/);
  if (!match) throw new Error(`Configuration error: ${label} must be a duration such as 30s, 5m, or 12h.`);
  const valueNumber = Number(match[1]);
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  const result = valueNumber * multiplier;
  if (!allowZero && result <= 0) throw new Error(`Configuration error: ${label} must be greater than zero.`);
  return result;
}

function parseSync(value: unknown, label: string): InstanceSyncOverrides {
  if (value === undefined) return {};
  const input = record(value, label);
  const integer = (key: string): number | undefined => {
    if (input[key] === undefined) return undefined;
    const parsed = Number(input[key]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Configuration error: ${label}.${key} must be a positive integer.`);
    return parsed;
  };
  const boolean = (key: string): boolean | undefined => {
    if (input[key] === undefined) return undefined;
    if (typeof input[key] !== 'boolean') throw new Error(`Configuration error: ${label}.${key} must be a boolean.`);
    return input[key] as boolean;
  };
  return {
    lookbackPeriod: optionalString(input.lookback, `${label}.lookback`),
    refreshIntervalMs: parseDuration(input.refreshInterval, `${label}.refreshInterval`, true),
    idleRefreshIntervalMs: parseDuration(input.idleRefreshInterval, `${label}.idleRefreshInterval`, true),
    idleThresholdMs: parseDuration(input.idleThreshold, `${label}.idleThreshold`, true),
    requestTimeoutMs: parseDuration(input.requestTimeout, `${label}.requestTimeout`),
    heartbeatIntervalMs: parseDuration(input.heartbeatInterval, `${label}.heartbeatInterval`, true),
    alertSyncChunkMs: parseDuration(input.alertSyncChunk, `${label}.alertSyncChunk`),
    alertSyncMinChunkMs: parseDuration(input.alertSyncMinChunk, `${label}.alertSyncMinChunk`),
    reconcileWindowMs: parseDuration(input.reconcileWindow, `${label}.reconcileWindow`),
    reconcileRecentAgeMs: parseDuration(input.reconcileRecentAge, `${label}.reconcileRecentAge`),
    reconcileRecentIntervalMs: parseDuration(input.reconcileRecentInterval, `${label}.reconcileRecentInterval`),
    reconcileActiveIntervalMs: parseDuration(input.reconcileActiveInterval, `${label}.reconcileActiveInterval`),
    reconcileOldIntervalMs: parseDuration(input.reconcileOldInterval, `${label}.reconcileOldInterval`),
    reconcileWindowsPerRefresh: integer('reconcileWindowsPerRefresh'),
    bootstrapRetryDelayMs: parseDuration(input.bootstrapRetryDelay, `${label}.bootstrapRetryDelay`),
    bootstrapRetryEnabled: boolean('bootstrapRetryEnabled'),
    bouncerPropagationDelayMs: parseDuration(input.bouncerPropagationDelay, `${label}.bouncerPropagationDelay`, true),
  };
}

export function parseInstancesConfig(parsed: unknown, env: NodeJS.ProcessEnv): CrowdsecInstanceConfig[] {
  const root = record(parsed, 'instances config');
  if (!Array.isArray(root.instances) || root.instances.length === 0) {
    throw new Error('Configuration error: instances must contain at least one entry.');
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  return root.instances.map((raw, instanceIndex) => {
    const label = `instances[${instanceIndex}]`;
    const input = record(raw, label);
    const id = endpointId(input.id, `${label}.id`);
    const name = string(input.name, `${label}.name`);
    if (ids.has(id)) throw new Error(`Configuration error: duplicate instance id "${id}".`);
    if (names.has(name.toLocaleLowerCase())) throw new Error(`Configuration error: duplicate instance name "${name}".`);
    ids.add(id);
    names.add(name.toLocaleLowerCase());
    const lapi = record(input.lapi, `${label}.lapi`);
    const lapiAuth = parseLapiAuth(lapi.auth, env, `${label}.lapi.auth`);
    const tls = parseTls(lapi.tls, `${label}.lapi.tls`);
    if (tls.certFile || tls.keyFile) {
      throw new Error(`Configuration error: ${label}.lapi.tls only configures server trust with caFile; put the client certificate pair in lapi.auth with type mtls.`);
    }
    const lapiTls = { ...tls, ...lapiAuth.tlsClient };
    if (input.prometheus !== undefined) {
      throw new Error(`Configuration error: ${label}.prometheus has been renamed to ${label}.metrics.`);
    }
    const prometheusInput = input.metrics === undefined ? [] : input.metrics;
    if (!Array.isArray(prometheusInput)) throw new Error(`Configuration error: ${label}.metrics must be an array.`);
    const prometheusIds = new Set<string>();
    const prometheus = prometheusInput.map((rawEndpoint, endpointIndex): PrometheusEndpointConfig => {
      const endpointLabel = `${label}.metrics[${endpointIndex}]`;
      const endpoint = record(rawEndpoint, endpointLabel);
      const endpointIdValue = endpointId(endpoint.id, `${endpointLabel}.id`);
      if (prometheusIds.has(endpointIdValue)) throw new Error(`Configuration error: duplicate Prometheus id "${endpointIdValue}" in ${id}.`);
      prometheusIds.add(endpointIdValue);
      return {
        id: endpointIdValue,
        name: string(endpoint.name, `${endpointLabel}.name`),
        url: endpointUrl(endpoint.url, `${endpointLabel}.url`, { allowPath: true }),
        auth: parsePrometheusAuth(endpoint.auth, env, `${endpointLabel}.auth`),
        tls: parseTls(endpoint.tls, `${endpointLabel}.tls`),
        requestTimeoutMs: parseDuration(endpoint.requestTimeout, `${endpointLabel}.requestTimeout`),
      };
    });
    return {
      id,
      name,
      icon: optionalIcon(input.icon, `${label}.icon`),
      lapiUrl: endpointUrl(lapi.url, `${label}.lapi.url`, { allowPath: false }),
      lapiAuth: lapiAuth.auth,
      lapiTls,
      prometheus,
      sync: parseSync(input.sync, `${label}.sync`),
    };
  });
}

export function loadInstancesConfig(file: string, env: NodeJS.ProcessEnv): CrowdsecInstanceConfig[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to read CROWDSEC_INSTANCES_CONFIG_FILE at "${file}": ${message}`);
  }
  return parseInstancesConfig(parsed, env);
}

export function hasLegacyConnectionEnvironment(env: NodeJS.ProcessEnv): string[] {
  return [
    'CROWDSEC_URL', 'CROWDSEC_USER', 'CROWDSEC_PASSWORD', 'CROWDSEC_PASSWORD_FILE',
    'CROWDSEC_TLS_CERT_PATH', 'CROWDSEC_TLS_KEY_PATH', 'CROWDSEC_TLS_CA_CERT_PATH',
    'CROWDSEC_PROMETHEUS_URL',
  ].filter((key) => Object.prototype.hasOwnProperty.call(env, key));
}
