import { execFile } from 'node:child_process';

/*
 * Runs a small, fixed set of cscli hub operations on the machine that hosts
 * CrowdSec. The Web UI never builds a shell command: it sends one "verb line"
 * (for example `install scenarios crowdsecurity/ssh-bf`) that scripts/hub-exec.sh
 * validates again on the CrowdSec side before it calls cscli. The executor is
 * off unless HUB_EXECUTOR is set.
 */

export const HUB_ITEM_TYPES = ['scenarios', 'collections', 'parsers', 'postoverflows'] as const;
export type HubItemType = (typeof HUB_ITEM_TYPES)[number];

export type HubOperation =
  | { action: 'list' }
  | { action: 'update' }
  | { action: 'upgrade-all' }
  | { action: 'reload' }
  | { action: 'install' | 'remove' | 'upgrade'; type: HubItemType; name: string };

export type HubExecutorConfig =
  | { transport: 'disabled' }
  | { transport: 'ssh'; host: string; user: string; port: number; keyFile: string; knownHostsFile: string; timeoutMs: number; instance?: string }
  | { transport: 'command'; command: string[]; timeoutMs: number; instance?: string };

export interface HubRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HubRunner = (file: string, args: string[], options: { timeoutMs: number; maxBuffer: number }) => Promise<HubRunResult>;

export interface HubExecutor {
  readonly config: HubExecutorConfig;
  readonly enabled: boolean;
  run(operation: HubOperation): Promise<HubRunResult>;
}

const HUB_NAME = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/i;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function isHubItemType(value: unknown): value is HubItemType {
  return typeof value === 'string' && (HUB_ITEM_TYPES as readonly string[]).includes(value);
}

export function isValidHubName(value: unknown): value is string {
  return typeof value === 'string' && HUB_NAME.test(value) && !value.includes('..');
}

/** The single line sent to the executor, or null when the operation is not allowed. */
export function buildVerb(operation: HubOperation): string | null {
  switch (operation.action) {
    case 'list': return 'hub-list';
    case 'update': return 'hub-update';
    case 'upgrade-all': return 'upgrade-all';
    case 'reload': return 'reload';
    case 'install':
    case 'remove':
    case 'upgrade':
      return isHubItemType(operation.type) && isValidHubName(operation.name) ? `${operation.action} ${operation.type} ${operation.name}` : null;
    default: return null;
  }
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** Reads HUB_EXECUTOR and its settings. An invalid setting disables the executor and says why. */
export function parseHubExecutorConfig(env: NodeJS.ProcessEnv): { config: HubExecutorConfig; error?: string } {
  const mode = (env.HUB_EXECUTOR ?? 'disabled').trim().toLowerCase();
  const timeoutMs = positiveInt(env.HUB_EXEC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 600_000);
  const instance = env.HUB_EXECUTOR_INSTANCE?.trim() || undefined;
  if (mode === '' || mode === 'disabled' || mode === 'off' || mode === 'false') return { config: { transport: 'disabled' } };
  if (mode === 'ssh') {
    const host = env.HUB_SSH_HOST?.trim();
    const keyFile = env.HUB_SSH_KEY_FILE?.trim();
    const knownHostsFile = env.HUB_SSH_KNOWN_HOSTS_FILE?.trim();
    if (!host || !keyFile || !knownHostsFile) {
      return { config: { transport: 'disabled' }, error: 'HUB_EXECUTOR=ssh needs HUB_SSH_HOST, HUB_SSH_KEY_FILE and HUB_SSH_KNOWN_HOSTS_FILE' };
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(host)) return { config: { transport: 'disabled' }, error: 'HUB_SSH_HOST is not a valid host name' };
    const user = env.HUB_SSH_USER?.trim() || 'root';
    if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) return { config: { transport: 'disabled' }, error: 'HUB_SSH_USER is not a valid user name' };
    return { config: { transport: 'ssh', host, user, port: positiveInt(env.HUB_SSH_PORT, 22, 65535), keyFile, knownHostsFile, timeoutMs, instance } };
  }
  if (mode === 'command') {
    const command = (env.HUB_EXEC_COMMAND ?? '').trim().split(/\s+/).filter(Boolean);
    if (command.length === 0) return { config: { transport: 'disabled' }, error: 'HUB_EXECUTOR=command needs HUB_EXEC_COMMAND' };
    return { config: { transport: 'command', command, timeoutMs, instance } };
  }
  return { config: { transport: 'disabled' }, error: `Unknown HUB_EXECUTOR value "${mode}"` };
}

const defaultRunner: HubRunner = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, { timeout: options.timeoutMs, maxBuffer: options.maxBuffer, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    if (!error) return resolve({ code: 0, stdout, stderr });
    const failure = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
    const code = typeof failure.code === 'number' ? failure.code : 255;
    const note = failure.killed ? 'The command timed out' : typeof failure.code === 'string' ? `Could not run ${file}: ${failure.code}` : '';
    resolve({ code, stdout: stdout ?? '', stderr: [stderr ?? '', note].filter(Boolean).join('\n') });
  });
});

/** Operations run one at a time, because cscli does not expect two hub changes at once. */
export function createHubExecutor(config: HubExecutorConfig, runner: HubRunner = defaultRunner): HubExecutor {
  let queue: Promise<unknown> = Promise.resolve();

  const invocation = (verb: string): { file: string; args: string[]; timeoutMs: number } => {
    if (config.transport === 'ssh') {
      return {
        file: 'ssh',
        timeoutMs: config.timeoutMs,
        args: [
          '-i', config.keyFile, '-p', String(config.port),
          '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
          '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
          `${config.user}@${config.host}`, verb,
        ],
      };
    }
    if (config.transport === 'command') {
      return { file: config.command[0]!, args: [...config.command.slice(1), ...verb.split(' ')], timeoutMs: config.timeoutMs };
    }
    throw new Error('The hub executor is not configured');
  };

  return {
    config,
    enabled: config.transport !== 'disabled',
    run(operation) {
      const verb = buildVerb(operation);
      if (!verb) return Promise.reject(new Error('This hub operation is not allowed'));
      const next = queue.then(() => {
        const call = invocation(verb);
        return runner(call.file, call.args, { timeoutMs: call.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES });
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
