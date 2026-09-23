import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SavedFiltersMenu } from '../SavedFiltersMenu';
import { filterValidForPage } from '../../lib/savedFilters';

const authState = vi.hoisted(() => ({ current: { authEnabled: false, user: null as { userId: number } | null } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState.current }));

afterEach(() => {
  vi.unstubAllGlobals();
  authState.current = { authEnabled: false, user: null };
});

function installApi() {
  const saved = [
    { id: 'one', name: 'German WAF', query: 'kind=waf AND country=DE', created_at: '', updated_at: '' },
    { id: 'two', name: 'Decision action', query: 'action=ban', created_at: '', updated_at: '' },
  ];
  let recent = [{ query: 'country=DE', used_at: new Date().toISOString() }];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET') return Response.json({ saved, recent, shared: true });
    if (method === 'POST' && path.endsWith('/recent')) return Response.json({ recent });
    if (method === 'POST' && path.endsWith('/saved')) {
      const body = JSON.parse(String(init?.body)) as { name: string; query: string };
      saved.push({ id: 'new', ...body, created_at: '', updated_at: '' });
      return Response.json(saved.at(-1), { status: 201 });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      saved[0].name = body.name;
      return Response.json(saved[0]);
    }
    if (method === 'DELETE' && path.endsWith('/recent')) {
      recent = [];
      return Response.json({ success: true });
    }
    if (method === 'DELETE') {
      saved.splice(saved.findIndex((filter) => path.endsWith(filter.id)), 1);
      return Response.json({ success: true });
    }
    throw new Error(`${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('SavedFiltersMenu', () => {
  test('manages server-backed saved filters and recent history', async () => {
    const api = installApi();
    const apply = vi.fn();
    const user = userEvent.setup();
    render(<SavedFiltersMenu page="alerts" query="target=ssh" onApply={apply} />);
    await user.click(screen.getByRole('button', { name: 'Saved filters' }));
    expect(await screen.findByText('German WAF')).toBeInTheDocument();
    expect(screen.getByText(/filters are shared with everyone/i)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'SSH');
    await user.click(screen.getByRole('button', { name: 'Save current query' }));
    expect(await screen.findByText('SSH')).toBeInTheDocument();
    const german = screen.getByText('German WAF').closest('div.rounded-md')!;
    expect(within(german as HTMLElement).getByRole('button', { name: 'Rename' }).querySelector('svg.lucide-square-pen')).not.toBeNull();
    expect(within(german as HTMLElement).getByRole('button', { name: 'Delete' }).querySelector('svg.lucide-trash-2')).not.toBeNull();
    await user.click(within(german as HTMLElement).getByRole('button', { name: 'Rename' }));
    await user.clear(within(german as HTMLElement).getByRole('textbox', { name: 'Name' }));
    await user.type(within(german as HTMLElement).getByRole('textbox', { name: 'Name' }), 'Germany WAF');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Germany WAF')).toBeInTheDocument();
    const renamed = screen.getByText('Germany WAF').closest('div.rounded-md')!;
    await user.click(within(renamed as HTMLElement).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Germany WAF')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Clear recent' }));
    expect(await screen.findByText('No recent filters yet.')).toBeInTheDocument();
    const ssh = screen.getByText('SSH').closest('div.rounded-md')!;
    await user.click(within(ssh as HTMLElement).getByRole('button', { name: 'Apply' }));
    expect(apply).toHaveBeenCalledWith('target=ssh');
    expect(api).toHaveBeenCalled();
  });

  test('clears the menu and reloads filters when the signed-in user changes', async () => {
    let loads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      loads += 1;
      return Response.json({
        saved: [{ id: String(loads), name: `User ${loads} filter`, query: 'country=DE', created_at: '', updated_at: '' }],
        recent: [],
        shared: false,
      });
    }));
    authState.current = { authEnabled: true, user: { userId: 1 } };
    const view = render(<SavedFiltersMenu page="alerts" query="country=DE" onApply={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Saved filters' }));
    expect(await screen.findByText('User 1 filter')).toBeInTheDocument();
    authState.current = { authEnabled: true, user: { userId: 2 } };
    view.rerender(<SavedFiltersMenu page="alerts" query="country=DE" onApply={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Saved filters' }));
    expect(await screen.findByText('User 2 filter')).toBeInTheDocument();
    expect(screen.queryByText('User 1 filter')).not.toBeInTheDocument();
  });

  test('disables applying queries that are incompatible with the current page', async () => {
    installApi();
    render(<SavedFiltersMenu page="dashboard" query="country=DE" onApply={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Saved filters' }));
    const action = await screen.findByText('Decision action');
    const row = action.closest('div.rounded-md')!;
    expect(within(row as HTMLElement).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(filterValidForPage('action=ban', 'decisions')).toBe(true);
    expect(filterValidForPage('action=ban', 'dashboard')).toBe(false);
  });
});
