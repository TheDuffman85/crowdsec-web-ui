import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAuditLogger, type AuditActor } from '../../audit-log';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-audit-test-'));
  tempDirs.push(dir);
  return dir;
}

function createLogger(options: { enabled?: boolean; logFile?: string; actor?: AuditActor | null } = {}) {
  return createAuditLogger({
    enabled: options.enabled ?? true,
    logFile: options.logFile,
    getActor: () => (options.actor === undefined ? { username: 'tommy', role: 'admin' } : options.actor),
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createAuditLogger', () => {
  test('writes a structured console line and appends the entry to the log file', () => {
    const logFile = join(createTempDir(), 'logs', 'audit.log');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const auditLog = createLogger({ logFile });
      auditLog.record({}, { action: 'decision.add', ip: '1.2.3.4', type: 'ban', outcome: 'success' });

      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0][0]);
      expect(line.startsWith('[audit] ')).toBe(true);
      const entry = JSON.parse(line.slice('[audit] '.length));
      expect(entry).toMatchObject({
        user: 'tommy',
        role: 'admin',
        action: 'decision.add',
        ip: '1.2.3.4',
        type: 'ban',
        outcome: 'success',
      });
      expect(Number.isNaN(Date.parse(entry.time))).toBe(false);
      expect(readFileSync(logFile, 'utf8')).toBe(`${line.slice('[audit] '.length)}\n`);
    } finally {
      log.mockRestore();
    }
  });

  test('appends one line per recorded entry', () => {
    const logFile = join(createTempDir(), 'audit.log');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const auditLog = createLogger({ logFile });
      auditLog.record({}, { action: 'decision.add', ip: '1.2.3.4', outcome: 'success' });
      auditLog.record({}, { action: 'decision.delete', decision_ids: ['10'], outcome: 'success' });

      const lines = readFileSync(logFile, 'utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).action).toBe('decision.add');
      expect(JSON.parse(lines[1]).action).toBe('decision.delete');
    } finally {
      log.mockRestore();
    }
  });

  test('stays silent when disabled', () => {
    const logFile = join(createTempDir(), 'audit.log');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const auditLog = createLogger({ enabled: false, logFile });
      auditLog.record({}, { action: 'decision.add', ip: '1.2.3.4', outcome: 'success' });

      expect(log).not.toHaveBeenCalled();
      expect(() => readFileSync(logFile, 'utf8')).toThrow();
    } finally {
      log.mockRestore();
    }
  });

  test('records unknown when no actor is available', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const auditLog = createLogger({ actor: null });
      auditLog.record({}, { action: 'alert.delete', alert_ids: ['1'], outcome: 'success' });

      const entry = JSON.parse(String(log.mock.calls[0][0]).slice('[audit] '.length));
      expect(entry.user).toBe('unknown');
      expect(entry.role).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test('keeps console logging when the log file cannot be written', () => {
    const logFile = join(createTempDir(), 'audit.log');
    mkdirSync(logFile);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const auditLog = createLogger({ logFile });
      auditLog.record({}, { action: 'decision.add', ip: '1.2.3.4', outcome: 'success' });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('[audit] '));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to write audit log entry'));
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  test('warns once when the log file directory cannot be created', () => {
    const blockingFile = join(createTempDir(), 'not-a-directory');
    writeFileSync(blockingFile, 'occupied', 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const auditLog = createLogger({ logFile: join(blockingFile, 'audit.log') });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be created'));

      auditLog.record({}, { action: 'decision.add', ip: '1.2.3.4', outcome: 'success' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[audit] '));
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});
