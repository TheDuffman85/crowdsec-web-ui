import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

// Settings keeps the selected tab in the URL, so tests render it inside a router.
export function SettingsRouter({ tab, children }: { tab?: string; children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[tab ? `/settings?tab=${tab}` : '/settings']}>
      {children}
    </MemoryRouter>
  );
}
