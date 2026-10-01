import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { parseAccessJournalFile } from './access-journal-format.js';
import {
  ACCESS_JOURNAL_EXPORT_BATCH_LIMIT,
  runAccessJournalExportOnce,
} from './run-access-journal-export.js';

const clock = { utcNow: () => new Date('2032-01-10T00:00:05.000Z') };

function row(seq: number, kind = 'membership_deactivated') {
  return {
    can_read_history: kind === 'share_narrowed' ? true : null,
    can_read_live: kind === 'share_narrowed' ? false : null,
    changed_at: new Date('2032-01-10T00:00:00.000Z'),
    journal_seq: String(seq),
    kind,
    org_id: '11111111-1111-4111-8111-111111111111',
    run_id: kind === 'membership_deactivated' ? null : `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`,
    user_id: '22222222-2222-4222-8222-222222222222',
  };
}

function fakePool(handler: (sql: string, values?: unknown[]) => unknown) {
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => Promise.resolve(handler(sql, values))),
    release: vi.fn(),
  };
  return { client, pool: { connect: () => Promise.resolve(client as unknown as PoolClient) } };
}

const verbs = (client: ReturnType<typeof fakePool>['client']) =>
  client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/u)[0]);

describe('runAccessJournalExportOnce', () => {
  it('is idle and commits without touching the sink when nothing is pending', async () => {
    const sink = { write: vi.fn() };
    const { client, pool } = fakePool(() => ({ rows: [] }));

    await expect(runAccessJournalExportOnce(pool, sink, clock)).resolves.toEqual({ status: 'idle' });

    expect(sink.write).not.toHaveBeenCalled();
    expect(verbs(client)).toEqual(['BEGIN', 'SELECT', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('writes an access-journal file durably before acknowledging and committing', async () => {
    const order: string[] = [];
    const sink = {
      write: vi.fn<(name: string, contents: string) => Promise<void>>(() => {
        order.push('write');
        return Promise.resolve();
      }),
    };
    const { pool } = fakePool((sql, values) => {
      order.push(String(sql).trim().split(/\s/u)[0]!.replace(/\W.*$/u, ''));
      if (sql.includes('claim_access_journal_batch')) {
        expect(values).toEqual([ACCESS_JOURNAL_EXPORT_BATCH_LIMIT]);
        return { rows: [row(7), row(8, 'share_revoked'), row(9, 'share_narrowed')] };
      }
      if (sql.includes('ack_access_journal_batch')) {
        expect(values).toEqual([['7', '8', '9']]);
        return { rows: [{ acknowledged: 3 }] };
      }
      return { rows: [] };
    });

    const result = await runAccessJournalExportOnce(pool, sink, clock);

    expect(result).toMatchObject({ exportedCount: 3, status: 'exported' });
    expect(order).toEqual(['BEGIN', 'SELECT', 'write', 'SELECT', 'COMMIT']);

    const [fileName, contents] = sink.write.mock.calls[0]!;
    expect(fileName).toMatch(/^access-journal-20320110T000005000Z-7-9-[0-9a-f]{8}\.ndjson$/u);
    expect(parseAccessJournalFile(fileName, contents)).toEqual([
      expect.objectContaining({ kind: 'membership_deactivated', seq: '7' }),
      expect.objectContaining({ kind: 'share_revoked', seq: '8' }),
      expect.objectContaining({ canReadHistory: true, canReadLive: false, kind: 'share_narrowed', seq: '9' }),
    ]);
  });

  it('rolls back and keeps every row when the sink fails', async () => {
    const sink = { write: vi.fn(() => Promise.reject(new Error('disk full'))) };
    const { client, pool } = fakePool((sql) =>
      sql.includes('claim_access_journal_batch') ? { rows: [row(1)] } : { rows: [] },
    );

    await expect(runAccessJournalExportOnce(pool, sink, clock)).rejects.toThrow('disk full');

    expect(verbs(client)).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('rolls back when the acknowledgement count does not match the batch', async () => {
    const sink = { write: vi.fn(() => Promise.resolve()) };
    const { client, pool } = fakePool((sql) => {
      if (sql.includes('claim_access_journal_batch')) return { rows: [row(1), row(2)] };
      if (sql.includes('ack_access_journal_batch')) return { rows: [{ acknowledged: 1 }] };
      return { rows: [] };
    });

    await expect(runAccessJournalExportOnce(pool, sink, clock)).rejects.toThrow(
      'access journal acknowledgement did not match',
    );
    expect(verbs(client).at(-1)).toBe('ROLLBACK');
  });

  it('destroys the connection when the rollback fails or the commit outcome is unknown', async () => {
    const failingRollback = fakePool((sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return sql.includes('claim_access_journal_batch') ? { rows: [row(1)] } : { rows: [] };
    });
    await expect(
      runAccessJournalExportOnce(failingRollback.pool, { write: () => Promise.reject(new Error('boom')) }, clock),
    ).rejects.toThrow('boom');
    expect(failingRollback.client.release).toHaveBeenCalledWith(true);

    const failingCommit = fakePool((sql) => {
      if (sql === 'COMMIT') throw new Error('commit outcome unknown');
      if (sql.includes('claim_access_journal_batch')) return { rows: [row(1)] };
      if (sql.includes('ack_access_journal_batch')) return { rows: [{ acknowledged: 1 }] };
      return { rows: [] };
    });
    await expect(
      runAccessJournalExportOnce(failingCommit.pool, { write: () => Promise.resolve() }, clock),
    ).rejects.toThrow('commit outcome unknown');
    expect(failingCommit.client.release).toHaveBeenCalledWith(true);
    expect(failingCommit.client.query.mock.calls.map(([sql]) => sql)).not.toContain('ROLLBACK');
  });

  it.each([
    ['an unparsable instant', { ...row(1), changed_at: 'yesterday' }],
    ['an unknown kind', row(1, 'share_granted')],
    ['a share without a run', { ...row(1, 'share_revoked'), run_id: null }],
    ['a narrowed share without booleans', { ...row(1, 'share_narrowed'), can_read_live: null }],
  ])('rejects a malformed claim result (%s) before any write', async (_label, bad) => {
    const sink = { write: vi.fn() };
    const { pool } = fakePool((sql) =>
      sql.includes('claim_access_journal_batch') ? { rows: [bad] } : { rows: [] },
    );
    await expect(runAccessJournalExportOnce(pool, sink, clock)).rejects.toThrow('invalid result');
    expect(sink.write).not.toHaveBeenCalled();
  });

  it('rejects an invalid clock before touching the database', async () => {
    const untouched = fakePool(() => ({ rows: [] }));
    await expect(
      runAccessJournalExportOnce(untouched.pool, { write: vi.fn() }, { utcNow: () => new Date(Number.NaN) }),
    ).rejects.toThrow('invalid UTC time');
    expect(untouched.client.query).not.toHaveBeenCalled();
  });
});
