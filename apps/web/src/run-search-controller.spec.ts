import type { RunSearchItem, RunSearchResponse } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import { RunnerApiError } from './runner-api.js';
import {
  RunSearchController,
  type RunSearchLoader,
  type RunSearchSnapshot,
} from './run-search-controller.js';
import type { RunSearchFilters } from './run-search.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const filters: RunSearchFilters = {
  maxDistance: null,
  minDistance: '5',
  period: { kind: 'preset', preset: 'this-month' },
  sort: 'newest',
  timeZone: 'Europe/Warsaw',
  unit: 'km',
};

const runUuid = (n: number) => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number): RunSearchItem => ({
  distanceM: 5_000 + n,
  gpsQuality: 'good',
  observedDurationS: 1_800,
  runId: runUuid(n),
  startedAt: '2026-10-05T06:00:00.000Z',
});
const page = (items: RunSearchItem[], nextCursor: string | null = null, pendingSummaryCount = 0): RunSearchResponse => ({
  applied: {
    from: '2026-09-30T22:00:00.000Z',
    fromDate: '2026-10-01',
    maxDistanceM: null,
    minDistanceM: 5_000,
    sort: 'newest',
    timeZone: 'Europe/Warsaw',
    to: '2026-10-31T23:00:00.000Z',
    toDate: '2026-10-31',
  },
  items,
  nextCursor,
  pendingSummaryCount,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function harness(loader: RunSearchLoader, scope: { filters?: RunSearchFilters; orgId?: string } = {}) {
  const snapshots: RunSearchSnapshot[] = [];
  const controller = new RunSearchController({
    filters: scope.filters ?? filters,
    load: loader,
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: scope.orgId ?? orgId,
  });
  const latest = () => snapshots.at(-1)!;
  return { controller, latest, snapshots };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('RunSearchController', () => {
  it('starts loading, asks for the first page of the applied filters and shows it', async () => {
    const first = deferred<RunSearchResponse>();
    const loader = vi.fn<RunSearchLoader>(() => first.promise);
    const { controller, latest } = harness(loader);

    controller.start();
    expect(latest().status).toBe('loading');
    expect(latest().items).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![0]).toEqual({
      orgId,
      params: { distanceUnit: 'km', minDistance: '5', preset: 'this-month', sort: 'newest', timeZone: 'Europe/Warsaw' },
    });

    first.resolve(page([item(2), item(1)], 'c1', 3));
    await flush();

    expect(latest()).toMatchObject({
      hasMore: true,
      pendingSummaryCount: 3,
      status: 'ready',
    });
    expect(latest().items.map((entry) => entry.runId)).toEqual([runUuid(2), runUuid(1)]);
    expect(latest().resolved).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-31' });
  });

  it('shows an empty result as ready with no items, and keeps the pending count', async () => {
    const loader = vi.fn<RunSearchLoader>(() => Promise.resolve(page([], null, 2)));
    const { controller, latest } = harness(loader);
    controller.start();
    await flush();
    expect(latest()).toMatchObject({ hasMore: false, items: [], pendingSummaryCount: 2, status: 'ready' });
  });

  it('shows an error with a retry that asks for the first page again', async () => {
    const loader = vi
      .fn<RunSearchLoader>()
      .mockRejectedValueOnce(new RunnerApiError('The database is busy', 503, 'SERVICE_UNAVAILABLE', 'req-1'))
      .mockResolvedValueOnce(page([item(1)]));
    const { controller, latest } = harness(loader);

    controller.start();
    await flush();
    expect(latest().status).toBe('error');
    expect(latest().message).toContain('The database is busy');
    expect(latest().items).toEqual([]);

    controller.retry();
    expect(latest().status).toBe('loading');
    await flush();
    expect(latest()).toMatchObject({ message: null, status: 'ready' });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1]![0].params).not.toHaveProperty('cursor');
  });

  it.each([401, 403])('treats HTTP %i as lost access, clears everything and does not retry by itself', async (status) => {
    const loader = vi
      .fn<RunSearchLoader>()
      .mockResolvedValueOnce(page([item(1)], 'c1'))
      .mockRejectedValueOnce(new RunnerApiError('No access', status, 'ORG_ACCESS_DENIED', null));
    const { controller, latest } = harness(loader);
    controller.start();
    await flush();
    controller.loadMore();
    await flush();
    expect(latest()).toMatchObject({ hasMore: false, items: [], pendingSummaryCount: 0, status: 'access-denied' });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  describe('the next page', () => {
    it('sends the cursor of the page it follows and appends', async () => {
      const second = deferred<RunSearchResponse>();
      const loader = vi
        .fn<RunSearchLoader>()
        .mockResolvedValueOnce(page([item(3), item(2)], 'c1', 1))
        .mockReturnValueOnce(second.promise);
      const { controller, latest } = harness(loader);
      controller.start();
      await flush();

      controller.loadMore();
      expect(latest()).toMatchObject({ loadingMore: true, status: 'ready' });
      expect(latest().items).toHaveLength(2);
      expect(loader.mock.calls[1]![0].params.cursor).toBe('c1');

      second.resolve(page([item(1)], null, 0));
      await flush();
      expect(latest()).toMatchObject({ hasMore: false, loadingMore: false, pendingSummaryCount: 0 });
      expect(latest().items.map((entry) => entry.runId)).toEqual([runUuid(3), runUuid(2), runUuid(1)]);
    });

    it('ignores a request while one is running, before the first page, and when there is no more', async () => {
      const first = deferred<RunSearchResponse>();
      const second = deferred<RunSearchResponse>();
      const loader = vi
        .fn<RunSearchLoader>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const { controller } = harness(loader);
      controller.start();
      controller.loadMore();
      expect(loader).toHaveBeenCalledTimes(1);

      first.resolve(page([item(1)], 'c1'));
      await flush();
      controller.loadMore();
      controller.loadMore();
      expect(loader).toHaveBeenCalledTimes(2);

      second.resolve(page([item(2)], null));
      await flush();
      controller.loadMore();
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('keeps what is shown when the next page fails and retries the same page', async () => {
      const loader = vi
        .fn<RunSearchLoader>()
        .mockResolvedValueOnce(page([item(2)], 'c1'))
        .mockRejectedValueOnce(new RunnerApiError('Busy', 503, 'SERVICE_UNAVAILABLE', null))
        .mockResolvedValueOnce(page([item(1)]));
      const { controller, latest } = harness(loader);
      controller.start();
      await flush();
      controller.loadMore();
      await flush();
      expect(latest()).toMatchObject({ hasMore: true, loadingMore: false, status: 'ready' });
      expect(latest().moreMessage).toContain('Busy');
      expect(latest().items).toHaveLength(1);

      controller.retry();
      expect(loader.mock.calls[2]![0].params.cursor).toBe('c1');
      await flush();
      expect(latest().moreMessage).toBeNull();
      expect(latest().items).toHaveLength(2);
    });

    it('asks to start over when the server no longer accepts the cursor, and then does so from page one', async () => {
      const loader = vi
        .fn<RunSearchLoader>()
        .mockResolvedValueOnce(page([item(2)], 'c1'))
        .mockRejectedValueOnce(new RunnerApiError('The run search cursor is invalid', 400, 'INVALID_CURSOR', null))
        .mockResolvedValueOnce(page([item(5), item(4)], null));
      const { controller, latest } = harness(loader);
      controller.start();
      await flush();
      controller.loadMore();
      await flush();
      expect(latest().outdated).toBe(true);
      expect(latest().moreMessage).toMatch(/out of date/iu);

      controller.retry();
      expect(latest().items).toEqual([]);
      expect(latest().status).toBe('loading');
      expect(loader.mock.calls[2]![0].params).not.toHaveProperty('cursor');
      await flush();
      expect(latest()).toMatchObject({ outdated: false, status: 'ready' });
      expect(latest().items).toHaveLength(2);
    });

    it('drops a run the server repeats on a later page', async () => {
      const loader = vi
        .fn<RunSearchLoader>()
        .mockResolvedValueOnce(page([item(3), item(2)], 'c1'))
        .mockResolvedValueOnce(page([item(2), item(1)]));
      const { controller, latest } = harness(loader);
      controller.start();
      await flush();
      controller.loadMore();
      await flush();
      expect(latest().items.map((entry) => entry.runId)).toEqual([runUuid(3), runUuid(2), runUuid(1)]);
    });
  });

  describe('when the search is replaced', () => {
    it('aborts the request in flight and ignores its late answer', async () => {
      const late = deferred<RunSearchResponse>();
      let signal: AbortSignal | undefined;
      const loader = vi.fn<RunSearchLoader>((_input, abortSignal) => {
        signal = abortSignal;
        return late.promise;
      });
      const { controller, snapshots } = harness(loader);
      controller.start();
      const before = snapshots.length;

      controller.dispose();
      expect(signal?.aborted).toBe(true);

      late.resolve(page([item(1)], 'c1'));
      await flush();
      expect(snapshots).toHaveLength(before);
    });

    it('never lets an old search’s page appear in a new search’s results', async () => {
      const oldFirst = deferred<RunSearchResponse>();
      const newFirst = deferred<RunSearchResponse>();
      const states: Array<{ ids: string[]; scope: string }> = [];
      const onChange = (scope: string) => (snapshot: RunSearchSnapshot) =>
        states.push({ ids: snapshot.items.map((entry) => entry.runId), scope });

      const oldController = new RunSearchController({
        filters,
        load: () => oldFirst.promise,
        onChange: onChange('old'),
        orgId,
      });
      const newController = new RunSearchController({
        filters: { ...filters, sort: 'longest' },
        load: () => newFirst.promise,
        onChange: onChange('new'),
        orgId,
      });
      oldController.start();
      oldController.dispose();
      newController.start();

      newFirst.resolve(page([item(9)]));
      oldFirst.resolve(page([item(1)]));
      await flush();

      expect(states.filter((state) => state.scope === 'old').every((state) => state.ids.length === 0)).toBe(true);
      expect(states.at(-1)).toEqual({ ids: [runUuid(9)], scope: 'new' });
    });

    it('ignores calls after it was disposed', async () => {
      const loader = vi.fn<RunSearchLoader>(() => Promise.resolve(page([item(1)], 'c1')));
      const { controller } = harness(loader);
      controller.start();
      await flush();
      controller.dispose();
      controller.loadMore();
      controller.retry();
      controller.refresh();
      expect(loader).toHaveBeenCalledTimes(1);
    });
  });

  describe('refresh after the list is known to be out of date', () => {
    it('is needed because retry does nothing for a search that succeeded', async () => {
      const loader = vi.fn<RunSearchLoader>(() => Promise.resolve(page([item(1)], 'c1')));
      const { controller } = harness(loader);
      controller.start();
      await flush();
      controller.retry();
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('starts over from page one with the same filters, no cursor and nothing of the old list shown', async () => {
      const loader = vi
        .fn<RunSearchLoader>()
        .mockResolvedValueOnce(page([item(3), item(2)], 'c1'))
        .mockResolvedValueOnce(page([item(1)], 'c2'))
        .mockResolvedValueOnce(page([item(3)], null));
      const { controller, latest } = harness(loader);
      controller.start();
      await flush();
      controller.loadMore();
      await flush();
      expect(latest().items).toHaveLength(3);

      controller.refresh();
      expect(latest()).toMatchObject({ hasMore: false, items: [], loadingMore: false, status: 'loading' });
      expect(loader).toHaveBeenCalledTimes(3);
      expect(loader.mock.calls[2]![0]).toEqual(loader.mock.calls[0]![0]);
      expect(loader.mock.calls[2]![0].params).not.toHaveProperty('cursor');

      await flush();
      expect(latest()).toMatchObject({ hasMore: false, status: 'ready' });
      expect(latest().items.map((entry) => entry.runId)).toEqual([runUuid(3)]);
      // The old cursor is gone with the old pages.
      controller.loadMore();
      expect(loader).toHaveBeenCalledTimes(3);
    });

    it('drops a first page that was already on its way, so it cannot bring back a deleted run', async () => {
      const stale = deferred<RunSearchResponse>();
      const fresh = deferred<RunSearchResponse>();
      const signals: AbortSignal[] = [];
      const loader = vi
        .fn<RunSearchLoader>()
        .mockImplementationOnce((_input, signal) => {
          signals.push(signal);
          return stale.promise;
        })
        .mockImplementationOnce((_input, signal) => {
          signals.push(signal);
          return fresh.promise;
        });
      const { controller, latest, snapshots } = harness(loader);
      controller.start();

      controller.refresh();
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);

      fresh.resolve(page([item(2)]));
      await flush();
      const settled = snapshots.length;
      // The stale answer still lists the deleted run 1; it arrives last and changes nothing.
      stale.resolve(page([item(2), item(1)]));
      await flush();
      expect(snapshots).toHaveLength(settled);
      expect(latest().items.map((entry) => entry.runId)).toEqual([runUuid(2)]);
    });

    it('drops a next page that was on its way', async () => {
      const staleMore = deferred<RunSearchResponse>();
      const loader = vi
        .fn<RunSearchLoader>()
        .mockResolvedValueOnce(page([item(3)], 'c1'))
        .mockReturnValueOnce(staleMore.promise)
        .mockResolvedValueOnce(page([item(3), item(2)]));
      const { controller, latest } = harness(loader);
      controller.start();
      await flush();
      controller.loadMore();
      controller.refresh();
      await flush();
      staleMore.resolve(page([item(1)]));
      await flush();
      expect(latest()).toMatchObject({ loadingMore: false, status: 'ready' });
      expect(latest().items.map((entry) => entry.runId)).toEqual([runUuid(3), runUuid(2)]);
    });

    it('does nothing before the search started', () => {
      const loader = vi.fn<RunSearchLoader>(() => Promise.resolve(page([])));
      const { controller } = harness(loader);
      controller.refresh();
      expect(loader).not.toHaveBeenCalled();
    });
  });
});
