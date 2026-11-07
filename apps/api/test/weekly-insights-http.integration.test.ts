import {
  apiErrorResponseSchema,
  weeklyInsightAcceptedSchema,
  weeklyInsightViewSchema,
  type WeeklyInsightView,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { FAKE_PROVIDER_MODEL, FakeProvider, factsFromPrompt } from '../src/insights/fake-provider.js';
import { WEEKLY_INSIGHT_PROMPT_VERSION } from '../src/insights/insight-prompt.js';
import type { LlmProvider } from '../src/insights/llm-provider.js';
import { WEEKLY_INSIGHT_POLICY_VERSION } from '../src/insights/weekly-aggregate.js';
import { WeeklyInsightService, type WeeklyInsightSettings } from '../src/insights/weekly-insight-service.js';
import { createLogger } from '../src/observability/logger.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0076 over HTTP, with the real runtime role, session, Origin and CSRF checks, and the deterministic FakeProvider:
// no test here can reach Ollama. The service is built by the test so that it can wait for the queue to drain.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-20T10:00:00.000Z';
const WEEK = '2026-11-02';
const silent = createLogger({ clock: { utcNow: () => new Date(now) }, minLevel: 'error', write: () => undefined });

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(now),
};

interface Authentication {
  cookie: string;
  csrfToken: string;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

const errorCode = (response: request.Response) => apiErrorResponseSchema.parse(response.body).error.code;

describe('ADR-0076 weekly insights HTTP API', () => {
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let sessions: SessionManager;
  let provider: FakeProvider;
  let service: WeeklyInsightService;
  let app: ReturnType<typeof createApp>;
  let owner: Authentication;
  let stranger: Authentication;
  let grantee: Authentication;
  let outsider: Authentication;
  const services: WeeklyInsightService[] = [];

  const settings: WeeklyInsightSettings = {
    attemptTimeoutMs: 5_000,
    maxAttempts: 3,
    maxOutputTokens: 800,
    maxPerPerson: 2,
    maxQueue: 16,
    totalBudgetMs: 15_000,
  };

  function build(withProvider: LlmProvider | undefined, override: Partial<WeeklyInsightSettings> = {}) {
    const built = new WeeklyInsightService({ clock, logger: silent, pool: runtimePool, provider: withProvider, settings: { ...settings, ...override } });
    services.push(built);
    return { app: createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions, weeklyInsights: built }), service: built };
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userDual, ids.userOrgB].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ application_name: 'running-tracker-insight-http-owner', connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    sessions = new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    provider = new FakeProvider();
    ({ app, service } = build(provider));
    owner = await login(ids.userOrgA);
    stranger = await login(ids.userStranger);
    grantee = await login(ids.userDual);
    outsider = await login(ids.userOrgB);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    provider.mode = 'grounded';
    provider.calls.length = 0;
  });

  afterAll(async () => {
    for (const built of services) await built.stop();
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM daily_metrics').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const insightsPath = (orgId: string) => `/api/orgs/${orgId}/insights/weekly`;

  const post = (auth: Authentication, body: unknown, options: { orgId?: string; target?: ReturnType<typeof createApp> } = {}) =>
    request(options.target ?? app)
      .post(insightsPath(options.orgId ?? ids.orgA))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send(body as object);

  const get = (auth: Authentication, weekStart: string, options: { orgId?: string; target?: ReturnType<typeof createApp> } = {}) =>
    request(options.target ?? app).get(insightsPath(options.orgId ?? ids.orgA)).query({ weekStart }).set('Cookie', auth.cookie);

  const ask = (auth: Authentication = owner, weekStart = WEEK, timeZone = 'Europe/Warsaw') => post(auth, { timeZone, weekStart });

  async function generate(auth: Authentication = owner, weekStart = WEEK, target = service): Promise<WeeklyInsightView> {
    const accepted = weeklyInsightAcceptedSchema.parse((await ask(auth, weekStart).expect(202)).body);
    await target.whenIdle();
    const view = weeklyInsightViewSchema.parse((await get(auth, weekStart).expect(200)).body);
    expect(view.id).toBe(accepted.id);
    return view;
  }

  async function checkIn(userId: string, localDate: string, values: string, note: string | null = null) {
    await ownerPool.query(
      `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood, sleep_minutes, soreness, note)
       SELECT $1, $2, $3::date, 'Europe/Warsaw', v.mood, v.sleep, v.soreness, $5
       FROM (SELECT (string_to_array($4, ','))[1]::smallint AS mood, (string_to_array($4, ','))[2]::int AS sleep,
                    (string_to_array($4, ','))[3]::smallint AS soreness) AS v`,
      [ids.orgA, userId, localDate, values, note],
    );
  }

  async function activity(id: string, startedAt: string, notes: string | null = null) {
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, notes)
       VALUES ($1, $2, $3, 'run', $4::timestamptz, 1800, 5000, $5)`,
      [ids.orgA, id, ids.userOrgA, startedAt, notes],
    );
  }

  const storedCount = async () =>
    Number((await ownerPool.query<{ count: string }>('SELECT count(*)::text AS count FROM weekly_insights')).rows[0]!.count);

  it('accepts with 202, generates in the background and serves a ready, grounded insight with no-store', async () => {
    await checkIn(ids.userOrgA, '2026-11-02', '4,450,2');
    await checkIn(ids.userOrgA, '2026-11-04', '3,420,3');
    const accepted = await ask().expect(202);
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(weeklyInsightAcceptedSchema.parse(accepted.body).status).toBe('queued');
    await service.whenIdle();
    const read = await get(owner, WEEK).expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const view = weeklyInsightViewSchema.parse(read.body);
    expect(view).toMatchObject({
      attempts: 1,
      failureReason: null,
      freshness: 'current',
      model: FAKE_PROVIDER_MODEL,
      policyVersion: WEEKLY_INSIGHT_POLICY_VERSION,
      promptVersion: WEEKLY_INSIGHT_PROMPT_VERSION,
      retryable: false,
      status: 'ready',
      timeZone: 'Europe/Warsaw',
      weekStart: WEEK,
    });
    expect(view.output?.summary).toBe('A calm look at your week, based on what you logged.');
    // Every number shown is rendered by code from the facts the model cited.
    expect(view.output?.observations.flatMap((observation) => observation.facts.map((fact) => fact.text))).toEqual([
      'Days with a check-in: 2 of 7',
      'Average sleep: 435 min',
      'Shortest sleep: 420 min (Wednesday)',
      'Longest sleep: 450 min (Monday)',
    ]);
    expect(view.output?.dataGaps.map((gap) => gap.code)).toEqual(['missing_check_in_days', 'no_activities']);
  });

  it('returns the existing insight for the same input without calling the model again', async () => {
    await checkIn(ids.userOrgA, '2026-11-03', '4,450,2');
    const first = await generate();
    expect(provider.calls).toHaveLength(1);
    const again = weeklyInsightAcceptedSchema.parse((await ask().expect(202)).body);
    expect(again).toEqual({ id: first.id, status: 'ready' });
    await service.whenIdle();
    expect(provider.calls).toHaveLength(1);
  });

  it('replaces the week\'s insight when its input changes', async () => {
    await checkIn(ids.userOrgA, '2026-11-03', '4,450,2');
    const first = await generate();
    await activity('c0000000-0000-4000-8000-0000000000b1', '2026-11-05T07:00:00Z');
    const second = await generate();
    expect(second.id).not.toBe(first.id);
    expect(provider.calls).toHaveLength(2);
    expect(await storedCount()).toBe(1);
  });

  it('stores generation_failed after two schema failures, and retries it on the next request (attempts counted)', async () => {
    provider.mode = 'invalid_schema';
    const failed = await generate();
    expect(failed).toMatchObject({ attempts: 1, failureReason: 'schema_invalid', output: null, retryable: true, status: 'generation_failed' });
    expect(provider.calls).toHaveLength(2);
    provider.mode = 'grounded';
    const retried = weeklyInsightAcceptedSchema.parse((await ask().expect(202)).body);
    expect(retried).toEqual({ id: failed.id, status: 'queued' });
    await service.whenIdle();
    expect(weeklyInsightViewSchema.parse((await get(owner, WEEK).expect(200)).body)).toMatchObject({ attempts: 2, id: failed.id, status: 'ready' });
  });

  it('stores generation_failed for a provider timeout after the whole attempt budget, and stops at the retry limit', async () => {
    provider.mode = 'timeout';
    expect(await generate()).toMatchObject({ failureReason: 'timeout', output: null, status: 'generation_failed' });
    expect(provider.calls).toHaveLength(3);
    await ask().expect(202);
    await service.whenIdle();
    await ask().expect(202);
    await service.whenIdle();
    expect(weeklyInsightViewSchema.parse((await get(owner, WEEK).expect(200)).body)).toMatchObject({
      attempts: 3,
      retryable: false,
      status: 'generation_failed',
    });
    expect(errorCode(await ask().expect(409))).toBe('WEEKLY_INSIGHT_RETRY_LIMIT');
    expect(provider.calls).toHaveLength(9);
  });

  it('discards a number in prose as failed_grounding and does not retry it for the same input', async () => {
    await checkIn(ids.userOrgA, '2026-11-03', '4,450,2');
    provider.mode = 'number_in_prose';
    const failed = await generate();
    expect(failed).toMatchObject({ failureReason: 'number_in_prose', output: null, retryable: false, status: 'failed_grounding' });
    provider.mode = 'grounded';
    expect(weeklyInsightAcceptedSchema.parse((await ask().expect(202)).body)).toEqual({ id: failed.id, status: 'failed_grounding' });
    await service.whenIdle();
    expect(provider.calls).toHaveLength(1);
    const stored = await ownerPool.query<{ output: unknown }>('SELECT output FROM weekly_insights');
    expect(stored.rows).toEqual([{ output: null }]);
  });

  it('discards a claim of an unknown fact as failed_grounding', async () => {
    provider.mode = 'unknown_fact';
    expect(await generate()).toMatchObject({ failureReason: 'unknown_fact', output: null, status: 'failed_grounding' });
  });

  it('discards medical content as failed_safety; in an extreme week the suggestion is the approved one', async () => {
    provider.mode = 'unsafe_medication';
    expect(await generate()).toMatchObject({ failureReason: 'medication', output: null, status: 'failed_safety' });
    await checkIn(ids.userOrgA, '2026-11-10', '2,300,9');
    provider.mode = 'extreme_model_suggestion';
    const extreme = await generate(owner, '2026-11-09');
    expect(extreme).toMatchObject({ status: 'ready' });
    expect(extreme.output?.suggestion).toMatchObject({ id: 'rest_and_recovery', source: 'approved' });
  });

  it('isolates insights: another member, a coach, a grantee and another organization see none of the owner\'s', async () => {
    await generate();
    expect(errorCode(await get(stranger, WEEK).expect(404))).toBe('WEEKLY_INSIGHT_NOT_FOUND');
    expect(errorCode(await get(grantee, WEEK).expect(404))).toBe('WEEKLY_INSIGHT_NOT_FOUND');
    expect(errorCode(await get(outsider, WEEK, { orgId: ids.orgA }).expect(403))).toBe('ORG_ACCESS_DENIED');
    expect(errorCode(await get(owner, WEEK, { orgId: ids.orgB }).expect(403))).toBe('ORG_ACCESS_DENIED');
    // Their own request for the same week is their own row, built from their own (empty) data.
    const theirs = await generate(stranger);
    expect(theirs.id).not.toBe(weeklyInsightViewSchema.parse((await get(owner, WEEK).expect(200)).body).id);
  });

  it('aggregates only the person\'s own GPS runs, even those they can read through sharing', async () => {
    // userOrgA owns three finished runs on 2026-09-20; userDual holds history grants on some of them.
    await generate(owner, '2026-09-14');
    await generate(grantee, '2026-09-14');
    const [ownerCall, granteeCall] = provider.calls.map((call) => factsFromPrompt(call.user).find((fact) => fact.id === 'gps.runs')?.value);
    expect(ownerCall).toBe(3);
    expect(granteeCall).toBe(0);
  });

  it('never sends check-in notes or activity notes to the model', async () => {
    await checkIn(ids.userOrgA, '2026-11-03', '4,450,2', 'SECRET-CHECKIN-NOTE');
    await activity('c0000000-0000-4000-8000-0000000000b2', '2026-11-04T07:00:00Z', 'SECRET-ACTIVITY-NOTE');
    await generate();
    expect(provider.calls[0]!.user).not.toMatch(/SECRET/u);
    expect(provider.calls[0]!.system).not.toMatch(/SECRET/u);
  });

  it('deleting a source record over HTTP deletes the week\'s insight', async () => {
    await activity('c0000000-0000-4000-8000-0000000000b3', '2026-11-05T07:00:00Z');
    await generate();
    await request(app)
      .delete(`/api/orgs/${ids.orgA}/activities/c0000000-0000-4000-8000-0000000000b3`)
      .set('Cookie', owner.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, owner.csrfToken)
      .expect(204);
    expect(errorCode(await get(owner, WEEK).expect(404))).toBe('WEEKLY_INSIGHT_NOT_FOUND');
  });

  it('discards a result whose source record was erased while it was being generated', async () => {
    let release!: () => void;
    const held = new FakeProvider({ beforeAnswer: () => new Promise<void>((resolve) => (release = resolve)) });
    const holding = build(held);
    await checkIn(ids.userOrgA, '2026-11-06', '4,450,2');
    await post(owner, { timeZone: 'Europe/Warsaw', weekStart: WEEK }, { target: holding.app }).expect(202);
    await expect.poll(() => held.calls.length).toBe(1);
    await request(holding.app)
      .delete(`/api/orgs/${ids.orgA}/daily-metrics/2026-11-06`)
      .set('Cookie', owner.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, owner.csrfToken)
      .expect(204);
    expect(await storedCount()).toBe(0);
    release();
    await holding.service.whenIdle();
    expect(await storedCount()).toBe(0);
    expect(errorCode(await get(owner, WEEK, { target: holding.app }).expect(404))).toBe('WEEKLY_INSIGHT_NOT_FOUND');
  });

  it('marks the job interrupted at shutdown; asking again retries it', async () => {
    const stuck = build(new FakeProvider({ beforeAnswer: () => new Promise<void>(() => undefined) }));
    const accepted = weeklyInsightAcceptedSchema.parse(
      (await post(owner, { timeZone: 'Europe/Warsaw', weekStart: WEEK }, { target: stuck.app }).expect(202)).body,
    );
    await expect.poll(async () => weeklyInsightViewSchema.parse((await get(owner, WEEK).expect(200)).body).status).toBe('running');
    await stuck.service.stop(); // as at shutdown: the running generation is cancelled and the row says so
    expect((await get(owner, WEEK).expect(200)).body).toMatchObject({
      failureReason: 'shutdown',
      id: accepted.id,
      retryable: true,
      status: 'interrupted',
    });
    expect(weeklyInsightAcceptedSchema.parse((await ask().expect(202)).body)).toEqual({ id: accepted.id, status: 'queued' });
    await service.whenIdle();
    expect((await get(owner, WEEK).expect(200)).body).toMatchObject({ attempts: 2, id: accepted.id, status: 'ready' });
  });

  it('reports a job whose process died (expired lease) as interrupted, and retries it on request', async () => {
    await generate();
    await ownerPool.query(
      "UPDATE weekly_insights SET status = 'running', output = NULL, job_token = gen_random_uuid(), lease_expires_at = clock_timestamp() - interval '1 second'",
    );
    expect((await get(owner, WEEK).expect(200)).body).toMatchObject({ failureReason: 'lease_expired', output: null, status: 'interrupted' });
    expect(weeklyInsightAcceptedSchema.parse((await ask().expect(202)).body).status).toBe('queued');
    await service.whenIdle();
    expect((await get(owner, WEEK).expect(200)).body).toMatchObject({ attempts: 2, status: 'ready' });
  });

  it('answers 503 when the queue is full and stores nothing for the refused week', async () => {
    const busy = build(new FakeProvider({ beforeAnswer: () => new Promise<void>(() => undefined) }), { maxPerPerson: 1, maxQueue: 0 });
    await post(owner, { timeZone: 'Europe/Warsaw', weekStart: WEEK }, { target: busy.app }).expect(202);
    const refused = await post(owner, { timeZone: 'Europe/Warsaw', weekStart: '2026-11-09' }, { target: busy.app }).expect(503);
    expect(errorCode(refused)).toBe('WEEKLY_INSIGHTS_BUSY');
    expect(errorCode(await get(owner, '2026-11-09').expect(404))).toBe('WEEKLY_INSIGHT_NOT_FOUND');
    // A ready insight is still served while the queue is full: no queue place is needed for it.
    await busy.service.stop();
  });

  it('reports a stale insight when a source was added, and a policy-outdated one without its output', async () => {
    await checkIn(ids.userOrgA, '2026-11-03', '4,450,2');
    await generate();
    await checkIn(ids.userOrgA, '2026-11-04', '3,420,3');
    expect((await get(owner, WEEK).expect(200)).body).toMatchObject({ freshness: 'stale', retryable: true, status: 'ready' });
    await ownerPool.query("UPDATE weekly_insights SET policy_version = 'weekly-insight-policy-1'");
    const outdated = weeklyInsightViewSchema.parse((await get(owner, WEEK).expect(200)).body);
    expect(outdated).toMatchObject({ freshness: 'outdated_policy', output: null, status: 'ready' });
  });

  it('marks the row interrupted when the result cannot be stored, after bounded retries', async () => {
    const failing = new WeeklyInsightService({
      clock,
      hooks: { publish: () => Promise.reject(new Error('database unavailable')) },
      logger: silent,
      pool: runtimePool,
      provider: new FakeProvider(),
      settings,
    });
    services.push(failing);
    const failingApp = createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions, weeklyInsights: failing });
    await post(owner, { timeZone: 'Europe/Warsaw', weekStart: WEEK }, { target: failingApp }).expect(202);
    await failing.whenIdle();
    expect((await get(owner, WEEK).expect(200)).body).toMatchObject({ failureReason: 'persistence_failed', status: 'interrupted' });
  });

  it('answers 503 WEEKLY_INSIGHTS_DISABLED without a model, but still serves stored insights', async () => {
    await generate();
    const disabled = build(undefined);
    expect(errorCode(await post(owner, { timeZone: 'Europe/Warsaw', weekStart: WEEK }, { target: disabled.app }).expect(503))).toBe(
      'WEEKLY_INSIGHTS_DISABLED',
    );
    expect((await get(owner, WEEK, { target: disabled.app }).expect(200)).body).toMatchObject({ status: 'ready' });
  });

  it('validates the request: a Monday, not in the future, a known zone, a session, Origin and CSRF token', async () => {
    expect(errorCode(await ask(owner, '2026-11-03').expect(400))).toBe('INVALID_REQUEST');
    expect(errorCode(await ask(owner, '2026-11-23').expect(400))).toBe('INVALID_REQUEST');
    expect(errorCode(await post(owner, { timeZone: 'Mars/Base', weekStart: WEEK }).expect(400))).toBe('INVALID_REQUEST');
    expect(errorCode(await post(owner, { extra: 1, timeZone: 'UTC', weekStart: WEEK }).expect(400))).toBe('INVALID_REQUEST');
    expect(errorCode(await get(owner, '2026-11-04').expect(400))).toBe('INVALID_REQUEST');
    await request(app).post(insightsPath(ids.orgA)).set('Origin', allowedOrigin).type('application/json').send({ timeZone: 'UTC', weekStart: WEEK }).expect(401);
    await request(app)
      .post(insightsPath(ids.orgA))
      .set('Cookie', owner.cookie)
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ timeZone: 'UTC', weekStart: WEEK })
      .expect(403);
    // The current week (in progress) is allowed.
    await ask(owner, '2026-11-16').expect(202);
    await service.whenIdle();
    expect(provider.calls.map((call) => call.user.includes('week_in_progress'))).toEqual([true]);
    expect(await storedCount()).toBe(1);
  });
});
