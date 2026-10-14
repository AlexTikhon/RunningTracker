import { describe, expect, it } from 'vitest';

import {
  deletionJournalFileNamePattern,
  parseDeletionJournalFile,
  serializeDeletionJournalEntries,
  type DeletionJournalEntry,
} from './deletion-journal-format.js';

const entry: DeletionJournalEntry = {
  deletedAt: '2032-01-10T00:00:00.000Z',
  orgId: '11111111-1111-4111-8111-111111111111',
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  seq: '42',
  v: 1,
};

describe('deletion journal format', () => {
  it('round-trips entries as newline-terminated JSON lines in order', () => {
    const second = { ...entry, runId: '44444444-4444-4444-8444-444444444444', seq: '43' };
    const text = serializeDeletionJournalEntries([entry, second]);

    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(3);
    expect(parseDeletionJournalFile('f.ndjson', text)).toEqual([entry, second]);
    expect(parseDeletionJournalFile('empty.ndjson', '')).toEqual([]);
  });

  it('serializes and parses UUID v7 identifiers alongside v4 ones', () => {
    const v7Entry: DeletionJournalEntry = {
      ...entry,
      orgId: '01890f47-3f6b-7c82-98c3-b71ef3ed1001',
      ownerUserId: '01890f47-3f6b-7c82-98c3-b71ef3ed1002',
      runId: '01890f47-3f6b-7c82-98c3-b71ef3ed1003',
      seq: '44',
    };
    const text = serializeDeletionJournalEntries([entry, v7Entry]);

    expect(parseDeletionJournalFile('mixed.ndjson', text)).toEqual([entry, v7Entry]);
    expect(text).toContain(v7Entry.runId);
  });

  it.each([
    ['an uppercase identifier', '01890F47-3F6B-7C82-98C3-B71EF3ED1003'],
    ['an unassigned version', '01890f47-3f6b-0c82-98c3-b71ef3ed1003'],
    ['a version beyond the registered range', '01890f47-3f6b-9c82-98c3-b71ef3ed1003'],
    ['a foreign variant', '01890f47-3f6b-7c82-c8c3-b71ef3ed1003'],
    ['an identifier without hyphens', '01890f473f6b7c8298c3b71ef3ed1003'],
  ])('still rejects %s when serializing and parsing', (_label, runId) => {
    expect(() => serializeDeletionJournalEntries([{ ...entry, runId }])).toThrow();
    expect(() =>
      parseDeletionJournalFile('bad.ndjson', `${JSON.stringify({ ...entry, runId })}\n`),
    ).toThrow(/line 1 is not a valid entry/u);
  });

  it('carries identifiers and timestamps only', () => {
    expect(Object.keys(JSON.parse(serializeDeletionJournalEntries([entry])) as object).sort()).toEqual([
      'deletedAt',
      'orgId',
      'ownerUserId',
      'runId',
      'seq',
      'v',
    ]);
  });

  it('rejects a truncated file instead of skipping the final record', () => {
    const text = serializeDeletionJournalEntries([entry]).slice(0, -1);
    expect(() => parseDeletionJournalFile('cut.ndjson', text)).toThrow('truncated');
  });

  it.each([
    ['invalid JSON', '{not json}\n'],
    ['an unknown key', `${JSON.stringify({ ...entry, extra: 1 })}\n`],
    ['a wrong version', `${JSON.stringify({ ...entry, v: 2 })}\n`],
    ['a non-canonical UUID', `${JSON.stringify({ ...entry, runId: 'NOT-A-UUID' })}\n`],
    ['a non-UTC-millisecond instant', `${JSON.stringify({ ...entry, deletedAt: '2032-01-10T00:00:00Z' })}\n`],
    ['an impossible calendar date', `${JSON.stringify({ ...entry, deletedAt: '2032-02-31T00:00:00.000Z' })}\n`],
    ['a non-decimal sequence', `${JSON.stringify({ ...entry, seq: '4x' })}\n`],
    ['a blank line', `${JSON.stringify(entry)}\n\n`],
  ])('rejects the whole file for %s', (_label, text) => {
    expect(() => parseDeletionJournalFile('bad.ndjson', text)).toThrow(/line \d+/u);
  });

  it('names the failing line without echoing record contents', () => {
    const text = `${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, runId: 'x' })}\n`;
    let message = '';
    try {
      parseDeletionJournalFile('two.ndjson', text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('line 2');
    expect(message).not.toContain(entry.orgId);
  });

  it('only accepts journal file names that cannot traverse directories', () => {
    expect(deletionJournalFileNamePattern.test('deletion-journal-20320110T000000000Z-1-2-ab12cd34.ndjson')).toBe(true);
    for (const name of ['../deletion-journal-1.ndjson', 'deletion-journal-a/b.ndjson', '.tmp-x', 'other.ndjson']) {
      expect(deletionJournalFileNamePattern.test(name)).toBe(false);
    }
  });
});
