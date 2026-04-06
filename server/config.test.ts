import { describe, expect, test } from 'vitest';
import { createRuntimeConfig, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseRefreshInterval } from './config';

describe('config helpers', () => {
  test('parseRefreshInterval handles supported inputs', () => {
    expect(parseRefreshInterval('manual')).toBe(0);
    expect(parseRefreshInterval('0')).toBe(0);
    expect(parseRefreshInterval('5s')).toBe(5_000);
    expect(parseRefreshInterval('30s')).toBe(30_000);
    expect(parseRefreshInterval('1m')).toBe(60_000);
    expect(parseRefreshInterval('5m')).toBe(300_000);
    expect(parseRefreshInterval('2h')).toBe(7_200_000);
    expect(parseRefreshInterval('1d')).toBe(86_400_000);
    expect(parseRefreshInterval('invalid')).toBe(0);
  });

  test('parseLookbackToMs uses sane defaults', () => {
    expect(parseLookbackToMs(undefined)).toBe(604_800_000);
    expect(parseLookbackToMs('5d')).toBe(432_000_000);
    expect(parseLookbackToMs('12h')).toBe(43_200_000);
    expect(parseLookbackToMs('15m')).toBe(900_000);
  });

  test('parseBooleanEnv supports common truthy and falsy forms', () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv('yes')).toBe(true);
    expect(parseBooleanEnv('On')).toBe(true);
    expect(parseBooleanEnv('0', true)).toBe(false);
    expect(parseBooleanEnv('maybe', true)).toBe(true);
  });

  test('parseCsvEnv splits, trims, and drops empty entries', () => {
    expect(parseCsvEnv(undefined)).toEqual([]);
    expect(parseCsvEnv(' crowdsec , manual/web-ui ,, cscli ')).toEqual(['crowdsec', 'manual/web-ui', 'cscli']);
  });

  test('getIntervalName formats known intervals', () => {
    expect(getIntervalName(0)).toBe('Off');
    expect(getIntervalName(30_000)).toBe('30s');
    expect(getIntervalName(12_345)).toBe('12345ms');
  });

  test('createRuntimeConfig reads relevant environment values', () => {
    const config = createRuntimeConfig({
      PORT: '4000',
      BASE_PATH: '/crowdsec/',
      CROWDSEC_URL: 'http://localhost:8080',
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_ALERT_ORIGINS: 'crowdsec, cscli',
      CROWDSEC_ALERT_EXTRA_SCENARIOS: 'manual/web-ui',
      CROWDSEC_SIMULATIONS_ENABLED: 'false',
      CROWDSEC_ALWAYS_SHOW_MACHINE: 'true',
      CROWDSEC_LOOKBACK_PERIOD: '2d',
      CROWDSEC_REFRESH_INTERVAL: '5s',
      CROWDSEC_IDLE_REFRESH_INTERVAL: '1m',
      CROWDSEC_IDLE_THRESHOLD: '30s',
      CROWDSEC_FULL_REFRESH_INTERVAL: '5m',
      CROWDSEC_BOOTSTRAP_RETRY_DELAY: '1m',
      CROWDSEC_BOOTSTRAP_RETRY_ENABLED: 'false',
      DOCKER_IMAGE_REF: 'Example/Repo',
      VITE_VERSION: '1.2.3',
      VITE_BRANCH: 'dev',
      VITE_COMMIT_HASH: 'abc123',
      DB_DIR: '/tmp/app',
      NOTIFICATION_SECRET_KEY: 'notif-secret',
      NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
    });

    expect(config.port).toBe(4000);
    expect(config.basePath).toBe('/crowdsec');
    expect(config.crowdsecAuthMode).toBe('password');
    expect(config.crowdsecAuth).toEqual({ mode: 'password', user: 'watcher', password: 'secret' });
    expect(config.alertOrigins).toEqual(['crowdsec', 'cscli']);
    expect(config.alertExtraScenarios).toEqual(['manual/web-ui']);
    expect(config.simulationsEnabled).toBe(false);
    expect(config.alwaysShowMachine).toBe(true);
    expect(config.lookbackMs).toBe(172_800_000);
    expect(config.refreshIntervalMs).toBe(5_000);
    expect(config.bootstrapRetryEnabled).toBe(false);
    expect(config.dockerImageRef).toBe('example/repo');
    expect(config.updateCheckEnabled).toBe(true);
    expect(config.dbDir).toBe('/tmp/app');
    expect(config.notificationSecretKey).toBe('notif-secret');
    expect(config.notificationAllowPrivateAddresses).toBe(true);
  });

  test('createRuntimeConfig disables simulations by default', () => {
    const config = createRuntimeConfig({});
    expect(config.crowdsecAuthMode).toBe('none');
    expect(config.crowdsecAuth).toEqual({ mode: 'none' });
    expect(config.alertOrigins).toEqual([]);
    expect(config.alertExtraScenarios).toEqual([]);
    expect(config.simulationsEnabled).toBe(false);
    expect(config.alwaysShowMachine).toBe(false);
    expect(config.notificationSecretKey).toBeUndefined();
    expect(config.notificationAllowPrivateAddresses).toBe(true);
  });

  test('createRuntimeConfig supports mTLS authentication', () => {
    const config = createRuntimeConfig({
      CROWDSEC_URL: 'https://localhost:8080',
      CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
      CROWDSEC_TLS_KEY_PATH: '/certs/agent-key.pem',
      CROWDSEC_TLS_CA_CERT_PATH: '/certs/ca.pem',
    });

    expect(config.crowdsecAuthMode).toBe('mtls');
    expect(config.crowdsecAuth).toEqual({
      mode: 'mtls',
      certPath: '/certs/agent.pem',
      keyPath: '/certs/agent-key.pem',
      caCertPath: '/certs/ca.pem',
    });
    expect(config.crowdsecTlsCertPath).toBe('/certs/agent.pem');
    expect(config.crowdsecTlsKeyPath).toBe('/certs/agent-key.pem');
    expect(config.crowdsecTlsCaCertPath).toBe('/certs/ca.pem');
  });

  test('createRuntimeConfig rejects mixed password and mTLS authentication', () => {
    expect(() => createRuntimeConfig({
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
      CROWDSEC_TLS_KEY_PATH: '/certs/agent-key.pem',
    })).toThrow(/choose either CROWDSEC_USER\/CROWDSEC_PASSWORD or CROWDSEC_TLS_CERT_PATH\/CROWDSEC_TLS_KEY_PATH/i);
  });

  test('createRuntimeConfig rejects partial mTLS authentication', () => {
    expect(() => createRuntimeConfig({
      CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
    })).toThrow(/CrowdSec mTLS authentication requires both CROWDSEC_TLS_CERT_PATH and CROWDSEC_TLS_KEY_PATH/i);

    expect(() => createRuntimeConfig({
      CROWDSEC_TLS_CA_CERT_PATH: '/certs/ca.pem',
    })).toThrow(/CrowdSec mTLS authentication requires both CROWDSEC_TLS_CERT_PATH and CROWDSEC_TLS_KEY_PATH/i);
  });
});
