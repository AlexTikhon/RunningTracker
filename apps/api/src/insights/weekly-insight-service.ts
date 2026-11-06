import { createHash } from 'node:crypto';

import {
  WEEKLY_INSIGHT_NOT_FOUND,
  WEEKLY_INSIGHTS_BUSY,
  WEEKLY_INSIGHTS_DISABLED,
  addLocalDays,
  weeklyInsightAcceptedSchema,
  weeklyInsightViewSchema,
  type ActivityType,
  type CreateWeeklyInsightRequest,
  type WeeklyInsightAccepted,
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
import { SerialJobQueue } from './insight-queue.js';
import type { LlmProvider } from './llm-provider.js';
import {
  aggregateWeek,
  canonicalJson,
  resolveWeekWindow,
  todayIn,
  type CheckInRecord,
  type GpsRunRecord,
  type ManualActivityRecord,
  type WeeklyAggregate,
} from './weekly-aggregate.js';

// Weekly insights (ADR-0076). A request computes the week's aggregate inside one owner-scoped transaction, keeps or
// replaces the week's row, and leaves the model call to an in-process queue that runs one generation at a time. No
// database connection is held while the model works. The result is written back only to the same row, still pending,
// for the same input: if a source record was deleted in the meantime (and its trigger deleted the row), or a newer
// input replaced the row, the result is discarded.
//
// Every statement states the organization and the owner, and runs with row-level security in force (owner-only
// policies, migration 0030): ownership never rests on the policy alone.

export interface WeeklyInsightSettings {
  maxOutputTokens: number;
  maxPerPerson: number;
  maxQueue: number;
  timeoutMs: number;
}

export interface WeeklyInsightServiceOptions {
  clock: Clock;
  logger: Logger;
  pool: Pick<Pool, 'connect'>;
  /** Undefined when generation is off: requests are refused, reads still work. */
  provider: LlmProvider | undefined;
  settings: WeeklyInsightSettings;
}

interface CheckInRow {
  local_date: string;
  mood: number | null;
  sleep_minutes: number | null;
  sleep_quality: number | null;
  soreness: number | null;
  time_zone: string;
  weight_kg: string | null;
}

interface ActivityRow {
  distance_m: number | null;
  duration_s: number;
  started_at_ms: number;
  type: ActivityType;
}

interface GpsRunRow {
  distance_m: number | null;
  finished_at_ms: number;
  started_at_ms: number;
}

interface InsightKeyRow {
  id: string;
  input_hash: string;
  model: string;
  prompt_version: string;
  status: WeeklyInsightStatus;
}

interface InsightViewRow {
  created_at: string;
  id: string;
  model: string;
  output: unknown;
  prompt_version: string;
  status: WeeklyInsightStatus;
  time_zone: string;
  week_start: string;
}

// Notes (check-in notes, activity notes) and activity effort are never selected: they cannot reach the model.
export const weekCheckInsSql = `SELECT to_char(metric.local_date, 'YYYY-MM-DD') AS local_date,
         metric.time_zone,
         metric.weight_kg::text AS weight_kg,
         metric.sleep_minutes,
         metric.sleep_quality,
         metric.mood,
         metric.soreness
  FROM daily_metrics AS metric
  WHERE metric.org_id = $1 AND metric.user_id = $2 AND metric.local_date BETWEEN $3::date AND $4::date
  ORDER BY metric.local_date`;

export const weekActivitiesSql = `SELECT activity.type,
         (extract(epoch FROM activity.started_at) * 1000)::float8 AS started_at_ms,
         activity.duration_s,
         activity.distance_m
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.user_id = $2
    AND activity.started_at >= $3::timestamptz AND activity.started_at < $4::timestamptz
  ORDER BY activity.started_at, activity.id`;

// The person's own finished runs only: run sharing makes other people's runs readable, never part of this insight.
export const weekGpsRunsSql = `SELECT (extract(epoch FROM run.started_at) * 1000)::float8 AS started_at_ms,
         (extract(epoch FROM run.finished_at) * 1000)::float8 AS finished_at_ms,
         summary.distance_m
  FROM runs AS run
  LEFT JOIN run_summaries AS summary ON summary.org_id = run.org_id AND summary.run_id = run.id
  WHERE run.org_id = $1 AND run.user_id = $2 AND run.status = 'finished'
    AND run.started_at >= $3::timestamptz AND run.started_at < $4::timestamptz
  ORDER BY run.started_at, run.id`;

const utcMicroseconds = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const viewProjection = `insight.id,
         to_char(insight.week_start, 'YYYY-MM-DD') AS week_start,
         insight.time_zone,
         insight.status,
         insight.model,
         insight.prompt_version,
         insight.output,
         ${utcMicroseconds('insight.created_at')} AS created_at`;

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

/** Reads the person's records of one week and computes its aggregate. Exported for tests. */
export async function computeWeek(
  client: PoolClient,
  owner: { orgId: string; userId: string },
  weekStart: string,
  requestTimeZone: string,
  nowMs: number,
): Promise<{ aggregate: WeeklyAggregate; rangeEnd: string; rangeStart: string; timeZone: string }> {
  const checkInRows = await client.query<CheckInRow>(weekCheckInsSql, [
    owner.orgId,
    owner.userId,
    weekStart,
    addLocalDays(weekStart, 6),
  ]);
  const checkIns: CheckInRecord[] = checkInRows.rows.map((row) => ({
    localDate: row.local_date,
    mood: row.mood,
    sleepMinutes: row.sleep_minutes,
    sleepQuality: row.sleep_quality,
    soreness: row.soreness,
    timeZone: row.time_zone,
    // numeric(5,2) as text, e.g. "72.30".
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
  }));
  const window = resolveWeekWindow({ checkIns, requestTimeZone, weekStart });
  const rangeStart = new Date(window.rangeStartMs).toISOString();
  const rangeEnd = new Date(window.rangeEndMs).toISOString();
  const range = [owner.orgId, owner.userId, rangeStart, rangeEnd];
  const activityRows = await client.query<ActivityRow>(weekActivitiesSql, range);
  const runRows = await client.query<GpsRunRow>(weekGpsRunsSql, range);
  const activities: ManualActivityRecord[] = activityRows.rows.map((row) => ({
    distanceM: row.distance_m,
    durationS: row.duration_s,
    startedAtMs: row.started_at_ms,
    type: row.type,
  }));
  const gpsRuns: GpsRunRecord[] = runRows.rows.map((row) => ({
    distanceM: row.distance_m,
    finishedAtMs: row.finished_at_ms,
    startedAtMs: row.started_at_ms,
  }));
  const aggregate = aggregateWeek({
    activities,
    checkIns,
    gpsRuns,
    todayLocalDate: todayIn(window.timeZone, nowMs),
    window,
  });
  return { aggregate, rangeEnd, rangeStart, timeZone: window.timeZone };
}

const notFound = () => new ApiError(404, WEEKLY_INSIGHT_NOT_FOUND, 'No insight exists for this week');

export class WeeklyInsightService {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #pool: Pick<Pool, 'connect'>;
  readonly #provider: LlmProvider | undefined;
  readonly #queue: SerialJobQueue;
  readonly #settings: WeeklyInsightSettings;

  public constructor(options: WeeklyInsightServiceOptions) {
    this.#clock = options.clock;
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

  /** Resolves when no generation is queued or running (tests). */
  public whenIdle(): Promise<void> {
    return this.#queue.whenIdle();
  }

  /** Stops accepting work and cancels the running generation; its row stays pending. */
  public stop(): Promise<void> {
    return this.#queue.stop();
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

    const decided = await withAuthenticatedTenantTransaction(this.#pool, session, orgId, async (client) => {
      const week = await computeWeek(client, owner, request.weekStart, requestTimeZone, nowMs);
      const inputHash = inputHashOf(week.aggregate);
      const row = await this.#settle(client, owner, request.weekStart, week, inputHash, provider.model);
      return { ...row, aggregate: week.aggregate, inputHash };
    });

    if (decided.status === 'pending') {
      const enqueued = this.#queue.enqueue({
        id: decided.id,
        owner: `${orgId}:${session.userId}`,
        run: (signal) => this.#generate(provider, owner, decided.id, decided.inputHash, decided.aggregate, signal),
      });
      if (enqueued !== 'queued' && enqueued !== 'already_queued') {
        // The row stays pending: asking again later puts it back in the queue.
        throw new ApiError(503, WEEKLY_INSIGHTS_BUSY, 'Insight generation is busy; try again shortly', { id: decided.id });
      }
    }
    return weeklyInsightAcceptedSchema.parse({ id: decided.id, status: decided.status });
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, weekStart: string): Promise<WeeklyInsightView> {
    const row = await withAuthenticatedTenantTransaction(this.#pool, session, orgId, async (client) => {
      const result = await client.query<InsightViewRow>(
        `SELECT ${viewProjection}
         FROM weekly_insights AS insight
         WHERE insight.org_id = $1 AND insight.user_id = $2 AND insight.week_start = $3::date`,
        [orgId, session.userId, weekStart],
      );
      return result.rows[0];
    });
    if (!row) throw notFound();
    return weeklyInsightViewSchema.parse({
      createdAt: transportTimestamp(row.created_at),
      id: row.id,
      model: row.model,
      output: row.output ?? null,
      promptVersion: row.prompt_version,
      status: row.status,
      timeZone: row.time_zone,
      weekStart: row.week_start,
    });
  }

  /**
   * Keeps, resets or replaces the week's row, under a row lock. Same input, model and prompt version: the existing row
   * (a `generation_failed` one is reset to `pending` and tried again; a failed check stays as it is). Anything else:
   * the week's row is replaced by a new pending one.
   */
  async #settle(
    client: PoolClient,
    owner: { orgId: string; userId: string },
    weekStart: string,
    week: { rangeEnd: string; rangeStart: string; timeZone: string },
    inputHash: string,
    model: string,
  ): Promise<{ id: string; status: WeeklyInsightStatus }> {
    const select = () =>
      client.query<InsightKeyRow>(
        `SELECT id, input_hash, model, prompt_version, status
         FROM weekly_insights
         WHERE org_id = $1 AND user_id = $2 AND week_start = $3::date
         FOR UPDATE`,
        [owner.orgId, owner.userId, weekStart],
      );

    const existing = (await select()).rows[0];
    if (existing) {
      const same =
        existing.input_hash === inputHash && existing.model === model && existing.prompt_version === WEEKLY_INSIGHT_PROMPT_VERSION;
      if (same) {
        if (existing.status !== 'generation_failed') return { id: existing.id, status: existing.status };
        await client.query(
          `UPDATE weekly_insights SET status = 'pending', output = NULL
           WHERE org_id = $1 AND id = $2 AND user_id = $3`,
          [owner.orgId, existing.id, owner.userId],
        );
        return { id: existing.id, status: 'pending' };
      }
      await client.query('DELETE FROM weekly_insights WHERE org_id = $1 AND id = $2 AND user_id = $3', [
        owner.orgId,
        existing.id,
        owner.userId,
      ]);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO weekly_insights (
         org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, model, prompt_version
       )
       VALUES ($1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9)
       ON CONFLICT (org_id, user_id, week_start) DO NOTHING
       RETURNING id`,
      [
        owner.orgId,
        owner.userId,
        weekStart,
        week.timeZone,
        week.rangeStart,
        week.rangeEnd,
        inputHash,
        model,
        WEEKLY_INSIGHT_PROMPT_VERSION,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id !== undefined) return { id, status: 'pending' };
    // A concurrent request created the week's row first: answer with that row.
    const raced = (await select()).rows[0];
    if (!raced) throw new Error('The weekly insight row is neither insertable nor readable');
    return { id: raced.id, status: raced.status };
  }

  async #generate(
    provider: LlmProvider,
    owner: { orgId: string; userId: string },
    id: string,
    inputHash: string,
    aggregate: WeeklyAggregate,
    signal: AbortSignal,
  ): Promise<void> {
    const started = this.#clock.monotonicNow();
    const outcome = await generateWeeklyInsight(aggregate, provider, {
      maxOutputTokens: this.#settings.maxOutputTokens,
      signal,
      timeoutMs: this.#settings.timeoutMs,
    });
    // Cancelled at shutdown: nothing is written, the row stays pending for a later request.
    if (signal.aborted) return;
    const written = await withTenantTransaction(this.#pool, owner, async (client) => {
      const result = await client.query(
        `UPDATE weekly_insights SET status = $5, output = $6::jsonb
         WHERE org_id = $1 AND id = $2 AND user_id = $3 AND input_hash = $4 AND status = 'pending'`,
        [owner.orgId, id, owner.userId, inputHash, outcome.status, outcome.status === 'ready' ? JSON.stringify(outcome.output) : null],
      );
      return result.rowCount === 1;
    });
    this.#logger.info('weekly_insight.generated', {
      count: violationCount(outcome),
      durationMs: Math.round(this.#clock.monotonicNow() - started),
      model: provider.model,
      outcome: written ? 'stored' : 'discarded',
      reason: outcome.status === 'generation_failed' ? outcome.reason : undefined,
      status: outcome.status,
    });
  }
}

function violationCount(outcome: GenerationOutcome): number {
  if (outcome.status === 'failed_grounding') return outcome.grounding.length;
  if (outcome.status === 'failed_safety') return outcome.safety.length + outcome.grounding.length;
  return 0;
}
