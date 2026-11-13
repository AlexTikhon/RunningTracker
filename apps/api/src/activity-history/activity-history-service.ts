import {
  ACTIVITY_HISTORY_PAGE_DEFAULT,
  ACTIVITY_HISTORY_VERSION,
  activityHistoryResponseSchema,
  qualityStatsSchema,
  type ActivityHistoryDay,
  type ActivityHistoryItem,
  type ActivityHistoryQuery,
  type ActivityHistoryResponse,
} from '@running-tracker/contracts';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { localDayInterval } from '../daily-overview/daily-overview-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { classifyGpsQuality } from '../runs/run-search-query.js';
import {
  activityHistoryContext,
  decodeActivityHistoryCursor,
  encodeActivityHistoryCursor,
} from './activity-history-cursor.js';

// The unified activity history (ADR-0087): computed on every read from the existing tables, never stored, never queued.
// It writes nothing.
//
// One REPEATABLE READ READ ONLY transaction holds the membership check and the single page statement, so the page is
// read from one snapshot (taken by the transaction's first statement): a write committed after that is not seen, and
// nothing is read after the transaction ends. Row-level security is in force (runtime role, tenant context), and every
// branch of the statement also names the organization and the owner. The run policies let this role read runs that were
// shared with the person; the explicit `run.user_id` predicate is what keeps them out of this history.

/** Barriers for deterministic snapshot tests. Never set in production (createApp refuses them outside APP_ENV=test). */
export interface ActivityHistoryTestHooks {
  /** Inside the read transaction, after the membership check and before the page statement. */
  beforePageRead?: () => Promise<void>;
}

export interface ActivityHistoryServiceOptions {
  hooks?: ActivityHistoryTestHooks;
  pool: Pick<Pool, 'connect'>;
}

// The two entity kinds, ranked for the total order. At an equal start a recorded run (1) comes before an activity (0);
// the rank, not the id, separates an activity and a run that share an id. Manual, GPX and TCX rows are one kind: they
// live in one table whose primary key makes the id unique within the organization.
const KIND_RANK = { activity: 0, run: 1 } as const;
type Kind = keyof typeof KIND_RANK;

const utcMicroseconds = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// $1 organization, $2 owner, $3 source filter or NULL, $4 type filter or NULL, $5/$6/$7 keyset position (start, kind
// rank, id) or NULL, $8 fetch size (page size + 1), $9/$10 the day filter's half-open interval [start, end) or NULL
// (ADR-0088).
//
// Day filter: both branches keep an item only when started_at >= $9 AND started_at < $10, the start of the selected
// local date and the start of the next one in the requested zone (computed by the caller from the zone's rules, never
// start + 24 hours). That is Today's rule (ADR-0082): an item belongs to the date it started on, also when it continued
// past midnight. Together with the owner predicates it is a range of the same owner index, so a day page reads at most
// that day's rows of the person, not the whole history.
//
// Order: started_at DESC, kind rank DESC, id DESC, which is total. The outer ORDER BY decides; each branch applies the
// same keyset predicate and its own ORDER BY ... LIMIT, so it can stop after one page from its owner index
// (activities_owner_started_idx and runs_owner_started_idx, both (org_id, user_id, started_at DESC, id DESC)). The keyset
// predicate of a branch is the row comparison (started_at, rank, id) < ($5, $6, $7) with the branch's constant rank
// substituted: at an equal start an activity (rank 0) follows a run cursor ($6 = 1) or a lower id; a run (rank 1) follows
// only a run cursor with a higher id. `started_at <= $5` keeps it an index range.
//
// Filters: an activity row matches a source filter equal to its stored, server-owned source ('manual', 'gpx' or 'tcx'), so
// 'recorded_run' excludes every activity; a run matches only 'recorded_run'. A recorded run's type is 'run'.
//
// Run metrics come only from a summary whose source revision equals the run's current data revision (ADR-0015; the
// check used by run search, run details and Today). Otherwise the state says why they are unknown and no value is
// selected. No point, geometry, share or other person's row is read.
export const activityHistoryPageSql = `/* activity-history:page */
SELECT entry.kind_rank, entry.entry_id, entry.source, entry.type, entry.started_at_us, entry.finished_at_us,
       entry.duration_s, entry.distance_m, entry.rpe, entry.notes,
       entry.summary_state, entry.observed_duration_s, entry.quality_stats
  FROM (
    (SELECT 0::smallint AS kind_rank,
            activity.id AS entry_id,
            activity.source,
            activity.type,
            activity.started_at,
            ${utcMicroseconds('activity.started_at')} AS started_at_us,
            NULL::text AS finished_at_us,
            activity.duration_s,
            activity.distance_m,
            activity.rpe,
            activity.notes,
            NULL::text AS summary_state,
            NULL::double precision AS observed_duration_s,
            NULL::jsonb AS quality_stats
       FROM activities AS activity
      WHERE activity.org_id = $1
        AND activity.user_id = $2
        AND ($3::text IS NULL OR activity.source = $3::text)
        AND ($4::text IS NULL OR activity.type = $4::text)
        AND ($9::timestamptz IS NULL OR (activity.started_at >= $9::timestamptz AND activity.started_at < $10::timestamptz))
        AND ($5::timestamptz IS NULL
             OR (activity.started_at <= $5::timestamptz
                 AND (activity.started_at < $5::timestamptz OR $6::smallint > 0 OR activity.id < $7::uuid)))
      ORDER BY activity.started_at DESC, activity.id DESC
      LIMIT $8)
    UNION ALL
    (SELECT 1::smallint AS kind_rank,
            run.id AS entry_id,
            'recorded_run' AS source,
            'run' AS type,
            run.started_at,
            ${utcMicroseconds('run.started_at')} AS started_at_us,
            ${utcMicroseconds('run.finished_at')} AS finished_at_us,
            NULL::integer AS duration_s,
            CASE WHEN summary.source_revision = run.data_revision THEN summary.distance_m END AS distance_m,
            NULL::smallint AS rpe,
            NULL::text AS notes,
            CASE
              WHEN summary.run_id IS NULL THEN 'pending'
              WHEN summary.source_revision = run.data_revision THEN 'current'
              ELSE 'stale'
            END AS summary_state,
            CASE WHEN summary.source_revision = run.data_revision THEN summary.observed_duration_s END AS observed_duration_s,
            CASE WHEN summary.source_revision = run.data_revision THEN summary.quality_stats END AS quality_stats
       FROM runs AS run
       LEFT JOIN run_summaries AS summary ON summary.org_id = run.org_id AND summary.run_id = run.id
      WHERE run.org_id = $1
        AND run.user_id = $2
        AND run.status = 'finished'
        AND ($3::text IS NULL OR $3::text = 'recorded_run')
        AND ($4::text IS NULL OR $4::text = 'run')
        AND ($9::timestamptz IS NULL OR (run.started_at >= $9::timestamptz AND run.started_at < $10::timestamptz))
        AND ($5::timestamptz IS NULL
             OR (run.started_at <= $5::timestamptz
                 AND (run.started_at < $5::timestamptz OR ($6::smallint = 1 AND run.id < $7::uuid))))
      ORDER BY run.started_at DESC, run.id DESC
      LIMIT $8)
  ) AS entry
 ORDER BY entry.started_at DESC, entry.kind_rank DESC, entry.entry_id DESC
 LIMIT $8`;

export interface ActivityHistoryRow {
  distance_m: number | null;
  duration_s: number | null;
  entry_id: string;
  finished_at_us: string | null;
  kind_rank: number;
  notes: string | null;
  observed_duration_s: number | null;
  quality_stats: unknown;
  rpe: number | null;
  source: 'gpx' | 'manual' | 'recorded_run' | 'tcx';
  started_at_us: string;
  summary_state: 'current' | 'pending' | 'stale' | null;
  type: string;
}

// Trailing zeros of the microsecond fraction are dropped, at least three digits stay, as for activities and runs. The
// cursor keeps the full microsecond value, so the keyset comparison is exact.
function transportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) {
    throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  }
  return `${matched[1]}${matched[2]!.replace(/0+$/u, '').padEnd(3, '0')}Z`;
}

function required<Value>(value: Value | null, column: string): Value {
  if (value === null) throw new Error(`The activity history statement returned no ${column}`);
  return value;
}

// Each source maps to its own item shape and duration name. The switch is exhaustive (ADR-0091 audit): a source the code
// does not know is an error, never mapped as another source.
export function mapActivityHistoryRow(row: ActivityHistoryRow): ActivityHistoryItem {
  const startedAt = transportTimestamp(row.started_at_us);
  const source = row.source;
  switch (source) {
    case 'manual':
      return {
        activityId: row.entry_id,
        distanceM: row.distance_m,
        enteredDurationS: required(row.duration_s, 'duration'),
        notes: row.notes,
        rpe: row.rpe,
        source: 'manual',
        startedAt,
        type: row.type,
      } as ActivityHistoryItem;
    case 'gpx':
      return {
        activityId: row.entry_id,
        distanceM: row.distance_m,
        elapsedDurationS: required(row.duration_s, 'duration'),
        source: 'gpx',
        startedAt,
        type: row.type,
      } as ActivityHistoryItem;
    case 'tcx':
      return {
        activityId: row.entry_id,
        distanceM: required(row.distance_m, 'distance'),
        reportedDurationS: required(row.duration_s, 'duration'),
        source: 'tcx',
        startedAt,
        type: row.type,
      } as ActivityHistoryItem;
    case 'recorded_run': {
      const state = required(row.summary_state, 'summary state');
      return {
        captureSource: null,
        finishedAt: transportTimestamp(required(row.finished_at_us, 'finish time')),
        runId: row.entry_id,
        source: 'recorded_run',
        startedAt,
        summary:
          state === 'current'
            ? {
                distanceM: required(row.distance_m, 'distance'),
                gpsQuality: classifyGpsQuality(qualityStatsSchema.parse(row.quality_stats)),
                observedDurationS: required(row.observed_duration_s, 'observed duration'),
                state,
              }
            : { state },
        type: 'run',
      };
    }
    default: {
      const unknown: never = source;
      throw new Error(`The activity history statement returned an unknown source: ${String(unknown)}`);
    }
  }
}

const kindOfRank = (rank: number): Kind => (rank === KIND_RANK.run ? 'run' : 'activity');

/**
 * The day filter of a query (ADR-0088), or null without one. The zone is put in the platform's canonical spelling first,
 * so the interval, the echo and the cursor scope all name the same zone. The interval runs from the start of the date to
 * the start of the next calendar date in that zone, both located from the zone's own offset history (startOfLocalDate);
 * the end is never the start plus 24 hours. The bounds are whole seconds, so the millisecond ISO strings are exact.
 */
export function activityHistoryDay(query: Pick<ActivityHistoryQuery, 'localDate' | 'timeZone'>): ActivityHistoryDay | null {
  if (query.localDate === undefined || query.timeZone === undefined) return null;
  const timeZone = canonicalTimeZone(query.timeZone);
  const interval = localDayInterval(query.localDate, timeZone);
  return {
    endsAt: new Date(interval.endsAtMs).toISOString(),
    localDate: query.localDate,
    startsAt: new Date(interval.startsAtMs).toISOString(),
    timeZone,
  };
}

export class ActivityHistoryService {
  readonly #hooks: ActivityHistoryTestHooks | undefined;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: ActivityHistoryServiceOptions) {
    this.#hooks = options.hooks;
    this.#pool = options.pool;
  }

  public async read(
    session: Pick<StoredSession, 'userId'>,
    orgId: string,
    query: ActivityHistoryQuery,
  ): Promise<ActivityHistoryResponse> {
    const source = query.source ?? null;
    const type = query.type ?? null;
    const day = activityHistoryDay(query);
    const context = activityHistoryContext({
      day: day === null ? null : { localDate: day.localDate, timeZone: day.timeZone },
      orgId,
      source,
      type,
      userId: session.userId,
    });
    // Decoded before the transaction: a cursor of another scope is refused without touching the database.
    const cursor = query.cursor === undefined ? undefined : decodeActivityHistoryCursor(query.cursor, { context });
    const limit = query.limit ?? ACTIVITY_HISTORY_PAGE_DEFAULT;

    const rows = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        await this.#hooks?.beforePageRead?.();
        const result = await client.query<ActivityHistoryRow>(activityHistoryPageSql, [
          orgId,
          session.userId,
          source,
          type,
          cursor?.startedAt ?? null,
          cursor === undefined ? null : KIND_RANK[cursor.kind],
          cursor?.id ?? null,
          limit + 1,
          day?.startsAt ?? null,
          day?.endsAt ?? null,
        ]);
        return result.rows;
      },
      { snapshot: 'read-only snapshot' },
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return activityHistoryResponseSchema.parse({
      applied: { day, source, type },
      items: page.map(mapActivityHistoryRow),
      nextCursor:
        rows.length > limit && last
          ? encodeActivityHistoryCursor({
              context,
              id: last.entry_id,
              kind: kindOfRank(last.kind_rank),
              startedAt: last.started_at_us,
            })
          : null,
      provenance: { historyVersion: ACTIVITY_HISTORY_VERSION, persisted: false, snapshot: 'single_read_only_transaction' },
    });
  }
}
