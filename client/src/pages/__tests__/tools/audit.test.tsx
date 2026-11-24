import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuditLog } from '../../tools/AuditLog';
import { AUDIT_CSV_COLUMNS, toCsv } from '../../../lib/csvExport';

const mocks = vi.hoisted(() => ({ fetchAuditLog: vi.fn() }));
vi.mock('../../../lib/insightsApi', () => ({ fetchAuditLog: mocks.fetchAuditLog }));

const event = (id: number, overrides = {}) => ({
  id, time: '2026-11-20T10:00:00.000Z', user: 'tommy', role: 'admin', action: 'decision.add', outcome: 'success',
  target: '203.0.113.5', details: { reason: 'scanner', duration: '4h' }, ...overrides,
});
const page = (data: unknown[], extra = {}) => ({
  data, pagination: { page: 1, page_size: 50, total: data.length, total_pages: 1 }, users: ['alice', 'tommy'], actions: ['decision.add', 'decision.delete'], ...extra,
});

afterEach(() => vi.clearAllMocks());

describe('AuditLog page', () => {
  test('lists entries with readable action names and expandable details', async () => {
    const user = userEvent.setup();
    mocks.fetchAuditLog.mockResolvedValue(page([event(1), event(2, { user: 'alice', action: 'decision.delete', outcome: 'partial', target: 'decision 4' })]));
    render(<MemoryRouter><AuditLog /></MemoryRouter>);
    const table = await screen.findByTestId('audit-table');
    expect(within(table).getByText('Decision added')).toBeInTheDocument();
    expect(within(table).getByText('Decision deleted')).toBeInTheDocument();
    expect(within(table).getByText('Partial')).toBeInTheDocument();
    await user.click(within(table).getAllByLabelText('Show details')[0]!);
    expect(within(table).getByText(/"reason": "scanner"/)).toBeInTheDocument();
  });

  test('sends filters to the server and resets to the first page', async () => {
    const user = userEvent.setup();
    mocks.fetchAuditLog.mockResolvedValue(page([event(1)], { pagination: { page: 1, page_size: 50, total: 120, total_pages: 3 } }));
    render(<MemoryRouter><AuditLog /></MemoryRouter>);
    await screen.findByTestId('audit-table');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mocks.fetchAuditLog).toHaveBeenLastCalledWith({}, 2));
    await user.selectOptions(screen.getByLabelText('User'), 'alice');
    await waitFor(() => expect(mocks.fetchAuditLog).toHaveBeenLastCalledWith({ user: 'alice' }, 1));
    await user.selectOptions(screen.getByLabelText('Outcome'), 'failure');
    await waitFor(() => expect(mocks.fetchAuditLog).toHaveBeenLastCalledWith({ user: 'alice', outcome: 'failure' }, 1));
    await user.selectOptions(screen.getByLabelText('Action'), 'decision.delete');
    await waitFor(() => expect(mocks.fetchAuditLog).toHaveBeenLastCalledWith({ user: 'alice', outcome: 'failure', action: 'decision.delete' }, 1));
  });

  test('shows the empty state and errors', async () => {
    mocks.fetchAuditLog.mockResolvedValueOnce(page([]));
    const view = render(<MemoryRouter><AuditLog /></MemoryRouter>);
    expect(await screen.findByText('No audit entries match these filters.')).toBeInTheDocument();
    view.unmount();
    mocks.fetchAuditLog.mockRejectedValueOnce(new Error('Administrator access required'));
    render(<MemoryRouter><AuditLog /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Administrator access required');
  });
});

describe('audit CSV columns', () => {
  test('exports every field and neutralises formulas', () => {
    const csv = toCsv([event(1, { target: '=cmd()' })], AUDIT_CSV_COLUMNS);
    expect(csv).toContain('time,user,role,action,target,outcome,details');
    expect(csv).toContain("'=cmd()");
    expect(csv).toContain('"{""reason"":""scanner"",""duration"":""4h""}"');
  });
});
