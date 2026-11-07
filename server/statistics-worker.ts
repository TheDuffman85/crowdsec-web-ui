import { setPriority } from 'node:os';
import { StatisticsStore, type ConsolidationContext } from './statistics-store';
import type { StatisticsOutboxRow } from './statistics-capture';
import type { StatisticsDetailRequest, StatisticsFilters } from '../shared/statistics';
import { installTimestampedConsole } from './logging';

const options = JSON.parse(process.argv[2]);
installTimestampedConsole();
process.once('disconnect', () => process.exit(0));
try { setPriority(0, 10); } catch { /* Scheduling priority is best effort across platforms. */ }
const store = new StatisticsStore(options.dbPath, options);
process.send?.({ ready: true });
process.on('message', (message: { id: number; request: Record<string, any> }) => {
  try {
    const r = message.request;
    let result: unknown;
    if (r.type === 'consolidate') result = store.consolidate(r.rows as StatisticsOutboxRow[], r.context as ConsolidationContext);
    else if (r.type === 'prune') {
      store.prune(String(r.cutoff));
      result = store.hasExpired(String(r.cutoff));
    } else if (r.type === 'details') result = store.details(r.filters as StatisticsFilters, r.request as StatisticsDetailRequest, Number(r.retentionDays), r.instances as string[], Date.now());
    else if (r.type === 'query') result = store.query(r.filters as StatisticsFilters, Number(r.retentionDays), r.instances as string[], Date.now(), Number(r.freshnessMs) || 0);
    else if (r.type === 'status') result = { lastSuccess: store.metadata('lastSuccess'), revision: Number(store.metadata('revision') || 0), coverageThrough: store.latestCoverage() };
    else throw new Error('Unknown statistics worker operation');
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
