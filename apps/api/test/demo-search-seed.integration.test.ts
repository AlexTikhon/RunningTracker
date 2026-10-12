import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runSearchResponseSchema } from '@running-tracker/contracts';
import type { RunSearchResponse } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { prepareTenantIsolationFixtures } from './tenant-isolation-fixtures.js';

// The seed is a plain Node module of the repository's scripts, so it is loaded by URL and described here.
interface PlanRun {
  id: string;
  label: string;
  orgId: string;
  points: unknown[];
  startedAt: string;
  summary: { distanceM: number } | null;
  userId: string;
}
interface Plan {
  organizations: Array<{ id: string }>;
  runs: PlanRun[];
  shares: Array<{ runId: string }>;
}
interface SeedModule {
  applySearchDemoPlan: (
    client: unknown,
    plan: Plan,
    options: { algorithmVersion: string },
  ) => Promise<{ runsExisting: number; runsInserted: number; shares: number; users: number }>;
  searchDemoIds: Record<string, string>;
  searchDemoPlan: (input: { month: string }) => Plan;
}

const allowedOrigin = 'http://127.0.0.1:5173';

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse('2026-10-15T12:00:00.000Z');
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date('2026-10-15T12:00:00.000Z');
  }
}

describe('the archive-search demo seed', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let seed: SeedModule;
  let plan: Plan;
  let cookie = '';
  let outsiderCookie = '';

  const planIds = () => plan.runs.map((run) => run.id);
  const labelOf = (id: string) => plan.runs.find((run) => run.id === id)?.label ?? id;

  async function seedOnce() {
    const client = await ownerPool.connect();
    try {
      return await seed.applySearchDemoPlan(client, plan, { algorithmVersion: 'v1' });
    } finally {
      client.release();
    }
  }

  async function query(orgId: string, params: Record<string, string>, session = cookie) {
    const search = new URLSearchParams(params);
    const response = await request(app)
      .get(`/api/orgs/${orgId}/runs/search?${search.toString()}`)
      .set('Cookie', session)
      .expect(200);
    return runSearchResponseSchema.parse(response.body);
  }

  async function everyPage(orgId: string, params: Record<string, string>): Promise<RunSearchResponse[]> {
    const pages: RunSearchResponse[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 30; step += 1) {
      const page = await query(orgId, cursor === undefined ? params : { ...params, cursor });
      pages.push(page);
      if (page.nextCursor === null) {
        return pages;
      }
      cursor = page.nextCursor;
    }
    throw new Error('The search never ended');
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const module = (await import(
      pathToFileURL(join(import.meta.dirname, '..', '..', '..', 'scripts', 'demo-search-data.mjs')).href
    )) as SeedModule;
    seed = module;
    plan = seed.searchDemoPlan({ month: '2026-10' });

    const config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: `${seed.searchDemoIds.runner!},${seed.searchDemoIds.outsider!}`,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 4 });
    ownerPool = new Pool({
      application_name: 'running-tracker-demo-search-seed-test',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    // Empties the tenant tables of the disposable test database, as every integration suite does.
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);

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
    const signIn = async (userId: string) => {
      const login = await request(app)
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId })
        .expect(201);
      const header = login.headers['set-cookie'] as unknown as string[];
      return header[0]!.split(';', 1)[0]!;
    };
    cookie = await signIn(seed.searchDemoIds.runner!);
    outsiderCookie = await signIn(seed.searchDemoIds.outsider!);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  it('writes the whole plan once and nothing the second time', async () => {
    const first = await seedOnce();
    expect(first.runsInserted).toBe(plan.runs.length);
    expect(first.runsExisting).toBe(0);
    const before = await ownerPool.query<{ runs: number; summaries: number; points: number; shares: number }>(
      `SELECT (SELECT count(*)::int FROM runs WHERE id = ANY($1::uuid[])) AS runs,
              (SELECT count(*)::int FROM run_summaries WHERE run_id = ANY($1::uuid[])) AS summaries,
              (SELECT count(*)::int FROM run_points WHERE run_id = ANY($1::uuid[])) AS points,
              (SELECT count(*)::int FROM run_shares WHERE run_id = ANY($1::uuid[])) AS shares`,
      [planIds()],
    );
    expect(before.rows[0]!.runs).toBe(plan.runs.length);

    const second = await seedOnce();
    expect(second).toMatchObject({ runsExisting: plan.runs.length, runsInserted: 0, shares: 0, users: 0 });
    const after = await ownerPool.query(
      `SELECT (SELECT count(*)::int FROM runs WHERE id = ANY($1::uuid[])) AS runs,
              (SELECT count(*)::int FROM run_summaries WHERE run_id = ANY($1::uuid[])) AS summaries,
              (SELECT count(*)::int FROM run_points WHERE run_id = ANY($1::uuid[])) AS points,
              (SELECT count(*)::int FROM run_shares WHERE run_id = ANY($1::uuid[])) AS shares`,
      [planIds()],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('shows the runner only the runner’s own current runs, and counts the others as pending', async () => {
    const orgId = seed.searchDemoIds.organization!;
    const body = await query(orgId, { limit: '50', preset: 'this-month', sort: 'newest', timeZone: 'UTC' });
    const own = plan.runs.filter(
      (run) =>
        run.orgId === orgId &&
        run.userId === seed.searchDemoIds.runner &&
        run.summary !== null &&
        run.startedAt >= '2026-10-01T00:00:00.000Z' &&
        run.startedAt < '2026-11-01T00:00:00.000Z' &&
        run.points.length === 0,
    );
    expect(body.items).toHaveLength(own.length);
    expect(own.length).toBeGreaterThanOrEqual(24);
    for (const item of body.items) {
      const run = plan.runs.find((candidate) => candidate.id === item.runId)!;
      expect(run.userId).toBe(seed.searchDemoIds.runner);
      expect(run.orgId).toBe(orgId);
    }
    // r25 and r26 have no summary, r27 has one for an older revision.
    expect(body.pendingSummaryCount).toBe(3);
  });

  it('keeps teammates’ shared runs and the other organization out of the list', async () => {
    const orgId = seed.searchDemoIds.organization!;
    const sharedIds = new Set(plan.shares.map((share) => share.runId));
    expect(sharedIds.size).toBeGreaterThanOrEqual(3);

    // The ordinary list does return them: they are readable, which is exactly why the search must filter owners.
    const list = await request(app)
      .get(`/api/orgs/${orgId}/runs?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=100`)
      .set('Cookie', cookie)
      .expect(200);
    const listed = new Set((list.body as { items: Array<{ runId: string }> }).items.map((item) => item.runId));
    expect([...sharedIds].filter((id) => plan.runs.find((run) => run.id === id)?.orgId === orgId).some((id) => listed.has(id))).toBe(true);

    const pages = await everyPage(orgId, { limit: '50', preset: 'this-month', timeZone: 'UTC' });
    const found = pages.flatMap((page) => page.items.map((item) => item.runId));
    for (const id of found) {
      expect(sharedIds.has(id)).toBe(false);
      expect(labelOf(id)).not.toMatch(/^(t\d|x\d|b\d)/u);
    }
  });

  it('keeps each organization to its own runs', async () => {
    const other = seed.searchDemoIds.otherOrganization!;
    const body = await query(other, { limit: '50', preset: 'this-month', timeZone: 'UTC' });
    expect(body.items.map((item) => labelOf(item.runId)).sort()).toEqual(['b01', 'b02', 'b03', 'b04', 'b05', 'b06']);
    expect(body.items.every((item) => item.distanceM >= 15_000)).toBe(true);
    expect(body.pendingSummaryCount).toBe(0);
  });

  it('gives the stranger no way to see the runner’s organization', async () => {
    await request(app)
      .get(`/api/orgs/${seed.searchDemoIds.organization!}/runs/search?preset=this-month&timeZone=UTC`)
      .set('Cookie', outsiderCookie)
      .expect(403);
    const own = await query(seed.searchDemoIds.otherOrganization!, { preset: 'this-month', timeZone: 'UTC' }, outsiderCookie);
    expect(own.items.map((item) => labelOf(item.runId)).sort()).toEqual(['x01', 'x02', 'x03', 'x04']);
  });

  it('puts the UTC month edge in the right month for each zone', async () => {
    const orgId = seed.searchDemoIds.organization!;
    const warsaw = await query(orgId, { limit: '50', preset: 'this-month', timeZone: 'Europe/Warsaw' });
    const utc = await query(orgId, { limit: '50', preset: 'this-month', timeZone: 'UTC' });
    const warsawLabels = warsaw.items.map((item) => labelOf(item.runId));
    expect(warsawLabels).toContain('q13');
    expect(utc.items.map((item) => labelOf(item.runId))).not.toContain('q13');
    expect(warsaw.items).toHaveLength(utc.items.length + 1);
  });

  it('orders and pages every sort over the equal values without a gap or a repeat', async () => {
    const orgId = seed.searchDemoIds.organization!;
    for (const sort of ['newest', 'longest', 'shortest'] as const) {
      const whole = await query(orgId, { limit: '50', preset: 'previous-month', sort, timeZone: 'UTC' });
      const paged = await everyPage(orgId, { limit: '4', preset: 'previous-month', sort, timeZone: 'UTC' });
      expect(paged.flatMap((page) => page.items.map((item) => item.runId))).toEqual(
        whole.items.map((item) => item.runId),
      );
    }
    const current = await everyPage(orgId, { limit: '5', preset: 'this-month', sort: 'longest', timeZone: 'UTC' });
    const labels = current.flatMap((page) => page.items.map((item) => labelOf(item.runId)));
    expect(new Set(labels).size).toBe(labels.length);
    // r15 and r16 share start and distance: the later id comes first in every order.
    expect(labels.indexOf('r16')).toBe(labels.indexOf('r15') - 1);
  });
});
