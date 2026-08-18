import fs from 'node:fs';
import path from 'node:path';

type HonoContext = any;

export type AuditAction = 'decision.add' | 'decision.delete' | 'alert.delete' | 'cleanup.by-ip';
export type AuditOutcome = 'success' | 'partial' | 'failure';

export interface AuditActor {
  username: string;
  role?: string;
}

export interface AuditEvent {
  action: AuditAction;
  outcome: AuditOutcome;
  [detail: string]: unknown;
}

export interface AuditLogger {
  enabled: boolean;
  record: (context: HonoContext, event: AuditEvent) => void;
}

export interface CreateAuditLoggerOptions {
  enabled: boolean;
  logFile?: string;
  getActor: (context: HonoContext) => AuditActor | null;
}

export function createAuditLogger(options: CreateAuditLoggerOptions): AuditLogger {
  const { enabled, logFile, getActor } = options;
  let fileWritable = Boolean(logFile);

  if (enabled && logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch (error) {
      fileWritable = false;
      console.error(`Audit log file directory for "${logFile}" could not be created: ${(error as Error).message}`);
    }
  }

  function record(context: HonoContext, event: AuditEvent): void {
    if (!enabled) return;

    // Audit logging must never break the user action it describes.
    try {
      const actor = getActor(context);
      const line = JSON.stringify({
        time: new Date().toISOString(),
        user: actor?.username || 'unknown',
        ...(actor?.role ? { role: actor.role } : {}),
        ...event,
      });
      console.log(`[audit] ${line}`);
      if (logFile && fileWritable) {
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
      }
    } catch (error) {
      console.error(`Failed to write audit log entry: ${(error as Error).message}`);
    }
  }

  return { enabled, record };
}
