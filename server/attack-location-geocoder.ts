import fs from 'node:fs';
import path from 'node:path';
import localReverseGeocoder from 'local-reverse-geocoder';
import { makeGeoNamesSnapshotsImmutable } from '../scripts/geonames-snapshot.mjs';
export const ATTACK_LOCATION_MAX_DISTANCE_KM = 100;
const ATTACK_LOCATION_CANDIDATE_LIMIT = 10;

export interface CoordinateLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  countryCode?: string;
}

interface LocalAddress {
  name?: unknown;
  admin1Code?: unknown;
  countryCode?: unknown;
  distance?: unknown;
  featureCode?: unknown;
}

interface LocalReverseGeocoderClient {
  init: (options: {
    dumpDirectory: string;
    citiesFileOverride: string;
    load: {
      admin1: boolean;
      admin2: boolean;
      admin3And4: boolean;
      alternateNames: boolean;
    };
  }, callback: () => void) => void;
  lookUp: (
    points: Array<{ latitude: number; longitude: number }>,
    maxResults: number,
    callback: (error: Error | null, results?: LocalAddress[][]) => void,
  ) => void;
}

export interface AttackLocationResolver {
  resolve: <T extends CoordinateLocation>(locations: T[]) => Promise<Array<T & CoordinateLocation>>;
}

interface CreateAttackLocationResolverOptions {
  dumpDirectory: string;
  client?: LocalReverseGeocoderClient;
  maxDistanceKm?: number;
  dataAvailable?: () => boolean;
  warn?: (message: string) => void;
  timeoutMs?: number;
}

function hasImmutableDumpFile(dumpDirectory: string, subdirectory: string, basename: string): boolean {
  try {
    return fs.statSync(path.join(dumpDirectory, subdirectory, `${basename}.txt`)).isFile();
  } catch {
    return false;
  }
}

export function hasGeoNamesAttackLocationData(dumpDirectory: string): boolean {
  return hasImmutableDumpFile(dumpDirectory, 'cities5000', 'cities5000')
    && hasImmutableDumpFile(dumpDirectory, 'admin1_codes', 'admin1CodesASCII');
}

function prepareGeoNamesAttackLocationData(dumpDirectory: string): boolean {
  if (hasGeoNamesAttackLocationData(dumpDirectory)) return true;

  try {
    // Releases before the immutable-snapshot migration left valid downloads
    // under dated filenames. Promote those files locally so upgrades keep
    // location labels without letting the geocoder refresh data at runtime.
    makeGeoNamesSnapshotsImmutable(dumpDirectory);
  } catch {
    return false;
  }

  return hasGeoNamesAttackLocationData(dumpDirectory);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeRegion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return normalizeText((value as { name?: unknown }).name);
}

function normalizeCountryCode(value: unknown): string | undefined {
  const normalized = normalizeText(value)?.toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

export function createAttackLocationResolver(
  options: CreateAttackLocationResolverOptions,
): AttackLocationResolver {
  const client = options.client || localReverseGeocoder as LocalReverseGeocoderClient;
  const maxDistanceKm = options.maxDistanceKm ?? ATTACK_LOCATION_MAX_DISTANCE_KM;
  const dataAvailable = options.dataAvailable || (() => prepareGeoNamesAttackLocationData(options.dumpDirectory));
  const warn = options.warn || ((message: string) => console.warn(message));
  let initialization: Promise<void> | null = null;
  let initialized = false;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let warned = false;

  function withDeadline<T>(
    label: string,
    start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms timeout`)), timeoutMs);
      const complete = (value: T) => {
        clearTimeout(timeout);
        resolve(value);
      };
      const fail = (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      };
      try {
        start(complete, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function warnOnce(message: string): void {
    if (warned) return;
    warned = true;
    warn(message);
  }

  function initialize(): Promise<void> {
    if (initialized) return Promise.resolve();
    if (initialization) return initialization;

    initialization = withDeadline<void>('GeoNames initialization', (resolve, reject) => {
      try {
        client.init({
          dumpDirectory: options.dumpDirectory,
          citiesFileOverride: 'cities5000',
          load: {
            admin1: true,
            admin2: false,
            admin3And4: false,
            alternateNames: false,
          },
        }, () => {
          // A slow initializer can still become usable later, without starting
          // overlapping initialization of the singleton native data structures.
          initialized = true;
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    return initialization;
  }

  function lookUp(locations: CoordinateLocation[]): Promise<LocalAddress[][]> {
    return withDeadline('GeoNames lookup', (resolve, reject) => {
      client.lookUp(
        locations.map(({ latitude, longitude }) => ({ latitude, longitude })),
        ATTACK_LOCATION_CANDIDATE_LIMIT,
        (error, results) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(results || []);
        },
      );
    });
  }

  return {
    async resolve<T extends CoordinateLocation>(locations: T[]): Promise<Array<T & CoordinateLocation>> {
      if (locations.length === 0) return locations;
      if (!dataAvailable()) {
        warnOnce(
          `GeoNames attack-location data is unavailable in ${options.dumpDirectory}; `
          + 'marker popups will show coordinates only. Run "pnpm geocoder:data" to download it.',
        );
        return locations;
      }

      try {
        await initialize();
        const results = await lookUp(locations);
        return locations.map((location, index) => {
          const candidates = results[index] || [];
          const nearest = candidates.find((candidate) => (
            candidate.featureCode !== 'PPLX'
            && Number.isFinite(Number(candidate.distance))
            && Number(candidate.distance) <= maxDistanceKm
          )) || candidates[0];
          const distance = Number(nearest?.distance);
          if (!nearest || !Number.isFinite(distance) || distance > maxDistanceKm) {
            return location;
          }

          return {
            ...location,
            city: normalizeText(nearest.name),
            region: normalizeRegion(nearest.admin1Code),
            countryCode: normalizeCountryCode(nearest.countryCode),
          };
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce(`GeoNames attack-location lookup failed: ${reason}`);
        return locations;
      }
    },
  };
}
