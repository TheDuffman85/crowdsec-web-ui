import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { I18nContext, type I18nContextValue } from '../lib/i18n';
import { WorldMapCard } from './WorldMapCard';

const { choroplethMountSpy, choroplethUnmountSpy, transformWrapperPropsSpy } = vi.hoisted(() => ({
  choroplethMountSpy: vi.fn(),
  choroplethUnmountSpy: vi.fn(),
  transformWrapperPropsSpy: vi.fn(),
}));

vi.mock('@nivo/geo', async () => {
  const React = await import('react');

  return {
    Choropleth: ({
      data,
      features,
      tooltip: Tooltip,
    }: {
      data?: Array<Record<string, unknown>>;
      features?: Array<{ id: string; properties?: { NAME?: string } }>;
      tooltip?: React.ComponentType<{ feature: Record<string, unknown> }>;
    }) => {
      React.useEffect(() => {
        choroplethMountSpy();
        return () => {
          choroplethUnmountSpy();
        };
      }, []);

      const firstFeature = features?.[0];
      const firstFeatureData = data?.find((item) => item.id === firstFeature?.id);

      return (
        <svg data-testid="choropleth">
          {features?.map((feature) => (
            <path key={feature.id} data-feature-id={feature.id} fill="#ccc" />
          ))}
          {Tooltip && firstFeature ? (
            <Tooltip
              feature={firstFeatureData ? {
                id: firstFeature.id,
                label: firstFeature.properties?.NAME,
                data: { id: firstFeature.id, ...firstFeatureData },
              } : {
                id: firstFeature.id,
                label: firstFeature.properties?.NAME,
                properties: firstFeature.properties,
              }}
            />
          ) : null}
        </svg>
      );
    },
  };
});

vi.mock('react-zoom-pan-pinch', async () => {
  const React = await import('react');

  return {
    TransformWrapper: React.forwardRef(({
      children,
      ...props
    }: {
      children: React.ReactNode | ((controls: {
        zoomIn: () => void;
        zoomOut: () => void;
        centerView: () => void;
      }) => React.ReactNode);
      smooth?: boolean;
      wheel?: { step?: number };
    }, ref: React.Ref<{ centerView: () => void }>) => {
      const controls = {
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        centerView: vi.fn(),
      };

      transformWrapperPropsSpy(props);

      React.useImperativeHandle(ref, () => ({
        centerView: controls.centerView,
      }));

      return (
        <div>
          {typeof children === 'function' ? children(controls) : children}
        </div>
      );
    }),
    TransformComponent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

describe('WorldMapCard', () => {
  beforeEach(() => {
    choroplethMountSpy.mockClear();
    choroplethUnmountSpy.mockClear();
    transformWrapperPropsSpy.mockClear();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          { id: 'DE', properties: { NAME: 'Germany', ISO_A2: 'DE' } },
          { id: 'US', properties: { NAME: 'United States', ISO_A2: 'US' } },
        ],
      }),
    }));

    vi.stubGlobal('ResizeObserver', class {
      private callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(): void {
        this.callback([
          {
            contentRect: { width: 800, height: 450 },
          } as ResizeObserverEntry,
        ], this as unknown as ResizeObserver);
      }

      disconnect(): void {}
      unobserve(): void {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('shares map loading across development StrictMode effect replays', async () => {
    render(
      <StrictMode>
        <WorldMapCard
          data={[]}
          onCountrySelect={vi.fn()}
          selectedCountry={null}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId('choropleth')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('does not remount the choropleth when selectedCountry changes', async () => {
    const { rerender } = render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('choropleth')).toBeInTheDocument());
    await waitFor(() => expect(choroplethMountSpy).toHaveBeenCalledTimes(1));
    expect(choroplethUnmountSpy).not.toHaveBeenCalled();

    rerender(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry="DE"
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('choropleth')).toBeInTheDocument());
    await waitFor(() => expect(choroplethMountSpy).toHaveBeenCalledTimes(1));
    expect(choroplethUnmountSpy).not.toHaveBeenCalled();
  });

  test('uses deterministic wheel zoom settings for the map wrapper', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(transformWrapperPropsSpy).toHaveBeenCalled());

    expect(transformWrapperPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        smooth: false,
        wheel: expect.objectContaining({ step: 0.15 }),
      }),
    );
  });

  test('outlines the selected country even when map data is empty', async () => {
    render(
      <WorldMapCard
        data={[]}
        onCountrySelect={vi.fn()}
        selectedCountry="DE"
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('choropleth')).toBeInTheDocument());

    const selectedPath = document.querySelector('path[data-feature-id="DE"]') as SVGPathElement | null;
    const otherPath = document.querySelector('path[data-feature-id="US"]') as SVGPathElement | null;
    expect(selectedPath).not.toBeNull();
    expect(otherPath).not.toBeNull();

    await waitFor(() => expect(selectedPath?.getAttribute('data-status')).toBe('active'));
    expect(selectedPath?.style.stroke).toBe('rgb(56, 189, 248)');
    expect(selectedPath?.style.strokeWidth).toBe('2.5');
    expect(otherPath?.getAttribute('data-status')).toBe('dimmed');
    expect(otherPath?.style.opacity).toBe('0.3');
  });

  test('localizes country names in the tooltip', async () => {
    const i18nValue: I18nContextValue = {
      language: 'zh',
      preference: 'zh',
      browserLanguage: 'en',
      setLanguagePreference: () => undefined,
      t: (key) => ({
        'components.worldMap.alerts': '告警',
        'components.worldMap.simulationAlerts': '模拟告警',
        'components.worldMap.title': '世界地图',
        'components.worldMap.zoomIn': '放大',
        'components.worldMap.zoomOut': '缩小',
        'components.worldMap.resetView': '重置视图',
        'common.loadingMap': '正在加载地图...',
      }[key] ?? key),
    };

    render(
      <I18nContext.Provider value={i18nValue}>
        <WorldMapCard
          data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
          onCountrySelect={vi.fn()}
          selectedCountry={null}
          simulationsEnabled={true}
        />
      </I18nContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('德国')).toBeInTheDocument());
    expect(screen.queryByText('Germany')).not.toBeInTheDocument();
  });

  test('shows the country flag in the tooltip', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('world-map-tooltip')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'DE' })).toHaveTextContent('🇩🇪');
  });

  test('shows active decisions in the tooltip', async () => {
    render(
      <WorldMapCard
        data={[{
          label: 'Germany',
          countryCode: 'DE',
          count: 2,
          liveCount: 2,
          simulatedCount: 0,
          liveDecisionCount: 3,
          simulatedDecisionCount: 0,
          activeLiveDecisionCount: 2,
          activeSimulatedDecisionCount: 0,
        }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Decisions: 3 \(2 active\)/)).toBeInTheDocument());
  });

  test('renders the tooltip outside the zoom transform at a fixed screen size', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('world-map-tooltip')).toBeInTheDocument());

    const mapContainer = document.querySelector('.world-map-container') as HTMLElement | null;
    expect(mapContainer).not.toBeNull();

    fireEvent.pointerMove(mapContainer as HTMLElement, { clientX: 40, clientY: 50 });

    const tooltip = screen.getByTestId('world-map-tooltip');
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveClass('fixed');
    expect(tooltip).toHaveStyle({ left: '55px', top: '65px' });
  });

  test('hides counts for a country dimmed by an active country filter', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'United States', countryCode: 'US', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry="US"
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByText('Germany')).toBeInTheDocument());
    expect(screen.queryByText(/Alerts:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Decisions:/)).not.toBeInTheDocument();
  });

  test('hides counts for a grey country without stats', async () => {
    render(
      <WorldMapCard
        data={[]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByText('Germany')).toBeInTheDocument());
    expect(screen.queryByText(/Alerts:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Decisions:/)).not.toBeInTheDocument();
  });

  test('uses the geographic feature id for a country without stats', async () => {
    render(
      <WorldMapCard
        data={[]}
        onCountrySelect={vi.fn()}
        selectedCountry="DE"
        simulationsEnabled={true}
      />,
    );

    await waitFor(() => expect(screen.getByText('Germany')).toBeInTheDocument());
    expect(screen.getByText(/Alerts: 0/)).toBeInTheDocument();
    expect(screen.getByText(/Decisions: 0 \(0 active\)/)).toBeInTheDocument();
  });
});
