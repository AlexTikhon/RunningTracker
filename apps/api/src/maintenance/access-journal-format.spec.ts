import { describe, expect, it } from 'vitest';

import {
  accessJournalFileNamePattern,
  parseAccessJournalFile,
  serializeAccessJournalEntries,
  type AccessJournalEntry,
} from './access-journal-format.js';

const org = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const run = '33333333-3333-4333-8333-333333333333';
const changedAt = '2032-01-10T00:00:00.000Z';

const membership: AccessJournalEntry = {
  changedAt,
  kind: 'membership_deactivated',
  orgId: org,
  seq: '1',
  userId: user,
  v: 1,
};
const revoked: AccessJournalEntry = { ...membership, kind: 'share_revoked', runId: run, seq: '2' };
const narrowed: AccessJournalEntry = {
  ...membership,
  canReadHistory: true,
  canReadLive: false,
  kind: 'share_narrowed',
  runId: run,
  seq: '3',
};

describe('access journal format', () => {
  it('round-trips every kind as newline-terminated JSON lines in order', () => {
    const text = serializeAccessJournalEntries([membership, revoked, narrowed]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(4);
    expect(parseAccessJournalFile('f.ndjson', text)).toEqual([membership, revoked, narrowed]);
    expect(parseAccessJournalFile('empty.ndjson', '')).toEqual([]);
  });

  it('carries identifiers, two booleans and an instant only', () => {
    const keys = (entry: AccessJournalEntry) =>
      Object.keys(JSON.parse(serializeAccessJournalEntries([entry])) as object).sort();
    expect(keys(membership)).toEqual(['changedAt', 'kind', 'orgId', 'seq', 'userId', 'v']);
    expect(keys(revoked)).toEqual(['changedAt', 'kind', 'orgId', 'runId', 'seq', 'userId', 'v']);
    expect(keys(narrowed)).toEqual([
      'canReadHistory',
      'canReadLive',
      'changedAt',
      'kind',
      'orgId',
      'runId',
      'seq',
      'userId',
      'v',
    ]);
  });

  it('rejects a truncated file instead of skipping the final record', () => {
    const text = serializeAccessJournalEntries([membership]).slice(0, -1);
    expect(() => parseAccessJournalFile('cut.ndjson', text)).toThrow('truncated');
  });

  it.each([
    ['invalid JSON', '{not json}\n'],
    ['an unknown key', `${JSON.stringify({ ...membership, extra: 1 })}\n`],
    ['an unknown kind (a grant can never be imported)', `${JSON.stringify({ ...membership, kind: 'share_granted' })}\n`],
    ['a wrong version', `${JSON.stringify({ ...membership, v: 2 })}\n`],
    ['a non-canonical UUID', `${JSON.stringify({ ...membership, userId: 'NOT-A-UUID' })}\n`],
    ['a non-UTC-millisecond instant', `${JSON.stringify({ ...membership, changedAt: '2032-01-10T00:00:00Z' })}\n`],
    ['an impossible calendar date', `${JSON.stringify({ ...membership, changedAt: '2032-02-31T00:00:00.000Z' })}\n`],
    ['a non-decimal sequence', `${JSON.stringify({ ...membership, seq: '4x' })}\n`],
    ['a membership entry carrying a run', `${JSON.stringify({ ...membership, runId: run })}\n`],
    ['a revoked share without a run', `${JSON.stringify({ ...revoked, runId: undefined })}\n`],
    ['a revoked share carrying booleans', `${JSON.stringify({ ...revoked, canReadLive: true })}\n`],
    ['a narrowed share without booleans', `${JSON.stringify({ ...narrowed, canReadLive: undefined })}\n`],
    ['a narrowed share with a non-boolean', `${JSON.stringify({ ...narrowed, canReadLive: 'no' })}\n`],
    ['a blank line', `${JSON.stringify(membership)}\n\n`],
  ])('rejects the whole file for %s', (_label, text) => {
    expect(() => parseAccessJournalFile('bad.ndjson', text)).toThrow(/line \d+/u);
  });

  it('names the failing line without echoing record contents', () => {
    const text = `${JSON.stringify(membership)}\n${JSON.stringify({ ...membership, userId: 'x' })}\n`;
    let message = '';
    try {
      parseAccessJournalFile('two.ndjson', text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('line 2');
    expect(message).not.toContain(org);
  });

  it('only accepts journal file names that cannot traverse directories', () => {
    expect(accessJournalFileNamePattern.test('access-journal-20320110T000000000Z-1-2-ab12cd34.ndjson')).toBe(true);
    for (const name of [
      '../access-journal-1.ndjson',
      'access-journal-a/b.ndjson',
      '.tmp-x',
      'deletion-journal-1.ndjson',
    ]) {
      expect(accessJournalFileNamePattern.test(name)).toBe(false);
    }
  });
});
