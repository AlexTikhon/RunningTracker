import {
  ACTIVITY_HISTORY_VERSION,
  type ActivityHistoryDay,
  type ActivityHistoryItem,
  type ActivityHistoryResponse,
} from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  ActivityHistoryController,
  historyFilterKey,
  historyItemKey,
  noHistoryFilters,
  type ActivityHistoryFilters,
  type ActivityHistoryLoader,
  type ActivityHistorySnapshot,
} from './activity-history-controller.js';
import { RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id = (n: number) => `ad000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const manual = (n: number): ActivityHistoryItem => ({
  activityId: id(n),
  distanceM: null,
  enteredDurationS: 600,
  notes: null,
  rpe: null,
  source: 'manual',
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'run',
});
const recorded = (n: number): ActivityHistoryItem => ({
  captureSource: null,
  finishedAt: '2026-10-05T07:00:00.000Z',
  runId: id(n),
  source: 'recorded_run',
  startedAt: '2026-10-05T06:00:00.000Z',
  summary: { state: 'pending' },
  type: 'run',
});
const page = (
  items: ActivityHistoryItem[],
  nextCursor: string | null = null,
  applied: { day?: ActivityHistoryDay | null; source: ActivityHistoryFilters['source']; type: ActivityHistoryFilters['type'] } = { day: null, source: null, type: null },
): ActivityHistoryResponse => ({
  applied: { day: applied.day ?? null, source: applied.source, type: applied.type },
  items,
  nextCursor,
  provenance: { historyVersion: ACTIVITY_HISTORY_VERSION, persisted: false, snapshot: 'single_read_only_transaction' },
});
const apiError = (status: number, code: string, message = 'Refused') =>
  new RunnerApiError(message, status, code, '22222222-2222-4222-8222-222222222222');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const warsawDay = { localDate: '2026-03-29', timeZone: 'Europe/Warsaw' };
const warsawApplied: ActivityHistoryDay = { ...warsawDay, endsAt: '2026-03-29T22:00:00.000Z', startsAt: '2026-03-28T23:00:00.000Z' };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(load: ActivityHistoryLoader, filters: ActivityHistoryFilters = noHistoryFilters, signal?: AbortSignal) {
  const snapshots: ActivityHistorySnapshot[] = [];
  const controller = new ActivityHistoryController({ filters, load, onChange: (s) => snapshots.push(s), orgId, ...(signal ? { signal } : {}) });
  return { controller, last: () => snapshots.at(-1)!, snapshots };
}

describe('history keys', () => {
  it('tells an activity and a run with the same id apart, and every filter pair apart', () => {
    expect(historyItemKey(manual(1))).not.toBe(historyItemKey(recorded(1)));
    expect(new Set([
      historyFilterKey(noHistoryFilters),
      historyFilterKey({ day: null, source: 'manual', type: null }),
      historyFilterKey({ day: null, source: null, type: 'run' }),
      historyFilterKey({ day: null, source: 'manual', type: 'run' }),
      historyFilterKey({ day: warsawDay, source: null, type: null }),
      historyFilterKey({ day: { ...warsawDay, localDate: '2026-03-30' }, source: null, type: null }),
      historyFilterKey({ day: { ...warsawDay, timeZone: 'Europe/Berlin' }, source: null, type: null }),
      historyFilterKey({ day: warsawDay, source: 'manual', type: null }),
    ]).size).toBe(8);
  });
});

describe('ActivityHistoryController', () => {
  it('loads the first page with its filters and no cursor', async () => {
    const filters = { day: null, source: 'recorded_run' as const, type: 'run' as const };
    const load = vi.fn<ActivityHistoryLoader>().mockResolvedValue(page([recorded(1)], 'c1', filters));
    const { controller, last, snapshots } = harness(load, filters);
    controller.start();
    expect(snapshots[0]).toMatchObject({ filters, items: [], status: 'loading' });
    await flush();
    expect(load).toHaveBeenCalledWith({ cursor: null, day: null, orgId, source: 'recorded_run', type: 'run' }, expect.any(AbortSignal));
    expect(last()).toMatchObject({ filters, hasMore: true, status: 'ready' });
  });

  it('pages with the server’s cursor, one request at a time, keeping an activity and a run that share an id', async () => {
    const second = deferred<ActivityHistoryResponse>();
    const load = vi
      .fn<ActivityHistoryLoader>()
      .mockResolvedValueOnce(page([recorded(1), manual(1)], 'c1'))
      .mockReturnValueOnce(second.promise);
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    controller.loadMore();
    controller.loadMore();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]![0]).toEqual({ cursor: 'c1', day: null, orgId, source: null, type: null });
    expect(last().loadingMore).toBe(true);
    second.resolve(page([manual(1), manual(2)]));
    await flush();
    expect(last().items.map(historyItemKey)).toEqual([`run:${id(1)}`, `activity:${id(1)}`, `activity:${id(2)}`]);
    expect(last()).toMatchObject({ hasMore: false, loadingMore: false });
    // The last page carried no cursor: there is nothing more to ask for.
    controller.loadMore();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops an answer that arrives after disposal (a filter, organization or session change) and aborts its request', async () => {
    const pending = deferred<ActivityHistoryResponse>();
    let aborted: AbortSignal | undefined;
    const load = vi.fn<ActivityHistoryLoader>().mockImplementation((_input, signal) => {
      aborted = signal;
      return pending.promise;
    });
    const { controller, snapshots } = harness(load);
    controller.start();
    controller.dispose();
    expect(aborted?.aborted).toBe(true);
    pending.resolve(page([manual(1)]));
    await flush();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.status).toBe('loading');
    controller.refresh();
    controller.loadMore();
    controller.retry();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is disposed when its session ends', async () => {
    const session = new AbortController();
    const pending = deferred<ActivityHistoryResponse>();
    let aborted: AbortSignal | undefined;
    const load = vi.fn<ActivityHistoryLoader>().mockImplementation((_input, signal) => {
      aborted = signal;
      return pending.promise;
    });
    const { controller, snapshots } = harness(load, noHistoryFilters, session.signal);
    controller.start();
    session.abort();
    expect(aborted?.aborted).toBe(true);
    pending.resolve(page([manual(1)]));
    await flush();
    expect(snapshots.every((snapshot) => snapshot.status === 'loading')).toBe(true);
    controller.refresh();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not start at all for a session that has already ended', () => {
    const session = new AbortController();
    session.abort();
    const load = vi.fn<ActivityHistoryLoader>();
    const { controller, snapshots } = harness(load, noHistoryFilters, session.signal);
    controller.start();
    expect(load).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(0);
  });

  it('lets a refresh replace a page that is still on its way, so the older answer is never shown', async () => {
    const first = deferred<ActivityHistoryResponse>();
    const second = deferred<ActivityHistoryResponse>();
    const load = vi.fn<ActivityHistoryLoader>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { controller, last } = harness(load);
    controller.start();
    controller.refresh();
    second.resolve(page([manual(2)]));
    await flush();
    first.resolve(page([manual(1)]));
    await flush();
    expect(last().items.map(historyItemKey)).toEqual([`activity:${id(2)}`]);
  });

  it('refuses an answer for other filters', async () => {
    const load = vi.fn<ActivityHistoryLoader>().mockResolvedValue(page([manual(1)], null, { source: 'gpx', type: null }));
    const { controller, last } = harness(load, { day: null, source: 'manual', type: null });
    controller.start();
    await flush();
    expect(last()).toMatchObject({ items: [], status: 'error' });
  });

  it('loads a day with its zone, pages within it and keeps the server’s interval', async () => {
    const filters = { day: warsawDay, source: 'recorded_run' as const, type: null };
    const load = vi
      .fn<ActivityHistoryLoader>()
      .mockResolvedValueOnce(page([recorded(1)], 'c1', { day: warsawApplied, source: 'recorded_run', type: null }))
      .mockResolvedValueOnce(page([recorded(2)], null, { day: warsawApplied, source: 'recorded_run', type: null }));
    const { controller, last } = harness(load, filters);
    controller.start();
    await flush();
    expect(load.mock.calls[0]![0]).toEqual({ cursor: null, day: warsawDay, orgId, source: 'recorded_run', type: null });
    expect(last()).toMatchObject({ appliedDay: warsawApplied, hasMore: true, status: 'ready' });
    controller.loadMore();
    await flush();
    expect(load.mock.calls[1]![0]).toEqual({ cursor: 'c1', day: warsawDay, orgId, source: 'recorded_run', type: null });
    expect(last().items.map(historyItemKey)).toEqual([`run:${id(1)}`, `run:${id(2)}`]);
  });

  it('refuses an answer for another date, another zone, no day, or a day it did not ask for', async () => {
    for (const [requested, applied] of [
      [warsawDay, { ...warsawApplied, localDate: '2026-03-30' }],
      [warsawDay, { ...warsawApplied, timeZone: 'Europe/Berlin' }],
      [warsawDay, null],
      [null, warsawApplied],
    ] as const) {
      const load = vi.fn<ActivityHistoryLoader>().mockResolvedValue(page([manual(1)], 'c', { day: applied, source: null, type: null }));
      const { controller, last } = harness(load, { day: requested, source: null, type: null });
      controller.start();
      await flush();
      expect(last(), JSON.stringify({ applied, requested })).toMatchObject({ appliedDay: null, items: [], status: 'error' });
    }
  });

  it('never shows the previous day’s late answer once the day changed (the old controller is disposed)', async () => {
    const previous = deferred<ActivityHistoryResponse>();
    let previousSignal: AbortSignal | undefined;
    const oldLoad = vi.fn<ActivityHistoryLoader>().mockImplementation((_input, signal) => {
      previousSignal = signal;
      return previous.promise;
    });
    const old = harness(oldLoad, { day: warsawDay, source: null, type: null });
    old.controller.start();
    // The screen changes the day: it disposes the old controller and starts one for the new day.
    old.controller.dispose();
    const nextDay = { ...warsawDay, localDate: '2026-03-30' };
    const fresh = harness(
      vi.fn<ActivityHistoryLoader>().mockResolvedValue(
        page([manual(2)], null, { day: { ...warsawApplied, endsAt: '2026-03-30T22:00:00.000Z', localDate: '2026-03-30', startsAt: '2026-03-29T22:00:00.000Z' }, source: null, type: null }),
      ),
      { day: nextDay, source: null, type: null },
    );
    fresh.controller.start();
    expect(previousSignal?.aborted).toBe(true);
    previous.resolve(page([manual(1)], null, { day: warsawApplied, source: null, type: null }));
    await flush();
    expect(old.snapshots.every((snapshot) => snapshot.items.length === 0)).toBe(true);
    expect(fresh.last().items.map(historyItemKey)).toEqual([`activity:${id(2)}`]);
  });

  it('reports lost access, a failed first page with the server’s message, and retries from page one', async () => {
    const load = vi
      .fn<ActivityHistoryLoader>()
      .mockRejectedValueOnce(apiError(403, 'ORG_ACCESS_DENIED'))
      .mockRejectedValueOnce(apiError(500, 'INTERNAL', 'Broken.'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(page([manual(1)]));
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    expect(last()).toMatchObject({ message: 'You no longer have access to your activity history in this organization.', status: 'access-denied' });
    controller.retry();
    await flush();
    expect(last()).toMatchObject({ message: 'Broken. Reference 22222222-2222-4222-8222-222222222222.', status: 'error' });
    controller.retry();
    await flush();
    expect(last()).toMatchObject({ message: 'Your activity history could not be loaded. Check your connection and try again.', status: 'error' });
    controller.retry();
    await flush();
    expect(last()).toMatchObject({ status: 'ready' });
    expect(load.mock.calls.every(([input]) => input.cursor === null)).toBe(true);
  });

  it('clears the pages already shown and says access was lost on 401 or 403 while paging', async () => {
    for (const error of [apiError(401, 'AUTH_REQUIRED'), apiError(403, 'ORG_ACCESS_DENIED')]) {
      const load = vi
        .fn<ActivityHistoryLoader>()
        .mockResolvedValueOnce(page([manual(1)], 'c1'))
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(page([manual(2)]));
      const { controller, last } = harness(load);
      controller.start();
      await flush();
      controller.loadMore();
      await flush();
      expect(last(), error.code).toMatchObject({
        hasMore: false,
        items: [],
        loadingMore: false,
        message: 'You no longer have access to your activity history in this organization.',
        moreMessage: null,
        status: 'access-denied',
      });
      // Retrying after lost access starts over from page one, never with the old cursor.
      controller.retry();
      expect(load.mock.calls[2]![0].cursor).toBeNull();
      await flush();
      expect(last()).toMatchObject({ message: null, status: 'ready' });
      expect(last().items.map(historyItemKey)).toEqual([`activity:${id(2)}`]);
    }
  });

  it('keeps shown pages when the next page fails, and marks the list outdated when the cursor is refused', async () => {
    const load = vi
      .fn<ActivityHistoryLoader>()
      .mockResolvedValueOnce(page([manual(1)], 'c1'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(apiError(400, 'INVALID_CURSOR'))
      .mockResolvedValueOnce(page([manual(5)]));
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    controller.loadMore();
    await flush();
    expect(last()).toMatchObject({ moreMessage: 'More of your history could not be loaded. Check your connection and try again.', status: 'ready' });
    expect(last().items).toHaveLength(1);
    controller.retry();
    await flush();
    expect(load.mock.calls[2]![0].cursor).toBe('c1');
    expect(last()).toMatchObject({ moreMessage: 'This history is out of date. Refresh to see your current activities.', outdated: true });
    controller.loadMore();
    expect(load).toHaveBeenCalledTimes(3);
    controller.retry();
    await flush();
    expect(load.mock.calls[3]![0].cursor).toBeNull();
    expect(last().items.map(historyItemKey)).toEqual([`activity:${id(5)}`]);
  });
});
