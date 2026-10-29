import './harness';
import { SettingsRouter } from './router';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig } from '../../../lib/api';
import { BrandingContext, type BrandingContextValue } from '../../../contexts/branding-context';
import { ToastContext } from '../../../contexts/toast-context';
import type { ConfigResponse } from '../../../types';
import { DEFAULT_BRANDING_THEME } from '../../../../../shared/branding-theme';

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
    logoDarkUrl: null,
    theme: DEFAULT_BRANDING_THEME,
    setBranding,
    refreshBranding: vi.fn(),
    ...branding,
  };
  render(
    <ToastContext.Provider value={{ toasts: [], addToast, removeToast: vi.fn() }}>
      <BrandingContext.Provider value={value}>
        <SettingsRouter tab="branding"><Settings /></SettingsRouter>
      </BrandingContext.Provider>
    </ToastContext.Provider>,
  );
  return { setBranding, addToast };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Settings branding', () => {
  test('hides branding from read-only users', async () => {
    renderSettings({ appName: 'Acme SOC', logoUrl: '/api/branding/logo?v=1', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    expect(await screen.findByRole('tab', { name: 'pages.settings.account' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'pages.settings.branding' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('pages.settings.appName')).not.toBeInTheDocument();
  });

  test('saves the application name', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const saved = { appName: 'Acme SOC', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(saved));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings();
    await waitFor(() => expect(screen.getByLabelText('pages.settings.appName')).toBeEnabled());

    expect(screen.getByLabelText('pages.settings.appName')).toHaveValue('');
    expect(screen.getByLabelText('pages.settings.appName')).toHaveAttribute('placeholder', 'CrowdSec Web UI');

    await user.type(screen.getByLabelText('pages.settings.appName'), 'Acme SOC');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setBranding).toHaveBeenCalledWith(saved));
    expect(fetchMock).toHaveBeenCalledWith('/api/branding', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ appName: 'Acme SOC' }),
    }));
    // The colors are unchanged, so only the name is saved.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith('Settings saved.', 'success');
  });

  test('uploads a logo and rejects unsupported or oversized files before uploading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    mockAdminConfig();
    const uploaded = { appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: '/api/branding/logo?v=abc', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(uploaded));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings();
    await waitFor(() => expect(within(screen.getByTestId('settings-logo-default')).getByRole('button', { name: 'pages.settings.uploadLogo' })).toBeEnabled());
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
      .mockResolvedValueOnce(jsonResponse({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME }));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings({ appName: 'Acme', logoUrl: '/api/branding/logo?v=abc', logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME });
    await waitFor(() => expect(screen.getByRole('button', { name: 'pages.settings.resetLogo' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'pages.settings.resetLogo' }));
    await waitFor(() => expect(addToast).toHaveBeenLastCalledWith('Database is busy', 'danger'));
    expect(setBranding).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'pages.settings.resetLogo' }));
    await waitFor(() => expect(setBranding).toHaveBeenCalledWith({ appName: 'Acme', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/branding/logo', { method: 'DELETE' });
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.logoReset', 'success');
  });

  test('uploads and removes the dark mode logo independently of the main logo', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const uploaded = {
      appName: 'CrowdSec Web UI',
      defaultAppName: 'CrowdSec Web UI',
      logoUrl: null,
      logoDarkUrl: '/api/branding/logo/dark?v=abc',
      theme: DEFAULT_BRANDING_THEME,
    };
    const removed = { ...uploaded, logoDarkUrl: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(uploaded))
      .mockResolvedValueOnce(jsonResponse(removed));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings();
    await waitFor(() => expect(within(screen.getByTestId('settings-logo-dark')).getByRole('button', { name: 'pages.settings.uploadLogo' })).toBeEnabled());
    expect(within(screen.getByTestId('settings-logo-dark')).queryByRole('button', { name: 'pages.settings.removeLogo' })).not.toBeInTheDocument();

    await user.upload(screen.getByTestId('settings-dark-logo-input'), new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'dark.png', { type: 'image/png' }));
    await waitFor(() => expect(setBranding).toHaveBeenCalledWith(uploaded));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/branding/logo/dark');
    expect(init.method).toBe('PUT');
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.darkLogoUpdated', 'success');
  });

  test('removes an existing dark mode logo', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const removed = { appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: DEFAULT_BRANDING_THEME };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(removed));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings({ logoDarkUrl: '/api/branding/logo/dark?v=abc' });
    await waitFor(() => expect(within(screen.getByTestId('settings-logo-dark')).getByRole('button', { name: 'pages.settings.removeLogo' })).toBeEnabled());
    expect(screen.getByAltText('pages.settings.darkLogoAlt')).toHaveAttribute('src', '/api/branding/logo/dark?v=abc');
    expect(screen.queryByRole('button', { name: 'pages.settings.resetLogo' })).not.toBeInTheDocument();

    await user.click(within(screen.getByTestId('settings-logo-dark')).getByRole('button', { name: 'pages.settings.removeLogo' }));
    await waitFor(() => expect(setBranding).toHaveBeenCalledWith(removed));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/branding/logo/dark', { method: 'DELETE' });
    expect(addToast).toHaveBeenLastCalledWith('pages.settings.darkLogoRemoved', 'success');
  });

  test('edits, previews, and saves the colors for each theme', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const savedTheme = { light: { accent: '#e11d48', neutral: null }, dark: { accent: null, neutral: 'zinc' } };
    const saved = { appName: 'CrowdSec Web UI', defaultAppName: 'CrowdSec Web UI', logoUrl: null, logoDarkUrl: null, theme: savedTheme };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(saved));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings();
    const light = within(await screen.findByTestId('settings-theme-light'));
    const dark = within(screen.getByTestId('settings-theme-dark'));
    await waitFor(() => expect(light.getByLabelText('pages.settings.accentColor')).toBeEnabled());
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(screen.getByRole('button', { name: 'pages.settings.restoreDefaultColors' })).toBeDisabled();
    expect(screen.getByTestId('settings-theme-preview-light').style.getPropertyValue('--color-primary-600')).toBe('#0284c7');

    // Partial hex input is kept as typed but only applied once it is a valid color.
    await user.type(light.getByLabelText('pages.settings.accentColor'), '#e1');
    expect(screen.getByTestId('settings-theme-preview-light').style.getPropertyValue('--color-primary-600')).toBe('#0284c7');
    expect(light.getByLabelText('pages.settings.accentColor')).toHaveValue('#e1');
    await user.type(light.getByLabelText('pages.settings.accentColor'), '1d48');
    expect(screen.getByTestId('settings-theme-preview-light').style.getPropertyValue('--color-primary-600')).toBe('#e11d48');
    // Dark mode inherits the light accent until it gets its own.
    expect(dark.getByLabelText('pages.settings.accentColor')).toHaveAttribute('placeholder', 'pages.settings.sameAsLightMode');
    expect(screen.getByTestId('settings-theme-preview-dark').style.getPropertyValue('--color-primary-600')).toBe('#e11d48');

    await user.selectOptions(dark.getByLabelText('pages.settings.neutralTone'), 'zinc');
    expect(screen.getByTestId('settings-theme-preview-dark').style.getPropertyValue('--color-gray-900')).toBe('oklch(21% 0.006 285.885)');

    await user.click(saveButton);
    await waitFor(() => expect(setBranding).toHaveBeenCalledWith(saved));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/branding/theme');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ theme: savedTheme });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenLastCalledWith('Settings saved.', 'success');
  });

  test('warns about low contrast and restores the default colors', async () => {
    const user = userEvent.setup();
    mockAdminConfig();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Database is busy' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const { setBranding, addToast } = renderSettings({
      theme: { light: { accent: '#16a34a', neutral: 'stone' }, dark: { accent: null, neutral: null } },
    });
    const light = within(await screen.findByTestId('settings-theme-light'));
    await waitFor(() => expect(light.getByLabelText('pages.settings.accentColor')).toBeEnabled());
    expect(light.getByLabelText('pages.settings.accentColor')).toHaveValue('#16a34a');
    expect(light.getByText('pages.settings.lowAccentContrast')).toBeInTheDocument();

    fireEvent.change(light.getByLabelText('pages.settings.accentColorPicker'), { target: { value: '#2563EB' } });
    expect(light.getByLabelText('pages.settings.accentColor')).toHaveValue('#2563eb');
    expect(light.queryByText('pages.settings.lowAccentContrast')).not.toBeInTheDocument();

    await user.click(light.getByRole('button', { name: 'pages.settings.useDefaultAccent' }));
    expect(light.getByLabelText('pages.settings.accentColor')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'pages.settings.restoreDefaultColors' }));
    expect(light.getByLabelText('pages.settings.neutralTone')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(addToast).toHaveBeenLastCalledWith('Database is busy', 'danger'));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ theme: DEFAULT_BRANDING_THEME });
    expect(setBranding).not.toHaveBeenCalled();
  });
});
