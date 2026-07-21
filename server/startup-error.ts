import { ConfigurationLoadError } from './config-error';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = String(error);
  return message === '[object Object]' ? 'An unknown startup error occurred.' : message;
}

export function formatStartupError(error: unknown): string {
  if (error instanceof ConfigurationLoadError) {
    const lines = [
      'CrowdSec Web UI could not start because the configuration is invalid.',
      `  Problem: ${error.message}`,
      `  Configuration file: ${error.configFile}`,
    ];
    if (error.overrideNames.length > 0) {
      lines.push(`  CONFIG_ override${error.overrideNames.length === 1 ? '' : 's'}: ${error.overrideNames.join(', ')}`);
    }
    lines.push('Correct the configuration and restart CrowdSec Web UI.');
    return lines.join('\n');
  }

  return [
    'CrowdSec Web UI could not start.',
    `  Problem: ${errorMessage(error)}`,
    'Check the configuration and preceding log messages, then restart CrowdSec Web UI.',
  ].join('\n');
}
