import type { RunShareListResponse } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  accessLabel,
  personLabel,
  RunSharingController,
  rowActions,
  shareRows,
  type RunSharingApi,
  type RunSharingSnapshot,
} from './run-sharing.js';
import { RunnerApiError, type RunShareTarget } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const coachA = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001';
const coachB = 'cccccccc-cccc-4ccc-8ccc-cccccccc0002';
const runnerMember = 'dddddddd-dddd-4ddd-8ddd-dddddddd0009';
const csrf = { headerName: 'x-csrf-token' as const, token: 't'.repeat(43) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function shares(...items: RunShareListResponse['items']): RunShareListResponse {
  return { items, truncated: false };
}

// An API whose every call waits until the test answers it, so the order of answers is the test's to choose.
function scriptedApi() {
  const calls: Array<{ kind: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; signal: AbortSignal; userId?: string }> = [];
  const record = <T>(kind: string, signal: AbortSignal, userId?: string): Promise<T> => {
    const step = deferred<T>();
    calls.push({
      kind,
      reject: step.reject,
      resolve: step.resolve as (value: unknown) => void,
      signal,
      ...(userId === undefined ? {} : { userId }),
    });
    return step.promise;
  };
  const api: RunSharingApi = {
    grant: vi.fn((target: RunShareTarget, _csrf: unknown, signal: AbortSignal) => record('grant', signal, target.userId)),
    loadCoaches: vi.fn((_orgId: string, signal: AbortSignal) => record<string[]>('coaches', signal)),
    loadShares: vi.fn((_scope, signal: AbortSignal) => record<RunShareListResponse>('shares', signal)),
    revoke: vi.fn((target: RunShareTarget, _csrf: unknown, signal: AbortSignal) =>
      record<void>('revoke', signal, target.userId)),
  };
  const next = (kind: string) => {
    const index = calls.findIndex((call) => call.kind === kind);
    if (index === -1) throw new Error(`No pending ${kind} call`);
    return calls.splice(index, 1)[0]!;
  };
  return { api, calls, next };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function controllerWith(api: RunSharingApi) {
  const snapshots: RunSharingSnapshot[] = [];
  const controller = new RunSharingController({ api, csrf, onChange: (s) => snapshots.push(s), orgId, runId });
  const latest = () => snapshots.at(-1)!;
  return { controller, latest, snapshots };
}

describe('share rows', () => {
  it('lists coaches in server order, then grantees who are not listed coaches, with their exact access', () => {
    const rows = shareRows(
      [coachA, coachB],
      [
        { canReadHistory: false, canReadLive: true, userId: coachB },
        { canReadHistory: true, canReadLive: false, userId: runnerMember },
      ],
    );

    expect(rows).toEqual([
      { access: 'none', kind: 'coach', userId: coachA },
      { access: 'live', kind: 'coach', userId: coachB },
      { access: 'history', kind: 'member', userId: runnerMember },
    ]);
  });

  it('names every access state without rounding a partial grant up or down', () => {
    expect(shareRows([coachA], [{ canReadHistory: true, canReadLive: true, userId: coachA }])[0]?.access).toBe('both');
    expect(shareRows([coachA], [{ canReadHistory: false, canReadLive: false, userId: coachA }])[0]?.access).toBe('neither');
    expect(accessLabel('none')).toBe('Not shared');
    expect(accessLabel('both')).toBe('Live and history');
    expect(accessLabel('live')).toBe('Live only');
    expect(accessLabel('history')).toBe('History only');
    expect(accessLabel('neither')).toBe('No access');
  });

  it('labels a person by role and the end of the identifier, since no name exists', () => {
    expect(personLabel({ access: 'none', kind: 'coach', userId: coachA })).toBe('Coach …cccc0001');
    expect(personLabel({ access: 'live', kind: 'member', userId: runnerMember })).toBe('Member …dddd0009');
  });

  it('offers Share for an unshared coach, Revoke for a full grant, both for a partial one, and only Revoke for a member', () => {
    expect(rowActions({ access: 'none', kind: 'coach', userId: coachA })).toEqual(['grant']);
    expect(rowActions({ access: 'both', kind: 'coach', userId: coachA })).toEqual(['revoke']);
    expect(rowActions({ access: 'live', kind: 'coach', userId: coachA })).toEqual(['grant', 'revoke']);
    expect(rowActions({ access: 'neither', kind: 'coach', userId: coachA })).toEqual(['grant', 'revoke']);
    expect(rowActions({ access: 'history', kind: 'member', userId: runnerMember })).toEqual(['revoke']);
    expect(rowActions({ access: 'both', kind: 'member', userId: runnerMember })).toEqual(['revoke']);
  });
});

describe('RunSharingController', () => {
  it('loads coaches and shares together and becomes ready', async () => {
    const { api, next } = scriptedApi();
    const { controller, latest } = controllerWith(api);

    controller.start();
    expect(latest()).toMatchObject({ pending: null, rows: [], status: 'loading' });
    next('coaches').resolve([coachA]);
    next('shares').resolve(shares());
    await settle();

    expect(latest()).toEqual({
      message: null,
      pending: null,
      rows: [{ access: 'none', kind: 'coach', userId: coachA }],
      status: 'ready',
      truncated: false,
    });
  });

  it('grants, then reads the shares again and shows what the server reports', async () => {
    const { api, calls, next } = scriptedApi();
    const { controller, latest } = controllerWith(api);
    controller.start();
    next('coaches').resolve([coachA, coachB]);
    next('shares').resolve(shares());
    await settle();

    controller.grant(coachA);
    expect(latest().pending).toEqual({ change: 'grant', userId: coachA });
    // One change at a time: a second click on any row does nothing while the first is open.
    controller.revoke(coachB);
    controller.grant(coachB);
    expect(calls.filter((call) => call.kind === 'grant' || call.kind === 'revoke')).toHaveLength(1);

    next('grant').resolve({ canReadHistory: true, canReadLive: true });
    await settle();
    expect(latest().pending).toEqual({ change: 'grant', userId: coachA });
    next('shares').resolve(shares({ canReadHistory: true, canReadLive: true, userId: coachA }));
    await settle();

    expect(latest()).toMatchObject({
      message: null,
      pending: null,
      rows: [
        { access: 'both', kind: 'coach', userId: coachA },
        { access: 'none', kind: 'coach', userId: coachB },
      ],
      status: 'ready',
    });
    expect(api.loadCoaches).toHaveBeenCalledTimes(1);
  });

  it('reads the shares again after a failed change too, and says the change failed', async () => {
    const { api, next } = scriptedApi();
    const { controller, latest } = controllerWith(api);
    controller.start();
    next('coaches').resolve([coachA]);
    next('shares').resolve(shares({ canReadHistory: true, canReadLive: true, userId: coachA }));
    await settle();

    controller.revoke(coachA);
    next('revoke').reject(new RunnerApiError('The run does not exist', 404, 'RUN_NOT_FOUND', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
    await settle();
    // The timed-out or refused change may still have happened: the list is read again rather than guessed.
    next('shares').resolve(shares());
    await settle();

    expect(latest()).toMatchObject({
      message: 'Revoking was not confirmed: The run does not exist. Reference eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.',
      pending: null,
      rows: [{ access: 'none', kind: 'coach', userId: coachA }],
      status: 'ready',
    });
  });

  it('shows an error with no rows when the current shares cannot be read, and retries the whole load', async () => {
    const { api, next } = scriptedApi();
    const { controller, latest } = controllerWith(api);
    controller.start();
    next('coaches').resolve([coachA]);
    next('shares').reject(new TypeError('Failed to fetch'));
    await settle();

    expect(latest()).toMatchObject({ pending: null, rows: [], status: 'error' });
    expect(latest().message).toMatch(/could not be read/u);
    controller.grant(coachA);
    expect(api.grant).not.toHaveBeenCalled();

    controller.retry();
    expect(latest().status).toBe('loading');
    next('coaches').resolve([coachA]);
    next('shares').resolve(shares());
    await settle();
    expect(latest()).toMatchObject({ message: null, status: 'ready' });
  });

  it('marks a list the server cut at its maximum', async () => {
    const { api, next } = scriptedApi();
    const { controller, latest } = controllerWith(api);
    controller.start();
    next('coaches').resolve([]);
    next('shares').resolve({ items: [], truncated: true });
    await settle();

    expect(latest().truncated).toBe(true);
  });

  it('after dispose, aborts what is open and ignores every late answer', async () => {
    const { api, calls, next } = scriptedApi();
    const { controller, snapshots } = controllerWith(api);
    controller.start();
    const signals = calls.map((call) => call.signal);

    controller.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const seen = snapshots.length;
    next('coaches').resolve([coachA]);
    next('shares').resolve(shares({ canReadHistory: true, canReadLive: true, userId: coachA }));
    await settle();
    controller.start();
    controller.retry();
    controller.grant(coachA);

    expect(snapshots).toHaveLength(seen);
    expect(api.grant).not.toHaveBeenCalled();
  });

  it('ignores a late change answer once disposed, and does not read the shares again', async () => {
    const { api, next } = scriptedApi();
    const { controller, snapshots } = controllerWith(api);
    controller.start();
    next('coaches').resolve([coachA]);
    next('shares').resolve(shares());
    await settle();
    controller.grant(coachA);
    const seen = snapshots.length;

    controller.dispose();
    next('grant').resolve({ canReadHistory: true, canReadLive: true });
    await settle();

    expect(snapshots).toHaveLength(seen);
    expect(api.loadShares).toHaveBeenCalledTimes(1);
  });
});
