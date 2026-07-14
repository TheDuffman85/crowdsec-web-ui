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

  test('translates known server sync status messages', () => {
    const i18nValue: I18nContextValue = {
      language: 'de',
      preference: 'de',
      browserLanguage: 'de',
      setLanguagePreference: () => undefined,
      t: (key) => ({
        'components.syncOverlay.description': 'Bitte warten',
        'components.syncOverlay.statusActiveDecisions': 'Aktive Entscheidungen werden synchronisiert...',
        'components.syncOverlay.title': 'Historische Daten werden synchronisiert',
      })[key] ?? key,
    };

    render(
      <I18nContext.Provider value={i18nValue}>
        <SyncOverlay
          syncStatus={{
            isSyncing: true,
            progress: 95,
            message: 'Syncing active decisions...',
            startedAt: null,
            completedAt: null,
          }}
        />
      </I18nContext.Provider>,
    );

    expect(screen.getByText('Aktive Entscheidungen werden synchronisiert...')).toBeInTheDocument();
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
});
