# ADR-0090: Comparing activity trends with the previous 28 local dates

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including a concurrent-write test,
  mutation checks and `EXPLAIN (ANALYZE, BUFFERS)` under the runtime role, Chromium end-to-end including a 375 px viewport).
  Not run in Firefox, WebKit or on an iPhone.
- Date: 2026-11-12
- Extends: ADR-0089 (activity trends for one source and one type over 28 local dates). Relates to ADR-0084 (the Trends
  range and its 2000-01-01 lower bound, "today" by the server clock in the client's zone), ADR-0082/0088 (an item belongs
  to the local date it started on), ADR-0013/0015 (a run summary is current only for the run's data revision), ADR-0042
  (run policies admit runs shared with the caller).
- Scope: an optional `compare=previous_period` on `GET /api/orgs/{orgId}/activity-trends`, the comparison contract in
  `packages/contracts/src/activity-trends.ts`, two comparison statements in `apps/api/src/activity-trends/`, a compact
  **Compared with the previous 28 days** part of the Activity section on Trends, OpenAPI, tests at every layer, docs. No
  migration, table, view, persisted aggregate, background job, cache, model call or dependency. The ordinary answer (no
  `compare`) is byte-for-byte the ADR-0089 answer; Today, the history, the weekly review, the health series of Trends and
  every AI input are unchanged. No training-load score, fitness judgement or advice.

## Context

ADR-0089 shows what a person logged of one source and one type over 28 local dates, per date and for the range. The next
question is "more or less than the four weeks before?". Answering it naively is easy to get wrong: the two periods could be
read at different moments (a deletion between two reads makes the change wrong), a total over partly unknown values reads
as a real decrease, a range that ends today is still growing, a period cut by 2000-01-01 is not four weeks, a pending or
stale GPS summary has no value, and a percentage of a zero baseline does not exist. Each of these needs a rule that the
server applies and the screen can explain.

## Decision 1: one explicit, optional mode

`compare` is an optional, single-valued query parameter of the existing endpoint. Its only value is `previous_period`; an
empty, unknown or repeated value is `400 INVALID_REQUEST` (strict query object, like the other four). Without it, the
answer is exactly the ADR-0089 answer: no `comparison` key, no `applied.compare`, the same statements. With it, the answer
adds `applied.compare: previous_period` and a `comparison` object; the contract refuses an answer that has one without
the other.

## Decision 2: the two periods

For end date E: the **current period** is the range, E-27..E; the **previous period** is E-55..E-28, the 28 local calendar
dates immediately before it, for the same source, type and zone. Dates are calendar arithmetic (`addLocalDays`); every
date's start is located in the zone with `startOfLocalDate`, never by adding hours, so 23- and 25-hour dates and a date the
zone skipped (Pacific/Apia's 2011-12-30, an empty interval) are handled as in ADR-0089 in either period. The previous
period ends exactly where the range starts (the contract checks `previous.period.endsAt === range.startsAt`).

`previousActivityTrendsPeriodOf(endDate)` in the contract defines the previous period: cut by 2000-01-01 like a range
(`days` below 28, `shortenedByLowerBound`), or `period: null` when all of its dates are before 2000-01-01. The requested
dates (`requestedStartDate`, `requestedEndDate`) are always returned. 2000-02-25 is the earliest end date with two full
periods; 2000-01-28 the latest whose previous period is entirely out of range.

The answer returns both actual ranges: `comparison.current.period` (equal to `range`) with `inProgress`, and
`comparison.previous.period` with its own dates and UTC interval, plus `comparison.previous.summary`, which has the shape
of the range `summary` for the source (`count`, `daysWithEntries`, per metric `withValue`, the total and `daysWithValue`;
run summary states for recorded runs).

## Decision 3: one statement over at most 56 dates, one snapshot

The membership check and **one** comparison statement for the source run in the same `REPEATABLE READ, READ ONLY`
transaction as before (`withAuthenticatedTenantTransaction`, runtime role, RLS in force), so the query count stays fixed:
one aggregate statement per read, with or without `compare`.

- `activity-trends:activities-comparison` and `activity-trends:recorded-runs-comparison` are the ADR-0089 statements over a
  **window**: the bucket bounds are the previous period's date starts followed by the range's, at most 56, and the
  predicate is `started_at >= window start AND started_at < range end`. Organization and owner are stated in SQL besides
  RLS (`run.user_id` keeps runs shared with the caller out; removing it fails the shared-run test, mutation check).
- A bucket above the number of previous dates (`$8`/`$6`) is a date of the range; the statement returns the range's date
  rows, one `current` and one `previous` period row (an aggregate per period over the materialized per-date rows, so it
  exists for an empty period) and one `change` row. The range part goes through the ADR-0089 builder unchanged, so a
  comparison's `days` and `summary` equal an ordinary read's (tested on real data).
- Both periods come from one statement, so they cannot come from different snapshots even under concurrent writes. The
  transaction's snapshot also excludes writes committed after the membership check. Both are tested (Decision 6).

## Decision 4: what PostgreSQL computes, and how it is rounded

As in ADR-0089, each date's floating-point sum (distance, a run's observed duration) is rounded once to a whole unit,
halves up, with `floor(x) + (x - floor(x) >= 0.5)`; a period total is the **sum of its dates' rounded totals**, so each
period total equals the sum of a daily column. Entered and elapsed durations are integers and exact.

The `change` row gives, per metric, the signed absolute change `current - previous` (NULL when either total is undefined)
and the percentage in tenths of a percent:

    percent = (current - previous) / previous * 100, rounded to one decimal place, halves away from zero

computed exactly from the integer totals as `sign(d) * div(|d| * 2000 + p, 2p)` with numeric integer division (`div`
truncates; both operands are positive, so this is `floor(|d| * 1000 / p + 1/2)`). No floating point and no `round()` is
involved; `::numeric` only keeps `|d| * 2000` from overflowing `bigint`. 49/400 = 12.25 % gives 12.3 and -49/400 gives
-12.3 (halves to even would give 12.2). The percentage is NULL when the previous total is 0. The JSON value is tenths / 10,
a number with at most one decimal.

`activityTrendsPercentTenths` in the contract computes the same with `BigInt`, and `activityTrendsComparisonFiguresOf`
defines every metric, change and reason. The service takes the changes and percentages from PostgreSQL and the
availability from the contract's rules; the schema then compares the whole comparison with the contract's definition and
refuses an answer that differs (a wrong change or percentage is a `500`, never corrected), as ADR-0089 does for range rows.

## Decision 5: availability per metric, with stable reasons

The comparison policy is versioned: `comparison.policyVersion: activity-trends-comparison-1` (the ordinary trends keep
`activity-trends-1`). Each metric (`count`, the source's duration name — `enteredDuration`, `elapsedDuration` or
`observedDuration` — and `distance`) has both period totals and a `change`:

- `{ status: available, absolute, percent, percentUnavailableReason }`, where `percent` is null exactly when
  `percentUnavailableReason` is `zero_baseline` (the previous total is 0; the absolute change stays available);
- `{ status: unavailable, reasons: [...] }`, with every applicable reason in this fixed order:

| Reason | Applies to | When |
|---|---|---|
| `current_period_in_progress` | every metric | the range ends today, so later records can still change it |
| `current_period_shortened` | every metric | 2000-01-01 cut the range below 28 dates |
| `previous_period_out_of_range` | every metric | every previous date is before 2000-01-01 (`previous.period` and its totals are null) |
| `previous_period_shortened` | every metric | 2000-01-01 cut the previous period below 28 dates |
| `current_period_no_entries`, `previous_period_no_entries` | duration, distance | that period has no item, so no total (not a total of 0) |
| `current_values_missing`, `previous_values_missing` | duration, distance | some items of that period do not record the metric |
| `current_summaries_pending`, `previous_summaries_pending` | duration, distance | some recorded runs of that period have no summary yet |
| `current_summaries_stale`, `previous_summaries_stale` | duration, distance | some recorded runs of that period have a summary for older data |

`comparison.periodReasons` repeats the first four kinds once for the screen. In words:

- **Counts describe logged records only.** They are compared whenever both periods exist as full 28-date periods and the
  range has ended, whatever the metric coverage; an empty period is a count of 0 (so 0 vs 0 is an absolute change of 0
  with no percentage). For recorded runs the count is runs, whatever their summary state.
- **Durations and distances** need, in both periods, at least one item and the value for every item (full metric
  coverage), and for runs no pending or stale summary. A recorded zero is a value: a previous total of 0 from recorded
  zeros gives an available absolute change and no percentage.
- **In progress.** A range ending today keeps its ordinary trends and both periods' values; every change is unavailable.
- **Shortened or missing periods** are never compared as full 28-day periods; their figures are returned with the reason.
- **Full metric coverage is not complete logging.** It says that every logged item records the value, not that every
  activity was logged; the screen says so.

## Decision 6: the comparison on the Trends screen

The web client always asks for `compare=previous_period` (one request per filter set, as before) and refuses an answer
whose echo lacks it or has no `comparison` (`readActivityTrends`, and the controller again). Filters, request
cancellation, session disposal and the canonical zone comparison (`sameTimeZone`) are unchanged.

Below the duration explanation, **Compared with the previous 28 days** shows both periods' dates ("15 Oct 2026 – 11 Nov
2026 (28 dates)"), the period notes (in progress, shortened or out of range), the coverage caveat, and a table with one row
per measure: this period's and the previous period's value with its coverage ("From 2 of 3 entries", "None logged",
"Unknown", pending or stale summaries), and the change: "+1 (+50.0%)", "−30:00 (−25.0%)" (U+2212), "+1.00 km" with "No
percentage: the previous total is 0.", or "Not compared" with the measure's reasons in words. The browser formats the
server's numbers (`formatSignedChange`, `formatPercentChange`) and never computes a change. No "better", "worse", goal,
score or advice. The table uses the Trends table styles and fits a 375 px viewport.

## Evidence

**Real PostgreSQL** (`activity-trends-http.integration.test.ts`, 13 new tests, runtime role and RLS): equal periods (no
change, 0.0 %) and a comparison equal to two ordinary reads; rounding (two dates of 199.5 m → 400, not 399; +12.3 % and
-12.3 %); empty periods, zero baseline, recorded zero and partial coverage; current, pending and stale run summaries;
today in progress; 2000-02-25, 2000-02-24 (27 previous dates), 2000-01-28 (out of range) and 2000-01-10; Warsaw with the
23-hour 2026-03-29 in the previous period and records at the microsecond on both sides of the shared boundary, agreeing
with PostgreSQL's own `AT TIME ZONE` grouping; Pacific/Apia with the skipped date as the range's first date and inside the
previous period; deletions over HTTP in either period; owner isolation and shared-run exclusion in both periods; unknown
and repeated `compare` refused.

**Snapshots.** A test-only hook commits, after the membership check, a move of an item from the previous period into the
range, a deletion in the range and an insertion in the previous period: the answer shows both periods before the writes,
the next read after them. Without the read-only snapshot (READ COMMITTED) that test fails (mutation check). A concurrent
test moves one item between the periods in committed `UPDATE`s as fast as one connection can while 100+ comparison reads
run five at a time: every answer has the same totals across the two periods (5 items, 2,000 s) and the change row agrees
with its totals, while the readers saw the item on both sides (one run: 100 answers, 73 committed moves).

**Plans** (`activity-trends-explain.integration.test.ts`, 150,000 activities and 15,000 runs over five members, runtime
role): the activity comparison reads `activities_owner_started_idx` once over the 56-date window (manual/ride: 109 rows kept
of the 1,143 in the window, 363 shared buffer hits, about 1.1 ms); the run comparison reads `runs_owner_started_idx` (123
runs) with one `run_summaries_pkey` probe per run (867 shared hits, about 3.7 ms); the period and change rows are
aggregates over the materialized date rows with no further table access. About twice the ADR-0089 range statements, as the
window is twice as long.

## Alternatives considered

- **Two ordinary reads (two requests) and a difference in the browser.** Rejected: two snapshots, and numbers computed in
  the browser.
- **Two statements in the one transaction.** Equivalent under REPEATABLE READ, but twice the scans and no place for SQL to
  compute the changes from both periods' rows; one statement keeps the query count fixed.
- **A percentage in floating point or `round(numeric)` of a divided value.** Rejected: a numeric division keeps a limited
  number of digits, so a value just below a half could be rounded as a half for very large totals; integer division is
  exact.
- **Comparing partial coverage as "at least".** Rejected: an unknown value is not zero, and a total over fewer items reads
  as a decrease.
- **Comparing a range that ends today, or prorating it.** Rejected: an unfinished period is not comparable, and prorating
  is an estimate without a definition.
- **Comparing a shortened previous period scaled to 28 dates.** Rejected for the same reason.
- **Always comparing (no parameter).** Rejected: doubles the window for every existing caller; the explicit mode keeps the
  ADR-0089 answer unchanged.

## Not established

- Browser evidence is Chromium only (desktop and 375 px); no Firefox, WebKit or iPhone run.
- One synthetic dataset for the plans; no load run.
- The single-statement property is structural; the concurrent test shows it under one writer pattern, not every possible
  interleaving.
- A percentage too large for a JSON-safe integer of tenths (about 9 × 10^14 %) would be a `500`; real totals are far below.
- No week-by-week or year-over-year comparison, averages, pace, training load, goals or advice; not an AI input.
