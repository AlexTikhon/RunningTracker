import type { RunCommandResponse, RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { unrecoverableRefusalOf } from './run-authority.js';
import { RunnerApiError } from './runner-api.js';
import { executeRunnerRequest } from './runner-requests.js';
import type { CommandRequest, StartRequest } from './runner-state.js';
import { IndexedDbRunnerStorage } from './runner-storage.js';

// The durable command boundary under an unknown outcome and under a definitive refusal (ADR-0055). The request is
// queued before it is sent and keeps its exact identity until the server's answer is acknowledged; a refusal
// changes how the page classifies the failure, not what is stored.

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const startedAt = '2026-10-08T08:00:00.000Z';
const recording: RunView = {
  controlRevision: '3', dataRevision: '5', finishedAt: null, rawState: 'available', runId, startedAt, status: 'recording', summary: null,
};
const start: StartRequest = { kind: 'start', orgId, runId, startedAt };
const pause: CommandRequest = {
  commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expectedControlRevision: '3', kind: 'command', orgId, runId, type: 'pause',
};
const paused: RunCommandResponse = { commandId: pause.commandId, controlRevision: '4', dataRevision: '5', finishedAt: null, status: 'paused' };
const apiError = (status: number, code: string) => new RunnerApiError('The server said no', status, code, null);
const csrf = { headerName: 'x-csrf-token', token: 't' } as const;

async function setup() {
  const storage = new IndexedDbRunnerStorage({ databaseName: crypto.randomUUID(), factory: new IDBFactory(), keyRange: IDBKeyRange });
  await storage.acknowledgeStart(userId, start, recording);
  const sent: CommandRequest[] = [];
  const run = (
    send: (request: CommandRequest) => Promise<RunCommandResponse>,
    read: () => Promise<RunView> = () => Promise.reject(new Error('unexpected read')),
    request: CommandRequest = pause,
  ) =>
    executeRunnerRequest({
      api: {
        createRun: () => Promise.reject(new Error('unexpected start')),
        readRun: read,
        sendRunCommand: (input) => { sent.push(input as CommandRequest); return send(input as CommandRequest); },
      },
      assertOwned: () => Promise.resolve(true),
      csrf,
      online: true,
      request,
      run: recording,
      signal: new AbortController().signal,
      storage,
      userId,
    });
  return { run, sent, storage };
}

describe('a command the server refuses for good', () => {
  it.each([
    [410, 'RUN_DELETED'],
    [404, 'RUN_NOT_FOUND'],
    [403, 'ORG_ACCESS_DENIED'],
  ])('%i %s is raised as it is, classified as a refusal, and the exact request stays queued', async (status, code) => {
    const { run, storage } = await setup();
    const error = await run(() => Promise.reject(apiError(status, code))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunnerApiError);
    expect(unrecoverableRefusalOf(error)).toMatchObject({ code });
    const recovered = await storage.loadRecovery(userId);
    expect(recovered.request).toEqual(pause);
    expect(recovered.run).toMatchObject({ controlRevision: '3', status: 'recording' });
  });

  it('a revision conflict whose reconciliation read is refused for good surfaces that refusal, with the request still queued', async () => {
    const { run, storage } = await setup();
    const error = await run(
      () => Promise.reject(apiError(409, 'CONTROL_REVISION_CONFLICT')),
      () => Promise.reject(apiError(410, 'RUN_DELETED')),
    ).catch((caught: unknown) => caught);
    expect(unrecoverableRefusalOf(error)).toMatchObject({ code: 'RUN_DELETED' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: pause });
  });

  it('a revision conflict whose reconciliation read cannot be answered keeps the conflict and is no refusal', async () => {
    const { run, storage } = await setup();
    const error = await run(
      () => Promise.reject(apiError(409, 'CONTROL_REVISION_CONFLICT')),
      () => Promise.reject(apiError(503, 'HTTP_ERROR')),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CONTROL_REVISION_CONFLICT' });
    expect(unrecoverableRefusalOf(error)).toBeNull();
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: pause });
  });
});

describe('a command whose outcome is unknown', () => {
  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['the request deadline', new DOMException('Request deadline exceeded', 'TimeoutError')],
    ['a 500', apiError(500, 'RUN_DELETED')],
    ['a 503', apiError(503, 'HTTP_ERROR')],
    ['a 408', apiError(408, 'RUN_DELETED')],
    ['a 425', apiError(425, 'RUN_DELETED')],
    ['a 429', apiError(429, 'ORG_ACCESS_DENIED')],
    ['an unreadable body', new SyntaxError('Unexpected end of JSON input')],
  ])('%s authorizes nothing, and the retry sends the very same command identity', async (_name, failure) => {
    const { run, sent, storage } = await setup();
    const error = await run(() => Promise.reject(failure)).catch((caught: unknown) => caught);
    expect(unrecoverableRefusalOf(error)).toBeNull();
    expect(await storage.loadRecovery(userId)).toMatchObject({ request: pause, run: { status: 'recording' } });

    // Retrying the recovered request: same id, same expected revision, one stored record, acknowledged once.
    const recovered = (await storage.loadRecovery(userId)).request;
    expect(recovered).toEqual(pause);
    const outcome = await run(() => Promise.resolve(paused), undefined, recovered as CommandRequest);
    expect(outcome).toEqual({ kind: 'command', result: paused });
    expect(sent.map((request) => [request.commandId, request.expectedControlRevision])).toEqual([
      [pause.commandId, '3'],
      [pause.commandId, '3'],
    ]);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ request: null, run: { controlRevision: '4', status: 'paused' } });
  });
});
