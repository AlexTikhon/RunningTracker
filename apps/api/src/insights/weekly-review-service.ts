import type { ActivityType, WeeklyReview, WeeklyReviewQuery } from '@running-tracker/contracts';
import type { Pool, PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { localDateOf } from '../runs/run-search-period.js';
import { canonicalTimeZone, computeWeek } from './weekly-insight-service.js';
import {
  buildWeeklyReview,
  kcalTenthsOf,
  reviewDetailOf,
  type ImportedActivityRecord,
  type TcxImportedActivityRecord,
  type MovementDayRecord,
} from './weekly-review.js';

// The deterministic weekly review: computed on every read, never stored, never queued, and independent of AI
// generation. It does not know the weekly insight service or any model provider, so it cannot call a model.
//
// One REPEATABLE READ READ ONLY transaction: the membership check, the week's AI-shared sources (one statement:
// check-ins, manual activities and the person's own finished GPS runs with current summaries) and the week's manual
// movement (a second statement, ADR-0079) share one snapshot: the transaction's snapshot is taken by its first statement
// and every later statement reads it, so a movement write committed in between is not seen. Nothing is read after the
// transaction ends. Every statement names the organization and the owner, and runs with row-level security in force;
// GPS runs are filtered by owner explicitly, so a run another person shared with this one is never part of their review.
//
// Movement has its own statement on purpose: the source statement is the AI input (weekSourcesSql), and movement must
// not become part of it.

/** Barriers for deterministic snapshot tests. Never set in production. */
export interface WeeklyReviewTestHooks {
  /** Inside the read transaction, after the AI-shared sources were read and before movement is read. */
  afterSourcesRead?: () => Promise<void>;
}

export interface WeeklyReviewServiceOptions {
  clock: Clock;
  hooks?: WeeklyReviewTestHooks;
  pool: Pick<Pool, 'connect'>;
}

interface MovementRow {
  active_energy_kcal: string | null;
  local_date: string;
  source: 'manual';
  steps: number | null;
  time_zone: string;
}

// $1 organization, $2 owner, $3 Monday. The stored local dates of the week, Monday to Sunday inclusive: a daily total
// belongs to the calendar date it was entered for, whatever zone the week's activities are read in. Manual rows only
// (no other source exists; a later importer's rows must not be added to them). The owner/date/source unique index
// serves the range.
export const weekMovementSql = `/* weekly-review:movement */
SELECT to_char(movement.local_date, 'YYYY-MM-DD') AS local_date,
       movement.source,
       movement.time_zone,
       movement.steps,
       movement.active_energy_kcal::text AS active_energy_kcal
  FROM daily_movement AS movement
 WHERE movement.org_id = $1
   AND movement.user_id = $2
   AND movement.source = 'manual'
   AND movement.local_date BETWEEN $3::date AND $3::date + 6
 ORDER BY movement.local_date`;

export async function readWeekMovement(
  client: PoolClient,
  owner: { orgId: string; userId: string },
  weekStart: string,
): Promise<MovementDayRecord[]> {
  const result = await client.query<MovementRow>(weekMovementSql, [owner.orgId, owner.userId, weekStart]);
  return result.rows.map((row) => ({
    activeEnergyTenths: row.active_energy_kcal === null ? null : kcalTenthsOf(row.active_energy_kcal),
    localDate: row.local_date,
    source: row.source,
    steps: row.steps,
    timeZone: row.time_zone,
  }));
}

// $1 organization, $2 owner, $3 first instant of the week's range, $4 first instant after it (exclusive): the bounds the
// aggregate keeps manual activities by, in the week's zone. GPX imports only (ADR-0086); their own statement, outside
// the AI-shared source statement, so an import never becomes model input. No note, effort, fingerprint or id is selected.
export const weekImportsSql = `/* weekly-review:gpx-imports */
SELECT activity.type,
       activity.duration_s,
       activity.distance_m
  FROM activities AS activity
 WHERE activity.org_id = $1
   AND activity.user_id = $2
   AND activity.source = 'gpx'
   AND activity.started_at >= $3::timestamptz
   AND activity.started_at < $4::timestamptz
 ORDER BY activity.started_at, activity.id`;

export async function readWeekImports(
  client: PoolClient,
  owner: { orgId: string; userId: string },
  rangeStart: string,
  rangeEnd: string,
): Promise<ImportedActivityRecord[]> {
  const result = await client.query<{ distance_m: number | null; duration_s: number; type: ActivityType }>(weekImportsSql, [
    owner.orgId,
    owner.userId,
    rangeStart,
    rangeEnd,
  ]);
  return result.rows.map((row) => {
    if (row.distance_m === null) throw new Error('A GPX-imported activity has no distance');
    return { distanceM: row.distance_m, durationS: row.duration_s, type: row.type };
  });
}

// $1 organization, $2 owner, $3/$4 the week's range as for GPX imports. TCX imports only (ADR-0091), in their own
// statement outside the AI-shared source statement, so a TCX import never becomes model input and is never mixed with GPX
// imports. Every TCX row has a distance (migration 0042). No note, effort, fingerprint or id is selected.
export const weekTcxImportsSql = `/* weekly-review:tcx-imports */
SELECT activity.type,
       activity.duration_s,
       activity.distance_m
  FROM activities AS activity
 WHERE activity.org_id = $1
   AND activity.user_id = $2
   AND activity.source = 'tcx'
   AND activity.started_at >= $3::timestamptz
   AND activity.started_at < $4::timestamptz
 ORDER BY activity.started_at, activity.id`;

export async function readWeekTcxImports(
  client: PoolClient,
  owner: { orgId: string; userId: string },
  rangeStart: string,
  rangeEnd: string,
): Promise<TcxImportedActivityRecord[]> {
  const result = await client.query<{ distance_m: number | null; duration_s: number; type: ActivityType }>(weekTcxImportsSql, [
    owner.orgId,
    owner.userId,
    rangeStart,
    rangeEnd,
  ]);
  return result.rows.map((row) => {
    if (row.distance_m === null) throw new Error('A TCX-imported activity has no distance');
    return { distanceM: row.distance_m, reportedDurationS: row.duration_s, type: row.type };
  });
}

export class WeeklyReviewService {
  readonly #clock: Clock;
  readonly #hooks: WeeklyReviewTestHooks | undefined;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: WeeklyReviewServiceOptions) {
    this.#clock = options.clock;
    this.#hooks = options.hooks;
    this.#pool = options.pool;
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, query: WeeklyReviewQuery): Promise<WeeklyReview> {
    const requestTimeZone = canonicalTimeZone(query.timeZone);
    const now = this.#clock.utcNow();
    const nowMs = now.getTime();
    const today = localDateOf(nowMs, requestTimeZone);
    if (query.weekStart > today) {
      throw new ApiError(400, 'INVALID_REQUEST', `The week cannot start after today (${today} in ${requestTimeZone})`, {
        fields: [{ message: `Must not be after ${today}`, path: ['weekStart'] }],
      });
    }
    const owner = { orgId, userId: session.userId };
    const { imported, movement, tcxImported, week } = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        const computed = await computeWeek(client, owner, query.weekStart, requestTimeZone, nowMs);
        await this.#hooks?.afterSourcesRead?.();
        return {
          imported: await readWeekImports(client, owner, computed.rangeStart, computed.rangeEnd),
          movement: await readWeekMovement(client, owner, query.weekStart),
          tcxImported: await readWeekTcxImports(client, owner, computed.rangeStart, computed.rangeEnd),
          week: computed,
        };
      },
      { snapshot: 'read-only snapshot' },
    );
    const detail = reviewDetailOf({ activities: week.sources.activities, checkIns: week.sources.checkIns, window: week.window });
    return buildWeeklyReview({ aggregate: week.aggregate, computedAt: now.toISOString(), detail, imported, movement, tcxImported });
  }
}
