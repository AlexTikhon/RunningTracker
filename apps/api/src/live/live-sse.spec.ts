import { EventEmitter } from 'node:events';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type { Clock } from '../clock.js';
import { validateEnvironment } from '../config/environment.js';
import { createApiMetrics } from '../observability/api-metrics.js';
import { createLogger } from '../observability/logger.js';
import type { DatabasePool } from '../database/database.js';
import { ApiError } from '../http/errors.js';
import {
  LiveSseHub,
  type LiveConnectionManager,
  type ReadLiveState,
  type LiveStreamResponse,
} from './live-sse.js';
import type { LiveStateSnapshot } from './live-state.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';

interface ScheduledTimer {
  callback: () => void;
  dueAt: number;
}

function controlledClock(): Clock & { advanceBy(milliseconds: number): void } {
  let now = Date.parse('2031-01-01T00:00:00.000Z');
  let nextHandle = 1;
  const timers = new Map<ReturnType<typeof setTimeout>, ScheduledTimer>();

  return {
    advanceBy(milliseconds) {
      now += milliseconds;
      for (const [handle, timer] of [...timers]) {
        if (timer.dueAt <= now) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    monotonicNow: () => now,
    setTimeout(callback, delayMs) {
      const handle = nextHandle as unknown as ReturnType<typeof setTimeout>;
      nextHandle += 1;
      timers.set(handle, { callback, dueAt: now + delayMs });
      return handle;
    },
    utcNow: () => new Date(now),
  };
}

class FakeStreamResponse extends EventEmitter implements LiveStreamResponse {
  public readonly chunks: string[] = [];
  public readonly headers = new Map<string, string>();
  public ended = false;
  public writeResults: boolean[] = [];

  public end(): void {
    this.ended = true;
  }

  public setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writeResults.shift() ?? true;
  }
}

function snapshot(index: number): LiveStateSnapshot {
  return {
    algorithmVersion: 'v1',
    runs: [],
    serverTime: new Date(Date.parse('2031-01-01T00:00:00.000Z') + index * 1_000).toISOString(),
  };
}

function subscription(tokenDigest = 'session-1') {
  return {
    orgId,
    session: {
      expiresAt: new Date('2031-01-01T01:00:00.000Z'),
      tokenDigest,
      userId,
    },
  };
}

function snapshotWithRun(index: number): LiveStateSnapshot {
  return {
    ...snapshot(index),
    runs: [
      {
        dataRevision: '1',
        position: null,
        runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'recording',
      },
    ],
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function eventData(frame: string): Record<string, unknown> {
  const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (!line) {
    throw new Error('Expected an SSE data line');
  }
  return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
}

describe('LiveSseHub', () => {
  it('sends immediate state and shares each poll read across matching tab connections', async () => {
    const clock = controlledClock();
    let readIndex = 0;
    const readState = vi.fn<ReadLiveState>(() => Promise.resolve(snapshot(readIndex++)));
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 4,
      pollConcurrency: 2,
      pollIntervalMs: 2_000,
      readState,
      streamIdGenerator: () => '99999999-9999-4999-8999-999999999999',
      validateSession: () => true,
    });
    const first = new FakeStreamResponse();
    const second = new FakeStreamResponse();
    const firstRequest = new EventEmitter();
    const secondRequest = new EventEmitter();

    await hub.connect(subscription('session-1'), firstRequest, first);
    await hub.connect(subscription('session-2'), secondRequest, second);

    expect(first.chunks).toHaveLength(1);
    expect(second.chunks).toHaveLength(1);
    const firstEvent = eventData(first.chunks[0]!);
    expect(firstEvent.sequence).toBe(0);
    expect(typeof firstEvent.streamId).toBe('string');
    expect(first.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(first.headers.get('x-accel-buffering')).toBe('no');

    clock.advanceBy(2_000);
    await settle();

    expect(readState).toHaveBeenCalledTimes(3);
    expect(eventData(first.chunks[1]!)).toMatchObject({ sequence: 1 });
    expect(eventData(second.chunks[1]!)).toMatchObject({ sequence: 1 });
    hub.stop();
  });

  it('retains only the latest pending state and closes a persistently blocked writer', async () => {
    const clock = controlledClock();
    let readIndex = 0;
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState: () => Promise.resolve(snapshot(readIndex++)),
      streamIdGenerator: () => '99999999-9999-4999-8999-999999999999',
      validateSession: () => true,
    });
    const response = new FakeStreamResponse();
    response.writeResults.push(false, true);
    const requestEvents = new EventEmitter();

    await hub.connect(subscription(), requestEvents, response);
    clock.advanceBy(2_000);
    await settle();
    clock.advanceBy(2_000);
    await settle();
    expect(response.chunks).toHaveLength(1);

    response.emit('drain');
    expect(response.chunks).toHaveLength(2);
    expect(eventData(response.chunks[1]!)).toMatchObject({
      sequence: 1,
      serverTime: '2031-01-01T00:00:02.000Z',
    });

    response.writeResults.push(false);
    clock.advanceBy(2_000);
    await settle();
    clock.advanceBy(10_000);
    expect(response.ended).toBe(true);
  });

  it('writes heartbeat comments without consuming application sequence values', async () => {
    const clock = controlledClock();
    let readIndex = 0;
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 20_000,
      readState: () => Promise.resolve(snapshot(readIndex++)),
      streamIdGenerator: () => '99999999-9999-4999-8999-999999999999',
      validateSession: () => true,
    });
    const response = new FakeStreamResponse();

    await hub.connect(subscription(), new EventEmitter(), response);
    clock.advanceBy(15_000);
    expect(response.chunks[1]).toBe(': heartbeat\n\n');

    clock.advanceBy(5_000);
    await settle();
    expect(eventData(response.chunks[2]!)).toMatchObject({ sequence: 1 });
    hub.stop();
  });

  it('counts in-progress initial reads against the connection cap', async () => {
    const clock = controlledClock();
    let releaseRead!: (value: LiveStateSnapshot) => void;
    const readState = vi.fn(
      () => new Promise<LiveStateSnapshot>((resolve) => (releaseRead = resolve)),
    );
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState,
      validateSession: () => true,
    });
    const opening = hub.connect(
      subscription(),
      new EventEmitter(),
      new FakeStreamResponse(),
    );

    await expect(
      hub.connect(
        subscription('session-2'),
        new EventEmitter(),
        new FakeStreamResponse(),
      ),
    ).rejects.toMatchObject({ code: 'LIVE_CONNECTION_LIMIT', statusCode: 503 });

    releaseRead(snapshot(0));
    await opening;
    hub.stop();
  });

  it('rechecks session validity after the initial database read before opening headers', async () => {
    const clock = controlledClock();
    let active = true;
    let releaseRead!: (value: LiveStateSnapshot) => void;
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState: () => new Promise((resolve) => (releaseRead = resolve)),
      validateSession: () => active,
    });
    const response = new FakeStreamResponse();
    const opening = hub.connect(subscription(), new EventEmitter(), response);

    await Promise.resolve();
    active = false;
    releaseRead(snapshot(0));

    await expect(opening).rejects.toMatchObject({ code: 'AUTH_REQUIRED', statusCode: 401 });
    expect(response.headers.size).toBe(0);
    expect(response.chunks).toHaveLength(0);
  });

  it('closes only the revoked session while preserving a shared identity poll', async () => {
    const clock = controlledClock();
    const activeSessions = new Set(['session-1', 'session-2']);
    const readState = vi.fn<ReadLiveState>(() => Promise.resolve(snapshot(0)));
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 2,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState,
      validateSession: (session) => activeSessions.has(session.tokenDigest),
    });
    const revoked = new FakeStreamResponse();
    const retained = new FakeStreamResponse();

    await hub.connect(subscription('session-1'), new EventEmitter(), revoked);
    await hub.connect(subscription('session-2'), new EventEmitter(), retained);
    activeSessions.delete('session-1');
    clock.advanceBy(2_000);
    await settle();

    expect(revoked.ended).toBe(true);
    expect(retained.ended).toBe(false);
    expect(retained.chunks).toHaveLength(2);
    expect(readState).toHaveBeenCalledTimes(3);
    hub.stop();
  });

  it('closes at the authenticated session expiry even without another poll', async () => {
    const clock = controlledClock();
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 20_000,
      readState: () => Promise.resolve(snapshot(0)),
      validateSession: () => true,
    });
    const response = new FakeStreamResponse();
    const expiring = subscription();
    expiring.session.expiresAt = new Date('2031-01-01T00:00:02.000Z');

    await hub.connect(expiring, new EventEmitter(), response);
    clock.advanceBy(1_999);
    expect(response.ended).toBe(false);
    clock.advanceBy(1);
    expect(response.ended).toBe(true);
  });

  it('closes on membership denial and cancels blocked pending state', async () => {
    const clock = controlledClock();
    let readIndex = 0;
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState: () => {
        if (readIndex++ === 0) {
          return Promise.resolve(snapshotWithRun(0));
        }
        return Promise.reject(
          new ApiError(403, 'ORG_ACCESS_DENIED', 'The current identity cannot access this organization'),
        );
      },
      validateSession: () => true,
    });
    const response = new FakeStreamResponse();
    response.writeResults.push(false);

    await hub.connect(subscription(), new EventEmitter(), response);
    clock.advanceBy(2_000);
    await settle();
    response.emit('drain');

    expect(response.ended).toBe(true);
    expect(response.chunks).toHaveLength(1);
  });

  it('replaces a blocked visible-run state with the latest grant-filtered state', async () => {
    const clock = controlledClock();
    let readIndex = 0;
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState: () => {
        const index = readIndex++;
        return Promise.resolve(index < 2 ? snapshotWithRun(index) : snapshot(index));
      },
      validateSession: () => true,
    });
    const response = new FakeStreamResponse();
    response.writeResults.push(false, true);

    await hub.connect(subscription(), new EventEmitter(), response);
    clock.advanceBy(2_000);
    await settle();
    clock.advanceBy(2_000);
    await settle();
    response.emit('drain');

    expect(eventData(response.chunks[1]!)).toMatchObject({ runs: [], sequence: 1 });
    hub.stop();
  });
});

describe('GET /api/orgs/:orgId/live', () => {
  it('requires an authenticated event-stream request and passes canonical identity to the hub', async () => {
    const config = validateEnvironment({
      ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      APP_ENV: 'test',
      DATABASE_URL:
        'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker_test',
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: userId,
      MAINTENANCE_DATABASE_URL:
        'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/running_tracker_test',
      SESSION_COOKIE_SECURE: 'false',
    });
    const connect = vi.fn<LiveConnectionManager['connect']>((_subscription, _request, response) => {
      response.end();
      return Promise.resolve();
    });
    const pool: DatabasePool = { connect: vi.fn() };
    const app = createApp({
      clock: controlledClock(),
      config,
      liveConnections: { connect },
      pool,
    });
    const login = await request(app)
      .post('/api/session')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({ userId })
      .expect(201);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';', 1)[0]!;

    await request(app).get(`/api/orgs/${orgId}/live`).set('Accept', 'text/event-stream').expect(401);
    await request(app).get(`/api/orgs/${orgId}/live`).set('Cookie', cookie).expect(406);
    await request(app)
      .get(`/api/orgs/${orgId.toUpperCase()}/live`)
      .set('Accept', 'text/event-stream')
      .set('Cookie', cookie)
      .expect(200);

    expect(connect).toHaveBeenCalledOnce();
    const connectedSubscription = connect.mock.calls[0]?.[0];
    expect(connectedSubscription?.orgId).toBe(orgId);
    expect(connectedSubscription?.session.userId).toBe(userId);
  });
});

describe('P11.1 LiveSseHub metrics', () => {
  function hubWithMetrics(
    overrides: Partial<ConstructorParameters<typeof LiveSseHub>[0]> = {},
    clock = controlledClock(),
  ) {
    const metrics = createApiMetrics();
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock,
      heartbeatIntervalMs: 15_000,
      maxConnections: 1,
      metrics: metrics.live,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState: () => Promise.resolve(snapshot(0)),
      validateSession: () => true,
      ...overrides,
    });
    return { clock, hub, metrics };
  }

  it('tracks open streams, limit rejections, and poll cycle duration', async () => {
    const { clock, hub, metrics } = hubWithMetrics();
    const response = new FakeStreamResponse();

    await hub.connect(subscription(), new EventEmitter(), response);
    await expect(
      hub.connect(subscription('session-2'), new EventEmitter(), new FakeStreamResponse()),
    ).rejects.toMatchObject({ code: 'LIVE_CONNECTION_LIMIT' });
    clock.advanceBy(2_000);
    await settle();

    let output = metrics.registry.render();
    expect(output).toContain('live_sse_streams_opened_total 1');
    expect(output).toContain('live_sse_connections 1');
    expect(output).toContain('live_sse_connection_limit_rejections_total 1');
    expect(output).toContain('live_sse_poll_cycle_seconds_count 1');

    response.emit('close');
    output = metrics.registry.render();
    expect(output).toContain('live_sse_connections 0');
    hub.stop();
  });

  it('counts backpressure closes and per-subscription poll failures without logging details', async () => {
    let failing = false;
    const logged: string[] = [];
    const { clock, hub, metrics } = hubWithMetrics({
      logger: createLogger({
        clock: { utcNow: () => new Date('2031-01-01T00:00:00.000Z') },
        write: (_level, line) => void logged.push(line),
      }),
      readState: () =>
        failing ? Promise.reject(new Error('boom secret')) : Promise.resolve(snapshot(0)),
    });
    const response = new FakeStreamResponse();
    response.writeResults.push(true, false);

    await hub.connect(subscription(), new EventEmitter(), response);
    failing = true;
    clock.advanceBy(2_000);
    await settle();
    failing = false;
    clock.advanceBy(2_000);
    await settle();
    clock.advanceBy(10_000);

    const output = metrics.registry.render();
    expect(output).toContain('live_sse_poll_failures_total 1');
    expect(output).toContain('live_sse_backpressure_closes_total 1');
    expect(output).not.toContain('secret');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? '')).toMatchObject({
      errorName: 'Error',
      event: 'live.poll.failed',
      level: 'error',
    });
    expect(logged[0]).not.toContain('secret');
    hub.stop();
  });
});
