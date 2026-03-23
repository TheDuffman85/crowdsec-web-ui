import { describe, expect, test } from 'bun:test';
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
    });

    expect(config.port).toBe(4000);
    expect(config.basePath).toBe('/crowdsec');
    expect(config.alertOrigins).toEqual(['crowdsec', 'cscli']);
    expect(config.alertExtraScenarios).toEqual(['manual/web-ui']);
    expect(config.simulationsEnabled).toBe(false);
    expect(config.lookbackMs).toBe(172_800_000);
    expect(config.refreshIntervalMs).toBe(5_000);
    expect(config.bootstrapRetryEnabled).toBe(false);
    expect(config.dockerImageRef).toBe('example/repo');
    expect(config.updateCheckEnabled).toBe(true);
    expect(config.dbDir).toBe('/tmp/app');
  });

  test('createRuntimeConfig disables simulations by default', () => {
    const config = createRuntimeConfig({});
    expect(config.alertOrigins).toEqual([]);
    expect(config.alertExtraScenarios).toEqual([]);
    expect(config.simulationsEnabled).toBe(false);
  });
});
