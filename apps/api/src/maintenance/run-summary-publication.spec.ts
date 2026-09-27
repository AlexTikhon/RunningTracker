import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
import {
  runSummaryPublicationBatch,
  runSummaryPublicationOnce,
} from './run-summary-publication.js';

const clock: Pick<Clock, 'utcNow'> = {
  utcNow: () => new Date('2026-09-26T18:30:00.000Z'),
};

const candidate = {
  algorithm_version: 'v1',
  org_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  source_revision: '7',
};

function createPool(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  return {
    connect: vi.fn().mockResolvedValue({ query, release }),
    release,
  };
}

describe('runSummaryPublicationOnce', () => {
  it('commits an idle transaction when no claimable candidate exists', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = createPool(query);

    await expect(runSummaryPublicationOnce(pool as never, clock)).resolves.toEqual({
      status: 'idle',
    });
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(query.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining('claim_stale_run_summary'),
    );
    expect(query.mock.calls[2]?.[0]).toBe('COMMIT');
    expect(query.mock.calls[1]?.[1]).toEqual([1_000]);
    expect(pool.release).toHaveBeenCalledWith();
  });

  it('calculates and publishes exactly the revision protected by the claim', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [{ archive_revision: '12', published: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = createPool(query);

    await expect(runSummaryPublicationOnce(pool as never, clock)).resolves.toEqual({
      algorithmVersion: 'v1',
      archiveRevision: '12',
      orgId: candidate.org_id,
      runId: candidate.run_id,
      sourceRevision: '7',
      status: 'published',
    });
    expect(query.mock.calls[2]?.[0]).toContain('MATERIALIZED');
    expect(query.mock.calls[2]?.[0]).toContain('app_private.publish_run_summary');
    expect(query.mock.calls[2]?.[1]).toEqual([
      candidate.org_id,
      candidate.run_id,
      '7',
      'v1',
      '2026-09-26T18:30:00.000Z',
    ]);
    expect(query.mock.calls[3]?.[0]).toBe('COMMIT');
  });

  it('rolls back malformed database results and destroys a client after an unknown commit', async () => {
    const invalidQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...candidate, source_revision: '-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const invalidPool = createPool(invalidQuery);
    await expect(runSummaryPublicationOnce(invalidPool as never, clock)).rejects.toThrow(
      'summary candidate function returned an invalid result',
    );
    expect(invalidQuery.mock.calls[2]?.[0]).toBe('ROLLBACK');
    expect(invalidPool.release).toHaveBeenCalledWith();

    const commitFailure = new Error('commit outcome unknown');
    const commitQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(commitFailure);
    const commitPool = createPool(commitQuery);
    await expect(runSummaryPublicationOnce(commitPool as never, clock)).rejects.toBe(
      commitFailure,
    );
    expect(commitQuery).toHaveBeenCalledTimes(3);
    expect(commitPool.release).toHaveBeenCalledWith(true);
  });

  it('rejects an invalid clock before acquiring a connection', async () => {
    const pool = createPool(vi.fn());
    await expect(
      runSummaryPublicationOnce(pool as never, { utcNow: () => new Date(Number.NaN) }),
    ).rejects.toThrow('maintenance clock returned an invalid UTC time');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('runSummaryPublicationBatch', () => {
  it('starts only the configured worker count and aggregates outcomes', async () => {
    const outcomes = [
      { archive_revision: '1', published: true },
      { archive_revision: '1', published: false },
      undefined,
    ];
    let nextWorker = 0;
    const connect = vi.fn().mockImplementation(() => {
      const worker = nextWorker;
      nextWorker += 1;
      const outcome = outcomes[worker];
      return Promise.resolve({
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT') {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('claim_stale_run_summary')) {
            return Promise.resolve({
              rows:
                outcome === undefined
                  ? []
                  : [
                      {
                        ...candidate,
                        run_id: `bbbbbbbb-bbbb-4bbb-8bbb-${worker.toString().padStart(12, '0')}`,
                      },
                    ],
            });
          }
          if (sql.includes('publish_run_summary') && outcome !== undefined) {
            return Promise.resolve({ rows: [outcome] });
          }
          throw new Error(`Unexpected query: ${sql}`);
        }),
        release: vi.fn(),
      });
    });

    await expect(
      runSummaryPublicationBatch({ connect }, clock, 3),
    ).resolves.toEqual({ idleCount: 1, publishedCount: 1, staleCount: 1 });
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('waits for every worker to settle before reporting failures and enforces the bound', async () => {
    await expect(runSummaryPublicationBatch({} as never, clock, 0)).rejects.toThrow(
      'integer between 1 and 8',
    );
    await expect(runSummaryPublicationBatch({} as never, clock, 9)).rejects.toThrow(
      'integer between 1 and 8',
    );

    let resolveSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    let connection = 0;
    const connect = vi.fn().mockImplementation(() => {
      const current = connection;
      connection += 1;
      return Promise.resolve({
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === 'BEGIN') {
            return { rows: [] };
          }
          if (sql.includes('claim_stale_run_summary')) {
            if (current === 0) {
              throw new Error('claim failed');
            }
            await slow;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK' || sql === 'COMMIT') {
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }),
        release: vi.fn(),
      });
    });
    let settled = false;
    const batch = runSummaryPublicationBatch({ connect }, clock, 2).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveSlow();
    await expect(batch).rejects.toThrow('1 run summary worker(s) failed');
  });
});
