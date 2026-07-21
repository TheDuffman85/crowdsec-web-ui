import { toPaginatedDecisions } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Decisions } from '../../Decisions';

describe('Decisions page actions', () => {
  test('select all excludes expired decisions from bulk delete', async () => {
    vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions([
        {
          id: 10,
          created_at: '2026-03-23T10:00:00.000Z',
          value: '1.2.3.4',
          expired: false,
          is_duplicate: false,
          simulated: false,
          detail: {
            origin: 'CAPI',
            reason: 'crowdsecurity/ssh-bf',
            country: 'DE',
            as: 'Hetzner',
            action: 'ban',
            duration: '4h',
            alert_id: 1,
          },
        },
        {
          id: 30,
          created_at: '2026-03-23T12:00:00.000Z',
          value: '9.9.9.9',
          expired: true,
          is_duplicate: false,
          simulated: false,
          detail: {
            origin: 'CAPI',
            reason: 'crowdsecurity/http-probing',
            country: 'FR',
            as: 'OVH',
            action: 'ban',
            duration: '-5m',
            alert_id: 3,
          },
        },
      ], page, pageSize),
    );
    const bulkDeleteDecisionsMock = vi.mocked(api.bulkDeleteDecisions).mockResolvedValue({
      requested_alerts: 0,
      requested_decisions: 1,
      deleted_alerts: 0,
      deleted_decisions: 1,
      failed: [],
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const deleteSelectedButton = screen.getByRole('button', { name: 'Delete selected' });
    expect(deleteSelectedButton).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all loaded decisions' }));
    expect(deleteSelectedButton).toBeEnabled();
    await userEvent.click(deleteSelectedButton);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bulkDeleteDecisionsMock).toHaveBeenCalledWith(['10']));
  });

  test('delete all for this IP triggers cross-resource cleanup', async () => {
    const cleanupByIpMock = vi.mocked(api.cleanupByIp).mockResolvedValue({
      requested_alerts: 1,
      requested_decisions: 1,
      deleted_alerts: 1,
      deleted_decisions: 1,
      failed: [],
      ip: '1.2.3.4',
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete all alerts and decisions for 1.2.3.4' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(cleanupByIpMock).toHaveBeenCalledWith('1.2.3.4'));
  });

  test('shows add permission guidance inside the add decision modal', async () => {
    const permissionError = Object.assign(new Error('Permission denied.'), {
      helpLink: 'https://github.com/TheDuffman85/crowdsec-web-ui#trusted-ips-for-delete-operations-optional',
      helpText: 'Trusted IPs for Write Operations',
    });
    vi.mocked(api.addDecision).mockRejectedValueOnce(permissionError);

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    let addDialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    const ipInput = within(addDialog).getByPlaceholderText('1.2.3.4');
    await userEvent.type(ipInput, '203.0.113.10');
    await userEvent.click(within(addDialog).getByRole('button', { name: 'Add Decision' }));

    addDialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    const modalAlert = await within(addDialog).findByRole('alert');
    expect(modalAlert).toHaveTextContent('Permission denied.');
    expect(within(modalAlert).getByRole('link', { name: 'Trusted IPs for Write Operations' })).toHaveAttribute(
      'href',
      'https://github.com/TheDuffman85/crowdsec-web-ui#trusted-ips-for-delete-operations-optional',
    );
    expect(within(addDialog).getByPlaceholderText('1.2.3.4')).toHaveValue('203.0.113.10');
  });

  test('shows delete permission guidance inside the confirmation modal', async () => {
    const permissionError = Object.assign(new Error('Permission denied.'), {
      helpLink: 'https://github.com/TheDuffman85/crowdsec-web-ui#trusted-ips-for-delete-operations-optional',
      helpText: 'Trusted IPs for Delete Operations',
    });
    vi.mocked(api.deleteDecision).mockRejectedValueOnce(permissionError);

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getAllByTitle('Delete Decision')[0]);
    let deleteDialog = screen.getByRole('dialog', { name: 'Delete Decision?' });
    await userEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }));

    deleteDialog = screen.getByRole('dialog', { name: 'Delete Decision?' });
    const modalAlert = await within(deleteDialog).findByRole('alert');
    expect(modalAlert).toHaveTextContent('Permission denied.');
    expect(within(modalAlert).getByRole('link', { name: 'Trusted IPs for Delete Operations' })).toHaveAttribute(
      'href',
      'https://github.com/TheDuffman85/crowdsec-web-ui#trusted-ips-for-delete-operations-optional',
    );
  });
});
