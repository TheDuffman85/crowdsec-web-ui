import { describe, expect, test } from 'vitest';
import type { DecisionListItem, SlimAlert } from '../../types';
import {
  ALERT_CSV_COLUMNS,
  collectAllPages,
  csvFilename,
  DECISION_CSV_COLUMNS,
  escapeCsvCell,
  toCsv,
} from '../csvExport';

describe('escapeCsvCell', () => {
  test('quotes cells with commas, quotes and line breaks', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('two\nlines')).toBe('"two\nlines"');
    expect(escapeCsvCell('plain')).toBe('plain');
  });

  test('renders empty values and non-strings', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(false)).toBe('false');
  });

  test('neutralises spreadsheet formulas in text but leaves negative numbers alone', () => {
    expect(escapeCsvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('@cmd')).toBe("'@cmd");
    expect(escapeCsvCell(-5)).toBe('-5');
  });
});

describe('toCsv', () => {
  test('writes a BOM, header row and CRLF line endings', () => {
    const csv = toCsv([{ a: 1, b: 'x,y' }], [
      { header: 'a', value: (row) => row.a },
      { header: 'b', value: (row) => row.b },
    ]);
    expect(csv).toBe('\uFEFFa,b\r\n1,"x,y"\r\n');
  });

  test('exports alerts and decisions with their key columns', () => {
    const alert = {
      id: 7, created_at: '2026-11-20T10:00:00Z', scenario: 'crowdsecurity/ssh-bf', kind: 'ssh',
      source: { ip: '203.0.113.9', cn: 'DE', as_name: 'Example AS' }, machine_alias: 'odin', target: 'sshd',
      events_count: 6, decisions: [{ id: 1 }], simulated: false, message: 'hi', meta_search: '',
    } as unknown as SlimAlert;
    const decision = {
      id: 3, created_at: '2026-11-20T10:00:00Z', value: '203.0.113.9', scenario: 'crowdsecurity/ssh-bf',
      expired: false, is_duplicate: false, detail: { origin: 'crowdsec', type: 'ban', country: 'DE', duration: '4h' },
    } as unknown as DecisionListItem;

    const alertLines = toCsv([alert], ALERT_CSV_COLUMNS).trimEnd().split('\r\n');
    expect(alertLines[0]).toBe('\uFEFFid,instance,created_at,scenario,kind,source,country,city,as,machine,target,events_count,decisions,simulated,message');
    expect(alertLines[1]).toBe('7,,2026-11-20T10:00:00Z,crowdsecurity/ssh-bf,ssh,203.0.113.9,DE,,Example AS,odin,sshd,6,1,false,hi');

    const decisionLines = toCsv([decision], DECISION_CSV_COLUMNS).trimEnd().split('\r\n');
    expect(decisionLines[1]).toBe('3,,2026-11-20T10:00:00Z,203.0.113.9,ban,crowdsecurity/ssh-bf,crowdsec,DE,,,4h,,false,false,');
  });
});

describe('collectAllPages', () => {
  const pageOf = (page: number, totalPages: number) => ({
    data: [page * 10, page * 10 + 1],
    pagination: { total_pages: totalPages },
  });

  test('walks every page', async () => {
    const requested: number[] = [];
    const result = await collectAllPages(async (page) => {
      requested.push(page);
      return pageOf(page, 3);
    });
    expect(requested).toEqual([1, 2, 3]);
    expect(result.rows).toHaveLength(6);
    expect(result.truncated).toBe(false);
  });

  test('stops at the row cap and reports truncation', async () => {
    const requested: number[] = [];
    const result = await collectAllPages(async (page) => {
      requested.push(page);
      return pageOf(page, 50);
    }, 5);
    expect(requested).toEqual([1, 2, 3]);
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  test('handles an empty result', async () => {
    const result = await collectAllPages(async () => ({ data: [], pagination: { total_pages: 0 } }));
    expect(result).toEqual({ rows: [], truncated: false });
  });

  test('names files by kind and minute', () => {
    expect(csvFilename('alerts', new Date('2026-11-20T10:05:30Z'))).toBe('crowdsec-alerts-2026-11-20-10-05.csv');
  });
});
