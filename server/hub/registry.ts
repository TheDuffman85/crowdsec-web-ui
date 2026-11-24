import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CrowdsecDatabase } from '../database';
import { createHubExecutor, type HubExecutor, type HubExecutorConfig, type HubRunner } from './executor';
import { generateSshKeyPair, slugify } from './ssh-key';
import { HUB_KEY_COMMENT } from './install-script';

export type HubServerStatus = 'pending' | 'paired' | 'error';
export type HubServerSource = 'env' | 'pairing';
export type HubInstallMode = 'docker' | 'native';

export interface HubServerRecord {
  id: string;
  /** The CrowdSec machine (log processor) name, when the server was set up for one. */
  machine: string | null;
  instance_id: string | null;
  name: string;
  source: HubServerSource;
  transport: 'ssh' | 'command';
  host: string | null;
  port: number | null;
  ssh_user: string | null;
  key_ref: string | null;
  known_hosts_ref: string | null;
  host_key: string | null;
  public_key: string | null;
  command: string | null;
  mode: HubInstallMode | null;
  status: HubServerStatus;
  last_check_at: string | null;
  last_error: string | null;
  pending_reload: boolean;
  profile: string | null;
  apply_profile: boolean;
  /** Address the Web UI connects from, written into the server's authorized_keys line. */
  app_from: string | null;
  created_at: string;
  paired_at: string | null;
  paired_from: string | null;
}

export const ENV_SERVER_ID = 'env';
export const DEFAULT_PAIRING_TTL_MS = 15 * 60_000;
/** The install script can be fetched a few times (a failed download is retried), the pairing report only once. */
export const MAX_SCRIPT_DOWNLOADS = 5;

const ADDRESS = /^[A-Za-z0-9._:-]{1,253}$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]{20,2000}={0,2}$/;
const MACHINE_NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;

export class HubRegistryError extends Error {
  constructor(message: string, readonly code: string, readonly status: 400 | 404 | 409 | 410) {
    super(message);
  }
}

export interface PairingReport {
  address: string;
  port: number;
  user: string;
  mode: string;
  host_keys: string[];
}

export interface CreatePairingInput {
  machine: string;
  name?: string;
  instanceId: string | null;
  profile: string | null;
  applyProfile: boolean;
  appFrom: string | null;
  createdBy: string;
}

interface Row {
  id: string; machine: string | null; instance_id: string | null; name: string; source: string; transport: string;
  host: string | null; port: number | null; ssh_user: string | null; key_ref: string | null; known_hosts_ref: string | null;
  host_key: string | null; public_key: string | null; command: string | null; mode: string | null; status: string;
  last_check_at: string | null; last_error: string | null; pending_reload: number; profile: string | null; apply_profile: number; app_from: string | null;
  created_at: string; paired_at: string | null; paired_from: string | null;
}

function toRecord(row: Row): HubServerRecord {
  return {
    ...row,
    source: row.source === 'env' ? 'env' : 'pairing',
    transport: row.transport === 'command' ? 'command' : 'ssh',
    mode: row.mode === 'docker' || row.mode === 'native' ? row.mode : null,
    status: row.status === 'paired' || row.status === 'error' ? row.status : 'pending',
    pending_reload: row.pending_reload === 1,
    apply_profile: row.apply_profile === 1,
  };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** SHA256 fingerprint of the first pinned host key, in the form ssh prints it. */
export function hostKeyFingerprint(hostKey: string | null): string | null {
  const first = hostKey?.split('\n').find(Boolean)?.split(' ');
  if (!first || first.length < 2) return null;
  try {
    return `SHA256:${crypto.createHash('sha256').update(Buffer.from(first[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`;
  } catch {
    return null;
  }
}

export interface HubRegistryOptions {
  database: CrowdsecDatabase;
  /** Directory for private keys and pinned host keys. Created with mode 700. */
  keysDir: string;
  runner?: HubRunner;
  now?: () => number;
  pairingTtlMs?: number;
  execTimeoutMs?: number;
}

/**
 * The servers whose CrowdSec hub the Web UI may manage, one entry per machine. Entries come
 * from the HUB_* environment variables (kept working as before) or from the pairing installer.
 */
export class HubRegistry {
  private readonly database: CrowdsecDatabase;
  private readonly keysDir: string;
  private readonly runner?: HubRunner;
  private readonly now: () => number;
  readonly pairingTtlMs: number;
  private readonly execTimeoutMs: number;
  private readonly executors = new Map<string, { signature: string; executor: HubExecutor }>();

  constructor(options: HubRegistryOptions) {
    this.database = options.database;
    this.keysDir = options.keysDir;
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.execTimeoutMs = options.execTimeoutMs ?? 120_000;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  list(): HubServerRecord[] {
    const rows = this.database.db.query('SELECT * FROM hub_executors ORDER BY source = \'env\' DESC, name COLLATE NOCASE, id').all() as Row[];
    return rows.map(toRecord);
  }

  get(id: string): HubServerRecord | null {
    const row = this.database.db.query('SELECT * FROM hub_executors WHERE id = ?').get(id) as Row | null | undefined;
    return row ? toRecord(row) : null;
  }

  /** Servers that can be reached right now: set up, and not waiting for pairing. */
  isUsable(record: HubServerRecord | null): record is HubServerRecord {
    return Boolean(record && record.status !== 'pending');
  }

  /** Makes the single-server HUB_* settings an entry of the registry. The environment wins over the stored copy. */
  syncEnvironment(config: HubExecutorConfig, details: { instanceId: string; name: string; machine?: string | null }): HubServerRecord | null {
    if (config.transport === 'disabled') {
      this.database.db.query('DELETE FROM hub_executors WHERE id = ? AND source = \'env\'').run(ENV_SERVER_ID);
      this.executors.delete(ENV_SERVER_ID);
      return null;
    }
    const existing = this.get(ENV_SERVER_ID);
    const values = {
      transport: config.transport,
      host: config.transport === 'ssh' ? config.host : null,
      port: config.transport === 'ssh' ? config.port : null,
      ssh_user: config.transport === 'ssh' ? config.user : null,
      key_ref: config.transport === 'ssh' ? config.keyFile : null,
      known_hosts_ref: config.transport === 'ssh' ? config.knownHostsFile : null,
      command: config.transport === 'command' ? config.command.join(' ') : null,
    };
    if (existing) {
      this.database.db.query(`
        UPDATE hub_executors SET instance_id = ?, name = ?, machine = ?, transport = ?, host = ?, port = ?, ssh_user = ?,
          key_ref = ?, known_hosts_ref = ?, command = ? WHERE id = ?
      `).run(details.instanceId, details.name, details.machine ?? null, values.transport, values.host, values.port, values.ssh_user,
        values.key_ref, values.known_hosts_ref, values.command, ENV_SERVER_ID);
    } else {
      this.database.db.query(`
        INSERT INTO hub_executors (id, machine, instance_id, name, source, transport, host, port, ssh_user, key_ref, known_hosts_ref, command,
          mode, status, pending_reload, created_at, paired_at)
        VALUES (?, ?, ?, ?, 'env', ?, ?, ?, ?, ?, ?, ?, NULL, 'paired', 0, ?, ?)
      `).run(ENV_SERVER_ID, details.machine ?? null, details.instanceId, details.name, values.transport, values.host, values.port, values.ssh_user,
        values.key_ref, values.known_hosts_ref, values.command, this.iso(), this.iso());
    }
    this.executors.delete(ENV_SERVER_ID);
    return this.get(ENV_SERVER_ID);
  }

  /** The executor for one server, or null while it is waiting for pairing or when it has no usable settings. */
  executorFor(id: string): HubExecutor | null {
    const record = this.get(id);
    if (!record || record.status === 'pending') return null;
    let config: HubExecutorConfig | null = null;
    if (record.transport === 'ssh' && record.host && record.ssh_user && record.key_ref && record.known_hosts_ref) {
      config = {
        transport: 'ssh', host: record.host, user: record.ssh_user, port: record.port ?? 22,
        keyFile: record.key_ref, knownHostsFile: record.known_hosts_ref, timeoutMs: this.execTimeoutMs, instance: record.instance_id ?? undefined,
      };
    } else if (record.transport === 'command' && record.command) {
      config = { transport: 'command', command: record.command.split(/\s+/).filter(Boolean), timeoutMs: this.execTimeoutMs, instance: record.instance_id ?? undefined };
    }
    if (!config) return null;
    const signature = JSON.stringify(config);
    const cached = this.executors.get(id);
    if (cached?.signature === signature) return cached.executor;
    const executor = createHubExecutor(config, this.runner);
    this.executors.set(id, { signature, executor });
    return executor;
  }

  private idFor(machine: string): string {
    return `m-${slugify(machine)}-${crypto.createHash('sha1').update(machine).digest('hex').slice(0, 6)}`;
  }

  /** Starts pairing for a machine: a key pair for the Web UI side and a one-time token for the install command. */
  createPairing(input: CreatePairingInput): { record: HubServerRecord; token: string; expiresAt: number; publicKey: string } {
    const machine = input.machine.trim();
    if (!MACHINE_NAME.test(machine)) throw new HubRegistryError('A valid machine name is required', 'INVALID_MACHINE', 400);
    const id = this.idFor(machine);
    const existing = this.get(id);
    if (existing && existing.status !== 'pending') {
      throw new HubRegistryError('This server is already set up. Remove it first to pair it again.', 'ALREADY_PAIRED', 409);
    }
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.keysDir, `${id}.key`);
    const pair = generateSshKeyPair(HUB_KEY_COMMENT);
    fs.writeFileSync(keyFile, pair.privateKey, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);

    const name = (input.name?.trim() || machine).slice(0, 80);
    if (existing) {
      this.database.db.query(`
        UPDATE hub_executors SET name = ?, instance_id = ?, public_key = ?, key_ref = ?, profile = ?, apply_profile = ?, app_from = ?, status = 'pending', last_error = NULL
        WHERE id = ?
      `).run(name, input.instanceId, pair.publicKey, keyFile, input.profile, input.applyProfile ? 1 : 0, input.appFrom, id);
      this.database.db.query('DELETE FROM hub_pairing_tokens WHERE executor_id = ? AND used_at IS NULL').run(id);
    } else {
      this.database.db.query(`
        INSERT INTO hub_executors (id, machine, instance_id, name, source, transport, public_key, key_ref, status, profile, apply_profile, app_from, pending_reload, created_at)
        VALUES (?, ?, ?, ?, 'pairing', 'ssh', ?, ?, 'pending', ?, ?, ?, 0, ?)
      `).run(id, machine, input.instanceId, name, pair.publicKey, keyFile, input.profile, input.applyProfile ? 1 : 0, input.appFrom, this.iso());
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.pairingTtlMs;
    this.database.db.query(`
      INSERT INTO hub_pairing_tokens (token_hash, executor_id, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?)
    `).run(hashToken(token), id, this.iso(), input.createdBy, expiresAt);
    this.executors.delete(id);
    return { record: this.get(id)!, token, expiresAt, publicKey: pair.publicKey };
  }

  /** The latest unused token of a pending server, for showing whether its command can still be used. */
  pairingExpiry(id: string): number | null {
    const row = this.database.db.query(
      'SELECT expires_at FROM hub_pairing_tokens WHERE executor_id = ? AND used_at IS NULL ORDER BY expires_at DESC LIMIT 1',
    ).get(id) as { expires_at: number } | null | undefined;
    return row?.expires_at ?? null;
  }

  private findToken(token: string): { executor_id: string; expires_at: number; downloads: number; used_at: string | null } | null {
    return (this.database.db.query('SELECT executor_id, expires_at, downloads, used_at FROM hub_pairing_tokens WHERE token_hash = ?')
      .get(hashToken(token)) as { executor_id: string; expires_at: number; downloads: number; used_at: string | null } | null | undefined) ?? null;
  }

  private checkToken(token: string, forDownload: boolean): { executor_id: string } {
    const row = typeof token === 'string' && token.length >= 16 ? this.findToken(token) : null;
    if (!row) throw new HubRegistryError('Unknown pairing token', 'TOKEN_UNKNOWN', 404);
    if (row.used_at) throw new HubRegistryError('This pairing token was already used', 'TOKEN_USED', 410);
    if (row.expires_at <= this.now()) throw new HubRegistryError('This pairing token has expired', 'TOKEN_EXPIRED', 410);
    if (forDownload && row.downloads >= MAX_SCRIPT_DOWNLOADS) throw new HubRegistryError('This pairing token was downloaded too many times', 'TOKEN_DOWNLOADS', 410);
    return row;
  }

  /** The record behind a token that may still fetch the install script; counts the download. */
  claimScriptDownload(token: string): HubServerRecord {
    const row = this.checkToken(token, true);
    const record = this.get(row.executor_id);
    if (!record?.public_key) throw new HubRegistryError('Unknown pairing token', 'TOKEN_UNKNOWN', 404);
    this.database.db.query('UPDATE hub_pairing_tokens SET downloads = downloads + 1 WHERE token_hash = ?').run(hashToken(token));
    return record;
  }

  /** Finishes pairing: the token is spent, the host keys are pinned and the server becomes usable. */
  completePairing(token: string, report: PairingReport, from: string | null): HubServerRecord {
    const row = this.checkToken(token, false);
    const record = this.get(row.executor_id);
    if (!record || record.status !== 'pending') throw new HubRegistryError('Unknown pairing token', 'TOKEN_UNKNOWN', 404);

    const address = typeof report?.address === 'string' ? report.address.trim() : '';
    const user = typeof report?.user === 'string' ? report.user : '';
    const port = Number(report?.port);
    const keys = Array.isArray(report?.host_keys) ? report.host_keys : [];
    if (!ADDRESS.test(address) || !SSH_USER.test(user) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HubRegistryError('The pairing report is not valid', 'REPORT_INVALID', 400);
    }
    if (report.mode !== 'docker' && report.mode !== 'native') throw new HubRegistryError('The pairing report is not valid', 'REPORT_INVALID', 400);
    if (keys.length < 1 || keys.length > 6 || !keys.every((key) => typeof key === 'string' && HOST_KEY.test(key))) {
      throw new HubRegistryError('The pairing report needs valid SSH host keys', 'REPORT_INVALID', 400);
    }

    // Spend the token first, so two reports cannot both succeed.
    const claimed = this.database.db.query(
      'UPDATE hub_pairing_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    ).run(this.iso(), hashToken(token), this.now()) as { changes: number };
    if (claimed.changes !== 1) throw new HubRegistryError('This pairing token was already used', 'TOKEN_USED', 410);

    const hostPattern = port === 22 ? address : `[${address}]:${port}`;
    const knownHostsFile = path.join(this.keysDir, `${record.id}.known_hosts`);
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(knownHostsFile, `${keys.map((key) => `${hostPattern} ${key}`).join('\n')}\n`, { mode: 0o600 });
    this.database.db.query(`
      UPDATE hub_executors SET host = ?, port = ?, ssh_user = ?, mode = ?, known_hosts_ref = ?, host_key = ?, status = 'paired',
        paired_at = ?, paired_from = ?, last_error = NULL WHERE id = ?
    `).run(address, port, user, report.mode, knownHostsFile, keys.join('\n'), this.iso(), from, record.id);
    this.executors.delete(record.id);
    return this.get(record.id)!;
  }

  recordCheck(id: string, error: string | null): void {
    this.database.db.query(`
      UPDATE hub_executors SET last_check_at = ?, last_error = ?, status = CASE WHEN status = 'pending' THEN 'pending' WHEN ? IS NULL THEN 'paired' ELSE 'error' END
      WHERE id = ?
    `).run(this.iso(), error, error, id);
  }

  setPendingReload(id: string, value: boolean): void {
    this.database.db.query('UPDATE hub_executors SET pending_reload = ? WHERE id = ?').run(value ? 1 : 0, id);
  }

  /** Forgets a server and deletes the keys held for it. The server itself keeps its installer until the uninstall command is run there. */
  remove(id: string): HubServerRecord {
    const record = this.get(id);
    if (!record) throw new HubRegistryError('Unknown server', 'SERVER_UNKNOWN', 404);
    if (record.source === 'env') {
      throw new HubRegistryError('This server comes from the HUB_* environment variables; change them to remove it', 'ENV_SERVER', 409);
    }
    this.database.db.query('DELETE FROM hub_pairing_tokens WHERE executor_id = ?').run(id);
    this.database.db.query('DELETE FROM hub_executors WHERE id = ?').run(id);
    this.executors.delete(id);
    for (const file of [record.key_ref, record.known_hosts_ref]) {
      if (file && path.dirname(file) === this.keysDir) fs.rmSync(file, { force: true });
    }
    return record;
  }

  /** Machines known to CrowdSec that have no registry entry yet. They are only listed, never contacted. */
  detectMachines(machines: string[]): string[] {
    const known = new Set(this.list().map((record) => record.machine).filter((machine): machine is string => Boolean(machine)));
    return [...new Set(machines.map((machine) => machine.trim()).filter(Boolean))].filter((machine) => !known.has(machine));
  }
}

export function listMachineNames(database: CrowdsecDatabase): string[] {
  const rows = database.db.query("SELECT DISTINCT machine FROM alerts WHERE machine IS NOT NULL AND machine <> '' ORDER BY machine").all() as Array<{ machine: string }>;
  return rows.map((row) => row.machine);
}
