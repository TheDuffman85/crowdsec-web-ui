import { createDefaultConfigResponse } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Decisions } from '../../Decisions';

function configureMultipleInstances() {
  const config = createDefaultConfigResponse();
  vi.mocked(api.fetchConfig).mockResolvedValue({
    ...config,
    instances: ['east', 'west'].map((id) => ({
      id,
      name: id.toUpperCase(),
      lapi_status: config.lapi_status,
      sync_status: config.sync_status,
      prometheus: [],
    })),
  });
}

const renderDecisions = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><Decisions /></MemoryRouter>,
);

describe('shared Add Decision modal on Decisions page', () => {
  test('defaults to the filtered instance, supports all instances, and retries only failures', async () => {
    configureMultipleInstances();
    vi.mocked(api.addDecision)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        results: [
          { instance_id: 'east', instance_name: 'EAST', success: true },
          { instance_id: 'west', instance_name: 'WEST', success: false, error: 'unavailable' },
        ],
        succeeded: 1,
        failed: 1,
      })
      .mockResolvedValueOnce({
        results: [{ instance_id: 'west', instance_name: 'WEST', success: true }],
        succeeded: 1,
        failed: 0,
      });
    renderDecisions('/decisions?instance=east');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Decision' })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    let dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(within(dialog).getByRole('checkbox', { name: 'All instances' })).not.toBeChecked();
    expect(within(dialog).getByText('Current instance: EAST')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.8');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.8', duration: '4h', reason: 'manual', scope: 'instance', instance_id: 'east',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Manual Decision' })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(within(dialog).getByRole('textbox', { name: 'IP / Range' })).toHaveValue('');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.9');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All instances' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9', duration: '4h', reason: 'manual', scope: 'all',
    }));
    dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Failed: WEST');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry failed instances' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenNthCalledWith(3, {
      ip: '203.0.113.9', duration: '4h', reason: 'manual', scope: 'instance', instance_id: 'west',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Manual Decision' })).not.toBeInTheDocument());
  });

  test('keeps All instances selected when the page has no single-instance filter', async () => {
    configureMultipleInstances();
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    renderDecisions('/decisions');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Decision' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    const allInstances = within(dialog).getByRole('checkbox', { name: 'All instances' });
    expect(allInstances).toBeChecked();
    expect(allInstances).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.10', duration: '4h', reason: 'manual', scope: 'all',
    }));
  });
});
