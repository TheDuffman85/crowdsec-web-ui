import fs from 'node:fs';
import path from 'node:path';

const snapshots = [
  { directory: 'cities5000', basename: 'cities5000' },
  { directory: 'admin1_codes', basename: 'admin1CodesASCII' },
];

export function makeGeoNamesSnapshotsImmutable(dumpDirectory) {
  for (const { directory, basename } of snapshots) {
    const directoryPath = path.join(dumpDirectory, directory);
    const stablePath = path.join(directoryPath, `${basename}.txt`);
    if (fs.existsSync(stablePath)) continue;

    const datedPattern = new RegExp(`^${basename}_\\d{4}-\\d{2}-\\d{2}\\.txt$`);
    const datedFilename = fs.readdirSync(directoryPath)
      .filter((filename) => datedPattern.test(filename))
      .sort()
      .at(-1);
    if (!datedFilename) {
      throw new Error(`Downloaded GeoNames snapshot is missing for ${basename}`);
    }

    fs.renameSync(path.join(directoryPath, datedFilename), stablePath);
  }
}
