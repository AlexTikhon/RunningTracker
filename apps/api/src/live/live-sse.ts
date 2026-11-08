import {
  liveEventName,
  liveStateSchema,
  type LiveState,
} from '@running-tracker/contracts';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { SessionManager } from '../auth/session-manager.js';
import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import { defaultLogger, describeError, type Logger } from '../observability/logger.js';
import { readLiveState, type LiveStateSnapshot } from './live-state.js';

export interface LiveSubscription {
  orgId: string;
  session: Pick<StoredSession, 'expiresAt' | 'tokenDigest' | 'userId'>;
}

export type ReadLiveState = (subscription: LiveSubscription) => Promise<LiveStateSnapshot>;

export interface LiveStreamResponse {
  end(): void;
  flushHeaders?(): void;
  on(event: 'close' | 'drain', listener: () => void): this;
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
}

export interface LiveStreamRequest {
  on(event: 'aborted', listener: () => void): unknown;
}

export interface LiveConnectionManager {
  connect(
    subscription: LiveSubscription,
    request: LiveStreamRequest,
    response: LiveStreamResponse,
  ): Promise<void>;
}

interface LiveConnection {
  blocked: boolean;
  blockedTimeout: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  expiryTimeout: ReturnType<typeof setTimeout> | undefined;
  id: number;
  nextSequence: number;
  pending: LiveStateSnapshot | undefined;
  response: LiveStreamResponse;
  session: LiveSubscription['session'];
  streamId: string;
  subscriptionKey: string;
}

export interface LiveSseHubOptions {
  backpressureTimeoutMs: number;
  clock: Clock;
  heartbeatIntervalMs: number;
  logger?: Logger;
  maxConnections: number;
  metrics?: ApiMetrics['live'];
  pollConcurrency: number;
  pollIntervalMs: number;
  readState: ReadLiveState;
  streamIdGenerator?: () => string;
  /**
   * Asks the session store whether this session is still live (ADR-0080). Only a resolved `true` keeps a connection;
   * `false`, a rejection (store unreachable or timed out) or anything else closes it.
   */
  validateSession: (session: LiveSubscription['session']) => Promise<boolean>;
}

function subscriptionKey(subscription: LiveSubscription): string {
  return `${subscription.session.userId}:${subscription.orgId}`;
}

function eventFrame(state: LiveState): string {
  return `event: ${liveEventName}\ndata: ${JSON.stringify(state)}\n\n`;
}

export class LiveSseHub implements LiveConnectionManager {
  readonly #backpressureTimeoutMs: number;
  readonly #clock: Clock;
  readonly #connections = new Map<number, LiveConnection>();
  readonly #heartbeatIntervalMs: number;
  readonly #logger: Logger;
  readonly #maxConnections: number;
  readonly #metrics: ApiMetrics['live'] | undefined;
  readonly #pollConcurrency: number;
  readonly #pollIntervalMs: number;
  readonly #readState: ReadLiveState;
  readonly #streamIdGenerator: () => string;
  readonly #validateSession: LiveSseHubOptions['validateSession'];
  readonly #subscriptions = new Map<string, LiveSubscription>();
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #nextConnectionId = 1;
  #openingConnections = 0;
  #polling = false;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #sessionCheck: Promise<void> | undefined;
  #stopped = false;

  public constructor({
    backpressureTimeoutMs,
    clock,
    heartbeatIntervalMs,
    logger = defaultLogger,
    maxConnections,
    metrics,
    pollConcurrency,
    pollIntervalMs,
    readState,
    streamIdGenerator = randomUUID,
    validateSession,
  }: LiveSseHubOptions) {
    this.#backpressureTimeoutMs = backpressureTimeoutMs;
    this.#clock = clock;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#logger = logger;
    this.#maxConnections = maxConnections;
    this.#metrics = metrics;
    this.#pollConcurrency = pollConcurrency;
    this.#pollIntervalMs = pollIntervalMs;
    this.#readState = readState;
    this.#streamIdGenerator = streamIdGenerator;
    this.#validateSession = validateSession;
  }

  public async connect(
    subscription: LiveSubscription,
    request: LiveStreamRequest,
    response: LiveStreamResponse,
  ): Promise<void> {
    if (this.#stopped) {
      throw new ApiError(503, 'LIVE_UNAVAILABLE', 'Live streaming is shutting down');
    }
    if (this.#connections.size + this.#openingConnections >= this.#maxConnections) {
      this.#metrics?.rejected.inc();
      throw new ApiError(503, 'LIVE_CONNECTION_LIMIT', 'The live connection limit is reached');
    }

    // Counted from here, so that concurrent openings awaiting the store cannot overshoot the limit together. A store
    // that cannot answer rejects the opening (503 via the error handler) before any header is sent.
    this.#openingConnections += 1;
    let initial: LiveStateSnapshot;
    try {
      if ((await this.#validateSession(subscription.session)) !== true) {
        throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
      }
      initial = await this.#readState(subscription);
      if (this.#stopped) {
        throw new ApiError(503, 'LIVE_UNAVAILABLE', 'Live streaming is shutting down');
      }
      if ((await this.#validateSession(subscription.session)) !== true) {
        throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
      }
    } finally {
      this.#openingConnections -= 1;
    }

    if (this.#stopped) {
      throw new ApiError(503, 'LIVE_UNAVAILABLE', 'Live streaming is shutting down');
    }

    const id = this.#nextConnectionId++;
    const key = subscriptionKey(subscription);
    const connection: LiveConnection = {
      blocked: false,
      blockedTimeout: undefined,
      closed: false,
      expiryTimeout: undefined,
      id,
      nextSequence: 0,
      pending: undefined,
      response,
      session: subscription.session,
      streamId: this.#streamIdGenerator(),
      subscriptionKey: key,
    };

    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    this.#connections.set(id, connection);
    this.#subscriptions.set(key, subscription);
    this.#metrics?.opened.inc();
    this.#metrics?.connections.set({}, this.#connections.size);
    const close = (): void => this.#closeConnection(connection, false);
    request.on('aborted', close);
    response.on('close', close);
    response.on('drain', () => this.#drain(connection));
    this.#writeState(connection, initial);
    if (!connection.closed) {
      connection.expiryTimeout = this.#clock.setTimeout(
        () => this.#closeConnection(connection, true),
        Math.max(0, subscription.session.expiresAt.getTime() - this.#clock.utcNow().getTime()),
      );
    }
    this.#ensureTimers();
  }

  public stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#clearTimers();
    for (const connection of [...this.#connections.values()]) {
      this.#closeConnection(connection, true);
    }
  }

  async #poll(): Promise<void> {
    this.#pollTimer = undefined;
    if (this.#stopped || this.#connections.size === 0) {
      return;
    }
    this.#polling = true;
    const cycleStartedAt = this.#clock.monotonicNow();
    // Every cycle first asks the store about every open session; only connections that pass receive this cycle's
    // private state. So a revocation committed on any instance stops delivery within one poll interval plus one cycle.
    await this.#checkSessions();
    if (this.#stopped || this.#connections.size === 0) {
      this.#polling = false;
      return;
    }

    const entries = [...this.#subscriptions.entries()];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        if (!entry) {
          continue;
        }
        const [key, subscription] = entry;
        try {
          const snapshot = await this.#readState(subscription);
          for (const connection of this.#connections.values()) {
            if (connection.subscriptionKey === key) {
              this.#publish(connection, snapshot);
            }
          }
        } catch (error) {
          if (error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403)) {
            this.#closeSubscription(key);
            continue;
          }
          this.#metrics?.pollFailures.inc();
          this.#logger.error('live.poll.failed', describeError(error));
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.#pollConcurrency, entries.length) }, () => worker()),
    );
    this.#polling = false;
    this.#metrics?.pollSeconds.observe(
      {},
      Math.max(0, (this.#clock.monotonicNow() - cycleStartedAt) / 1_000),
    );
    if (!this.#stopped && this.#connections.size > 0) {
      this.#pollTimer = this.#clock.setTimeout(() => void this.#poll(), this.#pollIntervalMs);
    }
  }

  #publish(connection: LiveConnection, snapshot: LiveStateSnapshot): void {
    // The session passed this cycle's check (#checkSessions) or the connection would be closed already.
    if (connection.closed) {
      return;
    }
    if (connection.blocked) {
      connection.pending = snapshot;
      return;
    }
    this.#writeState(connection, snapshot);
  }

  #writeState(connection: LiveConnection, snapshot: LiveStateSnapshot): void {
    if (connection.nextSequence > Number.MAX_SAFE_INTEGER) {
      this.#closeConnection(connection, true);
      return;
    }
    try {
      const state = liveStateSchema.parse({
        ...snapshot,
        sequence: connection.nextSequence,
        streamId: connection.streamId,
      });
      const writable = connection.response.write(eventFrame(state));
      connection.nextSequence += 1;
      if (!writable) {
        this.#block(connection);
      }
    } catch {
      this.#closeConnection(connection, true);
    }
  }

  #block(connection: LiveConnection): void {
    connection.blocked = true;
    connection.blockedTimeout = this.#clock.setTimeout(() => {
      this.#metrics?.backpressureCloses.inc();
      this.#closeConnection(connection, true);
    }, this.#backpressureTimeoutMs);
  }

  #drain(connection: LiveConnection): void {
    // The pending snapshot belongs to the latest cycle, whose session check this still-open connection passed.
    if (connection.closed || !connection.blocked) {
      return;
    }
    connection.blocked = false;
    if (connection.blockedTimeout) {
      this.#clock.clearTimeout(connection.blockedTimeout);
      connection.blockedTimeout = undefined;
    }
    const pending = connection.pending;
    connection.pending = undefined;
    if (pending) {
      this.#writeState(connection, pending);
    }
  }

  #heartbeat(): void {
    this.#heartbeatTimer = undefined;
    if (this.#stopped || this.#connections.size === 0) {
      return;
    }
    for (const connection of this.#connections.values()) {
      // A comment line carries no private state; session checks run with every poll cycle instead.
      if (connection.closed || connection.blocked) {
        continue;
      }
      try {
        if (!connection.response.write(': heartbeat\n\n')) {
          this.#block(connection);
        }
      } catch {
        this.#closeConnection(connection, true);
      }
    }
    if (!this.#stopped && this.#connections.size > 0) {
      this.#heartbeatTimer = this.#clock.setTimeout(
        () => this.#heartbeat(),
        this.#heartbeatIntervalMs,
      );
    }
  }

  #ensureTimers(): void {
    if (!this.#pollTimer && !this.#polling) {
      this.#pollTimer = this.#clock.setTimeout(() => void this.#poll(), this.#pollIntervalMs);
    }
    if (!this.#heartbeatTimer) {
      this.#heartbeatTimer = this.#clock.setTimeout(
        () => this.#heartbeat(),
        this.#heartbeatIntervalMs,
      );
    }
  }

  #clearTimers(): void {
    if (this.#pollTimer) {
      this.#clock.clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#heartbeatTimer) {
      this.#clock.clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  /**
   * One store question per distinct open session, at most `pollConcurrency` at a time, each bounded by the store's
   * own deadline. Single flight: a caller arriving while a check runs waits for that check instead of starting
   * another. No database connection is held between checks. A session that is not confirmed live, because the
   * store said so or because it could not answer, has all its connections closed (fail closed); the browser
   * reconnects through the authenticated route, which answers 401 or 503 as appropriate.
   */
  #checkSessions(): Promise<void> {
    this.#sessionCheck ??= this.#runSessionCheck().finally(() => {
      this.#sessionCheck = undefined;
    });
    return this.#sessionCheck;
  }

  async #runSessionCheck(): Promise<void> {
    const bySession = new Map<string, LiveConnection[]>();
    for (const connection of this.#connections.values()) {
      const key = `${connection.session.tokenDigest}:${connection.session.userId}`;
      const group = bySession.get(key);
      if (group) group.push(connection);
      else bySession.set(key, [connection]);
    }
    const groups = [...bySession.values()];
    let cursor = 0;
    let failures = 0;
    const worker = async (): Promise<void> => {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        const first = group?.[0];
        if (!group || !first) continue;
        let active = false;
        try {
          active = (await this.#validateSession(first.session)) === true;
        } catch {
          failures += 1;
        }
        if (!active) {
          for (const connection of group) this.#closeConnection(connection, true);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#pollConcurrency, groups.length) }, () => worker()));
    if (failures > 0) {
      // Counts only: never a digest, user or connection identifier.
      this.#logger.warn('live.session_check.failed', { failedSessions: failures, reason: 'store_unavailable' });
    }
  }

  #closeSubscription(subscriptionKey: string): void {
    for (const connection of [...this.#connections.values()]) {
      if (connection.subscriptionKey === subscriptionKey) {
        this.#closeConnection(connection, true);
      }
    }
  }

  #closeConnection(connection: LiveConnection, endResponse: boolean): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.blockedTimeout) {
      this.#clock.clearTimeout(connection.blockedTimeout);
    }
    if (connection.expiryTimeout) {
      this.#clock.clearTimeout(connection.expiryTimeout);
    }
    connection.pending = undefined;
    this.#connections.delete(connection.id);
    this.#metrics?.connections.set({}, this.#connections.size);
    if (![...this.#connections.values()].some((item) => item.subscriptionKey === connection.subscriptionKey)) {
      this.#subscriptions.delete(connection.subscriptionKey);
    }
    if (endResponse) {
      connection.response.end();
    }
    if (this.#connections.size === 0) {
      this.#clearTimers();
    }
  }
}

export function createLiveSseHub(options: {
  clock: Clock;
  config: Environment;
  logger?: Logger;
  metrics?: ApiMetrics['live'];
  pool: Pick<Pool, 'connect'>;
  sessionManager: SessionManager;
}): LiveSseHub {
  const { clock, config, logger, metrics, pool, sessionManager } = options;
  return new LiveSseHub({
    backpressureTimeoutMs: config.LIVE_SSE_BACKPRESSURE_TIMEOUT_MS,
    clock,
    heartbeatIntervalMs: config.LIVE_SSE_HEARTBEAT_INTERVAL_MS,
    ...(logger ? { logger } : {}),
    maxConnections: config.LIVE_SSE_MAX_CONNECTIONS,
    ...(metrics ? { metrics } : {}),
    pollConcurrency: config.LIVE_SSE_POLL_CONCURRENCY,
    pollIntervalMs: config.LIVE_SSE_POLL_INTERVAL_MS,
    readState: ({ orgId, session }) =>
      // The poll reads a few live rows every cycle: it declares the narrow scope so the run visibility
      // policies do not build the identity's whole readable set for it (migration 0019).
      withAuthenticatedTenantTransaction(
        pool,
        session,
        orgId,
        (client) => readLiveState(client, orgId),
        { visibilityScope: 'live' },
      ),
    validateSession: (session) => sessionManager.isActive(session),
  });
}
