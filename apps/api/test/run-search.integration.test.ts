import { apiErrorResponseSchema, runListResponseSchema, runSearchResponseSchema } from '@running-tracker/contracts';
import type { RunSearchResponse } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const WARSAW = 'Europe/Warsaw';

// The server's "now" for presets. Fixed and injected, never taken from the client.
const serverNow = new Date('2026-10-15T12:00:00.000Z');

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return serverNow.getTime();
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(serverNow);
  }
}

type Label = string;
interface Seed {
  distanceM?: number;
  durationS?: number;
  label: Label;
  org?: string;
  owner: string;
  // 'current' publishes a summary at the run's data revision, 'stale' at an older one, 'none' publishes none.
  summary: 'current' | 'none' | 'stale';
  startedAt: string;
  stats?: { accepted: number; insufficient?: boolean; raw: number };
  status?: 'finished' | 'recording';
}

const runIds = new Map<Label, string>();
let counter = 0;
function runIdFor(label: Label): string {
  let value = runIds.get(label);
  if (value === undefined) {
    counter += 1;
    // Ascending in creation order, so "run id descending" is the reverse of the seed order below.
    value = `c1000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    runIds.set(label, value);
  }
  return value;
}

// Mine = ids.userDual in ids.orgA. The October window in Europe/Warsaw is [2026-09-30T22:00Z, 2026-10-31T23:00Z).
const seeds: Seed[] = [
  { label: 'm01', owner: ids.userDual, startedAt: '2026-09-30T21:59:59.000Z', distanceM: 5000, summary: 'current' },
  { label: 'm02', owner: ids.userDual, startedAt: '2026-09-30T22:00:00.000Z', distanceM: 5000, summary: 'current' },
  { label: 'm03', owner: ids.userDual, startedAt: '2026-10-10T06:00:00.000Z', distanceM: 10000, summary: 'current' },
  { label: 'm04', owner: ids.userDual, startedAt: '2026-10-10T06:00:00.000Z', distanceM: 10000, summary: 'current' },
  { label: 'm05', owner: ids.userDual, startedAt: '2026-10-12T06:00:00.000Z', distanceM: 10000, summary: 'current' },
  {
    label: 'm06',
    owner: ids.userDual,
    startedAt: '2026-10-20T06:00:00.000Z',
    distanceM: 4999.96,
    summary: 'current',
    stats: { accepted: 70, raw: 100 },
  },
  {
    label: 'm07',
    owner: ids.userDual,
    startedAt: '2026-10-25T00:30:00.000Z',
    distanceM: 21097.5,
    summary: 'current',
    stats: { accepted: 0, insufficient: true, raw: 6 },
  },
  { label: 'm08', owner: ids.userDual, startedAt: '2026-10-31T22:59:59.000Z', distanceM: 3000, summary: 'current' },
  { label: 'm09', owner: ids.userDual, startedAt: '2026-10-31T23:00:00.000Z', distanceM: 3000, summary: 'current' },
  { label: 'm10', owner: ids.userDual, startedAt: '2026-10-24T22:00:00.000Z', distanceM: 7000, summary: 'current' },
  { label: 'm11', owner: ids.userDual, startedAt: '2026-10-25T22:59:59.000Z', distanceM: 7000, summary: 'current' },
  { label: 'p1', owner: ids.userDual, startedAt: '2026-10-15T06:00:00.000Z', summary: 'none' },
  { label: 'p2', owner: ids.userDual, startedAt: '2026-10-16T06:00:00.000Z', distanceM: 8000, summary: 'stale' },
  { label: 'rec', owner: ids.userDual, startedAt: '2026-10-17T06:00:00.000Z', summary: 'none', status: 'recording' },
  // A teammate's finished run that RLS lets userDual read through a history share: never "my runs".
  { label: 's1', owner: ids.userOrgA, startedAt: '2026-10-11T06:00:00.000Z', distanceM: 8000, summary: 'current' },
  { label: 's2', owner: ids.userOrgA, startedAt: '2026-10-13T06:00:00.000Z', distanceM: 9000, summary: 'current' },
  // Same person, another organization; and another person in that organization shared with userDual.
  { label: 'b1', org: ids.orgB, owner: ids.userDual, startedAt: '2026-10-14T06:00:00.000Z', distanceM: 6000, summary: 'current' },
  { label: 'b2', org: ids.orgB, owner: ids.userOrgB, startedAt: '2026-10-14T07:00:00.000Z', distanceM: 6500, summary: 'current' },
];

const octoberNewest = ['m08', 'm11', 'm07', 'm10', 'm06', 'm05', 'm04', 'm03', 'm02'];
const octoberLongest = ['m07', 'm05', 'm04', 'm03', 'm11', 'm10', 'm02', 'm06', 'm08'];
const octoberShortest = ['m08', 'm06', 'm02', 'm11', 'm10', 'm05', 'm04', 'm03', 'm07'];

const qualityStats = (accepted: number, raw: number, insufficient: boolean) => ({
  acceptedEdgeCount: Math.max(accepted - 1, 0),
  acceptedPointCount: accepted,
  excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0,
  insufficientData: insufficient,
  nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0,
  rawPointCount: raw,
  segmentBreakCount: 0,
  seqGapCount: 0,
});

function objectBody(response: request.Response): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const first: unknown = Array.isArray(header) ? (header[0] as unknown) : header;
  if (typeof first !== 'string') {
    throw new Error('Expected a session cookie');
  }
  return first.split(';', 1)[0]!;
}

describe('run search endpoint', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const cookies = new Map<string, string>();

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const users = [ids.userDual, ids.userInactive, ids.userOrgA, ids.userOrgB, ids.userStranger];
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: users.join(','),
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    ownerPool = new Pool({
      application_name: 'running-tracker-run-search-fixtures',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    const clock = new FixedClock();
    app = createApp({
      clock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
    });
    for (const userId of users) {
      const login = await request(app)
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId })
        .expect(201);
      cookies.set(userId, cookiePair(login));
    }
  });

  beforeEach(async () => {
    const integration = loadIntegrationTestConfiguration();
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    for (const seed of seeds) {
      const orgId = seed.org ?? ids.orgA;
      const startedAt = seed.startedAt;
      const finishedAt = new Date(Date.parse(startedAt) + 1_800_000).toISOString();
      const finished = (seed.status ?? 'finished') === 'finished';
      // A "stale" summary was published for revision 1, and the run has since reached revision 2.
      const dataRevision = seed.summary === 'stale' ? 2 : 1;
      await ownerPool.query(
        `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
        [
          orgId,
          runIdFor(seed.label),
          seed.owner,
          finished ? 'finished' : 'recording',
          startedAt,
          finished ? finishedAt : null,
          dataRevision,
        ],
      );
      if (seed.summary !== 'none') {
        const stats = seed.stats ?? { accepted: 100, raw: 100 };
        await ownerPool.query(
          `INSERT INTO run_summaries (
             org_id, run_id, source_revision, algorithm_version,
             distance_m, observed_duration_s, quality_stats
           ) VALUES ($1, $2, $3, 'search-fixture-v1', $4, $5, $6::jsonb)`,
          [
            orgId,
            runIdFor(seed.label),
            1,
            seed.distanceM ?? 1000,
            seed.durationS ?? 1_800,
            JSON.stringify(qualityStats(stats.accepted, stats.raw, stats.insufficient ?? false)),
          ],
        );
      }
    }
    // userDual may read s1 and the other organization's b2 through ordinary history shares.
    await ownerPool.query(
      `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_live, can_read_history)
       VALUES ($1, $2, $4, false, true), ($3, $5, $4, false, true)`,
      [ids.orgA, runIdFor('s1'), ids.orgB, ids.userDual, runIdFor('b2')],
    );
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function search(userId: string, orgId: string, query: Record<string, string | number> = {}) {
    const params = new URLSearchParams({ preset: 'this-month', timeZone: WARSAW });
    for (const [key, value] of Object.entries(query)) {
      params.set(key, String(value));
    }
    for (const key of ['fromDate', 'toDate']) {
      if (key in query) {
        params.delete('preset');
      }
    }
    return request(app)
      .get(`/api/orgs/${orgId}/runs/search?${params.toString()}`)
      .set('Cookie', cookies.get(userId) ?? '');
  }

  function labels(body: RunSearchResponse): string[] {
    const byId = new Map([...runIds].map(([label, id]) => [id, label]));
    return body.items.map((item) => byId.get(item.runId) ?? item.runId);
  }

  async function ok(userId: string, orgId: string, query: Record<string, string | number> = {}) {
    const response = await search(userId, orgId, query).expect(200);
    return runSearchResponseSchema.parse(objectBody(response));
  }

  async function allPages(query: Record<string, string | number>): Promise<string[]> {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const body: RunSearchResponse = await ok(ids.userDual, ids.orgA, {
        ...query,
        ...(cursor === null ? {} : { cursor }),
      });
      collected.push(...labels(body));
      cursor = body.nextCursor;
      if (cursor === null) {
        return collected;
      }
    }
    throw new Error('The search never ended');
  }

  describe('ownership and tenancy', () => {
    it('returns only the signed-in person’s own finished runs, though a shared run is readable', async () => {
      const list = runListResponseSchema.parse(
        objectBody(
          await request(app)
            .get(
              `/api/orgs/${ids.orgA}/runs?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=100`,
            )
            .set('Cookie', cookies.get(ids.userDual) ?? '')
            .expect(200),
        ),
      );
      // The ordinary list still returns the shared run: its semantics are unchanged.
      expect(list.items.map((item) => item.runId)).toContain(runIdFor('s1'));
      expect(list.items.map((item) => item.runId)).not.toContain(runIdFor('s2'));

      const body = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(body)).toEqual(octoberNewest);
      expect(labels(body)).not.toContain('s1');
      expect(labels(body)).not.toContain('s2');
    });

    it('returns a teammate their own runs and not the first person’s', async () => {
      const body = await ok(ids.userOrgA, ids.orgA);
      expect(labels(body)).toEqual(['s2', 's1']);
      expect(body.pendingSummaryCount).toBe(0);
    });

    it('does not mix organizations, and does not show another organization’s shared run', async () => {
      const inA = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(inA)).not.toContain('b1');
      const inB = await ok(ids.userDual, ids.orgB, { limit: 50 });
      expect(labels(inB)).toEqual(['b1']);
      expect(labels(inB)).not.toContain('b2');
      expect(inB.pendingSummaryCount).toBe(0);
    });

    it('never lists a run that is not finished', async () => {
      const body = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(body)).not.toContain('rec');
      expect(body.pendingSummaryCount).toBe(2);
    });

    it('answers 401 without a session', async () => {
      await request(app)
        .get(`/api/orgs/${ids.orgA}/runs/search?preset=this-month&timeZone=UTC`)
        .expect(401);
    });

    it('answers 403 to a person with no membership in the organization', async () => {
      const response = await search(ids.userOrgA, ids.orgB).expect(403);
      expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('ORG_ACCESS_DENIED');
    });

    it('answers 403 to an inactive member', async () => {
      const response = await search(ids.userInactive, ids.orgA).expect(403);
      expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('ORG_ACCESS_DENIED');
    });

    it.each(['userId', 'ownerId', 'user_id', 'orgId', 'status'])(
      'refuses an owner or scope named in the query (%s)',
      async (field) => {
        const response = await search(ids.userDual, ids.orgA, { [field]: ids.userOrgA }).expect(400);
        expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('INVALID_REQUEST');
      },
    );

    it('is handled by the search route and not by the run id route', async () => {
      const response = await search(ids.userDual, ids.orgA).expect(200);
      expect(Array.isArray(objectBody(response).items)).toBe(true);
      const invalid = await request(app)
        .get(`/api/orgs/${ids.orgA}/runs/search/points?preset=this-month&timeZone=UTC`)
        .set('Cookie', cookies.get(ids.userDual) ?? '');
      expect(invalid.status).toBe(400);
    });
  });

  describe('periods', () => {
    it('applies an inclusive local start and an exclusive local end on started_at', async () => {
      const body = await ok(ids.userDual, ids.orgA, { fromDate: '2026-10-01', limit: 50, toDate: '2026-10-31' });
      expect(body.applied).toMatchObject({
        from: '2026-09-30T22:00:00.000Z',
        fromDate: '2026-10-01',
        timeZone: WARSAW,
        to: '2026-10-31T23:00:00.000Z',
        toDate: '2026-10-31',
      });
      // m02 starts exactly at the period start, m09 exactly at its end.
      expect(labels(body)).toEqual(octoberNewest);
      expect(labels(body)).toContain('m02');
      expect(labels(body)).not.toContain('m09');
      expect(labels(body)).not.toContain('m01');
    });

    it('treats the same instants as September in UTC, since the zone decides the date', async () => {
      const body = await ok(ids.userDual, ids.orgA, {
        fromDate: '2026-09-01',
        limit: 50,
        timeZone: 'UTC',
        toDate: '2026-09-30',
      });
      expect(labels(body)).toEqual(['m02', 'm01']);
    });

    it('covers a 25-hour local day on the day clocks go back', async () => {
      const body = await ok(ids.userDual, ids.orgA, { fromDate: '2026-10-25', toDate: '2026-10-25' });
      expect(body.applied.from).toBe('2026-10-24T22:00:00.000Z');
      expect(body.applied.to).toBe('2026-10-25T23:00:00.000Z');
      expect(labels(body)).toEqual(['m11', 'm07', 'm10']);
    });

    it('resolves the presets from the injected clock', async () => {
      const thisMonth = await ok(ids.userDual, ids.orgA, { limit: 50, preset: 'this-month' });
      expect(thisMonth.applied.fromDate).toBe('2026-10-01');
      expect(thisMonth.applied.toDate).toBe('2026-10-31');
      expect(labels(thisMonth)).toEqual(octoberNewest);
      const previous = await ok(ids.userDual, ids.orgA, { preset: 'previous-month' });
      expect(previous.applied.fromDate).toBe('2026-09-01');
      expect(previous.applied.to).toBe('2026-09-30T22:00:00.000Z');
      expect(labels(previous)).toEqual(['m01']);
    });
  });

  describe('distance', () => {
    it('compares the stored metres, not a rounded display value', async () => {
      // m06 is 4999.96 m, which a screen would show as 5.0 km.
      const body = await ok(ids.userDual, ids.orgA, {
        distanceUnit: 'km',
        limit: 50,
        minDistance: '5',
        sort: 'shortest',
      });
      expect(labels(body)).not.toContain('m06');
      expect(labels(body)).toContain('m02');
      expect(body.applied.minDistanceM).toBe(5000);
    });

    it('includes values equal to a bound on both sides', async () => {
      const body = await ok(ids.userDual, ids.orgA, {
        distanceUnit: 'km',
        limit: 50,
        maxDistance: '10',
        minDistance: '10',
        sort: 'shortest',
      });
      expect(labels(body)).toEqual(['m05', 'm04', 'm03']);
    });

    it('converts miles exactly', async () => {
      const body = await ok(ids.userDual, ids.orgA, {
        distanceUnit: 'mi',
        limit: 50,
        maxDistance: '6.2',
        minDistance: '3.1',
        sort: 'shortest',
      });
      expect(body.applied.minDistanceM).toBe(4988.9664);
      expect(body.applied.maxDistanceM).toBe(9977.9328);
      expect(labels(body)).toEqual(['m06', 'm02', 'm11', 'm10']);
    });

    it('refuses a minimum above the maximum', async () => {
      await search(ids.userDual, ids.orgA, { distanceUnit: 'km', maxDistance: '1', minDistance: '2' }).expect(400);
    });
  });

  describe('current and pending summaries', () => {
    it('counts finished runs without a current summary, before the distance filter, and lists none of them', async () => {
      const body = await ok(ids.userDual, ids.orgA, { distanceUnit: 'km', limit: 50, minDistance: '100' });
      expect(body.items).toEqual([]);
      expect(body.pendingSummaryCount).toBe(2);
      const whole = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(whole)).not.toContain('p1');
      expect(labels(whole)).not.toContain('p2');
      expect(whole.pendingSummaryCount).toBe(2);
    });

    it('counts only the selected period and only the signed-in person', async () => {
      const previous = await ok(ids.userDual, ids.orgA, { preset: 'previous-month' });
      expect(previous.pendingSummaryCount).toBe(0);
      const other = await ok(ids.userOrgA, ids.orgA);
      expect(other.pendingSummaryCount).toBe(0);
    });

    it('moves a run into the results when its summary becomes current', async () => {
      await ownerPool.query(
        `INSERT INTO run_summaries (
           org_id, run_id, source_revision, algorithm_version, distance_m, observed_duration_s, quality_stats
         ) VALUES ($1, $2, 1, 'search-fixture-v1', 12000, 3000, $3::jsonb)`,
        [ids.orgA, runIdFor('p1'), JSON.stringify(qualityStats(100, 100, false))],
      );
      const body = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(body)).toContain('p1');
      expect(body.pendingSummaryCount).toBe(1);
    });

    it('treats a summary of an older data revision as pending, and recovers when it is republished', async () => {
      await ownerPool.query('UPDATE runs SET data_revision = 2 WHERE org_id = $1 AND id = $2', [
        ids.orgA,
        runIdFor('m03'),
      ]);
      const stale = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(stale)).not.toContain('m03');
      expect(stale.pendingSummaryCount).toBe(3);
      await ownerPool.query(
        'UPDATE run_summaries SET source_revision = 2 WHERE org_id = $1 AND run_id = $2',
        [ids.orgA, runIdFor('m03')],
      );
      const fresh = await ok(ids.userDual, ids.orgA, { limit: 50 });
      expect(labels(fresh)).toContain('m03');
      expect(fresh.pendingSummaryCount).toBe(2);
    });

    it('shows the observed duration and a quality label from the summary', async () => {
      const body = await ok(ids.userDual, ids.orgA, { limit: 50 });
      const byLabel = new Map(labels(body).map((label, index) => [label, body.items[index]!]));
      expect(byLabel.get('m03')).toMatchObject({ distanceM: 10000, gpsQuality: 'good', observedDurationS: 1800 });
      expect(byLabel.get('m06')?.gpsQuality).toBe('poor');
      expect(byLabel.get('m07')?.gpsQuality).toBe('insufficient');
      expect(byLabel.get('m03')?.startedAt).toBe('2026-10-10T06:00:00.000Z');
    });
  });

  describe('sorting and pages', () => {
    it.each([
      ['newest', octoberNewest],
      ['longest', octoberLongest],
      ['shortest', octoberShortest],
    ] as const)('orders %s with ties broken by newest start and then run id', async (sort, expected) => {
      const body = await ok(ids.userDual, ids.orgA, { limit: 50, sort });
      expect(labels(body)).toEqual(expected);
      expect(body.nextCursor).toBeNull();
    });

    it.each([
      ['newest', octoberNewest],
      ['longest', octoberLongest],
      ['shortest', octoberShortest],
    ] as const)('pages %s by a keyset without omission or duplication', async (sort, expected) => {
      for (const limit of [1, 2, 4]) {
        expect(await allPages({ limit, sort })).toEqual(expected);
      }
    });

    it('splits the equal-key runs across a page boundary in a stable order', async () => {
      // m03 and m04 have the same start and the same distance; the boundary after m04 must not repeat it.
      const first = await ok(ids.userDual, ids.orgA, { limit: 3, sort: 'longest' });
      expect(labels(first)).toEqual(['m07', 'm05', 'm04']);
      const second = await ok(ids.userDual, ids.orgA, { cursor: first.nextCursor ?? '', limit: 3, sort: 'longest' });
      expect(labels(second)).toEqual(['m03', 'm11', 'm10']);
    });

    it('applies the page bound', async () => {
      await search(ids.userDual, ids.orgA, { limit: 51 }).expect(400);
      const body = await ok(ids.userDual, ids.orgA, { limit: 1 });
      expect(body.items).toHaveLength(1);
      expect(body.nextCursor).not.toBeNull();
    });
  });

  describe('cursors', () => {
    async function firstPage(query: Record<string, string | number> = {}) {
      const body = await ok(ids.userDual, ids.orgA, { limit: 2, ...query });
      expect(body.nextCursor).not.toBeNull();
      return body.nextCursor as string;
    }

    async function refused(userId: string, orgId: string, query: Record<string, string | number>) {
      const response = await search(userId, orgId, query).expect(400);
      expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('INVALID_CURSOR');
    }

    it('is refused for another sort', async () => {
      await refused(ids.userDual, ids.orgA, { cursor: await firstPage(), sort: 'longest' });
    });

    it('is refused when a distance bound changes', async () => {
      const cursor = await firstPage();
      await refused(ids.userDual, ids.orgA, { cursor, distanceUnit: 'km', minDistance: '1' });
    });

    it('is refused for another period', async () => {
      const cursor = await firstPage();
      await refused(ids.userDual, ids.orgA, { cursor, fromDate: '2026-10-02', toDate: '2026-10-31' });
    });

    it('is refused for another time zone', async () => {
      const cursor = await firstPage();
      await refused(ids.userDual, ids.orgA, { cursor, fromDate: '2026-10-01', timeZone: 'UTC', toDate: '2026-10-31' });
    });

    it('is refused in another organization', async () => {
      await refused(ids.userDual, ids.orgB, { cursor: await firstPage() });
    });

    it('is refused for another person', async () => {
      await refused(ids.userOrgA, ids.orgA, { cursor: await firstPage() });
    });

    it('is refused when it is not one of ours', async () => {
      await refused(ids.userDual, ids.orgA, { cursor: 'not-a-cursor' });
      await refused(ids.userDual, ids.orgA, {
        cursor: Buffer.from(JSON.stringify({ runId: runIdFor('m03'), startedAt: '2026-10-10T06:00:00.000Z' })).toString(
          'base64url',
        ),
      });
    });
  });
});
