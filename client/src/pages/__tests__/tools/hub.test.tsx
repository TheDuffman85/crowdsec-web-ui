import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { hubCommand } from '../../../lib/hubCommands';
import { Hub } from '../../tools/Hub';

const mocks = vi.hoisted(() => ({
  fetchHub: vi.fn(), fetchHubServers: vi.fn(), runHubAction: vi.fn(), reloadCrowdsec: vi.fn(), applyHubProfile: vi.fn(),
  startHubPairing: vi.fn(), removeHubServer: vi.fn(), checkHubServer: vi.fn(),
}));
vi.mock('../../../lib/insightsApi', () => mocks);

const item = (overrides: Record<string, unknown>) => ({ type: 'scenarios', name: 'x/y', version: '', description: '', installed: false, upgradable: false, local: false, tainted: false, ...overrides });
const catalog = {
  scenarios: [
    item({ name: 'crowdsecurity/ssh-bf', version: '0.3', description: 'Detect ssh bruteforce', installed: true }),
    item({ name: 'crowdsecurity/old', version: '0.1', installed: true, upgradable: true }),
    item({ name: 'crowdsecurity/http-probing', description: 'Probing' }),
  ],
  collections: [item({ type: 'collections', name: 'crowdsecurity/linux', version: '0.2', installed: true, tainted: true })],
  parsers: [item({ type: 'parsers', name: 'locke/local-trusted-whitelist', installed: true, local: true })],
  postoverflows: [],
};
// The second server has not installed http-probing yet and is missing crowdsecurity/old.
const catalogWp = {
  ...catalog,
  scenarios: [
    item({ name: 'crowdsecurity/ssh-bf', version: '0.3', description: 'Detect ssh bruteforce', installed: true }),
    item({ name: 'crowdsecurity/http-probing', description: 'Probing', installed: true, version: '0.1' }),
  ],
};
const server = (overrides: Record<string, unknown>) => ({
  id: null, name: 'x', machine: 'x', status: 'detected', source: null, transport: null, host: null, port: null, ssh_user: null, mode: null,
  host_key_fingerprint: null, last_check_at: null, last_error: null, pending_reload: false, profile: null, apply_profile: false, paired_at: null,
  pairing_expired: false, pairing_expires_at: null, ...overrides,
});
const loki = server({ id: 'env', name: 'Loki', machine: null, status: 'paired', source: 'env', transport: 'ssh', host: '192.168.0.155', port: 155, ssh_user: 'roffo', mode: null, last_check_at: '2026-11-20T10:00:00Z' });
const wp = server({ id: 'm-wp', name: 'Roftwares-WP01', machine: 'Roftwares-WP01', status: 'paired', source: 'pairing', transport: 'ssh', host: '10.0.0.2', port: 22, ssh_user: 'cshub', mode: 'docker', host_key_fingerprint: 'SHA256:abc' });
const rmm = server({ name: 'RMM', machine: 'RMM' });
const pendingServer = server({ id: 'm-nt', name: 'NT-APP01', machine: 'NT-APP01', status: 'pending', source: 'pairing', pairing_expires_at: '2099-01-01T00:00:00Z' });
const profiles = [
  { id: 'web', items: [{ type: 'collections', name: 'crowdsecurity/nginx' }] },
  { id: 'linux', items: [{ type: 'collections', name: 'crowdsecurity/linux' }, { type: 'collections', name: 'crowdsecurity/sshd' }] },
];
const serversResponse = (list: unknown[], overrides: Record<string, unknown> = {}) => ({
  servers: list, can_manage: true, profiles, pairing_ttl_minutes: 15, uninstall_command: 'sudo /usr/local/lib/crowdsec-hub/uninstall.sh', config_error: null, ...overrides,
});
const status = (id: string, overrides: Record<string, unknown> = {}) => ({
  server: id === 'm-wp' ? wp : loki, executor: { state: 'ready', config_error: null }, can_manage: true, pending_reload: false,
  catalog: id === 'm-wp' ? catalogWp : catalog, catalog_error: null,
  seen_scenarios: [{ name: 'crowdsecurity/ssh-bf', alerts: 12, installed: true }], ...overrides,
});
const readOnlyStatus = {
  server: null, executor: { state: 'disabled', config_error: null }, can_manage: true, pending_reload: false, catalog: null, catalog_error: null,
  seen_scenarios: [{ name: 'crowdsecurity/ssh-bf', alerts: 12, installed: null }, { name: 'crowdsecurity/http-probing', alerts: 3, installed: null }],
};

const open = () => render(<MemoryRouter><Hub /></MemoryRouter>);
let writeText: ReturnType<typeof vi.fn> = vi.fn();
function start() {
  // user-event installs its own clipboard when it is set up, so the spy goes on after that.
  const user = userEvent.setup();
  writeText = vi.spyOn(navigator.clipboard, 'writeText') as unknown as ReturnType<typeof vi.fn>;
  return user;
}
const serverRow = (name: string) => screen.getAllByTestId('hub-server').find((row) => within(row).queryByText(name) !== null)!;

beforeEach(() => {
  mocks.fetchHubServers.mockResolvedValue(serversResponse([loki, wp, rmm, pendingServer]));
  mocks.fetchHub.mockImplementation(async (id?: string) => (id ? status(id) : readOnlyStatus));
});
afterEach(() => vi.clearAllMocks());

describe('hubCommand', () => {
  test('writes the equivalent cscli command', () => {
    expect(hubCommand({ action: 'update' })).toBe('cscli hub update');
    expect(hubCommand({ action: 'upgrade-all' })).toBe('cscli hub upgrade');
    expect(hubCommand({ action: 'install', type: 'scenarios', name: 'a/b' })).toBe('cscli scenarios install a/b');
  });
});

describe('Hub page servers', () => {
  test('lists every machine with its state and only reads the hub of the selected server', async () => {
    open();
    await screen.findAllByTestId('hub-row');
    expect(screen.getByTestId('hub-executor-state')).toHaveTextContent('2 of 4 servers set up');
    const rows = screen.getAllByTestId('hub-server');
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['paired', 'paired', 'detected', 'pending']);
    expect(within(serverRow('RMM')).getByText('Detected, installer not set up')).toBeInTheDocument();
    expect(within(serverRow('RMM')).getByRole('button', { name: 'Set up installer' })).toBeInTheDocument();
    expect(within(serverRow('NT-APP01')).getByText('Waiting for pairing')).toBeInTheDocument();
    expect(within(serverRow('NT-APP01')).getByRole('button', { name: 'New command' })).toBeInTheDocument();
    expect(within(serverRow('Roftwares-WP01')).getByText('CrowdSec in Docker')).toBeInTheDocument();
    expect(within(serverRow('Roftwares-WP01')).getByText('Host key SHA256:abc')).toBeInTheDocument();
    expect(within(serverRow('Loki')).getByText('Set by environment')).toBeInTheDocument();
    expect(within(serverRow('Loki')).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(within(serverRow('Roftwares-WP01')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    // Loki is selected by default; nothing else is contacted.
    expect(mocks.fetchHub.mock.calls.map((call) => call[0])).toEqual(['env']);
    expect(screen.getByLabelText('Select Loki')).toBeChecked();
    expect(screen.getByLabelText('Select Roftwares-WP01')).not.toBeChecked();
    expect(screen.queryByLabelText('Select RMM')).not.toBeInTheDocument();
  });

  test('shows a server in error with its message and checks it on demand', async () => {
    const user = start();
    mocks.fetchHubServers.mockResolvedValue(serversResponse([{ ...wp, status: 'error', last_error: 'Host key verification failed.' }, loki]));
    mocks.checkHubServer.mockResolvedValue({ ok: false, error: 'x', server: wp });
    open();
    await screen.findByText('Host key verification failed.');
    expect(within(serverRow('Roftwares-WP01')).getByText('Connection error')).toBeInTheDocument();
    await user.click(within(serverRow('Roftwares-WP01')).getByRole('button', { name: 'Check connection' }));
    expect(mocks.checkHubServer).toHaveBeenCalledWith('m-wp');
  });

  test('read-only users see the servers but no buttons', async () => {
    mocks.fetchHubServers.mockResolvedValue(serversResponse([loki, wp, rmm], { can_manage: false }));
    open();
    await screen.findAllByTestId('hub-row');
    expect(screen.getByText(/Only administrators can install/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up installer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
  });
});

describe('Hub page catalog', () => {
  test('shows installed items first and filters by status and text', async () => {
    const user = start();
    open();
    await screen.findAllByTestId('hub-row');
    expect(screen.getAllByTestId('hub-row')).toHaveLength(2);
    expect(screen.getByText('12 alerts')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Show'), 'available');
    expect(screen.getAllByTestId('hub-row')).toHaveLength(1);
    expect(screen.getByTestId('hub-row')).toHaveTextContent('http-probing');
    await user.selectOptions(screen.getByLabelText('Show'), 'updates');
    expect(screen.getByTestId('hub-row')).toHaveTextContent('old');
    await user.selectOptions(screen.getByLabelText('Show'), 'all');
    await user.type(screen.getByLabelText('Search the hub'), 'probing');
    expect(screen.getAllByTestId('hub-row')).toHaveLength(1);
    await user.clear(screen.getByLabelText('Search the hub'));
    await user.type(screen.getByLabelText('Search the hub'), 'zzzz');
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
  });

  test('switches type and marks local and edited items', async () => {
    const user = start();
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(screen.getByRole('tab', { name: /Collections/ }));
    expect(screen.getByText('Edited locally')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Parsers/ }));
    expect(screen.getByText('Local file')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });

  test('selecting a second server adds its state to every row', async () => {
    const user = start();
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(screen.getByLabelText('Select Roftwares-WP01'));
    await waitFor(() => expect(mocks.fetchHub).toHaveBeenCalledWith('m-wp'));
    await user.selectOptions(screen.getByLabelText('Show'), 'all');
    await waitFor(() => expect(screen.getAllByTestId('hub-item-state').length).toBeGreaterThan(3));
    const probing = screen.getAllByTestId('hub-row').find((row) => row.textContent?.includes('http-probing'))!;
    const states = within(probing).getAllByTestId('hub-item-state');
    expect(states).toHaveLength(2);
    expect(states[0]).toHaveTextContent('Loki');
    expect(states[0]).toHaveTextContent('Not installed');
    expect(states[1]).toHaveTextContent('Roftwares-WP01');
    expect(states[1]).toHaveTextContent('Installed');
    expect(states[1]).toHaveTextContent('v0.1');
    // crowdsecurity/old only exists on Loki.
    const old = screen.getAllByTestId('hub-row').find((row) => row.textContent?.includes('old'))!;
    expect(within(old).getAllByTestId('hub-item-state')[1]).toHaveTextContent('–');
  });

  test('asks for confirmation naming the servers, then reports each server separately', async () => {
    const user = start();
    mocks.runHubAction.mockResolvedValue({ ok: false, results: [
      { server: 'env', name: 'Loki', ok: true, output: 'installed crowdsecurity/http-probing' },
      { server: 'm-wp', name: 'Roftwares-WP01', ok: false, output: 'ssh: connection refused' },
    ] });
    // On both servers the item is missing, so the install button applies to both.
    mocks.fetchHub.mockImplementation(async (id?: string) => status(id ?? 'env', { catalog: { ...catalog, scenarios: [item({ name: 'crowdsecurity/http-probing' })] } }));
    open();
    await screen.findByLabelText('Show');
    await user.click(screen.getByLabelText('Select Roftwares-WP01'));
    await waitFor(() => expect(mocks.fetchHub).toHaveBeenCalledWith('m-wp'));
    await user.selectOptions(screen.getByLabelText('Show'), 'available');
    const button = await screen.findByRole('button', { name: 'Install crowdsecurity/http-probing' });
    expect(button).toHaveTextContent('Install (2)');
    await user.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('cscli scenarios install crowdsecurity/http-probing')).toBeInTheDocument();
    expect(within(within(dialog).getByTestId('hub-targets')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Loki', 'Roftwares-WP01']);
    expect(mocks.runHubAction).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.runHubAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Install crowdsecurity/http-probing' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(mocks.runHubAction).toHaveBeenCalledWith({ action: 'install', type: 'scenarios', name: 'crowdsecurity/http-probing' }, ['env', 'm-wp']));
    expect(await screen.findByText('Partly done:')).toBeInTheDocument();
    const results = screen.getAllByTestId('hub-server-result');
    expect(results[0]).toHaveTextContent('LokiSucceeded');
    expect(results[1]).toHaveTextContent('Roftwares-WP01Failed');
    expect(results[1]).toHaveTextContent('ssh: connection refused');
    expect(mocks.reloadCrowdsec).not.toHaveBeenCalled();
  });

  test('the item action only targets servers where it makes sense', async () => {
    const user = start();
    mocks.runHubAction.mockResolvedValue({ ok: true, results: [{ server: 'env', name: 'Loki', ok: true, output: '' }] });
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(screen.getByLabelText('Select Roftwares-WP01'));
    await waitFor(() => expect(mocks.fetchHub).toHaveBeenCalledWith('m-wp'));
    await user.selectOptions(screen.getByLabelText('Show'), 'all');
    await waitFor(() => expect(screen.getAllByTestId('hub-item-state').length).toBeGreaterThan(3));
    // Only Loki lacks http-probing, so installing it targets Loki alone.
    const probing = screen.getAllByTestId('hub-row').find((row) => row.textContent?.includes('http-probing'))!;
    await user.click(within(probing).getByRole('button', { name: 'Install crowdsecurity/http-probing' }));
    expect(within(await screen.findByTestId('hub-targets')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Loki']);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(mocks.runHubAction).toHaveBeenCalledWith({ action: 'install', type: 'scenarios', name: 'crowdsecurity/http-probing' }, ['env']));
  });

  test('reports a failed action and an error thrown by the request, and confirms the hub update', async () => {
    const user = start();
    mocks.runHubAction.mockResolvedValueOnce({ ok: false, results: [{ server: 'env', name: 'Loki', ok: false, output: 'boom' }] });
    mocks.runHubAction.mockRejectedValueOnce(new Error('Administrator access required'));
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(screen.getByRole('button', { name: 'Remove crowdsecurity/ssh-bf' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Failed:')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update hub index' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update index' }));
    expect(await screen.findByText('Administrator access required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Upgrade all' }));
    expect(within(await screen.findByRole('dialog')).getByText('cscli hub upgrade')).toBeInTheDocument();
  });

  test('read-only users get copyable commands instead of buttons', async () => {
    const user = start();
    mocks.fetchHubServers.mockResolvedValue(serversResponse([loki], { can_manage: false }));
    open();
    await screen.findAllByTestId('hub-row');
    expect(screen.queryByRole('button', { name: 'Remove crowdsecurity/ssh-bf' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy the Remove command for crowdsecurity/ssh-bf' }));
    expect(writeText).toHaveBeenCalledWith('cscli scenarios remove crowdsecurity/ssh-bf');
  });

  test('shows a catalog error for the server that failed while keeping the page usable', async () => {
    mocks.fetchHub.mockImplementation(async (id?: string) => status(id ?? 'env', { catalog: null, catalog_error: 'ssh: connection refused' }));
    open();
    expect(await screen.findByText('The hub could not be read: Loki: ssh: connection refused')).toBeInTheDocument();
    expect(screen.getByTestId('hub-servers')).toBeInTheDocument();
  });
});

describe('Hub page reload and profiles', () => {
  const pendingLoki = { ...loki, pending_reload: true };
  const pendingWp = { ...wp, pending_reload: true };

  test('a reload is chosen per server and only sent after the confirmation dialog', async () => {
    const user = start();
    mocks.fetchHubServers.mockResolvedValue(serversResponse([pendingLoki, pendingWp, wp === wp ? rmm : rmm]));
    mocks.reloadCrowdsec.mockResolvedValue({ ok: true, results: [{ server: 'm-wp', name: 'Roftwares-WP01', ok: true, output: '' }] });
    open();
    expect(await screen.findByTestId('hub-pending-reload')).toHaveTextContent('Loki, Roftwares-WP01');
    await user.click(screen.getByRole('button', { name: 'Reload CrowdSec…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Detection pauses for a few seconds');
    expect(mocks.reloadCrowdsec).not.toHaveBeenCalled();
    const boxes = within(within(dialog).getByTestId('hub-reload-servers')).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: /Loki/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Reload now' }));
    await waitFor(() => expect(mocks.reloadCrowdsec).toHaveBeenCalledWith(['m-wp']));
    expect(mocks.reloadCrowdsec).toHaveBeenCalledTimes(1);
  });

  test('a reload cannot be confirmed with no server chosen', async () => {
    const user = start();
    mocks.fetchHubServers.mockResolvedValue(serversResponse([pendingLoki]));
    open();
    await user.click(await screen.findByRole('button', { name: 'Reload CrowdSec…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Loki/ }));
    expect(within(dialog).getByRole('button', { name: 'Reload now' })).toBeDisabled();
  });

  test('read-only users only get the reload command to copy', async () => {
    const user = start();
    mocks.fetchHubServers.mockResolvedValue(serversResponse([pendingLoki], { can_manage: false }));
    open();
    await screen.findByTestId('hub-pending-reload');
    expect(screen.queryByRole('button', { name: 'Reload CrowdSec…' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy the reload command' }));
    expect(writeText).toHaveBeenCalledWith('docker kill --signal=SIGHUP crowdsec');
  });

  test('a starting profile is only applied after it is chosen and confirmed', async () => {
    const user = start();
    mocks.applyHubProfile.mockResolvedValue({ ok: true, results: [{ server: 'env', name: 'Loki', ok: true, output: 'ok: crowdsecurity/linux' }] });
    open();
    await screen.findAllByTestId('hub-row');
    expect(screen.getByRole('button', { name: 'Apply to selected servers' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Starting profiles'), 'linux');
    expect(screen.getByText('The Linux and SSH daemon collections.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply to selected servers' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('crowdsecurity/linux, crowdsecurity/sshd');
    expect(mocks.applyHubProfile).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(mocks.applyHubProfile).toHaveBeenCalledWith('linux', ['env']));
    expect(await screen.findByText('ok: crowdsecurity/linux')).toBeInTheDocument();
  });
});

describe('Hub page pairing and removal', () => {
  const pairing = {
    server: { ...pendingServer, name: 'RMM', machine: 'RMM' },
    token_expires_at: '2099-01-01T10:15:00Z',
    command: 'curl -fsSL http://app:3000/api/hub/pair/abc/install.sh | sudo bash',
    uninstall_command: 'sudo /usr/local/lib/crowdsec-hub/uninstall.sh',
  };

  test('sets up a detected machine with no profile unless one is chosen', async () => {
    const user = start();
    mocks.startHubPairing.mockResolvedValue(pairing);
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(within(serverRow('RMM')).getByRole('button', { name: 'Set up installer' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Nothing on the server changes until you run the command.');
    expect(within(dialog).getByLabelText(/Install the profile as soon as pairing finishes/)).toBeDisabled();
    expect(within(dialog).getByLabelText(/Install the profile as soon as pairing finishes/)).not.toBeChecked();
    expect(mocks.startHubPairing).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Generate command' }));
    await waitFor(() => expect(mocks.startHubPairing).toHaveBeenCalledWith({ machine: 'RMM', name: undefined, from: undefined, profile: undefined, applyProfile: false }));
    const commands = await within(dialog).findAllByTestId('hub-command');
    expect(commands[0]).toHaveTextContent('curl -fsSL http://app:3000/api/hub/pair/abc/install.sh | sudo bash');
    expect(commands[1]).toHaveTextContent('sudo /usr/local/lib/crowdsec-hub/uninstall.sh');
    expect(within(dialog).getByTestId('hub-pair-status')).toHaveTextContent('Waiting for the server to report in…');
    await user.click(within(dialog).getByRole('button', { name: 'Copy the install command' }));
    expect(writeText).toHaveBeenCalledWith(pairing.command);
  });

  test('passes the chosen profile, its opt-in and the app address', async () => {
    const user = start();
    mocks.startHubPairing.mockResolvedValue(pairing);
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(within(serverRow('RMM')).getByRole('button', { name: 'Set up installer' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Address of this Web UI/), '192.168.0.200');
    await user.selectOptions(within(dialog).getByLabelText('Starting profile'), 'web');
    await user.click(within(dialog).getByLabelText(/Install the profile as soon as pairing finishes/));
    await user.click(within(dialog).getByRole('button', { name: 'Generate command' }));
    await waitFor(() => expect(mocks.startHubPairing).toHaveBeenCalledWith({ machine: 'RMM', name: undefined, from: '192.168.0.200', profile: 'web', applyProfile: true }));
  });

  test('shows why a command could not be created', async () => {
    const user = start();
    mocks.startHubPairing.mockRejectedValue(new Error('This server is already set up.'));
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(within(serverRow('RMM')).getByRole('button', { name: 'Set up installer' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Generate command' }));
    expect(await screen.findByText('This server is already set up.')).toBeInTheDocument();
  });

  test('notices when the server has reported in', async () => {
    mocks.startHubPairing.mockResolvedValue(pairing);
    open();
    await screen.findAllByTestId('hub-row');
    fireEvent.click(within(serverRow('RMM')).getByRole('button', { name: 'Set up installer' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Generate command' }));
    await screen.findByTestId('hub-pair-status');
    mocks.fetchHubServers.mockResolvedValue(serversResponse([loki, { ...rmm, id: 'm-nt', status: 'paired', source: 'pairing' }]));
    await waitFor(() => expect(screen.getByTestId('hub-pair-status')).toHaveTextContent('RMM is paired. Its hub is now listed here.'), { timeout: 6000 });
  }, 10000);

  test('removes a paired server after confirmation and prints the uninstall command', async () => {
    const user = start();
    mocks.removeHubServer.mockResolvedValue({ ok: true, uninstall_command: 'sudo /usr/local/lib/crowdsec-hub/uninstall.sh' });
    open();
    await screen.findAllByTestId('hub-row');
    await user.click(within(serverRow('Roftwares-WP01')).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('deletes its SSH key');
    expect(mocks.removeHubServer).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove server' }));
    await waitFor(() => expect(mocks.removeHubServer).toHaveBeenCalledWith('m-wp'));
    expect(await screen.findByText('Roftwares-WP01 was removed. Run this on the server to remove its installer:')).toBeInTheDocument();
    expect(screen.getByTestId('hub-command')).toHaveTextContent('sudo /usr/local/lib/crowdsec-hub/uninstall.sh');
  });
});

describe('Hub page with no server set up', () => {
  beforeEach(() => {
    mocks.fetchHubServers.mockResolvedValue(serversResponse([rmm, pendingServer]));
  });

  test('is read-only and lists the scenarios that raised alerts with copyable commands', async () => {
    const user = start();
    open();
    expect(await screen.findByText('Read-only mode')).toBeInTheDocument();
    expect(screen.getByTestId('hub-executor-state')).toHaveTextContent('0 of 2 servers set up');
    expect(await screen.findAllByTestId('hub-seen-row')).toHaveLength(2);
    expect(mocks.fetchHub).toHaveBeenCalledWith();
    expect(screen.queryByRole('button', { name: 'Update hub index' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy the inspect command for crowdsecurity/http-probing' }));
    expect(writeText).toHaveBeenCalledWith('cscli scenarios inspect crowdsecurity/http-probing');
    await user.click(screen.getByRole('button', { name: 'Copy the reload command' }));
    expect(writeText).toHaveBeenLastCalledWith('docker kill --signal=SIGHUP crowdsec');
    expect(mocks.runHubAction).not.toHaveBeenCalled();
    // The detected machine can still be set up from here.
    expect(within(serverRow('RMM')).getByRole('button', { name: 'Set up installer' })).toBeInTheDocument();
  });

  test('shows a configuration problem and a load failure', async () => {
    mocks.fetchHubServers.mockResolvedValue(serversResponse([], { config_error: 'HUB_EXECUTOR=ssh needs HUB_SSH_HOST' }));
    const { unmount } = open();
    expect(await screen.findByText('HUB_EXECUTOR=ssh needs HUB_SSH_HOST')).toBeInTheDocument();
    unmount();
    mocks.fetchHubServers.mockRejectedValue(new Error('Failed to load the servers'));
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load the servers');
  });
});
