import type { AppliedConfigEnvironmentOverride } from './config-file';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripConfigurationPrefix(message: string): string {
  return message.replace(/^Configuration error:\s*/i, '').trim();
}

export class ConfigurationEnvironmentError extends Error {
  readonly overrideNames: string[];

  constructor(message: string, overrideNames: readonly string[]) {
    super(`Configuration error: ${message}`);
    this.name = 'ConfigurationEnvironmentError';
    this.overrideNames = [...new Set(overrideNames)].sort();
  }
}

export class ConfigurationLoadError extends Error {
  readonly configFile: string;
  readonly overrideNames: string[];

  constructor(
    error: unknown,
    options: {
      configFile: string;
      overrides?: readonly AppliedConfigEnvironmentOverride[];
      overrideNames?: readonly string[];
    },
  ) {
    const message = stripConfigurationPrefix(errorMessage(error));
    super(message, error instanceof Error ? { cause: error } : undefined);
    this.name = 'ConfigurationLoadError';
    this.configFile = options.configFile;
    this.overrideNames = [...new Set([
      ...(options.overrides || []).map((override) => override.name),
      ...(options.overrideNames || []),
    ])].sort();
  }
}

export function isConfigurationError(error: unknown): boolean {
  const message = errorMessage(error);
  return error instanceof ConfigurationLoadError
    || /^Configuration error:/i.test(message)
    || /^Invalid (?:TZ|TIME_FORMAT|AUTH_)/i.test(message)
    || /^CrowdSec (?:authentication is misconfigured|password authentication requires|mTLS authentication requires)/i.test(message);
}
