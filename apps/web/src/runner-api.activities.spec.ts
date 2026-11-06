import { afterEach, describe, expect, it, vi } from 'vitest';

import { onAuthenticationRequired } from './request.js';
import { createActivity, deleteActivity, listActivities, readActivity } from './runner-api.js';

const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activityId = 'ad000000-0000-4000-8000-000000000001';
const details = { distanceM: 5_000, durationS: 1_800, notes: null, rpe: 6, startedAt: '2026-10-05T06:00:00.000Z', type: 'run' as const };
const request = { ...details, idempotencyKey: 'bf000000-0000-4000-8000-000000000001' };
const view = { ...details, activityId, createdAt: '2026-10-05T08:00:00.000Z', source: 'manual' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activity API calls', () => {
  it('creates with a PUT to the client-chosen id, carrying JSON and the CSRF header, and reports 201 as created', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createActivity({ activityId, orgId }, request, csrf, new AbortController().signal)).resolves.toEqual({
      activity: view,
      created: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/activities/${activityId}`, {
      body: JSON.stringify(request),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'PUT',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('reports an equal retry (200) as not created, and refuses a newly created activity under another id', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(view, 200)));
    await expect(createActivity({ activityId, orgId }, request, csrf, new AbortController().signal)).resolves.toMatchObject({
      created: false,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...view, activityId: 'ad000000-0000-4000-8000-000000000002' }, 201)));
    await expect(createActivity({ activityId, orgId }, request, csrf, new AbortController().signal)).rejects.toThrow(
      'The server returned a different activity',
    );
  });

  it('accepts a replay (200) of the activity this form session saved earlier under another id', async () => {
    const earlier = { ...view, activityId: 'ad000000-0000-4000-8000-000000000002' };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(earlier, 200)));
    await expect(createActivity({ activityId, orgId }, request, csrf, new AbortController().signal)).resolves.toEqual({
      activity: earlier,
      created: false,
    });
  });

  it('surfaces a refusal with its status, code, request id and details', async () => {
    const error = {
      error: {
        code: 'ACTIVITY_ALREADY_SAVED',
        details: { activityId: 'ad000000-0000-4000-8000-000000000009' },
        message: 'Already saved',
        requestId: '22222222-2222-4222-8222-222222222222',
      },
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(error, 409)));
    await expect(createActivity({ activityId, orgId }, request, csrf, new AbortController().signal)).rejects.toMatchObject({
      code: 'ACTIVITY_ALREADY_SAVED',
      details: { activityId: 'ad000000-0000-4000-8000-000000000009' },
      requestId: '22222222-2222-4222-8222-222222222222',
      status: 409,
    });
  });

  it('reads one activity, never cached, and refuses an answer about another one', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(view));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readActivity({ activityId, orgId }, new AbortController().signal)).resolves.toEqual(view);
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/activities/${activityId}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...view, activityId: 'ad000000-0000-4000-8000-000000000002' })));
    await expect(readActivity({ activityId, orgId }, new AbortController().signal)).rejects.toThrow('different activity');
  });

  it('lists without parameters for the first page and with the cursor afterwards, never cached', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json({ items: [view], nextCursor: 'next' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listActivities({ cursor: null, orgId }, new AbortController().signal)).resolves.toEqual({ items: [view], nextCursor: 'next' });
    await listActivities({ cursor: 'abc_-', orgId }, new AbortController().signal);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/orgs/${orgId}/activities`,
      `/api/orgs/${orgId}/activities?cursor=abc_-`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  });

  it('refuses a list outside the contract', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ items: [{ ...view, userId: orgId }], nextCursor: null })));
    await expect(listActivities({ cursor: null, orgId }, new AbortController().signal)).rejects.toThrow();
  });

  it('deletes with a DELETE that carries the CSRF header and accepts the empty 204', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteActivity({ activityId, orgId }, csrf, new AbortController().signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/activities/${activityId}`, {
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrf.token },
      method: 'DELETE',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('encodes the path segments', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteActivity({ activityId: 'c?d', orgId: 'a/b' }, csrf, new AbortController().signal);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/orgs/a%2Fb/activities/c%3Fd');
  });

  it('announces a 401 like every other request', async () => {
    const error = { error: { code: 'AUTH_REQUIRED', message: 'no', requestId: '22222222-2222-4222-8222-222222222222' } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(error, 401)));
    const announced = vi.fn();
    const unsubscribe = onAuthenticationRequired(announced);
    try {
      await expect(listActivities({ cursor: null, orgId }, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
      expect(announced).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
