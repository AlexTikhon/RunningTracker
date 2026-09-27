import {
  revisionSchema,
  uuidSchema,
  type TrackPage,
  type TrackPoint,
} from '@running-tracker/contracts';

import {
  readLiveTrackChangesPage,
  readLiveTrackSnapshotPage,
  RunnerApiError,
  type LiveTrackScope,
} from './runner-api.js';

export interface LiveTrackState {
  algorithmVersion: string;
  points: readonly TrackPoint[];
  revision: string;
}

export interface LiveTrackStoreScope extends LiveTrackScope {
  userId: string;
}

export interface LiveTrackPageSource {
  readChanges(input: LiveTrackScope & ({ afterRevision: string } | { cursor: string })): Promise<TrackPage>;
  readSnapshot(input: LiveTrackScope & { cursor?: string }): Promise<TrackPage>;
}

interface LiveTrackEntry {
  inFlight: Promise<LiveTrackState> | null;
  requestedRevision: string | null;
  state: LiveTrackState | null;
}

interface PageChainMetadata {
  algorithmVersion: string;
  fromRevision: string | null;
  toRevision: string;
}

class LiveTrackProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LiveTrackProtocolError';
  }
}

class SnapshotRequiredError extends Error {
  public constructor() {
    super('The local live-track snapshot must be replaced');
    this.name = 'SnapshotRequiredError';
  }
}

export class LiveTrackTargetUnavailableError extends Error {
  public constructor(
    public readonly requestedRevision: string,
    public readonly receivedRevision: string,
  ) {
    super(
      `Live-track revision ${requestedRevision} was requested, but the server returned ${receivedRevision}`,
    );
    this.name = 'LiveTrackTargetUnavailableError';
  }
}

const httpPageSource: LiveTrackPageSource = {
  readChanges: readLiveTrackChangesPage,
  readSnapshot: readLiveTrackSnapshotPage,
};

function parseScope(scope: LiveTrackStoreScope): LiveTrackStoreScope {
  return {
    orgId: uuidSchema.parse(scope.orgId).toLowerCase(),
    runId: uuidSchema.parse(scope.runId).toLowerCase(),
    userId: uuidSchema.parse(scope.userId).toLowerCase(),
  };
}

function scopeKey(scope: LiveTrackStoreScope): string {
  return `${scope.userId}/${scope.orgId}/${scope.runId}`;
}

function apiScope(scope: LiveTrackStoreScope): LiveTrackScope {
  return { orgId: scope.orgId, runId: scope.runId };
}

function laterRevision(current: string | null, candidate: string): string {
  if (current === null || BigInt(candidate) > BigInt(current)) {
    return candidate;
  }
  return current;
}

function isInvalidCursor(error: unknown): boolean {
  return error instanceof RunnerApiError && error.code === 'INVALID_CURSOR';
}

function metadataFor(page: TrackPage): PageChainMetadata {
  return {
    algorithmVersion: page.algorithmVersion,
    fromRevision: page.fromRevision,
    toRevision: page.toRevision,
  };
}

function assertPageMetadata(page: TrackPage, expected: PageChainMetadata): void {
  if (
    page.algorithmVersion !== expected.algorithmVersion ||
    page.fromRevision !== expected.fromRevision ||
    page.toRevision !== expected.toRevision
  ) {
    throw new LiveTrackProtocolError('Live-track page metadata changed within one cursor chain');
  }
}

function applyPage(
  points: Map<string, TrackPoint>,
  page: TrackPage,
  previousSeq: string | null,
): string | null {
  let lastSeq = previousSeq;
  for (const point of page.upserts) {
    if (lastSeq !== null && BigInt(point.seq) <= BigInt(lastSeq)) {
      throw new LiveTrackProtocolError('Live-track pages must be strictly ordered by sequence');
    }
    points.set(point.seq, point);
    lastSeq = point.seq;
  }
  if (page.nextCursor !== null && page.upserts.length === 0) {
    throw new LiveTrackProtocolError('A live-track continuation page cannot be empty');
  }
  return lastSeq;
}

function completeState(metadata: PageChainMetadata, points: Map<string, TrackPoint>): LiveTrackState {
  return {
    algorithmVersion: metadata.algorithmVersion,
    points: [...points.values()].sort((left, right) =>
      BigInt(left.seq) < BigInt(right.seq) ? -1 : BigInt(left.seq) > BigInt(right.seq) ? 1 : 0,
    ),
    revision: metadata.toRevision,
  };
}

export class LiveTrackStore {
  readonly #entries = new Map<string, LiveTrackEntry>();
  readonly #source: LiveTrackPageSource;

  public constructor(source: LiveTrackPageSource = httpPageSource) {
    this.#source = source;
  }

  public get(scopeInput: LiveTrackStoreScope): LiveTrackState | null {
    const scope = parseScope(scopeInput);
    return this.#entries.get(scopeKey(scope))?.state ?? null;
  }

  public synchronize(
    scopeInput: LiveTrackStoreScope,
    requestedRevisionInput?: string,
  ): Promise<LiveTrackState> {
    const scope = parseScope(scopeInput);
    const key = scopeKey(scope);
    const entry = this.#entries.get(key) ?? {
      inFlight: null,
      requestedRevision: null,
      state: null,
    };
    this.#entries.set(key, entry);

    if (requestedRevisionInput !== undefined) {
      const requestedRevision = revisionSchema.parse(requestedRevisionInput);
      entry.requestedRevision = laterRevision(entry.requestedRevision, requestedRevision);
    }

    if (entry.inFlight !== null) {
      return entry.inFlight;
    }
    if (
      requestedRevisionInput !== undefined &&
      entry.state !== null &&
      BigInt(entry.state.revision) >= BigInt(requestedRevisionInput)
    ) {
      entry.requestedRevision = null;
      return Promise.resolve(entry.state);
    }

    const inFlight = this.#drain(scope, entry);
    entry.inFlight = inFlight;
    const clear = (): void => {
      if (entry.inFlight === inFlight) {
        entry.inFlight = null;
      }
    };
    void inFlight.then(clear, (error: unknown) => {
      entry.requestedRevision = null;
      clear();
      return error;
    });
    return inFlight;
  }

  async #drain(scope: LiveTrackStoreScope, entry: LiveTrackEntry): Promise<LiveTrackState> {
    let synchronizeAtLeastOnce = true;
    while (
      synchronizeAtLeastOnce ||
      (entry.requestedRevision !== null &&
        (entry.state === null || BigInt(entry.state.revision) < BigInt(entry.requestedRevision)))
    ) {
      synchronizeAtLeastOnce = false;
      const previousRevision = entry.state?.revision ?? null;
      const nextState = await this.#synchronizeOnce(scope, entry.state);
      entry.state = nextState;

      if (
        entry.requestedRevision !== null &&
        BigInt(nextState.revision) < BigInt(entry.requestedRevision) &&
        previousRevision === nextState.revision
      ) {
        throw new LiveTrackTargetUnavailableError(
          entry.requestedRevision,
          nextState.revision,
        );
      }
    }
    entry.requestedRevision = null;
    if (entry.state === null) {
      throw new LiveTrackProtocolError('Live-track synchronization completed without state');
    }
    return entry.state;
  }

  async #synchronizeOnce(
    scope: LiveTrackStoreScope,
    current: LiveTrackState | null,
  ): Promise<LiveTrackState> {
    if (current === null) {
      return this.#readSnapshotWithOneRestart(scope);
    }

    try {
      return await this.#readChanges(scope, current);
    } catch (error) {
      if (!(error instanceof SnapshotRequiredError) && !isInvalidCursor(error)) {
        throw error;
      }
      return this.#readSnapshotWithOneRestart(scope);
    }
  }

  async #readSnapshotWithOneRestart(scope: LiveTrackStoreScope): Promise<LiveTrackState> {
    try {
      return await this.#readSnapshot(scope);
    } catch (error) {
      if (!isInvalidCursor(error)) {
        throw error;
      }
      return this.#readSnapshot(scope);
    }
  }

  async #readSnapshot(scope: LiveTrackStoreScope): Promise<LiveTrackState> {
    const requestScope = apiScope(scope);
    let page = await this.#source.readSnapshot(requestScope);
    if (page.fromRevision !== null) {
      throw new LiveTrackProtocolError('A live-track snapshot page must not have a source revision');
    }
    const metadata = metadataFor(page);
    const points = new Map<string, TrackPoint>();
    const cursors = new Set<string>();
    let previousSeq: string | null = null;

    while (true) {
      assertPageMetadata(page, metadata);
      previousSeq = applyPage(points, page, previousSeq);
      if (page.nextCursor === null) {
        return completeState(metadata, points);
      }
      if (cursors.has(page.nextCursor)) {
        throw new LiveTrackProtocolError('A live-track cursor chain contains a cycle');
      }
      cursors.add(page.nextCursor);
      page = await this.#source.readSnapshot({ ...requestScope, cursor: page.nextCursor });
    }
  }

  async #readChanges(scope: LiveTrackStoreScope, current: LiveTrackState): Promise<LiveTrackState> {
    const requestScope = apiScope(scope);
    let page = await this.#source.readChanges({
      ...requestScope,
      afterRevision: current.revision,
    });
    if (
      page.algorithmVersion !== current.algorithmVersion ||
      page.fromRevision !== current.revision
    ) {
      throw new SnapshotRequiredError();
    }
    const metadata = metadataFor(page);
    const points = new Map(current.points.map((point) => [point.seq, point]));
    const cursors = new Set<string>();
    let previousSeq: string | null = null;

    while (true) {
      if (page.algorithmVersion !== current.algorithmVersion) {
        throw new SnapshotRequiredError();
      }
      assertPageMetadata(page, metadata);
      previousSeq = applyPage(points, page, previousSeq);
      if (page.nextCursor === null) {
        return completeState(metadata, points);
      }
      if (cursors.has(page.nextCursor)) {
        throw new LiveTrackProtocolError('A live-track cursor chain contains a cycle');
      }
      cursors.add(page.nextCursor);
      page = await this.#source.readChanges({ ...requestScope, cursor: page.nextCursor });
    }
  }
}
