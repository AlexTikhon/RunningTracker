import type { DailyMovementListResponse, DailyMovementView } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  MovementDayController,
  MovementHistoryController,
  type DailyMovementLoader,
  type DailyMovementReader,
  type DailyMovementRemover,
  type DailyMovementWriter,
  type MovementDaySnapshot,
  type MovementHistorySnapshot,
} from './daily-movement-controller.js';
import type { MovementValues } from './daily-movement.js';
import { RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const view = (localDate: string, overrides: Partial<DailyMovementView> = {}): DailyMovementView => ({
  activeEnergyKcal: null,
  createdAt: '2026-11-05T08:00:00.000Z',
  localDate,
  source: 'manual',
  steps: 5_000,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-11-05T08:00:00.000Z',
  ...overrides,
});
const values: MovementValues = { activeEnergyKcal: 0, steps: 0 };
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

describe('MovementHistoryController', () => {
  function harness(load: DailyMovementLoader, signal?: AbortSignal) {
    const snapshots: MovementHistorySnapshot[] = [];
    const controller = new MovementHistoryController({
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
      orgId,
      today: '2026-11-06',
      ...(signal ? { signal } : {}),
    });
    return { controller, last: () => snapshots.at(-1)!, snapshots };
  }

  it('loads the 14 days ending today and shows every day, the empty ones included', async () => {
    const load = vi.fn<DailyMovementLoader>().mockResolvedValue({ items: [view('2026-11-05'), view('2026-10-24', { steps: 0 })] });
    const { controller, last } = harness(load);
    controller.start();
    expect(last().status).toBe('loading');
    await flush();
    expect(load).toHaveBeenCalledWith({ from: '2026-10-24', orgId, to: '2026-11-06' }, expect.any(AbortSignal));
    expect(last().status).toBe('ready');
    expect(last().days).toHaveLength(14);
    expect(last().days.filter((day) => day.movement !== null).map((day) => day.localDate)).toEqual(['2026-11-05', '2026-10-24']);
  });

  it('keeps the shown days while a refresh loads, aborts the request it replaces and drops its late answer', async () => {
    const first = deferred<DailyMovementListResponse>();
    const second = deferred<DailyMovementListResponse>();
    const signals: AbortSignal[] = [];
    const load = vi.fn<DailyMovementLoader>((_input, signal) => {
      signals.push(signal);
      return signals.length === 1 ? Promise.resolve({ items: [] }) : signals.length === 2 ? first.promise : second.promise;
    });
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    controller.refresh();
    expect(last().status).toBe('ready');
    controller.refresh();
    expect(signals[1]?.aborted).toBe(true);
    second.resolve({ items: [view('2026-11-06')] });
    await flush();
    first.resolve({ items: [] });
    await flush();
    expect(last().days[0]?.movement?.localDate).toBe('2026-11-06');
  });

  it('reports lost access and failures, and retries', async () => {
    const load = vi.fn<DailyMovementLoader>()
      .mockRejectedValueOnce(apiError(401, 'AUTH_REQUIRED'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ items: [] });
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    expect(last()).toMatchObject({ message: 'You no longer have access to your movement in this organization.', status: 'access-denied' });
    controller.retry();
    await flush();
    expect(last()).toMatchObject({ message: expect.stringContaining('could not be loaded') as string, status: 'error' });
    controller.retry();
    await flush();
    expect(last().status).toBe('ready');
  });

  it('goes silent and aborts when its session ends, and after it is disposed', async () => {
    const pending = deferred<DailyMovementListResponse>();
    const session = new AbortController();
    let seen: AbortSignal | null = null;
    const { controller, snapshots } = harness((_input, signal) => {
      seen = signal;
      return pending.promise;
    }, session.signal);
    controller.start();
    const before = snapshots.length;
    session.abort();
    expect(seen!.aborted).toBe(true);
    pending.resolve({ items: [view('2026-11-06')] });
    await flush();
    expect(snapshots).toHaveLength(before);
    controller.refresh();
    controller.retry();
    expect(snapshots).toHaveLength(before);
  });
});

describe('MovementDayController', () => {
  interface Harness {
    controller: MovementDayController;
    deleted: string[];
    last: () => MovementDaySnapshot;
    loaded: Array<[string, DailyMovementView | null]>;
    saved: Array<[DailyMovementView, boolean]>;
    snapshots: MovementDaySnapshot[];
  }

  function harness(
    options: { read?: DailyMovementReader; remove?: DailyMovementRemover; signal?: AbortSignal; write?: DailyMovementWriter } = {},
  ): Harness {
    const snapshots: MovementDaySnapshot[] = [];
    const loaded: Array<[string, DailyMovementView | null]> = [];
    const saved: Array<[DailyMovementView, boolean]> = [];
    const deleted: string[] = [];
    const controller = new MovementDayController({
      csrf: () => csrf,
      date: '2026-11-06',
      onChange: (snapshot) => snapshots.push(snapshot),
      onDeleted: (date) => deleted.push(date),
      onLoaded: (date, existing) => loaded.push([date, existing]),
      onSaved: (saved_, created) => saved.push([saved_, created]),
      orgId,
      read: options.read ?? (() => Promise.resolve(null)),
      remove: options.remove ?? (() => Promise.resolve()),
      ...(options.signal ? { signal: options.signal } : {}),
      timeZone: 'Europe/Warsaw',
      write: options.write ?? ((target) => Promise.resolve({ created: true, view: view(target.localDate) })),
    });
    return { controller, deleted, last: () => snapshots.at(-1)!, loaded, saved, snapshots };
  }

  it('loads the selected day; a day without a record is ready and empty', async () => {
    const read = vi.fn<DailyMovementReader>().mockResolvedValue(null);
    const { controller, last, loaded } = harness({ read });
    controller.start();
    expect(last()).toMatchObject({ date: '2026-11-06', existing: null, load: 'loading' });
    await flush();
    expect(read).toHaveBeenCalledWith({ localDate: '2026-11-06', orgId }, expect.any(AbortSignal));
    expect(last()).toMatchObject({ existing: null, load: 'ready' });
    expect(loaded).toEqual([['2026-11-06', null]]);
  });

  it("never lets an earlier date's late answer replace the selected day's data", async () => {
    const answers = new Map<string, ReturnType<typeof deferred<DailyMovementView | null>>>();
    const signals = new Map<string, AbortSignal>();
    const read: DailyMovementReader = (target, signal) => {
      const answer = deferred<DailyMovementView | null>();
      answers.set(target.localDate, answer);
      signals.set(target.localDate, signal);
      return answer.promise;
    };
    const { controller, last, loaded } = harness({ read });
    controller.start();
    expect(controller.select('2026-11-04')).toBe(true);
    // The previous date is cleared at once and its request aborted.
    expect(last()).toMatchObject({ date: '2026-11-04', existing: null, load: 'loading' });
    expect(signals.get('2026-11-06')?.aborted).toBe(true);
    expect(controller.select('2026-11-05')).toBe(true);
    answers.get('2026-11-05')!.resolve(view('2026-11-05', { steps: 5 }));
    await flush();
    answers.get('2026-11-06')!.resolve(view('2026-11-06', { steps: 6 }));
    answers.get('2026-11-04')!.resolve(view('2026-11-04', { steps: 4 }));
    await flush();
    expect(last()).toMatchObject({ date: '2026-11-05', existing: { localDate: '2026-11-05', steps: 5 }, load: 'ready' });
    expect(loaded).toEqual([['2026-11-05', view('2026-11-05', { steps: 5 })]]);
  });

  it("drops an earlier date's late failure too", async () => {
    const first = deferred<DailyMovementView | null>();
    const read = vi.fn<DailyMovementReader>().mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    const { controller, last } = harness({ read });
    controller.start();
    controller.select('2026-11-05');
    await flush();
    first.reject(new TypeError('offline'));
    await flush();
    expect(last()).toMatchObject({ date: '2026-11-05', load: 'ready', loadMessage: null });
  });

  it('saves the whole day with the zone, reports created and updated, and only for a loaded day', async () => {
    const write = vi.fn<DailyMovementWriter>()
      .mockResolvedValueOnce({ created: true, view: view('2026-11-06', { activeEnergyKcal: 0, steps: 0 }) })
      .mockResolvedValueOnce({ created: false, view: view('2026-11-06', { steps: 10 }) });
    const { controller, last, saved } = harness({ write });
    controller.save(values);
    expect(write).not.toHaveBeenCalled();
    controller.start();
    await flush();
    controller.save(values);
    expect(last().save).toBe('pending');
    await flush();
    expect(write).toHaveBeenCalledWith(
      { localDate: '2026-11-06', orgId },
      { activeEnergyKcal: 0, steps: 0, timeZone: 'Europe/Warsaw' },
      csrf,
      expect.any(AbortSignal),
    );
    expect(last()).toMatchObject({ existing: { steps: 0 }, save: 'saved', saveMessage: 'Movement saved.' });
    controller.save({ activeEnergyKcal: null, steps: 10 });
    await flush();
    expect(last().saveMessage).toBe('Movement updated.');
    expect(saved.map(([, created]) => created)).toEqual([true, false]);
  });

  it('allows one mutation at a time: while a save is pending, another date, another save and a deletion are refused', async () => {
    const pending = deferred<{ created: boolean; view: DailyMovementView }>();
    const write = vi.fn<DailyMovementWriter>().mockReturnValue(pending.promise);
    const remove = vi.fn<DailyMovementRemover>();
    const read = vi.fn<DailyMovementReader>().mockResolvedValue(view('2026-11-06'));
    const { controller, last } = harness({ read, remove, write });
    controller.start();
    await flush();
    controller.save(values);
    expect(controller.select('2026-11-05')).toBe(false);
    controller.save(values);
    controller.deleteDay();
    expect(write).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve({ created: false, view: view('2026-11-06', { steps: 0 }) });
    await flush();
    expect(last()).toMatchObject({ date: '2026-11-06', save: 'saved' });
    expect(controller.select('2026-11-05')).toBe(true);
  });

  it('says an unknown save outcome is safe to repeat, and a definitive refusal is not saved', async () => {
    const write = vi.fn<DailyMovementWriter>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(apiError(503, 'DATABASE_UNAVAILABLE', 'Try later'))
      .mockRejectedValueOnce(apiError(400, 'INVALID_REQUEST', 'The date cannot be after today (2026-11-06 in Europe/Warsaw)'))
      .mockRejectedValueOnce(apiError(403, 'ORG_ACCESS_DENIED'))
      .mockRejectedValueOnce(apiError(401, 'AUTH_REQUIRED'));
    const { controller, last } = harness({ write });
    controller.start();
    await flush();
    controller.save(values);
    await flush();
    expect(last()).toMatchObject({ save: 'failed', uncertain: true });
    expect(last().saveMessage).toBe(
      'The save was not confirmed: the connection failed. Saving again is safe: the day is replaced, never duplicated.',
    );
    controller.save(values);
    await flush();
    expect(last().saveMessage).toContain('Try later. Reference 22222222-2222-4222-8222-222222222222. Saving again is safe');
    controller.save(values);
    await flush();
    expect(last().saveMessage).toBe(
      'The movement was not saved: The date cannot be after today (2026-11-06 in Europe/Warsaw). Reference 22222222-2222-4222-8222-222222222222.',
    );
    controller.save(values);
    await flush();
    expect(last().saveMessage).toBe('The movement was not saved: you no longer have access to this organization.');
    controller.save(values);
    await flush();
    expect(last().saveMessage).toBe('The movement was not saved: sign in again, then save.');
  });

  it('deletes only a stored day, empties it after a confirmed deletion, and keeps the values after a failure', async () => {
    const remove = vi.fn<DailyMovementRemover>().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(undefined);
    const read = vi.fn<DailyMovementReader>().mockResolvedValueOnce(null).mockResolvedValueOnce(view('2026-11-05'));
    const { controller, deleted, last } = harness({ read, remove });
    controller.start();
    await flush();
    controller.deleteDay();
    expect(remove).not.toHaveBeenCalled();
    controller.select('2026-11-05');
    await flush();
    controller.deleteDay();
    expect(last().deletion).toBe('pending');
    await flush();
    expect(last()).toMatchObject({
      deletion: 'failed',
      deletionMessage: 'The deletion was not confirmed: the connection failed. Deleting again is safe.',
      existing: { localDate: '2026-11-05' },
    });
    controller.deleteDay();
    await flush();
    expect(remove).toHaveBeenLastCalledWith({ localDate: '2026-11-05', orgId }, csrf, expect.any(AbortSignal));
    expect(last()).toMatchObject({ deletion: 'idle', deletionMessage: 'Movement deleted.', existing: null });
    expect(deleted).toEqual(['2026-11-05']);
  });

  it('goes silent when its session ends: no late load, save or deletion answer reaches the screen', async () => {
    const session = new AbortController();
    const reading = deferred<DailyMovementView | null>();
    const { controller, loaded, snapshots } = harness({ read: () => reading.promise, signal: session.signal });
    controller.start();
    const before = snapshots.length;
    session.abort();
    reading.resolve(view('2026-11-06'));
    await flush();
    expect(snapshots).toHaveLength(before);
    expect(loaded).toEqual([]);
    expect(controller.select('2026-11-05')).toBe(false);

    const writing = deferred<{ created: boolean; view: DailyMovementView }>();
    const second = harness({ write: () => writing.promise });
    second.controller.start();
    await flush();
    second.controller.save(values);
    const count = second.snapshots.length;
    second.controller.dispose();
    writing.resolve({ created: true, view: view('2026-11-06') });
    await flush();
    expect(second.snapshots).toHaveLength(count);
    expect(second.saved).toEqual([]);
  });

  it('is already disposed when created with an ended session', () => {
    const session = new AbortController();
    session.abort();
    const read = vi.fn<DailyMovementReader>();
    const { controller, snapshots } = harness({ read, signal: session.signal });
    controller.start();
    expect(read).not.toHaveBeenCalled();
    expect(snapshots).toEqual([]);
  });
});
