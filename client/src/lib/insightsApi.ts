import { apiUrl } from './basePath';
import { sessionFetch } from './sessionFetch';

export type NoteSubjectType = 'ip' | 'alert';

export interface EntityNote {
  id: string;
  subject_type: NoteSubjectType;
  subject: string;
  author_id: number;
  author_name: string;
  body: string;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_delete: boolean;
}

export interface RepeatOffender {
  ip: string;
  episodes: number;
  first_ban_at: string;
  last_ban_end: string;
  banned_now: boolean;
  scenarios: string[];
  country: string | null;
  suggested_duration: string;
}

export interface RepeatOffenderCheck {
  ip: string;
  previous_bans: number;
  repeat_offender: boolean;
  offender: RepeatOffender | null;
}

export type IntelStatus = 'ok' | 'not_configured' | 'not_found' | 'error';

export interface IntelSource<T> {
  status: IntelStatus;
  data?: T;
  error?: string;
}

export interface IpIntel {
  ip: string;
  cached: boolean;
  whois: IntelSource<{
    name: string | null; handle: string | null; country: string | null; type: string | null;
    start_address: string | null; end_address: string | null; registered_at: string | null; last_changed_at: string | null;
  }>;
  abuseipdb: IntelSource<{
    abuse_confidence_score: number; total_reports: number; distinct_reporters: number; last_reported_at: string | null;
    isp: string | null; usage_type: string | null; domain: string | null; country_code: string | null; is_tor: boolean;
  }>;
  shodan: IntelSource<{
    ports: number[]; hostnames: string[]; organization: string | null; os: string | null; vulnerabilities: string[]; last_update: string | null;
  }>;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || fallback);
  }
  return await response.json() as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function fetchNotes(type: NoteSubjectType, subject: string): Promise<EntityNote[]> {
  const query = new URLSearchParams({ type, subject });
  const payload = await readJson<{ notes: EntityNote[] }>(await sessionFetch(apiUrl(`/api/notes?${query}`)), 'Failed to load notes');
  return payload.notes;
}

export async function addNote(type: NoteSubjectType, subject: string, body: string): Promise<EntityNote> {
  return readJson<EntityNote>(await sessionFetch(apiUrl('/api/notes'), {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ subject_type: type, subject, body }),
  }), 'Failed to save note');
}

export async function updateNote(id: string, body: string): Promise<EntityNote> {
  return readJson<EntityNote>(await sessionFetch(apiUrl(`/api/notes/${encodeURIComponent(id)}`), {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ body }),
  }), 'Failed to update note');
}

export async function deleteNote(id: string): Promise<void> {
  await readJson<unknown>(await sessionFetch(apiUrl(`/api/notes/${encodeURIComponent(id)}`), { method: 'DELETE' }), 'Failed to delete note');
}

export async function checkRepeatOffender(ip: string): Promise<RepeatOffenderCheck> {
  const query = new URLSearchParams({ ip });
  return readJson<RepeatOffenderCheck>(await sessionFetch(apiUrl(`/api/repeat-offenders/check?${query}`)), 'Failed to check ban history');
}

export async function fetchRepeatOffenders(): Promise<RepeatOffender[]> {
  const payload = await readJson<{ offenders: RepeatOffender[] }>(await sessionFetch(apiUrl('/api/repeat-offenders?limit=100')), 'Failed to load repeat offenders');
  return payload.offenders;
}

export async function fetchIpIntel(ip: string): Promise<IpIntel> {
  const query = new URLSearchParams({ ip });
  return readJson<IpIntel>(await sessionFetch(apiUrl(`/api/ip-intel?${query}`)), 'Lookup failed');
}

export interface GeoCountrySummary { code: string; alerts: number; unique_ips: number; blocked: boolean }
export interface GeoBlockingSummary { hours: number; total_alerts: number; countries: GeoCountrySummary[]; blocked_countries: string[] }

export async function fetchGeoBlocking(hours: number): Promise<GeoBlockingSummary> {
  return readJson<GeoBlockingSummary>(await sessionFetch(apiUrl(`/api/geo-blocking?hours=${hours}`)), 'Failed to load country data');
}

export interface HostSummary { machine: string; alerts_total: number; alerts_24h: number; alerts_7d: number; last_alert_at: string | null }
export interface HostCount { name: string; count: number }
export interface HostDetail extends HostSummary {
  active_decisions: number;
  daily: Array<{ date: string; count: number }>;
  top_scenarios: HostCount[];
  top_sources: HostCount[];
  top_countries: HostCount[];
  top_targets: HostCount[];
  recent_alerts: Array<{ id: number; created_at: string; scenario: string | null; source_ip: string | null; country: string | null; target: string | null }>;
}

export async function fetchHosts(): Promise<HostSummary[]> {
  return (await readJson<{ hosts: HostSummary[] }>(await sessionFetch(apiUrl('/api/hosts')), 'Failed to load hosts')).hosts;
}

export async function fetchHostDetail(machine: string): Promise<HostDetail> {
  return readJson<HostDetail>(await sessionFetch(apiUrl(`/api/hosts/detail?${new URLSearchParams({ machine })}`)), 'Failed to load host');
}

export interface BlocklistEntry { name: string; active: number; total: number; unique_values: number }
export interface DecisionOrigin {
  origin: string;
  kind: 'community' | 'subscribed' | 'local';
  active: number;
  total: number;
  unique_values: number;
  lists: BlocklistEntry[];
}
export interface BlocklistOverview { origins: DecisionOrigin[]; manageable: false }

export async function fetchBlocklists(): Promise<BlocklistOverview> {
  return readJson<BlocklistOverview>(await sessionFetch(apiUrl('/api/blocklists')), 'Failed to load blocklists');
}

export interface LiveFeedAlert {
  id: number;
  created_at: string;
  scenario: string | null;
  source_ip: string | null;
  country: string | null;
  as_name: string | null;
  latitude: number | null;
  longitude: number | null;
  target: string | null;
  machine: string | null;
}
export interface LiveFeedSnapshot {
  server_time: string;
  alerts: LiveFeedAlert[];
  last_hour: number;
  last_24h: number;
  top_countries: HostCount[];
  top_scenarios: HostCount[];
}

export async function fetchLiveFeed(limit = 30): Promise<LiveFeedSnapshot> {
  return readJson<LiveFeedSnapshot>(await sessionFetch(apiUrl(`/api/live-feed?limit=${limit}`), { cache: 'no-store' }), 'Failed to load the live feed');
}

export interface ReportSummary {
  period: { from: string; to: string; label: string };
  generated_at: string;
  total_alerts: number;
  unique_sources: number;
  decisions_created: number;
  active_decisions: number;
  repeat_offenders: number;
  daily: Array<{ date: string; count: number }>;
  top_scenarios: HostCount[];
  top_countries: HostCount[];
  top_sources: HostCount[];
  top_machines: HostCount[];
}

export type ReportSelection = { days: number } | { month: string };

function reportQuery(selection: ReportSelection): string {
  return 'month' in selection ? `month=${encodeURIComponent(selection.month)}` : `days=${selection.days}`;
}

export async function fetchReport(selection: ReportSelection): Promise<ReportSummary> {
  return readJson<ReportSummary>(await sessionFetch(apiUrl(`/api/report?${reportQuery(selection)}`)), 'Failed to build the report');
}

export async function downloadReportPdf(selection: ReportSelection): Promise<void> {
  const response = await sessionFetch(apiUrl(`/api/report.pdf?${reportQuery(selection)}`));
  if (!response.ok) await readJson<unknown>(response, 'Failed to build the report');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'month' in selection ? `security-report-${selection.month}.pdf` : `security-report-${selection.days}d.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface AutoBanRule {
  id?: string;
  name: string;
  scenario: string;
  min_alerts: number;
  window_minutes: number;
  duration: string;
  escalate: boolean;
}
export interface AutoBanSettings { enabled: boolean; dry_run: boolean; rules: AutoBanRule[] }
export interface AutoBanLogEntry {
  id: number;
  at: string;
  rule_id: string;
  rule_name: string;
  ip: string;
  action: 'would_ban' | 'banned' | 'skipped_allowlisted' | 'failed';
  duration: string | null;
  alerts: number;
  detail: string | null;
}
export interface AutoBanCandidate { ip: string; alerts: number; duration: string; previous_bans: number }

export async function fetchAutoBan(): Promise<{ settings: AutoBanSettings; log: AutoBanLogEntry[] }> {
  return readJson(await sessionFetch(apiUrl('/api/auto-ban')), 'Failed to load auto-ban rules');
}

export async function saveAutoBan(settings: AutoBanSettings): Promise<AutoBanSettings> {
  return (await readJson<{ settings: AutoBanSettings }>(await sessionFetch(apiUrl('/api/auto-ban'), {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(settings),
  }), 'Failed to save auto-ban rules')).settings;
}

export async function previewAutoBan(): Promise<Array<{ rule_id: string; rule_name: string; candidates: AutoBanCandidate[] }>> {
  return (await readJson<{ rules: Array<{ rule_id: string; rule_name: string; candidates: AutoBanCandidate[] }> }>(
    await sessionFetch(apiUrl('/api/auto-ban/preview'), { method: 'POST' }), 'Failed to preview',
  )).rules;
}

export interface AuditEvent {
  id: number;
  time: string;
  user: string;
  role: string | null;
  action: string;
  outcome: string;
  target: string | null;
  details: Record<string, unknown>;
}

export interface AuditFilters { user?: string; action?: string; outcome?: string; q?: string; from?: string; to?: string; target?: string }

export interface AuditPage {
  data: AuditEvent[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  users?: string[];
  actions?: string[];
}

export async function fetchAuditLog(filters: AuditFilters, page: number, pageSize = 50): Promise<AuditPage> {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  return readJson<AuditPage>(await sessionFetch(apiUrl(`/api/audit-log?${query}`)), 'Failed to load the audit log');
}

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';
export interface ThreatFactor { key: 'volume' | 'severity' | 'repeat' | 'reputation'; points: number; max: number; value: number | null }
export interface ThreatScore { ip: string; score: number; level: ThreatLevel; factors: ThreatFactor[]; reputation_available: boolean }

export async function fetchThreatScore(ip: string): Promise<ThreatScore> {
  return readJson<ThreatScore>(await sessionFetch(apiUrl(`/api/threat-score?${new URLSearchParams({ ip })}`)), 'Failed to load the threat score');
}

export async function fetchThreatScores(ips: string[]): Promise<ThreatScore[]> {
  if (ips.length === 0) return [];
  const query = new URLSearchParams({ ips: ips.join(',') });
  return (await readJson<{ scores: ThreatScore[] }>(await sessionFetch(apiUrl(`/api/threat-scores?${query}`)), 'Failed to load threat scores')).scores;
}

export type TimelineKind = 'alert' | 'decision' | 'note' | 'audit';
export interface TimelineEvent {
  kind: TimelineKind;
  time: string;
  title: string;
  instance: string | null;
  machine: string | null;
  detail: Record<string, string | number | boolean | null>;
}
export interface IpTimeline {
  ip: string;
  events: TimelineEvent[];
  counts: Record<TimelineKind, number>;
  machines: string[];
  instances: string[];
  truncated: boolean;
  audit_included: boolean;
}

export async function fetchIpTimeline(ip: string): Promise<IpTimeline> {
  return readJson<IpTimeline>(await sessionFetch(apiUrl(`/api/ip-timeline?${new URLSearchParams({ ip })}`)), 'Failed to load the timeline');
}

export interface AsnSummary {
  asn: string;
  name: string | null;
  alerts: number;
  unique_ips: number;
  last_seen: string;
  countries: Array<{ code: string; count: number }>;
  scenarios: Array<{ name: string; count: number }>;
  ranges: Array<{ range: string; count: number }>;
}
export interface AsnList { asns: AsnSummary[]; unknown_alerts: number; days: number }
export interface AsnIp { ip: string; alerts: number; last_seen: string; country: string | null; scenarios: string[]; banned_now: boolean }
export interface AsnDetail {
  asn: string;
  name: string | null;
  alerts: number;
  unique_ips: number;
  ips: AsnIp[];
  ranges: Array<{ range: string; count: number }>;
  scenarios: Array<{ name: string; count: number }>;
  truncated: boolean;
}

export async function fetchAsns(days: number): Promise<AsnList> {
  return readJson<AsnList>(await sessionFetch(apiUrl(`/api/asn?${new URLSearchParams({ days: String(days) })}`)), 'Failed to load networks');
}

export async function fetchAsnDetail(asn: string, days: number): Promise<AsnDetail> {
  return readJson<AsnDetail>(await sessionFetch(apiUrl(`/api/asn/${encodeURIComponent(asn)}?${new URLSearchParams({ days: String(days) })}`)), 'Failed to load the network');
}

export type HubItemType = 'scenarios' | 'collections' | 'parsers' | 'postoverflows';
export interface HubItem {
  type: HubItemType;
  name: string;
  version: string;
  description: string;
  installed: boolean;
  upgradable: boolean;
  local: boolean;
  tainted: boolean;
}
export type HubServerState = 'detected' | 'pending' | 'paired' | 'error';
export interface HubServer {
  /** Null for a machine that was only detected. */
  id: string | null;
  name: string;
  machine: string | null;
  status: HubServerState;
  source: 'env' | 'pairing' | null;
  transport: 'ssh' | 'command' | null;
  host: string | null;
  port: number | null;
  ssh_user: string | null;
  mode: 'docker' | 'native' | null;
  host_key_fingerprint: string | null;
  last_check_at: string | null;
  last_error: string | null;
  pending_reload: boolean;
  profile: string | null;
  apply_profile: boolean;
  paired_at: string | null;
  pairing_expired: boolean;
  pairing_expires_at: string | null;
}
export interface HubProfile { id: string; items: Array<{ type: HubItemType; name: string }> }
export interface HubServers {
  servers: HubServer[];
  can_manage: boolean;
  profiles: HubProfile[];
  pairing_ttl_minutes: number;
  uninstall_command: string;
  config_error: string | null;
}
export interface HubStatus {
  server: HubServer | null;
  executor: { state: 'disabled' | 'ready'; config_error: string | null };
  can_manage: boolean;
  pending_reload: boolean;
  catalog: Record<HubItemType, HubItem[]> | null;
  catalog_error: string | null;
  seen_scenarios: Array<{ name: string; alerts: number; installed: boolean | null }>;
}
export type HubAction =
  | { action: 'update' }
  | { action: 'upgrade-all' }
  | { action: 'install'; type: HubItemType; name: string }
  | { action: 'remove'; type: HubItemType; name: string }
  | { action: 'upgrade'; type: HubItemType; name: string };
export interface HubServerResult { server: string; name: string; ok: boolean; output: string }
export interface HubActionResult { ok: boolean; results: HubServerResult[] }
export interface HubPairing {
  server: HubServer;
  token_expires_at: string;
  command: string;
  uninstall_command: string;
}

export function fetchHubServers(): Promise<HubServers> {
  return sessionFetch(apiUrl('/api/hub/servers')).then((response) => readJson<HubServers>(response, 'Failed to load the servers'));
}

export async function fetchHub(server?: string): Promise<HubStatus> {
  const query = server ? `?${new URLSearchParams({ server })}` : '';
  return readJson<HubStatus>(await sessionFetch(apiUrl(`/api/hub${query}`)), 'Failed to load the hub');
}

async function sendHub<T>(method: string, path: string, body: unknown, fallback: string): Promise<T> {
  const response = await sessionFetch(apiUrl(path), {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!payload || (payload.error && typeof payload.error === 'string')) throw new Error(payload?.error ?? fallback);
  return payload;
}

/** The server only runs an operation that is sent with confirm: true, so every call here is a confirmed one. */
export function runHubAction(action: HubAction, servers: string[]): Promise<HubActionResult> {
  return sendHub<HubActionResult>('POST', '/api/hub/action', { ...action, servers, confirm: true }, 'The hub request failed');
}

export function reloadCrowdsec(servers: string[]): Promise<HubActionResult> {
  return sendHub<HubActionResult>('POST', '/api/hub/reload', { servers, confirm: true }, 'The hub request failed');
}

export function applyHubProfile(profile: string, servers: string[]): Promise<HubActionResult> {
  return sendHub<HubActionResult>('POST', '/api/hub/profile', { profile, servers, confirm: true }, 'The hub request failed');
}

export function startHubPairing(input: { machine: string; name?: string; from?: string; profile?: string; applyProfile?: boolean }): Promise<HubPairing> {
  return sendHub<HubPairing>('POST', '/api/hub/servers/pair', {
    machine: input.machine,
    ...(input.name ? { name: input.name } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.profile ? { profile: input.profile, apply_profile: input.applyProfile === true } : {}),
  }, 'Could not create the pairing command');
}

export function removeHubServer(id: string): Promise<{ ok: boolean; uninstall_command: string }> {
  return sendHub('DELETE', `/api/hub/servers/${encodeURIComponent(id)}`, undefined, 'Could not remove the server');
}

export function checkHubServer(id: string): Promise<{ ok: boolean; error: string | null; server: HubServer }> {
  return sendHub('POST', `/api/hub/servers/${encodeURIComponent(id)}/check`, undefined, 'The connection check failed');
}
