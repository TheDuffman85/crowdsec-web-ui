import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EventCard } from '../EventCard';

describe('EventCard', () => {
  test('renders object metadata values safely', () => {
    render(
      <EventCard
        index={0}
        event={{
          timestamp: '2025-01-01T12:34:56.000Z',
          meta: [
            { key: 'service', value: 'crowdsec' },
            { key: 'payload', value: { foo: 'bar' } },
          ],
        }}
      />,
    );

    expect(screen.getByText('Timestamp')).toBeInTheDocument();
    expect(screen.getByText('Additional Metadata (1)')).toBeInTheDocument();
    expect(screen.getByText('{"foo":"bar"}')).toBeInTheDocument();
  });

  test('uses the regular event styling for AppSec events without an inline WAF badge', () => {
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

    expect(container.firstElementChild).toHaveClass('bg-gray-50', 'border-gray-100');
    expect(container.firstElementChild).not.toHaveClass('bg-red-50', 'border-red-100');
    expect(screen.queryByText('AppSec / WAF')).not.toBeInTheDocument();
    expect(screen.getByText('Rule')).toBeInTheDocument();
    expect(screen.getByText('REQUEST_FILENAME')).toBeInTheDocument();
  });
});
