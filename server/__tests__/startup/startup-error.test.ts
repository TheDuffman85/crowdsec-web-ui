import { describe, expect, test } from 'vitest';
import { ConfigurationLoadError } from '../../config-error';
import { formatStartupError } from '../../startup-error';

describe('startup error formatting', () => {
  test('formats configuration failures without exposing an exception or stack trace', () => {
    const cause = new Error('Configuration error: instances[2].lapi.url must be a non-empty string.');
    const error = new ConfigurationLoadError(cause, {
      configFile: '/app/data/config.yaml',
      overrideNames: ['CONFIG_INSTANCES_2_LAPI_URL'],
    });

    const message = formatStartupError(error);

    expect(message).toContain('could not start because the configuration is invalid');
    expect(message).toContain('Problem: instances[2].lapi.url must be a non-empty string.');
    expect(message).toContain('Configuration file: /app/data/config.yaml');
    expect(message).toContain('CONFIG_ override: CONFIG_INSTANCES_2_LAPI_URL');
    expect(message).not.toContain('Configuration error:');
    expect(message).not.toContain('at ');
    expect(message).not.toContain(cause.stack);
  });

  test('formats non-configuration startup failures without rendering an Error object', () => {
    const message = formatStartupError(new Error('database is not writable'));

    expect(message).toContain('Problem: database is not writable');
    expect(message).not.toContain('Error:');
    expect(message).not.toContain('at ');
  });
});
