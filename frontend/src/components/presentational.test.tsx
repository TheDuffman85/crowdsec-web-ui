import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SyncOverlay } from './SyncOverlay';
import { TimeDisplay } from './TimeDisplay';
import { Badge } from './ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';

describe('presentational components', () => {
  test('renders badges and card wrappers', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent>
          <Badge variant="secondary">Status</Badge>
        </CardContent>
      </Card>,
    );

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  test('renders formatted time', () => {
    render(<TimeDisplay timestamp="2025-01-01T12:34:56.000Z" />);
    expect(screen.getByText(/2025/)).toBeInTheDocument();
  });

  test('only shows the sync overlay while syncing', () => {
    const { rerender } = render(
      <SyncOverlay
        syncStatus={{
          isSyncing: true,
          progress: 42,
          message: 'Synchronizing...',
          startedAt: null,
          completedAt: null,
        }}
      />,
    );

    expect(screen.getByText('Syncing Historical Data')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();

    rerender(
      <SyncOverlay
        syncStatus={{
          isSyncing: false,
          progress: 100,
          message: 'Done',
          startedAt: null,
          completedAt: null,
        }}
      />,
    );

    expect(screen.queryByText('Syncing Historical Data')).not.toBeInTheDocument();
  });

  test('returns null for missing timestamp and non-syncing overlay', () => {
    const { container } = render(
      <>
        <TimeDisplay timestamp={null} />
        <SyncOverlay syncStatus={null} />
      </>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  test('uses fallback sync values when progress or message are missing', () => {
    render(
      <SyncOverlay
        syncStatus={{
          isSyncing: true,
          progress: 0,
          message: '',
          startedAt: null,
          completedAt: null,
        }}
      />,
    );

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('Synchronizing...')).toBeInTheDocument();
  });
});
