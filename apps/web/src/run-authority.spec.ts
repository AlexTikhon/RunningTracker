import type { RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { readAuthoritativeRun } from './run-authority.js';
import { RunnerApiError } from './runner-api.js';
import { IndexedDbRunnerStorage } from './runner-storage.js';
import type { StartRequest } from './runner-state.js';

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope = { orgId, runId, userId };
const startedAt = '2026-10-06T08:00:00.000Z';

function run(status: RunView['status'], controlRevision: number, dataRevision: number): RunView {
  return {
    controlRevision: String(controlRevision),
    dataRevision: String(dataRevision),
    finishedAt: status === 'finished' ? '2026-10-07T08:00:00.000Z' : null,
    rawState: 'available',
    runId,
    startedAt,
    status,
    summary: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

const startRequest: StartRequest = { kind: 'start', orgId, runId, startedAt };

async function storageWithRecordingRun() {
  const storage = new IndexedDbRunnerStorage({
    databaseName: crypto.randomUUID(),
    factory: new IDBFactory(),
    keyRange: IDBKeyRange,
    now: () => new Date('2026-10-06T08:00:01.000Z'),
  });
  await storage.acknowledgeStart(userId, startRequest, run('recording', 3, 5));
  await storage.appendPoint(scope, { accuracyM: 4, latitude: 52.2, longitude: 21, recordedAt: startedAt, segmentId: 0 });
  return storage;
}

const abort = new AbortController();
const apiError = (status: number, code = 'X') => new RunnerApiError('The server said no', status, code, null);

describe('readAuthoritativeRun', () => {
  it('stores the answer through the monotonic merge and reports it', async () => {
    const storage = await storageWithRecordingRun();
    const event = await readAuthoritativeRun({ attempt: 1, read: () => Promise.resolve(run('finished', 3, 6)), scope, signal: abort.signal, storage });
    expect(event).toEqual({ attempt: 1, run: run('finished', 3, 6), type: 'authority-confirmed' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { status: 'finished' } });
  });

  it('a stale answer stored after FINISHED cannot resurrect the run in IndexedDB', async () => {
    const storage = await storageWithRecordingRun();
    await storage.saveRunSnapshot(userId, orgId, run('finished', 3, 6));
    await readAuthoritativeRun({ attempt: 1, read: () => Promise.resolve(run('paused', 3, 5)), scope, signal: abort.signal, storage });
    await readAuthoritativeRun({ attempt: 2, read: () => Promise.resolve(run('recording', 3, 5)), scope, signal: abort.signal, storage });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ run: { controlRevision: '3', dataRevision: '6', status: 'finished' } });
  });

  it.each([
    ['500', apiError(500, 'INTERNAL_ERROR')],
    ['502', apiError(502, 'HTTP_ERROR')],
    ['503', apiError(503, 'HTTP_ERROR')],
    ['429', apiError(429, 'RATE_LIMITED')],
    ['408', apiError(408, 'HTTP_ERROR')],
    ['a network failure', new TypeError('Failed to fetch')],
    ['the request deadline', new DOMException('Request deadline exceeded', 'TimeoutError')],
    ['an unreadable body', new SyntaxError('Unexpected end of JSON input')],
  ])('%s is no answer: unreachable, nothing concluded, local data untouched', async (_name, error) => {
    const storage = await storageWithRecordingRun();
    const event = await readAuthoritativeRun({ attempt: 4, read: () => Promise.reject(error), scope, signal: abort.signal, storage });
    expect(event).toMatchObject({ attempt: 4, kind: 'unreachable', type: 'authority-unconfirmed' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { status: 'recording' } });
    await expect(storage.readPointBatch(scope)).resolves.toHaveLength(1);
  });

  it.each([
    [410, 'RUN_DELETED'],
    [404, 'RUN_NOT_FOUND'],
    [403, 'ORG_ACCESS_DENIED'],
    [409, 'CONTROL_REVISION_CONFLICT'],
    [404, 'ROUTE_NOT_FOUND'],
    [400, 'INVALID_REQUEST'],
  ])('%i %s is an answer that the run is not readable: refused with its code, local data untouched', async (status, code) => {
    const storage = await storageWithRecordingRun();
    const event = await readAuthoritativeRun({ attempt: 1, read: () => Promise.reject(apiError(status, code)), scope, signal: abort.signal, storage });
    expect(event).toEqual({ attempt: 1, code, kind: 'refused', message: `The server said no (${code}).`, type: 'authority-unconfirmed' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { status: 'recording' } });
  });

  it('keeps the server error code and not the response body or the request reference in the refusal', async () => {
    const storage = await storageWithRecordingRun();
    const error = new RunnerApiError('The run has been deleted', 410, 'RUN_DELETED', 'req-123');
    const event = await readAuthoritativeRun({ attempt: 1, read: () => Promise.reject(error), scope, signal: abort.signal, storage });
    expect(Object.keys(event ?? {}).sort()).toEqual(['attempt', 'code', 'kind', 'message', 'type']);
  });

  it.each([
    ['500', apiError(500, 'RUN_DELETED')],
    ['429', apiError(429, 'RUN_DELETED')],
    ['408', apiError(408, 'ORG_ACCESS_DENIED')],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('%s never carries a refusal code, whatever the code says', async (_name, error) => {
    const storage = await storageWithRecordingRun();
    const event = await readAuthoritativeRun({ attempt: 1, read: () => Promise.reject(error), scope, signal: abort.signal, storage });
    expect(event).toMatchObject({ kind: 'unreachable' });
    expect(event).not.toHaveProperty('code');
  });

  it('401 is left to the session layer and says nothing about the run', async () => {
    const storage = await storageWithRecordingRun();
    await expect(readAuthoritativeRun({ attempt: 1, read: () => Promise.reject(apiError(401, 'SESSION_REQUIRED')), scope, signal: abort.signal, storage })).resolves.toBeNull();
  });

  it('a cancelled read, before or after the answer arrives, reports nothing and stores nothing', async () => {
    const storage = await storageWithRecordingRun();
    const save = vi.spyOn(storage, 'saveRunSnapshot');
    const answer = deferred<RunView>();
    const controller = new AbortController();
    const pending = readAuthoritativeRun({ attempt: 1, read: () => answer.promise, scope, signal: controller.signal, storage });
    controller.abort();
    answer.resolve(run('finished', 3, 6));
    await expect(pending).resolves.toBeNull();
    expect(save).not.toHaveBeenCalled();

    const failing = new AbortController();
    const rejected = readAuthoritativeRun({ attempt: 2, read: () => { failing.abort(); return Promise.reject(new DOMException('Request cancelled', 'AbortError')); }, scope, signal: failing.signal, storage });
    await expect(rejected).resolves.toBeNull();
  });

  it('a read-only tab shows the answer without writing it', async () => {
    const storage = await storageWithRecordingRun();
    const event = await readAuthoritativeRun({ attempt: 1, read: () => Promise.resolve(run('finished', 3, 6)), scope, signal: abort.signal, storage: null });
    expect(event?.type).toBe('authority-confirmed');
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ run: { status: 'recording' } });
  });

  it('a failing local write is not reported as an answer', async () => {
    const storage = await storageWithRecordingRun();
    vi.spyOn(storage, 'saveRunSnapshot').mockRejectedValue(new Error('QuotaExceededError'));
    const event = await readAuthoritativeRun({ attempt: 1, read: () => Promise.resolve(run('finished', 3, 6)), scope, signal: abort.signal, storage });
    expect(event).toMatchObject({ kind: 'unreachable', type: 'authority-unconfirmed' });
  });
});
