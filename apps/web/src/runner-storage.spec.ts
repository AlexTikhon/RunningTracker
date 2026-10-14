import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { IndexedDbRunnerStorage, type PointMeasurement } from './runner-storage.js';
import type { CommandRequest, StartRequest } from './runner-state.js';

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope = { orgId, runId, userId };
const measurement: PointMeasurement = {
  accuracyM: 4.5,
  latitude: 52.2297,
  longitude: 21.0122,
  recordedAt: '2026-09-26T08:00:00.000Z',
  segmentId: 0,
};
const startRequest: StartRequest = {
  kind: 'start',
  orgId,
  runId,
  startedAt: measurement.recordedAt,
};
const recordingRun = {
  controlRevision: '0',
  dataRevision: '0',
  finishedAt: null,
  rawState: 'available' as const,
  runId,
  startedAt: measurement.recordedAt,
  status: 'recording' as const,
  summary: null,
};

function createStorage(factory: IDBFactory, databaseName: string) {
  return new IndexedDbRunnerStorage({
    databaseName,
    factory,
    keyRange: IDBKeyRange,
    now: () => new Date('2026-09-26T08:00:01.000Z'),
  });
}

describe('IndexedDbRunnerStorage', () => {
  it.each(['pause', 'finish'] as const)('recovers %s after interleaved upload and lifecycle acknowledgements', async (type) => {
    for (const uploadFirst of [true, false]) {
      const factory = new IDBFactory();
      const databaseName = crypto.randomUUID();
      const storage = createStorage(factory, databaseName);
      await storage.acknowledgeStart(userId, startRequest, recordingRun);
      const request: CommandRequest = { ...scope, kind: 'command', commandId: crypto.randomUUID(), expectedControlRevision: '0', type };
      await storage.queueRequest(userId, request, recordingRun);
      await storage.appendPoint(scope, measurement);
      if (uploadFirst) await storage.acknowledgePointBatch(scope, ['1'], '2');
      await storage.acknowledgeCommand(userId, request, recordingRun, { commandId: request.commandId, controlRevision: '1', dataRevision: '1', status: type === 'pause' ? 'paused' : 'finished', finishedAt: type === 'finish' ? '2026-09-26T08:01:00.000Z' : null });
      if (!uploadFirst) await storage.acknowledgePointBatch(scope, ['1'], '2');
      await storage.activateRunSnapshot(userId, orgId, { ...recordingRun, dataRevision: '3' });
      await storage.close();
      const reopened = createStorage(factory, databaseName);
      await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ request: null, pendingPointCount: 0, run: { controlRevision: '1', dataRevision: '3', status: type === 'pause' ? 'paused' : 'finished' } });
      await reopened.close();
    }
  });

  it('keeps an auto-finished run FINISHED when the acknowledgement of an older pause arrives after it, across reload', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const storage = createStorage(factory, databaseName);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    const pause: CommandRequest = { ...scope, kind: 'command', commandId: crypto.randomUUID(), expectedControlRevision: '0', type: 'pause' };
    await storage.queueRequest(userId, pause, recordingRun);
    await storage.appendPoint(scope, measurement);
    // The server paused (control revision 1), then auto-finished: status and data revision change, control revision does not.
    await storage.activateRunSnapshot(userId, orgId, { ...recordingRun, controlRevision: '1', dataRevision: '3', finishedAt: '2026-09-27T08:00:00.000Z', status: 'finished' });
    await storage.acknowledgeCommand(userId, pause, recordingRun, { commandId: pause.commandId, controlRevision: '1', dataRevision: '2', finishedAt: null, status: 'paused' });
    await storage.close();

    const reopened = createStorage(factory, databaseName);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({
      pendingPointCount: 1,
      request: null,
      run: { controlRevision: '1', dataRevision: '3', finishedAt: '2026-09-27T08:00:00.000Z', status: 'finished' },
    });
    await reopened.close();
  });

  it('retains rejected points through reload, fences capture and atomically discards only the settled rejected run', async () => {
    const factory = new IDBFactory();
    const name = crypto.randomUUID();
    const storage = createStorage(factory, name);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);
    const otherScope = { ...scope, runId: crypto.randomUUID() };
    await storage.appendPoint(otherScope, measurement);
    await storage.rejectUpload(scope, 'RUN_POINT_LIMIT', (await storage.acquireWriterLease(userId, crypto.randomUUID(), 15_000)).lease);
    await storage.close();
    const reopened = createStorage(factory, name);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ uploadRejection: 'RUN_POINT_LIMIT', pendingPointCount: 1 });
    await expect(reopened.appendPoint(scope, measurement)).rejects.toThrow('rejected queue');
    const acquisition = await reopened.acquireWriterLease(userId, crypto.randomUUID(), 15_000);
    const lease = acquisition.lease;
    await expect(reopened.discardRejectedRun(scope, lease)).rejects.toThrow('active rejected run');
    await reopened.activateRunSnapshot(userId, orgId, { ...recordingRun, controlRevision: '1', dataRevision: '1', status: 'finished', finishedAt: '2026-09-26T08:01:00.000Z' });
    const request: CommandRequest = { kind: 'command', orgId, runId, commandId: crypto.randomUUID(), expectedControlRevision: '0', type: 'finish' };
    await reopened.queueRequest(userId, request, recordingRun);
    await expect(reopened.exportBufferedPoints(scope)).resolves.toMatchObject([{ seq: '1' }]);
    await expect(reopened.discardRejectedRun(scope, { ...lease, fencingToken: '0' })).rejects.toThrow();
    await expect(reopened.countPoints(scope)).resolves.toBe(1);
    await reopened.discardRejectedRun(scope, lease);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ run: null, request: null, pendingPointCount: 0 });
    await expect(reopened.countPoints(scope)).resolves.toBe(0);
    await expect(reopened.countPoints(otherScope)).resolves.toBe(1);
  });
  it('allocates seq and stores each point atomically across concurrent transactions and reload', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const storage = createStorage(factory, databaseName);

    const points = await Promise.all(
      Array.from({ length: 12 }, (_, index) => storage.appendPoint(scope, {
        ...measurement,
        recordedAt: `2026-09-26T08:00:${index.toString().padStart(2, '0')}.000Z`,
      })),
    );
    expect(points.map((point) => point.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => (index + 1).toString()),
    );
    await storage.close();

    const reopened = createStorage(factory, databaseName);
    await expect(reopened.readPointBatch(scope)).resolves.toEqual(points);
    await expect(
      reopened.appendPoint(scope, { ...measurement, recordedAt: '2026-09-26T08:00:06.000Z' }),
    ).resolves.toMatchObject({ seq: '13' });
  });

  it('does not consume a sequence when canonical point validation fails', async () => {
    const storage = createStorage(new IDBFactory(), crypto.randomUUID());

    await expect(storage.appendPoint(scope, { ...measurement, latitude: 91 })).rejects.toThrow();
    await expect(storage.appendPoint(scope, measurement)).resolves.toMatchObject({ seq: '1' });
  });

  it('removes only explicitly acknowledged point sequences and tolerates a duplicate acknowledgement', async () => {
    const storage = createStorage(new IDBFactory(), crypto.randomUUID());
    await storage.appendPoint(scope, measurement);
    await storage.appendPoint(scope, { ...measurement, recordedAt: '2026-09-26T08:00:02.000Z' });
    await storage.appendPoint(scope, { ...measurement, recordedAt: '2026-09-26T08:00:04.000Z' });

    await storage.acknowledgePointBatch(scope, ['1', '2']);
    await storage.acknowledgePointBatch(scope, ['1', '2']);

    await expect(storage.readPointBatch(scope)).resolves.toEqual([
      expect.objectContaining({ seq: '3' }),
    ]);
  });

  it('records the acknowledged data revision without allowing a late tab to regress it', async () => {
    const storage = createStorage(new IDBFactory(), crypto.randomUUID());
    await storage.queueRequest(userId, startRequest, null);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);
    await storage.appendPoint(scope, { ...measurement, recordedAt: '2026-09-26T08:00:02.000Z' });

    await storage.acknowledgePointBatch(scope, ['1'], '4');
    await storage.acknowledgePointBatch(scope, ['1'], '3');
    await storage.activateRunSnapshot(userId, orgId, recordingRun);

    await expect(storage.countPoints(scope)).resolves.toBe(1);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      pendingPointCount: 1,
      run: { dataRevision: '4' },
    });
  });

  it('keeps a start request through reload until its server acknowledgement is recorded', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const storage = createStorage(factory, databaseName);
    await storage.queueRequest(userId, startRequest, null);
    await storage.close();

    const reopened = createStorage(factory, databaseName);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({
      orgId,
      pendingPointCount: 0,
      request: startRequest,
      run: null,
    });

    await reopened.acknowledgeStart(userId, startRequest, recordingRun);
    await expect(reopened.loadRecovery(userId)).resolves.toEqual({
      uploadRejection: null,
      captureSource: 'geolocation',
      orgId,
      pendingPointCount: 0,
      request: null,
      run: recordingRun,
    });
  });

  it('atomically retains the confirmed run while removing only the acknowledged command', async () => {
    const storage = createStorage(new IDBFactory(), crypto.randomUUID());
    await storage.queueRequest(userId, startRequest, null);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId,
      runId,
      type: 'pause',
    };
    await storage.queueRequest(userId, command, recordingRun);

    await storage.acknowledgeCommand(userId, command, recordingRun, {
      commandId: command.commandId,
      controlRevision: '1',
      dataRevision: '1',
      finishedAt: null,
      status: 'paused',
    });

    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      request: null,
      run: { controlRevision: '1', dataRevision: '1', status: 'paused' },
    });
  });

  it('atomically clears a permanently stale command after authoritative run reconciliation', async () => {
    const storage = createStorage(new IDBFactory(), crypto.randomUUID());
    await storage.queueRequest(userId, startRequest, null);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId,
      runId,
      type: 'finish',
    };
    await storage.queueRequest(userId, command, recordingRun);
    const automaticallyFinished = {
      ...recordingRun,
      dataRevision: '1',
      finishedAt: '2026-09-26T09:00:00.000Z',
      status: 'finished' as const,
    };

    await storage.acknowledgeReconciledRequest(userId, command, automaticallyFinished);

    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      request: null,
      run: automaticallyFinished,
    });
  });

  it('keeps buffered points when the finished run is cleared from the active UI', async () => {
    const storage = createStorage(new IDBFactory(), crypto.randomUUID());
    await storage.queueRequest(userId, startRequest, null);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);

    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      orgId,
      pendingPointCount: 1,
      run: recordingRun,
    });

    await storage.clearActiveRun(userId);

    await expect(storage.loadRecovery(userId)).resolves.toEqual({
      uploadRejection: null,
      captureSource: 'geolocation',
      orgId: null,
      pendingPointCount: 0,
      request: null,
      run: null,
    });
    await expect(storage.readPointBatch(scope)).resolves.toHaveLength(1);
  });

  describe('capture source', () => {
    async function putRawProfile(factory: IDBFactory, databaseName: string, profile: unknown) {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(databaseName);
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('open failed')), { once: true });
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('profiles', 'readwrite');
        transaction.objectStore('profiles').put(profile);
        transaction.addEventListener('complete', () => resolve(), { once: true });
        transaction.addEventListener(
          'error',
          () => reject(transaction.error ?? new Error('profile write failed')),
          { once: true },
        );
      });
      database.close();
    }

    it('defaults to the device GPS when nothing was ever chosen', async () => {
      const storage = createStorage(new IDBFactory(), crypto.randomUUID());

      await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ captureSource: 'geolocation' });
    });

    it('restores the chosen source with the active recording run after the storage is closed and reopened', async () => {
      const factory = new IDBFactory();
      const databaseName = crypto.randomUUID();
      const before = createStorage(factory, databaseName);
      await before.saveCaptureSource(userId, 'simulator');
      await before.queueRequest(userId, startRequest, null);
      await before.acknowledgeStart(userId, startRequest, recordingRun);
      await before.close();

      const after = createStorage(factory, databaseName);
      await expect(after.loadRecovery(userId)).resolves.toMatchObject({
        captureSource: 'simulator',
        run: { runId, status: 'recording' },
      });
    });

    it('keeps the source when later run snapshots rewrite the profile', async () => {
      const storage = createStorage(new IDBFactory(), crypto.randomUUID());
      await storage.queueRequest(userId, startRequest, null);
      await storage.acknowledgeStart(userId, startRequest, recordingRun);
      await storage.saveCaptureSource(userId, 'simulator');

      await storage.activateRunSnapshot(userId, orgId, { ...recordingRun, controlRevision: '1', status: 'paused' });

      await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
        captureSource: 'simulator',
        run: { status: 'paused' },
      });
    });

    it('keeps the choice as a preference, with no active run, after a finished run is cleared', async () => {
      const storage = createStorage(new IDBFactory(), crypto.randomUUID());
      await storage.saveCaptureSource(userId, 'simulator');
      await storage.queueRequest(userId, startRequest, null);
      await storage.acknowledgeStart(userId, startRequest, recordingRun);

      await storage.clearActiveRun(userId);

      await expect(storage.loadRecovery(userId)).resolves.toEqual({
      uploadRejection: null,
        captureSource: 'simulator',
        orgId: null,
        pendingPointCount: 0,
        request: null,
        run: null,
      });
    });

    it('treats a profile written before the field existed as the default', async () => {
      const factory = new IDBFactory();
      const databaseName = crypto.randomUUID();
      const storage = createStorage(factory, databaseName);
      await storage.queueRequest(userId, startRequest, null);
      await storage.acknowledgeStart(userId, startRequest, recordingRun);
      await putRawProfile(factory, databaseName, { activeOrgId: orgId, activeRunId: runId, userId });

      await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
        captureSource: 'geolocation',
        run: { runId },
      });
    });

    it('never lets an unknown stored value reach the caller', async () => {
      const factory = new IDBFactory();
      const databaseName = crypto.randomUUID();
      const storage = createStorage(factory, databaseName);
      await storage.queueRequest(userId, startRequest, null);
      await storage.acknowledgeStart(userId, startRequest, recordingRun);
      await putRawProfile(factory, databaseName, {
        activeOrgId: orgId,
        activeRunId: runId,
        captureSource: 'carrier-pigeon',
        userId,
      });

      await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ captureSource: 'geolocation' });
    });

    it('refuses to store a value that is not a known source', async () => {
      const storage = createStorage(new IDBFactory(), crypto.randomUUID());

      await expect(storage.saveCaptureSource(userId, 'carrier-pigeon' as never)).rejects.toThrow();
      await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ captureSource: 'geolocation' });
    });
  });
});

// A run the server no longer lets this identity read: its local recovery is cleared only on purpose, only by the
// writer, and only for exactly the run that is active (ADR-0052).
describe('discardRefusedRun', () => {
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const otherRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const otherOrgId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const pause: CommandRequest = { ...scope, kind: 'command', commandId: crypto.randomUUID(), expectedControlRevision: '0', type: 'pause' };

  async function refusedRun() {
    const factory = new IDBFactory();
    const name = crypto.randomUUID();
    const storage = createStorage(factory, name);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);
    await storage.appendPoint(scope, measurement);
    await storage.queueRequest(userId, pause, recordingRun);
    const { lease } = await storage.acquireWriterLease(userId, crypto.randomUUID(), 15_000);
    return { factory, lease, name, storage };
  }

  it('removes the exact run: buffered points, its queued requests and the active pointer, in one step', async () => {
    const { storage, lease } = await refusedRun();
    // Neighbours that must survive: another run of the same user, and another user with its own active run.
    const neighbour = { ...scope, runId: otherRunId };
    await storage.appendPoint(neighbour, measurement);
    const stranger = { orgId, runId: otherRunId, userId: otherUserId };
    await storage.acknowledgeStart(otherUserId, { kind: 'start', orgId, runId: otherRunId, startedAt: measurement.recordedAt }, { ...recordingRun, runId: otherRunId });
    await storage.appendPoint(stranger, measurement);
    // The refusal alone changed nothing, and the points can still be exported first.
    await expect(storage.exportBufferedPoints(scope)).resolves.toMatchObject([{ seq: '1' }, { seq: '2' }]);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 2, request: { commandId: pause.commandId }, run: { status: 'recording' } });
    await storage.discardRefusedRun(scope, lease);

    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ orgId: null, pendingPointCount: 0, request: null, run: null });
    await expect(storage.countPoints(scope)).resolves.toBe(0);
    await expect(storage.exportBufferedPoints(scope)).resolves.toEqual([]);
    await expect(storage.countPoints(neighbour)).resolves.toBe(1);
    await expect(storage.loadRecovery(otherUserId)).resolves.toMatchObject({ pendingPointCount: 1, run: { runId: otherRunId } });
  });

  it('does not need a finished run or a rejected upload, which is what the ordinary discard requires', async () => {
    const { storage, lease } = await refusedRun();
    await expect(storage.discardRejectedRun(scope, lease)).rejects.toThrow('active rejected run');
    await expect(storage.countPoints(scope)).resolves.toBe(2);
    await storage.discardRefusedRun(scope, lease);
    await expect(storage.countPoints(scope)).resolves.toBe(0);
  });

  it('lets the next run start: nothing active, nothing queued, the capture source preference kept', async () => {
    const { storage, lease } = await refusedRun();
    await storage.saveCaptureSource(userId, 'simulator');
    await storage.discardRefusedRun(scope, lease);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ captureSource: 'simulator', request: null, run: null });
    const next = { ...startRequest, runId: otherRunId };
    await storage.acknowledgeStart(userId, next, { ...recordingRun, runId: otherRunId });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ orgId, run: { runId: otherRunId } });
  });

  it('keeps the inactive run record so that a sequence number of the discarded run is never issued twice', async () => {
    const { storage, lease } = await refusedRun();
    await storage.discardRefusedRun(scope, lease);
    await expect(storage.appendPoint(scope, measurement)).resolves.toMatchObject({ seq: '3' });
  });

  it('survives a reload: the discarded run is not restored', async () => {
    const { factory, name, storage, lease } = await refusedRun();
    await storage.discardRefusedRun(scope, lease);
    await storage.close();
    const reopened = createStorage(factory, name);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 0, request: null, run: null });
  });

  it('a lease that is not the current one cannot discard, and nothing changes', async () => {
    const { storage, lease } = await refusedRun();
    for (const stale of [
      { ...lease, fencingToken: '0' },
      { ...lease, ownerId: crypto.randomUUID() },
    ]) {
      await expect(storage.discardRefusedRun(scope, stale)).rejects.toThrow('no longer owns the writer lease');
    }
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 2, request: { commandId: pause.commandId }, run: { runId } });
  });

  it('a tab that lost the lease to another tab cannot delete what the new owner recovers, while the new owner can', async () => {
    const { storage, lease: tabA } = await refusedRun();
    // Tab B proves tab A is gone (writer-presence) and takes the live lease over, under a new fencing token.
    const tabB = (await storage.acquireWriterLease(userId, crypto.randomUUID(), 15_000, [tabA.ownerId])).lease;
    expect(tabB.fencingToken).not.toBe(tabA.fencingToken);

    await expect(storage.discardRefusedRun(scope, tabA)).rejects.toThrow('no longer owns the writer lease');
    await expect(storage.countPoints(scope)).resolves.toBe(2);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ run: { runId } });

    await storage.discardRefusedRun(scope, tabB);
    await expect(storage.countPoints(scope)).resolves.toBe(0);
  });

  it('an expired lease cannot discard', async () => {
    const factory = new IDBFactory();
    const name = crypto.randomUUID();
    let now = new Date('2026-09-26T08:00:01.000Z');
    const storage = new IndexedDbRunnerStorage({ databaseName: name, factory, keyRange: IDBKeyRange, now: () => now });
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);
    const { lease } = await storage.acquireWriterLease(userId, crypto.randomUUID(), 1_000);
    now = new Date('2026-09-26T08:00:03.000Z');
    await expect(storage.discardRefusedRun(scope, lease)).rejects.toThrow('no longer owns the writer lease');
    await expect(storage.countPoints(scope)).resolves.toBe(1);
  });

  it.each([
    ['another run', { runId: otherRunId }],
    ['another organization', { orgId: otherOrgId }],
  ])('a stale scope for %s is rejected and the active run is untouched', async (_name, change) => {
    const { storage, lease } = await refusedRun();
    await expect(storage.discardRefusedRun({ ...scope, ...change }, lease)).rejects.toThrow('Only the active run');
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 2, request: { commandId: pause.commandId }, run: { runId } });
  });

  it('a lease of another user cannot discard this user\'s run', async () => {
    const { storage } = await refusedRun();
    const foreign = (await storage.acquireWriterLease(otherUserId, crypto.randomUUID(), 15_000)).lease;
    await expect(storage.discardRefusedRun(scope, foreign)).rejects.toThrow('does not match');
    await expect(storage.countPoints(scope)).resolves.toBe(2);
  });

  it('a delayed discard of the old run cannot clear the newer run that replaced it', async () => {
    const { storage, lease } = await refusedRun();
    await storage.discardRefusedRun(scope, lease);
    const newer = { ...startRequest, runId: otherRunId };
    await storage.acknowledgeStart(userId, newer, { ...recordingRun, runId: otherRunId });
    const newerScope = { ...scope, runId: otherRunId };
    await storage.appendPoint(newerScope, measurement);
    const newerPause: CommandRequest = { ...newerScope, kind: 'command', commandId: crypto.randomUUID(), expectedControlRevision: '0', type: 'pause' };
    await storage.queueRequest(userId, newerPause, { ...recordingRun, runId: otherRunId });

    // The same callback runs a second time, late.
    await expect(storage.discardRefusedRun(scope, lease)).rejects.toThrow('Only the active run');
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      pendingPointCount: 1,
      request: { commandId: newerPause.commandId },
      run: { runId: otherRunId },
    });
  });

  it('there is nothing to discard once the pointer is already cleared', async () => {
    const { storage, lease } = await refusedRun();
    await storage.clearActiveRun(userId);
    await expect(storage.discardRefusedRun(scope, lease)).rejects.toThrow('Only the active run');
    // The points were not touched by a discard that did not apply.
    await expect(storage.countPoints(scope)).resolves.toBe(2);
  });

  it('a failure part-way through leaves the run fully recoverable', async () => {
    const { storage, lease } = await refusedRun();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the store as this below
    const original = IDBObjectStore.prototype.delete;
    const failing = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      // The points are already deleted in this transaction when the queued requests are reached.
      if (this.name === 'requests') throw new Error('disk failure');
      return original.call(this, key);
    });
    try {
      await expect(storage.discardRefusedRun(scope, lease)).rejects.toThrow('disk failure');
    } finally {
      failing.mockRestore();
    }
    await expect(storage.exportBufferedPoints(scope)).resolves.toMatchObject([{ seq: '1' }, { seq: '2' }]);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 2, request: { commandId: pause.commandId }, run: { runId } });
  });

  it('does not change what the ordinary discard of a rejected finished run does', async () => {
    const { storage, lease } = await refusedRun();
    await storage.rejectUpload(scope, 'RUN_POINT_LIMIT', lease);
    await storage.activateRunSnapshot(userId, orgId, { ...recordingRun, controlRevision: '1', dataRevision: '1', finishedAt: '2026-09-26T08:01:00.000Z', status: 'finished' });
    await storage.discardRejectedRun(scope, lease);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 0, request: null, run: null });
  });
});

// A Start the server definitively rejected leaves only a queued request: no run, no points, no pointer. Abandoning
// it deletes exactly that record, inside the writer-fenced transaction, and nothing that belongs to anyone else.
describe('abandonQueuedStart', () => {
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const newerRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const newerStart: StartRequest = { ...startRequest, runId: newerRunId, startedAt: '2026-09-26T08:05:00.000Z' };

  async function rejectedStart() {
    const factory = new IDBFactory();
    const name = crypto.randomUUID();
    const storage = createStorage(factory, name);
    await storage.queueRequest(userId, startRequest, null);
    const { lease } = await storage.acquireWriterLease(userId, crypto.randomUUID(), 15_000);
    return { factory, lease, name, storage };
  }

  it('deletes the exact queued Start and nothing else, and reports it as abandoned', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.saveCaptureSource(userId, 'simulator');
    await storage.queueRequest(otherUserId, startRequest, null);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest, run: null });

    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'abandoned' });

    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      captureSource: 'simulator',
      orgId: null,
      pendingPointCount: 0,
      request: null,
      run: null,
    });
    // The same request id of another identity is another record.
    await expect(storage.loadRecovery(otherUserId)).resolves.toMatchObject({ request: startRequest });
  });

  it('survives a reload: the abandoned Start is not recovered', async () => {
    const { factory, name, storage, lease } = await rejectedStart();
    await storage.abandonQueuedStart(userId, startRequest, lease);
    await storage.close();
    const reopened = createStorage(factory, name);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ request: null, run: null });
  });

  it('lets a new Start be queued and acknowledged afterwards', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.abandonQueuedStart(userId, startRequest, lease);
    await storage.queueRequest(userId, newerStart, null);
    await storage.acknowledgeStart(userId, newerStart, { ...recordingRun, runId: newerRunId, startedAt: newerStart.startedAt });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { runId: newerRunId } });
  });

  it('removes only the Start it is given when a newer request is queued beside it', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.queueRequest(userId, newerStart, null);
    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'abandoned' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: newerStart });
  });

  it('a stale abandonment of the old Start leaves the newer request, and its active run and points, untouched', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.abandonQueuedStart(userId, startRequest, lease);
    const newerScope = { ...scope, runId: newerRunId };
    await storage.queueRequest(userId, newerStart, null);
    await storage.acknowledgeStart(userId, newerStart, { ...recordingRun, runId: newerRunId, startedAt: newerStart.startedAt });
    await storage.appendPoint(newerScope, measurement);
    const pause: CommandRequest = { ...newerScope, kind: 'command', commandId: crypto.randomUUID(), expectedControlRevision: '0', type: 'pause' };
    await storage.queueRequest(userId, pause, { ...recordingRun, runId: newerRunId });

    // The same callback fires a second time, late.
    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-queued' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      pendingPointCount: 1,
      request: { commandId: pause.commandId },
      run: { runId: newerRunId },
    });
  });

  it('a Start that was acknowledged meanwhile is not abandoned, and the run it became stays active', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);
    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-queued' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { runId } });
  });

  it('a queued Start is not abandoned while any run is active, and nothing changes', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.acknowledgeStart(userId, newerStart, { ...recordingRun, runId: newerRunId });
    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'run-active' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest, run: { runId: newerRunId } });
  });

  it('a record with the same run id but another identity (startedAt) is not the request that was rejected', async () => {
    const { storage, lease } = await rejectedStart();
    const different = { ...startRequest, startedAt: '2026-09-26T09:00:00.000Z' };
    await expect(storage.abandonQueuedStart(userId, different, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-queued' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
  });

  it('a command request is not abandoned through this operation', async () => {
    const { storage, lease } = await rejectedStart();
    const pause: CommandRequest = { ...scope, kind: 'command', commandId: crypto.randomUUID(), expectedControlRevision: '0', type: 'pause' };
    await expect(storage.abandonQueuedStart(userId, pause as unknown as StartRequest, lease)).rejects.toThrow('requires a start request');
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
  });

  it('a stale or foreign writer cannot abandon, and nothing changes', async () => {
    const { storage, lease } = await rejectedStart();
    for (const stale of [
      { ...lease, fencingToken: '0' },
      { ...lease, ownerId: crypto.randomUUID() },
    ]) {
      await expect(storage.abandonQueuedStart(userId, startRequest, stale)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    }
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
  });

  it('a tab that lost the lease to another tab cannot abandon, while the new owner can', async () => {
    const { storage, lease: tabA } = await rejectedStart();
    const tabB = (await storage.acquireWriterLease(userId, crypto.randomUUID(), 15_000, [tabA.ownerId])).lease;
    await expect(storage.abandonQueuedStart(userId, startRequest, tabA)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
    await expect(storage.abandonQueuedStart(userId, startRequest, tabB)).resolves.toEqual({ outcome: 'abandoned' });
  });

  it('a released lease cannot abandon', async () => {
    const { storage, lease } = await rejectedStart();
    await storage.releaseWriterLease(lease);
    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
  });

  it('an expired lease cannot abandon', async () => {
    const factory = new IDBFactory();
    let now = new Date('2026-09-26T08:00:01.000Z');
    const storage = new IndexedDbRunnerStorage({ databaseName: crypto.randomUUID(), factory, keyRange: IDBKeyRange, now: () => now });
    await storage.queueRequest(userId, startRequest, null);
    const { lease } = await storage.acquireWriterLease(userId, crypto.randomUUID(), 1_000);
    now = new Date('2026-09-26T08:00:03.000Z');
    await expect(storage.abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
  });

  it('a lease of another user cannot abandon this user Start', async () => {
    const { storage } = await rejectedStart();
    const foreign = (await storage.acquireWriterLease(otherUserId, crypto.randomUUID(), 15_000)).lease;
    await expect(storage.abandonQueuedStart(userId, startRequest, foreign)).rejects.toThrow('does not match');
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
  });

  it('a transaction failure leaves the exact Start queued and recoverable', async () => {
    const { factory, name, storage, lease } = await rejectedStart();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the store as this below
    const original = IDBObjectStore.prototype.delete;
    const failing = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (this.name === 'requests') throw new Error('disk failure');
      return original.call(this, key);
    });
    try {
      await expect(storage.abandonQueuedStart(userId, startRequest, lease)).rejects.toThrow('disk failure');
    } finally {
      failing.mockRestore();
    }
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: startRequest, run: null });
    await storage.close();
    await expect(createStorage(factory, name).loadRecovery(userId)).resolves.toMatchObject({ request: startRequest });
    // The same operation then succeeds: the failure left nothing half-done.
    await expect(createStorage(factory, name).abandonQueuedStart(userId, startRequest, lease)).resolves.toEqual({ outcome: 'abandoned' });
  });
});
