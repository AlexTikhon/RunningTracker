import type { CreateMealRequest, MealListResponse, MealView } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  MealCreateController,
  MealDeletionController,
  MealEditController,
  MealListController,
  type MealListSnapshot,
  type MealSaveSnapshot,
} from './meal-log-controller.js';
import type { MealDetails } from './meal-log.js';
import { RunnerApiError } from './runner-api.js';

const orgId = 'org';
const csrf = { headerName: 'x-csrf-token' as const, token: 't' };
const details: MealDetails = { carbohydrateG: null, energyKcal: 410.5, fatG: 0, mealType: 'lunch', proteinG: null, title: 'Soup' };

function entry(mealId: string, localDate = '2026-11-05', title = mealId): MealView {
  return {
    carbohydrateG: null,
    createdAt: '2026-11-05T08:00:00.000Z',
    energyKcal: null,
    fatG: null,
    localDate,
    mealId: `${mealId.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`,
    mealType: 'snack',
    proteinG: null,
    source: 'manual',
    timeZone: 'Europe/Warsaw',
    title,
    updatedAt: '2026-11-05T08:00:00.000Z',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// Outcomes are created lazily, when the call happens, so no rejected promise exists before a handler is attached.
const failWith = (error: unknown) => () => Promise.reject(error instanceof Error ? error : new Error(String(error)));
const succeedWith = <Value>(value: Value) => () => Promise.resolve(value);
const apiError = (status: number, code: string, details: Record<string, unknown> | null = null) => new RunnerApiError('No', status, code, null, null, details);

describe('MealListController', () => {
  it('shows a date, drops a late answer for a date no longer selected, and clears the previous date at once', async () => {
    const answers = new Map<string, ReturnType<typeof deferred<MealListResponse>>>();
    const load = vi.fn((input: { localDate: string }) => {
      const answer = deferred<MealListResponse>();
      answers.set(input.localDate, answer);
      return answer.promise;
    });
    const snapshots: MealListSnapshot[] = [];
    const controller = new MealListController({ load, localDate: '2026-11-05', onChange: (snapshot) => snapshots.push(snapshot), orgId });
    controller.start();
    controller.select('2026-11-04');
    expect(snapshots.at(-1)).toMatchObject({ items: [], localDate: '2026-11-04', status: 'loading' });
    answers.get('2026-11-05')!.resolve({ items: [entry('old')], nextCursor: null });
    await flush();
    expect(snapshots.at(-1)).toMatchObject({ localDate: '2026-11-04', status: 'loading' });
    answers.get('2026-11-04')!.resolve({ items: [entry('new', '2026-11-04')], nextCursor: null });
    await flush();
    expect(snapshots.at(-1)).toMatchObject({ items: [entry('new', '2026-11-04')], localDate: '2026-11-04', status: 'ready' });
    // The abandoned request was aborted.
    expect((load.mock.calls[0] as unknown as [unknown, AbortSignal])[1].aborted).toBe(true);
  });

  it('pages with the cursor, without duplicates, and reports an outdated cursor', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [entry('a'), entry('b')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [entry('b'), entry('c')], nextCursor: 'c2' })
      .mockRejectedValueOnce(apiError(400, 'INVALID_CURSOR'));
    let last: MealListSnapshot | null = null;
    const controller = new MealListController({ load, localDate: '2026-11-05', onChange: (snapshot) => (last = snapshot), orgId });
    controller.start();
    await flush();
    controller.loadMore();
    controller.loadMore(); // ignored: one request at a time
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]![0]).toEqual({ cursor: 'c1', localDate: '2026-11-05', orgId });
    expect(last!.items.map((item) => item.title)).toEqual(['a', 'b', 'c']);
    expect(last!.hasMore).toBe(true);
    controller.loadMore();
    await flush();
    expect(last).toMatchObject({ outdated: true, status: 'ready' });
    expect(last!.items).toHaveLength(3);
  });

  it('keeps the entries shown while page one reloads after a save, and retries a failed load', async () => {
    const reload = deferred<MealListResponse>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [entry('a')], nextCursor: null })
      .mockReturnValueOnce(reload.promise)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    let last: MealListSnapshot | null = null;
    const controller = new MealListController({ load, localDate: '2026-11-05', onChange: (snapshot) => (last = snapshot), orgId });
    controller.start();
    await flush();
    controller.refresh();
    expect(last).toMatchObject({ items: [entry('a')], status: 'ready' });
    reload.resolve({ items: [entry('a'), entry('b')], nextCursor: null });
    await flush();
    expect(last!.items).toHaveLength(2);
    controller.select('2026-11-04');
    await flush();
    expect(last).toMatchObject({ items: [], message: 'Your meal log could not be loaded. Check your connection and try again.', status: 'error' });
    controller.retry();
    await flush();
    expect(last).toMatchObject({ items: [], localDate: '2026-11-04', status: 'ready' });
  });

  it('reports lost access, and stops for good when its session ends', async () => {
    const session = new AbortController();
    const pending = deferred<MealListResponse>();
    const load = vi.fn().mockRejectedValueOnce(apiError(403, 'ORG_ACCESS_DENIED')).mockReturnValueOnce(pending.promise);
    let last: MealListSnapshot | null = null;
    const controller = new MealListController({ load, localDate: '2026-11-05', onChange: (snapshot) => (last = snapshot), orgId, signal: session.signal });
    controller.start();
    await flush();
    expect(last).toMatchObject({ message: 'You no longer have access to your meal log in this organization.', status: 'access-denied' });
    controller.retry();
    const before = last;
    session.abort();
    pending.resolve({ items: [entry('late')], nextCursor: null });
    await flush();
    expect(last).toBe(before);
  });
});

describe('MealCreateController', () => {
  function setup(create: (orgId: string, request: CreateMealRequest) => Promise<{ created: boolean; view: MealView }>) {
    let counter = 0;
    const snapshots: MealSaveSnapshot[] = [];
    const onSaved = vi.fn();
    const onAlreadySaved = vi.fn();
    const createMock = vi.fn(create);
    const controller = new MealCreateController({
      create: createMock,
      csrf: () => csrf,
      newKey: () => `key-${++counter}`,
      onAlreadySaved,
      onChange: (snapshot) => snapshots.push(snapshot),
      onSaved,
      orgId,
      timeZone: 'Europe/Warsaw',
    });
    return { controller, createMock, onAlreadySaved, onSaved, snapshots };
  }

  it('sends the date, zone, details and the form session key; refuses a second submission while one is on its way', async () => {
    const answer = deferred<{ created: boolean; view: MealView }>();
    const { controller, createMock, onSaved, snapshots } = setup(() => answer.promise);
    expect(controller.submit('2026-11-05', details)).toBe(true);
    expect(controller.submit('2026-11-05', details)).toBe(false);
    expect(controller.pending).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![1]).toEqual({ ...details, idempotencyKey: 'key-1', localDate: '2026-11-05', timeZone: 'Europe/Warsaw' });
    expect(snapshots.at(-1)).toEqual({ message: null, phase: 'pending', uncertain: false });
    answer.resolve({ created: true, view: entry('a') });
    await flush();
    expect(snapshots.at(-1)).toEqual({ message: 'Entry saved.', phase: 'saved', uncertain: false });
    expect(onSaved).toHaveBeenCalledWith(entry('a'), true);
  });

  it('reuses the same key after an uncertain outcome, for the same or changed details, and starts a new key after a confirmed save', async () => {
    const outcomes = [failWith(new TypeError('Failed to fetch')), failWith(apiError(503, 'SERVICE_UNAVAILABLE'))];
    const { controller, createMock, snapshots } = setup(() => (outcomes.shift() ?? succeedWith({ created: false, view: entry('a') }))());
    controller.submit('2026-11-05', details);
    await flush();
    expect(snapshots.at(-1)).toMatchObject({ phase: 'failed', uncertain: true });
    expect(snapshots.at(-1)!.message).toContain('The entry may already be saved. Saving again is safe');
    expect(controller.wouldReuse('2026-11-05', details)).toBe(true);
    expect(controller.wouldReuse('2026-11-05', { ...details, title: 'Stew' })).toBe(false);
    expect(controller.wouldReuse('2026-11-04', details)).toBe(false);
    controller.submit('2026-11-05', details);
    await flush();
    controller.submit('2026-11-05', { ...details, title: 'Stew' });
    await flush();
    expect(createMock.mock.calls.map((call) => call[1].idempotencyKey)).toEqual(['key-1', 'key-1', 'key-1']);
    expect(snapshots.at(-1)).toMatchObject({ phase: 'saved' });
    // A genuinely new entry: the next form session has a new key.
    controller.submit('2026-11-05', details);
    expect(createMock.mock.calls.at(-1)![1].idempotencyKey).toBe('key-2');
  });

  it('tells the person when the earlier save went through with other details, and only a new entry clears it', async () => {
    const mealId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const outcomes: Array<() => Promise<{ created: boolean; view: MealView }>> = [
      failWith(new TypeError('Failed to fetch')),
      failWith(apiError(409, 'MEAL_ALREADY_SAVED', { mealId })),
    ];
    const { controller, createMock, onAlreadySaved, snapshots } = setup(() => (outcomes.shift() ?? succeedWith({ created: true, view: entry('b') }))());
    controller.submit('2026-11-05', details);
    await flush();
    controller.submit('2026-11-05', { ...details, energyKcal: 500 });
    await flush();
    expect(snapshots.at(-1)).toMatchObject({ phase: 'already-saved', uncertain: false });
    expect(onAlreadySaved).toHaveBeenCalledWith(mealId);
    expect(controller.submit('2026-11-05', details)).toBe(false);
    controller.acknowledge();
    expect(snapshots.at(-1)!.phase).toBe('already-saved');
    controller.startNew();
    expect(snapshots.at(-1)).toEqual({ message: null, phase: 'idle', uncertain: false });
    controller.submit('2026-11-05', details);
    expect(createMock.mock.calls.at(-1)![1].idempotencyKey).toBe('key-2');
  });

  it('keeps the key after a definitive refusal (nothing was stored) and says why', async () => {
    const outcomes = [failWith(apiError(400, 'INVALID_REQUEST')), failWith(apiError(401, 'AUTH_REQUIRED'))];
    const { controller, createMock, snapshots } = setup(() => (outcomes.shift() ?? succeedWith({ created: true, view: entry('a') }))());
    controller.submit('2026-11-05', details);
    await flush();
    expect(snapshots.at(-1)).toEqual({ message: 'The entry was not saved: No.', phase: 'failed', uncertain: false });
    expect(controller.wouldReuse('2026-11-05', details)).toBe(false);
    controller.submit('2026-11-05', details);
    await flush();
    expect(snapshots.at(-1)!.message).toBe('The entry was not saved: sign in again, then save.');
    expect(createMock.mock.calls.map((call) => call[1].idempotencyKey)).toEqual(['key-1', 'key-1']);
  });

  it('is silenced by disposal: a late answer changes nothing', async () => {
    const answer = deferred<{ created: boolean; view: MealView }>();
    const { controller, onSaved, snapshots } = setup(() => answer.promise);
    controller.submit('2026-11-05', details);
    controller.dispose();
    answer.resolve({ created: true, view: entry('a') });
    await flush();
    expect(snapshots.at(-1)!.phase).toBe('pending');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('MealEditController and MealDeletionController', () => {
  it('saves an edit, marks an unknown outcome as safe to repeat, and reports a vanished entry', async () => {
    const outcomes: Array<() => Promise<MealView>> = [failWith(new TypeError('Failed to fetch')), succeedWith(entry('a')), failWith(apiError(404, 'MEAL_NOT_FOUND'))];
    const update = vi.fn(() => outcomes.shift()!());
    const snapshots: MealSaveSnapshot[] = [];
    const onSaved = vi.fn();
    const controller = new MealEditController({ csrf: () => csrf, mealId: 'm1', onChange: (snapshot) => snapshots.push(snapshot), onSaved, orgId, update });
    controller.submit(details);
    expect(controller.submit(details)).toBe(false);
    await flush();
    expect(snapshots.at(-1)).toMatchObject({ phase: 'failed', uncertain: true });
    expect(snapshots.at(-1)!.message).toContain('Saving again is safe.');
    controller.submit(details);
    await flush();
    expect(onSaved).toHaveBeenCalledWith(entry('a'));
    expect(update.mock.calls[1]).toEqual([{ mealId: 'm1', orgId }, details, csrf, expect.any(AbortSignal)]);
    controller.submit(details);
    await flush();
    expect(snapshots.at(-1)!.message).toBe('The changes were not saved: this entry no longer exists. It may have been deleted elsewhere.');
  });

  it('deletes only after confirmation, lets a failed deletion be retried, and reports lost access', async () => {
    const outcomes: Array<() => Promise<void>> = [failWith(new TypeError('Failed to fetch')), succeedWith(undefined)];
    const remove = vi.fn(() => outcomes.shift()!());
    const onDeleted = vi.fn();
    let last = { message: null as string | null, phase: 'confirming' };
    const controller = new MealDeletionController({ csrf: () => csrf, mealId: 'm1', onChange: (snapshot) => (last = snapshot), onDeleted, orgId, remove });
    expect(remove).not.toHaveBeenCalled();
    controller.confirm();
    controller.confirm(); // ignored while pending
    await flush();
    expect(last).toEqual({ message: 'The deletion was not confirmed: the connection failed. Trying again is safe.', phase: 'failed' });
    controller.confirm();
    await flush();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledTimes(1);

    const denied = new MealDeletionController({
      csrf: () => csrf,
      mealId: 'm2',
      onChange: (snapshot) => (last = snapshot),
      onDeleted,
      orgId,
      remove: failWith(apiError(403, 'ORG_ACCESS_DENIED')),
    });
    denied.confirm();
    await flush();
    expect(last.phase).toBe('unavailable');
    denied.confirm();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});
