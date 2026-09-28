import { liveStateRunSchema } from '@running-tracker/contracts';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { sessionCookieName } from '../src/auth/session-http.js';
import { systemClock, type Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
  type VerifiedIntegrationDatabaseConnection,
} from '../src/config/environment.js';
import { withAuthenticatedTenantTransaction } from '../src/database/authenticated-tenant-transaction.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  LiveSseHub,
  type LiveStreamResponse,
} from '../src/live/live-sse.js';
import { readLiveState } from '../src/live/live-state.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

interface ScheduledTimer {
  callback: () => void;
  dueAt: number;
}

class ControlledClock implements Clock {
  readonly #timers = new Map<ReturnType<typeof setTimeout>, ScheduledTimer>();
  #nextHandle = 1;
  #now = Date.parse('2026-09-27T12:00:00.000Z');

  public advanceBy(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [handle, timer] of [...this.#timers]) {
      if (timer.dueAt <= this.#now) {
        this.#timers.delete(handle);
        timer.callback();
      }
    }
  }

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.#timers.delete(handle);
  }

  public monotonicNow(): number {
    return this.#now;
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = this.#nextHandle as unknown as ReturnType<typeof setTimeout>;
    this.#nextHandle += 1;
    this.#timers.set(handle, { callback, dueAt: this.#now + delayMs });
    return handle;
  }

  public utcNow(): Date {
    return new Date(this.#now);
  }
}

class FakeStreamResponse extends EventEmitter implements LiveStreamResponse {
  public readonly chunks: string[] = [];
  public ended = false;

  public end(): void {
    this.ended = true;
  }

  public setHeader(): void {}

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function eventData(frame: string): Record<string, unknown> {
  const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (!line) {
    throw new Error('Expected an SSE data line');
  }
  return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
}

describe('P08.1 live-state database snapshot', () => {
  let migration: VerifiedIntegrationDatabaseConnection;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    migration = integration.migration;
    config = validateEnvironment({
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p081-live-state-fixtures',
      connectionString: migration.connectionString,
      max: 2,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 3 });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, migration);
    await ownerPool.query(
      `UPDATE runs
       SET data_revision = CASE id
         WHEN $2 THEN 2
         WHEN $3 THEN 1
         ELSE data_revision
       END
       WHERE org_id = $1
         AND id IN ($2, $3)`,
      [ids.orgA, ids.runRecording, ids.runPaused],
    );
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES (
         $1, $2, 2, 0, $3, $3,
         public.ST_SetSRID(public.ST_MakePoint(21.00101, 52.001), 4326),
         5.0, 2
       )`,
      [ids.orgA, ids.runRecording, '2026-09-20T08:15:02.000Z'],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function readFor(userId: string) {
    return withAuthenticatedTenantTransaction(runtimePool, { userId }, ids.orgA, (client) =>
      readLiveState(client, ids.orgA),
    );
  }

  it('returns only authorized active runs with evaluator-bound position quality', async () => {
    const state = await readFor(ids.userDual);

    expect(state.algorithmVersion).toBe('v1');
    expect(Number.isNaN(Date.parse(state.serverTime))).toBe(false);
    expect(state.runs).toHaveLength(2);
    expect(state.runs.every((run) => liveStateRunSchema.safeParse(run).success)).toBe(true);
    expect(state.runs).toEqual([
      {
        dataRevision: '2',
        position: {
          accuracyM: 5,
          coordinates: [21.00101, 52.001],
          quality: 'confirmed',
          recordedAt: '2026-09-20T08:15:02.000Z',
          seq: '2',
        },
        runId: ids.runRecording,
        status: 'recording',
      },
      {
        dataRevision: '1',
        position: {
          accuracyM: 5,
          coordinates: [21.002, 52.002],
          quality: 'unconfirmed',
          recordedAt: '2026-09-20T08:15:00.000Z',
          seq: '1',
        },
        runId: ids.runPaused,
        status: 'paused',
      },
    ]);
  });

  it('does not expose a latest point whose accuracy fails the shared threshold', async () => {
    await ownerPool.query(
      `UPDATE run_points
       SET accuracy_m = 50.0
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      [ids.orgA, ids.runPaused],
    );

    const state = await readFor(ids.userDual);
    expect(state.runs.find(({ runId }) => runId === ids.runPaused)?.position).toBeNull();
  });

  it('observes a committed point on the next independent snapshot without a held connection', async () => {
    const before = await readFor(ids.userDual);
    expect(before.runs[0]?.position?.seq).toBe('2');

    await ownerPool.query('BEGIN');
    try {
      await ownerPool.query(
        `INSERT INTO run_points (
           org_id, run_id, seq, segment_id, recorded_at, received_at,
           geom, accuracy_m, ingested_revision
         ) VALUES (
           $1, $2, 3, 0, $3, $3,
           public.ST_SetSRID(public.ST_MakePoint(21.00102, 52.001), 4326),
           5.0, 3
         )`,
        [ids.orgA, ids.runRecording, '2026-09-20T08:15:04.000Z'],
      );
      await ownerPool.query(
        'UPDATE runs SET data_revision = 3 WHERE org_id = $1 AND id = $2',
        [ids.orgA, ids.runRecording],
      );
      await ownerPool.query('COMMIT');
    } catch (error) {
      await ownerPool.query('ROLLBACK');
      throw error;
    }

    const after = await readFor(ids.userDual);
    expect(after.runs[0]).toMatchObject({
      dataRevision: '3',
      position: { quality: 'confirmed', seq: '3' },
    });
  });

  it('returns an empty state for an active member without a visible active run', async () => {
    const state = await readFor(ids.userStranger);
    expect(state.runs).toEqual([]);
    expect(state.algorithmVersion).toBe('v1');
  });

  it('removes revoked grants and closes after membership loss at the next authorization check', async () => {
    const clock = new ControlledClock();
    const sessionManager = new SessionManager({
      clock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const session = sessionManager.create(ids.userDual);
    let attempts = 0;
    const waiters = new Map<number, () => void>();
    const waitForAttempt = (target: number): Promise<void> =>
      attempts >= target
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiters.set(target, resolve);
          });
    const hub = new LiveSseHub({
      backpressureTimeoutMs: config.LIVE_SSE_BACKPRESSURE_TIMEOUT_MS,
      clock,
      heartbeatIntervalMs: config.LIVE_SSE_HEARTBEAT_INTERVAL_MS,
      maxConnections: 1,
      pollConcurrency: 1,
      pollIntervalMs: config.LIVE_SSE_POLL_INTERVAL_MS,
      readState: async ({ orgId, session: activeSession }) => {
        try {
          return await withAuthenticatedTenantTransaction(
            runtimePool,
            activeSession,
            orgId,
            (client) => readLiveState(client, orgId),
          );
        } finally {
          attempts += 1;
          waiters.get(attempts)?.();
        }
      },
      validateSession: (candidate) => sessionManager.isActive(candidate),
    });
    const response = new FakeStreamResponse();

    try {
      await hub.connect(
        { orgId: ids.orgA, session: session.record },
        new EventEmitter(),
        response,
      );
      expect(eventData(response.chunks[0]!)).toMatchObject({
        runs: [
          { runId: ids.runRecording },
          { runId: ids.runPaused },
        ],
      });

      await ownerPool.query(
        `UPDATE run_shares
         SET can_read_live = false
         WHERE org_id = $1 AND grantee_user_id = $2`,
        [ids.orgA, ids.userDual],
      );
      const grantsPoll = waitForAttempt(2);
      clock.advanceBy(config.LIVE_SSE_POLL_INTERVAL_MS);
      await grantsPoll;
      await Promise.resolve();
      await Promise.resolve();
      expect(eventData(response.chunks[1]!)).toMatchObject({ runs: [] });
      expect(response.ended).toBe(false);

      await ownerPool.query(
        'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userDual],
      );
      const membershipPoll = waitForAttempt(3);
      clock.advanceBy(config.LIVE_SSE_POLL_INTERVAL_MS);
      await membershipPoll;
      await Promise.resolve();
      await Promise.resolve();
      expect(response.ended).toBe(true);
      expect(response.chunks).toHaveLength(2);
    } finally {
      hub.stop();
    }
  });

  it('serves the immediate state as a live event without waiting for a poll cycle', async () => {
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const session = sessionManager.create(ids.userDual);
    const app = createApp({ clock: systemClock, config, pool: runtimePool, sessionManager });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP test server address');
      }
      const received = await new Promise<{ frame: string; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          let settled = false;
          const request = httpRequest(
            {
              headers: {
                Accept: 'text/event-stream',
                Cookie: `${sessionCookieName}=${session.sessionToken}`,
              },
              host: '127.0.0.1',
              path: `/api/orgs/${ids.orgA}/live`,
              port: address.port,
            },
            (response) => {
              let buffer = '';
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => {
                buffer += chunk;
                const frameEnd = buffer.indexOf('\n\n');
                if (!settled && frameEnd >= 0) {
                  settled = true;
                  resolve({ frame: buffer.slice(0, frameEnd + 2), headers: response.headers });
                  response.destroy();
                }
              });
              response.on('error', (error) => {
                if (!settled) reject(error);
              });
            },
          );
          request.on('error', (error) => {
            if (!settled) reject(error);
          });
          request.end();
        },
      );

      expect(received.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(received.headers['cache-control']).toBe('private, no-store');
      expect(received.frame.startsWith('event: live.state\n')).toBe(true);
      const dataLine = received.frame.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const data = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
      expect(data.sequence).toBe(0);
      expect(data.algorithmVersion).toBe('v1');
      expect(Array.isArray(data.runs)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
