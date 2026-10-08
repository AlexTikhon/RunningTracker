import type { RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { refusalOf, RunAuthority, type AuthorityHost, type AuthorityScope } from './run-authority.js';
import { RunnerApiError } from './runner-api.js';
import type { RunnerEvent, StartRequest } from './runner-state.js';
import { IndexedDbRunnerStorage, type WriterLease } from './runner-storage.js';

// ADR-0055. The coordinator owns the scope and the completion of every authority read. These tests run it against
// the real storage class on fake-indexeddb, hold the server's answers, and compare the whole database before and
// after: an obsolete completion must leave every store as it was, whatever the transport did with the abort.

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const owner = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const startedAt = '2026-10-08T08:00:00.000Z';
const scopeA: AuthorityScope = { orgId, runId: runA, userId };
const scopeB: AuthorityScope = { orgId, runId: runB, userId };
const stores = ['leases', 'points', 'profiles', 'requests', 'runs'] as const;

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

const apiError = (status: number, code = 'X') => new RunnerApiError('The server said no', status, code, null);
const startOf = (runId: string): StartRequest => ({ kind: 'start', orgId, runId, startedAt });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function fixture() {
  const factory = new IDBFactory();
  const databaseName = crypto.randomUUID();
  const storage = new IndexedDbRunnerStorage({ databaseName, factory, keyRange: IDBKeyRange, now: () => new Date('2026-10-08T08:00:01.000Z') });
  await storage.acknowledgeStart(userId, startOf(runA), run(runA, 'recording', 3, 5));
  await storage.appendPoint(scopeA, { accuracyM: 4, latitude: 52.2, longitude: 21, recordedAt: startedAt, segmentId: 0 });
  const acquired = await storage.acquireWriterLease(userId, owner, 15_000);
  if (!acquired.acquired) throw new Error('lease');

  const session = new AbortController();
  const state: { lease: WriterLease | null; online: boolean; scope: AuthorityScope | null; signal: AbortSignal | null } = {
    lease: acquired.lease,
    online: true,
    scope: scopeA,
    signal: session.signal,
  };
  const host: AuthorityHost = {
    lease: () => state.lease,
    online: () => state.online,
    scope: () => state.scope,
    signal: () => state.signal,
  };

  // Every read the coordinator makes is held until the test answers it; `aborted` records what the abort did.
  const reads: Array<{ answer: ReturnType<typeof deferred<RunView>>; aborted: () => boolean }> = [];
  const read = (_org: string, _run: string, signal?: AbortSignal) => {
    const answer = deferred<RunView>();
    reads.push({ answer, aborted: () => signal?.aborted === true });
    // The transport ignores the abort on purpose: the coordinator must not rely on it.
    return answer.promise;
  };

  const events: RunnerEvent[] = [];
  const authority = new RunAuthority({ dispatch: (event) => events.push(event), host, read, storage });

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
  return { authority, dump, events, factory, host, lease: acquired.lease, read, reads, session, state, storage, databaseName };
}

describe('a confirmed read', () => {
  it('announces the attempt, persists the answer for the current writer and then confirms it', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 6));
    await expect(completion).resolves.toEqual({ kind: 'confirmed', persisted: true });
    expect(f.events).toEqual([
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run(runA, 'finished', 3, 6), type: 'authority-confirmed' },
    ]);
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { status: 'finished' } });
    expect(f.authority.inFlight).toBe(0);
  });

  it('cannot bring a finished run back through the stored copy', async () => {
    const f = await fixture();
    await f.storage.refreshActiveRun(scopeA, run(runA, 'finished', 3, 6), f.lease);
    for (const stale of [run(runA, 'paused', 3, 5), run(runA, 'recording', 3, 5)]) {
      const completion = f.authority.request();
      f.reads.at(-1)?.answer.resolve(stale);
      await completion;
    }
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ run: { controlRevision: '3', dataRevision: '6', status: 'finished' } });
  });

  it('a read-only tab shows the answer without writing it', async () => {
    const f = await fixture();
    f.state.lease = null;
    const before = await f.dump();
    const completion = f.authority.request();
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 6));
    await expect(completion).resolves.toEqual({ kind: 'confirmed', persisted: false });
    expect(f.events.at(-1)).toMatchObject({ type: 'authority-confirmed' });
    expect(await f.dump()).toEqual(before);
  });

  it('does not ask while the browser is offline or without a session or scope', async () => {
    const f = await fixture();
    f.state.online = false;
    await expect(f.authority.request()).resolves.toEqual({ kind: 'obsolete', reason: 'not-requested' });
    f.state.online = true;
    f.state.scope = null;
    await expect(f.authority.request()).resolves.toEqual({ kind: 'obsolete', reason: 'not-requested' });
    f.state.scope = scopeA;
    f.state.signal = null;
    await expect(f.authority.request()).resolves.toEqual({ kind: 'obsolete', reason: 'not-requested' });
    expect(f.reads).toHaveLength(0);
    expect(f.events).toEqual([]);
  });
});

describe('what a failed read means', () => {
  async function failWith(error: unknown) {
    const f = await fixture();
    const completion = f.authority.request();
    f.reads[0]?.answer.reject(error);
    return { completion: await completion, f };
  }

  it.each([
    ['500', apiError(500, 'INTERNAL_ERROR')],
    ['502', apiError(502, 'HTTP_ERROR')],
    ['503', apiError(503, 'HTTP_ERROR')],
    ['429', apiError(429, 'RATE_LIMITED')],
    ['425', apiError(425, 'TOO_EARLY')],
    ['408', apiError(408, 'HTTP_ERROR')],
    ['a network failure', new TypeError('Failed to fetch')],
    ['the request deadline', new DOMException('Request deadline exceeded', 'TimeoutError')],
    ['an unreadable body', new SyntaxError('Unexpected end of JSON input')],
  ])('%s is no answer: unreachable, nothing concluded, local data untouched', async (_name, error) => {
    const { completion, f } = await failWith(error);
    expect(completion).toEqual({ kind: 'unreachable' });
    expect(f.events.at(-1)).toMatchObject({ attempt: 1, kind: 'unreachable', type: 'authority-unconfirmed' });
    expect(f.events.at(-1)).not.toHaveProperty('code');
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { status: 'recording' } });
  });

  it.each([
    [410, 'RUN_DELETED'],
    [404, 'RUN_NOT_FOUND'],
    [403, 'ORG_ACCESS_DENIED'],
    [409, 'CONTROL_REVISION_CONFLICT'],
    [404, 'ROUTE_NOT_FOUND'],
    [400, 'INVALID_REQUEST'],
  ])('%i %s is an answer that the run is not readable: refused with its code, local data untouched', async (status, code) => {
    const { completion, f } = await failWith(apiError(status, code));
    expect(completion).toEqual({ kind: 'refused' });
    expect(f.events.at(-1)).toEqual({ attempt: 1, code, kind: 'refused', message: `The server said no (${code}).`, type: 'authority-unconfirmed' });
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { status: 'recording' } });
  });

  it.each([
    ['500', apiError(500, 'RUN_DELETED')],
    ['429', apiError(429, 'RUN_DELETED')],
    ['408', apiError(408, 'ORG_ACCESS_DENIED')],
  ])('%s never carries a refusal code, whatever the code says', async (_name, error) => {
    expect(refusalOf(error)).toBeNull();
    const { f } = await failWith(error);
    expect(f.events.at(-1)).toMatchObject({ kind: 'unreachable' });
  });

  it('keeps the code and the message, and not the response body or the request reference', async () => {
    const { f } = await failWith(new RunnerApiError('The run has been deleted', 410, 'RUN_DELETED', 'req-123'));
    expect(Object.keys(f.events.at(-1) ?? {}).sort()).toEqual(['attempt', 'code', 'kind', 'message', 'type']);
  });

  it('401 is left to the session layer and says nothing about the run', async () => {
    const { completion, f } = await failWith(apiError(401, 'SESSION_REQUIRED'));
    expect(completion).toEqual({ kind: 'obsolete', reason: 'session' });
    expect(f.events).toEqual([{ attempt: 1, type: 'authority-requested' }]);
  });

  it('a failing local write is not reported as an answer', async () => {
    const f = await fixture();
    f.storage.refreshActiveRun = () => Promise.reject(new Error('QuotaExceededError'));
    const completion = f.authority.request();
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 6));
    await expect(completion).resolves.toEqual({ kind: 'unreachable' });
    expect(f.events.at(-1)).toMatchObject({ kind: 'unreachable', type: 'authority-unconfirmed' });
  });
});

describe('an answer that arrives after its scope or its writer has changed', () => {
  it('A is finished and cleared and B started while A\'s read is held: B stays active, nothing is written, nothing is confirmed', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    await f.storage.refreshActiveRun(scopeA, run(runA, 'finished', 3, 6), f.lease);
    await f.storage.clearActiveRun(userId);
    await f.storage.acknowledgeStart(userId, startOf(runB), run(runB, 'recording', 0, 0));
    await f.storage.appendPoint(scopeB, { accuracyM: 4, latitude: 52.2, longitude: 21, recordedAt: startedAt, segmentId: 0 });
    f.state.scope = scopeB;
    const before = await f.dump();

    f.reads[0]?.answer.resolve(run(runA, 'paused', 9, 9));
    await expect(completion).resolves.toEqual({ kind: 'obsolete', reason: 'scope-changed' });

    expect(await f.dump()).toEqual(before);
    expect(f.events.filter((event) => event.type === 'authority-confirmed')).toEqual([]);
    await f.storage.close();
    const reopened = new IndexedDbRunnerStorage({ databaseName: f.databaseName, factory: f.factory, keyRange: IDBKeyRange });
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({ orgId, pendingPointCount: 1, run: { runId: runB, status: 'recording' } });
  });

  it('A is explicitly discarded while an older successful read is held: the pointer stays empty and the discarded queue stays absent', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    await f.storage.discardRefusedRun(scopeA, f.lease);
    f.authority.invalidate();
    f.state.scope = null;
    const before = await f.dump();

    f.reads[0]?.answer.resolve(run(runA, 'recording', 3, 5));
    await expect(completion).resolves.toMatchObject({ kind: 'obsolete' });

    expect(await f.dump()).toEqual(before);
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ orgId: null, pendingPointCount: 0, run: null });
  });

  it('even if the discard is not announced to the coordinator, the storage transaction finds the run inactive', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    await f.storage.discardRefusedRun(scopeA, f.lease);
    const before = await f.dump();

    f.reads[0]?.answer.resolve(run(runA, 'recording', 3, 5));
    // Not confirmed: the unwritten answer is reported as not saved, never as success.
    await expect(completion).resolves.toEqual({ kind: 'obsolete', reason: 'not-saved' });

    expect(await f.dump()).toEqual(before);
    expect(f.events.filter((event) => event.type === 'authority-confirmed')).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({ kind: 'unreachable', type: 'authority-unconfirmed' });
  });

  it('the writer is released and the same owner acquires a newer epoch while the read is held: no obsolete durable write', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    await f.storage.releaseWriterLease(f.lease);
    const next = await f.storage.acquireWriterLease(userId, owner, 15_000);
    if (!next.acquired) throw new Error('lease');
    expect(BigInt(next.lease.fencingToken)).toBeGreaterThan(BigInt(f.lease.fencingToken));
    f.state.lease = next.lease;
    const before = await f.dump();

    f.reads[0]?.answer.resolve(run(runA, 'paused', 4, 6));
    await expect(completion).resolves.toEqual({ kind: 'obsolete', reason: 'writer-changed' });

    expect(await f.dump()).toEqual(before);
    expect(f.events.filter((event) => event.type === 'authority-confirmed')).toEqual([]);
  });

  it('a lease that expired or was replaced before the coordinator noticed is caught by the transaction and reported as not saved', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    await f.storage.releaseWriterLease(f.lease);
    await f.storage.acquireWriterLease(userId, owner, 15_000);
    const before = await f.dump();

    f.reads[0]?.answer.resolve(run(runA, 'paused', 4, 6));
    await expect(completion).resolves.toEqual({ kind: 'obsolete', reason: 'not-saved' });

    expect(await f.dump()).toEqual(before);
    expect(f.events.filter((event) => event.type === 'authority-confirmed')).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({ kind: 'unreachable', type: 'authority-unconfirmed' });
  });

  it('a session that ended while the transport ignored the abort cannot confirm or persist', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    f.session.abort();
    const before = await f.dump();
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 6));
    await expect(completion).resolves.toMatchObject({ kind: 'obsolete' });
    expect(await f.dump()).toEqual(before);
    expect(f.events).toEqual([{ attempt: 1, type: 'authority-requested' }]);
  });
});

describe('supersession, duplicates and out-of-order completions', () => {
  it('asks once for the same scope and writer, however often it is asked, and never has more than one read pending', async () => {
    const f = await fixture();
    const first = f.authority.request();
    const second = f.authority.request();
    const third = f.authority.request();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(f.reads).toHaveLength(1);
    expect(f.authority.inFlight).toBe(1);
    expect(f.events).toEqual([{ attempt: 1, type: 'authority-requested' }]);
    f.reads[0]?.answer.resolve(run(runA, 'recording', 3, 6));
    await first;
    expect(f.authority.inFlight).toBe(0);
  });

  it('a read for a changed writer epoch supersedes the older one, and the older answer arriving last changes nothing', async () => {
    const f = await fixture();
    const older = f.authority.request();
    // The writer changes: a newer epoch of the same owner.
    await f.storage.releaseWriterLease(f.lease);
    const next = await f.storage.acquireWriterLease(userId, owner, 15_000);
    if (!next.acquired) throw new Error('lease');
    f.state.lease = next.lease;
    const newer = f.authority.request();
    expect(f.reads).toHaveLength(2);
    expect(f.reads[0]?.aborted()).toBe(true);
    expect(f.reads[1]?.aborted()).toBe(false);
    expect(f.authority.inFlight).toBe(1);

    // Out of order: the newer answer first, then the older one although its abort was ignored.
    f.reads[1]?.answer.resolve(run(runA, 'paused', 4, 6));
    await expect(newer).resolves.toEqual({ kind: 'confirmed', persisted: true });
    const afterNewer = await f.dump();
    f.reads[0]?.answer.resolve(run(runA, 'recording', 3, 5));
    await expect(older).resolves.toEqual({ kind: 'obsolete', reason: 'superseded' });

    expect(await f.dump()).toEqual(afterNewer);
    expect(f.events).toEqual([
      { attempt: 1, type: 'authority-requested' },
      { attempt: 2, type: 'authority-requested' },
      { attempt: 2, run: run(runA, 'paused', 4, 6), type: 'authority-confirmed' },
    ]);
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ run: { controlRevision: '4', status: 'paused' } });
  });

  it('an older failure arriving after a newer success reports nothing', async () => {
    const f = await fixture();
    const older = f.authority.request();
    f.authority.invalidate();
    const newer = f.authority.request();
    f.reads[1]?.answer.resolve(run(runA, 'recording', 3, 6));
    await newer;
    f.reads[0]?.answer.reject(apiError(410, 'RUN_DELETED'));
    await older;
    expect(f.events.map((event) => event.type)).toEqual(['authority-requested', 'authority-requested', 'authority-confirmed']);
  });

  it('invalidate() ends the read in flight: its late answer neither persists nor reports, and the next request starts fresh', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    f.authority.invalidate();
    expect(f.reads[0]?.aborted()).toBe(true);
    expect(f.authority.inFlight).toBe(0);
    const before = await f.dump();
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 6));
    await expect(completion).resolves.toEqual({ kind: 'obsolete', reason: 'superseded' });
    expect(await f.dump()).toEqual(before);
    void f.authority.request();
    expect(f.reads).toHaveLength(2);
  });

  it('the attempt numbers only grow, across completed and abandoned reads', async () => {
    const f = await fixture();
    void f.authority.request();
    f.authority.invalidate();
    const second = f.authority.request();
    f.reads[1]?.answer.resolve(run(runA, 'recording', 3, 6));
    await second;
    const third = f.authority.request();
    f.reads[2]?.answer.reject(new TypeError('offline'));
    await third;
    const attempts = f.events.flatMap((event) => (event.type === 'authority-requested' ? [event.attempt] : []));
    expect(attempts).toEqual([1, 2, 3]);
  });
});

describe('a refusal that comes from an upload or a command', () => {
  const refusal = { code: 'RUN_DELETED', message: 'The run has been deleted (RUN_DELETED).' };

  it('is accepted for the scope the page has, announced once and ends the read in flight', async () => {
    const f = await fixture();
    const completion = f.authority.request();
    expect(f.authority.refuse(scopeA, refusal)).toBe(true);
    expect(f.events.at(-1)).toEqual({ ...refusal, runId: runA, type: 'authority-refused' });
    expect(f.authority.inFlight).toBe(0);

    // An older, successful answer for the same run cannot undo the refusal, in the page or on disk.
    const before = await f.dump();
    f.reads[0]?.answer.resolve(run(runA, 'recording', 3, 5));
    await expect(completion).resolves.toEqual({ kind: 'obsolete', reason: 'superseded' });
    expect(await f.dump()).toEqual(before);
    expect(f.events.filter((event) => event.type === 'authority-confirmed')).toEqual([]);
  });

  it('is dropped for another run, organization or user than the page has now', async () => {
    const f = await fixture();
    for (const other of [scopeB, { ...scopeA, orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, { ...scopeA, userId: '22222222-2222-4222-8222-222222222222' }]) {
      expect(f.authority.refuse(other, refusal)).toBe(false);
    }
    f.state.scope = null;
    expect(f.authority.refuse(scopeA, refusal)).toBe(false);
    expect(f.events).toEqual([]);
  });

  it('only a refusal that is a definitive answer about the run qualifies', () => {
    expect(refusalOf(apiError(410, 'RUN_DELETED'))).toEqual({ code: 'RUN_DELETED', message: 'The server said no (RUN_DELETED).' });
    expect(refusalOf(apiError(403, 'ORG_ACCESS_DENIED'))?.code).toBe('ORG_ACCESS_DENIED');
    for (const error of [apiError(401, 'SESSION_REQUIRED'), apiError(500, 'RUN_DELETED'), apiError(502, 'RUN_DELETED'), apiError(408, 'RUN_DELETED'), apiError(425, 'RUN_DELETED'), apiError(429, 'RUN_DELETED'), new TypeError('Failed to fetch'), new DOMException('x', 'AbortError'), new SyntaxError('Unexpected end'), 'RUN_DELETED']) {
      expect(refusalOf(error)).toBeNull();
    }
  });
});

describe('a reconciliation after an upload the server rejected', () => {
  it('merges the answer into the page and the stored run without asking the reducer for a new attempt', async () => {
    const f = await fixture();
    const completion = f.authority.request({ reconcile: true });
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 6));
    await expect(completion).resolves.toEqual({ kind: 'confirmed', persisted: true });
    expect(f.events).toEqual([{ run: run(runA, 'finished', 3, 6), type: 'run-reconciled' }]);
    await expect(f.storage.loadRecovery(userId)).resolves.toMatchObject({ run: { status: 'finished' } });
  });

  it('turns a definitive refusal into the same refusal, and stays silent when the server cannot be reached', async () => {
    const refused = await fixture();
    const first = refused.authority.request({ reconcile: true });
    refused.reads[0]?.answer.reject(apiError(404, 'RUN_NOT_FOUND'));
    await first;
    expect(refused.events).toEqual([{ code: 'RUN_NOT_FOUND', message: 'The server said no (RUN_NOT_FOUND).', runId: runA, type: 'authority-refused' }]);

    const unreachable = await fixture();
    const second = unreachable.authority.request({ reconcile: true });
    unreachable.reads[0]?.answer.reject(apiError(503, 'HTTP_ERROR'));
    await second;
    expect(unreachable.events).toEqual([]);
  });

  it('joins the ordinary confirmation of the same scope already running, so the attempt the reducer awaits is still answered', async () => {
    const f = await fixture();
    const confirm = f.authority.request();
    const reconcile = f.authority.request({ reconcile: true });
    expect(reconcile).toBe(confirm);
    expect(f.reads).toHaveLength(1);
    f.reads[0]?.answer.reject(apiError(503, 'HTTP_ERROR'));
    await confirm;
    // The awaited attempt was answered (unreachable), not abandoned while the reducer still waits for it.
    expect(f.events.map((event) => event.type)).toEqual(['authority-requested', 'authority-unconfirmed']);
  });

  it('is replaced by an ordinary confirmation of the same scope, never the other way round by accident', async () => {
    const f = await fixture();
    const reconcile = f.authority.request({ reconcile: true });
    const confirm = f.authority.request();
    expect(confirm).not.toBe(reconcile);
    expect(f.reads).toHaveLength(2);
    await settle();
    f.reads[1]?.answer.resolve(run(runA, 'recording', 3, 6));
    f.reads[0]?.answer.resolve(run(runA, 'finished', 3, 9));
    await Promise.all([reconcile, confirm]);
    expect(f.events.map((event) => event.type)).toEqual(['authority-requested', 'authority-confirmed']);
  });
});
