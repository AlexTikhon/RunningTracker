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

import { advanceDataRevision, mergeCommandResult, mergeRunSnapshot } from './run-snapshot.js';
import { parseCaptureSourceKind, type CaptureSourceKind } from './capture-source-kind.js';
import type { CommandRequest, RunnerRequest, StartRequest } from './runner-state.js';

const DATABASE_VERSION = 2;
const DEFAULT_DATABASE_NAME = 'running-tracker-runner';
const MAX_SEQ = 9_223_372_036_854_775_807n;
const MAX_SEGMENT_ID = 2_147_483_647;
const SEQ_KEY_WIDTH = MAX_SEQ.toString().length;

const STORES = {
  leases: 'leases',
  points: 'points',
  profiles: 'profiles',
  requests: 'requests',
  runs: 'runs',
} as const;

// One record per user for the lifetime of the database: its fencingToken is the durable ownership epoch. A
// release keeps the record and stamps releasedAt, because deleting it would let the next acquisition start the
// epoch again and revive every capability issued before (ADR-0053). Records written before releasedAt existed
// are live exactly while unexpired, as always.
interface WriterLeaseRecord extends WriterLease {
  releasedAt?: string;
  storageKey: string;
}

function isLiveLease(record: WriterLeaseRecord, now: Date): boolean {
  return record.releasedAt === undefined && Date.parse(record.expiresAt) > now.getTime();
}

interface ProfileRecord {
  activeOrgId: string | null;
  activeRunId: string | null;
  // Absent in profiles written before the capture source was persisted; read it only through parseCaptureSourceKind.
  captureSource?: CaptureSourceKind;
  userId: string;
}

interface RunRecord {
  uploadRejection?: string;
  nextSeq: string;
  nextSegmentId?: number;
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

export interface WriterLease {
  expiresAt: string;
  fencingToken: string;
  ownerId: string;
  userId: string;
}

export type WriterLeaseAcquisition =
  | { acquired: true; lease: WriterLease }
  | { acquired: false; lease: WriterLease };

export interface RunnerRecovery {
  uploadRejection: string | null;
  captureSource: CaptureSourceKind;
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

function captureSourceField(profile: ProfileRecord | undefined): Pick<ProfileRecord, 'captureSource'> {
  return profile?.captureSource === undefined
    ? {}
    : { captureSource: parseCaptureSourceKind(profile.captureSource) };
}

function seqKey(seq: string): string {
  return seq.padStart(SEQ_KEY_WIDTH, '0');
}

function validateLeaseDuration(leaseDurationMs: number): number {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 300_000) {
    throw new Error('Writer lease duration must be an integer from 1 to 300000 milliseconds');
  }
  return leaseDurationMs;
}

function parseWriterLease(value: WriterLeaseRecord): WriterLease {
  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error('Stored writer lease expiry is invalid');
  }
  return {
    expiresAt: expiresAt.toISOString(),
    fencingToken: revisionSchema.parse(value.fencingToken),
    ownerId: uuidSchema.parse(value.ownerId),
    userId: uuidSchema.parse(value.userId),
  };
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

function compareRequests(left: RequestRecord, right: RequestRecord): number {
  return left.enqueuedAt.localeCompare(right.enqueuedAt) || left.requestKey.localeCompare(right.requestKey);
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

  public async acquireWriterLease(
    userIdInput: string,
    ownerIdInput: string,
    leaseDurationMsInput: number,
    // Owners the caller has proven are no longer running (see writer-presence.ts): a live lease held by one of
    // them is replaced, with a new fencing token, inside the same transaction that checks it. A lease held by
    // anyone else stays a conflict, so two claimants racing for a dead owner's lease still produce one winner.
    replaceableOwnerIdsInput: readonly string[] = [],
  ): Promise<WriterLeaseAcquisition> {
    const userId = uuidSchema.parse(userIdInput);
    const ownerId = uuidSchema.parse(ownerIdInput);
    const leaseDurationMs = validateLeaseDuration(leaseDurationMsInput);
    const replaceableOwnerIds = replaceableOwnerIdsInput.map((id) => uuidSchema.parse(id));
    const now = this.#now();
    const database = await this.#open();
    const transaction = database.transaction(STORES.leases, 'readwrite');
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(STORES.leases);
      const existing = (await requestResult(store.get(userId))) as WriterLeaseRecord | undefined;
      if (
        existing !== undefined
        && existing.ownerId !== ownerId
        && !replaceableOwnerIds.includes(existing.ownerId)
        && isLiveLease(existing, now)
      ) {
        await done;
        return { acquired: false, lease: parseWriterLease(existing) };
      }

      // Only a live lease of this same owner is re-confirmed under its own token. Everything else (nothing yet,
      // expired, released, or a replaced dead owner) starts a new generation from the stored epoch.
      const sameLiveOwner = existing?.ownerId === ownerId && isLiveLease(existing, now);
      const fencingToken = sameLiveOwner
        ? revisionSchema.parse(existing.fencingToken)
        : revisionSchema.parse((BigInt(existing?.fencingToken ?? '0') + 1n).toString());
      const lease: WriterLeaseRecord = {
        expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        fencingToken,
        ownerId,
        storageKey: userId,
        userId,
      };
      store.put(lease);
      await done;
      return { acquired: true, lease: parseWriterLease(lease) };
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async renewWriterLease(
    leaseInput: WriterLease,
    leaseDurationMsInput: number,
  ): Promise<WriterLease | null> {
    const lease = parseWriterLease({ ...leaseInput, storageKey: leaseInput.userId });
    const leaseDurationMs = validateLeaseDuration(leaseDurationMsInput);
    const now = this.#now();
    const database = await this.#open();
    const transaction = database.transaction(STORES.leases, 'readwrite');
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(STORES.leases);
      const existing = (await requestResult(store.get(lease.userId))) as WriterLeaseRecord | undefined;
      if (
        existing === undefined
        || existing.ownerId !== lease.ownerId
        || existing.fencingToken !== lease.fencingToken
        || !isLiveLease(existing, now)
      ) {
        await done;
        return null;
      }
      const renewed: WriterLeaseRecord = {
        ...existing,
        expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      };
      store.put(renewed);
      await done;
      return parseWriterLease(renewed);
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async releaseWriterLease(leaseInput: WriterLease): Promise<boolean> {
    const lease = parseWriterLease({ ...leaseInput, storageKey: leaseInput.userId });
    const now = this.#now();
    const database = await this.#open();
    const transaction = database.transaction(STORES.leases, 'readwrite');
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(STORES.leases);
      const existing = (await requestResult(store.get(lease.userId))) as WriterLeaseRecord | undefined;
      // Only the current, still unreleased holder can release. The record stays: ownership ends, the epoch does not.
      const matches = existing !== undefined
        && existing.releasedAt === undefined
        && existing.ownerId === lease.ownerId
        && existing.fencingToken === lease.fencingToken;
      if (matches) {
        const released: WriterLeaseRecord = {
          ...existing,
          expiresAt: now.toISOString(),
          releasedAt: now.toISOString(),
        };
        store.put(released);
      }
      await done;
      return matches;
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async appendPoint(scopeInput: RunScope, measurement: PointMeasurement): Promise<PointInput> {
    return this.#appendPoint(scopeInput, measurement, null);
  }

  public async allocateCaptureSegment(
    scopeInput: RunScope,
    leaseInput: WriterLease,
  ): Promise<number> {
    const scope = validateScope(scopeInput);
    const lease = parseWriterLease({ ...leaseInput, storageKey: leaseInput.userId });
    if (lease.userId !== scope.userId) {
      throw new Error('Writer lease does not match the capture scope');
    }
    const database = await this.#open();
    const transaction = database.transaction([STORES.leases, STORES.runs], 'readwrite');
    const done = transactionDone(transaction);
    try {
      await this.#assertCurrentLease(transaction, lease);
      const runStore = transaction.objectStore(STORES.runs);
      const key = runStorageKey(scope);
      const existing = (await requestResult(runStore.get(key))) as RunRecord | undefined;
      if (existing?.uploadRejection !== undefined) throw new Error('Discard the rejected queue before capturing more points');
      if (existing?.run === null || existing?.run === undefined) {
        throw new Error('Capture requires a confirmed run snapshot');
      }
      const segmentId = existing.nextSegmentId ?? 0;
      if (!Number.isInteger(segmentId) || segmentId < 0 || segmentId > MAX_SEGMENT_ID) {
        throw new Error('The local capture segment is exhausted');
      }
      runStore.put({ ...existing, nextSegmentId: segmentId + 1 });
      await done;
      return segmentId;
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async appendPointForWriter(
    scopeInput: RunScope,
    measurement: PointMeasurement,
    leaseInput: WriterLease,
  ): Promise<PointInput> {
    const scope = validateScope(scopeInput);
    const lease = parseWriterLease({ ...leaseInput, storageKey: leaseInput.userId });
    if (lease.userId !== scope.userId) {
      throw new Error('Writer lease does not match the capture scope');
    }
    return this.#appendPoint(scope, measurement, lease);
  }

  async #appendPoint(
    scopeInput: RunScope,
    measurement: PointMeasurement,
    lease: WriterLease | null,
  ): Promise<PointInput> {
    const scope = validateScope(scopeInput);
    const database = await this.#open();
    const stores = lease === null
      ? [STORES.points, STORES.runs]
      : [STORES.leases, STORES.points, STORES.runs];
    const transaction = database.transaction(stores, 'readwrite');
    const done = transactionDone(transaction);
    try {
      if (lease !== null) await this.#assertCurrentLease(transaction, lease);
      const runStore = transaction.objectStore(STORES.runs);
      const key = runStorageKey(scope);
      const existing = (await requestResult(runStore.get(key))) as RunRecord | undefined;
      if (existing?.uploadRejection !== undefined) throw new Error('Discard the rejected queue before capturing more points');
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
        ...(existing?.nextSegmentId === undefined ? {} : { nextSegmentId: existing.nextSegmentId }),
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

  async #assertCurrentLease(transaction: IDBTransaction, lease: WriterLease): Promise<void> {
    const existing = (await requestResult(
      transaction.objectStore(STORES.leases).get(lease.userId),
    )) as WriterLeaseRecord | undefined;
    if (
      existing === undefined
      || existing.ownerId !== lease.ownerId
      || existing.fencingToken !== lease.fencingToken
      || !isLiveLease(existing, this.#now())
    ) {
      throw new Error('This tab no longer owns the writer lease');
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
        runStore.put({ ...record, run: advanceDataRevision(record.run, dataRevision) });
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
    await this.#putRunSnapshot(transaction, userId, request.orgId, mergeCommandResult(currentRun, result));
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
    let uploadRejection: string | null = null;
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
      uploadRejection = record?.uploadRejection ?? null;
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
      uploadRejection,
      captureSource: parseCaptureSourceKind(profile?.captureSource),
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
    const store = transaction.objectStore(STORES.profiles);
    const existing = (await requestResult(store.get(userId))) as ProfileRecord | undefined;
    const profile: ProfileRecord = {
      activeOrgId: null,
      activeRunId: null,
      ...captureSourceField(existing),
      userId,
    };
    store.put(profile);
    await done;
  }

  public async rejectUpload(scopeInput: RunScope, message: string): Promise<void> {
    const scope = validateScope(scopeInput);
    const database = await this.#open();
    const transaction = database.transaction(STORES.runs, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORES.runs);
    const record = (await requestResult(store.get(runStorageKey(scope)))) as RunRecord | undefined;
    if (record) store.put({ ...record, uploadRejection: message });
    await done;
  }

  public async exportBufferedPoints(scopeInput: RunScope): Promise<PointInput[]> {
    const scope = validateScope(scopeInput);
    const database = await this.#open();
    const transaction = database.transaction(STORES.points, 'readonly');
    const done = transactionDone(transaction);
    const range = this.#keyRange.bound([scope.userId, scope.orgId, scope.runId, ''], [scope.userId, scope.orgId, scope.runId, '\uffff']);
    const records = await requestResult(transaction.objectStore(STORES.points).index('by-run-seq').getAll(range)) as PointRecord[];
    await done;
    return records.map((record) => pointInputSchema.parse(record.point));
  }

  // Reject, capture and discard transactions serialize through the run store.
  // Resolve the blocked queue and its exact commands before clearing the pointer.
  public async discardRejectedRun(scopeInput: RunScope, lease: WriterLease): Promise<void> {
    await this.#discardActiveRun(
      scopeInput,
      lease,
      (record) => record?.uploadRejection !== undefined && record.uploadRejection !== '' && record.run?.status === 'finished',
      'Only the active rejected run can be discarded',
    );
  }

  // The local half of a run the server refuses (ADR-0052): the run is deleted or no longer accessible, so it can
  // be neither finished nor uploaded, and the ordinary discard (finished, upload rejected) can never apply. The
  // caller decides from the server's answer that the run is refused; this only fences and clears. It never talks
  // to the server and never marks the run finished.
  public async discardRefusedRun(scopeInput: RunScope, lease: WriterLease): Promise<void> {
    await this.#discardActiveRun(scopeInput, lease, () => true, 'Only the active run can be discarded');
  }

  // One transaction for everything that must change together: the lease is checked inside it, the profile must
  // still point at exactly this user, organization and run, and the buffered points, the queued requests and the
  // pointer go together or not at all. The run record stays, inactive, as it does after any discard: it holds the
  // next point sequence, so a sequence number of this run is never issued twice.
  async #discardActiveRun(
    scopeInput: RunScope,
    lease: WriterLease,
    mayDiscard: (record: RunRecord | undefined) => boolean,
    refusal: string,
  ): Promise<void> {
    const scope = validateScope(scopeInput);
    if (lease.userId !== scope.userId) throw new Error('Writer lease does not match the run');
    const database = await this.#open();
    const transaction = database.transaction([STORES.leases, STORES.points, STORES.requests, STORES.profiles, STORES.runs], 'readwrite');
    const done = transactionDone(transaction);
    try {
      await this.#assertCurrentLease(transaction, lease);
      const runs = transaction.objectStore(STORES.runs);
      const record = await requestResult(runs.get(runStorageKey(scope))) as RunRecord | undefined;
      const profiles = transaction.objectStore(STORES.profiles);
      const profile = await requestResult(profiles.get(scope.userId)) as ProfileRecord | undefined;
      if (!mayDiscard(record) || profile?.activeRunId !== scope.runId || profile.activeOrgId !== scope.orgId) {
        throw new Error(refusal);
      }
      const points = transaction.objectStore(STORES.points);
      const range = this.#keyRange.bound([scope.userId, scope.orgId, scope.runId, ''], [scope.userId, scope.orgId, scope.runId, '\uffff']);
      for (const key of await requestResult(points.index('by-run-seq').getAllKeys(range))) points.delete(key);
      const requests = transaction.objectStore(STORES.requests);
      const queued = await requestResult(requests.index('by-user').getAll(scope.userId)) as RequestRecord[];
      for (const entry of queued) {
        if (entry.request.orgId === scope.orgId && entry.request.runId === scope.runId) requests.delete(entry.storageKey);
      }
      profiles.put({ ...profile, activeRunId: null, activeOrgId: null });
      await done;
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
  }

  // The source is a per-user selection that outlives any one run, so it lives in the profile next to the active
  // run pointer and every rewrite of the profile carries it forward.
  public async saveCaptureSource(userIdInput: string, captureSource: CaptureSourceKind): Promise<void> {
    const userId = uuidSchema.parse(userIdInput);
    if (parseCaptureSourceKind(captureSource) !== captureSource) {
      throw new Error('Unknown capture source');
    }
    const database = await this.#open();
    const transaction = database.transaction(STORES.profiles, 'readwrite');
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(STORES.profiles);
      const existing = (await requestResult(store.get(userId))) as ProfileRecord | undefined;
      const profile: ProfileRecord = {
        activeOrgId: existing?.activeOrgId ?? null,
        activeRunId: existing?.activeRunId ?? null,
        captureSource,
        userId,
      };
      store.put(profile);
      await done;
    } catch (error) {
      abortTransaction(transaction);
      await done.catch(() => undefined);
      throw error;
    }
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
      ...(existing?.uploadRejection === undefined ? {} : { uploadRejection: existing.uploadRejection }),
      nextSeq: existing?.nextSeq ?? '1',
      ...(existing?.nextSegmentId === undefined ? {} : { nextSegmentId: existing.nextSegmentId }),
      orgId: scope.orgId,
      run: mergeRunSnapshot(existing?.run, run),
      runId: scope.runId,
      storageKey,
      userId: scope.userId,
    };
    store.put(record);
    const profiles = transaction.objectStore(STORES.profiles);
    const existingProfile = (await requestResult(profiles.get(scope.userId))) as ProfileRecord | undefined;
    const profile: ProfileRecord = {
      activeOrgId: scope.orgId,
      activeRunId: scope.runId,
      ...captureSourceField(existingProfile),
      userId: scope.userId,
    };
    profiles.put(profile);
  }

  #open(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise((resolve, reject) => {
      const request = this.#factory.open(this.#databaseName, DATABASE_VERSION);
      request.addEventListener(
        'upgradeneeded',
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORES.leases)) {
            database.createObjectStore(STORES.leases, { keyPath: 'storageKey' });
          }
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
