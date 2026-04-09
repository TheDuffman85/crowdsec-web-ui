import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WorldMapCard } from './WorldMapCard';

const { choroplethMountSpy, choroplethUnmountSpy, transformWrapperPropsSpy } = vi.hoisted(() => ({
  choroplethMountSpy: vi.fn(),
  choroplethUnmountSpy: vi.fn(),
  transformWrapperPropsSpy: vi.fn(),
}));

vi.mock('@nivo/geo', async () => {
  const React = await import('react');

  return {
    Choropleth: ({ features }: { features?: Array<{ id: string }> }) => {
      React.useEffect(() => {
        choroplethMountSpy();
        return () => {
          choroplethUnmountSpy();
        };
      }, []);

      return (
        <svg data-testid="choropleth">
          {features?.map((feature) => (
            <path key={feature.id} data-feature-id={feature.id} fill="#ccc" />
          ))}
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
});
