import { afterEach, describe, expect, it, vi } from 'vitest';

import { listDailyMetrics, putDailyMetrics, readDailyMetrics } from './runner-api.js';

const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = { mood: 4, note: null, sleepMinutes: 450, sleepQuality: null, soreness: null, timeZone: 'Europe/Warsaw', weightKg: 72.35 };
const view = {
  createdAt: '2026-11-06T08:00:00.000Z',
  localDate: '2026-11-06',
  mood: 4,
  note: null,
  sleepMinutes: 450,
  sleepQuality: null,
  soreness: null,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-11-06T08:00:00.000Z',
  weightKg: 72.35,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refusal = (code: string) => ({ error: { code, message: 'No', requestId: '22222222-2222-4222-8222-222222222222' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daily metrics API calls', () => {
  it('replaces a day with a PUT to its date, carrying JSON and the CSRF header, and reports 201 as created', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view, 201));
    vi.stubGlobal('fetch', fetchMock);
    await expect(putDailyMetrics({ localDate: '2026-11-06', orgId }, request, csrf, new AbortController().signal)).resolves.toEqual({
      created: true,
      view,
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-metrics/2026-11-06`, {
      body: JSON.stringify(request),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'PUT',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(view, 200)));
    await expect(putDailyMetrics({ localDate: '2026-11-06', orgId }, request, csrf, new AbortController().signal)).resolves.toMatchObject({
      created: false,
    });
  });

  it('refuses an answer for another date', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json({ ...view, localDate: '2026-11-05' }, 200))));
    await expect(putDailyMetrics({ localDate: '2026-11-06', orgId }, request, csrf, new AbortController().signal)).rejects.toThrow(
      'The server returned a different date',
    );
    await expect(readDailyMetrics({ localDate: '2026-11-06', orgId }, new AbortController().signal)).rejects.toThrow(
      'The server returned a different date',
    );
  });

  it('reads a day without caching, and answers null for a day without a record but throws for other refusals', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readDailyMetrics({ localDate: '2026-11-06', orgId }, new AbortController().signal)).resolves.toEqual(view);
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-metrics/2026-11-06`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('DAILY_METRICS_NOT_FOUND'), 404)));
    await expect(readDailyMetrics({ localDate: '2026-11-06', orgId }, new AbortController().signal)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('ROUTE_NOT_FOUND'), 404)));
    await expect(readDailyMetrics({ localDate: '2026-11-06', orgId }, new AbortController().signal)).rejects.toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      status: 404,
    });
  });

  it('lists a range with from and to, without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [view] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listDailyMetrics({ from: '2026-10-24', orgId, to: '2026-11-06' }, new AbortController().signal)).resolves.toEqual({
      items: [view],
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-metrics?from=2026-10-24&to=2026-11-06`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });
});
