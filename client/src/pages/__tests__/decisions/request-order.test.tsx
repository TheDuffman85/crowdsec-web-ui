import { installControlledIntersectionObserver, createDeferred, toPaginatedDecisions } from './harness';
import { test, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { Decisions } from '../../Decisions';
import * as api from '../../../lib/api';
import type { DecisionListItem, PaginatedResponse } from '../../../types';

const item = (id: number, value: string): DecisionListItem => ({ id, value, created_at: new Date().toISOString(), expired: false, is_duplicate: false, simulated: false, detail: { origin: 'manual', action: 'ban', reason: 'test', country: 'DE', as: 'test', duration: '1h', alert_id: id } });

test('ignores an older filter response after the current results arrive', async () => {
  const old = createDeferred<PaginatedResponse<DecisionListItem>>();

  vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (_page, _size, filters) => filters?.q?.includes('1.2.3.4') ? old.promise : toPaginatedDecisions([item(20, '5.6.7.8')]));
  function Navigate() { const navigate = useNavigate(); return <button onClick={() => navigate('/decisions?q=ip:5.6.7.8')}>Next filter</button>; }
  render(<MemoryRouter initialEntries={['/decisions?q=ip:1.2.3.4']}><Navigate /><Decisions /></MemoryRouter>);
  await waitFor(() => expect(api.fetchDecisionsPaginated).toHaveBeenCalledWith(1, 50, expect.objectContaining({ q: expect.stringContaining('1.2.3.4') })));
  fireEvent.click(screen.getByText('Next filter'));
  await waitFor(() => expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument());
  await act(async () => old.resolve(toPaginatedDecisions([item(10, '1.2.3.4')])));
  expect(within(screen.getByRole('table')).queryByText('1.2.3.4')).not.toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument();
});


test('ignores an old pagination response after changing the filter', async () => {
  const triggerIntersection = installControlledIntersectionObserver();
  const oldPage = createDeferred<PaginatedResponse<DecisionListItem>>();
  const oldRows = Array.from({ length: 51 }, (_, index) => item(index + 1, '1.2.3.4'));
  vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, _size, filters) => {
    if (!filters?.q?.includes('1.2.3.4')) return toPaginatedDecisions([item(100, '5.6.7.8')]);
    return page === 2 ? oldPage.promise : toPaginatedDecisions(oldRows);
  });
  function Navigate() { const navigate = useNavigate(); return <button onClick={() => navigate('/decisions?q=ip:5.6.7.8')}>Next filter</button>; }
  render(<MemoryRouter initialEntries={['/decisions?q=ip:1.2.3.4']}><Navigate /><Decisions /></MemoryRouter>);
  await waitFor(() => expect(within(screen.getByRole('table')).getAllByText('1.2.3.4')).toHaveLength(50));
  act(() => triggerIntersection());
  await waitFor(() => expect(api.fetchDecisionsPaginated).toHaveBeenCalledWith(2, 50, expect.anything()));
  fireEvent.click(screen.getByText('Next filter'));
  await waitFor(() => expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument());
  await act(async () => oldPage.resolve(toPaginatedDecisions(oldRows, 2)));
  expect(within(screen.getByRole('table')).queryByText('1.2.3.4')).not.toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('5.6.7.8')).toBeInTheDocument();
});
