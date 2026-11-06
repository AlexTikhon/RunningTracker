import type { DailyMetricsListResponse, DailyMetricsView } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  CheckInDayController,
  CheckInHistoryController,
  type CheckInDaySnapshot,
  type CheckInHistorySnapshot,
  type DailyMetricsLoader,
  type DailyMetricsReader,
  type DailyMetricsRemover,
  type DailyMetricsWriter,
} from './daily-checkin-controller.js';
import type { CheckInValues } from './daily-checkin.js';
import { RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const view = (localDate: string, overrides: Partial<DailyMetricsView> = {}): DailyMetricsView => ({
  createdAt: '2026-10-05T08:00:00.000Z',
  localDate,
  mood: 4,
  note: null,
  sleepMinutes: null,
  sleepQuality: null,
  soreness: null,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-10-05T08:00:00.000Z',
  weightKg: null,
  ...overrides,
});
const values: CheckInValues = { mood: 3, note: null, sleepMinutes: 420, sleepQuality: null, soreness: null, weightKg: 71.5 };
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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('CheckInHistoryController', () => {
  function harness(load: DailyMetricsLoader, signal?: AbortSignal) {
    const snapshots: CheckInHistorySnapshot[] = [];
    const controller = new CheckInHistoryController({
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
      orgId,
      today: '2026-11-06',
      ...(signal ? { signal } : {}),
    });
    return { controller, last: () => snapshots.at(-1)!, snapshots };
  }

  it('loads the 14 days ending today and shows every day, the empty ones included', async () => {
    const load = vi.fn<DailyMetricsLoader>().mockResolvedValue({ items: [view('2026-11-05'), view('2026-10-24')] });
    const { controller, last } = harness(load);
    controller.start();
    expect(last().status).toBe('loading');
    await flush();
    expect(load).toHaveBeenCalledWith({ from: '2026-10-24', orgId, to: '2026-11-06' }, expect.any(AbortSignal));
    expect(last().status).toBe('ready');
    expect(last().days).toHaveLength(14);
    expect(last().days.filter((day) => day.metrics !== null).map((day) => day.localDate)).toEqual(['2026-11-05', '2026-10-24']);
  });

  it('keeps the shown days while a refresh loads, and drops the answer of the request it replaced', async () => {
    const first = deferred<DailyMetricsListResponse>();
    const second = deferred<DailyMetricsListResponse>();
    const load = vi.fn<DailyMetricsLoader>()
      .mockResolvedValueOnce({ items: [] })
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    controller.refresh();
    expect(last().status).toBe('ready');
    controller.refresh();
    second.resolve({ items: [view('2026-11-06')] });
    await flush();
    first.resolve({ items: [] });
    await flush();
    expect(last().days[0]?.metrics?.localDate).toBe('2026-11-06');
  });

  it('reports lost access and failures, and retries', async () => {
    const load = vi.fn<DailyMetricsLoader>()
      .mockRejectedValueOnce(apiError(403, 'ORG_ACCESS_DENIED'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ items: [] });
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    expect(last()).toMatchObject({ message: 'You no longer have access to your check-ins in this organization.', status: 'access-denied' });
    controller.retry();
    await flush();
    expect(last()).toMatchObject({ message: expect.stringContaining('could not be loaded') as string, status: 'error' });
    controller.retry();
    await flush();
    expect(last().status).toBe('ready');
  });

  it('goes silent when its session ends', async () => {
    const pending = deferred<DailyMetricsListResponse>();
    const session = new AbortController();
    const { controller, snapshots } = harness(() => pending.promise, session.signal);
    controller.start();
    const before = snapshots.length;
    session.abort();
    pending.resolve({ items: [view('2026-11-06')] });
    await flush();
    expect(snapshots).toHaveLength(before);
  });
});

describe('CheckInDayController', () => {
  function harness(
    read: DailyMetricsReader,
    write: DailyMetricsWriter = vi.fn<DailyMetricsWriter>(),
    signal?: AbortSignal,
    remove: DailyMetricsRemover = vi.fn<DailyMetricsRemover>(),
  ) {
    const snapshots: CheckInDaySnapshot[] = [];
    const deleted: string[] = [];
    const loaded: Array<[string, DailyMetricsView | null]> = [];
    const saved: Array<[DailyMetricsView, boolean]> = [];
    const controller = new CheckInDayController({
      csrf: () => csrf,
      date: '2026-11-06',
      onChange: (snapshot) => snapshots.push(snapshot),
      onDeleted: (date) => deleted.push(date),
      onLoaded: (date, existing) => loaded.push([date, existing]),
      onSaved: (stored, created) => saved.push([stored, created]),
      orgId,
      read,
      remove,
      timeZone: 'Europe/Warsaw',
      write,
      ...(signal ? { signal } : {}),
    });
    return { controller, deleted, last: () => snapshots.at(-1)!, loaded, saved, snapshots };
  }

  it('loads the stored values of today and hands them to the form', async () => {
    const stored = view('2026-11-06', { weightKg: 72.4 });
    const read = vi.fn<DailyMetricsReader>().mockResolvedValue(stored);
    const { controller, last, loaded } = harness(read);
    controller.start();
    expect(last()).toMatchObject({ date: '2026-11-06', load: 'loading' });
    await flush();
    expect(read).toHaveBeenCalledWith({ localDate: '2026-11-06', orgId }, expect.any(AbortSignal));
    expect(last()).toMatchObject({ existing: stored, load: 'ready' });
    expect(loaded).toEqual([['2026-11-06', stored]]);
  });

  it('shows an earlier date as empty when nothing is recorded, and drops a late answer for the date it left', async () => {
    const today = deferred<DailyMetricsView | null>();
    const read = vi.fn<DailyMetricsReader>().mockReturnValueOnce(today.promise).mockResolvedValueOnce(null);
    const { controller, last, loaded } = harness(read);
    controller.start();
    expect(controller.select('2026-11-01')).toBe(true);
    await flush();
    today.resolve(view('2026-11-06'));
    await flush();
    expect(last()).toMatchObject({ date: '2026-11-01', existing: null, load: 'ready' });
    expect(loaded).toEqual([['2026-11-01', null]]);
  });

  it('saves the whole day with the current zone, reports a first save and a replacement, and tells the history', async () => {
    const write = vi.fn<DailyMetricsWriter>()
      .mockResolvedValueOnce({ created: true, view: view('2026-11-06', { mood: 3 }) })
      .mockResolvedValueOnce({ created: false, view: view('2026-11-06', { mood: 2 }) });
    const { controller, last, saved } = harness(vi.fn<DailyMetricsReader>().mockResolvedValue(null), write);
    controller.start();
    await flush();
    controller.save(values);
    expect(last().save).toBe('pending');
    await flush();
    expect(write).toHaveBeenCalledWith(
      { localDate: '2026-11-06', orgId },
      { ...values, timeZone: 'Europe/Warsaw' },
      csrf,
      expect.any(AbortSignal),
    );
    expect(last()).toMatchObject({ existing: { mood: 3 }, save: 'saved', saveMessage: 'Check-in saved.' });
    controller.save({ ...values, mood: 2 });
    await flush();
    expect(last()).toMatchObject({ save: 'saved', saveMessage: 'Check-in updated.' });
    expect(saved.map(([, created]) => created)).toEqual([true, false]);
  });

  it('does not save before the day is loaded, and refuses another date while a save is pending', async () => {
    const pendingSave = deferred<{ created: boolean; view: DailyMetricsView }>();
    const write = vi.fn<DailyMetricsWriter>().mockReturnValue(pendingSave.promise);
    const read = vi.fn<DailyMetricsReader>().mockResolvedValue(null);
    const { controller, last } = harness(read, write);
    controller.start();
    controller.save(values);
    expect(write).not.toHaveBeenCalled();
    await flush();
    controller.save(values);
    controller.save(values);
    expect(write).toHaveBeenCalledTimes(1);
    expect(controller.select('2026-11-01')).toBe(false);
    pendingSave.resolve({ created: true, view: view('2026-11-06') });
    await flush();
    expect(last()).toMatchObject({ date: '2026-11-06', save: 'saved' });
    expect(controller.select('2026-11-01')).toBe(true);
  });

  it('says a refused save was not saved, and an unknown outcome is safe to save again', async () => {
    const write = vi.fn<DailyMetricsWriter>()
      .mockRejectedValueOnce(apiError(400, 'INVALID_REQUEST', 'The date cannot be after today (2026-11-06 in Europe/Warsaw)'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(apiError(503, 'SERVICE_UNAVAILABLE', 'Busy'))
      .mockRejectedValueOnce(apiError(401, 'AUTH_REQUIRED'));
    const { controller, last } = harness(vi.fn<DailyMetricsReader>().mockResolvedValue(null), write);
    controller.start();
    await flush();
    controller.save(values);
    await flush();
    expect(last()).toMatchObject({ save: 'failed', uncertain: false });
    expect(last().saveMessage).toMatch(/^The check-in was not saved: The date cannot be after today/u);
    controller.save(values);
    await flush();
    expect(last()).toMatchObject({ save: 'failed', uncertain: true });
    expect(last().saveMessage).toContain('Saving again is safe: the day is replaced, never duplicated.');
    controller.save(values);
    await flush();
    expect(last().saveMessage).toContain('Busy.');
    controller.save(values);
    await flush();
    expect(last().saveMessage).toBe('The check-in was not saved: sign in again, then save.');
  });

  it('reports a day that cannot be loaded and retries it', async () => {
    const read = vi.fn<DailyMetricsReader>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(view('2026-11-06'));
    const { controller, last } = harness(read);
    controller.start();
    await flush();
    expect(last()).toMatchObject({ load: 'error', loadMessage: 'This day could not be loaded. Check your connection and try again.' });
    controller.retry();
    await flush();
    expect(last()).toMatchObject({ load: 'ready' });
  });

  it('deletes the shown day once it is loaded, then shows it empty and tells the screen', async () => {
    const remove = vi.fn<DailyMetricsRemover>().mockResolvedValue(undefined);
    const write = vi.fn<DailyMetricsWriter>().mockResolvedValue({ created: true, view: view('2026-11-06') });
    const { controller, deleted, last } = harness(vi.fn<DailyMetricsReader>().mockResolvedValue(view('2026-11-06')), write, undefined, remove);
    controller.start();
    controller.deleteDay();
    expect(remove).not.toHaveBeenCalled();
    await flush();

    controller.deleteDay();
    expect(last()).toMatchObject({ deletion: 'pending', deletionMessage: null });
    await flush();
    expect(remove).toHaveBeenCalledWith({ localDate: '2026-11-06', orgId }, csrf, expect.any(AbortSignal));
    expect(last()).toMatchObject({ deletion: 'idle', deletionMessage: 'Check-in deleted.', existing: null, load: 'ready' });
    expect(deleted).toEqual(['2026-11-06']);

    // Nothing is stored any more, so there is nothing to delete; a new save clears the deletion notice.
    controller.deleteDay();
    expect(remove).toHaveBeenCalledTimes(1);
    controller.save(values);
    expect(last()).toMatchObject({ deletion: 'idle', deletionMessage: null, save: 'pending' });
  });

  it('offers no deletion for a day without a record', async () => {
    const remove = vi.fn<DailyMetricsRemover>();
    const { controller } = harness(vi.fn<DailyMetricsReader>().mockResolvedValue(null), undefined, undefined, remove);
    controller.start();
    await flush();
    controller.deleteDay();
    expect(remove).not.toHaveBeenCalled();
  });

  it('runs one mutation at a time: no save, other date or second deletion while deleting, and no deletion while saving', async () => {
    const pendingDelete = deferred<undefined>();
    const pendingSave = deferred<{ created: boolean; view: DailyMetricsView }>();
    const remove = vi.fn<DailyMetricsRemover>().mockReturnValue(pendingDelete.promise);
    const write = vi.fn<DailyMetricsWriter>().mockReturnValue(pendingSave.promise);
    const read = vi.fn<DailyMetricsReader>().mockResolvedValue(view('2026-11-06'));
    const { controller, last } = harness(read, write, undefined, remove);
    controller.start();
    await flush();

    controller.deleteDay();
    controller.deleteDay();
    controller.save(values);
    expect(controller.select('2026-11-01')).toBe(false);
    controller.retry();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    pendingDelete.resolve(undefined);
    await flush();
    expect(last()).toMatchObject({ date: '2026-11-06', existing: null });

    controller.save(values);
    controller.deleteDay();
    expect(remove).toHaveBeenCalledTimes(1);
    pendingSave.resolve({ created: true, view: view('2026-11-06') });
    await flush();
    controller.deleteDay();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('says a refused deletion did not happen, an unknown outcome is safe to repeat, and keeps the stored values shown', async () => {
    const stored = view('2026-11-06', { weightKg: 70 });
    const remove = vi.fn<DailyMetricsRemover>()
      .mockRejectedValueOnce(apiError(403, 'CSRF_DENIED'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(apiError(503, 'SERVICE_UNAVAILABLE', 'Busy'))
      .mockRejectedValueOnce(apiError(401, 'AUTH_REQUIRED'))
      .mockResolvedValueOnce(undefined);
    const { controller, deleted, last } = harness(vi.fn<DailyMetricsReader>().mockResolvedValue(stored), undefined, undefined, remove);
    controller.start();
    await flush();

    controller.deleteDay();
    await flush();
    expect(last()).toMatchObject({
      deletion: 'failed',
      deletionMessage: 'The check-in was not deleted: you no longer have access to this organization.',
      existing: stored,
    });
    controller.deleteDay();
    await flush();
    expect(last()).toMatchObject({
      deletion: 'failed',
      deletionMessage: 'The deletion was not confirmed: the connection failed. Deleting again is safe.',
      existing: stored,
    });
    controller.deleteDay();
    await flush();
    expect(last().deletionMessage).toBe('The deletion was not confirmed: Busy. Reference 22222222-2222-4222-8222-222222222222. Deleting again is safe.');
    controller.deleteDay();
    await flush();
    expect(last().deletionMessage).toBe('The check-in was not deleted: sign in again, then delete it.');
    expect(deleted).toEqual([]);

    controller.deleteDay();
    await flush();
    expect(last()).toMatchObject({ deletion: 'idle', deletionMessage: 'Check-in deleted.', existing: null });
    expect(deleted).toEqual(['2026-11-06']);
  });

  it('goes silent when its session ends during a deletion', async () => {
    const pendingDelete = deferred<undefined>();
    const session = new AbortController();
    const { controller, deleted, snapshots } = harness(
      vi.fn<DailyMetricsReader>().mockResolvedValue(view('2026-11-06')),
      undefined,
      session.signal,
      vi.fn<DailyMetricsRemover>().mockReturnValue(pendingDelete.promise),
    );
    controller.start();
    await flush();
    controller.deleteDay();
    const before = snapshots.length;
    session.abort();
    pendingDelete.resolve(undefined);
    await flush();
    expect(snapshots).toHaveLength(before);
    expect(deleted).toEqual([]);
  });

  it('goes silent when its session ends, also for a pending save', async () => {
    const pendingSave = deferred<{ created: boolean; view: DailyMetricsView }>();
    const session = new AbortController();
    const { controller, saved, snapshots } = harness(
      vi.fn<DailyMetricsReader>().mockResolvedValue(null),
      vi.fn<DailyMetricsWriter>().mockReturnValue(pendingSave.promise),
      session.signal,
    );
    controller.start();
    await flush();
    controller.save(values);
    const before = snapshots.length;
    session.abort();
    pendingSave.resolve({ created: true, view: view('2026-11-06') });
    await flush();
    expect(snapshots).toHaveLength(before);
    expect(saved).toEqual([]);
  });
});
