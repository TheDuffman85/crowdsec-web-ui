type CoverageTotals = {
  lines: { found: number; hit: number };
  functions: { found: number; hit: number };
  branches: { found: number; hit: number };
};

type FileCoverage = CoverageTotals & {
  path: string;
};

type CoverageReport = {
  totals: CoverageTotals;
  files: Map<string, FileCoverage>;
};

type ThresholdSet = {
  lines: number;
  functions: number;
  branches: number;
};

type PackageRule = {
  name: string;
  reportPath: string;
  minimums: ThresholdSet;
  exactFiles: string[];
};

const packages: PackageRule[] = [
  {
    name: 'backend',
    reportPath: 'coverage/backend/lcov.info',
    minimums: { lines: 90, functions: 90, branches: 90 },
    exactFiles: [
      'src/backend/config.ts',
      'src/backend/utils/duration.ts',
      'src/backend/utils/alerts.ts',
    ],
  },
  {
    name: 'frontend',
    reportPath: 'frontend/coverage/lcov.info',
    minimums: { lines: 90, functions: 90, branches: 90 },
    exactFiles: [
      'src/lib/basePath.ts',
      'src/lib/utils.ts',
      'src/lib/stats.ts',
    ],
  },
];

function emptyTotals(): CoverageTotals {
  return {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };
}

function addTotals(target: CoverageTotals, source: CoverageTotals): void {
  target.lines.found += source.lines.found;
  target.lines.hit += source.lines.hit;
  target.functions.found += source.functions.found;
  target.functions.hit += source.functions.hit;
  target.branches.found += source.branches.found;
  target.branches.hit += source.branches.hit;
}

function percentage(hit: number, found: number): number {
  if (found === 0) {
    return 100;
  }
  return Number(((hit / found) * 100).toFixed(2));
}

async function parseLcov(reportPath: string): Promise<CoverageReport> {
  const file = Bun.file(reportPath);
  if (!(await file.exists())) {
    throw new Error(`Coverage report not found: ${reportPath}`);
  }

  const content = await file.text();
  const lines = content.split('\n');
  const files = new Map<string, FileCoverage>();
  const totals = emptyTotals();

  let current: FileCoverage | null = null;

  for (const line of lines) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3).trim();
      current = { path, ...emptyTotals() };
      files.set(path, current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('LF:')) {
      current.lines.found = Number(line.slice(3));
      continue;
    }

    if (line.startsWith('LH:')) {
      current.lines.hit = Number(line.slice(3));
      continue;
    }

    if (line.startsWith('FNF:')) {
      current.functions.found = Number(line.slice(4));
      continue;
    }

    if (line.startsWith('FNH:')) {
      current.functions.hit = Number(line.slice(4));
      continue;
    }

    if (line.startsWith('BRF:')) {
      current.branches.found = Number(line.slice(4));
      continue;
    }

    if (line.startsWith('BRH:')) {
      current.branches.hit = Number(line.slice(4));
      continue;
    }

    if (line === 'end_of_record') {
      addTotals(totals, current);
      current = null;
    }
  }

  return { totals, files };
}

function assertMinimums(name: string, totals: CoverageTotals, thresholds: ThresholdSet): string[] {
  const failures: string[] = [];
  const linePct = percentage(totals.lines.hit, totals.lines.found);
  const functionPct = percentage(totals.functions.hit, totals.functions.found);
  const branchPct = percentage(totals.branches.hit, totals.branches.found);

  if (linePct < thresholds.lines) {
    failures.push(`${name} lines coverage ${linePct}% is below ${thresholds.lines}%`);
  }
  if (functionPct < thresholds.functions) {
    failures.push(`${name} functions coverage ${functionPct}% is below ${thresholds.functions}%`);
  }
  if (branchPct < thresholds.branches) {
    failures.push(`${name} branches coverage ${branchPct}% is below ${thresholds.branches}%`);
  }

  return failures;
}

function findCoverageForPath(files: Map<string, FileCoverage>, filePath: string): FileCoverage | null {
  for (const [key, coverage] of files.entries()) {
    if (key.endsWith(filePath)) {
      return coverage;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const pkg of packages) {
    const report = await parseLcov(pkg.reportPath);
    failures.push(...assertMinimums(pkg.name, report.totals, pkg.minimums));

    for (const exactFile of pkg.exactFiles) {
      const coverage = findCoverageForPath(report.files, exactFile);
      if (!coverage) {
        failures.push(`${pkg.name} exact-coverage file missing from report: ${exactFile}`);
        continue;
      }

      failures.push(
        ...assertMinimums(`${pkg.name}:${exactFile}`, coverage, {
          lines: 100,
          functions: 100,
          branches: pkg.minimums.branches,
        }),
      );
    }
  }

  if (failures.length > 0) {
    console.error('Coverage enforcement failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('Coverage thresholds satisfied.');
}

await main();

export {};
