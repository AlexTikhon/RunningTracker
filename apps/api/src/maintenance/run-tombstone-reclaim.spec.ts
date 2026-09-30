import { describe, expect, it, vi } from 'vitest';

import {
  RUN_TOMBSTONE_RECLAIM_BATCH_LIMIT,
  runTombstoneReclaimOnce,
} from './run-tombstone-reclaim.js';

const effectiveNow = '2033-01-10T00:00:00.000Z';
const clock = { utcNow: () => new Date(effectiveNow) };

describe('P10.4 tombstone reclaim maintenance boundary', () => {
  it('passes the injected UTC instant and the bounded batch size in one statement', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reclaimed_count: 3 }] });

    await expect(runTombstoneReclaimOnce({ query }, clock)).resolves.toEqual({
      reclaimedCount: 3,
      status: 'reclaimed',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('app_private.reclaim_expired_run_tombstones'),
      [effectiveNow, 500],
    );
    expect(RUN_TOMBSTONE_RECLAIM_BATCH_LIMIT).toBe(500);
  });

  it('reports an empty cycle as idle', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reclaimed_count: 0 }] });

    await expect(runTombstoneReclaimOnce({ query }, clock)).resolves.toEqual({ status: 'idle' });
  });

  it.each([
    { rows: [] },
    { rows: [{ reclaimed_count: 1 }, { reclaimed_count: 1 }] },
    { rows: [{ reclaimed_count: -1 }] },
    { rows: [{ reclaimed_count: 1.5 }] },
    { rows: [{ reclaimed_count: 501 }] },
    { rows: [{ reclaimed_count: '1' }] },
    { rows: [{ reclaimed_count: null }] },
  ])('rejects a malformed function result %#', async (result) => {
    const query = vi.fn().mockResolvedValue(result);

    await expect(runTombstoneReclaimOnce({ query }, clock)).rejects.toThrow(
      'The tombstone reclaim function returned an invalid result',
    );
  });

  it('propagates a database failure without reporting progress', async () => {
    const query = vi.fn().mockRejectedValue(new Error('reclaim failed'));

    await expect(runTombstoneReclaimOnce({ query }, clock)).rejects.toThrow('reclaim failed');
  });

  it('rejects an invalid maintenance clock before querying', async () => {
    const query = vi.fn();

    await expect(
      runTombstoneReclaimOnce({ query }, { utcNow: () => new Date(Number.NaN) }),
    ).rejects.toThrow('invalid UTC time');
    expect(query).not.toHaveBeenCalled();
  });
});
