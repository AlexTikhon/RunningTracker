import { createHash } from 'node:crypto';

import {
  runSearchCursorSchema,
  type DistanceUnit,
  type GpsQuality,
  type QualityStats,
  type RunSearchCursor,
  type RunSearchQuery,
  type RunSearchSort,
} from '@running-tracker/contracts';

import { ApiError } from '../http/errors.js';
import { resolveSearchPeriod, type ResolvedPeriod } from './run-search-period.js';

export const RUN_SEARCH_DEFAULT_LIMIT = 20;
const CURSOR_VERSION = 1;
// One international mile is exactly 1609.344 m, so a decimal number of miles is an exact rational number of metres.
const MILLIMETRES_PER_MILE = 1_609_344n;

export interface NormalizedRunSearch {
  limit: number;
  maxDistanceM: number | null;
  minDistanceM: number | null;
  period: ResolvedPeriod;
  sort: RunSearchSort;
  timeZone: string;
}

/**
 * A decimal in kilometres or miles with at most three fraction digits, as exact metres. The integer numerator and
 * denominator are both below 2^53, so the one floating-point division is correctly rounded: `0.3 mi` is the double
 * nearest 482.8032 and not what `0.3 * 1609.344` happens to produce. What the screen rounds for display never
 * reaches this function.
 */
export function distanceToMetres(value: string, unit: DistanceUnit): number {
  const [whole, fraction = ''] = value.split('.');
  const mantissa = BigInt(`${whole ?? ''}${fraction}`);
  const scale = 10n ** BigInt(fraction.length);
  const numerator = unit === 'km' ? mantissa * 1_000n : mantissa * MILLIMETRES_PER_MILE;
  const denominator = unit === 'km' ? scale : scale * 1_000n;
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('The distance bound is out of range');
  }
  return Number(numerator) / Number(denominator);
}

export function normalizeRunSearch(query: RunSearchQuery, now: Date): NormalizedRunSearch {
  const period =
    query.preset !== undefined
      ? resolveSearchPeriod({ preset: query.preset }, query.timeZone, now)
      : resolveSearchPeriod(
          { fromDate: query.fromDate as string, toDate: query.toDate as string },
          query.timeZone,
          now,
        );
  const unit = query.distanceUnit;
  return {
    limit: query.limit ?? RUN_SEARCH_DEFAULT_LIMIT,
    maxDistanceM:
      query.maxDistance !== undefined && unit !== undefined ? distanceToMetres(query.maxDistance, unit) : null,
    minDistanceM:
      query.minDistance !== undefined && unit !== undefined ? distanceToMetres(query.minDistance, unit) : null,
    period,
    sort: query.sort ?? 'newest',
    timeZone: query.timeZone,
  };
}

/**
 * A display label for how much of the track the summary could use: `insufficient` when it found no usable
 * segment, `poor` when fewer than four in five of the raw measurements were used, `good` otherwise. The 80 % line
 * is a presentation choice made for this screen (ADR-0056), not a property of the summary algorithm.
 */
export function classifyGpsQuality(stats: QualityStats): GpsQuality {
  if (stats.insufficientData) {
    return 'insufficient';
  }
  return stats.acceptedPointCount * 5 >= stats.rawPointCount * 4 ? 'good' : 'poor';
}

export interface RunSearchContextInput {
  from: string;
  maxDistanceM: number | null;
  minDistanceM: number | null;
  orgId: string;
  sort: RunSearchSort;
  timeZone: string;
  to: string;
  userId: string;
}

/**
 * Everything that decides which rows a search can return and in what order, as a digest. A cursor carries it, so
 * the same page position cannot be replayed against another person, organization, period, bound or order. It is
 * not a secret and not a signature: forging one only moves a person's own keyset position inside their own,
 * already authorized rows.
 */
export function runSearchContext(input: RunSearchContextInput): string {
  const canonical = JSON.stringify([
    'run-search',
    CURSOR_VERSION,
    input.userId,
    input.orgId,
    input.timeZone,
    input.from,
    input.to,
    input.minDistanceM,
    input.maxDistanceM,
    input.sort,
  ]);
  return createHash('sha256').update(canonical).digest('base64url');
}

export type RunSearchPosition = Omit<RunSearchCursor, 'version'>;

export function encodeRunSearchCursor(position: RunSearchPosition): string {
  const cursor: RunSearchCursor = { ...position, version: CURSOR_VERSION };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeRunSearchCursor(
  cursor: string,
  expected: { context: string; sort: RunSearchSort },
): RunSearchCursor {
  const invalid = () =>
    new ApiError(400, 'INVALID_CURSOR', 'The run search cursor is invalid for this search');
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = runSearchCursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.context !== expected.context || parsed.data.sort !== expected.sort) {
    throw invalid();
  }
  return { ...parsed.data, runId: parsed.data.runId.toLowerCase() };
}

const pageProjection = `SELECT run.id AS run_id,
         to_char(run.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
         summary.distance_m AS distance_m,
         summary.distance_m::text AS distance_key,
         summary.observed_duration_s AS observed_duration_s,
         summary.quality_stats AS quality_stats
  FROM runs AS run
  JOIN run_summaries AS summary
    ON summary.org_id = run.org_id
   AND summary.run_id = run.id
   AND summary.source_revision = run.data_revision`;

// $1 organization, $2 owner (the session identity, never a filter field), $3 inclusive start, $4 exclusive end,
// $5 and $6 distance bounds in metres or NULL. Every statement below states the owner and `finished` explicitly:
// row-level security also lets this role read runs that were shared with the person, which are not "my runs".
const pageScope = `
  WHERE run.org_id = $1
    AND run.user_id = $2
    AND run.status = 'finished'
    AND run.started_at >= $3::timestamptz
    AND run.started_at < $4::timestamptz
    AND ($5::double precision IS NULL OR summary.distance_m >= $5::double precision)
    AND ($6::double precision IS NULL OR summary.distance_m <= $6::double precision)`;

// One fixed statement per sort. Nothing from the request is ever interpolated: the sort is chosen from this table.
// Each keyset predicate matches its ORDER BY exactly and ends in the run id, which makes the order total.
const pageSql: Record<RunSearchSort, string> = {
  // $7 started_at, $8 run id, $9 limit
  newest: `${pageProjection}${pageScope}
    AND ($7::timestamptz IS NULL OR (run.started_at, run.id) < ($7::timestamptz, $8::uuid))
  ORDER BY run.started_at DESC, run.id DESC
  LIMIT $9`,
  // $7 distance, $8 started_at, $9 run id, $10 limit
  longest: `${pageProjection}${pageScope}
    AND (
      $7::double precision IS NULL
      OR (summary.distance_m, run.started_at, run.id)
         < ($7::double precision, $8::timestamptz, $9::uuid)
    )
  ORDER BY summary.distance_m DESC, run.started_at DESC, run.id DESC
  LIMIT $10`,
  shortest: `${pageProjection}${pageScope}
    AND (
      $7::double precision IS NULL
      OR summary.distance_m > $7::double precision
      OR (
        summary.distance_m = $7::double precision
        AND (run.started_at, run.id) < ($8::timestamptz, $9::uuid)
      )
    )
  ORDER BY summary.distance_m ASC, run.started_at DESC, run.id DESC
  LIMIT $10`,
};

export function runSearchPageSql(sort: RunSearchSort): string {
  if (!Object.hasOwn(pageSql, sort)) {
    throw new RangeError('Unknown run search sort');
  }
  return pageSql[sort];
}

/** The parameter list that goes with `runSearchPageSql(sort)`. */
export function runSearchPageParameters(
  sort: RunSearchSort,
  base: {
    cursor: RunSearchCursor | undefined;
    limit: number;
    maxDistanceM: number | null;
    minDistanceM: number | null;
    orgId: string;
    period: ResolvedPeriod;
    userId: string;
  },
): unknown[] {
  const head = [
    base.orgId,
    base.userId,
    base.period.from.toISOString(),
    base.period.to.toISOString(),
    base.minDistanceM,
    base.maxDistanceM,
  ];
  const fetch = base.limit + 1;
  if (sort === 'newest') {
    return [...head, base.cursor?.startedAt ?? null, base.cursor?.runId ?? null, fetch];
  }
  return [
    ...head,
    base.cursor?.distanceKey ?? null,
    base.cursor?.startedAt ?? null,
    base.cursor?.runId ?? null,
    fetch,
  ];
}

// Finished runs of this owner in the period that have no current summary. Deliberately blind to the distance
// bounds and the cursor: whether such a run would match is unknown until its summary exists.
export const runSearchPendingSql = `SELECT count(*)::integer AS pending_count
  FROM runs AS run
  LEFT JOIN run_summaries AS summary
    ON summary.org_id = run.org_id
   AND summary.run_id = run.id
  WHERE run.org_id = $1
    AND run.user_id = $2
    AND run.status = 'finished'
    AND run.started_at >= $3::timestamptz
    AND run.started_at < $4::timestamptz
    AND (summary.run_id IS NULL OR summary.source_revision <> run.data_revision)`;
