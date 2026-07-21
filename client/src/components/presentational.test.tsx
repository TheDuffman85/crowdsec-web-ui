import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SyncOverlay } from './SyncOverlay';
import { TimeDisplay } from './TimeDisplay';
import { Badge } from './ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { I18nContext, type I18nContextValue } from '../lib/i18n';

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

  test('preserves invalid timestamps for troubleshooting', () => {
    render(<TimeDisplay timestamp="not-a-timestamp" className="raw-time" />);

    expect(screen.getByText('not-a-timestamp')).toHaveClass('raw-time');
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

  test('shows historical sync progress for every configured instance', () => {
    render(
      <SyncOverlay
        syncStatus={{
          isSyncing: true,
          progress: 52,
          message: '',
          startedAt: '2026-07-19T12:00:00.000Z',
          completedAt: null,
          state: 'syncing',
          instances: [
            {
              instance_id: 'primary',
              instance_name: 'Primary',
              icon: '🟦',
              isSyncing: false,
              progress: 100,
              message: 'Primary sync complete',
              startedAt: '2026-07-19T12:00:00.000Z',
              completedAt: '2026-07-19T12:01:00.000Z',
              state: 'complete',
            },
            {
              instance_id: 'secondary',
              instance_name: 'Secondary',
              icon: '🟩',
              isSyncing: true,
              progress: 5,
              message: 'Syncing Secondary',
              startedAt: '2026-07-19T12:01:00.000Z',
              completedAt: null,
              state: 'syncing',
            },
            {
              instance_id: 'edge',
              instance_name: 'Edge',
              isSyncing: false,
              progress: 0,
              message: '',
              startedAt: null,
              completedAt: null,
              state: 'idle',
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('1 of 3 instances finished')).toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('Secondary')).toBeInTheDocument();
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('Waiting for sync...')).toBeInTheDocument();
    expect(screen.getByText('52%')).toBeInTheDocument();
    expect(document.querySelector('.instance-color-icon')).toHaveClass('bg-orange-500');
  });

  test('translates known server sync status messages', () => {
    const i18nValue: I18nContextValue = {
      language: 'de',
      preference: 'de',
      browserLanguage: 'de',
      setLanguagePreference: () => undefined,
      t: (key) => ({
        'components.syncOverlay.description': 'Bitte warten',
        'components.syncOverlay.statusStarting': 'Historische Daten werden gestartet...',
        'components.syncOverlay.title': 'Historische Daten werden synchronisiert',
      })[key] ?? key,
    };

    render(
      <I18nContext.Provider value={i18nValue}>
        <SyncOverlay
          syncStatus={{
            isSyncing: true,
            progress: 95,
            message: 'Starting historical data sync...',
            startedAt: null,
            completedAt: null,
          }}
        />
      </I18nContext.Provider>,
    );

    expect(screen.getByText('Historische Daten werden gestartet...')).toBeInTheDocument();
  });

  test('translates the processing stage and keeps its progress visible', () => {
    const i18nValue: I18nContextValue = {
      language: 'de',
      preference: 'de',
      browserLanguage: 'de',
      setLanguagePreference: () => undefined,
      t: (key, values) => ({
        'components.syncOverlay.description': 'Bitte warten',
        'components.syncOverlay.statusProcessingWindow': `${values?.alerts} Alarme und ${values?.decisions} Entscheidungen aus ${values?.window} werden verarbeitet...`,
        'components.syncOverlay.title': 'Historische Daten werden synchronisiert',
      })[key] ?? key,
    };

    render(
      <I18nContext.Provider value={i18nValue}>
        <SyncOverlay
          syncStatus={{
            isSyncing: true,
            progress: 90,
            message: 'Processing 22 alerts and 18278 decisions from 12h0m0s -> 0h0m0s ago...',
            startedAt: null,
            completedAt: null,
          }}
        />
      </I18nContext.Provider>,
    );

    expect(screen.getByText('22 Alarme und 18278 Entscheidungen aus 12h0m0s -> 0h0m0s ago werden verarbeitet...')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  test.each([
    ['Finalizing decision data...', 'components.syncOverlay.statusFinalizingDecisions'],
    [
      'Removed 12 stale cached alerts and 34 stale cached decisions before sync.',
      'components.syncOverlay.statusRemovedStale:12:34',
    ],
    [
      'Syncing: 24h0m0s -> 12h0m0s ago (56 alerts, 78 decisions)',
      'components.syncOverlay.statusSyncingWindow:24h0m0s -> 12h0m0s ago:56:78',
    ],
    [
      'Fetching: 12h0m0s -> 0h0m0s ago (90 alerts and 123 decisions cached so far)',
      'components.syncOverlay.statusFetchingWindow:12h0m0s -> 0h0m0s ago:90:123',
    ],
  ])('translates the sync stage %s', (message, expected) => {
    const i18nValue: I18nContextValue = {
      language: 'en',
      preference: 'en',
      browserLanguage: 'en',
      setLanguagePreference: () => undefined,
      t: (key, values) => [
        key,
        values?.window,
        values?.alerts,
        values?.decisions,
      ].filter((value) => value !== undefined).join(':'),
    };

    render(
      <I18nContext.Provider value={i18nValue}>
        <SyncOverlay
          syncStatus={{
            isSyncing: true,
            progress: 50,
            message,
            startedAt: null,
            completedAt: null,
          }}
        />
      </I18nContext.Provider>,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
