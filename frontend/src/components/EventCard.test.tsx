import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EventCard } from './EventCard';

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

    expect(screen.getByText('Timestamp:')).toBeInTheDocument();
    expect(screen.getByText('Additional Metadata (1)')).toBeInTheDocument();
    expect(screen.getByText('{"foo":"bar"}')).toBeInTheDocument();
  });
});
