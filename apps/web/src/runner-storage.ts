import {
  createRunRequestSchema,
  pointInputSchema,
  revisionSchema,
  runCommandRequestSchema,
  runViewSchema,
  uuidSchema,
  type PointInput,
  type RunCommandResponse,
  type RunView,
} from '@running-tracker/contracts';

import type { CommandRequest, RunnerRequest, StartRequest } from './runner-state.js';

const DATABASE_VERSION = 1;
const DEFAULT_DATABASE_NAME = 'running-tracker-runner';
const MAX_SEQ = 9_223_372_036_854_775_807n;
const SEQ_KEY_WIDTH = MAX_SEQ.toString().length;

const STORES = {
  points: 'points',
  profiles: 'profiles',
  requests: 'requests',
  runs: 'runs',
} as const;

interface ProfileRecord {
  activeOrgId: string | null;
  activeRunId: string | null;
  userId: string;
}

interface RunRecord {
  nextSeq: string;
  orgId: string;
  run: RunView | null;
  runId: string;
  storageKey: string;
  userId: string;
}

interface PointRecord {
  orgId: string;
  point: PointInput;
  runId: string;
  seqKey: string;
  storageKey: string;
  userId: string;
}

interface RequestRecord {
  enqueuedAt: string;
  request: RunnerRequest;
  requestKey: string;
  storageKey: string;
  userId: string;
}

export interface RunScope {
  orgId: string;
  runId: string;
  userId: string;
}

export interface PointMeasurement {
  accuracyM: number;
  latitude: number;
  longitude: number;
  recordedAt: string;
  segmentId: number;
}

export interface RunnerRecovery {
  orgId: string | null;
  pendingPointCount: number;
  request: RunnerRequest | null;
  run: RunView | null;
}

interface RunnerStorageOptions {
  databaseName?: string;
  factory?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  now?: () => Date;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB request failed')),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
      throw error;
    }
  }
}

function runStorageKey(scope: RunScope): string {
  return `${scope.userId}:${scope.orgId}:${scope.runId}`;
}

function requestIdentity(request: RunnerRequest): string {
  return request.kind === 'start' ? `start:${request.runId}` : `command:${request.commandId}`;
}

function requestStorageKey(userId: string, request: RunnerRequest): string {
  return `${userId}:${requestIdentity(request)}`;
}

function seqKey(seq: string): string {
  return seq.padStart(SEQ_KEY_WIDTH, '0');
}

function validateScope(scope: RunScope): RunScope {
  return {
    orgId: uuidSchema.parse(scope.orgId),
    runId: uuidSchema.parse(scope.runId),
    userId: uuidSchema.parse(scope.userId),
  };
}

function parseRunnerRequest(value: unknown): RunnerRequest {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('Stored runner request is invalid');
  }

  const candidate = value as Record<string, unknown>;
  const path = {
    orgId: candidate.orgId,
    runId: candidate.runId,
  };
  const parsedPath = {
    orgId: uuidSchema.parse(path.orgId),
    runId: uuidSchema.parse(path.runId),
  };

  if (candidate.kind === 'start') {
    const body = createRunRequestSchema.parse({ startedAt: candidate.startedAt });
    return { kind: 'start', ...parsedPath, ...body };
  }
  if (candidate.kind === 'command') {
    const body = runCommandRequestSchema.parse({
      commandId: candidate.commandId,
      expectedControlRevision: candidate.expectedControlRevision,
      type: candidate.type,
    });
    return { kind: 'command', ...parsedPath, ...body };
  }
  throw new Error('Stored runner request kind is invalid');
}

function commandRun(run: RunView, result: RunCommandResponse): RunView {
  return runViewSchema.parse({
    ...run,
    controlRevision: result.controlRevision,
    dataRevision: result.dataRevision,
    finishedAt: result.finishedAt,
    status: result.status,
  });
}

function compareRequests(left: RequestRecord, right: RequestRecord): number {
  return left.enqueuedAt.localeCompare(right.enqueuedAt) || left.requestKey.localeCompare(right.requestKey);
}

function latestRunSnapshot(current: RunView | null | undefined, incoming: RunView): RunView {
  if (current === null || current === undefined) {
    return incoming;
  }
  const dataOrder = BigInt(incoming.dataRevision) - BigInt(current.dataRevision);
  if (dataOrder !== 0n) {
    return dataOrder > 0n ? incoming : current;
  }
  return BigInt(incoming.controlRevision) >= BigInt(current.controlRevision) ? incoming : current;
}

export class IndexedDbRunnerStorage {
  readonly #databaseName: string;
  readonly #factory: IDBFactory;
  readonly #keyRange: typeof IDBKeyRange;
  readonly #now: () => Date;
  #databasePromise: Promise<IDBDatabase> | null = null;

  public constructor(options: RunnerStorageOptions = {}) {
    const factory = options.factory ?? globalThis.indexedDB;
    const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
    if (factory === undefined || keyRange === undefined) {
      throw new Error('IndexedDB is unavailable in this browser');
    }
    this.#databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.#factory = factory;
    this.#keyRange = keyRange;
    this.#now = options.now ?? (() => new Date());
  }

  public async appendPoint(scopeInput: RunScope, measurement: PointMeasurement): Promise<PointInput> {
    const scope = validateScope(scopeInput);
    const database = await this.#open();
    const transaction = database.transaction([STORES.points, STORES.runs], 'readwrite');
    const done = transactionDone(transaction);
    try {
      const runStore = transaction.objectStore(STORES.runs);
      const key = runStorageKey(scope);
      const existing = (await requestResult(runStore.get(key))) as RunRecord | undefined;
      const nextSeq = BigInt(existing?.nextSeq ?? '1');
      if (nextSeq > MAX_SEQ) {
        throw new Error('The local point sequence is exhausted');
      }

      const point = pointInputSchema.parse({ ...measurement, seq: nextSeq.toString() });
      const pointRecord: PointRecord = {
        orgId: scope.orgId,
        point,
        runId: scope.runId,
        seqKey: seqKey(point.seq),
        storageKey: `${key}:${seqKey(point.seq)}`,
        userId: scope.userId,
      };
      const runRecord: RunRecord = {
        nextSeq: (nextSeq + 1n).toString(),
        orgId: scope.orgId,
        run: existing?.run ?? null,
        runId: scope.runId,
        storageKey: key,
        userId: scope.userId,
      };

      transaction.objectStore(STORES.points).add(pointRecord);
      runStore.put(runRecord);
      await done;
      return point;
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async readPointBatch(scopeInput: RunScope, limit = 100): Promise<PointInput[]> {
    const scope = validateScope(scopeInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Point batch limit must be an integer from 1 to 100');
    }
    const database = await this.#open();
    const transaction = database.transaction(STORES.points, 'readonly');
    const done = transactionDone(transaction);
    const index = transaction.objectStore(STORES.points).index('by-run-seq');
    const range = this.#keyRange.bound(
      [scope.userId, scope.orgId, scope.runId, ''],
      [scope.userId, scope.orgId, scope.runId, '\uffff'],
    );
    const records = (await requestResult(index.getAll(range, limit))) as PointRecord[];
    await done;
    return records.map((record) => pointInputSchema.parse(record.point));
  }

  public async acknowledgePointBatch(
    scopeInput: RunScope,
    sequences: readonly string[],
    dataRevisionInput?: string,
  ): Promise<void> {
    const scope = validateScope(scopeInput);
    const canonical = sequences.map((seq) => pointInputSchema.shape.seq.parse(seq));
    const dataRevision = dataRevisionInput === undefined
      ? undefined
      : revisionSchema.parse(dataRevisionInput);
    const database = await this.#open();
    const transaction = database.transaction([STORES.points, STORES.runs], 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORES.points);
    const prefix = runStorageKey(scope);
    for (const seq of new Set(canonical)) {
      store.delete(`${prefix}:${seqKey(seq)}`);
    }
    if (dataRevision !== undefined) {
      const runStore = transaction.objectStore(STORES.runs);
      const record = (await requestResult(runStore.get(prefix))) as RunRecord | undefined;
      if (
        record?.run !== null
        && record?.run !== undefined
        && BigInt(dataRevision) > BigInt(record.run.dataRevision)
      ) {
        runStore.put({ ...record, run: { ...record.run, dataRevision } });
      }
    }
    await done;
  }

  public async countPoints(scopeInput: RunScope): Promise<number> {
    const scope = validateScope(scopeInput);
    const database = await this.#open();
    const transaction = database.transaction(STORES.points, 'readonly');
    const done = transactionDone(transaction);
    const range = this.#keyRange.bound(
      [scope.userId, scope.orgId, scope.runId, ''],
      [scope.userId, scope.orgId, scope.runId, '\uffff'],
    );
    const count = await requestResult(
      transaction.objectStore(STORES.points).index('by-run-seq').count(range),
    );
    await done;
    return count;
  }

  public async queueRequest(
    userIdInput: string,
    requestInput: RunnerRequest,
    confirmedRun: RunView | null,
  ): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    const request = parseRunnerRequest(requestInput);
    const run = confirmedRun === null ? null : runViewSchema.parse(confirmedRun);
    if (request.kind === 'command' && (run === null || run.runId !== request.runId)) {
      throw new Error('A durable command requires its confirmed run snapshot');
    }

    const database = await this.#open();
    const transaction = database.transaction(
      [STORES.profiles, STORES.requests, STORES.runs],
      'readwrite',
    );
    const done = transactionDone(transaction);
    try {
      const requestKey = requestIdentity(request);
      const storageKey = requestStorageKey(userId, request);
      const requestStore = transaction.objectStore(STORES.requests);
      const existing = (await requestResult(requestStore.get(storageKey))) as RequestRecord | undefined;
      const record: RequestRecord = {
        enqueuedAt: existing?.enqueuedAt ?? this.#now().toISOString(),
        request,
        requestKey,
        storageKey,
        userId,
      };
      requestStore.put(record);

      if (run !== null) {
        await this.#putRunSnapshot(transaction, userId, request.orgId, run);
      }
      await done;
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async acknowledgeStart(userIdInput: string, requestInput: StartRequest, runInput: RunView): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    const parsedRequest = parseRunnerRequest(requestInput);
    if (parsedRequest.kind !== 'start') {
      throw new Error('A start acknowledgement requires a start request');
    }
    const request = parsedRequest;
    const run = runViewSchema.parse(runInput);
    if (run.runId !== request.runId) {
      throw new Error('The acknowledged run does not match the queued start request');
    }

    const database = await this.#open();
    const transaction = database.transaction(
      [STORES.profiles, STORES.requests, STORES.runs],
      'readwrite',
    );
    const done = transactionDone(transaction);
    transaction.objectStore(STORES.requests).delete(requestStorageKey(userId, request));
    await this.#putRunSnapshot(transaction, userId, request.orgId, run);
    await done;
  }

  public async acknowledgeCommand(
    userIdInput: string,
    requestInput: CommandRequest,
    currentRunInput: RunView,
    result: RunCommandResponse,
  ): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    const parsedRequest = parseRunnerRequest(requestInput);
    if (parsedRequest.kind !== 'command') {
      throw new Error('A command acknowledgement requires a command request');
    }
    const request = parsedRequest;
    const currentRun = runViewSchema.parse(currentRunInput);
    if (currentRun.runId !== request.runId || result.commandId !== request.commandId) {
      throw new Error('The command acknowledgement does not match the queued request');
    }

    const database = await this.#open();
    const transaction = database.transaction(
      [STORES.profiles, STORES.requests, STORES.runs],
      'readwrite',
    );
    const done = transactionDone(transaction);
    transaction.objectStore(STORES.requests).delete(requestStorageKey(userId, request));
    await this.#putRunSnapshot(transaction, userId, request.orgId, commandRun(currentRun, result));
    await done;
  }

  public async acknowledgeReconciledRequest(
    userIdInput: string,
    requestInput: CommandRequest,
    runInput: RunView,
  ): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    const parsedRequest = parseRunnerRequest(requestInput);
    if (parsedRequest.kind !== 'command') {
      throw new Error('Request reconciliation requires a command request');
    }
    const run = runViewSchema.parse(runInput);
    if (run.runId !== parsedRequest.runId) {
      throw new Error('The reconciled run does not match the queued request');
    }

    const database = await this.#open();
    const transaction = database.transaction(
      [STORES.profiles, STORES.requests, STORES.runs],
      'readwrite',
    );
    const done = transactionDone(transaction);
    transaction.objectStore(STORES.requests).delete(requestStorageKey(userId, parsedRequest));
    await this.#putRunSnapshot(transaction, userId, parsedRequest.orgId, run);
    await done;
  }

  public async saveRunSnapshot(userIdInput: string, orgIdInput: string, runInput: RunView): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    const orgId = uuidSchema.parse(orgIdInput);
    const run = runViewSchema.parse(runInput);
    const database = await this.#open();
    const transaction = database.transaction([STORES.profiles, STORES.runs], 'readwrite');
    const done = transactionDone(transaction);
    await this.#putRunSnapshot(transaction, userId, orgId, run);
    await done;
  }

  public async loadRecovery(userIdInput: string): Promise<RunnerRecovery> {
    const userId = uuidSchema.parse(userIdInput);
    const database = await this.#open();
    const transaction = database.transaction(
      [STORES.points, STORES.profiles, STORES.requests, STORES.runs],
      'readonly',
    );
    const done = transactionDone(transaction);
    const profile = (await requestResult(
      transaction.objectStore(STORES.profiles).get(userId),
    )) as ProfileRecord | undefined;
    const requestRecords = (await requestResult(
      transaction.objectStore(STORES.requests).index('by-user').getAll(userId),
    )) as RequestRecord[];
    requestRecords.sort(compareRequests);

    let run: RunView | null = null;
    if (profile?.activeOrgId !== null && profile?.activeOrgId !== undefined && profile.activeRunId !== null) {
      const scope = validateScope({
        orgId: profile.activeOrgId,
        runId: profile.activeRunId,
        userId,
      });
      const record = (await requestResult(
        transaction.objectStore(STORES.runs).get(runStorageKey(scope)),
      )) as RunRecord | undefined;
      run = record?.run === null || record?.run === undefined ? null : runViewSchema.parse(record.run);
    }

    const pending = requestRecords[0];
    const request = pending === undefined ? null : parseRunnerRequest(pending.request);
    if (request?.kind === 'command' && (run === null || run.runId !== request.runId)) {
      throw new Error('Stored command has no matching confirmed run snapshot');
    }

    let pendingPointCount = 0;
    if (profile?.activeOrgId !== null && profile?.activeOrgId !== undefined && profile.activeRunId !== null) {
      const range = this.#keyRange.bound(
        [userId, profile.activeOrgId, profile.activeRunId, ''],
        [userId, profile.activeOrgId, profile.activeRunId, '\uffff'],
      );
      pendingPointCount = await requestResult(
        transaction.objectStore(STORES.points).index('by-run-seq').count(range),
      );
    }
    await done;
    return {
      orgId: request?.orgId ?? profile?.activeOrgId ?? null,
      pendingPointCount,
      request,
      run,
    };
  }

  public async clearActiveRun(userIdInput: string): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    const database = await this.#open();
    const transaction = database.transaction(STORES.profiles, 'readwrite');
    const done = transactionDone(transaction);
    const profile: ProfileRecord = { activeOrgId: null, activeRunId: null, userId };
    transaction.objectStore(STORES.profiles).put(profile);
    await done;
  }

  public async close(): Promise<void> {
    if (this.#databasePromise === null) {
      return;
    }
    const database = await this.#databasePromise;
    database.close();
    this.#databasePromise = null;
  }

  async #putRunSnapshot(
    transaction: IDBTransaction,
    userId: string,
    orgId: string,
    run: RunView,
  ): Promise<void> {
    const scope = validateScope({ orgId, runId: run.runId, userId });
    const store = transaction.objectStore(STORES.runs);
    const storageKey = runStorageKey(scope);
    const existing = (await requestResult(store.get(storageKey))) as RunRecord | undefined;
    const record: RunRecord = {
      nextSeq: existing?.nextSeq ?? '1',
      orgId: scope.orgId,
      run: latestRunSnapshot(existing?.run, run),
      runId: scope.runId,
      storageKey,
      userId: scope.userId,
    };
    store.put(record);
    const profile: ProfileRecord = {
      activeOrgId: scope.orgId,
      activeRunId: scope.runId,
      userId: scope.userId,
    };
    transaction.objectStore(STORES.profiles).put(profile);
  }

  #open(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise((resolve, reject) => {
      const request = this.#factory.open(this.#databaseName, DATABASE_VERSION);
      request.addEventListener(
        'upgradeneeded',
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORES.profiles)) {
            database.createObjectStore(STORES.profiles, { keyPath: 'userId' });
          }
          if (!database.objectStoreNames.contains(STORES.runs)) {
            database.createObjectStore(STORES.runs, { keyPath: 'storageKey' });
          }
          if (!database.objectStoreNames.contains(STORES.points)) {
            const points = database.createObjectStore(STORES.points, { keyPath: 'storageKey' });
            points.createIndex('by-run-seq', ['userId', 'orgId', 'runId', 'seqKey'], { unique: true });
          }
          if (!database.objectStoreNames.contains(STORES.requests)) {
            const requests = database.createObjectStore(STORES.requests, { keyPath: 'storageKey' });
            requests.createIndex('by-user', 'userId');
          }
        },
        { once: true },
      );
      request.addEventListener(
        'success',
        () => {
          const database = request.result;
          database.addEventListener('versionchange', () => database.close());
          resolve(database);
        },
        { once: true },
      );
      request.addEventListener(
        'error',
        () => reject(request.error ?? new Error('Unable to open IndexedDB')),
        { once: true },
      );
      request.addEventListener(
        'blocked',
        () => reject(new Error('IndexedDB upgrade is blocked by another tab')),
        { once: true },
      );
    });
    return this.#databasePromise;
  }
}

let browserStorage: IndexedDbRunnerStorage | null = null;

export function getBrowserRunnerStorage(): IndexedDbRunnerStorage {
  browserStorage ??= new IndexedDbRunnerStorage();
  return browserStorage;
}
