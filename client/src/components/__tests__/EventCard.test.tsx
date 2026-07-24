import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { EventCard } from '../EventCard';

describe('EventCard', () => {
  test('renders all metadata in one collapsed context-style table', async () => {
    render(
      <EventCard
        index={0}
        event={{
          timestamp: '2025-01-01T12:34:56.000Z',
          meta: [
            { key: 'service', value: 'crowdsec' },
            { key: 'payload', value: { foo: 'bar' } },
            { key: 'target_uri', value: '["/one","/two"]' },
            { key: 'empty', value: '   ' },
          ],
        }}
      />,
    );

    const toggle = screen.getByRole('button', { name: '#1' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('w-full', 'p-3');
    expect(toggle.parentElement).not.toHaveClass('p-3');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getByText('Timestamp')).toBeInTheDocument();
    expect(screen.getByText('service')).toBeInTheDocument();
    expect(screen.getByText('crowdsec').closest('dd')).toHaveClass('bg-white', 'dark:bg-gray-950');
    expect(screen.getByText('payload')).toBeInTheDocument();
    expect(screen.getByText('{"foo":"bar"}')).toBeInTheDocument();
    expect(screen.getByText('target_uri')).toBeInTheDocument();
    expect(screen.getByText('/one')).toBeInTheDocument();
    expect(screen.getByText('/two')).toBeInTheDocument();
    expect(screen.queryByText('Additional Metadata (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
  });

  test('renders AppSec metadata as ordinary table rows', async () => {
    const { container } = render(
      <EventCard
        index={0}
        event={{
          timestamp: '2025-01-01T12:34:56.000Z',
          meta: [
            { key: 'rule_name', value: 'crowdsecurity/vpatch-git-config' },
            { key: 'matched_zones', value: 'REQUEST_FILENAME' },
            { key: 'target_uri', value: '/.git/config' },
          ],
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '#1' }));

    expect(container.firstElementChild).toHaveClass('bg-gray-50', 'border-gray-100');
    expect(container.firstElementChild).not.toHaveClass('bg-red-50', 'border-red-100');
    expect(screen.queryByText('AppSec / WAF')).not.toBeInTheDocument();
    expect(screen.getByText('rule_name')).toBeInTheDocument();
    expect(screen.getByText('crowdsecurity/vpatch-git-config')).toBeInTheDocument();
    expect(screen.getByText('matched_zones')).toBeInTheDocument();
    expect(screen.getByText('REQUEST_FILENAME')).toBeInTheDocument();
    expect(screen.getByText('target_uri')).toBeInTheDocument();
    expect(screen.getByText('/.git/config')).toBeInTheDocument();
  });
});
