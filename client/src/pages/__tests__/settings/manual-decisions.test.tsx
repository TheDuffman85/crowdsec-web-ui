import './harness';
import { SettingsRouter } from './router';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig, updateManualDecisionScenarios } from '../../../lib/api';
import type { ConfigResponse } from '../../../types';

async function mockAdminConfig(settings: ConfigResponse['manual_decision_scenario_settings']) {
  const base = await vi.mocked(fetchConfig).getMockImplementation()?.();
  vi.mocked(fetchConfig).mockResolvedValue({
    ...(base as ConfigResponse),
    manual_decision_scenario_settings: settings,
    permissions: { mode: 'admin', can_manage_enforcement: true, can_manage_settings: true },
  });
}

describe('Settings manual decision scenarios', () => {
  test('locks default and configured scenarios and saves custom ones', async () => {
    const user = userEvent.setup();
    await mockAdminConfig({ configured: ['custom/from-config'], custom: ['custom/old'] });
    vi.mocked(updateManualDecisionScenarios).mockResolvedValue({
      success: true,
      manual_decision_scenario_settings: { configured: ['custom/from-config'], custom: ['custom/new'] },
    });
    render(<SettingsRouter tab="general"><Settings /></SettingsRouter>);

    await waitFor(() => expect(screen.getByText('custom/old')).toBeInTheDocument());
    expect(screen.getByText('manual/web-ui')).toBeInTheDocument();
    expect(screen.getByText('custom/from-config')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove manual/web-ui' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove custom/from-config' })).not.toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Remove custom/old' }));
    await user.type(screen.getByLabelText('Scenarios'), 'not a scenario');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByText('not a scenario', { selector: 'span' })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Scenarios'));
    await user.type(screen.getByLabelText('Scenarios'), ' custom/new {Enter}');
    expect(screen.getByText('custom/new')).toBeInTheDocument();

    await user.click(save);
    await waitFor(() => expect(updateManualDecisionScenarios).toHaveBeenCalledWith({ scenarios: ['custom/new'] }));
  });

  test('hides manual decisions without settings permission', async () => {
    render(<SettingsRouter tab="general"><Settings /></SettingsRouter>);

    expect(await screen.findByRole('tab', { name: 'pages.settings.account' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'General' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scenarios')).not.toBeInTheDocument();
  });
});
