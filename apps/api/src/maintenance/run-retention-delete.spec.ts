import { describe, expect, it, vi } from 'vitest';

import { runRetentionDeleteOnce } from './run-retention-delete.js';

const orgId = 'a6500000-0000-4000-8000-000000000001';
const runId = 'a6500000-0000-4000-8000-000000000002';
const effectiveNow = '2032-01-10T00:00:00.000Z';
const clock = { utcNow: () => new Date(effectiveNow) };

describe('P10.3 annual retention deletion maintenance boundary', () => {
  it('claims and commits exactly one eligible deletion', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [{ org_id: orgId, run_id: runId }] });
      }
      if (sql.includes('delete_run_for_retention')) {
        return Promise.resolve({ rows: [{ archive_revision: '8' }] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const connect = vi.fn().mockResolvedValue({ query, release });

    await expect(runRetentionDeleteOnce({ connect }, clock)).resolves.toEqual({
      archiveRevision: '8',
      orgId,
      runId,
      status: 'deleted',
    });
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('claim_run_deletion_candidate'),
      [effectiveNow, 1_000],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('delete_run_for_retention'),
      [orgId, runId, effectiveNow],
    );
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(release).toHaveBeenCalledWith();
  });

  it('accepts UUID v7 candidate identifiers and deletes with them unchanged', async () => {
    const v7Org = '01890f47-3f6b-7c82-98c3-b71ef3ed1001';
    const v7Run = '01890f47-3f6b-7c82-98c3-b71ef3ed1003';
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [{ org_id: v7Org, run_id: v7Run }] });
      }
      if (sql.includes('delete_run_for_retention')) {
        return Promise.resolve({ rows: [{ archive_revision: '9' }] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      runRetentionDeleteOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).resolves.toEqual({ archiveRevision: '9', orgId: v7Org, runId: v7Run, status: 'deleted' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('delete_run_for_retention'), [
      v7Org,
      v7Run,
      effectiveNow,
    ]);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledWith();
  });

  it.each([
    ['an uppercase run identifier', '01890F47-3F6B-7C82-98C3-B71EF3ED1003'],
    ['an unassigned UUID version', '01890f47-3f6b-0c82-98c3-b71ef3ed1003'],
  ])('rejects %s from the candidate function and rolls back', async (_label, badRunId) => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [{ org_id: orgId, run_id: badRunId }] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();

    await expect(
      runRetentionDeleteOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).rejects.toThrow('The run deletion candidate function returned an invalid result');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith();
  });

  it('reports an empty cycle as idle', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      runRetentionDeleteOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).resolves.toEqual({ status: 'idle' });
    expect(release).toHaveBeenCalledWith();
  });

  it.each([
    { org_id: 'not-a-uuid', run_id: runId },
    { org_id: orgId, run_id: 'not-a-uuid' },
  ])('rejects a malformed candidate result %#', async (row) => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [row] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const connect = vi.fn().mockResolvedValue({ query, release: vi.fn() });

    await expect(runRetentionDeleteOnce({ connect }, clock)).rejects.toThrow(
      'The run deletion candidate function returned an invalid result',
    );
  });

  it('rejects a malformed deletion result', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [{ org_id: orgId, run_id: runId }] });
      }
      if (sql.includes('delete_run_for_retention')) {
        return Promise.resolve({ rows: [{ archive_revision: 'not-a-number' }] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const connect = vi.fn().mockResolvedValue({ query, release: vi.fn() });

    await expect(runRetentionDeleteOnce({ connect }, clock)).rejects.toThrow(
      'The run deletion function returned an invalid result',
    );
  });

  it('destroys the client without rollback when commit outcome is unknown', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql === 'COMMIT') return Promise.reject(new Error('commit lost'));
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      runRetentionDeleteOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).rejects.toThrow('commit lost');
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith(true);
  });

  it('rolls back on a failed claim query', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_deletion_candidate')) {
        return Promise.reject(new Error('claim failed'));
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      runRetentionDeleteOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).rejects.toThrow('claim failed');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith();
  });

  it('rejects an invalid maintenance clock before acquiring a client', async () => {
    const connect = vi.fn();

    await expect(
      runRetentionDeleteOnce({ connect }, { utcNow: () => new Date(Number.NaN) }),
    ).rejects.toThrow('invalid UTC time');
    expect(connect).not.toHaveBeenCalled();
  });
});
