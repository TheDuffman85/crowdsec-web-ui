import { installControlledIntersectionObserver, createDeferred, toPaginatedAlerts } from './harness';
import { test, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { Alerts } from '../../Alerts';
import * as api from '../../../lib/api';
import type { SlimAlert, PaginatedResponse } from '../../../types';

const item = (id: number, value: string): SlimAlert => ({ id, created_at: new Date().toISOString(), scenario: 'test', meta_search: '', source: { ip: value, value }, simulated: false, decisions: [] });

test('ignores an older filter response after the current results arrive', async () => {
  const old = createDeferred<PaginatedResponse<SlimAlert>>();

  vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (_page, _size, filters) => filters?.q?.includes('1.2.3.4') ? old.promise : toPaginatedAlerts([item(20, '5.6.7.8')]));
  function Navigate() { const navigate = useNavigate(); return <button onClick={() => navigate('/alerts?q=ip:5.6.7.8')}>Next filter</button>; }
  render(<MemoryRouter initialEntries={['/alerts?q=ip:1.2.3.4']}><Navigate /><Alerts /></MemoryRouter>);
  await waitFor(() => expect(api.fetchAlertsPaginated).toHaveBeenCalledWith(1, 50, expect.objectContaining({ q: expect.stringContaining('1.2.3.4') })));
  fireEvent.click(screen.getByText('Next filter'));
  await waitFor(() => expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument());
  await act(async () => old.resolve(toPaginatedAlerts([item(10, '1.2.3.4')])));
  expect(within(screen.getByRole('table')).queryByText('1.2.3.4')).not.toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument();
});


test('ignores an old pagination response after changing the filter', async () => {
  const triggerIntersection = installControlledIntersectionObserver();
  const oldPage = createDeferred<PaginatedResponse<SlimAlert>>();
  const oldRows = Array.from({ length: 51 }, (_, index) => item(index + 1, '1.2.3.4'));
  vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, _size, filters) => {
    if (!filters?.q?.includes('1.2.3.4')) return toPaginatedAlerts([item(100, '5.6.7.8')]);
    return page === 2 ? oldPage.promise : toPaginatedAlerts(oldRows);
  });
  function Navigate() { const navigate = useNavigate(); return <button onClick={() => navigate('/alerts?q=ip:5.6.7.8')}>Next filter</button>; }
  render(<MemoryRouter initialEntries={['/alerts?q=ip:1.2.3.4']}><Navigate /><Alerts /></MemoryRouter>);
  await waitFor(() => expect(within(screen.getByRole('table')).getAllByText('1.2.3.4')).toHaveLength(50));
  act(() => triggerIntersection());
  await waitFor(() => expect(api.fetchAlertsPaginated).toHaveBeenCalledWith(2, 50, expect.anything()));
  fireEvent.click(screen.getByText('Next filter'));
  await waitFor(() => expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument());
  await act(async () => oldPage.resolve(toPaginatedAlerts(oldRows, 2)));
  expect(within(screen.getByRole('table')).queryByText('1.2.3.4')).not.toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument();
});
