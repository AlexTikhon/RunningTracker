import { randomUUID } from 'node:crypto';

import { weeklyInsightViewSchema, type WeeklyInsightView } from '@running-tracker/contracts';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { deleteDailyMetrics, putDailyMetrics } from '../src/daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../src/database/authenticated-tenant-transaction.js';
import { createDatabasePool } from '../src/database/database.js';
import { ApiError } from '../src/http/errors.js';
import { FakeProvider, factsFromPrompt, groundedAnswer } from '../src/insights/fake-provider.js';
import { WEEKLY_INSIGHT_SUGGESTION_NULL } from '../src/insights/insight-prompt.js';
import type { LlmProvider, LlmStructuredInput, LlmStructuredResult } from '../src/insights/llm-provider.js';
import {
  WeeklyInsightService,
  type WeeklyInsightSettings,
  type WeeklyInsightTestHooks,
} from '../src/insights/weekly-insight-service.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0076 source protocol (migration 0032) against PostgreSQL with the real WeeklyInsightService. Every interleaving is
// forced with an explicit barrier, and "is blocked" is observed in pg_locks, never assumed from timing. The first test
// is the reproduction of the Stop 1 defect: with migration 0031 alone it ended with a ready insight quoting the deleted
// check-in (sleep 450 min), while both the check-in and the insight count were zero at the pause.
const now = '2026-11-20T10:00:00.000Z';
const WEEK = '2026-11-02';
const ZONE = 'Europe/Warsaw';
const owner = { userId: ids.userOrgA };
const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(now),
};
const silent = createLogger({ clock, minLevel: 'error', write: () => undefined });
const settings: WeeklyInsightSettings = {
  attemptTimeoutMs: 5_000,
  maxAttempts: 3,
  maxOutputTokens: 800,
  maxPerPerson: 4,
  maxQueue: 8,
  totalBudgetMs: 10_000,
};

interface Barrier {
  open: () => void;
  opened: Promise<void>;
}

function barrier(): Barrier {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** Pauses the first call only: signals `reached`, then waits for `release`. */
function pauseOnce(reached: Barrier, release: Barrier): () => Promise<void> {
  let used = false;
  return async () => {
    if (used) return;
    used = true;
    reached.open();
    await release.opened;
  };
}

/** A model that answers when `gate` opens and ignores cancellation: a late completion. */
class LateProvider implements LlmProvider {
  public readonly model = 'fake';
  public readonly calls: LlmStructuredInput[] = [];
  public constructor(private readonly gate: Promise<void>) {}
  public async generateStructured(input: LlmStructuredInput): Promise<LlmStructuredResult> {
    this.calls.push(input);
    await this.gate;
    return { value: groundedAnswer(factsFromPrompt(input.user), input.user.includes(WEEKLY_INSIGHT_SUGGESTION_NULL)) };
  }
}

describe('ADR-0076 weekly insight source protocol against PostgreSQL (migration 0032)', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  const services: WeeklyInsightService[] = [];

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    runtimePool = createDatabasePool({ ...integration.environment, DB_POOL_MAX: 8 });
    ownerPool = new Pool({ application_name: 'rt-insight-concurrency-owner', connectionString: integration.migration.connectionString, max: 4 });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM weekly_insights');
    await ownerPool.query('DELETE FROM daily_metrics');
    await ownerPool.query('DELETE FROM activities');
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop();
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await ownerPool?.query('DELETE FROM daily_metrics').catch(() => undefined);
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await ownerPool?.query('DELETE FROM run_tombstones').catch(() => undefined);
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function build(provider: LlmProvider, hooks: WeeklyInsightTestHooks = {}): WeeklyInsightService {
    const service = new WeeklyInsightService({ clock, hooks, logger: silent, pool: runtimePool, provider, settings });
    services.push(service);
    return service;
  }

  const asOwner = <Result>(work: Parameters<typeof withAuthenticatedTenantTransaction<Result>>[3]) =>
    withAuthenticatedTenantTransaction(runtimePool, owner, ids.orgA, work);

  const ask = (service: WeeklyInsightService, timeZone = ZONE, weekStart = WEEK) =>
    service.request(owner, ids.orgA, { timeZone, weekStart });

  async function readOrNull(service: WeeklyInsightService, weekStart = WEEK): Promise<WeeklyInsightView | null> {
    try {
      return weeklyInsightViewSchema.parse(await service.read(owner, ids.orgA, weekStart));
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async function checkIn(localDate: string, sleepMinutes: number): Promise<void> {
    await asOwner((client) => putDailyMetrics(client, owner, ids.orgA, localDate, { sleepMinutes, timeZone: ZONE }, clock));
  }

  async function rows(): Promise<{ id: string; status: string; time_zone: string }[]> {
    return (
      await ownerPool.query<{ id: string; status: string; time_zone: string }>(
        'SELECT id, status, time_zone FROM weekly_insights ORDER BY created_at',
      )
    ).rows;
  }

  /** Resolves once at least `count` lock requests are waiting (observed in pg_locks); fails after five seconds. */
  async function waitForBlockedLocks(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await ownerPool.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_locks WHERE NOT granted");
      if (Number(waiting.rows[0]!.count) >= count) return;
      if (Date.now() > deadline) throw new Error(`Expected ${count} blocked lock requests in pg_locks`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function stillPending(promise: Promise<unknown>, ms = 150): Promise<boolean> {
    const marker = Symbol('pending');
    const settled = await Promise.race([promise.then(() => 'settled' as const, () => 'settled' as const), new Promise((resolve) => setTimeout(() => resolve(marker), ms))]);
    return settled === marker;
  }

  async function waitUntil(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('a deletion after the sources were read and before the row is inserted waits for the request, then erases its row; nothing is published', async () => {
    await checkIn('2026-11-03', 450);
    const reached = barrier();
    const release = barrier();
    const provider = new FakeProvider();
    const service = build(provider, { afterSourcesRead: pauseOnce(reached, release) });

    const requested = ask(service);
    await reached.opened;
    // Direct permitted SQL of the object owner: no service code is involved on this side.
    const deletion = ownerPool.query('DELETE FROM daily_metrics WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await waitForBlockedLocks(1);
    expect(await stillPending(deletion)).toBe(true);

    release.open();
    await requested;
    await deletion;
    await service.whenIdle();

    expect(await rows()).toEqual([]);
    expect(await readOrNull(service)).toBeNull();
    const sources = await ownerPool.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_metrics');
    expect(sources.rows[0]!.count).toBe('0');
  });

  it('the same window through the API deletion path (runtime role, RLS) is serialised the same way', async () => {
    await checkIn('2026-11-03', 450);
    const reached = barrier();
    const release = barrier();
    const service = build(new FakeProvider(), { afterSourcesRead: pauseOnce(reached, release) });
    const requested = ask(service);
    await reached.opened;
    const deletion = asOwner((client) => deleteDailyMetrics(client, owner, ids.orgA, '2026-11-03'));
    await waitForBlockedLocks(1);
    release.open();
    await requested;
    await deletion;
    await service.whenIdle();
    expect(await rows()).toEqual([]);
  });

  it('a deletion during inference erases the row; the late result is discarded', async () => {
    await checkIn('2026-11-03', 450);
    const answer = barrier();
    const provider = new FakeProvider({ beforeAnswer: () => answer.opened });
    const service = build(provider);
    await ask(service);
    await waitUntil(() => provider.calls.length === 1, 'the model call');
    // No transaction is open during inference, so the deletion is not blocked at all.
    await asOwner((client) => deleteDailyMetrics(client, owner, ids.orgA, '2026-11-03'));
    expect(await rows()).toEqual([]);
    answer.open();
    await service.whenIdle();
    expect(await rows()).toEqual([]);
    expect(await readOrNull(service)).toBeNull();
  });

  it('a replacement of a source during inference erases the row; asking again generates from the new values', async () => {
    await checkIn('2026-11-03', 450);
    const answer = barrier();
    const provider = new FakeProvider({ beforeAnswer: () => answer.opened });
    const service = build(provider);
    await ask(service);
    await waitUntil(() => provider.calls.length === 1, 'the model call');
    await checkIn('2026-11-03', 300);
    expect(await rows()).toEqual([]);
    answer.open();
    await service.whenIdle();
    expect(await rows()).toEqual([]);

    const fresh = build(new FakeProvider());
    await ask(fresh);
    await fresh.whenIdle();
    const view = await readOrNull(fresh);
    expect(view).toMatchObject({ freshness: 'current', status: 'ready' });
    expect(view!.output!.observations.flatMap((observation) => observation.facts.map((fact) => fact.text))).toContain('Average sleep: 300 min');
  });

  it('two concurrent requests with different inputs are serialised by the gate: the second replaces the first, and only its result is stored', async () => {
    // No check-ins: the request's zone decides the week, so the two requests have different inputs.
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s) VALUES ($1, $2, $3, 'walk', '2026-11-04T12:00:00Z', 1800)`,
      [ids.orgA, randomUUID(), ids.userOrgA],
    );
    const reached = barrier();
    const release = barrier();
    const provider = new FakeProvider();
    const service = build(provider, { afterSourcesRead: pauseOnce(reached, release) });

    const first = ask(service, 'Europe/Warsaw');
    await reached.opened;
    const second = ask(service, 'America/New_York');
    await waitForBlockedLocks(1);
    expect(await stillPending(second)).toBe(true);
    release.open();
    const [firstAccepted, secondAccepted] = await Promise.all([first, second]);
    await service.whenIdle();

    expect(secondAccepted.id).not.toBe(firstAccepted.id);
    expect(await rows()).toEqual([{ id: secondAccepted.id, status: 'ready', time_zone: 'America/New_York' }]);
    expect(await readOrNull(service)).toMatchObject({ freshness: 'current', id: secondAccepted.id, status: 'ready' });
  });

  it('a late completion in another process cannot overwrite the replacement, and leaves no pending row', async () => {
    await checkIn('2026-11-03', 450);
    const late = barrier();
    const lateProvider = new LateProvider(late.opened);
    const slow = build(lateProvider);
    const replacing = build(new FakeProvider());

    const original = await ask(slow);
    await waitUntil(() => lateProvider.calls.length === 1, 'the slow model call');
    await checkIn('2026-11-04', 420);
    const replacement = await ask(replacing);
    await replacing.whenIdle();
    expect(replacement.id).not.toBe(original.id);
    expect(await rows()).toEqual([{ id: replacement.id, status: 'ready', time_zone: ZONE }]);

    late.open();
    await slow.whenIdle();
    expect(await rows()).toEqual([{ id: replacement.id, status: 'ready', time_zone: ZONE }]);
    const view = await readOrNull(replacing);
    expect(view).toMatchObject({ freshness: 'current', id: replacement.id, status: 'ready' });
    expect(view!.output!.observations.flatMap((observation) => observation.facts.map((fact) => fact.text))).toContain('Average sleep: 435 min');
  });

  it('a late completion after its own row was erased stores nothing, even though its model call ignored cancellation', async () => {
    await checkIn('2026-11-03', 450);
    const late = barrier();
    const lateProvider = new LateProvider(late.opened);
    const service = build(lateProvider);
    await ask(service);
    await waitUntil(() => lateProvider.calls.length === 1, 'the model call');
    await asOwner((client) => deleteDailyMetrics(client, owner, ids.orgA, '2026-11-03'));
    late.open();
    await service.whenIdle();
    expect(await rows()).toEqual([]);
  });

  it('refuses an insight inserted for a source revision that is no longer current, whoever inserts it', async () => {
    const revision = async () =>
      (
        await ownerPool.query<{ revision: string }>(
          'SELECT coalesce((SELECT revision FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2), 0)::text AS revision',
          [ids.orgA, ids.userOrgA],
        )
      ).rows[0]!.revision;
    const insert = (pool: Pool | PoolClient, sourceRevision: string) =>
      pool.query(
        `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision,
                                      model, prompt_version, policy_version, job_token, lease_expires_at)
         VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
                 repeat('a', 64), $4::bigint, 'fake', 'weekly-insight-v4', 'weekly-insight-policy-2', gen_random_uuid(),
                 clock_timestamp() + interval '1 minute')`,
        [ids.orgA, ids.userOrgA, WEEK, sourceRevision],
      );

    const before = await revision();
    await checkIn('2026-11-03', 450);
    // The object owner: the trigger refuses the stale revision.
    await expect(insert(ownerPool, before)).rejects.toMatchObject({ code: '40001' });
    // The runtime role, under RLS, without taking the gate first: refused the same way.
    await expect(asOwner((client) => insert(client, before))).rejects.toMatchObject({ code: '40001' });
    // With the current revision it is accepted.
    await asOwner(async (client) => {
      const current = (await client.query<{ revision: string }>("SELECT app_private.lock_weekly_insight_sources('exclusive')::text AS revision")).rows[0]!.revision;
      await insert(client, current);
    });
    expect(await rows()).toHaveLength(1);
  });

  it('a GPS run counts a distance only from a current summary; a late upload makes it a data gap and the insight stale, and publication fixes both', async () => {
    const runId = randomUUID();
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'finished', '2026-11-05T07:00:00Z', '2026-11-05T07:00:00Z', '2026-11-05T07:40:00Z', 2, 0, 'available')`,
      [ids.orgA, runId, ids.userOrgA],
    );
    const summary = (sourceRevision: number) =>
      ownerPool.query(
        `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s,
                                    quality_stats, computed_at)
         VALUES ($1, $2, $3, 'it-v1', ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326), 5000, 2400,
                 jsonb_build_object('rawPointCount', 3, 'acceptedPointCount', 3, 'acceptedEdgeCount', 2, 'poorAccuracyPointCount', 0,
                   'seqGapCount', 0, 'segmentBreakCount', 0, 'nonpositiveTimeDeltaCount', 0, 'excessiveTimeGapCount', 0,
                   'excessiveSpeedCount', 0, 'insufficientData', false), now())
         ON CONFLICT (org_id, run_id) DO UPDATE SET source_revision = EXCLUDED.source_revision`,
        [ids.orgA, runId, sourceRevision],
      );
    try {
      await summary(1); // older than the run's data (revision 2): stale
      const service = build(new FakeProvider());
      await ask(service);
      await service.whenIdle();
      const stale = await readOrNull(service);
      expect(stale).toMatchObject({ freshness: 'current', status: 'ready' });
      expect(stale!.output!.dataGaps.map((gap) => gap.code)).toContain('gps_distance_pending');

      await summary(2); // the summary is published for the current data
      expect(await readOrNull(service)).toMatchObject({ freshness: 'stale', status: 'ready' });
      await ask(service);
      await service.whenIdle();
      const published = await readOrNull(service);
      expect(published).toMatchObject({ freshness: 'current', status: 'ready' });
      expect(published!.output!.dataGaps.map((gap) => gap.code)).not.toContain('gps_distance_pending');

      // A late point upload inside the upload window bumps the run's data revision: the summary is stale again.
      await ownerPool.query('UPDATE runs SET data_revision = data_revision + 1 WHERE org_id = $1 AND id = $2', [ids.orgA, runId]);
      expect(await readOrNull(service)).toMatchObject({ freshness: 'stale' });
    } finally {
      await ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [ids.orgA, runId]);
    }
  });

  describe('restore replays when the erased record is already absent', () => {
    async function seedInsight(userId: string, weekStart: string): Promise<void> {
      await ownerPool.query(
        `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision,
                                      model, prompt_version, policy_version, status, output)
         VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
                 repeat('b', 64),
                 coalesce((SELECT revision FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2), 0),
                 'fake', 'weekly-insight-v4', 'weekly-insight-policy-2', 'interrupted', NULL)`,
        [ids.orgA, userId, weekStart],
      );
    }
    const counts = async () =>
      (
        await ownerPool.query<{ owner: string; other: string }>(
          `SELECT count(*) FILTER (WHERE user_id = $1)::text AS owner, count(*) FILTER (WHERE user_id <> $1)::text AS other
           FROM weekly_insights`,
          [ids.userOrgA],
        )
      ).rows[0]!;

    it('an absent erased check-in or activity invalidates its owner\'s insights that could have read it, once, and nobody else\'s', async () => {
      await seedInsight(ids.userOrgA, '2026-10-05');
      await seedInsight(ids.userOrgA, '2026-10-12');
      await seedInsight(ids.userStranger, '2026-10-05');
      const replay = (type: string, recordCreatedAt: string) =>
        ownerPool.query<{ outcome: string }>('SELECT app_private.reapply_erasure($1, $2, $3, $4, $5::timestamptz) AS outcome', [
          type,
          ids.orgA,
          randomUUID(),
          ids.userOrgA,
          recordCreatedAt,
        ]);
      // A record created after every stored insight: none of them can have read it, none is touched.
      expect((await replay('activity', '2999-01-01T00:00:00Z')).rows[0]!.outcome).toBe('absent');
      expect(await counts()).toEqual({ other: '1', owner: '2' });
      // A record created before them: its week is unknown, so all of the owner's insights go; the other person's stay.
      expect((await replay('daily_metric', '2000-01-01T00:00:00Z')).rows[0]!.outcome).toBe('absent');
      expect(await counts()).toEqual({ other: '1', owner: '0' });
      // Replaying again changes nothing.
      expect((await replay('daily_metric', '2000-01-01T00:00:00Z')).rows[0]!.outcome).toBe('absent');
      expect(await counts()).toEqual({ other: '1', owner: '0' });
    });

    it('an absent journaled run invalidates its owner\'s insights; the outcome is unchanged', async () => {
      await seedInsight(ids.userOrgA, '2026-10-05');
      await seedInsight(ids.userStranger, '2026-10-05');
      const outcome = await ownerPool.query<{ outcome: string }>(
        'SELECT app_private.reapply_journaled_deletion($1, $2, $3, now(), now()) AS outcome',
        [ids.orgA, randomUUID(), ids.userOrgA],
      );
      expect(outcome.rows[0]!.outcome).toBe('marker_restored');
      expect(await counts()).toEqual({ other: '1', owner: '0' });
    });
  });
});
