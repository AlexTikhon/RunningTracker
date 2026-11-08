import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteDailyMovement, listDailyMovement, putDailyMovement, readDailyMovement } from './runner-api.js';

const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = { activeEnergyKcal: null, steps: 0, timeZone: 'Europe/Warsaw' };
const view = {
  activeEnergyKcal: null,
  createdAt: '2026-11-06T08:00:00.000Z',
  localDate: '2026-11-06',
  source: 'manual',
  steps: 0,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-11-06T08:00:00.000Z',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refusal = (code: string) => ({ error: { code, message: 'No', requestId: '22222222-2222-4222-8222-222222222222' } });
const target = { localDate: '2026-11-06', orgId };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daily movement API calls', () => {
  it('replaces a day with a PUT to its date, carrying JSON (a zero kept as zero) and the CSRF header; 201 is created', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view, 201));
    vi.stubGlobal('fetch', fetchMock);
    await expect(putDailyMovement(target, request, csrf, new AbortController().signal)).resolves.toEqual({ created: true, view });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-movement/2026-11-06`, {
      body: '{"activeEnergyKcal":null,"steps":0,"timeZone":"Europe/Warsaw"}',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'PUT',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(view, 200)));
    await expect(putDailyMovement(target, request, csrf, new AbortController().signal)).resolves.toMatchObject({ created: false });
  });

  it('refuses an answer for another date, or one claiming another source', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json({ ...view, localDate: '2026-11-05' }))));
    await expect(putDailyMovement(target, request, csrf, new AbortController().signal)).rejects.toThrow('The server returned a different date');
    await expect(readDailyMovement(target, new AbortController().signal)).rejects.toThrow('The server returned a different date');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json({ ...view, source: 'apple_health' }))));
    await expect(readDailyMovement(target, new AbortController().signal)).rejects.toThrow();
  });

  it('reads a day without caching, and answers null only for DAILY_MOVEMENT_NOT_FOUND', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readDailyMovement(target, new AbortController().signal)).resolves.toEqual(view);
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-movement/2026-11-06`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('DAILY_MOVEMENT_NOT_FOUND'), 404)));
    await expect(readDailyMovement(target, new AbortController().signal)).resolves.toBeNull();
    // The check-in's not-found code is not this entity's.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('DAILY_METRICS_NOT_FOUND'), 404)));
    await expect(readDailyMovement(target, new AbortController().signal)).rejects.toMatchObject({ code: 'DAILY_METRICS_NOT_FOUND', status: 404 });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('ROUTE_NOT_FOUND'), 404)));
    await expect(readDailyMovement(target, new AbortController().signal)).rejects.toMatchObject({ code: 'ROUTE_NOT_FOUND', status: 404 });
  });

  it('deletes a day with a DELETE to its date carrying only the CSRF header, and throws a refusal', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteDailyMovement(target, csrf, new AbortController().signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-movement/2026-11-06`, {
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrf.token },
      method: 'DELETE',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('CSRF_DENIED'), 403)));
    await expect(deleteDailyMovement(target, csrf, new AbortController().signal)).rejects.toMatchObject({ code: 'CSRF_DENIED', status: 403 });
  });

  it('lists a range with from and to, without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [view] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listDailyMovement({ from: '2026-10-24', orgId, to: '2026-11-06' }, new AbortController().signal)).resolves.toEqual({
      items: [view],
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/daily-movement?from=2026-10-24&to=2026-11-06`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });
});
