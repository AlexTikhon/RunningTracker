import { describe, expect, it } from 'vitest';

import {
  erasureLedgerFileNamePattern,
  parseErasureLedgerFile,
  serializeErasureLedgerEntries,
  type ErasureLedgerEntry,
} from './erasure-ledger-format.js';

const entry: ErasureLedgerEntry = {
  entityType: 'activity',
  erasedAt: '2026-11-06T12:00:00.123456Z',
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerUserId: '44444444-4444-4444-8444-444444444444',
  recordCreatedAt: '2026-11-05T08:00:00.000001Z',
  recordId: 'ad000000-0000-4000-8000-000000000001',
  seq: '7',
  v: 1,
};

describe('erasure ledger format', () => {
  it('round-trips entries as one newline-terminated JSON object per line, microseconds intact', () => {
    const text = serializeErasureLedgerEntries([entry, { ...entry, seq: '8' }]);
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseErasureLedgerFile('f', text)).toEqual([entry, { ...entry, seq: '8' }]);
  });

  it('knows activities and daily check-ins (ADR-0074), and nothing else', () => {
    const daily = { ...entry, entityType: 'daily_metric' as const, seq: '9' };
    expect(parseErasureLedgerFile('f', serializeErasureLedgerEntries([entry, daily]))).toEqual([entry, daily]);
  });

  it('carries identifiers and timestamps only', () => {
    expect(Object.keys(JSON.parse(serializeErasureLedgerEntries([entry]).trim()) as object).sort()).toEqual([
      'entityType',
      'erasedAt',
      'orgId',
      'ownerUserId',
      'recordCreatedAt',
      'recordId',
      'seq',
      'v',
    ]);
  });

  it('reads an empty file as no entries', () => {
    expect(parseErasureLedgerFile('f', '')).toEqual([]);
  });

  it('rejects the whole file for a truncated last line, invalid JSON or any invalid entry', () => {
    const good = serializeErasureLedgerEntries([entry]);
    expect(() => parseErasureLedgerFile('f', good.slice(0, -1))).toThrow('truncated');
    expect(() => parseErasureLedgerFile('f', `${good}{not json}\n`)).toThrow('line 2 is not valid JSON');
    expect(() => parseErasureLedgerFile('f', `${good}\n`)).toThrow('line 2');
    for (const bad of [
      { ...entry, entityType: 'meal' },
      { ...entry, notes: 'content must never be here' },
      { ...entry, recordId: entry.recordId.toUpperCase() },
      { ...entry, erasedAt: '2026-11-06T12:00:00.123Z' },
      { ...entry, recordCreatedAt: '2026-02-30T08:00:00.000000Z' },
      { ...entry, seq: '0' },
      { ...entry, v: 2 },
    ]) {
      expect(() => parseErasureLedgerFile('f', `${good}${JSON.stringify(bad)}\n`)).toThrow('line 2 is not a valid entry');
    }
  });

  it('refuses to serialize an invalid entry', () => {
    expect(() => serializeErasureLedgerEntries([{ ...entry, entityType: 'run' as 'activity' }])).toThrow();
  });

  it('names files distinctly from the run and access journals', () => {
    expect(erasureLedgerFileNamePattern.test('erasure-ledger-20261106T120000000Z-1-2-abcd1234.ndjson')).toBe(true);
    expect(erasureLedgerFileNamePattern.test('deletion-journal-20261106T120000000Z-1-2-abcd1234.ndjson')).toBe(false);
    expect(erasureLedgerFileNamePattern.test('erasure-ledger-../x.ndjson')).toBe(false);
  });
});
