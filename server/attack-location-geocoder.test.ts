import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { makeGeoNamesSnapshotsImmutable } from '../scripts/geonames-snapshot.mjs';
import type { DashboardAttackLocationDatum } from '../shared/contracts';
import {
  createAttackLocationResolver,
  hasGeoNamesAttackLocationData,
} from './attack-location-geocoder';

const berlinLocation: DashboardAttackLocationDatum = {
  latitude: 52.52,
  longitude: 13.405,
  count: 3,
  liveCount: 2,
  simulatedCount: 1,
};

function createClient(results: Array<Array<Record<string, unknown>>>) {
  return {
    init: vi.fn((_options, callback: () => void) => callback()),
    lookUp: vi.fn((_points, _maxResults, callback) => callback(null, results)),
  };
}

describe('attack location geocoder', () => {
  test('promotes downloaded files to immutable snapshots that cannot trigger runtime refreshes', async () => {
    const dumpDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsec-geonames-'));
    const citiesDirectory = path.join(dumpDirectory, 'cities1000');
    const admin1Directory = path.join(dumpDirectory, 'admin1_codes');

    try {
      fs.mkdirSync(citiesDirectory);
      fs.mkdirSync(admin1Directory);
      fs.writeFileSync(path.join(citiesDirectory, 'cities1000_2026-07-15.txt'), 'cities');
      fs.writeFileSync(path.join(admin1Directory, 'admin1CodesASCII_2026-07-15.txt'), 'regions');

      expect(hasGeoNamesAttackLocationData(dumpDirectory)).toBe(false);
      const datedClient = createClient([]);
      const datedResolver = createAttackLocationResolver({
        dumpDirectory,
        client: datedClient,
      });
      await expect(datedResolver.resolve([berlinLocation])).resolves.toEqual([berlinLocation]);
      expect(datedClient.init).not.toHaveBeenCalled();

      makeGeoNamesSnapshotsImmutable(dumpDirectory);

      expect(hasGeoNamesAttackLocationData(dumpDirectory)).toBe(true);
      expect(fs.existsSync(path.join(citiesDirectory, 'cities1000_2026-07-15.txt'))).toBe(false);
      expect(fs.existsSync(path.join(admin1Directory, 'admin1CodesASCII_2026-07-15.txt'))).toBe(false);
    } finally {
      fs.rmSync(dumpDirectory, { recursive: true, force: true });
    }
  });

  test('resolves a nearby city, admin region, and country from cities1000', async () => {
    const client = createClient([[
      {
        name: 'Berlin',
        admin1Code: { name: 'Berlin' },
        countryCode: 'de',
        distance: 0.4,
      },
    ]]);
    const resolver = createAttackLocationResolver({
      dumpDirectory: '/geonames',
      client,
      dataAvailable: () => true,
    });

    await expect(resolver.resolve([berlinLocation])).resolves.toEqual([{
      ...berlinLocation,
      city: 'Berlin',
      region: 'Berlin',
      countryCode: 'DE',
    }]);
    expect(client.init).toHaveBeenCalledWith({
      dumpDirectory: '/geonames',
      citiesFileOverride: 'cities1000',
      load: {
        admin1: true,
        admin2: false,
        admin3And4: false,
        alternateNames: false,
      },
    }, expect.any(Function));
    expect(client.lookUp).toHaveBeenCalledWith(
      [{ latitude: 52.52, longitude: 13.405 }],
      10,
      expect.any(Function),
    );
  });

  test('prefers a city over a nearer neighborhood record', async () => {
    const client = createClient([[
      {
        name: 'Mitte',
        featureCode: 'PPLX',
        admin1Code: { name: 'State of Berlin' },
        countryCode: 'DE',
        distance: 0.01,
      },
      {
        name: 'Berlin',
        featureCode: 'PPLC',
        admin1Code: { name: 'State of Berlin' },
        countryCode: 'DE',
        distance: 0.61,
      },
    ]]);
    const resolver = createAttackLocationResolver({
      dumpDirectory: '/geonames',
      client,
      dataAvailable: () => true,
    });

    await expect(resolver.resolve([berlinLocation])).resolves.toEqual([{
      ...berlinLocation,
      city: 'Berlin',
      region: 'State of Berlin',
      countryCode: 'DE',
    }]);
  });

  test('does not attach a misleading city beyond the distance limit', async () => {
    const client = createClient([[
      {
        name: 'Remote City',
        admin1Code: { name: 'Remote Region' },
        countryCode: 'AU',
        distance: 100.01,
      },
    ]]);
    const resolver = createAttackLocationResolver({
      dumpDirectory: '/geonames',
      client,
      dataAvailable: () => true,
    });

    await expect(resolver.resolve([berlinLocation])).resolves.toEqual([berlinLocation]);
  });

  test('falls back to coordinates and warns once when local data is unavailable', async () => {
    const client = createClient([]);
    const warn = vi.fn();
    const resolver = createAttackLocationResolver({
      dumpDirectory: '/missing-geonames',
      client,
      dataAvailable: () => false,
      warn,
    });

    await expect(resolver.resolve([berlinLocation])).resolves.toEqual([berlinLocation]);
    await expect(resolver.resolve([berlinLocation])).resolves.toEqual([berlinLocation]);
    expect(client.init).not.toHaveBeenCalled();
    expect(client.lookUp).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coordinates only'));
  });

  test('falls back to coordinates when lookup fails', async () => {
    const warn = vi.fn();
    const client = {
      init: vi.fn((_options, callback: () => void) => callback()),
      lookUp: vi.fn((_points, _maxResults, callback) => callback(new Error('lookup failed'))),
    };
    const resolver = createAttackLocationResolver({
      dumpDirectory: '/geonames',
      client,
      dataAvailable: () => true,
      warn,
    });

    await expect(resolver.resolve([berlinLocation])).resolves.toEqual([berlinLocation]);
    expect(warn).toHaveBeenCalledWith('GeoNames attack-location lookup failed: lookup failed');
  });
});
