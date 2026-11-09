import { afterEach, describe, expect, it, vi } from 'vitest';

import { trendsFixture } from './daily-trends-fixtures.js';
import { readDailyTrends, RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target = { endDate: '2026-11-09', orgId, timeZone: 'America/Argentina/Buenos_Aires' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daily trends API call', () => {
  it('reads the range with the end date and zone as a query, without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(trendsFixture()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readDailyTrends(target, new AbortController().signal)).resolves.toEqual(trendsFixture());
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-trends?endDate=2026-11-09&timeZone=America%2FArgentina%2FBuenos_Aires`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('refuses an answer for another range or outside the contract', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(trendsFixture('2026-11-08', {}, '2026-11-09'))));
    await expect(readDailyTrends(target, new AbortController().signal)).rejects.toThrow('The server returned a different range');
    const inconsistent = trendsFixture();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...inconsistent, summary: { ...inconsistent.summary, steps: { daysRecorded: 0, recordedTotal: 0, source: 'manual' } } })));
    await expect(readDailyTrends(target, new AbortController().signal)).rejects.toThrow();
  });

  it('turns the error envelope into a RunnerApiError', async () => {
    const refusal = { error: { code: 'INVALID_REQUEST', message: 'The end date cannot be after today', requestId: '22222222-2222-4222-8222-222222222222' } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal, 400)));
    const failure = await readDailyTrends(target, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerApiError);
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });
});
