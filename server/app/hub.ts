import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { AuditAction, AuditLogger } from '../audit-log';
import type { CrowdsecDatabase } from '../database';
import { parseHubCatalog, type HubCatalog } from '../hub/catalog';
import {
  isHubItemType, isValidHubName, type HubExecutor, type HubItemType, type HubOperation, type HubRunResult,
} from '../hub/executor';
import { generateInstallScript, HUB_UNINSTALL_COMMAND, installCommand, isValidPairingFrom } from '../hub/install-script';
import { findProfile, HUB_PROFILES } from '../hub/profiles';
import {
  HubRegistryError, hostKeyFingerprint, listMachineNames, type HubRegistry, type HubServerRecord,
} from '../hub/registry';

const CATALOG_TTL_MS = 60_000;
const OUTPUT_LIMIT = 4000;
const SEEN_LIMIT = 200;
const MAX_FAN_OUT = 50;

export interface HubServerSummary {
  /** Null for a machine that is only detected. */
  id: string | null;
  name: string;
  machine: string | null;
  /** detected: seen in CrowdSec, installer not set up; pending: waiting for the install command; paired; error. */
  status: 'detected' | 'pending' | 'paired' | 'error';
  source: 'env' | 'pairing' | null;
  transport: 'ssh' | 'command' | null;
  host: string | null;
  port: number | null;
  ssh_user: string | null;
  mode: 'docker' | 'native' | null;
  /** SHA256 fingerprint of the pinned SSH host key. */
  host_key_fingerprint: string | null;
  instance_id: string | null;
  last_check_at: string | null;
  last_error: string | null;
  pending_reload: boolean;
  profile: string | null;
  apply_profile: boolean;
  paired_at: string | null;
  /** The install command can no longer be used. */
  pairing_expired: boolean;
  pairing_expires_at: string | null;
}

export interface HubServersResponse {
  servers: HubServerSummary[];
  can_manage: boolean;
  profiles: Array<{ id: string; items: Array<{ type: HubItemType; name: string }> }>;
  pairing_ttl_minutes: number;
  uninstall_command: string;
  config_error: string | null;
}

export interface HubStatus {
  server: HubServerSummary | null;
  executor: {
    state: 'disabled' | 'ready';
    /** Set when HUB_EXECUTOR is present but invalid. */
    config_error: string | null;
  };
  can_manage: boolean;
  /** An install, removal or upgrade needs a CrowdSec reload to take effect. */
  pending_reload: boolean;
  /** Present when the executor works. */
  catalog: HubCatalog | null;
  catalog_error: string | null;
  /** Scenarios that raised alerts, available without the executor. */
  seen_scenarios: Array<{ name: string; alerts: number; installed: boolean | null }>;
}

export interface HubServerResult {
  server: string;
  name: string;
  ok: boolean;
  output: string;
  pending_reload: boolean;
}

const clip = (text: string) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text);

function outputOf(result: HubRunResult): string {
  return clip([result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n'));
}

function summarise(record: HubServerRecord, expiresAt: number | null, now: number): HubServerSummary {
  return {
    id: record.id,
    name: record.name,
    machine: record.machine,
    status: record.status,
    source: record.source,
    transport: record.transport,
    host: record.host,
    port: record.port,
    ssh_user: record.ssh_user,
    mode: record.mode,
    host_key_fingerprint: hostKeyFingerprint(record.host_key),
    instance_id: record.instance_id,
    last_check_at: record.last_check_at,
    last_error: record.last_error,
    pending_reload: record.pending_reload,
    profile: record.profile,
    apply_profile: record.apply_profile,
    paired_at: record.paired_at,
    pairing_expired: record.status === 'pending' && (expiresAt === null || expiresAt <= now),
    pairing_expires_at: record.status === 'pending' && expiresAt ? new Date(expiresAt).toISOString() : null,
  };
}

function detectedSummary(machine: string): HubServerSummary {
  return {
    id: null, name: machine, machine, status: 'detected', source: null, transport: null, host: null, port: null, ssh_user: null, mode: null,
    host_key_fingerprint: null, instance_id: null, last_check_at: null, last_error: null, pending_reload: false, profile: null,
    apply_profile: false, paired_at: null, pairing_expired: false, pairing_expires_at: null,
  };
}

function forwardedAddress(context: any): string | null {
  const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim() || context.req.header('x-real-ip')?.trim();
  const address = forwarded || context.env?.incoming?.socket?.remoteAddress;
  return typeof address === 'string' && address ? address.slice(0, 64) : null;
}

function publicBase(context: any, basePath: string, override: string | undefined): string {
  if (override) return override.replace(/\/+$/, '');
  const forwardedHost = context.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || context.req.header('host');
  const forwardedProto = context.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const url = new URL(context.req.url);
  const origin = host ? `${forwardedProto || url.protocol.replace(/:$/, '')}://${host}` : url.origin;
  return `${origin}${basePath}`;
}

/**
 * Hub browsing for everyone signed in; changes for administrators, always audited and confirmed.
 * Every server has its own executor, and changes to several servers run side by side with one result each.
 */
export function registerHubRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  audit: AuditLogger;
  registry: HubRegistry;
  configError: string | null;
  defaultInstance: { id: string; name: string };
  /** Overrides the address shown in install commands (HUB_PUBLIC_URL). */
  publicUrl?: string;
  /** Address the Web UI connects to servers from, as they see it (HUB_APP_ADDRESS). */
  appAddress?: string;
  writeDatabase: <T>(operation: () => T) => Promise<T>;
  now?: () => number;
}): { settled: () => Promise<void> } {
  const { app, basePath, database, auth, audit, registry, configError, defaultInstance, writeDatabase } = options;
  const now = options.now ?? Date.now;
  const catalogs = new Map<string, { at: number; catalog: HubCatalog }>();
  const background = new Set<Promise<unknown>>();
  const canManage = (context: any) => auth.getPermissions(context).can_manage_settings;
  const forbidden = (context: any) => context.json({ error: 'Administrator access required', code: 'FORBIDDEN' }, 403);

  function listServers(): HubServerSummary[] {
    const at = now();
    const records = registry.list().map((record) => summarise(record, record.status === 'pending' ? registry.pairingExpiry(record.id) : null, at));
    const detected = registry.detectMachines(listMachineNames(database)).map(detectedSummary);
    return [...records, ...detected];
  }

  function defaultServer(): HubServerRecord | null {
    return registry.list().find((record) => registry.isUsable(record)) ?? null;
  }

  async function loadCatalog(record: HubServerRecord): Promise<{ catalog: HubCatalog | null; error: string | null }> {
    const executor = registry.executorFor(record.id);
    if (!executor) return { catalog: null, error: null };
    const cached = catalogs.get(record.id);
    if (cached && now() - cached.at < CATALOG_TTL_MS) return { catalog: cached.catalog, error: null };
    let error: string | null = null;
    try {
      const result = await executor.run({ action: 'list' });
      if (result.code === 0) {
        const catalog = parseHubCatalog(result.stdout);
        catalogs.set(record.id, { at: now(), catalog });
        await writeDatabase(() => registry.recordCheck(record.id, null));
        return { catalog, error: null };
      }
      error = clip(result.stderr.trim() || `The executor exited with code ${result.code}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed to read the hub';
    }
    await writeDatabase(() => registry.recordCheck(record.id, error));
    return { catalog: catalogs.get(record.id)?.catalog ?? null, error };
  }

  function seenScenarios(record: HubServerRecord | null, catalog: HubCatalog | null): HubStatus['seen_scenarios'] {
    const machine = record?.machine ?? null;
    const rows = database.db.query(`
      SELECT scenario AS name, COUNT(*) AS alerts FROM alerts
      WHERE scenario IS NOT NULL AND scenario <> '' AND simulated = 0 ${machine ? 'AND machine = ?' : ''}
      GROUP BY scenario ORDER BY alerts DESC LIMIT ?
    `).all(...(machine ? [machine, SEEN_LIMIT] : [SEEN_LIMIT])) as Array<{ name: string; alerts: number }>;
    const installed = catalog ? new Set(catalog.scenarios.filter((item) => item.installed).map((item) => item.name)) : null;
    return rows.map((row) => ({ ...row, installed: installed ? installed.has(row.name) : null }));
  }

  app.get(`${basePath}/api/hub/servers`, auth.ensureAuth, (context) => {
    const body: HubServersResponse = {
      servers: listServers(),
      can_manage: canManage(context),
      profiles: HUB_PROFILES.map((profile) => ({ id: profile.id, items: profile.items.map((item) => ({ ...item })) })),
      pairing_ttl_minutes: Math.round(registry.pairingTtlMs / 60_000),
      uninstall_command: HUB_UNINSTALL_COMMAND,
      config_error: configError,
    };
    return context.json(body);
  });

  app.get(`${basePath}/api/hub`, auth.ensureAuth, async (context) => {
    const requested = context.req.query('server');
    const record = requested ? registry.get(requested) : defaultServer();
    if (requested && !record) return context.json({ error: 'Unknown server', code: 'SERVER_UNKNOWN' }, 404);
    const usable = registry.isUsable(record) ? record : null;
    const { catalog, error } = usable ? await loadCatalog(usable) : { catalog: null, error: null };
    const fresh = usable ? registry.get(usable.id)! : record;
    const status: HubStatus = {
      server: fresh ? summarise(fresh, fresh.status === 'pending' ? registry.pairingExpiry(fresh.id) : null, now()) : null,
      executor: { state: usable && registry.executorFor(usable.id) ? 'ready' : 'disabled', config_error: configError },
      can_manage: canManage(context),
      pending_reload: Boolean(fresh?.pending_reload),
      catalog,
      catalog_error: error,
      seen_scenarios: seenScenarios(usable, catalog),
    };
    return context.json(status);
  });

  type Recorder = (event: { action: AuditAction; outcome: 'success' | 'failure'; [detail: string]: unknown }) => void;
  const recorderFor = (context: any): Recorder => (event) => audit.record(context, event);

  async function runOn(
    record: HubServerRecord,
    executor: HubExecutor,
    operation: HubOperation,
    action: AuditAction,
    item: string | undefined,
    record_: Recorder,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; output: string }> {
    const detail = { ...(item ? { hub_item: item } : {}), hub_server: record.name, server_id: record.id, ...extra };
    try {
      const result = await executor.run(operation);
      const ok = result.code === 0;
      record_({ action, outcome: ok ? 'success' : 'failure', ...detail, exit_code: result.code });
      if (ok) {
        catalogs.delete(record.id);
        await writeDatabase(() => registry.setPendingReload(record.id, operation.action !== 'reload'));
      }
      return { ok, output: outputOf(result) };
    } catch (error) {
      record_({ action, outcome: 'failure', ...detail });
      return { ok: false, output: error instanceof Error ? error.message : 'The hub executor failed' };
    }
  }

  /** The same operation on every chosen server at once; a server that fails does not stop the others. */
  async function fanOut(
    ids: unknown,
    record_: Recorder,
    task: (record: HubServerRecord, executor: HubExecutor) => Promise<{ ok: boolean; output: string }>,
  ): Promise<{ results: HubServerResult[]; status: 200 | 400 | 502 }> {
    const chosen = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))] : [];
    if (!Array.isArray(ids)) {
      const fallback = defaultServer();
      if (fallback) chosen.push(fallback.id);
    }
    if (chosen.length === 0 || chosen.length > MAX_FAN_OUT) return { results: [], status: 400 };
    const results = await Promise.all(chosen.map(async (id): Promise<HubServerResult> => {
      const record = registry.get(id);
      const executor = registry.isUsable(record) ? registry.executorFor(id) : null;
      if (!record || !executor) {
        record_({ action: 'hub.check', outcome: 'failure', hub_server: record?.name ?? id, reason: 'server not available' });
        return { server: id, name: record?.name ?? id, ok: false, output: 'This server is not available for hub changes', pending_reload: false };
      }
      const outcome = await task(record, executor);
      return { server: id, name: record.name, ok: outcome.ok, output: outcome.output, pending_reload: Boolean(registry.get(id)?.pending_reload) };
    }));
    return { results, status: results.some((result) => result.ok) ? 200 : 502 };
  }

  function respond(context: any, fan: { results: HubServerResult[]; status: 200 | 400 | 502 }) {
    if (fan.status === 400) return context.json({ error: 'Choose between 1 and 50 servers', code: 'NO_SERVERS' }, 400);
    return context.json({ ok: fan.results.every((result) => result.ok), results: fan.results }, fan.status);
  }

  app.post(`${basePath}/api/hub/action`, auth.ensureAuth, async (context) => {
    if (!canManage(context)) return forbidden(context);
    const body = await context.req.json().catch(() => null) as { action?: unknown; type?: unknown; name?: unknown; confirm?: unknown; servers?: unknown } | null;
    const action = body?.action;
    const record_ = recorderFor(context);
    if (action === 'update' || action === 'upgrade-all') {
      if (body?.confirm !== true) return context.json({ error: 'Confirmation is required' }, 400);
      const auditAction: AuditAction = action === 'update' ? 'hub.update' : 'hub.upgrade-all';
      return respond(context, await fanOut(body.servers, record_, (server, executor) => runOn(server, executor, { action }, auditAction, undefined, record_)));
    }
    if (action !== 'install' && action !== 'remove' && action !== 'upgrade') return context.json({ error: 'Unknown hub action' }, 400);
    if (!isHubItemType(body?.type) || !isValidHubName(body?.name)) return context.json({ error: 'A valid item type and name are required' }, 400);
    if (body?.confirm !== true) return context.json({ error: 'Confirmation is required' }, 400);
    const type = body.type as HubItemType;
    const name = body.name as string;
    const auditAction = `hub.${action}` as AuditAction;
    return respond(context, await fanOut(body.servers, record_, async (server, executor) => {
      // Files written by hand are not hub items, so they are never removed or replaced from here.
      const known = catalogs.get(server.id)?.catalog[type].find((item) => item.name === name);
      if (known?.local) return { ok: false, output: 'This is a local item and cannot be managed from the hub' };
      return runOn(server, executor, { action, type, name }, auditAction, `${type}/${name}`, record_);
    }));
  });

  app.post(`${basePath}/api/hub/reload`, auth.ensureAuth, async (context) => {
    if (!canManage(context)) return forbidden(context);
    const body = await context.req.json().catch(() => null) as { confirm?: unknown; servers?: unknown } | null;
    // Reloading makes CrowdSec re-read its configuration, so it is never done without an explicit yes.
    if (body?.confirm !== true) return context.json({ error: 'Confirmation is required' }, 400);
    const record_ = recorderFor(context);
    return respond(context, await fanOut(body.servers, record_, (server, executor) => runOn(server, executor, { action: 'reload' }, 'hub.reload', undefined, record_)));
  });

  async function applyProfile(record: HubServerRecord, executor: HubExecutor, profileId: string, record_: Recorder): Promise<{ ok: boolean; output: string }> {
    const profile = findProfile(profileId);
    if (!profile) return { ok: false, output: 'Unknown profile' };
    const lines: string[] = [];
    let ok = true;
    for (const item of profile.items) {
      const outcome = await runOn(record, executor, { action: 'install', type: item.type, name: item.name }, 'hub.install', `${item.type}/${item.name}`, record_, { profile: profile.id });
      ok &&= outcome.ok;
      lines.push(`${outcome.ok ? 'ok' : 'failed'}: ${item.name}${outcome.ok ? '' : ` (${outcome.output.split('\n')[0] ?? ''})`}`);
    }
    return { ok, output: clip(lines.join('\n')) };
  }

  app.post(`${basePath}/api/hub/profile`, auth.ensureAuth, async (context) => {
    if (!canManage(context)) return forbidden(context);
    const body = await context.req.json().catch(() => null) as { profile?: unknown; confirm?: unknown; servers?: unknown } | null;
    const profile = findProfile(body?.profile);
    if (!profile) return context.json({ error: 'Unknown profile' }, 400);
    if (body?.confirm !== true) return context.json({ error: 'Confirmation is required' }, 400);
    const record_ = recorderFor(context);
    return respond(context, await fanOut(body.servers, record_, (server, executor) => applyProfile(server, executor, profile.id, record_)));
  });

  // ---- Servers: detection, pairing and removal ----

  app.post(`${basePath}/api/hub/servers/pair`, auth.ensureAuth, async (context) => {
    if (!canManage(context)) return forbidden(context);
    const body = await context.req.json().catch(() => null) as {
      machine?: unknown; name?: unknown; profile?: unknown; apply_profile?: unknown; from?: unknown;
    } | null;
    if (typeof body?.machine !== 'string') return context.json({ error: 'A machine name is required', code: 'INVALID_MACHINE' }, 400);
    const profile = body.profile == null || body.profile === '' ? null : findProfile(body.profile)?.id ?? null;
    if (body.profile != null && body.profile !== '' && !profile) return context.json({ error: 'Unknown profile' }, 400);
    const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : (options.appAddress ?? '');
    if (!isValidPairingFrom(from)) return context.json({ error: 'The app address must be an IP address, a network or a list of them', code: 'INVALID_FROM' }, 400);
    try {
      const pairing = await writeDatabase(() => registry.createPairing({
        machine: body.machine as string,
        name: typeof body.name === 'string' ? body.name : undefined,
        instanceId: defaultInstance.id,
        profile,
        applyProfile: body.apply_profile === true && Boolean(profile),
        appFrom: from || null,
        createdBy: (auth.getSession(context) as { username?: string } | null)?.username ?? 'admin',
      }));
      audit.record(context, { action: 'hub.pair-token', outcome: 'success', hub_server: pairing.record.name, server_id: pairing.record.id, expires_at: new Date(pairing.expiresAt).toISOString(), ...(profile ? { profile, apply_profile: pairing.record.apply_profile } : {}) });
      const base = publicBase(context, basePath, options.publicUrl);
      return context.json({
        server: summarise(pairing.record, pairing.expiresAt, now()),
        token_expires_at: new Date(pairing.expiresAt).toISOString(),
        command: installCommand(base, pairing.token),
        uninstall_command: HUB_UNINSTALL_COMMAND,
      }, 201);
    } catch (error) {
      if (error instanceof HubRegistryError) return context.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });

  app.delete(`${basePath}/api/hub/servers/:id`, auth.ensureAuth, async (context) => {
    if (!canManage(context)) return forbidden(context);
    try {
      const removed = await writeDatabase(() => registry.remove(context.req.param('id')));
      catalogs.delete(removed.id);
      audit.record(context, { action: 'hub.unpair', outcome: 'success', hub_server: removed.name, server_id: removed.id });
      return context.json({ ok: true, uninstall_command: HUB_UNINSTALL_COMMAND });
    } catch (error) {
      if (error instanceof HubRegistryError) return context.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });

  app.post(`${basePath}/api/hub/servers/:id/check`, auth.ensureAuth, async (context) => {
    if (!canManage(context)) return forbidden(context);
    const record = registry.get(context.req.param('id'));
    if (!record) return context.json({ error: 'Unknown server', code: 'SERVER_UNKNOWN' }, 404);
    if (!registry.isUsable(record)) return context.json({ error: 'This server has not been paired yet', code: 'NOT_PAIRED' }, 409);
    catalogs.delete(record.id);
    const { error } = await loadCatalog(record);
    audit.record(context, { action: 'hub.check', outcome: error ? 'failure' : 'success', hub_server: record.name, server_id: record.id });
    const fresh = registry.get(record.id)!;
    return context.json({ ok: !error, error, server: summarise(fresh, null, now()) }, error ? 502 : 200);
  });

  // ---- Pairing endpoints used by the install command on the new server. The token is the credential. ----

  const pairingFailure = (context: any, error: unknown, action: AuditAction) => {
    if (error instanceof HubRegistryError) {
      audit.recordSystem('pairing-token', { action, outcome: 'failure', reason: error.code, ip: forwardedAddress(context) });
      return context.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  };

  app.get(`${basePath}/api/hub/pair/:token/install.sh`, async (context) => {
    try {
      const record = await writeDatabase(() => registry.claimScriptDownload(context.req.param('token')));
      const script = generateInstallScript({
        baseUrl: publicBase(context, basePath, options.publicUrl),
        token: context.req.param('token'),
        publicKey: record.public_key!,
        appFrom: record.app_from ?? '',
      });
      audit.recordSystem('pairing-token', { action: 'hub.pair-script', outcome: 'success', hub_server: record.name, server_id: record.id, ip: forwardedAddress(context) });
      return new Response(script, { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (error) {
      return pairingFailure(context, error, 'hub.pair-script');
    }
  });

  app.post(`${basePath}/api/hub/pair/:token/complete`, async (context) => {
    const body = await context.req.json().catch(() => null);
    const from = forwardedAddress(context);
    try {
      const record = await writeDatabase(() => registry.completePairing(context.req.param('token'), body, from));
      audit.recordSystem('pairing-token', { action: 'hub.pair', outcome: 'success', hub_server: record.name, server_id: record.id, ip: from, host: record.host, mode: record.mode, host_key: hostKeyFingerprint(record.host_key) });
      const job = verifyAndApplyProfile(record).catch(() => undefined).finally(() => background.delete(job));
      background.add(job);
      return context.json({ ok: true });
    } catch (error) {
      return pairingFailure(context, error, 'hub.pair');
    }
  });

  /** After pairing: prove the connection works, then apply the chosen profile if the administrator asked for it. */
  async function verifyAndApplyProfile(record: HubServerRecord): Promise<void> {
    const { catalog, error } = await loadCatalog(record);
    audit.recordSystem('pairing-token', { action: 'hub.check', outcome: error ? 'failure' : 'success', hub_server: record.name, server_id: record.id });
    const executor = registry.executorFor(record.id);
    if (error || !catalog || !executor || !record.apply_profile || !record.profile) return;
    const recorder: Recorder = (event) => audit.recordSystem('pairing-token', event);
    const outcome = await applyProfile(record, executor, record.profile, recorder);
    audit.recordSystem('pairing-token', { action: 'hub.profile', outcome: outcome.ok ? 'success' : 'failure', hub_server: record.name, server_id: record.id, profile: record.profile });
  }

  return { settled: async () => { await Promise.all([...background]); } };
}
