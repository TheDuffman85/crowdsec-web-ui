import { readFileSync } from 'node:fs';

function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

export function resolveSecretEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fileName = `${name}_FILE`;
  const hasDirect = hasEnv(env, name);
  const hasFile = hasEnv(env, fileName);

  if (hasDirect && hasFile) {
    throw new Error(`Configuration error: both ${name} and ${fileName} are set. Set only one.`);
  }

  if (hasDirect) {
    return env[name];
  }

  if (!hasFile) {
    return undefined;
  }

  const filePath = env[fileName];
  if (!filePath) {
    throw new Error(`Configuration error: ${fileName} is set but empty.`);
  }

  try {
    return readFileSync(filePath, 'utf8').replace(/[\r\n]+$/g, '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to read ${fileName} at "${filePath}": ${message}`);
  }
}
