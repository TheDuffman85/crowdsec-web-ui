import { geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { assetUrl } from './basePath';

export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 420;

export interface CountryShape {
  code: string;
  name: string;
  path: string;
}

interface RawFeature {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

const ISO_KEYS = ['ISO_A2', 'iso_a2', 'ISO_A2_EH', 'WB_A2'];

export function featureCountryCode(properties: Record<string, unknown> | undefined): string | null {
  for (const key of ISO_KEYS) {
    const value = properties?.[key];
    if (typeof value === 'string' && value !== '-99' && /^[A-Z]{2}$/i.test(value)) return value.toUpperCase();
  }
  return null;
}

/** Turns the bundled Natural Earth data into one SVG path per country. Pure, so it can be tested without a fetch. */
export function buildCountryShapes(features: RawFeature[]): CountryShape[] {
  const projection = geoNaturalEarth1().fitSize([MAP_WIDTH, MAP_HEIGHT], {
    type: 'FeatureCollection',
    features: features.filter((feature) => featureCountryCode(feature.properties) !== 'AQ'),
  } as unknown as GeoPermissibleObjects);
  const toPath = geoPath(projection);
  const seen = new Set<string>();
  const shapes: CountryShape[] = [];
  for (const feature of features) {
    const code = featureCountryCode(feature.properties);
    if (!code || code === 'AQ' || seen.has(code)) continue;
    const path = toPath(feature as unknown as GeoPermissibleObjects);
    if (!path) continue;
    seen.add(code);
    shapes.push({ code, name: String(feature.properties?.NAME ?? code), path });
  }
  return shapes;
}

let shapesPromise: Promise<CountryShape[]> | null = null;

/** Loads the map from the application's own origin; nothing is fetched from a third party. */
export function loadCountryShapes(): Promise<CountryShape[]> {
  shapesPromise ??= fetch(assetUrl('/world-50m.json'))
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load map data: ${response.status}`);
      return response.json() as Promise<{ features?: RawFeature[] }>;
    })
    .then((payload) => buildCountryShapes(payload.features ?? []))
    .catch((error: unknown) => { shapesPromise = null; throw error; });
  return shapesPromise;
}

/** Fill opacity for a country, on a square-root scale so a few busy countries do not hide the rest. */
export function intensity(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return 0.18 + 0.82 * Math.sqrt(Math.min(value, max) / max);
}
