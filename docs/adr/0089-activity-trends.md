# ADR-0089: Owner-only activity trends for one source and one type over 28 local dates

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including mutation checks and
  `EXPLAIN (ANALYZE, BUFFERS)` under the runtime role, Chromium end-to-end including a 375 px viewport). Not run on an
  iPhone, in Safari or in Firefox. Corrected the same day after review: skipped local dates, zone identity in the client,
  and range totals computed by PostgreSQL (see "Corrections after review").
- Date: 2026-11-12
- Extended by: ADR-0090 (an optional comparison with the previous 28 local dates, `compare=previous_period`) and ADR-0091
  (`source=tcx` with `reportedDuration`; the policy versions are unchanged).
- Relates to: ADR-0082 (Today: an item belongs to the local date it started on, intervals from the zone's rules),
  ADR-0084 (Trends: 28 calendar dates ending on a chosen date, the 2000-01-01 lower bound, "today" by the server clock in
  the client's zone, per-series coverage), ADR-0087/0088 (the unified, owner-only activity history, its source-specific
  duration names and its local-day filter), ADR-0013/0015 (a run summary is current only for the run's data revision),
  ADR-0042 (run policies admit runs shared with the caller), ADR-0086 (GPX elapsed time).
- Scope: `GET /api/orgs/{orgId}/activity-trends`, `packages/contracts/src/activity-trends.ts`,
  `apps/api/src/activity-trends/*`, an **Activity** section on the existing Trends screen (`ActivityTrendsSection.tsx`,
  `activity-trends.ts`, `activity-trends-controller.ts`), OpenAPI, tests at every layer, docs. No migration, table, view,
  persisted aggregate, background job, cache, model call, import format or dependency. Today, the history, the weekly
  review, the four health series of Trends and every AI input (weekly insights' facts, hashes, policies) are unchanged.

## Context

Trends (ADR-0084) shows four daily health series; the activity history (ADR-0087/0088) lists activities and runs but has,
by design, no totals. A person who wants to see "how much did I ride in the last four weeks" has neither. The risks are
those of both slices together: an item must land on the same date as on Today and in the day history, also around
midnight and a daylight saving change; three sources with three different meanings of "duration" must never be added; a
run whose summary is pending or stale must not contribute an old or a zero value; and a date with nothing logged must not
read as a date of inactivity.

## Decision 1: one strict, owner-only read

`GET /api/orgs/{orgId}/activity-trends?endDate=YYYY-MM-DD&timeZone=<IANA>&source=<source>&type=<type>`, session-
authenticated, `Cache-Control: no-store` on every answer (mounted before the JSON body parser, like the other derived
reads).

- **Parameters.** A strict query object with exactly four required, single-valued parameters: `endDate` (the shared
  strict date, not before 2000-01-01), `timeZone` (the shared IANA check: no offsets or unknown names), `source`
  (`manual`, `gpx` or `recorded_run`) and `type` (an activity type). `source=recorded_run` accepts only `type=run`. A
  missing, repeated, unknown or owner-like parameter is `400 INVALID_REQUEST`. One request is one source and one type:
  sources are never combined, so there is no "all sources" value.
- **Range.** The 28 calendar dates ending on `endDate` (`dailyTrendsRangeOf`, the ADR-0084 rule), shortened by
  2000-01-01 and disclosed (`range.days`, `shortenedByLowerBound`). An `endDate` after today **in the requested zone by
  the server's injected clock** is `400` naming the server's today (tested at UTC+14 and in UTC).
- **Echo.** `applied { endDate, source, timeZone (canonical), type }`, `range { startDate, endDate, days, requestedDays,
  shortenedByLowerBound, startsAt, endsAt, today, includesToday }`, and `provenance { policyVersion: activity-trends-1,
  computedAt, persisted: false, snapshot: single_read_only_transaction, source: computed_by_app }`. The web client refuses
  an answer whose echo differs from its request. It compares the zone by identity, not spelling (`sameTimeZone` in
  `apps/web/src/time-zone.ts`): both names are canonicalized with the API's convention (`Intl` `resolvedOptions().timeZone`),
  so `europe/warsaw` matches the echoed `Europe/Warsaw` and an alias matches its primary zone; where an engine keeps
  aliases as spelled, Temporal's zone equality decides when available. An invalid name matches nothing and never throws.

## Decision 2: Today's attribution, from the zone's rules

An item belongs to the local date on which it **started** in the requested zone, `[start of the date, start of the next
date)`. The service computes the start of every date of the range and of the date after it with `startOfLocalDate` (the
helper behind Today and the history's day filter), never by adding 24 hours, and returns each date's `startsAt`/`endsAt`:
Europe/Warsaw's 2026-03-29 is 23 hours and 2026-10-25 is 25 hours. An item that continued past midnight counts on its
start date with its whole duration. The contract refuses days that do not tile the range without a gap or an overlap.

**A date the zone skipped** stays in the range. Pacific/Apia went from 23:59:59 on 2011-12-29 (UTC-10) to 00:00 on
2011-12-31 (UTC+14), so `startOfLocalDate` gives 2011-12-30 and 2011-12-31 the same instant: 2011-12-30 has an **empty
interval** (`startsAt === endsAt`), zero entries and `null` totals, and still counts among the range's dates. The contract
accepts an empty interval only with `count: 0` and still refuses a reversed interval, a gap or an overlap. (As first
written it required `startsAt < endsAt` for every date, so this valid range was a `500`.) `width_bucket` returns how many
bounds are at or before a start, so a repeated bound sends an item to the **last** date starting at that instant, the date
after the skip; the service also refuses a bucket number of an empty date. A real-PostgreSQL test puts records at the
last microsecond before the skip, the first instant after it and the next midnight, and compares the dates with
PostgreSQL's own `AT TIME ZONE` grouping; the skipped date can also end the range.

PostgreSQL never receives the zone: the statement puts each row in a bucket with `width_bucket(started_at,
$day_starts::timestamptz[])` and keeps only `started_at >= $range_start AND started_at < $range_end`. So the server's
JavaScript time zone data decides the boundaries once, exactly as for Today and the history; PostgreSQL's own tz data
cannot disagree with them. An integration test compares a 25-hour date with Today's figure and the history's day page
for the same date, and a 130-item fixture with PostgreSQL's own `AT TIME ZONE` grouping.

## Decision 3: one range statement, one snapshot, owner stated in SQL

One `REPEATABLE READ, READ ONLY` transaction (`withAuthenticatedTenantTransaction`, runtime role, RLS in force) holds the
membership check and **one** aggregate statement for the requested source, whatever the range:

- `activity-trends:activities` (manual or GPX): `activities` grouped by date bucket, with `org_id = $1 AND user_id = $2`,
  the stored server-owned `source` and the `type`;
- `activity-trends:recorded-runs`: the person's own `finished` runs (`run.org_id = $1 AND run.user_id = $2`) with their
  summary looked up by key and bound to the organization too.

The run policies admit runs shared with the caller (ADR-0042); the explicit `run.user_id` predicate is what keeps them
out (removing it fails the shared-run test: mutation check). Nothing pages the history, reads a raw point or a geometry,
or adds single rows in the browser. A test-only hook (`testOnlyActivityTrendsHooks.beforeAggregateRead`, refused outside
`APP_ENV=test`) commits deletions and insertions after the membership check: the answer is the earlier state, the next read
the later one; with READ COMMITTED that test fails (mutation check). Reads change no row count of activities, runs,
summaries, the erasure ledger, tombstones or weekly insights. Deletions over the existing APIs are absent from the next
read.

## Decision 4: metrics, coverage and the three states

Per date and for the range, under the source's own names:

| Source | Count | Duration | Distance |
|---|---|---|---|
| `manual` | entries | `enteredDuration`: the sum of the durations the person typed (every entry has one) | over entries with a distance |
| `gpx` | imports | `elapsedDuration`: first to last point of each file, pauses included; not moving time (every import has one) | over imports with a distance |
| `recorded_run` | runs, and `summaries { current, pending, stale }` | `observedDuration`: accepted GPS edges, **current summaries only** | current summaries only |

Each metric is `{ withValue, totalS | totalM }`: how many items record it and the sum over exactly those, `null` when none
does. Three states stay distinct everywhere: **no entries** (`count: 0`, totals `null`), **unknown** (`count > 0`,
`withValue` below it, total `null` when none has it) and a **recorded zero** (`withValue > 0`, total `0`). A pending (no
summary yet) or stale (summary of an older data revision) run is counted and adds to missing coverage; its values are
never selected, and a summary made stale by new data leaves the figures on the next read (tested).

**Rounding and range figures, all in PostgreSQL.** Durations of manual entries and GPX imports are integers and summed
exactly. Distances (double precision) and observed durations are summed by PostgreSQL per date and rounded **once per
date** to the nearest metre or second, **halves up**, the rule Today uses for a date's GPS distance. The statement does
not use `round(double precision)` (halves to even) or a `::numeric` cast (15 significant digits, so 1000.4999999999999
would become 1001): it computes `floor(x) + (x - floor(x) >= 0.5)`, which is exact for a non-negative double and equals
JavaScript's `Math.round`. The same statement then returns one **range row** after the date rows (`UNION ALL` over the
materialized per-date CTE; an aggregate without `GROUP BY`, so it exists for an empty range): `count`,
`daysWithEntries`, per metric `withValue`, the sum of the dates' **rounded** totals and `daysWithValue`, and the run
summary states. A range total is therefore exactly the sum of the daily column on screen. The response's daily and range
figures both come from SQL; `summarize*TrendDays` in the contract stays the definition the schema checks the range row
against, and an answer whose range row differs is refused rather than corrected. (As first written, the API computed the
range figures with those TypeScript functions.)

Zero logged entries does not establish physical inactivity: the screen says "none was logged, which does not mean you were
inactive", and never "inactive", "rest day" or similar.

## Decision 5: the Activity section of Trends

Below the health series, under the same end date and Refresh: **Source** and **Activity type** selects (recorded runs fix
the type to Run and leaving them restores the last type chosen for the other sources), a **Measure** radio group
(Entries/Imports/Runs, the source's duration name, Distance), the coverage and total sentences, the source's duration
explanation, a note for each 23- or 25-hour date (and, for a date the zone skipped, a note that it did not happen in
the zone and had no hours, a "Date skipped" table row and chart label, and "1 of them did not happen in this time zone"
in the coverage sentence, never a clock-change note), an SVG bar chart (one bar per date with a value, anchored to a zero
baseline; a dot on the axis for a recorded 0; an open circle for a date whose items have no value; the short gap mark of
the health chart for a date with nothing logged; native titles; the screen's single accent, so no new palette) and a
table of every date (newest first, "None logged", "Unknown", partial coverage as "From 2 of 3 runs", pending/stale
summaries per date) as the accessible equivalent. The section's chart, table and rows have their own classes and data
attributes, so the health series' selectors are unchanged.

`ActivityTrendsController` follows the Trends controller: one per session, person, organization and zone (the screen is
keyed by scope and mounted only while open); a change of end date, source or type clears the answer at once, aborts the
request and drops a late answer or failure for other filters; the session signal disposes it; an error keeps no previous
answer and offers Retry. App keeps the source, type and measure per scope like the series; sign-out forgets them.

## Decision 6: plans from evidence

`activity-trends-explain.integration.test.ts` seeds five members of one organization with 30,000 activities each (both
sources, every type, about four years) and 3,000 finished runs each (summaries current, stale or missing), runs
`ANALYZE`, and runs `EXPLAIN (ANALYZE, BUFFERS)` of both statements under `running_tracker_runtime` with the tenant
context set:

- **activities**: `Index Scan using activities_owner_started_idx` bounded by organization, owner and the range; source and
  type are filters on it (manual/ride: 54 of the person's 567 rows of the range kept; well under 2 ms). No change.
- **recorded runs**: `runs_owner_started_idx` gives the 59 runs of the range. As first written (`LEFT JOIN
  run_summaries`), the planner hashed a **sequential scan of the whole `run_summaries` table** (13,483 rows of every
  organization, 704 shared buffers, about 3.3 ms), whose cost grows with the database rather than with the range. The
  summary is now a `LEFT JOIN LATERAL (… OFFSET 0)` lookup, which PostgreSQL does not flatten into a join: one
  `run_summaries_pkey` probe per run of the range (59 probes, about 1.8 ms). The remaining fixed cost is the summary
  table's own RLS function, evaluated once per statement. The test asserts the index names and a bounded row count, not
  timings.
- **After the range row was added** (rechecked under the runtime role on the same synthetic data): the per-date part is
  unchanged (the same index scans, 54 activity rows for manual/ride, 59 `run_summaries_pkey` probes); the range row is
  one `Aggregate` over a second `CTE Scan` of the 27–28 materialized date rows, with no further table access (same buffer
  counts as the date part: 83, 56 and 411 shared hits; about 0.9, 0.5 and 2.8 ms of execution on this run).

## Corrections after review (2026-11-12)

1. **Skipped dates.** An empty date interval is valid (Decision 2); `GET …?endDate=2012-01-05&timeZone=Pacific/Apia`
   returned `500` before.
2. **Zone identity in the client.** The client compared the echoed zone with the raw request, so `europe/warsaw` was
   refused when the server answered `Europe/Warsaw` (Decision 1).
3. **Range figures from SQL.** The range row comes from the same statement and snapshot (Decision 4); the response shape is
   unchanged, the statement count stays one per read.

## Privacy

Owner-only like its sources; no new data, nothing to erase, `no-store`; the request log keeps its allow-list. The response
holds counts and totals only: no note, effort, id, start time, point or other free text.

## Alternatives considered

- **Summing activity history pages.** Rejected: one request per page, many snapshots, totals in the browser.
- **All sources in one answer.** Rejected by the product principle that sources are never combined; the history keeps
  showing all sources side by side.
- **Bucketing in SQL with `AT TIME ZONE`.** Rejected: PostgreSQL's tz data could differ from the server's, so a date's
  figure could disagree with Today and the day history around a rule change. The service computes the boundaries once.
- **One statement per date.** Rejected: 28 statements for one view.
- **A view, materialized table or job.** Rejected for the reasons of ADR-0084/0087: a second definition to keep in step,
  staleness and copies of health data to erase.
- **Rounding each run, or summing unrounded values across the range.** Rejected: the first changes Today's per-date
  figure, the second makes the range total differ from the sum of the table it sits above.

## Not established

- Browser evidence is Chromium only (desktop and a 375 px viewport with a wide font); no Firefox, WebKit or iPhone run.
- The plan evidence is one synthetic dataset on the workstation; no load run, no production-size organization.
- No weekly or monthly buckets, averages, pace, training load, goals or personal bests. (Later: the comparison with the
  previous 28 dates is ADR-0090.)
- The chart's tooltips are native titles (pointer only); keyboard and screen-reader users read the table.
- "Today" is fixed when Trends opens, as in ADR-0084. The zone is the client's word (the device's zone).
- Activity trends are not an AI input; weekly insights are unchanged.
