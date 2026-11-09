import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMeal, deleteMeal, listMeals, RunnerApiError, updateMeal } from './runner-api.js';

const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mealId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const view = {
  carbohydrateG: null,
  createdAt: '2026-11-06T08:00:00.000Z',
  energyKcal: 0,
  fatG: null,
  localDate: '2026-11-06',
  mealId,
  mealType: 'snack',
  proteinG: 12.5,
  source: 'manual',
  timeZone: 'Europe/Warsaw',
  title: 'Yoghurt',
  updatedAt: '2026-11-06T08:00:00.000Z',
};
const createRequest = {
  carbohydrateG: null,
  energyKcal: 0,
  fatG: null,
  idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  localDate: '2026-11-06',
  mealType: 'snack' as const,
  proteinG: 12.5,
  timeZone: 'Europe/Warsaw',
  title: 'Yoghurt',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refusal = (code: string, details?: Record<string, unknown>) => ({
  error: { code, message: 'No', requestId: '22222222-2222-4222-8222-222222222222', ...(details === undefined ? {} : { details }) },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('meal log API calls (ADR-0083)', () => {
  it('creates with a POST carrying the form session key, JSON (a zero kept as zero) and the CSRF header; 201 is created, 200 a retry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view, 201));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createMeal(orgId, createRequest, csrf, new AbortController().signal)).resolves.toEqual({ created: true, view });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/meals`, {
      body: JSON.stringify(createRequest),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'POST',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ energyKcal: 0, fatG: null, idempotencyKey: createRequest.idempotencyKey });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(view, 200)));
    await expect(createMeal(orgId, createRequest, csrf, new AbortController().signal)).resolves.toMatchObject({ created: false });
  });

  it('passes on 409 MEAL_ALREADY_SAVED with its details, and refuses an answer for another date or another source', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('MEAL_ALREADY_SAVED', { mealId }), 409)));
    const error = await createMeal(orgId, createRequest, csrf, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunnerApiError);
    expect(error).toMatchObject({ code: 'MEAL_ALREADY_SAVED', details: { mealId }, status: 409 });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...view, localDate: '2026-11-05' }, 201)));
    await expect(createMeal(orgId, createRequest, csrf, new AbortController().signal)).rejects.toThrow('The server returned an entry of a different date');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...view, source: 'barcode' }, 201)));
    await expect(createMeal(orgId, createRequest, csrf, new AbortController().signal)).rejects.toThrow();
  });

  it('replaces the editable fields with a PUT to the entry, and refuses an answer for another entry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view));
    vi.stubGlobal('fetch', fetchMock);
    const body = { carbohydrateG: null, energyKcal: 0, fatG: null, mealType: 'snack' as const, proteinG: 12.5, title: 'Yoghurt' };
    await expect(updateMeal({ mealId, orgId }, body, csrf, new AbortController().signal)).resolves.toEqual(view);
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/meals/${mealId}`, {
      body: JSON.stringify(body),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'PUT',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...view, mealId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })));
    await expect(updateMeal({ mealId, orgId }, body, csrf, new AbortController().signal)).rejects.toThrow('The server returned a different entry');
  });

  it('lists one date without caching, with the cursor when given, and refuses entries of another date', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json({ items: [view], nextCursor: 'next' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listMeals({ cursor: null, localDate: '2026-11-06', orgId }, new AbortController().signal)).resolves.toEqual({ items: [view], nextCursor: 'next' });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/meals?localDate=2026-11-06`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    await listMeals({ cursor: 'abc_-', localDate: '2026-11-06', orgId }, new AbortController().signal);
    expect(fetchMock.mock.calls[1]![0]).toBe(`/api/orgs/${orgId}/meals?localDate=2026-11-06&cursor=abc_-`);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ items: [view], nextCursor: null })));
    await expect(listMeals({ cursor: null, localDate: '2026-11-05', orgId }, new AbortController().signal)).rejects.toThrow(
      'The server returned entries of a different date',
    );
  });

  it('deletes with a DELETE to the entry carrying only the CSRF header, and throws a refusal', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteMeal({ mealId, orgId }, csrf, new AbortController().signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/meals/${mealId}`, {
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrf.token },
      method: 'DELETE',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(refusal('CSRF_DENIED'), 403)));
    await expect(deleteMeal({ mealId, orgId }, csrf, new AbortController().signal)).rejects.toMatchObject({ code: 'CSRF_DENIED', status: 403 });
  });
});
