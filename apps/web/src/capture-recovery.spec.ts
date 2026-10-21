import type { RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaptureController, type CaptureState } from './capture-controller.js';
import { LocationFailure, type CaptureSink, type CaptureSource, type SourceMeasurement } from './capture-source.js';
import type { StartRequest } from './runner-state.js';
import { IndexedDbRunnerStorage, type RunScope, type WriterLease } from './runner-storage.js';

// Foreground GPS recovery (ADR-0061). A temporary location failure (TIMEOUT, POSITION_UNAVAILABLE) leaves the one
// native watch running and the next genuine fix is persisted in the same segment; a permission denial, storage
// failure, queue overflow or lost writer stops capture. Only an explicit retry restarts the watch, and only for
// the same live controller, writer epoch and run. The storage is the real IndexedDbRunnerStorage on
// fake-indexeddb, so seq and segment come from the durable records; the source is scripted callback by callback
// and every clock is injected. Nothing sleeps.

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ownerB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const scope: RunScope = { orgId, runId, userId };
const DURATION_MS = 15_000;
const startedAt = '2026-10-21T08:00:00.000Z';
const start: StartRequest = { kind: 'start', orgId, runId, startedAt };
const recording: RunView = {
  controlRevision: '0',
  dataRevision: '0',
  finishedAt: null,
  rawState: 'available',
  runId,
  startedAt,
  status: 'recording',
  summary: null,
};

afterEach(() => {
  vi.useRealTimers();
});

function fix(second: number): SourceMeasurement {
  return {
    accuracyM: 5,
    latitude: 52.2297 + second * 0.00001,
    longitude: 21.0122,
    recordedAt: new Date(Date.parse(startedAt) + second * 1_000).toISOString(),
  };
}

// A source whose every subscription keeps its own sink, so a test can deliver a late callback to a watch that was
// already replaced. `log` records starts and stops in order.
function scriptedSource(options: { failStart?: () => Error } = {}) {
  const log: string[] = [];
  const subscriptions: Array<{ sink: CaptureSink; stop: ReturnType<typeof vi.fn>; stopped: boolean }> = [];
  const start = vi.fn((sink: CaptureSink) => {
    if (options.failStart !== undefined) throw options.failStart();
    const index = subscriptions.length;
    log.push(`start ${index}`);
    const entry = {
      sink,
      stop: vi.fn(() => {
        entry.stopped = true;
        log.push(`stop ${index}`);
      }),
      stopped: false,
    };
    subscriptions.push(entry);
    return { stop: entry.stop };
  });
  const source: CaptureSource = { label: 'Device GPS', start };
  const sinkAt = (index: number): CaptureSink => {
    const entry = subscriptions[index];
    if (entry === undefined) throw new Error(`No subscription ${index}`);
    return entry.sink;
  };
  return {
    active: () => subscriptions.filter((entry) => !entry.stopped).length,
    latest: () => sinkAt(subscriptions.length - 1),
    log,
    sinkAt,
    source,
    start,
    subscriptions,
  };
}

async function createFixture(options: { failStart?: () => Error } = {}) {
  const factory = new IDBFactory();
  const databaseName = crypto.randomUUID();
  let wallMs = Date.parse(startedAt);
  let monotonicMs = 1_000;
  const open = () => new IndexedDbRunnerStorage({
    databaseName,
    factory,
    keyRange: IDBKeyRange,
    now: () => new Date(wallMs),
  });
  const storage = open();
  const otherTab = open();
  const acquired = await storage.acquireWriterLease(userId, ownerA, DURATION_MS);
  if (!acquired.acquired) throw new Error('Expected to acquire the lease');
  let lease: WriterLease | null = acquired.lease;
  await storage.queueRequest(userId, start, null, lease);
  await storage.acknowledgeStart(userId, start, recording, lease);

  const source = scriptedSource(options);
  const states: CaptureState[] = [];
  const allocate = vi.spyOn(storage, 'allocateCaptureSegment');
  const append = vi.spyOn(storage, 'appendPointForWriter');
  // The writer coordinator's proof: a renewal against the durable lease, null once another epoch holds it.
  const assertOwnedLease = vi.fn(async () => {
    if (lease === null) return null;
    lease = await storage.renewWriterLease(lease, DURATION_MS);
    return lease;
  });
  const controller = new CaptureController({
    assertOwnedLease,
    now: () => monotonicMs,
    onPoint: vi.fn(),
    onState: (state) => states.push(state),
    scope,
    source: source.source,
    storage,
  });
  return {
    advanceMonotonic: (ms: number) => { monotonicMs += ms; },
    allocate,
    append,
    assertOwnedLease,
    controller,
    // The durable truth: every point still buffered for this run, in seq order.
    durable: async () => (await otherTab.exportBufferedPoints(scope))
      .map(({ segmentId, seq }) => ({ segmentId, seq })),
    latest: () => states.at(-1),
    source,
    states,
    storage,
    // Tab A's lease runs out and another tab takes the next fencing epoch.
    takeOver: async () => {
      wallMs += DURATION_MS + 1;
      const next = await otherTab.acquireWriterLease(userId, ownerB, DURATION_MS);
      if (!next.acquired) throw new Error('Expected the other tab to take the lease');
    },
  };
}

const timeout = () => new LocationFailure('timeout');
const unavailable = () => new LocationFailure('position-unavailable');
const denied = () => new LocationFailure('permission-denied');

describe('temporary location failures keep the one native watch', () => {
  it('TIMEOUT after a fix, then a fix: the same watch resumes persistence in the same segment', async () => {
    const f = await createFixture();
    await expect(f.controller.start()).resolves.toBe(true);
    f.source.latest().measurement(fix(1));
    await f.controller.whenIdle();
    const persistedAt = 1_000;

    f.advanceMonotonic(10_000);
    f.source.latest().interrupted(timeout());
    await f.controller.whenIdle();

    expect(f.latest()).toMatchObject({
      capturedCount: 1,
      consecutiveFailures: 1,
      lastPersistedAtMs: persistedAt,
      lastRecordedAt: fix(1).recordedAt,
      segmentId: 0,
      signal: 'waiting',
      status: 'capturing',
    });

    f.advanceMonotonic(2_000);
    f.source.latest().measurement(fix(13));
    await f.controller.whenIdle();

    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }, { segmentId: 0, seq: '2' }]);
    expect(f.latest()).toMatchObject({
      capturedCount: 2,
      consecutiveFailures: 0,
      lastPersistedAtMs: 13_000,
      signal: 'live',
      status: 'capturing',
      warning: null,
    });
    expect(f.source.start).toHaveBeenCalledOnce();
    expect(f.source.subscriptions[0]?.stop).not.toHaveBeenCalled();
    expect(f.allocate).toHaveBeenCalledOnce();
  });

  it('POSITION_UNAVAILABLE before any fix waits without facts, then the first fix is persisted', async () => {
    const f = await createFixture();
    await f.controller.start();
    expect(f.latest()).toMatchObject({ capturedCount: 0, lastPersistedAtMs: null, signal: 'no-fix', startedAtMs: 1_000 });

    f.source.latest().interrupted(unavailable());
    await f.controller.whenIdle();
    expect(f.latest()).toMatchObject({
      capturedCount: 0,
      consecutiveFailures: 1,
      lastPersistedAtMs: null,
      signal: 'waiting',
      status: 'capturing',
      warning: expect.stringContaining('could not determine') as string,
    });

    f.source.latest().measurement(fix(1));
    await f.controller.whenIdle();

    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
    expect(f.latest()).toMatchObject({ capturedCount: 1, signal: 'live' });
    expect(f.source.active()).toBe(1);
  });

  it('consecutive temporary failures are counted on the same watch and never restart it', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    for (const failure of [timeout(), unavailable(), timeout()]) f.source.latest().interrupted(failure);
    await f.controller.whenIdle();

    expect(f.latest()).toMatchObject({ consecutiveFailures: 3, segmentId: 0, signal: 'waiting', status: 'capturing' });
    expect(f.source.start).toHaveBeenCalledOnce();
    expect(f.source.active()).toBe(1);
    expect(f.allocate).toHaveBeenCalledOnce();

    f.source.latest().measurement(fix(40));
    await f.controller.whenIdle();
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }, { segmentId: 0, seq: '2' }]);
    expect(f.latest()).toMatchObject({ consecutiveFailures: 0, signal: 'live' });
  });

  it('applies callbacks in the order the watch delivered them: a TIMEOUT after a fix still being persisted wins', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    f.source.latest().interrupted(timeout());
    await f.controller.whenIdle();

    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
    expect(f.latest()).toMatchObject({ capturedCount: 1, signal: 'waiting' });
  });

  it('never fabricates a point while waiting: only genuine fixes reach storage', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    for (let index = 0; index < 5; index += 1) {
      f.advanceMonotonic(10_000);
      f.source.latest().interrupted(timeout());
    }
    await f.controller.whenIdle();

    expect(f.append).toHaveBeenCalledOnce();
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
  });
});

describe('terminal failures stop the watch and stay stopped', () => {
  it('a permission denial stops the watch once, ignores its late callbacks and starts no other attempt', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    await f.controller.whenIdle();

    const old = f.source.latest();
    old.error(denied());
    await f.controller.whenIdle();
    expect(f.latest()).toMatchObject({
      capturedCount: 1,
      lastPersistedAtMs: 1_000,
      reason: 'permission-denied',
      status: 'error',
    });
    const statesAfterDenial = f.states.length;

    old.measurement(fix(2));
    old.interrupted(timeout());
    await f.controller.whenIdle();

    expect(f.source.subscriptions[0]?.stop).toHaveBeenCalledOnce();
    expect(f.source.start).toHaveBeenCalledOnce();
    expect(f.states).toHaveLength(statesAfterDenial);
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
  });

  it('a storage failure is terminal, keeps the buffered points and refuses a GPS retry', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    await f.controller.whenIdle();
    f.append.mockRejectedValueOnce(new Error('QuotaExceededError'));

    f.source.latest().measurement(fix(2));
    await f.controller.whenIdle();

    expect(f.latest()).toMatchObject({ message: 'QuotaExceededError', reason: 'storage', status: 'error' });
    expect(f.source.active()).toBe(0);
    await expect(f.controller.retry()).resolves.toBe(false);
    f.source.sinkAt(0).measurement(fix(3));
    await f.controller.whenIdle();
    expect(f.source.start).toHaveBeenCalledOnce();
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
  });

  it('a queue overflow is terminal and refuses a GPS retry', async () => {
    const f = await createFixture();
    await f.controller.start();
    for (let index = 0; index < 101; index += 1) f.source.latest().measurement(fix(index));

    expect(f.latest()).toMatchObject({ reason: 'overflow', status: 'error' });
    expect(f.source.active()).toBe(0);
    await expect(f.controller.retry()).resolves.toBe(false);
    await f.controller.whenIdle();
    expect(f.source.start).toHaveBeenCalledOnce();
  });

  it('a browser without geolocation is reported as unsupported and refuses a retry', async () => {
    const f = await createFixture({ failStart: () => new LocationFailure('unsupported') });
    await expect(f.controller.start()).resolves.toBe(false);

    expect(f.latest()).toMatchObject({ reason: 'unsupported', status: 'error' });
    await expect(f.controller.retry()).resolves.toBe(false);
    expect(f.source.start).toHaveBeenCalledOnce();
  });

  it('an arbitrary source exception is a terminal source failure, never a temporary one', async () => {
    const f = await createFixture();
    await f.controller.start();

    f.source.latest().error(new TypeError('Illegal invocation'));
    await f.controller.whenIdle();

    expect(f.latest()).toMatchObject({ reason: 'source', status: 'error' });
    expect(f.source.active()).toBe(0);
    await expect(f.controller.retry()).resolves.toBe(false);
  });

  it('a writer takeover while waiting for a fix stops capture as lost and appends nothing', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    f.source.latest().interrupted(timeout());
    await f.controller.whenIdle();

    await f.takeOver();
    f.source.latest().measurement(fix(30));
    await f.controller.whenIdle();

    expect(f.latest()).toMatchObject({ status: 'lost' });
    expect(f.source.active()).toBe(0);
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
    await expect(f.controller.retry()).resolves.toBe(false);
    expect(f.source.start).toHaveBeenCalledOnce();
  });

  it('starts no timer of its own, so a denied watch is never retried automatically', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    const source = scriptedSource();
    const controller = new CaptureController({
      assertOwnedLease: () => Promise.resolve({ expiresAt: startedAt, fencingToken: '1', ownerId: ownerA, userId }),
      now: () => 0,
      onPoint: vi.fn(),
      onState: vi.fn(),
      scope,
      source: source.source,
      storage: { allocateCaptureSegment: vi.fn(() => Promise.resolve(0)), appendPointForWriter: vi.fn() },
    });
    await controller.start();
    source.latest().interrupted(timeout());
    source.latest().error(denied());
    await controller.whenIdle();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(source.start).toHaveBeenCalledOnce();
    expect(source.active()).toBe(0);
  });
});

describe('an explicit GPS retry', () => {
  it('after a denial re-proves the writer, allocates the next durable segment and continues seq', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    await f.controller.whenIdle();
    f.source.latest().error(denied());
    await f.controller.whenIdle();
    const proofsBefore = f.assertOwnedLease.mock.calls.length;

    await expect(f.controller.retry()).resolves.toBe(true);
    expect(f.assertOwnedLease.mock.calls.length).toBe(proofsBefore + 1);
    expect(f.latest()).toMatchObject({
      capturedCount: 1,
      lastPersistedAtMs: 1_000,
      segmentId: 1,
      signal: 'no-fix',
      status: 'capturing',
    });
    f.source.latest().measurement(fix(20));
    await f.controller.whenIdle();

    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }, { segmentId: 1, seq: '2' }]);
    expect(f.allocate).toHaveBeenCalledTimes(2);
    expect(f.source.active()).toBe(1);
    expect(f.latest()).toMatchObject({ capturedCount: 2, segmentId: 1, signal: 'live' });
  });

  it('on a live but silent watch stops the old watch before the new one starts and ignores its late callbacks', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    f.source.latest().interrupted(timeout());
    await f.controller.whenIdle();
    const old = f.source.sinkAt(0);

    await expect(f.controller.retry()).resolves.toBe(true);
    expect(f.source.log).toEqual(['start 0', 'stop 0', 'start 1']);
    const statesAfterRetry = f.states.length;

    old.measurement(fix(2));
    old.interrupted(timeout());
    old.error(denied());
    await f.controller.whenIdle();
    expect(f.states).toHaveLength(statesAfterRetry);
    expect(f.source.active()).toBe(1);

    f.source.latest().measurement(fix(3));
    await f.controller.whenIdle();
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }, { segmentId: 1, seq: '2' }]);
  });

  it('rapid repeated retries start exactly one new watch', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().error(denied());

    const results = await Promise.all([f.controller.retry(), f.controller.retry(), f.controller.retry()]);

    expect(results).toEqual([true, false, false]);
    expect(f.source.start).toHaveBeenCalledTimes(2);
    expect(f.allocate).toHaveBeenCalledTimes(2);
    expect(f.source.active()).toBe(1);
  });

  it('is refused once the controller was stopped by pause, finish or a replaced session', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().measurement(fix(1));
    await f.controller.whenIdle();
    f.source.latest().interrupted(timeout());
    const old = f.source.latest();

    f.controller.stop();
    await expect(f.controller.retry()).resolves.toBe(false);
    await expect(f.controller.start()).resolves.toBe(false);
    old.measurement(fix(2));
    await f.controller.whenIdle();

    expect(f.latest()).toEqual({ status: 'idle' });
    expect(f.source.start).toHaveBeenCalledOnce();
    expect(f.allocate).toHaveBeenCalledOnce();
    await expect(f.durable()).resolves.toEqual([{ segmentId: 0, seq: '1' }]);
  });

  it('stopped while its writer proof is in flight never subscribes', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().error(denied());

    const retried = f.controller.retry();
    f.controller.stop();

    await expect(retried).resolves.toBe(false);
    expect(f.source.start).toHaveBeenCalledOnce();
    expect(f.source.active()).toBe(0);
    expect(f.latest()).toEqual({ status: 'idle' });
  });

  it('after another tab took the writer over reports lost and subscribes nothing', async () => {
    const f = await createFixture();
    await f.controller.start();
    f.source.latest().error(denied());
    await f.takeOver();

    await expect(f.controller.retry()).resolves.toBe(false);

    expect(f.latest()).toMatchObject({ status: 'lost' });
    expect(f.source.start).toHaveBeenCalledOnce();
    expect(f.allocate).toHaveBeenCalledOnce();
  });
});
