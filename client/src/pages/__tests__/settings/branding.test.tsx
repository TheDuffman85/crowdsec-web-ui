import './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig } from '../../../lib/api';
import { BrandingContext, type BrandingContextValue } from '../../../contexts/branding-context';
import { ToastContext } from '../../../contexts/toast-context';
import type { ConfigResponse } from '../../../types';

const adminPermissions = { mode: 'admin', can_manage_enforcement: true, can_manage_settings: true } as const;

function mockAdminConfig() {
  vi.mocked(fetchConfig).mockResolvedValue({
    lookback_period: '1h',
    lookback_hours: 1,
    lookback_days: 1,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
    machine_features_enabled: false,
    origin_features_enabled: false,
    permissions: adminPermissions,
  } as ConfigResponse);
}

function renderSettings(branding: Partial<BrandingContextValue> = {}) {
  const setBranding = vi.fn();
  const addToast = vi.fn();
  const value: BrandingContextValue = {
    appName: 'CrowdSec Web UI',
    defaultAppName: 'CrowdSec Web UI',
    logoUrl: null,
    setBranding,
    refreshBranding: vi.fn(),
    ...branding,
  };
  render(
    <ToastContext.Provider value={{ toasts: [], addToast, removeToast: vi.fn() }}>
      <BrandingContext.Provider value={value}>
        <Settings />
      </BrandingContext.Provider>
    </ToastContext.Provider>,
  );
  return { setBranding, addToast };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Settings branding', () => {
  test('disables branding controls for read-only users', async () => {
    renderSettings({ appName: 'Acme SOC', logoUrl: '/api/branding/logo?v=1' });
    await waitFor(() => expect(fetchConfig).toHaveBeenCalled());

    expect(screen.getByLabelText('pages.settings.appName')).toHaveValue('Acme SOC');
    expect(screen.getByLabelText('pages.settings.appName')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'pages.settings.saveAppName' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'pages.settings.uploadLogo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'pages.settings.resetLogo' })).toBeDisabled();
    expect(screen.getByText('pages.settings.readOnlyBranding')).toBeInTheDocument();
  });

  test('saves the application name', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const saved = { appName: 'Acme SOC', defaultAppName: 'CrowdSec Web UI', logoUrl: null };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(saved));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings();
    await waitFor(() => expect(screen.getByLabelText('pages.settings.appName')).toBeEnabled());

    expect(screen.getByLabelText('pages.settings.appName')).toHaveValue('');
    expect(screen.getByLabelText('pages.settings.appName')).toHaveAttribute('placeholder', 'CrowdSec Web UI');
    expect(screen.getByRole('button', { name: 'pages.settings.saveAppName' })).toBeDisabled();

    await user.type(screen.getByLabelText('pages.settings.appName'), 'Acme SOC');
    await user.click(screen.getByRole('button', { name: 'pages.settings.saveAppName' }));

    await waitFor(() => expect(setBranding).toHaveBeenCalledWith(saved));
    expect(fetchMock).toHaveBeenCalledWith('/api/branding', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ appName: 'Acme SOC' }),
    }));
    expect(addToast).toHaveBeenCalledWith('pages.settings.appNameSaved', 'success');
  });

  test('uploads a logo and rejects unsupported or oversized files before uploading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    mockAdminConfig();
    const uploaded = { appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: '/api/branding/logo?v=abc' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(uploaded));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings();
    await waitFor(() => expect(screen.getByRole('button', { name: 'pages.settings.uploadLogo' })).toBeEnabled());
    const input = screen.getByTestId('settings-logo-input');

    await user.upload(input, new File(['%PDF'], 'logo.pdf', { type: 'application/pdf' }));
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.logoUnsupportedType', 'danger');

    await user.upload(input, new File([new Uint8Array(512 * 1024 + 1)], 'logo.png', { type: 'image/png' }));
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.logoTooLarge', 'danger');
    expect(fetchMock).not.toHaveBeenCalled();

    await user.upload(input, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' }));
    await waitFor(() => expect(setBranding).toHaveBeenCalledWith(uploaded));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/branding/logo');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ dataUrl: 'data:image/png;base64,iVBORw==' });
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.logoUpdated', 'success');
  });

  test('restores the default logo and surfaces server errors', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Database is busy' }, 500))
      .mockResolvedValueOnce(jsonResponse({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings({ appName: 'Acme', logoUrl: '/api/branding/logo?v=abc' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'pages.settings.resetLogo' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'pages.settings.resetLogo' }));
    await waitFor(() => expect(addToast).toHaveBeenLastCalledWith('Database is busy', 'danger'));
    expect(setBranding).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'pages.settings.resetLogo' }));
    await waitFor(() => expect(setBranding).toHaveBeenCalledWith({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/branding/logo', { method: 'DELETE' });
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.logoReset', 'success');
  });
});
