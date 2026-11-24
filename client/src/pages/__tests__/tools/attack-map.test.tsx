import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AttackMap } from '../../tools/AttackMap';
import { buildCountryShapes, featureCountryCode, intensity } from '../../../lib/worldGeo';

const mocks = vi.hoisted(() => ({ fetchGeoBlocking: vi.fn(), loadCountryShapes: vi.fn() }));
vi.mock('../../../lib/insightsApi', () => ({ fetchGeoBlocking: mocks.fetchGeoBlocking }));
vi.mock('../../../lib/worldGeo', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/worldGeo')>()), loadCountryShapes: mocks.loadCountryShapes }));

const square = (x: number, y: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10], [x, y]]] });
const feature = (code: string, x: number, y: number, key = 'ISO_A2') => ({ type: 'Feature', properties: { NAME: code, [key]: code }, geometry: square(x, y) });

afterEach(() => vi.clearAllMocks());

describe('world geometry', () => {
  test('reads country codes from the usual property names and rejects placeholders', () => {
    expect(featureCountryCode({ ISO_A2: 'de' })).toBe('DE');
    expect(featureCountryCode({ ISO_A2: '-99', ISO_A2_EH: 'FR' })).toBe('FR');
    expect(featureCountryCode({ WB_A2: 'JP' })).toBe('JP');
    expect(featureCountryCode({ ISO_A2: 'XXX' })).toBeNull();
    expect(featureCountryCode(undefined)).toBeNull();
  });

  test('builds one path per country and skips Antarctica, duplicates and unknown codes', () => {
    const shapes = buildCountryShapes([
      feature('DE', 5, 45), feature('FR', -5, 42), feature('DE', 80, 20), feature('AQ', 0, -80),
      { type: 'Feature', properties: { NAME: 'Nowhere' }, geometry: square(0, 0) },
    ]);
    expect(shapes.map((shape) => shape.code)).toEqual(['DE', 'FR']);
    expect(shapes[0]!.path).toMatch(/^M/);
  });

  test('scales intensity on a square-root curve', () => {
    expect(intensity(0, 100)).toBe(0);
    expect(intensity(5, 0)).toBe(0);
    expect(intensity(100, 100)).toBeCloseTo(1);
    expect(intensity(25, 100)).toBeCloseTo(0.59);
    expect(intensity(1000, 100)).toBeCloseTo(1);
    expect(intensity(1, 10000)).toBeGreaterThan(0.18);
  });
});

describe('AttackMap', () => {
  const summary = { hours: 168, total_alerts: 100, blocked_countries: [], countries: [
    { code: 'CN', alerts: 60, unique_ips: 12, blocked: false },
    { code: 'DE', alerts: 15, unique_ips: 3, blocked: true },
  ] };

  function setup() {
    mocks.fetchGeoBlocking.mockResolvedValue(summary);
    mocks.loadCountryShapes.mockResolvedValue(buildCountryShapes([feature('CN', 100, 30), feature('DE', 5, 45), feature('FR', -5, 42)]));
    return render(<MemoryRouter><AttackMap /></MemoryRouter>);
  }

  test('colours countries with alerts and leaves the rest inert', async () => {
    setup();
    const map = await screen.findByTestId('attack-map');
    const cn = map.querySelector('[data-country="CN"]')!;
    const fr = map.querySelector('[data-country="FR"]')!;
    await waitFor(() => expect(cn.getAttribute('style')).toContain('rgb(220, 38, 38)'));
    expect(map.querySelector('[data-country="DE"]')!.getAttribute('style')).toContain('rgba(220, 38, 38, 0.5');
    expect(fr.getAttribute('role')).toBeNull();
    expect(fr.getAttribute('style')).toBeNull();
    expect(fr.getAttribute('class')).toContain('fill-gray-200 dark:fill-gray-700');
  });

  test('selecting a country shows its numbers and links to its alerts', async () => {
    const user = userEvent.setup();
    setup();
    const map = await screen.findByTestId('attack-map');
    await waitFor(() => expect(map.querySelector('[data-country="CN"]')!.getAttribute('role')).toBe('button'));
    await user.click(within(map).getByRole('button', { name: 'China: 60 alerts' }));
    const details = screen.getByTestId('attack-map-details');
    expect(details).toHaveTextContent('60 alerts (60% of the total) from 12 unique IPs.');
    expect(within(details).getByRole('link', { name: 'View alerts' })).toHaveAttribute('href', '/alerts?q=country%3ACN');
    expect(within(details).getByRole('link', { name: 'Block this country' })).toHaveAttribute('href', '/tools/geo-blocking');
  });

  test('works from the keyboard and from the top list', async () => {
    const user = userEvent.setup();
    setup();
    const map = await screen.findByTestId('attack-map');
    const de = await within(map).findByRole('button', { name: 'Germany: 15 alerts' });
    de.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('attack-map-details')).toHaveTextContent('15 alerts');
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    const listButton = screen.getAllByRole('button').find((button) => button.tagName === 'BUTTON' && /China/.test(button.textContent ?? ''))!;
    await user.click(listButton);
    expect(screen.getByTestId('attack-map-details')).toHaveTextContent('60 alerts');
  });

  test('reports data and map failures', async () => {
    mocks.fetchGeoBlocking.mockRejectedValue(new Error('no data'));
    mocks.loadCountryShapes.mockRejectedValue(new Error('no map'));
    render(<MemoryRouter><AttackMap /></MemoryRouter>);
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
  });
});
