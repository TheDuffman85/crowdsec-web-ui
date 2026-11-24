import fs from 'node:fs';
import path from 'node:path';

type HonoContext = any;

export type AuditAction =
  | 'decision.add'
  | 'decision.delete'
  | 'alert.delete'
  | 'cleanup.by-ip'
  | 'user.create'
  | 'user.update'
  | 'user.password-reset'
  | 'user.mfa-reset'
  | 'user.oidc-link'
  | 'user.oidc-unlink'
  | 'user.session-revoke'
  | 'user.delete'
  | 'push.subscribe'
  | 'push.unsubscribe'
  | 'hub.install'
  | 'hub.remove'
  | 'hub.upgrade'
  | 'hub.update'
  | 'hub.upgrade-all'
  | 'hub.reload'
  | 'hub.profile'
  | 'hub.pair-token'
  | 'hub.pair-script'
  | 'hub.pair'
  | 'hub.unpair'
  | 'hub.check';
export type AuditOutcome = 'success' | 'partial' | 'failure' | 'queued';

export interface AuditActor {
  username: string;
  role?: string;
}

export interface AuditEvent {
  action: AuditAction;
  outcome: AuditOutcome;
  [detail: string]: unknown;
}

export interface AuditEntry {
  time: string;
  user: string;
  role?: string;
  action: AuditAction;
  outcome: AuditOutcome;
  [detail: string]: unknown;
}

export interface AuditLogger {
  enabled: boolean;
  record: (context: HonoContext, event: AuditEvent) => void;
  /** Records an action taken by the application itself, for example a rule that bans an address. */
  recordSystem: (actor: string, event: AuditEvent) => void;
}

export interface CreateAuditLoggerOptions {
  enabled: boolean;
  logFile?: string;
  getActor: (context: HonoContext) => AuditActor | null;
  /** Keeps a copy of every entry so it can be browsed in the Web UI. */
  store?: (entry: AuditEntry) => void;
}

export function createAuditLogger(options: CreateAuditLoggerOptions): AuditLogger {
  const { enabled, logFile, getActor, store } = options;
  let fileWritable = Boolean(logFile);

  if (enabled && logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch (error) {
      fileWritable = false;
      console.error(`Audit log file directory for "${logFile}" could not be created: ${(error as Error).message}`);
    }
  }

  function write(user: string, role: string | undefined, event: AuditEvent): void {
    // Audit logging must never break the user action it describes.
    try {
      const entry: AuditEntry = {
        time: new Date().toISOString(),
        user,
        ...(role ? { role } : {}),
        ...event,
      };
      const line = JSON.stringify(entry);
      console.log(`[audit] ${line}`);
      if (logFile && fileWritable) {
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
      }
      store?.(entry);
    } catch (error) {
      console.error(`Failed to write audit log entry: ${(error as Error).message}`);
    }
  }

  function record(context: HonoContext, event: AuditEvent): void {
    if (!enabled) return;
    try {
      const actor = getActor(context);
      write(actor?.username || 'unknown', actor?.role, event);
    } catch (error) {
      console.error(`Failed to write audit log entry: ${(error as Error).message}`);
    }
  }

  function recordSystem(actor: string, event: AuditEvent): void {
    if (!enabled) return;
    write(actor, 'system', event);
  }

  return { enabled, record, recordSystem };
}
