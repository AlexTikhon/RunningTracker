import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

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
      await storage.saveRunSnapshot(userId, orgId, { ...recordingRun, dataRevision: '3' });
      await storage.close();
      const reopened = createStorage(factory, databaseName);
      await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ request: null, pendingPointCount: 0, run: { controlRevision: '1', dataRevision: '3', status: type === 'pause' ? 'paused' : 'finished' } });
      await reopened.close();
    }
  });

  it('retains rejected points through reload, fences capture and atomically discards only the settled rejected run', async () => {
    const factory = new IDBFactory();
    const name = crypto.randomUUID();
    const storage = createStorage(factory, name);
    await storage.acknowledgeStart(userId, startRequest, recordingRun);
    await storage.appendPoint(scope, measurement);
    const otherScope = { ...scope, runId: crypto.randomUUID() };
    await storage.appendPoint(otherScope, measurement);
    await storage.rejectUpload(scope, 'RUN_POINT_LIMIT');
    await storage.close();
    const reopened = createStorage(factory, name);
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ uploadRejection: 'RUN_POINT_LIMIT', pendingPointCount: 1 });
    await expect(reopened.appendPoint(scope, measurement)).rejects.toThrow('rejected queue');
    const acquisition = await reopened.acquireWriterLease(userId, crypto.randomUUID(), 15_000);
    const lease = acquisition.lease;
    await expect(reopened.discardRejectedRun(scope, lease)).rejects.toThrow('active rejected run');
    await reopened.saveRunSnapshot(userId, orgId, { ...recordingRun, controlRevision: '1', dataRevision: '1', status: 'finished', finishedAt: '2026-09-26T08:01:00.000Z' });
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
    await storage.saveRunSnapshot(userId, orgId, recordingRun);

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

      await storage.saveRunSnapshot(userId, orgId, { ...recordingRun, controlRevision: '1', status: 'paused' });

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
