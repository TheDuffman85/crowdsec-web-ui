import { createDeferred, flushDecisionSearchDebounce, installControlledIntersectionObserver, setRefreshSignalMock, toPaginatedDecisions } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Decisions } from '../../Decisions';
import { type DecisionListItem, type PaginatedResponse } from '../../../types';

describe('Decisions page search and pagination', () => {
  test('shows inline syntax errors while keeping the previous decision results visible', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Filter decisions...');
    fireEvent.change(input, { target: { value: 'origin:(manual OR' } });
    await flushDecisionSearchDebounce();

    await waitFor(() => expect(screen.getByText(/Search syntax error at character/i)).toBeInTheDocument());
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.getByText('5.6.7.8')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-search-highlight-error="true"]').length).toBeGreaterThan(0);
  });

  test('opens the search syntax help modal', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));

    expect(screen.getByRole('dialog', { name: 'Decision Search Syntax' })).toBeInTheDocument();
    expect(screen.getByText('status:active AND action:ban')).toBeInTheDocument();
    expect(screen.getByText('alert:1 OR ip:"1.2.3.4"')).toBeInTheDocument();
    expect(screen.getByText('target:ssh AND sim:live')).toBeInTheDocument();
    expect(screen.queryByText(/origin:\(/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/machine:/i)).not.toBeInTheDocument();
  });

  test('clicking a syntax example fills the search input', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: /status:active AND action:ban/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('Filter decisions...')).toHaveValue('status:active AND action:ban'));
  });

  test('applies an initial advanced search URL query on the first decision load', async () => {
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated);
    fetchDecisionsPaginatedMock.mockClear();

    render(
      <MemoryRouter initialEntries={['/decisions?q=country:germany']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDecisionsPaginatedMock).toHaveBeenCalled());
    expect(fetchDecisionsPaginatedMock.mock.calls[0]?.[2]).toMatchObject({ q: 'country:germany' });
    await waitFor(() => expect(screen.getByPlaceholderText('Filter decisions...')).toHaveValue('country:germany'));
    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
  });

  test('clicking decision fields and operators inserts snippets into the search input', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: 'Insert field date' }));
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: /^>=/ }));

    const input = screen.getByPlaceholderText('Filter decisions...');
    expect(input).toHaveValue('date>=');

    await userEvent.type(input, '2026-03-24');

    await flushDecisionSearchDebounce();
    await waitFor(() => expect(screen.getByPlaceholderText('Filter decisions...')).toHaveValue('date>=2026-03-24'));
    await waitFor(() => expect(screen.getByText('5.6.7.8')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument());
  });

  test('decision snippet insertion ignores stale input selections while the modal has focus', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert field date' }));

    const input = screen.getByPlaceholderText('Filter decisions...') as HTMLInputElement;
    expect(input).toHaveValue('date');

    fireEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    fireEvent.click(screen.getByRole('button', { name: /^>=/ }));

    expect(input).toHaveValue('date>=');

    await flushDecisionSearchDebounce();
    expect(input).toHaveValue('date>=');
  });

  test('reset all filters clears an advanced decision query without restoring it', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Filter decisions...');
    fireEvent.change(input, { target: { value: 'country:germany AND action:ban' } });
    await flushDecisionSearchDebounce();

    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Reset all filters' }));

    await waitFor(() => expect(screen.getByPlaceholderText('Filter decisions...')).toHaveValue(''));
    await waitFor(() => expect(screen.getByText('5.6.7.8')).toBeInTheDocument());
  });

  test('keeps the decisions table mounted while debounced search is loading and keeps the summary mounted', async () => {
    const user = userEvent.setup();
    const decisions: DecisionListItem[] = [
      {
        id: 10,
        created_at: '2026-03-23T10:00:00.000Z',
        machine: 'host-a',
        value: '1.2.3.4',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: 'manual',
          reason: 'crowdsecurity/ssh-bf',
          country: 'DE',
          as: 'Hetzner',
          action: 'ban',
          duration: '4h',
          alert_id: 1,
        },
      },
      {
        id: 20,
        created_at: '2026-03-23T11:00:00.000Z',
        machine: 'machine-2',
        value: '5.6.7.8',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: 'CAPI',
          reason: 'crowdsecurity/nginx-bf',
          country: 'US',
          as: 'AWS',
          action: 'ban',
          duration: '4h',
          alert_id: 2,
        },
      },
    ];
    const deferred = createDeferred<PaginatedResponse<DecisionListItem>>();

    vi.mocked(api.fetchDecisionsPaginated).mockImplementation((page, pageSize, filters) => {
      if (filters?.q === 'aws') {
        return deferred.promise;
      }

      return Promise.resolve(toPaginatedDecisions(decisions, page, pageSize, decisions.length));
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    const summary = screen.getByTestId('decisions-summary');
    expect(summary).toHaveTextContent('Showing 2 of 2 decisions');

    const input = screen.getByPlaceholderText('Filter decisions...');
    await user.clear(input);
    await user.type(input, 'aws');

    expect(summary).toBeInTheDocument();
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Loading decisions...')).not.toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Loading decisions...')).not.toBeInTheDocument();

    deferred.resolve(toPaginatedDecisions([decisions[1]], 1, 50, decisions.length));

    await waitFor(() => expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument());
    expect(screen.getByText('5.6.7.8')).toBeInTheDocument();
    expect(summary).toHaveTextContent('Showing 1 of 1 decisions (2 total before filters)');
  });

  test('shows loaded decision count when server filters still have more pages', async () => {
    const filteredDecisions = Array.from({ length: 313 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      value: `10.0.0.${index + 1}`,
      expired: false,
      is_duplicate: false,
      simulated: false,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/http-probing',
        country: 'DE',
        as: 'Hetzner',
        action: 'ban',
        duration: '4h',
        alert_id: index + 1,
      },
    }));
    vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions(filteredDecisions, page, pageSize, 314),
    );

    render(
      <MemoryRouter initialEntries={['/decisions?include_expired=true']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 313 decisions (314 total before filters)')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.313')).not.toBeInTheDocument();
  });


  test('loads the first decision page once when StrictMode replays mount effects', async () => {
    const decisions = [
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
    ];
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions(decisions, page, pageSize, decisions.length),
    );
    fetchDecisionsPaginatedMock.mockClear();

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/decisions']}>
          <Decisions />
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(fetchDecisionsPaginatedMock.mock.calls.filter(([page]) => page === 1)).toHaveLength(1);
  });

  test('auto-refresh preserves the already loaded decision pages', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    const pagedDecisions = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      value: `10.1.0.${index + 1}`,
      expired: false,
      is_duplicate: false,
      simulated: false,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/http-probing',
        country: 'DE',
        as: 'Hetzner',
        action: 'ban',
        duration: '4h',
        alert_id: index + 1,
      },
    }));
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions(pagedDecisions, page, pageSize, pagedDecisions.length),
    );

    const { rerender } = render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 120 decisions')).toBeInTheDocument());

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('Showing 100 of 120 decisions')).toBeInTheDocument());
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();

    const callCountBeforeRefresh = fetchDecisionsPaginatedMock.mock.calls.length;
    setRefreshSignalMock(1);

    rerender(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDecisionsPaginatedMock.mock.calls.length).toBeGreaterThanOrEqual(callCountBeforeRefresh + 2));
    expect(fetchDecisionsPaginatedMock.mock.calls.slice(callCountBeforeRefresh, callCountBeforeRefresh + 2).map(([page]) => page)).toEqual([1, 2]);
    expect(screen.getByText('Showing 100 of 120 decisions')).toBeInTheDocument();
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();
    expect(screen.queryByText('10.1.0.101')).not.toBeInTheDocument();
  });
});
