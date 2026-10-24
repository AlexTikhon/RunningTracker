import { describe, expect, it, vi } from 'vitest';

import {
  DemoSignInController,
  demoIdentities,
  describeDemoSignInFailure,
  localDemoEnabled,
  type DemoSignInSnapshot,
} from './demo-sign-in.js';
import { RunnerApiError } from './runner-api.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function setup() {
  const creations: { signal: AbortSignal; userId: string; answer: ReturnType<typeof deferred<void>> }[] = [];
  const confirmations: ReturnType<typeof deferred<boolean>>[] = [];
  const snapshots: DemoSignInSnapshot[] = [];
  const create = vi.fn((userId: string, signal: AbortSignal) => {
    const answer = deferred<void>();
    creations.push({ answer, signal, userId });
    return answer.promise;
  });
  const confirm = vi.fn(() => {
    const answer = deferred<boolean>();
    confirmations.push(answer);
    return answer.promise;
  });
  const controller = new DemoSignInController({ confirm, create, onChange: (snapshot) => snapshots.push(snapshot) });
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };
  return { confirm, confirmations, controller, create, creations, settle, snapshots };
}

describe('localDemoEnabled', () => {
  it('needs both a development build and the explicit flag', () => {
    expect(localDemoEnabled({ DEV: true, VITE_LOCAL_DEMO_ENABLED: 'true' })).toBe(true);
    expect(localDemoEnabled({ DEV: true })).toBe(false);
    expect(localDemoEnabled({ DEV: true, VITE_LOCAL_DEMO_ENABLED: '' })).toBe(false);
    expect(localDemoEnabled({ DEV: true, VITE_LOCAL_DEMO_ENABLED: '1' })).toBe(false);
    expect(localDemoEnabled({ DEV: true, VITE_LOCAL_DEMO_ENABLED: 'TRUE' })).toBe(false);
    // A production build never offers it, whatever the flag says.
    expect(localDemoEnabled({ DEV: false, VITE_LOCAL_DEMO_ENABLED: 'true' })).toBe(false);
  });
});

describe('DemoSignInController', () => {
  it('creates a session for the fixed demo identity, then hands over to the page’s own session check', async () => {
    const { confirm, confirmations, controller, create, creations, settle, snapshots } = setup();

    controller.signIn('runner');

    expect(create).toHaveBeenCalledTimes(1);
    expect(creations[0]?.userId).toBe(demoIdentities.runner);
    expect(snapshots).toEqual([{ failure: null, pending: 'runner' }]);
    creations[0]?.answer.resolve();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    // Still pending until the check has answered: the buttons stay disabled.
    expect(snapshots.at(-1)).toEqual({ failure: null, pending: 'runner' });
    confirmations[0]?.resolve(true);
    await settle();
    expect(snapshots.at(-1)).toEqual({ failure: null, pending: null });
  });

  it('uses the coach identity for the coach', () => {
    const { controller, creations } = setup();
    controller.signIn('coach');
    expect(creations[0]?.userId).toBe(demoIdentities.coach);
  });

  it('starts nothing else while a sign-in is pending, for either identity', async () => {
    const { controller, create, creations, settle } = setup();

    controller.signIn('runner');
    controller.signIn('coach');
    controller.signIn('runner');
    expect(create).toHaveBeenCalledTimes(1);

    creations[0]?.answer.resolve();
    await settle();
    // Still pending during the session check.
    controller.signIn('coach');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports a failure, never asks the session, and allows a retry', async () => {
    const { confirm, controller, create, creations, settle, snapshots } = setup();

    controller.signIn('coach');
    creations[0]?.answer.reject(new RunnerApiError('The local identity is not allowed', 403, 'LOCAL_IDENTITY_DENIED', null));
    await settle();

    expect(confirm).not.toHaveBeenCalled();
    expect(snapshots.at(-1)?.pending).toBeNull();
    expect(snapshots.at(-1)?.failure).toContain('LOCAL_AUTH_USER_IDS');

    controller.signIn('coach');
    expect(create).toHaveBeenCalledTimes(2);
    // A new attempt clears the old failure.
    expect(snapshots.at(-1)).toEqual({ failure: null, pending: 'coach' });
  });

  it('says so when the server accepted the sign-in but the session check did not confirm it', async () => {
    const { confirmations, controller, creations, settle, snapshots } = setup();

    controller.signIn('runner');
    creations[0]?.answer.resolve();
    await settle();
    confirmations[0]?.resolve(false);
    await settle();

    expect(snapshots.at(-1)?.pending).toBeNull();
    expect(snapshots.at(-1)?.failure).toContain('did not confirm');
  });

  it('treats a session check that throws like one that did not confirm', async () => {
    const { confirmations, controller, creations, settle, snapshots } = setup();

    controller.signIn('runner');
    creations[0]?.answer.resolve();
    await settle();
    confirmations[0]?.reject(new Error('boom'));
    await settle();

    expect(snapshots.at(-1)?.pending).toBeNull();
    expect(snapshots.at(-1)?.failure).toContain('did not confirm');
  });

  it('once disposed, aborts the request and lets neither its answer nor its failure reach the page', async () => {
    const answered = setup();
    answered.controller.signIn('runner');
    answered.controller.dispose();
    expect(answered.creations[0]?.signal.aborted).toBe(true);
    answered.creations[0]?.answer.resolve();
    await answered.settle();
    expect(answered.confirm).not.toHaveBeenCalled();
    expect(answered.snapshots).toHaveLength(1);

    const failed = setup();
    failed.controller.signIn('coach');
    failed.controller.dispose();
    failed.creations[0]?.answer.reject(new DOMException('aborted', 'AbortError'));
    await failed.settle();
    expect(failed.snapshots).toHaveLength(1);

    failed.controller.signIn('runner');
    expect(failed.create).toHaveBeenCalledTimes(1);
  });

  it('stays silent when it is disposed while the session check is still running', async () => {
    const { confirmations, controller, creations, settle, snapshots } = setup();

    controller.signIn('runner');
    creations[0]?.answer.resolve();
    await settle();
    controller.dispose();
    confirmations[0]?.resolve(false);
    await settle();

    expect(snapshots).toEqual([{ failure: null, pending: 'runner' }]);
  });
});

describe('describeDemoSignInFailure', () => {
  it('turns each refusal of the local session endpoint into what to do about it', () => {
    expect(describeDemoSignInFailure('runner', new RunnerApiError('no', 404, 'ROUTE_NOT_FOUND', null)))
      .toMatch(/^Could not sign in as the demo runner\. Local sign-in is off on this API.*npm run demo:up/u);
    expect(describeDemoSignInFailure('coach', new RunnerApiError('no', 403, 'ORIGIN_DENIED', null)))
      .toContain('http://127.0.0.1:5173');
    expect(describeDemoSignInFailure('coach', new RunnerApiError('no', 403, 'LOCAL_IDENTITY_DENIED', null)))
      .toContain('LOCAL_AUTH_USER_IDS');
    expect(describeDemoSignInFailure('coach', new RunnerApiError('Full', 503, 'SESSION_STORE_UNAVAILABLE', 'req-1')))
      .toBe('Could not sign in as the demo coach. Full (SESSION_STORE_UNAVAILABLE). Reference req-1. Try again.');
  });

  it('separates a deadline from an unreachable server', () => {
    expect(describeDemoSignInFailure('runner', new DOMException('late', 'TimeoutError'))).toContain('did not answer in time');
    expect(describeDemoSignInFailure('runner', new TypeError('Failed to fetch'))).toContain('could not be reached');
  });
});
