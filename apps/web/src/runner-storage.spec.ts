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
      orgId: null,
      pendingPointCount: 0,
      request: null,
      run: null,
    });
    await expect(storage.readPointBatch(scope)).resolves.toHaveLength(1);
  });
});
