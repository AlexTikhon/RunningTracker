import { ACTIVITY_HISTORY_VERSION } from '@running-tracker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadActivityHistory, type RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const response = (applied = { source: null, type: null }) => ({
  applied,
  items: [
    {
      captureSource: null,
      finishedAt: '2026-10-05T07:00:00.000Z',
      runId: 'a0000000-0000-4000-8000-000000000001',
      source: 'recorded_run',
      startedAt: '2026-10-05T06:00:00.000Z',
      summary: { state: 'stale' },
      type: 'run',
    },
  ],
  nextCursor: 'next',
  provenance: { historyVersion: ACTIVITY_HISTORY_VERSION, persisted: false, snapshot: 'single_read_only_transaction' },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activity history API call', () => {
  it('sends only the filters that are set and the cursor, uncached, with the session cookie', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(response())));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await expect(loadActivityHistory({ cursor: null, orgId, source: null, type: null }, signal)).resolves.toEqual(response());
    await loadActivityHistory({ cursor: 'abc_-', orgId, source: 'recorded_run', type: 'run' }, signal);
    await loadActivityHistory({ cursor: null, orgId, source: 'gpx', type: null }, signal);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/orgs/${orgId}/activity-history`,
      `/api/orgs/${orgId}/activity-history?source=recorded_run&type=run&cursor=abc_-`,
      `/api/orgs/${orgId}/activity-history?source=gpx`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin', signal });
  });

  it('refuses an answer outside the contract and passes the server’s refusal on', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...response(), totalDistanceM: 5 })));
    await expect(loadActivityHistory({ cursor: null, orgId, source: null, type: null }, new AbortController().signal)).rejects.toThrow();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'INVALID_CURSOR', message: 'The activity history cursor is invalid', requestId: '22222222-2222-4222-8222-222222222222' } }, 400)),
    );
    await expect(loadActivityHistory({ cursor: 'x', orgId, source: null, type: null }, new AbortController().signal)).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
      status: 400,
    } satisfies Partial<RunnerApiError>);
  });
});
