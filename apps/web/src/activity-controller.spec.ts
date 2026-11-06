import type { ActivityListResponse, ActivityView, CreateActivityRequest } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  ActivityDeletionController,
  ActivityListController,
  ActivitySubmissionController,
  type ActivityCreator,
  type ActivityDeletionSnapshot,
  type ActivityListSnapshot,
  type ActivityLoader,
  type ActivitySubmissionSnapshot,
} from './activity-controller.js';
import { RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const id = (n: number) => `ad000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const activity = (n: number): ActivityView => ({
  activityId: id(n),
  createdAt: '2026-10-05T08:00:00.000Z',
  distanceM: null,
  durationS: 600,
  notes: null,
  rpe: null,
  source: 'manual',
  startedAt: `2026-10-${String(10 - (n % 9)).padStart(2, '0')}T06:00:00.000Z`,
  type: 'run',
});
const page = (items: ActivityView[], nextCursor: string | null = null): ActivityListResponse => ({ items, nextCursor });
const request: Required<CreateActivityRequest> = {
  distanceM: 5_000,
  durationS: 1_800,
  notes: null,
  rpe: 6,
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'run',
};
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

describe('ActivityListController', () => {
  function harness(load: ActivityLoader, signal?: AbortSignal) {
    const snapshots: ActivityListSnapshot[] = [];
    const controller = new ActivityListController({ load, onChange: (s) => snapshots.push(s), orgId, ...(signal ? { signal } : {}) });
    return { controller, last: () => snapshots.at(-1)!, snapshots };
  }

  it('loads the first page for its organization without a cursor', async () => {
    const load = vi.fn<ActivityLoader>().mockResolvedValue(page([activity(1), activity(2)], 'c1'));
    const { controller, last, snapshots } = harness(load);
    controller.start();
    expect(snapshots[0]).toMatchObject({ items: [], status: 'loading' });
    await flush();
    expect(load).toHaveBeenCalledWith({ cursor: null, orgId }, expect.any(AbortSignal));
    expect(last()).toMatchObject({ hasMore: true, message: null, status: 'ready' });
    expect(last().items.map((item) => item.activityId)).toEqual([id(1), id(2)]);
  });

  it('asks for the next page with the cursor the server returned, one page at a time, without repeating items', async () => {
    const second = deferred<ActivityListResponse>();
    const load = vi
      .fn<ActivityLoader>()
      .mockResolvedValueOnce(page([activity(1), activity(2)], 'c1'))
      .mockReturnValueOnce(second.promise);
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    controller.loadMore();
    controller.loadMore();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toEqual({ cursor: 'c1', orgId });
    expect(last().loadingMore).toBe(true);
    second.resolve(page([activity(2), activity(3)], null));
    await flush();
    expect(last().items.map((item) => item.activityId)).toEqual([id(1), id(2), id(3)]);
    expect(last()).toMatchObject({ hasMore: false, loadingMore: false });
    controller.loadMore();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('says why the first page failed, with the reference, and starts over on retry', async () => {
    const load = vi
      .fn<ActivityLoader>()
      .mockRejectedValueOnce(apiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred'))
      .mockResolvedValueOnce(page([activity(1)]));
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    expect(last()).toMatchObject({ status: 'error' });
    expect(last().message).toBe('An unexpected server error occurred. Reference 22222222-2222-4222-8222-222222222222.');
    controller.retry();
    await flush();
    expect(load.mock.calls[1]?.[0]).toEqual({ cursor: null, orgId });
    expect(last()).toMatchObject({ message: null, status: 'ready' });
  });

  it('keeps the shown pages when the next one fails, and offers it again; an invalid cursor starts over', async () => {
    const load = vi
      .fn<ActivityLoader>()
      .mockResolvedValueOnce(page([activity(1)], 'c1'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(apiError(400, 'INVALID_CURSOR'))
      .mockResolvedValueOnce(page([activity(4)]));
    const { controller, last } = harness(load);
    controller.start();
    await flush();
    controller.loadMore();
    await flush();
    expect(last().items).toHaveLength(1);
    expect(last().moreMessage).toBe('More activities could not be loaded. Check your connection and try again.');
    controller.retry();
    await flush();
    expect(load.mock.calls[2]?.[0]).toEqual({ cursor: 'c1', orgId });
    expect(last().moreMessage).toBe('This list is out of date. Refresh to see your current activities.');
    controller.retry();
    await flush();
    expect(load.mock.calls[3]?.[0]).toEqual({ cursor: null, orgId });
    expect(last().items.map((item) => item.activityId)).toEqual([id(4)]);
  });

  it('clears the list and says access was lost on 401 or 403', async () => {
    for (const error of [apiError(401, 'AUTH_REQUIRED'), apiError(403, 'ORG_ACCESS_DENIED')]) {
      const load = vi.fn<ActivityLoader>().mockResolvedValueOnce(page([activity(1)], 'c1')).mockRejectedValueOnce(error);
      const { controller, last } = harness(load);
      controller.start();
      await flush();
      controller.loadMore();
      await flush();
      expect(last()).toMatchObject({ hasMore: false, items: [], status: 'access-denied' });
      expect(last().message).toBe('You no longer have access to your activities in this organization.');
    }
  });

  it('drops an answer still on its way when it is disposed, as on an organization or person switch', async () => {
    const answer = deferred<ActivityListResponse>();
    const load = vi.fn<ActivityLoader>().mockReturnValue(answer.promise);
    const { controller, snapshots } = harness(load);
    controller.start();
    const signal = load.mock.calls[0]![1];
    controller.dispose();
    expect(signal.aborted).toBe(true);
    const before = snapshots.length;
    answer.resolve(page([activity(1)]));
    await flush();
    expect(snapshots).toHaveLength(before);
    controller.refresh();
    controller.loadMore();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('drops an answer still on its way when the session that started it ends', async () => {
    const session = new AbortController();
    const answer = deferred<ActivityListResponse>();
    const load = vi.fn<ActivityLoader>().mockReturnValue(answer.promise);
    const { controller, snapshots } = harness(load, session.signal);
    controller.start();
    session.abort();
    expect(load.mock.calls[0]![1].aborted).toBe(true);
    const before = snapshots.length;
    answer.resolve(page([activity(1)]));
    await flush();
    expect(snapshots).toHaveLength(before);
    controller.refresh();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not start at all for a session that has already ended', () => {
    const session = new AbortController();
    session.abort();
    const load = vi.fn<ActivityLoader>();
    const { controller } = harness(load, session.signal);
    controller.start();
    expect(load).not.toHaveBeenCalled();
  });

  it('starts over on refresh and ignores the answer to the request it replaced', async () => {
    const stale = deferred<ActivityListResponse>();
    const load = vi.fn<ActivityLoader>().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(page([activity(2)]));
    const { controller, last } = harness(load);
    controller.start();
    controller.refresh();
    await flush();
    stale.resolve(page([activity(1)]));
    await flush();
    expect(last().items.map((item) => item.activityId)).toEqual([id(2)]);
  });
});

describe('ActivitySubmissionController', () => {
  function harness(create: ActivityCreator, signal?: AbortSignal) {
    const snapshots: ActivitySubmissionSnapshot[] = [];
    const saved = vi.fn<(activity: ActivityView, created: boolean) => void>();
    let next = 100;
    let token = csrf;
    const controller = new ActivitySubmissionController({
      create,
      csrf: () => token,
      newId: () => id(next++),
      onChange: (s) => snapshots.push(s),
      onSaved: saved,
      orgId,
      ...(signal ? { signal } : {}),
    });
    return {
      controller,
      last: () => snapshots.at(-1)!,
      saved,
      setToken: (value: typeof csrf) => {
        token = value;
      },
      snapshots,
    };
  }

  it('sends the request under a new client id with the current CSRF token, and reports it saved', async () => {
    const create = vi.fn<ActivityCreator>().mockResolvedValue({ activity: activity(100), created: true });
    const { controller, last, saved, setToken } = harness(create);
    const fresh = { headerName: 'x-csrf-token' as const, token: 'b'.repeat(43) };
    setToken(fresh);
    expect(controller.submit(request)).toBe(true);
    expect(last()).toMatchObject({ phase: 'pending', uncertain: false });
    await flush();
    expect(create).toHaveBeenCalledWith({ activityId: id(100), orgId }, request, fresh, expect.any(AbortSignal));
    expect(last()).toMatchObject({ message: 'Activity saved.', phase: 'saved', uncertain: false });
    expect(saved).toHaveBeenCalledWith(activity(100), true);
    controller.submit(request);
    expect(create.mock.calls[1]?.[0]).toEqual({ activityId: id(101), orgId });
  });

  it('keeps the id after an unknown outcome, so saving the same details again cannot duplicate them', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(new DOMException('Request deadline exceeded', 'TimeoutError'))
      .mockRejectedValueOnce(apiError(503, 'DB_STATEMENT_TIMEOUT', 'The database did not finish the request within its time limit'))
      .mockResolvedValueOnce({ activity: activity(100), created: false });
    const { controller, last, saved } = harness(create);
    controller.submit(request);
    await flush();
    expect(last()).toMatchObject({ phase: 'failed', uncertain: true });
    expect(last().message).toBe(
      'The save was not confirmed: the server did not answer in time. The activity may already be saved. Saving the same details again is safe and will not create a duplicate.',
    );
    expect(controller.wouldReuse(request)).toBe(true);
    controller.submit({ ...request });
    await flush();
    expect(last().message).toContain('The database did not finish the request within its time limit.');
    controller.submit(request);
    await flush();
    expect(create.mock.calls.map(([target]) => target.activityId)).toEqual([id(100), id(100), id(100)]);
    expect(saved).toHaveBeenCalledWith(activity(100), false);
    expect(last()).toMatchObject({ phase: 'saved', uncertain: false });
  });

  it('uses a new id when the details changed after an unknown outcome', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ activity: activity(101), created: true });
    const { controller } = harness(create);
    controller.submit(request);
    await flush();
    const changed = { ...request, rpe: 7 };
    expect(controller.wouldReuse(changed)).toBe(false);
    controller.submit(changed);
    await flush();
    expect(create.mock.calls.map(([target]) => target.activityId)).toEqual([id(100), id(101)]);
  });

  it('forgets the id after a definitive refusal, and says what the server refused', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(apiError(400, 'INVALID_REQUEST', 'The activity creation request is invalid'))
      .mockRejectedValueOnce(apiError(409, 'ACTIVITY_CONFLICT'))
      .mockRejectedValueOnce(apiError(404, 'ACTIVITY_NOT_FOUND'));
    const { controller, last } = harness(create);
    controller.submit(request);
    await flush();
    expect(last()).toMatchObject({ phase: 'failed', uncertain: false });
    expect(last().message).toBe(
      'The activity was not saved: The activity creation request is invalid. Reference 22222222-2222-4222-8222-222222222222.',
    );
    controller.submit(request);
    await flush();
    expect(last().message).toBe('The activity was not saved because its identifier was already used. Save again to retry.');
    controller.submit(request);
    await flush();
    expect(last().message).toBe('The activity was not saved because its identifier was already used. Save again to retry.');
    expect(create.mock.calls.map(([target]) => target.activityId)).toEqual([id(100), id(101), id(102)]);
  });

  it('says access was lost on 403, and that sign-in is needed on 401', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(apiError(403, 'ORG_ACCESS_DENIED'))
      .mockRejectedValueOnce(apiError(401, 'AUTH_REQUIRED'));
    const { controller, last } = harness(create);
    controller.submit(request);
    await flush();
    expect(last().message).toBe('The activity was not saved: you no longer have access to this organization.');
    controller.submit(request);
    await flush();
    expect(last().message).toBe('The activity was not saved: sign in again, then save.');
  });

  it('sends one request at a time', () => {
    const answer = deferred<{ activity: ActivityView; created: boolean }>();
    const create = vi.fn<ActivityCreator>().mockReturnValue(answer.promise);
    const { controller } = harness(create);
    expect(controller.submit(request)).toBe(true);
    expect(controller.submit({ ...request, rpe: 1 })).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports nothing after disposal or the end of its session, even if the server saved it', async () => {
    for (const end of ['dispose', 'session'] as const) {
      const session = new AbortController();
      const answer = deferred<{ activity: ActivityView; created: boolean }>();
      const create = vi.fn<ActivityCreator>().mockReturnValue(answer.promise);
      const { controller, saved, snapshots } = harness(create, session.signal);
      controller.submit(request);
      if (end === 'dispose') controller.dispose();
      else session.abort();
      expect(create.mock.calls[0]![3].aborted).toBe(true);
      const before = snapshots.length;
      answer.resolve({ activity: activity(100), created: true });
      await flush();
      expect(snapshots).toHaveLength(before);
      expect(saved).not.toHaveBeenCalled();
      expect(controller.submit(request)).toBe(false);
    }
  });
});

describe('ActivityDeletionController', () => {
  function harness(remove: ConstructorParameters<typeof ActivityDeletionController>[0]['deleteActivity'], signal?: AbortSignal) {
    const snapshots: ActivityDeletionSnapshot[] = [];
    const deleted = vi.fn();
    const controller = new ActivityDeletionController({
      activityId: id(1),
      csrf: () => csrf,
      deleteActivity: remove,
      onChange: (s) => snapshots.push(s),
      onDeleted: deleted,
      orgId,
      ...(signal ? { signal } : {}),
    });
    return { controller, deleted, last: () => snapshots.at(-1)!, snapshots };
  }

  it('sends nothing until confirmed, then one DELETE, and reports the deletion once', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { controller, deleted, last } = harness(remove);
    expect(controller.snapshot).toEqual({ message: null, phase: 'confirming' });
    expect(remove).not.toHaveBeenCalled();
    controller.confirm();
    controller.confirm();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ activityId: id(1), orgId }, csrf, expect.any(AbortSignal));
    expect(last()).toEqual({ message: null, phase: 'pending' });
    await flush();
    expect(last()).toEqual({ message: null, phase: 'deleted' });
    expect(deleted).toHaveBeenCalledTimes(1);
    controller.confirm();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('lets an unconfirmed deletion be sent again for the same activity', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(undefined);
    const { controller, deleted, last } = harness(remove);
    controller.confirm();
    await flush();
    expect(last()).toEqual({
      message: 'The deletion was not confirmed: the connection failed. Trying again is safe.',
      phase: 'failed',
    });
    controller.confirm();
    await flush();
    expect(remove.mock.calls.map(([target]) => (target as { activityId: string }).activityId)).toEqual([id(1), id(1)]);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('stops offering the deletion when access to the organization is gone', async () => {
    const remove = vi.fn().mockRejectedValue(apiError(403, 'ORG_ACCESS_DENIED'));
    const { controller, last } = harness(remove);
    controller.confirm();
    await flush();
    expect(last()).toEqual({
      message: 'You no longer have access to this organization, so this activity cannot be deleted.',
      phase: 'unavailable',
    });
    controller.confirm();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('reports nothing after disposal or the end of its session', async () => {
    for (const end of ['dispose', 'session'] as const) {
      const session = new AbortController();
      const answer = deferred<void>();
      const remove = vi.fn().mockReturnValue(answer.promise);
      const { controller, deleted, snapshots } = harness(remove, session.signal);
      controller.confirm();
      if (end === 'dispose') controller.dispose();
      else session.abort();
      const before = snapshots.length;
      answer.resolve();
      await flush();
      expect(snapshots).toHaveLength(before);
      expect(deleted).not.toHaveBeenCalled();
    }
  });
});
