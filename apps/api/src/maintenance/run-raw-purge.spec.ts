import { describe, expect, it, vi } from 'vitest';

import {
  purgeRunRawPointsBatch,
  RUN_RAW_PURGE_BATCH_LIMIT,
  runRawPurgeOnce,
} from './run-raw-purge.js';

const orgId = 'a6500000-0000-4000-8000-000000000001';
const runId = 'a6500000-0000-4000-8000-000000000002';
const effectiveNow = '2031-01-10T00:00:00.000Z';
const clock = { utcNow: () => new Date(effectiveNow) };

describe('P10.1 raw point purge maintenance boundary', () => {
  it('invokes exactly one bounded database purge unit and maps its state', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          completed: false,
          current_raw_state: 'purging',
          deleted_count: RUN_RAW_PURGE_BATCH_LIMIT,
          has_more: true,
          previous_raw_state: 'available',
        },
      ],
    });

    await expect(
      purgeRunRawPointsBatch({ query }, orgId, runId, clock),
    ).resolves.toEqual({
      completed: false,
      currentRawState: 'purging',
      deletedCount: RUN_RAW_PURGE_BATCH_LIMIT,
      hasMore: true,
      previousRawState: 'available',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('purge_run_raw_points_batch'), [
      orgId,
      runId,
      RUN_RAW_PURGE_BATCH_LIMIT,
      effectiveNow,
    ]);
  });

  it.each([
    { rowCount: 0, rows: [] },
    {
      rowCount: 1,
      rows: [
        {
          completed: true,
          current_raw_state: 'purging',
          deleted_count: 0,
          has_more: false,
          previous_raw_state: 'available',
        },
      ],
    },
    {
      rowCount: 1,
      rows: [
        {
          completed: true,
          current_raw_state: 'purged',
          deleted_count: RUN_RAW_PURGE_BATCH_LIMIT + 1,
          has_more: false,
          previous_raw_state: 'purging',
        },
      ],
    },
  ])('rejects malformed database result %#', async (databaseResult) => {
    const query = vi.fn().mockResolvedValue(databaseResult);

    await expect(
      purgeRunRawPointsBatch({ query }, orgId, runId, clock),
    ).rejects.toThrow('The raw purge function returned an invalid result');
  });

  it('claims and commits exactly one eligible purge batch', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_raw_purge_candidate')) {
        return Promise.resolve({ rows: [{ org_id: orgId, run_id: runId }] });
      }
      if (sql.includes('purge_run_raw_points_batch')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              completed: true,
              current_raw_state: 'purged',
              deleted_count: 7,
              has_more: false,
              previous_raw_state: 'available',
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const connect = vi.fn().mockResolvedValue({ query, release });

    await expect(runRawPurgeOnce({ connect }, clock)).resolves.toEqual({
      completed: true,
      currentRawState: 'purged',
      deletedCount: 7,
      hasMore: false,
      orgId,
      previousRawState: 'available',
      runId,
      status: 'completed',
    });
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('claim_run_raw_purge_candidate'),
      [effectiveNow, 1_000],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('purge_run_raw_points_batch'),
      [orgId, runId, RUN_RAW_PURGE_BATCH_LIMIT, effectiveNow],
    );
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(release).toHaveBeenCalledWith();
  });

  it.each([
    { blocked: false, status: 'idle' },
    { blocked: true, status: 'blocked' },
  ] as const)('reports an empty cycle as $status', async ({ blocked, status }) => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_raw_purge_candidate')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('has_overdue_raw_purge_summary_blocker')) {
        return Promise.resolve({ rows: [{ blocked }] });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      runRawPurgeOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).resolves.toEqual({ status });
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys the client without rollback when commit outcome is unknown', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql.includes('claim_run_raw_purge_candidate')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('has_overdue_raw_purge_summary_blocker')) {
        return Promise.resolve({ rows: [{ blocked: false }] });
      }
      if (sql === 'COMMIT') return Promise.reject(new Error('commit lost'));
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      runRawPurgeOnce({ connect: vi.fn().mockResolvedValue({ query, release }) }, clock),
    ).rejects.toThrow('commit lost');
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith(true);
  });

  it('rejects an invalid maintenance clock before acquiring a client', async () => {
    const connect = vi.fn();

    await expect(
      runRawPurgeOnce({ connect }, { utcNow: () => new Date(Number.NaN) }),
    ).rejects.toThrow('invalid UTC time');
    expect(connect).not.toHaveBeenCalled();
  });
});
