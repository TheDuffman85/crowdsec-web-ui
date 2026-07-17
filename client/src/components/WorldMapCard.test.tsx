import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    window.localStorage.clear();
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
    vi.restoreAllMocks();
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

  test('renders projected markers at aggregated source locations when animation is enabled', async () => {
    const { rerender } = render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2 }]}
        attackLocations={[
          { latitude: 52.52, longitude: 13.405, count: 2, liveCount: 2, simulatedCount: 0 },
          { latitude: 40.71, longitude: -74.01, count: 0, liveCount: 0, simulatedCount: 0 },
          { latitude: 120, longitude: 10, count: 4, liveCount: 4, simulatedCount: 0 },
        ]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
      />,
    );

    const overlay = await screen.findByTestId('world-map-attack-markers');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay).toHaveClass('pointer-events-none');

    const berlinMarker = overlay.querySelector('[data-latitude="52.52"][data-longitude="13.405"]');
    expect(berlinMarker).not.toBeNull();
    expect(overlay.querySelectorAll('[data-latitude]')).toHaveLength(1);
    expect(berlinMarker?.querySelectorAll('.world-map-attack-pulse')).toHaveLength(2);
    expect(berlinMarker?.querySelector('.world-map-attack-pulse-outline')).toHaveAttribute('stroke', '#7f1d1d');
    expect(berlinMarker?.querySelector('.world-map-attack-pulse:not(.world-map-attack-pulse-outline)')).toHaveAttribute('stroke', '#ffffff');
    expect(berlinMarker?.querySelector('.world-map-attack-dot')).toHaveAttribute('fill', '#dc2626');
    expect(berlinMarker?.querySelector('.world-map-attack-dot')).toHaveAttribute('stroke-width', '0.75');

    const projectedCoordinates = berlinMarker?.getAttribute('transform')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    expect(projectedCoordinates).toHaveLength(2);
    expect(projectedCoordinates.every(Number.isFinite)).toBe(true);

    rerender(
      <WorldMapCard
        data={[{ label: 'United States', countryCode: 'US', count: 3 }]}
        attackLocations={[{ latitude: 37.7749, longitude: -122.4194, count: 3, liveCount: 3, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
      />,
    );

    await waitFor(() => expect(overlay.querySelector('[data-latitude="37.7749"]')).not.toBeNull());
    expect(overlay.querySelector('[data-latitude="52.52"]')).toBeNull();
  });

  test('counter-scales marker geometry without changing its position transform', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 1 }]}
        attackLocations={[{ latitude: 52.52, longitude: 13.405, count: 1, liveCount: 1, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
      />,
    );

    const overlay = await screen.findByTestId('world-map-attack-markers');
    const transformProps = transformWrapperPropsSpy.mock.calls.at(-1)?.[0] as {
      onTransform?: (ref: unknown, state: { scale: number; positionX: number; positionY: number }) => void;
    };
    const marker = overlay.querySelector('[data-latitude="52.52"]');
    const markerTransform = marker?.getAttribute('transform');

    transformProps.onTransform?.({}, { scale: 4, positionX: 0, positionY: 0 });

    expect(overlay.style.getPropertyValue('--world-map-attack-pulse-radius')).toBe('0.75px');
    expect(overlay.style.getPropertyValue('--world-map-attack-pulse-outline-stroke')).toBe('0.625px');
    expect(overlay.style.getPropertyValue('--world-map-attack-pulse-stroke')).toBe('0.25px');
    expect(overlay.style.getPropertyValue('--world-map-attack-dot-radius')).toBe('0.625px');
    expect(overlay.style.getPropertyValue('--world-map-attack-dot-stroke')).toBe('0.1875px');
    expect(marker?.getAttribute('transform')).toBe(markerTransform);
    expect(overlay.querySelector('.world-map-attack-marker-visual')).toBeNull();
  });

  test('adds location attack details to the country tooltip while hovering a marker', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 5, liveCount: 3, simulatedCount: 2 }]}
        attackLocations={[{
          latitude: 52.52,
          longitude: 13.405,
          count: 5,
          liveCount: 3,
          simulatedCount: 2,
          city: 'Berlin',
          region: 'Berlin',
          countryCode: 'DE',
        }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
        simulationsEnabled={true}
      />,
    );

    const overlay = await screen.findByTestId('world-map-attack-markers');
    const marker = overlay.querySelector('[data-latitude="52.52"]');
    const projectedCoordinates = marker?.getAttribute('transform')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    expect(projectedCoordinates).toHaveLength(2);

    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      bottom: 450,
      height: 450,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const mapContainer = document.querySelector('.world-map-container') as HTMLElement;
    fireEvent.pointerMove(mapContainer, {
      clientX: projectedCoordinates[0],
      clientY: projectedCoordinates[1],
    });

    const details = await screen.findByTestId('world-map-attack-location');
    expect(details).toHaveClass('border-t');
    expect(screen.getByText(/Alerts: 3 \(5 at this location\)/)).toBeInTheDocument();
    expect(within(details).getByText('Approx. location')).toBeInTheDocument();
    expect(within(details).getByText('Berlin, Germany')).toBeInTheDocument();
    expect(within(details).queryByText('52.5200°, 13.4050°')).not.toBeInTheDocument();
    expect(screen.queryByText(/Location data/)).not.toBeInTheDocument();
    expect(screen.queryByText('Attack location')).not.toBeInTheDocument();

    fireEvent.pointerMove(mapContainer, {
      clientX: projectedCoordinates[0] + 50,
      clientY: projectedCoordinates[1] + 50,
    });
    await waitFor(() => expect(screen.queryByTestId('world-map-attack-location')).not.toBeInTheDocument());
    expect(screen.queryByText(/at location/)).not.toBeInTheDocument();
  });

  test('does not render the marker overlay when animation is disabled', async () => {
    window.localStorage.setItem('crowdsec-web-ui:dashboard:map-animation-enabled', 'false');

    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2 }]}
        attackLocations={[{ latitude: 52.52, longitude: 13.405, count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('choropleth')).toBeInTheDocument());
    expect(screen.queryByTestId('world-map-attack-markers')).not.toBeInTheDocument();
  });

  test('pauses pulse markers while the document is hidden and resumes them when visible', async () => {
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2 }]}
        attackLocations={[{ latitude: 52.52, longitude: 13.405, count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
      />,
    );

    const overlay = await screen.findByTestId('world-map-attack-markers');
    expect(overlay).toHaveClass('world-map-attack-markers-paused');

    visibilityState.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(overlay).not.toHaveClass('world-map-attack-markers-paused'));
  });

  test('enables attack markers by default and persists the browser toggle', async () => {
    const { unmount } = render(
      <WorldMapCard data={[]} onCountrySelect={vi.fn()} selectedCountry={null} />,
    );

    const toggle = screen.getByRole('switch', { name: 'Attack markers' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(window.localStorage.getItem('crowdsec-web-ui:dashboard:map-animation-enabled')).toBe('true'));

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(window.localStorage.getItem('crowdsec-web-ui:dashboard:map-animation-enabled')).toBe('false'));

    unmount();
    render(<WorldMapCard data={[]} onCountrySelect={vi.fn()} selectedCountry={null} />);
    expect(screen.getByRole('switch', { name: 'Attack markers' })).toHaveAttribute('aria-checked', 'false');
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
    expect(selectedPath?.style.strokeWidth).toBe('1.5');
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
    expect(screen.getByRole('img', { name: 'DE' })).toHaveClass('fi', 'fi-de');
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

  test('hides the tooltip on mobile viewports', async () => {
    render(
      <WorldMapCard
        data={[{ label: 'Germany', countryCode: 'DE', count: 2, liveCount: 2, simulatedCount: 0 }]}
        onCountrySelect={vi.fn()}
        selectedCountry={null}
      />,
    );

    const tooltip = await screen.findByTestId('world-map-tooltip');
    expect(tooltip).toHaveClass('max-[799px]:hidden');
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
