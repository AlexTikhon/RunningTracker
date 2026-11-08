import { afterEach, describe, expect, it, vi } from 'vitest';

import { overviewFixture } from './daily-overview-fixtures.js';
import { readDailyOverview, RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target = { localDate: '2026-11-05', orgId, timeZone: 'America/Argentina/Buenos_Aires' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daily overview API call', () => {
  it('reads the date with the zone as a query, without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(overviewFixture()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readDailyOverview(target, new AbortController().signal)).resolves.toEqual(overviewFixture());
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-overview/2026-11-05?timeZone=America%2FArgentina%2FBuenos_Aires`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('refuses an answer for another date or outside the contract', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(overviewFixture({ day: { ...overviewFixture().day, localDate: '2026-11-04' } }))));
    await expect(readDailyOverview(target, new AbortController().signal)).rejects.toThrow('The server returned a different date');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...overviewFixture(), checkIn: { note: 'x', recorded: true } })));
    await expect(readDailyOverview(target, new AbortController().signal)).rejects.toThrow();
  });

  it('turns the error envelope into a RunnerApiError', async () => {
    const refusal = { error: { code: 'INVALID_REQUEST', message: 'The date cannot be after today', requestId: '22222222-2222-4222-8222-222222222222' } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal, 400)));
    const failure = await readDailyOverview(target, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerApiError);
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });
});
