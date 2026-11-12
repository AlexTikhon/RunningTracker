import { afterEach, describe, expect, it, vi } from 'vitest';

import { activityTrendsFixture } from './activity-trends-fixtures.js';
import { readActivityTrends, RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target = { endDate: '2026-11-12', orgId, source: 'gpx' as const, timeZone: 'Europe/Warsaw', type: 'hike' as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fixture = (overrides: Parameters<typeof activityTrendsFixture>[0] = {}) =>
  activityTrendsFixture({ source: 'gpx', timeZone: 'Europe/Warsaw', type: 'hike', ...overrides });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activity trends API call', () => {
  it('sends all four filters once each, without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(fixture()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readActivityTrends(target, new AbortController().signal)).resolves.toEqual(fixture());
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/activity-trends?endDate=2026-11-12&source=gpx&timeZone=Europe%2FWarsaw&type=hike`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('refuses an answer echoing other filters, or one outside the contract', async () => {
    for (const other of [fixture({ type: 'walk' }), fixture({ source: 'manual' }), fixture({ endDate: '2026-11-11', today: '2026-11-12' }), fixture({ timeZone: 'UTC' })]) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(other)));
      await expect(readActivityTrends(target, new AbortController().signal)).rejects.toThrow('The server returned activity trends for other filters');
    }
    const answer = fixture();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...answer, summary: { ...answer.summary, count: 3 } })));
    await expect(readActivityTrends(target, new AbortController().signal)).rejects.toThrow();
  });

  it('accepts the canonical spelling of the requested zone: a lowercase name and an alias are the same zone', async () => {
    const cases = [
      { echoed: 'Europe/Warsaw', requested: 'europe/warsaw' },
      { echoed: 'Europe/Warsaw', requested: 'EUROPE/WARSAW' },
      // An alias the platform resolves: whichever spelling the server's platform prefers, this engine resolves both alike.
      { echoed: 'America/New_York', requested: 'US/Eastern' },
      { echoed: 'Asia/Calcutta', requested: 'Asia/Kolkata' },
      { echoed: 'Asia/Kolkata', requested: 'Asia/Calcutta' },
    ];
    for (const { echoed, requested } of cases) {
      const answer = fixture({ timeZone: echoed });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(answer)));
      await expect(readActivityTrends({ ...target, timeZone: requested }, new AbortController().signal)).resolves.toEqual(answer);
    }
  });

  it('refuses an answer for a genuinely different zone, also when the zones agree on today', async () => {
    for (const [requested, echoed] of [
      ['Europe/Warsaw', 'Europe/Berlin'],
      ['europe/warsaw', 'Europe/Berlin'],
      ['US/Eastern', 'America/Chicago'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(fixture({ timeZone: echoed }))));
      await expect(readActivityTrends({ ...target, timeZone: requested }, new AbortController().signal)).rejects.toThrow(
        'The server returned activity trends for other filters',
      );
    }
  });

  it('fails cleanly for an invalid zone name: the server’s refusal, or a mismatch for an invalid echo, never a RangeError', async () => {
    const refusal = { error: { code: 'INVALID_REQUEST', message: 'Invalid time zone', requestId: '33333333-3333-4333-8333-333333333333' } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal, 400)));
    const failure = await readActivityTrends({ ...target, timeZone: 'Not/A_Zone' }, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerApiError);
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(fixture({ timeZone: 'Not/A_Zone' }))));
    const mismatch = await readActivityTrends(target, new AbortController().signal).catch((error: unknown) => error);
    expect(mismatch).not.toBeInstanceOf(RangeError);
    expect(mismatch).toMatchObject({ message: 'The server returned activity trends for other filters' });
  });

  it('turns the error envelope into a RunnerApiError', async () => {
    const refusal = { error: { code: 'INVALID_REQUEST', message: 'The end date cannot be after today', requestId: '22222222-2222-4222-8222-222222222222' } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal, 400)));
    const failure = await readActivityTrends(target, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerApiError);
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });
});
