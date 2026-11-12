import type { ActivityView } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { ActivityDetails } from './activity-form.js';

import {
  ActivityDeletionController,
  ActivitySubmissionController,
  type ActivityCreator,
  type ActivityDeletionSnapshot,
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
const formKey = (n: number) => `bf000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request: ActivityDetails = {
  distanceM: 5_000,
  durationS: 1_800,
  notes: null,
  rpe: 6,
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'run',
};
const apiError = (status: number, code: string, message = 'Refused', details: Record<string, unknown> | null = null) =>
  new RunnerApiError(message, status, code, '22222222-2222-4222-8222-222222222222', null, details);

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

describe('ActivitySubmissionController', () => {
  function harness(create: ActivityCreator, signal?: AbortSignal) {
    const snapshots: ActivitySubmissionSnapshot[] = [];
    const saved = vi.fn<(activity: ActivityView, created: boolean) => void>();
    const alreadySaved = vi.fn<(activityId: string | null) => void>();
    let next = 100;
    let nextKey = 1;
    let token = csrf;
    const controller = new ActivitySubmissionController({
      create,
      csrf: () => token,
      newId: () => id(next++),
      newKey: () => formKey(nextKey++),
      onAlreadySaved: alreadySaved,
      onChange: (s) => snapshots.push(s),
      onSaved: saved,
      orgId,
      ...(signal ? { signal } : {}),
    });
    return {
      alreadySaved,
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
    expect(create).toHaveBeenCalledWith(
      { activityId: id(100), orgId },
      { ...request, idempotencyKey: formKey(1) },
      fresh,
      expect.any(AbortSignal),
    );
    expect(last()).toMatchObject({ message: 'Activity saved.', phase: 'saved', uncertain: false });
    expect(saved).toHaveBeenCalledWith(activity(100), true);
    // A confirmed save ends the form session: the next activity gets a new id and a new key.
    controller.submit(request);
    expect(create.mock.calls[1]?.[0]).toEqual({ activityId: id(101), orgId });
    expect(create.mock.calls[1]?.[1].idempotencyKey).toBe(formKey(2));
  });

  it('keeps one idempotency key for the whole form session, across edits after an unknown outcome', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ activity: activity(101), created: true });
    const { controller } = harness(create);
    controller.submit(request);
    await flush();
    controller.submit({ ...request, notes: 'edited' });
    await flush();
    controller.submit({ ...request, notes: 'edited again' });
    await flush();
    expect(create.mock.calls.map(([target, sent]) => [target.activityId, sent.idempotencyKey])).toEqual([
      [id(100), formKey(1)],
      [id(101), formKey(1)],
      [id(102), formKey(1)],
    ]);
  });

  it('tells the person their earlier save went through when the key already saved other details (409), and names it', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(new DOMException('Request deadline exceeded', 'TimeoutError'))
      .mockRejectedValueOnce(
        apiError(409, 'ACTIVITY_ALREADY_SAVED', 'An activity was already saved from this form with different details', {
          activityId: id(100),
        }),
      );
    const { alreadySaved, controller, last, saved } = harness(create);
    controller.submit(request);
    await flush();
    controller.submit({ ...request, rpe: 9 });
    await flush();

    expect(last()).toEqual({
      message: 'Your earlier save went through, so these changed details were not saved.',
      phase: 'already-saved',
      savedActivityId: id(100),
      uncertain: false,
    });
    expect(alreadySaved).toHaveBeenCalledWith(id(100));
    expect(saved).not.toHaveBeenCalled();
    // Nothing more is sent from this form session: it already produced its activity.
    expect(controller.submit({ ...request, rpe: 9 })).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('still reports the earlier save when the 409 does not name the activity', async () => {
    const create = vi.fn<ActivityCreator>().mockRejectedValueOnce(apiError(409, 'ACTIVITY_ALREADY_SAVED', 'Already saved', { activityId: 'nope' }));
    const { alreadySaved, controller, last } = harness(create);
    controller.submit(request);
    await flush();
    expect(last()).toMatchObject({ phase: 'already-saved', savedActivityId: null });
    expect(alreadySaved).toHaveBeenCalledWith(null);
  });

  it('starts a new form session on request: idle, a new key, and nothing retained', async () => {
    const create = vi
      .fn<ActivityCreator>()
      .mockRejectedValueOnce(apiError(409, 'ACTIVITY_ALREADY_SAVED', 'Already saved', { activityId: id(100) }))
      .mockResolvedValueOnce({ activity: activity(101), created: true });
    const { controller, last } = harness(create);
    controller.submit(request);
    await flush();
    controller.startNew();
    expect(last()).toEqual({ message: null, phase: 'idle', savedActivityId: null, uncertain: false });
    expect(controller.wouldReuse(request)).toBe(false);
    expect(controller.submit(request)).toBe(true);
    await flush();
    expect(create.mock.calls[1]?.[1].idempotencyKey).toBe(formKey(2));
    expect(last()).toMatchObject({ phase: 'saved' });
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
    // The key stays: if the first attempt did go through, the server refuses to save a second activity.
    expect(create.mock.calls.map(([, sent]) => sent.idempotencyKey)).toEqual([formKey(1), formKey(1)]);
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
