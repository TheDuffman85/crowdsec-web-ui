import path from 'node:path';
import localReverseGeocoder from 'local-reverse-geocoder';

const dumpDirectory = path.resolve(
  process.env.GEONAMES_DUMP_DIR || process.argv[2] || 'geonames',
);

console.log(`Downloading GeoNames cities1000 data to ${dumpDirectory}...`);

localReverseGeocoder.init(
  {
    dumpDirectory,
    citiesFileOverride: 'cities1000',
    load: {
      admin1: true,
      admin2: false,
      admin3And4: false,
      alternateNames: false,
    },
  },
  () => {
    console.log('GeoNames cities1000 data is ready.');
  },
);
