import path from 'node:path';
import localReverseGeocoder from 'local-reverse-geocoder';
import { makeGeoNamesSnapshotsImmutable } from './geonames-snapshot.mjs';

const dumpDirectory = path.resolve(
  process.env.GEONAMES_DUMP_DIR || process.argv[2] || 'geonames',
);

console.log(`Downloading GeoNames cities5000 data to ${dumpDirectory}...`);

localReverseGeocoder.init(
  {
    dumpDirectory,
    citiesFileOverride: 'cities5000',
    load: {
      admin1: true,
      admin2: false,
      admin3And4: false,
      alternateNames: false,
    },
  },
  () => {
    try {
      makeGeoNamesSnapshotsImmutable(dumpDirectory);
      console.log('Immutable GeoNames cities5000 snapshot is ready.');
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  },
);
