import type { RunSearchItem, RunSearchResponse } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  RunDeletionController,
  type RunDeleter,
  type RunDeletionSnapshot,
} from './run-deletion.js';
import { RunSearchController, type RunSearchLoader, type RunSearchSnapshot } from './run-search-controller.js';
import type { RunSearchFilters } from './run-search.js';
import { RunnerApiError, type CsrfCredentials } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const csrf = (token: string): CsrfCredentials => ({ headerName: 'x-csrf-token', token });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

function harness(deleteRun: RunDeleter, token: () => string = () => 't'.repeat(43)) {
  const snapshots: RunDeletionSnapshot[] = [];
  const events: string[] = [];
  const onDeleted = vi.fn(() => events.push('deleted callback'));
  const controller = new RunDeletionController({
    csrf: () => csrf(token()),
    deleteRun,
    onChange: (snapshot) => {
      snapshots.push(snapshot);
      events.push(`snapshot ${snapshot.phase}`);
    },
    onDeleted,
    orgId,
    runId,
  });
  return { controller, events, latest: () => snapshots.at(-1), onDeleted, snapshots };
}

describe('RunDeletionController', () => {
  it('starts confirming and sends nothing until confirmed; disposing then sends nothing either', async () => {
    const deleteRun = vi.fn<RunDeleter>(() => Promise.resolve());
    const { controller, snapshots } = harness(deleteRun);
    expect(controller.snapshot).toEqual({ message: null, phase: 'confirming' });
    controller.dispose();
    controller.confirm();
    await flush();
    expect(deleteRun).not.toHaveBeenCalled();
    expect(snapshots).toEqual([]);
  });

  it('sends one DELETE for its run with the token current at that moment, then reports deleted and calls back once', async () => {
    const sent = deferred<undefined>();
    const deleteRun = vi.fn<RunDeleter>(() => sent.promise);
    let token = 'old'.padEnd(43, 'x');
    const { controller, events, latest, onDeleted } = harness(deleteRun, () => token);
    token = 'new'.padEnd(43, 'x');

    controller.confirm();
    expect(latest()).toEqual({ message: null, phase: 'pending' });
    expect(deleteRun).toHaveBeenCalledTimes(1);
    expect(deleteRun.mock.calls[0]?.[0]).toEqual({ orgId, runId });
    expect(deleteRun.mock.calls[0]?.[1]).toEqual(csrf(token));
    expect(onDeleted).not.toHaveBeenCalled();

    sent.resolve(undefined);
    await flush();
    expect(latest()).toEqual({ message: null, phase: 'deleted' });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['snapshot pending', 'snapshot deleted', 'deleted callback']);
  });

  it('ignores more confirmations while one is pending and after the run was deleted', async () => {
    const sent = deferred<undefined>();
    const deleteRun = vi.fn<RunDeleter>(() => sent.promise);
    const { controller, onDeleted } = harness(deleteRun);
    controller.confirm();
    controller.confirm();
    controller.confirm();
    expect(deleteRun).toHaveBeenCalledTimes(1);
    sent.resolve(undefined);
    await flush();
    controller.confirm();
    await flush();
    expect(deleteRun).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  describe('a failed attempt', () => {
    it.each([
      ['a lost connection', new TypeError('Failed to fetch')],
      ['an abort it did not ask for', new DOMException('The operation was aborted', 'AbortError')],
      ['the request deadline', new DOMException('Request deadline exceeded', 'TimeoutError')],
      ['a server error', new RunnerApiError('Internal error', 500, 'INTERNAL_ERROR', 'req-5')],
    ])('after %s is not shown as deleted and says the outcome is unknown', async (_name, error) => {
      const { controller, latest, onDeleted } = harness(() => Promise.reject(error));
      controller.confirm();
      await flush();
      expect(latest()?.phase).toBe('failed');
      expect(latest()?.message).toMatch(/^The deletion was not confirmed: /u);
      expect(latest()?.message).toMatch(/may already be deleted\. Trying again is safe\.$/u);
      expect(latest()?.message).not.toMatch(/was deleted/u);
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('names the deadline and keeps the server reference', async () => {
      const timeout = harness(() => Promise.reject(new DOMException('x', 'TimeoutError')));
      timeout.controller.confirm();
      await flush();
      expect(timeout.latest()?.message).toContain('The server did not answer in time.');

      const server = harness(() => Promise.reject(new RunnerApiError('Busy.', 503, 'SERVICE_UNAVAILABLE', 'req-9')));
      server.controller.confirm();
      await flush();
      expect(server.latest()?.message).toContain('Busy. Reference req-9.');
    });

    it.each([
      [401, 'AUTH_REQUIRED'],
      [403, 'CSRF_INVALID'],
      [429, 'RATE_LIMITED'],
    ])('after a %i refusal says the run was not deleted', async (status, code) => {
      const { controller, latest, onDeleted } = harness(() =>
        Promise.reject(new RunnerApiError('Refused', status, code, null)));
      controller.confirm();
      await flush();
      expect(latest()).toEqual({ message: 'The run was not deleted: Refused.', phase: 'failed' });
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('can be sent again for the same run ID, and the repeat can succeed', async () => {
      const deleteRun = vi
        .fn<RunDeleter>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(undefined);
      const { controller, latest, onDeleted } = harness(deleteRun);
      controller.confirm();
      await flush();
      expect(latest()?.phase).toBe('failed');

      controller.confirm();
      expect(latest()).toEqual({ message: null, phase: 'pending' });
      await flush();
      expect(deleteRun).toHaveBeenCalledTimes(2);
      expect(deleteRun.mock.calls[1]?.[0]).toEqual(deleteRun.mock.calls[0]?.[0]);
      expect(latest()?.phase).toBe('deleted');
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });

  describe('a run the server will not delete for this person', () => {
    it('treats 404 as unavailable without saying whose run it is, and offers no repeat', async () => {
      const deleteRun = vi.fn<RunDeleter>(() =>
        Promise.reject(new RunnerApiError('Run not found', 404, 'RUN_NOT_FOUND', 'req-1')));
      const { controller, latest, onDeleted } = harness(deleteRun);
      controller.confirm();
      await flush();
      expect(latest()).toEqual({
        message: 'This run is not available to you, so it cannot be deleted. Search again to refresh the list.',
        phase: 'unavailable',
      });
      expect(latest()?.message).not.toMatch(/owner|someone|another|exist/iu);
      controller.confirm();
      await flush();
      expect(deleteRun).toHaveBeenCalledTimes(1);
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('treats a lost membership as unavailable', async () => {
      const { controller, latest } = harness(() =>
        Promise.reject(new RunnerApiError('No access', 403, 'ORG_ACCESS_DENIED', null)));
      controller.confirm();
      await flush();
      expect(latest()?.phase).toBe('unavailable');
      expect(latest()?.message).toMatch(/no longer have access to this organization/u);
    });
  });

  describe('when its scope ends', () => {
    it('aborts the pending DELETE and ignores its late success', async () => {
      const sent = deferred<undefined>();
      let signal: AbortSignal | undefined;
      const { controller, onDeleted, snapshots } = harness((_scope, _csrf, abortSignal) => {
        signal = abortSignal;
        return sent.promise;
      });
      controller.confirm();
      const before = snapshots.length;
      controller.dispose();
      expect(signal?.aborted).toBe(true);
      sent.resolve(undefined);
      await flush();
      expect(snapshots).toHaveLength(before);
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('ignores a late failure, so nothing reaches a replacement screen', async () => {
      const sent = deferred<undefined>();
      const { controller, snapshots } = harness(() => sent.promise);
      controller.confirm();
      const before = snapshots.length;
      controller.dispose();
      sent.reject(new TypeError('Failed to fetch'));
      await flush();
      expect(snapshots).toHaveLength(before);
    });

    it('a new controller for the same run starts confirming and is not reached by the old one’s answer', async () => {
      const old = deferred<undefined>();
      const replacement = deferred<undefined>();
      const deleteRun = vi
        .fn<RunDeleter>()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(replacement.promise);
      const first = harness(deleteRun);
      first.controller.confirm();
      first.controller.dispose();
      const second = harness(deleteRun);
      expect(second.controller.snapshot.phase).toBe('confirming');
      second.controller.confirm();
      old.resolve(undefined);
      await flush();
      expect(second.latest()?.phase).toBe('pending');
      expect(first.onDeleted).not.toHaveBeenCalled();
      expect(second.onDeleted).not.toHaveBeenCalled();
      replacement.resolve(undefined);
      await flush();
      expect(second.onDeleted).toHaveBeenCalledTimes(1);
    });
  });
});

// The order My runs follows after a confirmed deletion (RunSearchPanel): the refresh is asked for only after the
// server confirmed, and any search answer from before it is dropped, so the deleted card cannot come back.
describe('refreshing My runs after a deletion', () => {
  const filters: RunSearchFilters = {
    maxDistance: null,
    minDistance: null,
    period: { kind: 'preset', preset: 'this-month' },
    sort: 'newest',
    timeZone: 'Europe/Warsaw',
    unit: 'km',
  };
  const otherRun = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const item = (id: string): RunSearchItem => ({
    distanceM: 5_000,
    gpsQuality: 'good',
    observedDurationS: 1_800,
    runId: id,
    startedAt: '2026-10-05T06:00:00.000Z',
  });
  const page = (ids: string[], nextCursor: string | null = null): RunSearchResponse => ({
    applied: {
      from: '2026-09-30T22:00:00.000Z',
      fromDate: '2026-10-01',
      maxDistanceM: null,
      minDistanceM: null,
      sort: 'newest',
      timeZone: 'Europe/Warsaw',
      to: '2026-10-31T23:00:00.000Z',
      toDate: '2026-10-31',
    },
    items: ids.map(item),
    nextCursor,
    pendingSummaryCount: 0,
  });

  function myRuns(load: RunSearchLoader, deleteRun: RunDeleter) {
    const log: string[] = [];
    const shown: RunSearchSnapshot[] = [];
    const search = new RunSearchController({ filters, load, onChange: (snapshot) => shown.push(snapshot), orgId });
    const refreshArchive = vi.fn(() => log.push('archive refresh'));
    const deletion = new RunDeletionController({
      csrf: () => csrf('t'.repeat(43)),
      deleteRun: (scope, credentials, signal) => {
        log.push('DELETE');
        return deleteRun(scope, credentials, signal);
      },
      onChange: () => undefined,
      onDeleted: () => {
        log.push('search refresh');
        search.refresh();
        refreshArchive();
      },
      orgId,
      runId,
    });
    return { deletion, ids: () => shown.at(-1)?.items.map((entry) => entry.runId), log, refreshArchive, search };
  }

  it('asks for page one again only after the server confirmed, and the archive after that', async () => {
    const sent = deferred<undefined>();
    const load = vi
      .fn<RunSearchLoader>()
      .mockResolvedValueOnce(page([runId, otherRun], 'cursor-1'))
      .mockResolvedValueOnce(page([otherRun]));
    const { deletion, ids, log, refreshArchive, search } = myRuns(load, () => sent.promise);
    search.start();
    await flush();
    expect(ids()).toEqual([runId, otherRun]);

    deletion.confirm();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(refreshArchive).not.toHaveBeenCalled();

    sent.resolve(undefined);
    await flush();
    expect(log).toEqual(['DELETE', 'search refresh', 'archive refresh']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toEqual(load.mock.calls[0]?.[0]);
    expect(load.mock.calls[1]?.[0].params).not.toHaveProperty('cursor');
    expect(ids()).toEqual([otherRun]);
    expect(refreshArchive).toHaveBeenCalledTimes(1);
  });

  it('drops a search answer sent before the deletion was confirmed, even when it arrives last', async () => {
    const sent = deferred<undefined>();
    const stale = deferred<RunSearchResponse>();
    const load = vi
      .fn<RunSearchLoader>()
      .mockResolvedValueOnce(page([runId, otherRun], 'cursor-1'))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(page([otherRun]));
    const { deletion, ids, search } = myRuns(load, () => sent.promise);
    search.start();
    await flush();
    deletion.confirm();
    // A Load more was sent while the DELETE was on its way.
    search.loadMore();
    sent.resolve(undefined);
    await flush();
    stale.resolve(page([runId]));
    await flush();
    expect(ids()).toEqual([otherRun]);
  });

  it('refreshes nothing after a failed or abandoned deletion', async () => {
    const load = vi.fn<RunSearchLoader>(() => Promise.resolve(page([runId])));
    const failed = myRuns(load, () => Promise.reject(new TypeError('Failed to fetch')));
    failed.search.start();
    await flush();
    failed.deletion.confirm();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(failed.refreshArchive).not.toHaveBeenCalled();

    const late = deferred<undefined>();
    const abandoned = myRuns(load, () => late.promise);
    abandoned.search.start();
    await flush();
    abandoned.deletion.confirm();
    abandoned.deletion.dispose();
    late.resolve(undefined);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(abandoned.refreshArchive).not.toHaveBeenCalled();
  });
});
