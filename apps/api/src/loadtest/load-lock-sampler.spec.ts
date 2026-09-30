import { describe, expect, it, vi } from 'vitest';

import { createLockSampler, summarizeLockSamples } from './load-lock-sampler.js';

describe('createLockSampler', () => {
  it('reports waiting lock requests per application and lock type from the catalogs, never query text', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { application: 'running-tracker-api', locktype: 'transactionid', waiting: 3 },
        { application: 'running-tracker-maintenance', locktype: 'tuple', waiting: 1 },
      ],
    });

    const observations = await createLockSampler({ query })();

    expect(observations).toEqual([
      { application: 'running-tracker-api', locktype: 'transactionid', waiting: 3 },
      { application: 'running-tracker-maintenance', locktype: 'tuple', waiting: 1 },
    ]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/pg_locks/u);
    expect(sql).toMatch(/NOT lock\.granted/u);
    // Only the two application names of the API's own pools are observed, and no statement text is selected.
    expect(sql).toContain("'running-tracker-api'");
    expect(sql).toContain("'running-tracker-maintenance'");
    expect(sql).not.toMatch(/\bquery\b/iu);
  });

  it('returns an empty list when nothing waits and rejects a malformed row', async () => {
    expect(await createLockSampler({ query: vi.fn().mockResolvedValue({ rows: [] }) })()).toEqual([]);
    await expect(
      createLockSampler({ query: vi.fn().mockResolvedValue({ rows: [{ application: 1, locktype: 'x', waiting: 'a' }] }) })(),
    ).rejects.toThrow(/lock sample/u);
  });
});

describe('summarizeLockSamples', () => {
  const samples = [
    { atMs: 0, waits: [] },
    { atMs: 250, waits: [{ application: 'running-tracker-api', locktype: 'transactionid', waiting: 2 }] },
    {
      atMs: 500,
      waits: [
        { application: 'running-tracker-api', locktype: 'transactionid', waiting: 5 },
        { application: 'running-tracker-maintenance', locktype: 'tuple', waiting: 1 },
      ],
    },
    { atMs: 750, waits: [] },
  ];

  it('counts the samples with any waiter, the peak, and each application and lock type separately', () => {
    expect(summarizeLockSamples(samples)).toEqual({
      byApplication: {
        'running-tracker-api': { peakWaiting: 5, samplesWithWaiters: 2 },
        'running-tracker-maintenance': { peakWaiting: 1, samplesWithWaiters: 1 },
      },
      byLockType: { transactionid: { peakWaiting: 5, samplesWithWaiters: 2 }, tuple: { peakWaiting: 1, samplesWithWaiters: 1 } },
      peakWaiting: 6,
      sampleCount: 4,
      samplesWithWaiters: 2,
    });
  });

  it('is all zero for no samples', () => {
    expect(summarizeLockSamples([])).toEqual({
      byApplication: {},
      byLockType: {},
      peakWaiting: 0,
      sampleCount: 0,
      samplesWithWaiters: 0,
    });
  });
});
