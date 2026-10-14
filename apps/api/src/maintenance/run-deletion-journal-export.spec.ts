import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { parseDeletionJournalFile } from './deletion-journal-format.js';
import {
  DELETION_JOURNAL_EXPORT_BATCH_LIMIT,
  runDeletionJournalExportOnce,
} from './run-deletion-journal-export.js';

const clock = { utcNow: () => new Date('2032-01-10T00:00:05.000Z') };

function journalRow(seq: number) {
  return {
    deleted_at: new Date('2032-01-10T00:00:00.000Z'),
    journal_seq: String(seq),
    org_id: '11111111-1111-4111-8111-111111111111',
    owner_user_id: '22222222-2222-4222-8222-222222222222',
    run_id: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`,
  };
}

function fakePool(handler: (sql: string, values?: unknown[]) => unknown) {
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      return Promise.resolve(handler(sql, values));
    }),
    release: vi.fn(),
  };
  return { client, pool: { connect: () => Promise.resolve(client as unknown as PoolClient) } };
}

describe('runDeletionJournalExportOnce', () => {
  it('is idle and commits without touching the sink when nothing is pending', async () => {
    const sink = { write: vi.fn() };
    const { client, pool } = fakePool((sql) => {
      if (sql.includes('claim_deletion_journal_batch')) return { rows: [] };
      return { rows: [] };
    });

    await expect(runDeletionJournalExportOnce(pool, sink, clock)).resolves.toEqual({ status: 'idle' });

    expect(sink.write).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/u)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('writes the file durably before acknowledging and committing, in that order', async () => {
    const order: string[] = [];
    const sink = {
      write: vi.fn<(name: string, contents: string) => Promise<void>>(() => {
        order.push('write');
        return Promise.resolve();
      }),
    };
    const { pool } = fakePool((sql, values) => {
      order.push(String(sql).trim().split(/\s/u)[0]!.replace(/\W.*$/u, ''));
      if (sql.includes('claim_deletion_journal_batch')) {
        expect(values).toEqual([DELETION_JOURNAL_EXPORT_BATCH_LIMIT]);
        return { rows: [journalRow(7), journalRow(8)] };
      }
      if (sql.includes('ack_deletion_journal_batch')) {
        expect(values).toEqual([['7', '8']]);
        return { rows: [{ acknowledged: 2 }] };
      }
      return { rows: [] };
    });

    const result = await runDeletionJournalExportOnce(pool, sink, clock);

    expect(result).toMatchObject({ exportedCount: 2, status: 'exported' });
    expect(order).toEqual(['BEGIN', 'SELECT', 'write', 'SELECT', 'COMMIT']);

    const [fileName, contents] = sink.write.mock.calls[0]!;
    expect(fileName).toMatch(/^deletion-journal-20320110T000005000Z-7-8-[0-9a-f]{8}\.ndjson$/u);
    expect(parseDeletionJournalFile(fileName, contents).map((entry) => entry.seq)).toEqual(['7', '8']);
  });

  it('exports a mixed v4 and v7 batch in one file without blocking later entries', async () => {
    const order: string[] = [];
    const sink = {
      write: vi.fn<(name: string, contents: string) => Promise<void>>(() => {
        order.push('write');
        return Promise.resolve();
      }),
    };
    const v7Row = (seq: number) => ({
      ...journalRow(seq),
      org_id: '01890f47-3f6b-7c82-98c3-b71ef3ed1001',
      owner_user_id: '01890f47-3f6b-7c82-98c3-b71ef3ed1002',
      run_id: `01890f47-3f6b-7c82-98c3-b71ef3ed${String(seq).padStart(4, '0')}`,
    });
    const { client, pool } = fakePool((sql, values) => {
      order.push(String(sql).trim().split(/\s/u)[0]!.replace(/\W.*$/u, ''));
      if (sql.includes('claim_deletion_journal_batch')) {
        return { rows: [journalRow(1), v7Row(2), journalRow(3), v7Row(4)] };
      }
      if (sql.includes('ack_deletion_journal_batch')) {
        expect(values).toEqual([['1', '2', '3', '4']]);
        return { rows: [{ acknowledged: 4 }] };
      }
      return { rows: [] };
    });

    await expect(runDeletionJournalExportOnce(pool, sink, clock)).resolves.toMatchObject({
      exportedCount: 4,
      status: 'exported',
    });

    expect(order).toEqual(['BEGIN', 'SELECT', 'write', 'SELECT', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith();
    const [fileName, contents] = sink.write.mock.calls[0]!;
    expect(parseDeletionJournalFile(fileName, contents).map((entry) => entry.runId)).toEqual([
      journalRow(1).run_id,
      v7Row(2).run_id,
      journalRow(3).run_id,
      v7Row(4).run_id,
    ]);
  });

  it('rolls back and keeps every row when the sink fails', async () => {
    const sink = { write: vi.fn(() => Promise.reject(new Error('disk full'))) };
    const { client, pool } = fakePool((sql) =>
      sql.includes('claim_deletion_journal_batch') ? { rows: [journalRow(1)] } : { rows: [] },
    );

    await expect(runDeletionJournalExportOnce(pool, sink, clock)).rejects.toThrow('disk full');

    const statements = client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/u)[0]);
    expect(statements).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(statements).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledWith();
  });

  it('rolls back when the acknowledgement count does not match the batch', async () => {
    const sink = { write: vi.fn(() => Promise.resolve()) };
    const { client, pool } = fakePool((sql) => {
      if (sql.includes('claim_deletion_journal_batch')) return { rows: [journalRow(1), journalRow(2)] };
      if (sql.includes('ack_deletion_journal_batch')) return { rows: [{ acknowledged: 1 }] };
      return { rows: [] };
    });

    await expect(runDeletionJournalExportOnce(pool, sink, clock)).rejects.toThrow('did not match');
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/u)[0]).at(-1)).toBe('ROLLBACK');
  });

  it('destroys the connection when the rollback itself fails or the commit outcome is unknown', async () => {
    const failingRollback = fakePool((sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return sql.includes('claim_deletion_journal_batch') ? { rows: [journalRow(1)] } : { rows: [] };
    });
    await expect(
      runDeletionJournalExportOnce(failingRollback.pool, { write: () => Promise.reject(new Error('boom')) }, clock),
    ).rejects.toThrow('boom');
    expect(failingRollback.client.release).toHaveBeenCalledWith(true);

    const failingCommit = fakePool((sql) => {
      if (sql === 'COMMIT') throw new Error('commit outcome unknown');
      if (sql.includes('claim_deletion_journal_batch')) return { rows: [journalRow(1)] };
      if (sql.includes('ack_deletion_journal_batch')) return { rows: [{ acknowledged: 1 }] };
      return { rows: [] };
    });
    await expect(
      runDeletionJournalExportOnce(failingCommit.pool, { write: () => Promise.resolve() }, clock),
    ).rejects.toThrow('commit outcome unknown');
    expect(failingCommit.client.release).toHaveBeenCalledWith(true);
    expect(failingCommit.client.query.mock.calls.map(([sql]) => sql)).not.toContain('ROLLBACK');
  });

  it.each([
    ['a non-UUID run identifier', 'not-a-uuid'],
    ['an uppercase run identifier', '01890F47-3F6B-7C82-98C3-B71EF3ED1003'],
    ['an unassigned UUID version', '01890f47-3f6b-0c82-98c3-b71ef3ed1003'],
  ])('rejects %s in a mixed batch before any write and rolls back', async (_label, runId) => {
    const sink = { write: vi.fn() };
    const { client, pool } = fakePool((sql) =>
      sql.includes('claim_deletion_journal_batch')
        ? { rows: [journalRow(1), { ...journalRow(2), run_id: runId }, journalRow(3)] }
        : { rows: [] },
    );

    await expect(runDeletionJournalExportOnce(pool, sink, clock)).rejects.toThrow();

    expect(sink.write).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/u)[0]).at(-1)).toBe(
      'ROLLBACK',
    );
  });

  it('rejects a malformed claim result and an invalid clock before any write', async () => {
    const sink = { write: vi.fn() };
    const malformed = fakePool((sql) =>
      sql.includes('claim_deletion_journal_batch')
        ? { rows: [{ ...journalRow(1), deleted_at: 'yesterday' }] }
        : { rows: [] },
    );
    await expect(runDeletionJournalExportOnce(malformed.pool, sink, clock)).rejects.toThrow(
      'invalid result',
    );
    expect(sink.write).not.toHaveBeenCalled();

    const untouched = fakePool(() => ({ rows: [] }));
    await expect(
      runDeletionJournalExportOnce(untouched.pool, sink, { utcNow: () => new Date(Number.NaN) }),
    ).rejects.toThrow('invalid UTC time');
    expect(untouched.client.query).not.toHaveBeenCalled();
  });
});
