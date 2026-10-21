import type { RunCommandResponse, RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { RunnerApiError } from './runner-api.js';
import { executeRunnerRequest, performRunnerRequest, type RunnerRequestPage } from './runner-requests.js';
import type { CommandRequest, RunnerRequest, StartRequest } from './runner-state.js';
import { IndexedDbRunnerStorage, type PointMeasurement, type WriterLease } from './runner-storage.js';
import { detachActiveRunForTest } from './runner-storage-test-support.js';

// ADR-0059: a lifecycle request (queue, dispatch, acknowledge, reconcile) belongs to the writer capability it began
// with: the user, the owner and the fencing epoch, and the session. Two storage instances share one IDBFactory and
// one injected clock, as two tabs share the browser's IndexedDB; every interleaving is forced with deferred promises,
// never with a sleep, and what is asserted is what the stores hold afterwards. This is fake-indexeddb, not a browser:
// the browser regression is tests/e2e/lifecycle-takeover.spec.ts.

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ownerA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ownerB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const startedAt = '2026-10-08T08:00:00.000Z';
const DURATION_MS = 15_000;
const stores = ['leases', 'points', 'profiles', 'requests', 'runs'] as const;
const csrf = { headerName: 'x-csrf-token', token: 't' } as const;
const writerLost = { outcome: 'obsolete', reason: 'writer-lost' } as const;
const applied = { outcome: 'applied' } as const;

function run(runId: string, status: RunView['status'], controlRevision: number, dataRevision: number): RunView {
  return {
    controlRevision: String(controlRevision),
    dataRevision: String(dataRevision),
    finishedAt: status === 'finished' ? '2026-10-08T09:00:00.000Z' : null,
    rawState: 'available',
    runId,
    startedAt,
    status,
    summary: null,
  };
}

const startOf = (runId: string): StartRequest => ({ kind: 'start', orgId, runId, startedAt });
const commandOf = (type: CommandRequest['type'], expected = 3, runId = runA): CommandRequest => ({
  commandId: crypto.randomUUID(), expectedControlRevision: String(expected), kind: 'command', orgId, runId, type,
});
const resultOf = (command: CommandRequest, status: RunCommandResponse['status'], controlRevision: number, dataRevision: number): RunCommandResponse => ({
  commandId: command.commandId,
  controlRevision: String(controlRevision),
  dataRevision: String(dataRevision),
  finishedAt: status === 'finished' ? '2026-10-08T09:00:00.000Z' : null,
  status,
});
const measurement: PointMeasurement = { accuracyM: 4, latitude: 52.2, longitude: 21, recordedAt: startedAt, segmentId: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

function createFixture() {
  const factory = new IDBFactory();
  const databaseName = crypto.randomUUID();
  let nowMs = Date.parse('2026-10-08T08:00:00.000Z');
  const now = () => new Date(nowMs);
  const open = () => new IndexedDbRunnerStorage({ databaseName, factory, keyRange: IDBKeyRange, now });
  // Every record of every store, read through an independent connection: the durable truth.
  const dump = async (): Promise<Record<string, unknown[]>> => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      const result: Record<string, unknown[]> = {};
      for (const name of stores) {
        result[name] = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction(name, 'readonly').objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        });
      }
      return result;
    } finally {
      database.close();
    }
  };
  const fixture = {
    advance: (ms: number) => { nowMs += ms; },
    // The pointer moved off the active run, as another epoch can leave it (test setup, unfenced).
    detach: () => detachActiveRunForTest(factory, databaseName, userId),
    dump,
    open,
    tabA: open(),
    tabB: open(),
    // Tab A's lease runs out and tab B acquires the next fencing epoch.
    takeOver: async () => {
      fixture.advance(DURATION_MS + 1);
      return acquire(fixture.tabB, ownerB);
    },
  };
  return fixture;
}

async function acquire(storage: IndexedDbRunnerStorage, owner: string): Promise<WriterLease> {
  const result = await storage.acquireWriterLease(userId, owner, DURATION_MS);
  if (!result.acquired) throw new Error('Expected to acquire the lease');
  return result.lease;
}

// A run the profile points at, with one buffered point.
async function withActiveRun(f: ReturnType<typeof createFixture>, snapshot = run(runA, 'recording', 3, 5)) {
  await f.tabA.activateRunSnapshot(userId, orgId, snapshot);
  await f.tabA.appendPoint({ orgId, runId: snapshot.runId, userId }, measurement);
}

// A server that records every mutation it is asked for, in order.
interface ServerScript {
  createRun?: (request: StartRequest) => Promise<RunView>;
  readRun?: () => Promise<RunView>;
  sendRunCommand?: (request: CommandRequest) => Promise<RunCommandResponse>;
}

function server(script: ServerScript = {}) {
  const mutations: string[] = [];
  return {
    api: {
      createRun: (input: unknown) => {
        mutations.push(`start:${(input as StartRequest).runId}:${(input as StartRequest).startedAt}`);
        return script.createRun?.(input as StartRequest) ?? Promise.reject(new Error('unexpected start'));
      },
      readRun: () => script.readRun?.() ?? Promise.reject(new Error('unexpected read')),
      sendRunCommand: (input: unknown) => {
        const command = input as CommandRequest;
        mutations.push(`command:${command.commandId}:${command.type}:${command.expectedControlRevision}`);
        return script.sendRunCommand?.(command) ?? Promise.reject(new Error('unexpected command'));
      },
    },
    mutations,
  };
}

interface ExecuteOptions {
  online?: boolean;
  revalidate?: () => Promise<WriterLease | null>;
  signal?: AbortSignal;
}

// One tab's request: the capability it began with, and what the tab can prove about its writer lease right now (a
// renewal of exactly that lease, as the coordinator does).
function execute(
  storage: IndexedDbRunnerStorage,
  lease: WriterLease,
  request: RunnerRequest,
  snapshot: RunView | null,
  api: ReturnType<typeof server>['api'],
  options: ExecuteOptions = {},
) {
  const revalidate = options.revalidate ?? (() => storage.renewWriterLease(lease, DURATION_MS));
  return executeRunnerRequest({
    api,
    csrf,
    lease,
    online: options.online ?? true,
    request,
    revalidate,
    run: snapshot,
    signal: options.signal ?? new AbortController().signal,
    storage,
    userId,
  });
}

describe('lifecycle request writes check the writer capability inside their own transaction', () => {
  it('a Start queued with a capability taken over between the ownership check and the write writes nothing', async () => {
    const f = createFixture();
    const leaseA = await acquire(f.tabA, ownerA);
    // Tab A has passed its ownership check; tab B takes over before A's transaction opens.
    await f.takeOver();
    const before = await f.dump();

    await expect(f.tabA.queueRequest(userId, startOf(runA), null, leaseA)).resolves.toEqual(writerLost);

    expect(await f.dump()).toEqual(before);
  });

  it('a stale tab cannot overwrite the new owner\'s queued command or its snapshot', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const leaseA = await acquire(f.tabA, ownerA);
    const leaseB = await f.takeOver();
    const ownersPause = commandOf('pause');
    await expect(f.tabB.queueRequest(userId, ownersPause, run(runA, 'recording', 3, 5), leaseB)).resolves.toEqual(applied);
    const before = await f.dump();

    // Another command, and the new owner's own command identity with another payload, from the old epoch.
    await expect(f.tabA.queueRequest(userId, commandOf('finish'), run(runA, 'recording', 3, 4), leaseA)).resolves.toEqual(writerLost);
    await expect(f.tabA.queueRequest(userId, { ...ownersPause, type: 'finish' }, run(runA, 'recording', 3, 5), leaseA)).resolves.toEqual(writerLost);

    expect(await f.dump()).toEqual(before);
    await expect(f.tabB.loadRecovery(userId)).resolves.toMatchObject({ request: ownersPause, run: { runId: runA } });
  });

  it('the same owner under a newer fencing token makes the earlier capability obsolete', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const first = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    await expect(f.tabA.queueRequest(userId, pause, run(runA, 'recording', 3, 5), first)).resolves.toEqual(applied);
    f.advance(DURATION_MS + 1);
    const second = await acquire(f.tabA, ownerA);
    expect(second.ownerId).toBe(first.ownerId);
    expect(BigInt(second.fencingToken)).toBeGreaterThan(BigInt(first.fencingToken));
    const before = await f.dump();

    await expect(f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), first)).resolves.toEqual(writerLost);
    await expect(f.tabA.acknowledgeReconciledRequest(userId, pause, run(runA, 'paused', 4, 5), first)).resolves.toEqual(writerLost);
    await expect(f.tabA.queueRequest(userId, commandOf('finish'), run(runA, 'recording', 3, 5), first)).resolves.toEqual(writerLost);
    expect(await f.dump()).toEqual(before);

    // The same exact request is acknowledged under the epoch that holds the lease now.
    await expect(f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), second)).resolves.toEqual(applied);
    await expect(f.tabA.loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { controlRevision: '4', status: 'paused' } });
  });

  it('A\'s late Pause acknowledgement cannot restore the old pointer after B acknowledged it and moved to another run', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const leaseA = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    await f.tabA.queueRequest(userId, pause, run(runA, 'recording', 3, 5), leaseA);
    // A has received its Pause response and passed its external ownership check. Before its acknowledgement
    // transaction opens, its lease expires and B takes over, acknowledges the same idempotent command and moves on.
    const leaseB = await f.takeOver();
    await expect(f.tabB.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), leaseB)).resolves.toEqual(applied);
    await f.detach();
    await expect(f.tabB.queueRequest(userId, startOf(runB), null, leaseB)).resolves.toEqual(applied);
    await expect(f.tabB.acknowledgeStart(userId, startOf(runB), run(runB, 'recording', 0, 0), leaseB)).resolves.toEqual(applied);
    const before = await f.dump();

    await expect(f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), leaseA)).resolves.toEqual(writerLost);
    await expect(f.tabA.acknowledgeReconciledRequest(userId, pause, run(runA, 'paused', 4, 5), leaseA)).resolves.toEqual(writerLost);

    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ orgId, request: null, run: { runId: runB, status: 'recording' } });
  });

  it('an acknowledgement must find exactly the queued request: an acknowledged one or another payload is superseded', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const lease = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    await f.tabA.queueRequest(userId, pause, run(runA, 'recording', 3, 5), lease);
    let before = await f.dump();

    const otherPayload = { ...pause, expectedControlRevision: '2' };
    await expect(f.tabA.acknowledgeCommand(userId, otherPayload, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'superseded' });
    await expect(f.tabA.acknowledgeReconciledRequest(userId, { ...pause, type: 'finish' }, run(runA, 'finished', 3, 5), lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'superseded' });
    expect(await f.dump()).toEqual(before);

    await expect(f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), lease)).resolves.toEqual(applied);
    before = await f.dump();
    await expect(f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'superseded' });
    expect(await f.dump()).toEqual(before);
  });

  it('a command for a run that is no longer active is neither queued nor acknowledged, and the queued one stays', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const lease = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    await f.tabA.queueRequest(userId, pause, run(runA, 'recording', 3, 5), lease);
    // The same writer has since cleared run A and started run B.
    await f.detach();
    await f.tabA.activateRunSnapshot(userId, orgId, run(runB, 'recording', 0, 0));
    const before = await f.dump();

    await expect(f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 5), resultOf(pause, 'paused', 4, 5), lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    await expect(f.tabA.acknowledgeReconciledRequest(userId, pause, run(runA, 'paused', 4, 5), lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    await expect(f.tabA.queueRequest(userId, commandOf('finish'), run(runA, 'recording', 3, 5), lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    expect(await f.dump()).toEqual(before);
  });

  it('an initial Start needs no active run, and a Start while another run is active writes nothing', async () => {
    const f = createFixture();
    const lease = await acquire(f.tabA, ownerA);
    await expect(f.tabA.queueRequest(userId, startOf(runA), null, lease)).resolves.toEqual(applied);
    await expect(f.tabA.loadRecovery(userId)).resolves.toMatchObject({ request: startOf(runA), run: null });
    // Queued for a later Start; meanwhile run A becomes active.
    await expect(f.tabA.queueRequest(userId, { ...startOf(runB), startedAt: '2026-10-08T08:05:00.000Z' }, null, lease)).resolves.toEqual(applied);
    await expect(f.tabA.acknowledgeStart(userId, startOf(runA), run(runA, 'recording', 0, 0), lease)).resolves.toEqual(applied);
    await expect(f.tabA.loadRecovery(userId)).resolves.toMatchObject({ orgId, run: { runId: runA } });
    const before = await f.dump();

    await expect(f.tabA.queueRequest(userId, startOf(crypto.randomUUID()), null, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    await expect(f.tabA.acknowledgeStart(userId, { ...startOf(runB), startedAt: '2026-10-08T08:05:00.000Z' }, { ...run(runB, 'recording', 0, 0), startedAt: '2026-10-08T08:05:00.000Z' }, lease))
      .resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    expect(await f.dump()).toEqual(before);
  });

  it('acknowledgement and reconciliation merge the control and data revisions independently', async () => {
    const f = createFixture();
    await withActiveRun(f, run(runA, 'recording', 3, 7));
    const lease = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    await f.tabA.queueRequest(userId, pause, run(runA, 'recording', 3, 7), lease);
    // The command answer carries an older data revision than the uploads already acknowledged.
    await f.tabA.acknowledgeCommand(userId, pause, run(runA, 'recording', 3, 7), resultOf(pause, 'paused', 4, 5), lease);
    await expect(f.tabA.loadRecovery(userId)).resolves.toMatchObject({ run: { controlRevision: '4', dataRevision: '7', status: 'paused' } });

    const finish = commandOf('finish', 4);
    await f.tabA.queueRequest(userId, finish, run(runA, 'paused', 4, 7), lease);
    await f.tabA.acknowledgeReconciledRequest(userId, finish, run(runA, 'finished', 4, 6), lease);
    await expect(f.tabA.loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { controlRevision: '4', dataRevision: '7', status: 'finished' } });
  });

  it('losing ownership keeps the buffered points, the pending request and the rejection marker', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const leaseA = await acquire(f.tabA, ownerA);
    await f.tabA.rejectUpload({ orgId, runId: runA, userId }, 'RUN_POINT_LIMIT', leaseA);
    const finish = commandOf('finish');
    await f.tabA.queueRequest(userId, finish, run(runA, 'recording', 3, 5), leaseA);
    await f.takeOver();
    const before = await f.dump();

    await expect(f.tabA.queueRequest(userId, commandOf('pause'), run(runA, 'recording', 3, 5), leaseA)).resolves.toEqual(writerLost);
    await expect(f.tabA.acknowledgeCommand(userId, finish, run(runA, 'recording', 3, 5), resultOf(finish, 'finished', 4, 5), leaseA)).resolves.toEqual(writerLost);
    await expect(f.tabA.acknowledgeReconciledRequest(userId, finish, run(runA, 'finished', 3, 6), leaseA)).resolves.toEqual(writerLost);

    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({
      pendingPointCount: 1, request: finish, run: { runId: runA, status: 'recording' }, uploadRejection: 'RUN_POINT_LIMIT',
    });
  });
});

describe('executeRunnerRequest sends a mutation only for the capability it began with', () => {
  const cases = [
    ['Start', () => Promise.resolve({ f: createFixture(), request: startOf(runA), snapshot: null })],
    ['Pause', async () => {
      const f = createFixture();
      await withActiveRun(f);
      return { f, request: commandOf('pause') as RunnerRequest, snapshot: run(runA, 'recording', 3, 5) as RunView | null };
    }],
  ] as const;

  it.each(cases)('%s: ownership lost before dispatch sends no mutation and keeps the exact request queued', async (_name, setup) => {
    const { f, request, snapshot } = await setup();
    const lease = await acquire(f.tabA, ownerA);
    const { api, mutations } = server();

    const outcome = await execute(f.tabA, lease, request, snapshot, api, { revalidate: () => Promise.resolve(null) });

    expect(outcome).toEqual({ kind: 'obsolete', reason: 'writer-lost' });
    expect(mutations).toEqual([]);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request });
  });

  it.each(cases)('%s: the same owner under a newer fencing token before dispatch sends no mutation', async (_name, setup) => {
    const { f, request, snapshot } = await setup();
    const first = await acquire(f.tabA, ownerA);
    const { api, mutations } = server();

    // The queue write succeeds under the first epoch; before the send the lease lapses and the same owner reacquires.
    const outcome = await execute(f.tabA, first, request, snapshot, api, {
      revalidate: async () => { f.advance(DURATION_MS + 1); return acquire(f.tabA, ownerA); },
    });

    expect(outcome).toEqual({ kind: 'obsolete', reason: 'writer-lost' });
    expect(mutations).toEqual([]);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request });
  });

  it.each(cases)('%s: a takeover between the ownership check and the queue write sends nothing and writes nothing', async (_name, setup) => {
    const { f, request, snapshot } = await setup();
    const leaseA = await acquire(f.tabA, ownerA);
    await f.takeOver();
    const before = await f.dump();
    const { api, mutations } = server();

    await expect(execute(f.tabA, leaseA, request, snapshot, api)).resolves.toEqual({ kind: 'obsolete', reason: 'writer-lost' });

    expect(mutations).toEqual([]);
    expect(await f.dump()).toEqual(before);
  });

  it('a late Pause answer after B acknowledged the same command and moved to another run restores nothing', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const leaseA = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    const sent = deferred<void>();
    const answer = deferred<RunCommandResponse>();
    const tabAServer = server({ sendRunCommand: () => { sent.resolve(); return answer.promise; } });
    const pending = execute(f.tabA, leaseA, pause, run(runA, 'recording', 3, 5), tabAServer.api);
    await sent.promise;

    // B takes over, retries the recovered Pause (the server answers it idempotently) and starts another run.
    const leaseB = await f.takeOver();
    const recovered = (await f.tabB.loadRecovery(userId)).request;
    expect(recovered).toEqual(pause);
    const tabBServer = server({
      createRun: () => Promise.resolve(run(runB, 'recording', 0, 0)),
      sendRunCommand: (command) => Promise.resolve(resultOf(command, 'paused', 4, 5)),
    });
    await expect(execute(f.tabB, leaseB, recovered as CommandRequest, run(runA, 'recording', 3, 5), tabBServer.api)).resolves.toMatchObject({ kind: 'command' });
    await f.detach();
    await expect(execute(f.tabB, leaseB, startOf(runB), null, tabBServer.api)).resolves.toMatchObject({ kind: 'start' });
    expect(tabBServer.mutations).toEqual([`command:${pause.commandId}:pause:3`, `start:${runB}:${startedAt}`]);
    const before = await f.dump();

    answer.resolve(resultOf(pause, 'paused', 4, 5));

    await expect(pending).resolves.toEqual({ kind: 'obsolete', reason: 'writer-lost' });
    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { runId: runB, status: 'recording' } });
  });

  it('a revision conflict reconciled after a takeover restores nothing', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const leaseA = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    const reading = deferred<void>();
    const authoritative = deferred<RunView>();
    const tabAServer = server({
      readRun: () => { reading.resolve(); return authoritative.promise; },
      sendRunCommand: () => Promise.reject(new RunnerApiError('Conflict', 409, 'CONTROL_REVISION_CONFLICT', null)),
    });
    const pending = execute(f.tabA, leaseA, pause, run(runA, 'recording', 3, 5), tabAServer.api);
    await reading.promise;

    const leaseB = await f.takeOver();
    await f.tabB.acknowledgeReconciledRequest(userId, pause, run(runA, 'paused', 4, 5), leaseB);
    await f.detach();
    await f.tabB.queueRequest(userId, startOf(runB), null, leaseB);
    await f.tabB.acknowledgeStart(userId, startOf(runB), run(runB, 'recording', 0, 0), leaseB);
    const before = await f.dump();

    authoritative.resolve(run(runA, 'paused', 4, 5));

    await expect(pending).resolves.toEqual({ kind: 'obsolete', reason: 'writer-lost' });
    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ run: { runId: runB } });
  });

  it('a session that ends before the send sends nothing, and one that ends in flight writes no acknowledgement', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const lease = await acquire(f.tabA, ownerA);
    const before = server();
    const ended = new AbortController();
    const first = commandOf('pause');
    await expect(execute(f.tabA, lease, first, run(runA, 'recording', 3, 5), before.api, {
      revalidate: async () => { ended.abort(); return f.tabA.renewWriterLease(lease, DURATION_MS); },
      signal: ended.signal,
    })).resolves.toEqual({ kind: 'obsolete', reason: 'session-ended' });
    expect(before.mutations).toEqual([]);

    const inFlight = new AbortController();
    const answered = server({ sendRunCommand: (command) => { inFlight.abort(); return Promise.resolve(resultOf(command, 'paused', 4, 5)); } });
    await expect(execute(f.tabA, lease, first, run(runA, 'recording', 3, 5), answered.api, { signal: inFlight.signal }))
      .resolves.toEqual({ kind: 'obsolete', reason: 'session-ended' });
    expect(answered.mutations).toHaveLength(1);
    // The exact request is left for the next session or owner to retry.
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request: first, run: { controlRevision: '3', status: 'recording' } });
  });

  it('the writer queues the exact request offline; after a reload the next owner retries the same identity and succeeds', async () => {
    const f = createFixture();
    await withActiveRun(f);
    const leaseA = await acquire(f.tabA, ownerA);
    const offline = server();
    const pause = commandOf('pause');

    await expect(execute(f.tabA, leaseA, pause, run(runA, 'recording', 3, 5), offline.api, { online: false })).rejects.toThrow('Saved locally');
    expect(offline.mutations).toEqual([]);
    await f.tabA.close();

    // A reload: a new page instance, and after the old lease lapsed, another owner epoch.
    const reloaded = f.open();
    const recovery = await reloaded.loadRecovery(userId);
    expect(recovery.request).toEqual(pause);
    f.advance(DURATION_MS + 1);
    const leaseNext = await acquire(reloaded, ownerB);
    const online = server({ sendRunCommand: (command) => Promise.resolve(resultOf(command, 'paused', 4, 5)) });
    await expect(execute(reloaded, leaseNext, recovery.request as CommandRequest, recovery.run, online.api))
      .resolves.toEqual({ kind: 'command', result: resultOf(pause, 'paused', 4, 5) });
    expect(online.mutations).toEqual([`command:${pause.commandId}:pause:3`]);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { controlRevision: '4', status: 'paused' } });
  });

  it('a recovered Start keeps its run id and start time through an unknown outcome and the retry', async () => {
    const f = createFixture();
    const lease = await acquire(f.tabA, ownerA);
    const start = startOf(runA);
    const failing = server({ createRun: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(execute(f.tabA, lease, start, null, failing.api)).rejects.toThrow('Failed to fetch');
    const recovered = (await f.open().loadRecovery(userId)).request;
    expect(recovered).toEqual(start);

    const answering = server({ createRun: () => Promise.resolve(run(runA, 'recording', 0, 0)) });
    await expect(execute(f.tabA, lease, recovered as StartRequest, null, answering.api)).resolves.toMatchObject({ kind: 'start' });
    expect([...failing.mutations, ...answering.mutations]).toEqual([`start:${runA}:${startedAt}`, `start:${runA}:${startedAt}`]);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { runId: runA } });
  });
});

describe('performRunnerRequest reports a completion only to the page and writer epoch it began in', () => {
  async function inFlightPause() {
    const f = createFixture();
    await withActiveRun(f);
    const lease = await acquire(f.tabA, ownerA);
    const pause = commandOf('pause');
    const sent = deferred<void>();
    const answer = deferred<RunCommandResponse>();
    const { api } = server({ sendRunCommand: () => { sent.resolve(); return answer.promise; } });
    const state = { current: true, lease: lease as WriterLease | null };
    const page: RunnerRequestPage = { current: () => state.current, lease: () => state.lease };
    const dispatch = vi.fn();
    const onFollow = vi.fn();
    const onRefused = vi.fn();
    const session = new AbortController();
    const storage = {
      acknowledgeCommand: f.tabA.acknowledgeCommand.bind(f.tabA),
      acknowledgeReconciledRequest: f.tabA.acknowledgeReconciledRequest.bind(f.tabA),
      acknowledgeStart: f.tabA.acknowledgeStart.bind(f.tabA),
      loadRecovery: f.tabA.loadRecovery.bind(f.tabA),
      queueRequest: f.tabA.queueRequest.bind(f.tabA),
    };
    const settle = () => performRunnerRequest({
      api,
      csrf,
      describe: (error) => (error instanceof Error ? error.message : 'failed'),
      dispatch,
      lease,
      onFollow,
      onRefused,
      online: true,
      page,
      request: pause,
      revalidate: () => f.tabA.renewWriterLease(lease, DURATION_MS),
      run: run(runA, 'recording', 3, 5),
      signal: session.signal,
      storage,
      userId,
    });
    return { answer, dispatch, f, lease, onFollow, onRefused, pause, sent, session, settle, state, storage };
  }

  it('reports the answer to the page that is still current', async () => {
    const t = await inFlightPause();
    const settled = t.settle();
    await t.sent.promise;
    t.answer.resolve(resultOf(t.pause, 'paused', 4, 5));
    await expect(settled).resolves.toEqual({ kind: 'reported' });
    expect(t.dispatch.mock.calls).toEqual([[{ request: t.pause, result: resultOf(t.pause, 'paused', 4, 5), type: 'command-succeeded' }]]);
  });

  it.each([
    ['a success', (t: Awaited<ReturnType<typeof inFlightPause>>) => t.answer.resolve(resultOf(t.pause, 'paused', 4, 5))],
    ['a refusal', (t: Awaited<ReturnType<typeof inFlightPause>>) => t.answer.reject(new RunnerApiError('Gone', 410, 'RUN_DELETED', null))],
  ])('a session replaced while the request is in flight receives nothing from %s', async (_name, deliver) => {
    const t = await inFlightPause();
    const settled = t.settle();
    await t.sent.promise;
    t.state.current = false;
    deliver(t);
    await expect(settled).resolves.toEqual({ kind: 'detached' });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.onRefused).not.toHaveBeenCalled();
    expect(t.onFollow).not.toHaveBeenCalled();
  });

  it('an aborted session receives no late failure', async () => {
    const t = await inFlightPause();
    const settled = t.settle();
    await t.sent.promise;
    t.session.abort();
    t.answer.reject(new DOMException('The operation was aborted', 'AbortError'));
    await expect(settled).resolves.toEqual({ kind: 'detached' });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('a newer writer epoch receives no success: the request is released and the durable state followed', async () => {
    const t = await inFlightPause();
    const settled = t.settle();
    await t.sent.promise;
    // The same owner lost the lease and took it again under a newer fencing token while the answer was on its way.
    t.f.advance(DURATION_MS + 1);
    t.state.lease = await acquire(t.f.tabA, ownerA);
    t.answer.resolve(resultOf(t.pause, 'paused', 4, 5));

    await expect(settled).resolves.toEqual({ kind: 'obsolete', reason: 'writer-lost' });
    const restored = { pendingPointCount: 1, request: t.pause, run: run(runA, 'recording', 3, 5), uploadRejection: null };
    expect(t.dispatch.mock.calls).toEqual([[{ recovery: restored, request: t.pause, type: 'request-obsolete' }]]);
    expect(t.onFollow).toHaveBeenCalledWith(expect.objectContaining({ orgId, request: t.pause }));
    // Nothing was acknowledged for the old epoch: the exact Pause is still there for the new one to retry.
    await expect(t.f.open().loadRecovery(userId)).resolves.toMatchObject({ request: t.pause, run: { controlRevision: '3', status: 'recording' } });
  });

  it('a refusal that arrives after another tab took over is not reported and opens no recovery', async () => {
    const t = await inFlightPause();
    const settled = t.settle();
    await t.sent.promise;
    await t.f.takeOver();
    t.state.lease = null;
    t.answer.reject(new RunnerApiError('Gone', 410, 'RUN_DELETED', null));

    await expect(settled).resolves.toEqual({ kind: 'obsolete', reason: 'writer-lost' });
    expect(t.dispatch.mock.calls.map(([event]) => (event as { type: string }).type)).toEqual(['request-obsolete']);
    expect(t.onRefused).not.toHaveBeenCalled();
  });

  it('a page that changes while the acknowledgement is being written receives nothing', async () => {
    const t = await inFlightPause();
    const write = t.storage.acknowledgeCommand;
    t.storage.acknowledgeCommand = async (...input) => {
      const outcome = await write(...input);
      t.state.current = false;
      return outcome;
    };
    const settled = t.settle();
    await t.sent.promise;
    t.answer.resolve(resultOf(t.pause, 'paused', 4, 5));
    await expect(settled).resolves.toEqual({ kind: 'detached' });
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});
