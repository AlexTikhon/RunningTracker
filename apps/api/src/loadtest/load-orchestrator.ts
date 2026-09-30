import {
  archiveMetadataResponseSchema,
  ingestPointsResponseSchema,
  runCommandResponseSchema,
  runViewSchema,
  type PointInput,
} from '@running-tracker/contracts';

import type { ApiTarget } from './load-api-process.js';
import { runBounded, sleep } from './load-concurrency.js';
import { createLoadHttpClient, LoadRequestError, type LoadHttpClient, type LoadResponse, type LoadStream } from './load-http.js';
import type { LockSample, SampleLocks } from './load-lock-sampler.js';
import { scrapeMetrics, selectSeries } from './load-metrics-scrape.js';
import type {
  FailureKind,
  FreshPointSample,
  IngestionKind,
  IngestionSample,
  LoadFailure,
  LoadRunResult,
  MetricsSnapshot,
  ObserverReport,
  RequestSample,
  TileSample,
} from './load-result.js';
import {
  buildCatchupBatch,
  buildCatchupRange,
  buildFreshPoint,
  expectedObserversOf,
  lonLatToTile,
  planTileBurst,
  type LoadRunPlan,
  type LoadScenarioPlan,
  type TileBurstPlan,
  type TileCoordinate,
} from './load-scenario.js';
import { createLocalSession, type LoadSession } from './load-session.js';
import { FreshLatencyTracker, SseObserver } from './load-sse.js';
import { summarize } from './load-stats.js';

/** The part of the result the scenario itself produces; the CLI adds provenance and cleanup details. */
export type ScenarioReport = Pick<
  LoadRunResult,
  | 'archive'
  | 'failure'
  | 'freshLatency'
  | 'freshPoints'
  | 'http'
  | 'ingestionSummaryMs'
  | 'lockSamples'
  | 'metrics'
  | 'observers'
  | 'phases'
  | 'status'
  | 'summaryPublication'
  | 'tileSummaryMs'
  | 'warnings'
  | 'workload'
>;

/** The report plus the raw session secrets, which exist only so the result writer can prove none leaks. */
export interface ScenarioOutcome {
  report: ScenarioReport;
  secrets: string[];
}

export interface ScenarioOptions {
  api: ApiTarget;
  /** How long to wait for the last fresh points to reach their observers after the fresh phase ends. */
  drainMs?: number;
  log?: (message: string) => void;
  plan: LoadScenarioPlan;
  /** Asks the database which backends wait for a lock; when absent no lock sampling happens. */
  sampleLocks?: SampleLocks;
  signal?: AbortSignal;
  /** Deadline, from the finish command, for the summary to be published and visible. */
  summaryWaitMs?: number;
}

class UnexpectedResponseError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
    what: string,
  ) {
    super(`${what} was answered with status ${status}${code ? ` (${code})` : ''}`);
    this.name = 'UnexpectedResponseError';
  }
}

class ScenarioFailure extends Error {
  public constructor(
    public readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ScenarioFailure';
  }
}

const round3 = (value: number): number => Math.round(value * 1_000) / 1_000;
const dayMs = 24 * 60 * 60 * 1_000;
const hourMs = 60 * 60 * 1_000;
const sseFirstStateTimeoutMs = 15_000;
const maximumMetricSnapshots = 40;
const maximumLockSamples = 6_000;
/** Application rejections a saturated tile pipeline documents; recorded, not fatal. */
const sheddingCodes = new Set(['TILE_BUSY', 'TILE_TIMEOUT', 'TILE_TOO_COMPLEX']);
const snapshotFamilies = [
  'archive_tile_cache_bytes',
  'archive_tile_cache_entries',
  'archive_tile_generation_active',
  'archive_tile_generation_queue_depth',
  'db_pool_connections',
  'http_requests_in_flight',
  'live_sse_connections',
  'process_heap_used_bytes',
  'process_resident_memory_bytes',
];

function errorCodeOf(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

interface RunState {
  controlRevision: string;
  created: boolean;
  nextSeq: number;
  startedAtMs: number;
}

interface PublishedRevision {
  revision: string;
  template: string;
}

class ScenarioRun {
  readonly #api: ApiTarget;
  readonly #origin = performance.now();
  readonly #plan: LoadScenarioPlan;
  readonly #log: (message: string) => void;
  readonly #root = new AbortController();
  readonly #drainMs: number;
  readonly #summaryWaitMs: number;
  readonly #http: LoadHttpClient;

  readonly #sessions: LoadSession[] = [];
  readonly #observerReports: ObserverReport[] = [];
  readonly #streams: (LoadStream | undefined)[] = [];
  readonly #tracker = new FreshLatencyTracker();
  readonly #runStates = new Map<string, RunState>();
  readonly #seenTiles = new Set<string>();

  readonly #ingestion: IngestionSample[] = [];
  readonly #lifecycle: RequestSample[] = [];
  readonly #polls: RequestSample[] = [];
  readonly #tiles: TileSample[] = [];
  readonly #freshPoints: FreshPointSample[] = [];
  readonly #revisionSamples: { atMs: number; revision: string }[] = [];
  readonly #snapshots: MetricsSnapshot[] = [];
  readonly #lockSamples: LockSample[] = [];
  readonly #sampleLocks: SampleLocks | undefined;
  readonly #phases: { endMs: number | null; name: string; startMs: number }[] = [];
  readonly #warnings: string[] = [];

  #closing = false;
  #failure: LoadFailure | null = null;
  #freshId = 0;
  #ingestionId = 0;
  #metricsBefore: LoadRunResult['metrics']['before'] = null;
  #metricsAfter: LoadRunResult['metrics']['after'] = null;
  #phase = 'init';
  #published: PublishedRevision | null = null;
  #refreshing: Promise<void> | null = null;
  #tileBursts = 0;
  #tileRequestsStarted = 0;

  readonly #window: { from: string; to: string };
  #baselineRevision: string | null = null;
  #archiveVisibleMs: number | null = null;
  #finishAckedMs: number | null = null;
  #finishStartMs: number | null = null;
  #summaryVisibleMs: number | null = null;
  #timedOut = false;
  #tileBefore: { bytes: number; revision: string } | null = null;
  #tileAfter: { bytes: number; revision: string } | null = null;

  public constructor(private readonly options: ScenarioOptions) {
    this.#api = options.api;
    this.#sampleLocks = options.sampleLocks;
    this.#plan = options.plan;
    this.#log = options.log ?? (() => undefined);
    this.#drainMs = options.drainMs ?? 6_000;
    this.#summaryWaitMs = options.summaryWaitMs ?? options.plan.workload.freshMaxDurationMs;
    const sockets =
      this.#plan.users.length * 2 + this.#plan.workload.tileConcurrencyPerStream * 2 + 16;
    this.#http = createLoadHttpClient({ baseUrl: options.api.baseUrl, maxSockets: sockets });
    const toMs = Math.ceil(Date.now() / hourMs) * hourMs + hourMs;
    this.#window = { from: new Date(toMs - 366 * dayMs).toISOString(), to: new Date(toMs).toISOString() };
    options.signal?.addEventListener(
      'abort',
      () => this.#fail(new ScenarioFailure('load-runner', 'The load run was cancelled')),
      { once: true },
    );
  }

  #rel(at = performance.now()): number {
    return round3(at - this.#origin);
  }

  get #org(): string {
    return this.#plan.organizationId;
  }

  #fail(error: unknown): void {
    if (this.#failure) {
      return;
    }
    let kind: FailureKind = 'load-runner';
    let message = 'The load runner failed';
    if (error instanceof LoadRequestError) {
      if (error.kind === 'aborted') {
        return;
      }
      kind = error.kind;
      message = error.message;
    } else if (error instanceof UnexpectedResponseError) {
      kind = 'unexpected-response';
      message = error.message;
    } else if (error instanceof ScenarioFailure) {
      kind = error.kind;
      message = error.message;
    } else if (error instanceof Error) {
      message = `${error.name}: ${error.message}`.slice(0, 240);
    }
    this.#failure = { kind, message, phase: this.#phase };
    this.#log(`FAILED (${kind}) during ${this.#phase}: ${message}`);
    this.#root.abort(new Error(message));
  }

  async #stage<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.#phase = name;
    const entry = { endMs: null as number | null, name, startMs: this.#rel() };
    this.#phases.push(entry);
    this.#log(`phase ${name}`);
    try {
      return await work();
    } finally {
      entry.endMs = this.#rel();
    }
  }

  async #call(
    sink: RequestSample[],
    name: string,
    session: LoadSession | null,
    request: {
      body?: unknown;
      expected: readonly number[];
      method: 'GET' | 'POST' | 'PUT';
      mutate: boolean;
      path: string;
    },
  ): Promise<{ json: unknown; response: LoadResponse }> {
    const headers =
      session === null ? {} : request.mutate ? session.mutationHeaders() : session.readHeaders();
    const response = await this.#http.request({
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      headers,
      method: request.method,
      path: request.path,
      signal: this.#root.signal,
      timeoutMs: this.#plan.workload.requestTimeoutMs,
    });
    const code = response.status >= 400 ? errorCodeOf(response.body) : null;
    sink.push({
      endMs: this.#rel(response.endMs),
      errorCode: code,
      name,
      startMs: this.#rel(response.startMs),
      status: response.status,
    });
    if (!request.expected.includes(response.status)) {
      throw new UnexpectedResponseError(response.status, code, name);
    }
    const json: unknown = response.body.length > 0 ? JSON.parse(response.body.toString('utf8')) : null;
    return { json, response };
  }

  // ---- sessions, observers, baseline -------------------------------------------------------------

  async #createSessions(): Promise<void> {
    const started = performance.now();
    const created = await runBounded(
      4,
      this.#plan.users,
      (user) =>
        createLocalSession(this.#http, {
          origin: this.#api.origin,
          timeoutMs: this.#plan.workload.requestTimeoutMs,
          userId: user.id,
        }),
      this.#root.signal,
    );
    this.#sessions.push(...created);
    this.#lifecycle.push({
      endMs: this.#rel(),
      errorCode: null,
      name: 'sessions',
      startMs: this.#rel(started),
      status: 201,
    });
  }

  async #openObservers(): Promise<void> {
    const firstStates: Promise<void>[] = [];
    for (const user of this.#plan.users) {
      const index = user.index;
      const session = this.#sessions[index];
      if (!session) {
        throw new ScenarioFailure('load-runner', 'A session is missing for an observer');
      }
      const report: ObserverReport = {
        closedUnexpectedly: false,
        connectedMs: null,
        heartbeats: 0,
        index,
        protocolErrors: 0,
        reconnects: 0,
        statesReceived: 0,
      };
      this.#observerReports.push(report);
      let firstState!: () => void;
      firstStates.push(
        new Promise<void>((resolve) => {
          firstState = resolve;
        }),
      );
      const observer = new SseObserver(index, (observation) => {
        if (report.connectedMs === null) {
          report.connectedMs = this.#rel(observation.receivedAtMs);
          firstState();
        }
        this.#tracker.observe({ ...observation, receivedAtMs: observation.receivedAtMs - this.#origin });
      });
      const onEnded = (why: string): void => {
        if (this.#closing) {
          return;
        }
        report.closedUnexpectedly = true;
        this.#fail(new ScenarioFailure('sse', `An observer stream closed unexpectedly (${why})`));
      };
      const stream = await this.#http.openStream({
        headers: session.streamHeaders(),
        onChunk: (chunk, receivedAtMs) => {
          observer.feed(chunk, receivedAtMs);
          report.heartbeats = observer.counters.heartbeats;
          report.protocolErrors = observer.counters.protocolErrors;
          report.statesReceived = observer.counters.statesReceived;
        },
        onEnd: () => onEnded('ended'),
        onError: (error) => onEnded(error.message),
        path: `/api/orgs/${this.#org}/live`,
        signal: this.#root.signal,
        timeoutMs: this.#plan.workload.requestTimeoutMs,
      });
      this.#streams[index] = stream;
      if (stream.status !== 200) {
        stream.close();
        throw new ScenarioFailure('sse', `The live stream was answered with status ${stream.status}`);
      }
    }
    const waiting = new AbortController();
    const deadline = sleep(sseFirstStateTimeoutMs, AbortSignal.any([waiting.signal, this.#root.signal])).then(
      () => {
        throw new ScenarioFailure('sse', 'An observer did not receive its first state in time');
      },
    );
    try {
      await Promise.race([Promise.all(firstStates), deadline]);
    } finally {
      waiting.abort(new Error('first states received'));
      await deadline.catch(() => undefined);
    }
  }

  async #fetchMetadata(sessionIndex: number, sink: RequestSample[], name: string): Promise<string> {
    const session = this.#sessions[sessionIndex % this.#sessions.length];
    if (!session) {
      throw new ScenarioFailure('load-runner', 'No session is available for archive metadata');
    }
    const query = new URLSearchParams(this.#window);
    const { json } = await this.#call(sink, name, session, {
      expected: [200],
      method: 'GET',
      mutate: false,
      path: `/api/orgs/${this.#org}/archive/metadata?${query.toString()}`,
    });
    const metadata = archiveMetadataResponseSchema.parse(json);
    const template = metadata.tiles[0];
    if (!template) {
      throw new ScenarioFailure('unexpected-response', 'Archive metadata carried no tile template');
    }
    const previous = this.#published;
    this.#published = { revision: metadata.archiveRevision, template };
    if (previous?.revision !== metadata.archiveRevision) {
      this.#revisionSamples.push({ atMs: this.#rel(), revision: metadata.archiveRevision });
    }
    if (
      this.#finishAckedMs !== null &&
      this.#baselineRevision !== null &&
      this.#archiveVisibleMs === null &&
      BigInt(metadata.archiveRevision) > BigInt(this.#baselineRevision)
    ) {
      this.#archiveVisibleMs = this.#rel();
    }
    return metadata.archiveRevision;
  }

  async #refreshRevision(): Promise<void> {
    this.#refreshing ??= this.#fetchMetadata(1, this.#polls, 'metadata-refresh')
      .then(() => undefined)
      .finally(() => {
        this.#refreshing = null;
      });
    await this.#refreshing;
  }

  // ---- runs, shares, ingestion -----------------------------------------------------------------

  #stateOf(run: LoadRunPlan): RunState {
    const state = this.#runStates.get(run.runId);
    if (!state) {
      throw new ScenarioFailure('load-runner', 'A run was used before it was created');
    }
    return state;
  }

  #sessionOf(run: LoadRunPlan): LoadSession {
    const session = this.#sessions[run.ownerIndex];
    if (!session) {
      throw new ScenarioFailure('load-runner', 'A run owner has no session');
    }
    return session;
  }

  async #createRun(run: LoadRunPlan, catchupBatches: number): Promise<void> {
    const base = Math.floor(Date.now() / 1_000) * 1_000;
    const startedAtMs = base - this.#plan.spanMs(catchupBatches);
    const { json } = await this.#call(this.#lifecycle, 'run-create', this.#sessionOf(run), {
      body: { startedAt: new Date(startedAtMs).toISOString() },
      expected: [201],
      method: 'PUT',
      mutate: true,
      path: `/api/orgs/${this.#org}/runs/${run.runId}`,
    });
    const view = runViewSchema.parse(json);
    this.#runStates.set(run.runId, {
      controlRevision: view.controlRevision,
      created: true,
      nextSeq: 1,
      startedAtMs,
    });
    for (const share of this.#plan.shares) {
      if (share.ownerIndex !== run.ownerIndex) {
        continue;
      }
      const grantee = this.#plan.users[share.granteeIndex];
      if (!grantee) {
        continue;
      }
      await this.#call(this.#lifecycle, 'share-put', this.#sessionOf(run), {
        body: { canReadHistory: share.canReadHistory, canReadLive: share.canReadLive },
        expected: [200],
        method: 'PUT',
        mutate: true,
        path: `/api/orgs/${this.#org}/runs/${run.runId}/shares/${grantee.id}`,
      });
    }
  }

  async #ingest(
    kind: IngestionKind,
    run: LoadRunPlan,
    points: PointInput[],
    expected: { duplicate: number; inserted: number },
    round: number | null,
  ): Promise<IngestionSample> {
    const id = this.#ingestionId++;
    const session = this.#sessionOf(run);
    let response: LoadResponse;
    try {
      response = await this.#http.request({
        body: JSON.stringify({ points }),
        headers: session.mutationHeaders(),
        method: 'POST',
        path: `/api/orgs/${this.#org}/runs/${run.runId}/points`,
        signal: this.#root.signal,
        timeoutMs: this.#plan.workload.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof LoadRequestError && error.kind === 'aborted') {
        throw error;
      }
      this.#ingestion.push({
        duplicateCount: null,
        endMs: this.#rel(),
        errorCode: error instanceof LoadRequestError ? error.kind : 'runner',
        id,
        insertedCount: null,
        kind,
        pointCount: points.length,
        round,
        runIndex: run.ownerIndex,
        startMs: this.#rel(),
        status: null,
        unexpected: true,
      });
      throw error;
    }
    let insertedCount: number | null = null;
    let duplicateCount: number | null = null;
    let errorCode: string | null = null;
    if (response.status === 200) {
      const parsed = ingestPointsResponseSchema.parse(JSON.parse(response.body.toString('utf8')));
      insertedCount = parsed.insertedCount;
      duplicateCount = parsed.duplicateCount;
    } else {
      errorCode = errorCodeOf(response.body);
    }
    const unexpected =
      response.status !== 200 || insertedCount !== expected.inserted || duplicateCount !== expected.duplicate;
    const sample: IngestionSample = {
      duplicateCount,
      endMs: this.#rel(response.endMs),
      errorCode,
      id,
      insertedCount,
      kind,
      pointCount: points.length,
      round,
      runIndex: run.ownerIndex,
      startMs: this.#rel(response.startMs),
      status: response.status,
      unexpected,
    };
    this.#ingestion.push(sample);
    if (unexpected) {
      throw new UnexpectedResponseError(
        response.status,
        errorCode,
        `A ${kind} ingestion (inserted ${insertedCount ?? '-'} of expected ${expected.inserted}, duplicate ${duplicateCount ?? '-'} of expected ${expected.duplicate})`,
      );
    }
    return sample;
  }

  // ---- tiles -------------------------------------------------------------------------------------

  #tilePath(tile: TileCoordinate, published: PublishedRevision): string {
    return published.template
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));
  }

  async #fetchTile(burst: TileBurstPlan, tile: TileCoordinate, stop: AbortSignal): Promise<void> {
    if (stop.aborted) {
      return;
    }
    const session = this.#sessions[burst.viewerIndex];
    const published = this.#published;
    if (!session || !published) {
      throw new ScenarioFailure('load-runner', 'A tile request had no viewer or revision');
    }
    const key = `${burst.viewerIndex}/${tile.z}/${tile.x}/${tile.y}`;
    const repeatOfEarlier = this.#seenTiles.has(key);
    this.#seenTiles.add(key);
    this.#tileRequestsStarted += 1;
    const base = {
      burst: burst.burst,
      repeatOfEarlier,
      revision: published.revision,
      viewerIndex: burst.viewerIndex,
      zoom: tile.z,
    };
    let response: LoadResponse;
    try {
      response = await this.#http.request({
        headers: session.readHeaders(),
        method: 'GET',
        path: this.#tilePath(tile, published),
        signal: this.#root.signal,
        timeoutMs: this.#plan.workload.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof LoadRequestError && error.kind === 'aborted') {
        throw error;
      }
      this.#tiles.push({
        ...base,
        bytes: 0,
        endMs: this.#rel(),
        errorCode: error instanceof LoadRequestError ? error.kind : 'runner',
        outcome: 'transport',
        startMs: this.#rel(),
        status: null,
      });
      throw error;
    }
    const code = response.status === 200 ? null : errorCodeOf(response.body);
    let outcome: TileSample['outcome'];
    if (response.status === 200) {
      outcome = 'ok';
    } else if (response.status === 409 && code === 'ARCHIVE_REVISION_CHANGED') {
      outcome = 'revision-changed';
    } else if (code !== null && sheddingCodes.has(code)) {
      outcome = 'shed';
    } else {
      outcome = 'unexpected';
    }
    this.#tiles.push({
      ...base,
      bytes: response.status === 200 ? response.bytes : 0,
      endMs: this.#rel(response.endMs),
      errorCode: code,
      outcome,
      startMs: this.#rel(response.startMs),
      status: response.status,
    });
    if (outcome === 'unexpected') {
      throw new UnexpectedResponseError(response.status, code, 'A tile request');
    }
    if (outcome === 'revision-changed') {
      await this.#refreshRevision();
    }
  }

  async #tileStream(streamIndex: number, streams: number, stop: AbortSignal): Promise<void> {
    const conc = this.#plan.workload.tileConcurrencyPerStream;
    for (let burst = streamIndex; !stop.aborted; burst += streams) {
      const planned = planTileBurst(this.#plan, burst);
      this.#tileBursts += 1;
      await runBounded(
        conc,
        planned.requests,
        (tile) => this.#fetchTile(planned, tile, stop),
        this.#root.signal,
      );
      await sleep(this.#plan.workload.tileThinkMs, stop).catch(() => undefined);
    }
  }

  /** Fetches the tile over the summary run's route at the current revision; used before and after publication. */
  async #verificationTile(): Promise<{ bytes: number; revision: string }> {
    const published = this.#published;
    const owner = this.#sessions[this.#plan.summaryOwnerIndex];
    if (!published || !owner) {
      throw new ScenarioFailure('load-runner', 'No revision or owner for the verification tile');
    }
    const run = this.#plan.summaryRun;
    const tile = { ...lonLatToTile(run.centerLongitude, run.centerLatitude, 13), z: 13 };
    const response = await this.#http.request({
      headers: owner.readHeaders(),
      method: 'GET',
      path: this.#tilePath(tile, published),
      signal: this.#root.signal,
      timeoutMs: this.#plan.workload.requestTimeoutMs,
    });
    this.#polls.push({
      endMs: this.#rel(response.endMs),
      errorCode: response.status === 200 ? null : errorCodeOf(response.body),
      name: 'verification-tile',
      startMs: this.#rel(response.startMs),
      status: response.status,
    });
    if (response.status !== 200) {
      throw new UnexpectedResponseError(response.status, errorCodeOf(response.body), 'The verification tile');
    }
    return { bytes: response.bytes, revision: published.revision };
  }

  // ---- background loops ---------------------------------------------------------------------------

  async #pollArchive(stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      await this.#fetchMetadata(1, this.#polls, 'metadata-poll');
      await sleep(this.#plan.workload.pollIntervalMs, stop).catch(() => undefined);
    }
  }

  async #watchSummary(stop: AbortSignal): Promise<void> {
    const run = this.#plan.summaryRun;
    const deadline = (this.#finishAckedMs ?? 0) + this.#summaryWaitMs;
    while (!stop.aborted && this.#summaryVisibleMs === null) {
      const { json } = await this.#call(this.#polls, 'summary-poll', this.#sessionOf(run), {
        expected: [200],
        method: 'GET',
        mutate: false,
        path: `/api/orgs/${this.#org}/runs/${run.runId}`,
      });
      if (runViewSchema.parse(json).summary !== null) {
        this.#summaryVisibleMs = this.#rel();
        return;
      }
      if (this.#rel() > deadline) {
        this.#timedOut = true;
        throw new ScenarioFailure('timeout', 'The summary was not published within the deadline');
      }
      await sleep(this.#plan.workload.pollIntervalMs, stop).catch(() => undefined);
    }
  }

  async #snapshotMetrics(stop: AbortSignal): Promise<void> {
    const url = this.#api.metricsUrl;
    if (url === null) {
      return;
    }
    while (!stop.aborted && this.#snapshots.length < maximumMetricSnapshots) {
      await sleep(this.#plan.workload.metricsSnapshotIntervalMs, stop).catch(() => undefined);
      if (stop.aborted) {
        return;
      }
      const series = selectSeries(await scrapeMetrics(url, this.#root.signal), snapshotFamilies);
      this.#snapshots.push({ atMs: this.#rel(), series });
    }
  }

  /**
   * Samples which backends wait for a lock on the scenario clock. A failing sampler (for example a role that
   * may not read the catalogs) ends sampling with a warning and never fails the run; the warning carries the
   * error class only because a database message can quote object names.
   */
  async #sampleLockWaits(stop: AbortSignal): Promise<void> {
    const sample = this.#sampleLocks;
    if (sample === undefined) {
      return;
    }
    while (!stop.aborted && this.#lockSamples.length < maximumLockSamples) {
      try {
        const waits = await sample();
        this.#lockSamples.push({ atMs: this.#rel(), waits });
      } catch (error) {
        const errorClass = error instanceof Error ? error.constructor.name : 'NonError';
        this.#warnings.push(`Lock sampling stopped after ${this.#lockSamples.length} samples (${errorClass})`);
        return;
      }
      await sleep(this.#plan.workload.lockSampleIntervalMs, stop).catch(() => undefined);
    }
  }

  // ---- the scenario ---------------------------------------------------------------------------------

  async #fresh(): Promise<void> {
    const { workload } = this.#plan;
    const runs = this.#plan.activeRuns;
    const startedAt = performance.now();
    const summaryReady = (): boolean => this.#summaryVisibleMs !== null && this.#archiveVisibleMs !== null;
    const finished = (): boolean =>
      performance.now() - startedAt >= workload.freshMinDurationMs && summaryReady();
    const firstFresh = new Set<string>();

    await Promise.all(
      runs.map(async (run, position) => {
        const state = this.#stateOf(run);
        const observers = expectedObserversOf(this.#plan, run.ownerIndex);
        const offset = Math.floor((position * workload.freshIntervalMs) / runs.length);
        for (let tick = 0; ; tick += 1) {
          const dueAt = startedAt + offset + tick * workload.freshIntervalMs;
          await sleep(Math.max(0, dueAt - performance.now()), this.#root.signal);
          if (finished()) {
            return;
          }
          const seq = state.nextSeq++;
          const recordedAtMs = Date.now();
          const point = buildFreshPoint(this.#plan, run, state.startedAtMs, seq, recordedAtMs);
          const sampleId = this.#freshId++;
          const measuredMs = this.#rel();
          this.#tracker.register({
            expectedObservers: observers,
            measuredAtMs: measuredMs,
            runId: run.runId,
            sampleId,
            seq: BigInt(seq),
          });
          const bridge = !firstFresh.has(run.runId);
          firstFresh.add(run.runId);
          const sample = await this.#ingest('fresh', run, [point], { duplicate: 0, inserted: 1 }, null);
          this.#freshPoints.push({
            ackedMs: sample.endMs,
            bridge,
            ingestionId: sample.id,
            measuredMs,
            runIndex: run.ownerIndex,
            sampleId,
            seq: String(seq),
          });
        }
      }),
    );
  }

  async #mainFlow(): Promise<void> {
    const plan = this.#plan;
    const { workload } = plan;
    const users = plan.users.length;

    await this.#stage('setup', async () => {
      const summaryRun = plan.summaryRun;
      await this.#createRun(summaryRun, workload.summaryRunBatches);
      const summaryState = this.#stateOf(summaryRun);
      for (let batch = 0; batch < workload.summaryRunBatches; batch += 1) {
        await this.#ingest(
          'setup',
          summaryRun,
          buildCatchupRange(summaryRun, summaryState.startedAtMs, batch * 100 + 1, 100).points,
          { duplicate: 0, inserted: 100 },
          batch,
        );
      }
      summaryState.nextSeq = workload.summaryRunBatches * 100 + 1;
      // The summary owner's active run is created after the summary run is finished (one active run per member).
      await runBounded(
        4,
        plan.activeRuns.filter((run) => run.ownerIndex !== plan.summaryOwnerIndex),
        (run) => this.#createRun(run, workload.catchupRounds),
        this.#root.signal,
      );
      this.#baselineRevision = await this.#fetchMetadata(1, this.#polls, 'metadata-baseline');
      const before = await this.#verificationTile();
      this.#tileBefore = before;
    });

    const background = new AbortController();
    const loopSignal = AbortSignal.any([background.signal, this.#root.signal]);
    const streams = this.#plan.workload.tileStreams;
    const backgroundTasks: Promise<void>[] = [];
    const guard = (work: Promise<void>): Promise<void> =>
      work.catch((error: unknown) => {
        this.#fail(error);
      });

    try {
      await this.#stage('window-open', async () => {
        backgroundTasks.push(
          guard(this.#pollArchive(loopSignal)),
          guard(this.#snapshotMetrics(loopSignal)),
          guard(this.#sampleLockWaits(loopSignal)),
        );
        // Finish the summary run, then let its owner start the active run. The tile bursts start only after
        // this hand-over: it takes the organization lock for its share changes, and a lifecycle step queued
        // behind the bursts would measure the hand-over, not the concurrent workload.
        const summaryRun = plan.summaryRun;
        const summaryState = this.#stateOf(summaryRun);
        this.#finishStartMs = this.#rel();
        const { json } = await this.#call(this.#lifecycle, 'run-finish', this.#sessionOf(summaryRun), {
          body: {
            commandId: summaryRun.commandIds.finish,
            expectedControlRevision: summaryState.controlRevision,
            type: 'finish',
          },
          expected: [200],
          method: 'POST',
          mutate: true,
          path: `/api/orgs/${this.#org}/runs/${summaryRun.runId}/commands`,
        });
        runCommandResponseSchema.parse(json);
        this.#finishAckedMs = this.#rel();
        backgroundTasks.push(guard(this.#watchSummary(loopSignal)));
        const ownerRun = plan.activeRuns.find((run) => run.ownerIndex === plan.summaryOwnerIndex);
        if (!ownerRun) {
          throw new ScenarioFailure('load-runner', 'The summary owner has no active run');
        }
        await this.#createRun(ownerRun, workload.catchupRounds);
        backgroundTasks.push(
          ...Array.from({ length: streams }, (_, index) => guard(this.#tileStream(index, streams, loopSignal))),
        );
      });

      await this.#stage('catchup', async () => {
        for (let round = 0; round < workload.catchupRounds; round += 1) {
          await runBounded(
            users,
            plan.activeRuns,
            (run) =>
              this.#ingest(
                'catchup',
                run,
                buildCatchupBatch(plan, run, this.#stateOf(run).startedAtMs, round).points,
                { duplicate: 0, inserted: 100 },
                round,
              ),
            this.#root.signal,
          );
          for (const run of plan.activeRuns) {
            this.#stateOf(run).nextSeq = (round + 1) * 100 + 1;
          }
        }
      });

      await this.#stage('retries', async () => {
        const rounds = workload.catchupRounds;
        const first = plan.activeRuns[0];
        const second = plan.activeRuns[1 % users];
        if (!first || !second) {
          throw new ScenarioFailure('load-runner', 'Not enough runs for the retry checks');
        }
        await runBounded(
          2,
          ['exact', 'overlap'] as const,
          async (kind) => {
            if (kind === 'exact') {
              await this.#ingest(
                'retry-exact',
                first,
                buildCatchupBatch(plan, first, this.#stateOf(first).startedAtMs, 0).points,
                { duplicate: 100, inserted: 0 },
                0,
              );
            } else {
              // A response was lost after the last batch committed: 50 points repeat and 50 are new.
              await this.#ingest(
                'retry-overlap',
                second,
                buildCatchupRange(second, this.#stateOf(second).startedAtMs, rounds * 100 - 49, 100).points,
                { duplicate: 50, inserted: 50 },
                rounds - 1,
              );
              this.#stateOf(second).nextSeq = rounds * 100 + 51;
            }
          },
          this.#root.signal,
        );
      });

      await this.#stage('fresh', () => this.#fresh());

      await this.#stage('drain', async () => {
        const deadline = performance.now() + this.#drainMs;
        while (this.#tracker.unresolved().length > 0 && performance.now() < deadline) {
          await sleep(100, this.#root.signal);
        }
        if (this.#summaryVisibleMs === null || this.#archiveVisibleMs === null) {
          throw new ScenarioFailure('timeout', 'The summary was not visible when the fresh phase ended');
        }
      });

      await this.#stage('verification', async () => {
        await this.#fetchMetadata(1, this.#polls, 'metadata-final');
        this.#tileAfter = await this.#verificationTile();
      });
    } finally {
      background.abort();
      await Promise.allSettled(backgroundTasks);
    }
  }

  async execute(): Promise<ScenarioOutcome> {
    try {
      if (this.#api.metricsUrl !== null) {
        this.#metricsBefore = await scrapeMetrics(this.#api.metricsUrl, this.#root.signal);
      }
      await this.#stage('sessions', () => this.#createSessions());
      await this.#stage('baseline', async () => {
        await this.#fetchMetadata(1, this.#polls, 'metadata-initial');
      });
      await this.#stage('observers', () => this.#openObservers());
      await this.#mainFlow();
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#closing = true;
      for (const stream of this.#streams) {
        stream?.close();
      }
      if (this.#api.metricsUrl !== null && !(this.#failure?.kind === 'transport')) {
        try {
          this.#metricsAfter = await scrapeMetrics(this.#api.metricsUrl, AbortSignal.timeout(10_000));
        } catch {
          this.#warnings.push('The final metrics scrape failed');
        }
      }
      this.#http.close();
    }
    return { report: this.#report(), secrets: this.#sessions.flatMap((session) => session.secrets()) };
  }

  #report(): ScenarioReport {
    const fresh = this.#tracker.results();
    const bridgeIds = new Set(this.#freshPoints.filter((point) => point.bridge).map((point) => point.sampleId));
    const unresolved = this.#tracker.unresolved();
    if (!this.#failure && unresolved.length > 0) {
      this.#warnings.push(`${unresolved.length} fresh point observations never arrived`);
    }
    if (!this.#failure && this.#observerReports.some((report) => report.protocolErrors > 0)) {
      this.#failure = { kind: 'sse', message: 'An observer stream carried a protocol error', phase: 'report' };
    }
    const shed = this.#tiles.filter((tile) => tile.outcome === 'shed').length;
    if (shed > 0) {
      this.#warnings.push(`${shed} tile requests were shed by the application`);
    }

    const byKind = new Map<string, number[]>();
    for (const sample of this.#ingestion) {
      const list = byKind.get(sample.kind) ?? [];
      list.push(round3(sample.endMs - sample.startMs));
      byKind.set(sample.kind, list);
    }
    const byZoom = new Map<string, number[]>();
    for (const sample of this.#tiles.filter((tile) => tile.outcome === 'ok')) {
      const key = `z${sample.zoom}`;
      const list = byZoom.get(key) ?? [];
      list.push(round3(sample.endMs - sample.startMs));
      byZoom.set(key, list);
    }

    const before = this.#tileBefore;
    const after = this.#tileAfter;
    const catchupSamples = this.#ingestion.filter((sample) => sample.kind === 'catchup');
    const clean = this.#failure === null;
    return {
      archive: { revisionSamples: this.#revisionSamples, window: this.#window },
      failure: this.#failure,
      freshLatency: {
        samples: fresh,
        summaryMs: summarize(fresh.filter((sample) => !bridgeIds.has(sample.sampleId)).map((sample) => sample.latencyMs)),
        unresolved: unresolved.length,
      },
      freshPoints: this.#freshPoints,
      http: { ingestion: this.#ingestion, lifecycle: this.#lifecycle, polls: this.#polls, tiles: this.#tiles },
      ingestionSummaryMs: Object.fromEntries([...byKind].map(([kind, values]) => [kind, summarize(values)])),
      lockSamples: this.#lockSamples,
      metrics: { after: this.#metricsAfter, before: this.#metricsBefore, snapshots: this.#snapshots },
      observers: this.#observerReports,
      phases: this.#phases,
      status: clean ? 'ok' : 'failed',
      summaryPublication: {
        archiveRevisionAfter: after?.revision ?? null,
        archiveRevisionBefore: this.#baselineRevision,
        archiveRevisionVisibleMs: this.#archiveVisibleMs,
        finishAckedMs: this.#finishAckedMs,
        finishStartMs: this.#finishStartMs,
        summaryVisibleMs: this.#summaryVisibleMs,
        tileVerification:
          before && after
            ? {
                afterBytes: after.bytes,
                beforeBytes: before.bytes,
                changed: after.bytes !== before.bytes,
                revisionAfter: after.revision,
                revisionBefore: before.revision,
              }
            : null,
        timedOut: this.#timedOut,
      },
      tileSummaryMs: Object.fromEntries([...byZoom].map(([zoom, values]) => [zoom, summarize(values)])),
      warnings: this.#warnings,
      workload: {
        activeRuns: this.#plan.activeRuns.length,
        catchupPoints: catchupSamples.reduce((total, sample) => total + sample.pointCount, 0),
        catchupRequests: catchupSamples.length,
        freshPointsSent: this.#freshPoints.length,
        ingestionConcurrency: this.#plan.users.length,
        observers: this.#plan.users.length,
        summaryJobs: 1,
        tileBursts: this.#tileBursts,
        tileRequests: this.#tileRequestsStarted,
      },
    };
  }
}

/**
 * Runs the scenario end to end against a started API: real sessions, SSE observers, offline catch-up
 * batches, fresh points, archive tile bursts, and a real run finish that the summary worker publishes. It
 * never throws for a scenario failure; the failure is part of the report so a partial result can be written.
 */
export async function runLoadScenario(options: ScenarioOptions): Promise<ScenarioOutcome> {
  return await new ScenarioRun(options).execute();
}

