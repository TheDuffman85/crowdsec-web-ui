import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageName = 'better-sqlite3';

function verifyNativeModule() {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const Database = require(${JSON.stringify(packageName)}); const database = new Database(':memory:'); database.prepare('select 1').get(); database.close();`,
    ],
    {
      encoding: 'utf8',
      env: process.env,
    },
  );

  if (result.error) {
    return result.error;
  }

  if (result.status === 0) {
    return null;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const error = new Error(output || `${packageName} verification failed.`);
  error.code = result.signal ? `SIGNAL_${result.signal}` : `EXIT_${result.status ?? 'UNKNOWN'}`;
  return error;
}

function isAbiMismatch(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = 'code' in error ? error.code : undefined;
  return (
    error.message.includes('compiled against a different Node.js version') ||
    error.message.includes('NODE_MODULE_VERSION') ||
    error.message.includes('Could not locate the bindings file') ||
    error.message.includes('did not self-register') ||
    errorCode === 'ERR_DLOPEN_FAILED'
  );
}

function resolveNativeBuildEnv() {
  const currentNodeDir = path.dirname(process.execPath);
  const currentNodeRoot = path.resolve(currentNodeDir, '..');
  const tempRoot = path.join(os.tmpdir(), 'crowdsec-web-ui-native-deps');
  const env = {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_HOME: process.env.COREPACK_HOME || path.join(os.tmpdir(), 'corepack'),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || tempRoot,
    PREBUILD_INSTALL_CACHE: process.env.PREBUILD_INSTALL_CACHE || path.join(tempRoot, 'prebuild-install'),
    npm_config_cache: process.env.npm_config_cache || path.join(tempRoot, 'npm-cache'),
    npm_config_devdir: process.env.npm_config_devdir || path.join(tempRoot, 'node-gyp'),
    npm_config_nodedir: process.env.npm_config_nodedir || currentNodeRoot,
    PATH: [currentNodeDir, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
  };

  for (const directory of [
    env.COREPACK_HOME,
    env.XDG_CACHE_HOME,
    env.PREBUILD_INSTALL_CACHE,
    env.npm_config_cache,
    env.npm_config_devdir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  if (!existsSync(path.join(currentNodeRoot, 'include', 'node', 'node.h'))) {
    delete env.npm_config_nodedir;
  }

  return env;
}

function runRebuildCommand(env) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, 'rebuild', packageName], {
      stdio: 'inherit',
      env,
    });
  }

  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return spawnSync(packageManager, ['rebuild', packageName], {
    stdio: 'inherit',
    env,
  });
}

function resolvePackageDirectory() {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function runBuildRelease(env) {
  const packageManager = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(packageManager, ['run', 'build-release'], {
    cwd: resolvePackageDirectory(),
    stdio: 'inherit',
    env,
  });
}

const loadError = verifyNativeModule();
if (!loadError) {
  process.exit(0);
}

if (!isAbiMismatch(loadError)) {
  throw loadError;
}

console.warn(
  `[native-deps] Rebuilding ${packageName} for Node ${process.version} (ABI ${process.versions.modules})...`,
);

const env = resolveNativeBuildEnv();
const rebuildResult = runRebuildCommand(env);
if (rebuildResult.error) {
  throw rebuildResult.error;
}

const postRebuildError = verifyNativeModule();
if (!postRebuildError) {
  console.warn(`[native-deps] ${packageName} is ready for Node ${process.version}.`);
  process.exit(0);
}

console.warn(`[native-deps] Trying local source build for ${packageName}...`);

const buildReleaseResult = runBuildRelease(env);
if (buildReleaseResult.error) {
  throw buildReleaseResult.error;
}

const postBuildReleaseError = verifyNativeModule();
if (postBuildReleaseError) {
  throw postBuildReleaseError;
}

console.warn(`[native-deps] ${packageName} is ready for Node ${process.version}.`);
