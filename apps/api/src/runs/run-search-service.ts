import {
  qualityStatsSchema,
  runSearchResponseSchema,
  type RunSearchQuery,
  type RunSearchResponse,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import {
  classifyGpsQuality,
  decodeRunSearchCursor,
  encodeRunSearchCursor,
  normalizeRunSearch,
  runSearchContext,
  runSearchPageParameters,
  runSearchPageSql,
  runSearchPendingSql,
} from './run-search-query.js';

interface SearchRow {
  distance_key: string;
  distance_m: number;
  observed_duration_s: number;
  quality_stats: unknown;
  run_id: string;
  started_at: string;
}

/**
 * The signed-in person's own finished runs in a period, from published summaries only.
 *
 * The caller has already run this inside `withAuthenticatedTenantTransaction`, so the membership was rechecked and
 * row-level security is in force. That policy also exposes runs shared with the person, so ownership is stated in
 * the SQL as well (`run.user_id = session.userId`). No GPS point is read: distance, duration and quality come
 * from `run_summaries`, and only when its source revision is the run's current data revision.
 *
 * Consistency: the page and the pending count are two statements in one transaction. On an unchanged dataset
 * the pages neither skip nor repeat a run; a run that changes between two page requests may move.
 */
export async function searchRuns(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  query: RunSearchQuery,
  clock: Clock,
): Promise<RunSearchResponse> {
  const search = normalizeRunSearch(query, clock.utcNow());
  const from = search.period.from.toISOString();
  const to = search.period.to.toISOString();
  const context = runSearchContext({
    from,
    maxDistanceM: search.maxDistanceM,
    minDistanceM: search.minDistanceM,
    orgId,
    sort: search.sort,
    timeZone: search.timeZone,
    to,
    userId: session.userId,
  });
  const cursor =
    query.cursor === undefined
      ? undefined
      : decodeRunSearchCursor(query.cursor, { context, sort: search.sort });

  const page = await client.query<SearchRow>(
    runSearchPageSql(search.sort),
    runSearchPageParameters(search.sort, {
      cursor,
      limit: search.limit,
      maxDistanceM: search.maxDistanceM,
      minDistanceM: search.minDistanceM,
      orgId,
      period: search.period,
      userId: session.userId,
    }),
  );
  const pending = await client.query<{ pending_count: number }>(runSearchPendingSql, [
    orgId,
    session.userId,
    from,
    to,
  ]);

  const rows = page.rows.slice(0, search.limit);
  const last = rows.at(-1);
  return runSearchResponseSchema.parse({
    applied: {
      from,
      fromDate: search.period.fromDate,
      maxDistanceM: search.maxDistanceM,
      minDistanceM: search.minDistanceM,
      sort: search.sort,
      timeZone: search.timeZone,
      to,
      toDate: search.period.toDate,
    },
    items: rows.map((row) => ({
      distanceM: row.distance_m,
      gpsQuality: classifyGpsQuality(qualityStatsSchema.parse(row.quality_stats)),
      observedDurationS: row.observed_duration_s,
      runId: row.run_id,
      startedAt: toTransportTimestamp(row.started_at),
    })),
    nextCursor:
      page.rows.length > search.limit && last
        ? encodeRunSearchCursor({
            context,
            distanceKey: search.sort === 'newest' ? null : last.distance_key,
            runId: last.run_id,
            sort: search.sort,
            startedAt: last.started_at,
          })
        : null,
    pendingSummaryCount: pending.rows[0]?.pending_count ?? 0,
  });
}

// The same rendering as the run list: trailing zeros of the microsecond fraction are dropped, at least three
// digits stay. The cursor keeps the full microsecond value, so the keyset comparison is exact.
function toTransportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) {
    throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  }
  return `${matched[1]}${matched[2]!.replace(/0+$/u, '').padEnd(3, '0')}Z`;
}
