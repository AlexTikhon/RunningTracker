import { archiveTrackResponseSchema, type ArchiveTrackResponse } from '@running-tracker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadArchiveTrack, RunnerApiError } from './runner-api.js';
import { RunDetailController, type RunDetailSnapshot } from './run-detail-controller.js';

const scope = { orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
function feature(state: 'pending' | 'stale' | 'ready' = 'ready'): ArchiveTrackResponse {
  return archiveTrackResponseSchema.parse({
    type: 'Feature', geometry: null,
    properties: {
      runId: scope.runId, startedAt: '2026-11-01T08:00:00Z', finishedAt: '2026-11-01T09:00:00Z',
      rawState: 'purged', dataRevision: '2', sourceRevision: state === 'pending' ? null : state === 'stale' ? '1' : '2',
      algorithmVersion: state === 'pending' ? null : 'v1', summaryState: state,
      distanceM: state === 'ready' ? 0 : null, observedDurationS: state === 'ready' ? 0 : null,
      qualityStats: state !== 'ready' ? null : {
        acceptedEdgeCount: 0, acceptedPointCount: 0, excessiveSpeedCount: 0, excessiveTimeGapCount: 0,
        insufficientData: true, nonpositiveTimeDeltaCount: 0, poorAccuracyPointCount: 0,
        rawPointCount: 1, segmentBreakCount: 0, seqGapCount: 0,
      },
    },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}
function harness(load: (target: typeof scope, signal: AbortSignal) => Promise<ArchiveTrackResponse>) {
  const session = new AbortController();
  const snapshots: RunDetailSnapshot[] = [];
  const controller = new RunDetailController({ load, onChange: (snapshot) => snapshots.push(snapshot), scope, signal: session.signal });
  return { controller, session, snapshots, latest: () => snapshots.at(-1)! };
}
afterEach(() => vi.unstubAllGlobals());

describe('run detail lifetime', () => {
  it.each(['pending', 'stale', 'ready'] as const)('shows %s without automatic retries', async (state) => {
    const load = vi.fn().mockResolvedValue(feature(state));
    const h = harness(load);
    await h.controller.refresh();
    expect(h.snapshots[0]).toEqual({ status: 'loading' });
    expect(h.latest()).toMatchObject({ status: 'ready', feature: feature(state) });
    expect(load).toHaveBeenCalledOnce();
    h.controller.dispose();
  });

  it('aborts the displayed result before refreshing and never retains it after an error', async () => {
    const load = vi.fn().mockResolvedValueOnce(feature()).mockRejectedValueOnce(new Error('private server detail'));
    const h = harness(load);
    await h.controller.refresh();
    const ready = h.latest();
    if (ready.status !== 'ready') throw new Error('Expected ready');
    const refresh = h.controller.refresh();
    expect(ready.signal.aborted).toBe(true);
    expect(h.latest()).toEqual({ status: 'loading' });
    await refresh;
    expect(h.latest()).toMatchObject({ status: 'error', retryable: true });
    expect(JSON.stringify(h.latest())).not.toContain('private server detail');
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s when transport disregards cancellation', async (outcome) => {
    const old = deferred<ArchiveTrackResponse>();
    const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(feature('pending'));
    const h = harness(load);
    const first = h.controller.refresh();
    await h.controller.refresh();
    const count = h.snapshots.length;
    if (outcome === 'resolve') old.resolve(feature());
    else old.reject(new Error('late'));
    await first;
    expect(h.snapshots).toHaveLength(count);
    expect(h.latest()).toMatchObject({ feature: feature('pending') });
  });

  it('session end cancels an in-flight read and prevents future reads', async () => {
    const pending = deferred<ArchiveTrackResponse>();
    const load = vi.fn().mockReturnValue(pending.promise);
    const h = harness(load);
    const result = h.controller.refresh();
    h.session.abort();
    pending.resolve(feature());
    await result;
    await h.controller.refresh();
    expect(load).toHaveBeenCalledOnce();
    expect(h.snapshots).toEqual([{ status: 'loading' }]);
  });

  it('closing a ready screen ends its displayed map lifetime', async () => {
    const h = harness(() => Promise.resolve(feature()));
    await h.controller.refresh();
    const ready = h.latest();
    if (ready.status !== 'ready') throw new Error('Expected ready');
    h.controller.dispose();
    h.controller.dispose();
    expect(ready.signal.aborted).toBe(true);
  });

  it('never starts under an ended session and rejects a mismatched run', async () => {
    const load = vi.fn().mockResolvedValue(feature());
    const session = new AbortController(); session.abort();
    await new RunDetailController({ load, onChange: vi.fn(), scope, signal: session.signal }).refresh();
    expect(load).not.toHaveBeenCalled();
    const wrong = feature(); wrong.properties.runId = scope.orgId;
    const h = harness(() => Promise.resolve(wrong));
    await h.controller.refresh();
    expect(h.latest().status).toBe('error');
  });

  it.each([
    [401, 'AUTH_REQUIRED', 'Sign in again'],
    [403, 'ORG_ACCESS_DENIED', 'no longer available'],
    [404, 'RUN_NOT_FOUND', 'no longer available'],
    [410, 'RUN_DELETED', 'was deleted'],
    [422, 'ARCHIVE_TRACK_TOO_COMPLEX', 'too large'],
  ])('clears a refused %i read', async (status, code, message) => {
    const h = harness(() => Promise.reject(new RunnerApiError('sensitive text', Number(status), String(code), null)));
    await h.controller.refresh();
    expect(h.latest()).toMatchObject({ status: 'error', retryable: false, message: expect.stringContaining(String(message)) as string });
    expect(JSON.stringify(h.latest())).not.toContain('sensitive text');
  });
});

describe('archive-track browser adapter', () => {
  it('validates the complete feature and requests only published same-origin geometry without caching', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(feature())));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadArchiveTrack(scope, new AbortController().signal)).resolves.toEqual(feature());
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${scope.orgId}/runs/${scope.runId}/track?mode=archive`, {
      credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('rejects a different run and an inconsistent summary', async () => {
    const wrong = feature(); wrong.properties.runId = scope.orgId;
    const inconsistent = feature(); inconsistent.properties.sourceRevision = '1';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(wrong)))
      .mockResolvedValueOnce(new Response(JSON.stringify(inconsistent)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadArchiveTrack(scope, new AbortController().signal)).rejects.toThrow('different run');
    await expect(loadArchiveTrack(scope, new AbortController().signal)).rejects.toThrow();
  });
});
