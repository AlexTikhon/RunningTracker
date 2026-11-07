import { createHash, randomUUID } from 'node:crypto';

import {
  WEEKLY_INSIGHT_MAX_ATTEMPTS,
  WEEKLY_INSIGHT_NOT_FOUND,
  WEEKLY_INSIGHT_RETRY_LIMIT,
  WEEKLY_INSIGHTS_BUSY,
  WEEKLY_INSIGHTS_DISABLED,
  weeklyInsightAcceptedSchema,
  weeklyInsightOutputSchema,
  weeklyInsightViewSchema,
  type ActivityType,
  type CreateWeeklyInsightRequest,
  type WeeklyInsightAccepted,
  type WeeklyInsightFreshness,
  type WeeklyInsightStatus,
  type WeeklyInsightView,
} from '@running-tracker/contracts';
import type { Pool, PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { withTenantTransaction } from '../database/tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../observability/logger.js';
import { localDateOf } from '../runs/run-search-period.js';
import { generateWeeklyInsight, type GenerationOutcome } from './insight-generator.js';
import { WEEKLY_INSIGHT_PROMPT_VERSION } from './insight-prompt.js';
import { SerialJobQueue, type QueuedJob, type Reservation } from './insight-queue.js';
import type { LlmProvider } from './llm-provider.js';
import {
  WEEKLY_INSIGHT_POLICY_VERSION,
  aggregateWeek,
  canonicalJson,
  resolveWeekWindow,
  todayIn,
  type CheckInRecord,
  type GpsRunRecord,
  type ManualActivityRecord,
  type WeeklyAggregate,
} from './weekly-aggregate.js';

// Weekly insights (ADR-0076): the request, the background job and the read.
//
// Request (POST): reserve a queue place (nothing is changed when there is none), then ONE short READ COMMITTED
// transaction: lock the person's source gate exclusively (migration 0032), read every source in ONE statement, keep,
// retry or replace the week's row, commit. Only then is the job handed to the queue. No connection or transaction is
// held while the model works.
//
// Job: mark the row running (only if its job token is still the row's), generate within the budget, then publish in a
// separate short transaction that takes the gate FOR SHARE and updates the row only if it is still running with the
// same token. A row erased by a source deletion, or replaced by a newer request, is simply not found: the result is
// discarded. Shutdown and a failed publication mark the row interrupted; a process that dies leaves a lease that
// expires, and readers then see `interrupted`.
//
// Read (GET): one REPEATABLE READ READ ONLY transaction reads the row and recomputes the week's input from the current
// sources, so freshness is decided on one snapshot.
//
// Every statement states the organization and the owner, and runs with row-level security in force.

/** Time after the generation budget that a running job has to publish its result before its lease expires. */
export const PUBLICATION_GRACE_MS = 30_000;
/** Publication attempts (the first one and retries after a database error), with these delays between them. */
const PUBLICATION_RETRY_DELAYS_MS = [100, 500] as const;

export interface WeeklyInsightSettings {
  /** Deadline of one provider call. */
  attemptTimeoutMs: number;
  /** Provider calls per job, transport retries and the schema regeneration included. */
  maxAttempts: number;
  maxOutputTokens: number;
  maxPerPerson: number;
  maxQueue: number;
  /** Total time of one generation, every attempt included. */
  totalBudgetMs: number;
}

/** Barriers for deterministic concurrency tests. Never set in production. */
export interface WeeklyInsightTestHooks {
  /** Inside the request transaction, after the sources were read and before the row is written. */
  afterSourcesRead?: () => Promise<void>;
  /** After generation, before the result is published. */
  beforePublish?: () => Promise<void>;
  /** Replaces the publication statement's execution, to simulate a persistence failure. */
  publish?: (attempt: number) => Promise<void>;
}

export interface WeeklyInsightServiceOptions {
  clock: Clock;
  hooks?: WeeklyInsightTestHooks;
  logger: Logger;
  pool: Pick<Pool, 'connect'>;
  /** Undefined when generation is off: requests are refused, reads still work. */
  provider: LlmProvider | undefined;
  settings: WeeklyInsightSettings;
}

interface SourceRow {
  activities: { distanceM: number | null; durationS: number; startedAtMs: number; type: ActivityType }[];
  check_ins: {
    localDate: string;
    mood: number | null;
    sleepMinutes: number | null;
    sleepQuality: number | null;
    soreness: number | null;
    timeZone: string;
    weightKg: number | null;
  }[];
  gps_runs: { distanceM: number | null; finishedAtMs: number; startedAtMs: number }[];
}

interface InsightRow {
  attempts: number;
  created_at: string;
  failure_reason: string | null;
  id: string;
  input_hash: string;
  lease_expired: boolean;
  model: string;
  output: unknown;
  policy_version: string;
  prompt_version: string;
  status: WeeklyInsightStatus;
  time_zone: string;
  updated_at: string;
  week_start: string;
}

type Owner = { orgId: string; userId: string };

// Every source of a week in ONE statement, so the three reads share one snapshot. Activities and runs are read over a
// superset of the week (two days on each side of it, in UTC: wider than any zone offset), and aggregateWeek keeps the
// ones inside the week's range. Notes, activity effort, coordinates and identifiers are never selected: they cannot
// reach the model. A GPS distance is used only from a summary that is current for the run's data (source_revision =
// data_revision); a missing or stale summary is a data gap. The person's own finished runs only: run sharing makes
// other people's runs readable, never part of this insight.
export const weekSourcesSql = `/* weekly-insight:sources */
SELECT
  (SELECT coalesce(json_agg(json_build_object(
            'localDate', to_char(metric.local_date, 'YYYY-MM-DD'),
            'timeZone', metric.time_zone,
            'weightKg', metric.weight_kg,
            'sleepMinutes', metric.sleep_minutes,
            'sleepQuality', metric.sleep_quality,
            'mood', metric.mood,
            'soreness', metric.soreness) ORDER BY metric.local_date), '[]'::json)
   FROM daily_metrics AS metric
   WHERE metric.org_id = $1 AND metric.user_id = $2
     AND metric.local_date BETWEEN $3::date AND $3::date + 6) AS check_ins,
  (SELECT coalesce(json_agg(json_build_object(
            'type', activity.type,
            'startedAtMs', (extract(epoch FROM activity.started_at) * 1000)::float8,
            'durationS', activity.duration_s,
            'distanceM', activity.distance_m) ORDER BY activity.started_at, activity.id), '[]'::json)
   FROM activities AS activity
   WHERE activity.org_id = $1 AND activity.user_id = $2
     AND activity.started_at >= ($3::date - 2)::timestamp AT TIME ZONE 'UTC'
     AND activity.started_at < ($3::date + 9)::timestamp AT TIME ZONE 'UTC') AS activities,
  (SELECT coalesce(json_agg(json_build_object(
            'startedAtMs', (extract(epoch FROM run.started_at) * 1000)::float8,
            'finishedAtMs', (extract(epoch FROM run.finished_at) * 1000)::float8,
            'distanceM', CASE WHEN summary.source_revision = run.data_revision THEN summary.distance_m END)
            ORDER BY run.started_at, run.id), '[]'::json)
   FROM runs AS run
   LEFT JOIN run_summaries AS summary ON summary.org_id = run.org_id AND summary.run_id = run.id
   WHERE run.org_id = $1 AND run.user_id = $2 AND run.status = 'finished' AND run.finished_at IS NOT NULL
     AND run.started_at >= ($3::date - 2)::timestamp AT TIME ZONE 'UTC'
     AND run.started_at < ($3::date + 9)::timestamp AT TIME ZONE 'UTC') AS gps_runs`;

const utcMicroseconds = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const rowProjection = `insight.id,
         to_char(insight.week_start, 'YYYY-MM-DD') AS week_start,
         insight.time_zone,
         insight.status,
         insight.model,
         insight.prompt_version,
         insight.policy_version,
         insight.input_hash,
         insight.output,
         insight.failure_reason,
         insight.attempts,
         (insight.status IN ('queued', 'running') AND insight.lease_expires_at <= clock_timestamp()) AS lease_expired,
         ${utcMicroseconds('insight.created_at')} AS created_at,
         ${utcMicroseconds('insight.updated_at')} AS updated_at`;

function transportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  return `${matched[1]}${matched[2]!.replace(/0+$/u, '').padEnd(3, '0')}Z`;
}

function canonicalTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
}

/** SHA-256 of the canonical aggregate: the identity of the model input. */
export function inputHashOf(aggregate: WeeklyAggregate): string {
  return createHash('sha256').update(canonicalJson(aggregate), 'utf8').digest('hex');
}

/** Locks the current person's source gate and returns its revision (migration 0032). */
async function lockSources(client: PoolClient, mode: 'exclusive' | 'shared'): Promise<string> {
  const result = await client.query<{ revision: string }>('SELECT app_private.lock_weekly_insight_sources($1)::text AS revision', [mode]);
  const revision = result.rows[0]?.revision;
  if (revision === undefined) throw new Error('The weekly insight source gate returned no revision');
  return revision;
}

/** Reads the person's records of one week (one statement) and computes its aggregate. Exported for tests. */
export async function computeWeek(
  client: PoolClient,
  owner: Owner,
  weekStart: string,
  requestTimeZone: string,
  nowMs: number,
): Promise<{ aggregate: WeeklyAggregate; rangeEnd: string; rangeStart: string; timeZone: string }> {
  const sources = (await client.query<SourceRow>(weekSourcesSql, [owner.orgId, owner.userId, weekStart])).rows[0];
  if (!sources) throw new Error('The weekly insight source query returned no row');
  const checkIns: CheckInRecord[] = sources.check_ins;
  const window = resolveWeekWindow({ checkIns, requestTimeZone, weekStart });
  const activities: ManualActivityRecord[] = sources.activities;
  const gpsRuns: GpsRunRecord[] = sources.gps_runs;
  const aggregate = aggregateWeek({ activities, checkIns, gpsRuns, todayLocalDate: todayIn(window.timeZone, nowMs), window });
  return {
    aggregate,
    rangeEnd: new Date(window.rangeEndMs).toISOString(),
    rangeStart: new Date(window.rangeStartMs).toISOString(),
    timeZone: window.timeZone,
  };
}

const notFound = () => new ApiError(404, WEEKLY_INSIGHT_NOT_FOUND, 'No insight exists for this week');
const busy = (detail?: Record<string, unknown>) =>
  new ApiError(503, WEEKLY_INSIGHTS_BUSY, 'Insight generation is busy; try again shortly', detail);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Decision {
  id: string;
  /** Set when a new job must run for the row (its token is already stored on the row). */
  job?: { token: string };
  /** An older row of the week that was replaced: its job, if this process has one, is cancelled. */
  replacedId?: string;
  status: WeeklyInsightStatus;
}

export class WeeklyInsightService {
  readonly #clock: Clock;
  readonly #hooks: WeeklyInsightTestHooks;
  readonly #logger: Logger;
  /** The owner of every job this process started, for marking it interrupted. */
  readonly #owners = new WeakMap<QueuedJob, Owner>();
  readonly #pool: Pick<Pool, 'connect'>;
  readonly #provider: LlmProvider | undefined;
  readonly #queue: SerialJobQueue;
  readonly #settings: WeeklyInsightSettings;

  public constructor(options: WeeklyInsightServiceOptions) {
    this.#clock = options.clock;
    this.#hooks = options.hooks ?? {};
    this.#logger = options.logger;
    this.#pool = options.pool;
    this.#provider = options.provider;
    this.#settings = options.settings;
    this.#queue = new SerialJobQueue({
      maxPerOwner: options.settings.maxPerPerson,
      maxQueued: options.settings.maxQueue,
      onError: (error) =>
        this.#logger.error('weekly_insight.job_failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
    });
  }

  public get enabled(): boolean {
    return this.#provider !== undefined;
  }

  /** The lease of a running job: the whole generation budget plus the time to publish. */
  get #runningLeaseMs(): number {
    return this.#settings.totalBudgetMs + PUBLICATION_GRACE_MS;
  }

  /** Resolves when no generation is reserved, queued or running (tests). */
  public whenIdle(): Promise<void> {
    return this.#queue.whenIdle();
  }

  /** Stops accepting work, cancels the running generation and marks every job of this process interrupted. */
  public async stop(): Promise<void> {
    const dropped = await this.#queue.stop();
    await Promise.all(dropped.map((job) => this.#markInterrupted(job, 'shutdown')));
  }

  public async request(
    session: Pick<StoredSession, 'userId'>,
    orgId: string,
    request: CreateWeeklyInsightRequest,
  ): Promise<WeeklyInsightAccepted> {
    const provider = this.#provider;
    if (provider === undefined) {
      throw new ApiError(503, WEEKLY_INSIGHTS_DISABLED, 'Weekly insights are not enabled on this server');
    }
    const requestTimeZone = canonicalTimeZone(request.timeZone);
    const nowMs = this.#clock.utcNow().getTime();
    const today = localDateOf(nowMs, requestTimeZone);
    if (request.weekStart > today) {
      throw new ApiError(400, 'INVALID_REQUEST', `The week cannot start after today (${today} in ${requestTimeZone})`, {
        fields: [{ message: `Must not be after ${today}`, path: ['weekStart'] }],
      });
    }
    const owner = { orgId, userId: session.userId };
    const reserved = this.#queue.reserve(`${orgId}:${session.userId}`);
    const reservation: Reservation | undefined = typeof reserved === 'string' ? undefined : reserved;

    let decided: Decision & { aggregate: WeeklyAggregate; inputHash: string };
    try {
      decided = await withAuthenticatedTenantTransaction(this.#pool, session, orgId, async (client) => {
        const revision = await lockSources(client, 'exclusive');
        const week = await computeWeek(client, owner, request.weekStart, requestTimeZone, nowMs);
        await this.#hooks.afterSourcesRead?.();
        const inputHash = inputHashOf(week.aggregate);
        const decision = await this.#settle(client, owner, request.weekStart, week, inputHash, revision, provider.model, reservation);
        return { ...decision, aggregate: week.aggregate, inputHash };
      });
    } catch (error) {
      reservation?.release();
      throw error;
    }

    if (decided.replacedId !== undefined) this.#queue.cancel(decided.replacedId);
    if (decided.job && reservation) {
      const job: QueuedJob = {
        id: decided.id,
        run: (signal) => this.#runJob(provider, owner, job, decided.aggregate, signal),
        token: decided.job.token,
      };
      this.#owners.set(job, owner);
      reservation.start(job);
    } else {
      reservation?.release();
    }
    return weeklyInsightAcceptedSchema.parse({ id: decided.id, status: decided.status });
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, weekStart: string): Promise<WeeklyInsightView> {
    const owner = { orgId, userId: session.userId };
    const nowMs = this.#clock.utcNow().getTime();
    const found = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        const result = await client.query<InsightRow>(
          `SELECT ${rowProjection}
           FROM weekly_insights AS insight
           WHERE insight.org_id = $1 AND insight.user_id = $2 AND insight.week_start = $3::date`,
          [orgId, session.userId, weekStart],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        let freshness: WeeklyInsightFreshness = 'outdated_policy';
        if (row.policy_version === WEEKLY_INSIGHT_POLICY_VERSION && row.prompt_version === WEEKLY_INSIGHT_PROMPT_VERSION) {
          const week = await computeWeek(client, owner, weekStart, row.time_zone, nowMs);
          freshness = inputHashOf(week.aggregate) === row.input_hash ? 'current' : 'stale';
        }
        return { freshness, row };
      },
      { snapshot: 'read-only snapshot' },
    );
    if (!found) throw notFound();
    const { freshness, row } = found;
    const status: WeeklyInsightStatus = row.lease_expired ? 'interrupted' : row.status;
    const failureReason = row.lease_expired ? 'lease_expired' : row.failure_reason;
    const retryable =
      this.enabled &&
      (freshness !== 'current' ||
        ((status === 'interrupted' || status === 'generation_failed') && row.attempts < WEEKLY_INSIGHT_MAX_ATTEMPTS));
    const showOutput = status === 'ready' && freshness !== 'outdated_policy';
    return weeklyInsightViewSchema.parse({
      attempts: row.attempts,
      createdAt: transportTimestamp(row.created_at),
      failureReason,
      freshness,
      id: row.id,
      model: row.model,
      output: showOutput ? weeklyInsightOutputSchema.parse(row.output) : null,
      policyVersion: row.policy_version,
      promptVersion: row.prompt_version,
      retryable,
      status,
      timeZone: row.time_zone,
      updatedAt: transportTimestamp(row.updated_at),
      weekStart: row.week_start,
    });
  }

  /**
   * Keeps, retries or replaces the week's row, under the gate lock and a row lock.
   * - Same input, model, prompt and policy: a ready or check-failed row is returned as it is; a queued or running row
   *   with a live lease is returned as it is; an interrupted (or lease-expired) or generation_failed row is queued again
   *   while it has attempts left (409 WEEKLY_INSIGHT_RETRY_LIMIT after that).
   * - Anything else (no row, or a row for another input or policy): a new queued row replaces the week's row.
   * A new job needs the queue reservation; without one the transaction is rolled back (503) and nothing changes.
   */
  async #settle(
    client: PoolClient,
    owner: Owner,
    weekStart: string,
    week: { rangeEnd: string; rangeStart: string; timeZone: string },
    inputHash: string,
    revision: string,
    model: string,
    reservation: Reservation | undefined,
  ): Promise<Decision> {
    const existing = (
      await client.query<InsightRow>(
        `SELECT ${rowProjection}
         FROM weekly_insights AS insight
         WHERE insight.org_id = $1 AND insight.user_id = $2 AND insight.week_start = $3::date
         FOR UPDATE`,
        [owner.orgId, owner.userId, weekStart],
      )
    ).rows[0];
    const leaseMs = () => {
      if (!reservation) throw busy();
      return (reservation.ahead + 1) * this.#runningLeaseMs;
    };

    if (existing) {
      const same =
        existing.input_hash === inputHash &&
        existing.model === model &&
        existing.prompt_version === WEEKLY_INSIGHT_PROMPT_VERSION &&
        existing.policy_version === WEEKLY_INSIGHT_POLICY_VERSION;
      if (same) {
        const active = (existing.status === 'queued' || existing.status === 'running') && !existing.lease_expired;
        const retry = existing.status === 'generation_failed' || existing.status === 'interrupted' || existing.lease_expired;
        if (!retry || active) return { id: existing.id, status: existing.status };
        if (existing.attempts >= WEEKLY_INSIGHT_MAX_ATTEMPTS) {
          throw new ApiError(409, WEEKLY_INSIGHT_RETRY_LIMIT, 'This week\'s insight failed too many times for the same data', {
            attempts: existing.attempts,
            id: existing.id,
          });
        }
        const token = randomUUID();
        await client.query(
          `UPDATE weekly_insights
           SET status = 'queued', output = NULL, failure_reason = NULL, job_token = $4,
               lease_expires_at = clock_timestamp() + make_interval(secs => $5::double precision / 1000),
               attempts = attempts + 1
           WHERE org_id = $1 AND id = $2 AND user_id = $3`,
          [owner.orgId, existing.id, owner.userId, token, leaseMs()],
        );
        return { id: existing.id, job: { token }, status: 'queued' };
      }
    }

    const lease = leaseMs();
    if (existing) {
      await client.query('DELETE FROM weekly_insights WHERE org_id = $1 AND id = $2 AND user_id = $3', [
        owner.orgId,
        existing.id,
        owner.userId,
      ]);
    }
    const token = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO weekly_insights (
         org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision, model,
         prompt_version, policy_version, job_token, lease_expires_at
       )
       VALUES ($1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, $8::bigint, $9, $10, $11, $12,
               clock_timestamp() + make_interval(secs => $13::double precision / 1000))
       RETURNING id`,
      [
        owner.orgId,
        owner.userId,
        weekStart,
        week.timeZone,
        week.rangeStart,
        week.rangeEnd,
        inputHash,
        revision,
        model,
        WEEKLY_INSIGHT_PROMPT_VERSION,
        WEEKLY_INSIGHT_POLICY_VERSION,
        token,
        lease,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('The weekly insight row was not inserted');
    return { id, job: { token }, ...(existing ? { replacedId: existing.id } : {}), status: 'queued' };
  }

  async #runJob(provider: LlmProvider, owner: Owner, job: QueuedJob, aggregate: WeeklyAggregate, signal: AbortSignal): Promise<void> {
    const started = await withTenantTransaction(this.#pool, owner, async (client) => {
      const result = await client.query(
        `UPDATE weekly_insights
         SET status = 'running', lease_expires_at = clock_timestamp() + make_interval(secs => $5::double precision / 1000)
         WHERE org_id = $1 AND id = $2 AND user_id = $3 AND job_token = $4 AND status = 'queued'`,
        [owner.orgId, job.id, owner.userId, job.token, this.#runningLeaseMs],
      );
      return result.rowCount === 1;
    });
    // Erased by a source change, replaced by a newer request, or no longer this job's: nothing to do.
    if (!started) return;

    const outcome = await generateWeeklyInsight(aggregate, provider, {
      budget: {
        attemptTimeoutMs: this.#settings.attemptTimeoutMs,
        maxAttempts: this.#settings.maxAttempts,
        totalBudgetMs: this.#settings.totalBudgetMs,
      },
      maxOutputTokens: this.#settings.maxOutputTokens,
      now: () => this.#clock.monotonicNow(),
      signal,
    });
    if (signal.aborted) {
      // Shutdown, or cancelled because a newer request replaced the row (then the token no longer matches anything).
      await this.#markInterrupted(job, 'shutdown');
      return;
    }
    await this.#hooks.beforePublish?.();
    const stored = await this.#publish(owner, job, outcome);
    this.#logger.info('weekly_insight.generated', {
      attempts: outcome.stats.attempts,
      count: violationCount(outcome),
      durationMs: outcome.stats.durationMs,
      model: provider.model,
      outcome: stored,
      reason: outcome.status === 'generation_failed' ? outcome.reason : undefined,
      status: outcome.status,
    });
  }

  /** Writes the result if the row is still this job's. Retries a database error twice, then marks the row interrupted. */
  async #publish(owner: Owner, job: QueuedJob, outcome: GenerationOutcome): Promise<'discarded' | 'interrupted' | 'stored'> {
    const reason =
      outcome.status === 'generation_failed'
        ? outcome.reason
        : outcome.status === 'failed_grounding'
          ? (outcome.grounding[0]?.kind ?? 'grounding')
          : outcome.status === 'failed_safety'
            ? (outcome.safety[0]?.kind ?? 'safety')
            : null;
    const output = outcome.status === 'ready' ? JSON.stringify(outcome.output) : null;
    for (let attempt = 0; attempt <= PUBLICATION_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.#hooks.publish?.(attempt);
        const written = await withTenantTransaction(this.#pool, owner, async (client) => {
          await lockSources(client, 'shared');
          const result = await client.query(
            `UPDATE weekly_insights
             SET status = $5, output = $6::jsonb, failure_reason = $7, job_token = NULL, lease_expires_at = NULL
             WHERE org_id = $1 AND id = $2 AND user_id = $3 AND job_token = $4 AND status = 'running'`,
            [owner.orgId, job.id, owner.userId, job.token, outcome.status, output, reason],
          );
          return result.rowCount === 1;
        });
        return written ? 'stored' : 'discarded';
      } catch (error) {
        this.#logger.warn('weekly_insight.publish_failed', {
          attempts: attempt + 1,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        const wait = PUBLICATION_RETRY_DELAYS_MS[attempt];
        if (wait === undefined) break;
        await delay(wait);
      }
    }
    await this.#markInterrupted(job, 'persistence_failed');
    return 'interrupted';
  }

  /** Best effort: if the row is still this job's, it becomes interrupted. Otherwise its lease expires on its own. */
  async #markInterrupted(job: QueuedJob, reason: 'persistence_failed' | 'shutdown'): Promise<void> {
    const owner = this.#ownerOf(job);
    if (!owner) return;
    try {
      await withTenantTransaction(this.#pool, owner, (client) =>
        client.query(
          `UPDATE weekly_insights
           SET status = 'interrupted', failure_reason = $5, job_token = NULL, lease_expires_at = NULL
           WHERE org_id = $1 AND id = $2 AND user_id = $3 AND job_token = $4 AND status IN ('queued', 'running')`,
          [owner.orgId, job.id, owner.userId, job.token, reason],
        ),
      );
    } catch (error) {
      this.#logger.warn('weekly_insight.interrupt_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
  }

  #ownerOf(job: QueuedJob): Owner | undefined {
    return this.#owners.get(job);
  }
}

function violationCount(outcome: GenerationOutcome): number {
  if (outcome.status === 'failed_grounding') return outcome.grounding.length;
  if (outcome.status === 'failed_safety') return outcome.safety.length + outcome.grounding.length;
  return 0;
}
