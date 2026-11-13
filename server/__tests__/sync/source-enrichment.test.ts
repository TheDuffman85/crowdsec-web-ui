import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AlertRecord } from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
import { enrichAlertSourcesFromCache, getUnenrichedSourceIp, withSourceEnrichment, type SourceEnrichmentRow } from '../../source-enrichment';

const cached: SourceEnrichmentRow = {
  source_ip: '1.2.3.4', observed_at: '2026-01-10T00:00:00.000Z', country: 'CA', as_name: 'Cloud', source_as_number: '396982',
  source_range: '1.2.0.0/16', source_scope: 'Ip', latitude: 43.65, longitude: -79.38,
};

describe('manual alert source enrichment', () => {
  test('only enriches single IPs that carry neither country nor AS data', () => {
    expect(getUnenrichedSourceIp({ scope: 'ip', value: '1.2.3.4' })).toBe('1.2.3.4');
    expect(getUnenrichedSourceIp({ scope: 'Ip', ip: '2001:db8::1', cn: '', as_name: '' })).toBe('2001:db8::1');
    expect(getUnenrichedSourceIp({ scope: 'ip', value: '1.2.3.4', cn: 'DE' })).toBeUndefined();
    expect(getUnenrichedSourceIp({ scope: 'ip', value: '1.2.3.4', as_name: 'AS' })).toBeUndefined();
    expect(getUnenrichedSourceIp({ scope: 'range', value: '1.2.3.0/24' })).toBeUndefined();
    expect(getUnenrichedSourceIp({ scope: 'crowdsecurity/community-blocklist', value: '1.2.3.4' })).toBeUndefined();
    expect(getUnenrichedSourceIp(undefined)).toBeUndefined();
  });

  test('fills only missing fields, keeps the scope and value and records when the data was observed', () => {
    const alert = { id: 1, source: { scope: 'ip', value: '1.2.3.4', as_number: '7', latitude: 0, longitude: 0 } } as AlertRecord;
    const enrichment = { cn: 'CA', as_name: 'Cloud', as_number: '396982', range: '1.2.0.0/16', latitude: 43.65, longitude: -79.38, scope: 'range', value: 'x' };
    expect(withSourceEnrichment(alert, enrichment, Date.parse('2026-01-02T00:00:00Z')).source).toEqual({
      scope: 'ip', value: '1.2.3.4', cn: 'CA', as_name: 'Cloud', as_number: '7', range: '1.2.0.0/16', latitude: 43.65, longitude: -79.38,
      copied_enrichment_at: '2026-01-02T00:00:00.000Z',
    });
  });

  test('skips the lookup when no alert needs enrichment and prefers the most recently observed source', async () => {
    const query = vi.fn(() => [cached]);
    const enriched = { id: 1, created_at: '2026-01-09T00:00:00.000Z', source: { scope: 'Ip', ip: '1.2.3.4', value: '1.2.3.4', cn: 'FR', as_name: 'Old' } } as AlertRecord;
    const alerts = [enriched];
    expect(await enrichAlertSourcesFromCache(alerts, query)).toBe(alerts);
    expect(query).not.toHaveBeenCalled();

    const manual = { id: 2, created_at: '2026-01-11T00:00:00.000Z', source: { scope: 'ip', value: '1.2.3.4' } } as AlertRecord;
    // The cached source was observed after the enriched alert of the batch.
    const [, filled] = await enrichAlertSourcesFromCache([enriched, manual], query);
    expect(filled.source).toMatchObject({ cn: 'CA', as_name: 'Cloud', range: '1.2.0.0/16', copied_enrichment_at: cached.observed_at });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('source_ip IN (?)'), ['1.2.3.4']);

    // A batch alert observed later wins over the cache.
    const newer = { ...enriched, created_at: '2026-01-10T12:00:00.000Z' };
    const [, fromBatch] = await enrichAlertSourcesFromCache([newer, manual], query);
    expect(fromBatch.source).toMatchObject({ cn: 'FR', as_name: 'Old', copied_enrichment_at: '2026-01-10T12:00:00.000Z' });
    expect(fromBatch.source).not.toHaveProperty('range');
  });

  test('ranks copies by when their data was observed, so they never shadow later real data', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'source-enrichment-'));
    const database = new CrowdsecDatabase({ cachePath: path.join(dir, 'cache.db') });
    try {
      const query = (sql: string, params: string[]) => database.db.prepare(sql).all(...params) as SourceEnrichmentRow[];
      // Persists alerts the way sync does: enrichment first, then the insert.
      const sync = async (...alerts: AlertRecord[]) => {
        for (const alert of await enrichAlertSourcesFromCache(alerts, query)) {
          database.insertAlert({ $id: alert.id, $uuid: String(alert.id), $created_at: alert.created_at, $message: '', $record: alert });
        }
      };
      const real = (id: number, day: string, cn: string, as_name: string) =>
        ({ id, created_at: `2026-01-0${day}T00:00:00.000Z`, scenario: 'ssh', source: { scope: 'Ip', ip: '1.2.3.4', value: '1.2.3.4', cn, as_name } }) as AlertRecord;
      const manual = (id: number, day: string) =>
        ({ id, created_at: `2026-01-0${day}T00:00:00.000Z`, scenario: 'manual/web-ui', source: { scope: 'ip', value: '1.2.3.4' } }) as AlertRecord;
      const country = (id: number) => (database.db.prepare('SELECT country FROM alerts WHERE upstream_id = ?').get(String(id)) as { country: string }).country;

      await sync(real(1, '1', 'DE', 'German AS'));
      await sync(manual(3, '3'));
      expect(country(3)).toBe('DE');
      // A source observed on Jan 2 is imported later, e.g. from another window.
      await sync(real(2, '2', 'CA', 'Canadian AS'));
      // Re-syncing the earlier manual alert and adding a new one both pick it up.
      await sync(manual(3, '3'), manual(4, '4'));
      expect(country(3)).toBe('CA');
      expect(country(4)).toBe('CA');

      // Once the real alerts are gone, the copies keep the data they had.
      database.db.prepare('DELETE FROM alerts WHERE upstream_id IN (?, ?)').run('1', '2');
      await sync(manual(3, '3'), manual(4, '4'), manual(5, '5'));
      expect([country(3), country(4), country(5)]).toEqual(['CA', 'CA', 'CA']);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
