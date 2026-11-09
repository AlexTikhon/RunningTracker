# ADR-0084: 28-day Trends over stored daily records, with per-series coverage and no invented values

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration, Chromium end-to-end including a
  375 px viewport). Hosted CI: see the final report of the change.
- Date: 2026-11-09
- Relates to: ADR-0074 (a day is a local calendar date with the zone of its first write; "today" by the server clock in
  the client's zone), ADR-0078/0079 (manual movement, server-owned provenance; recorded totals with explicit
  denominators), ADR-0082 (Today: one snapshot, stored-date attribution, scoped navigation state), ADR-0083 (meal entries
  with optional user-reported totals; food energy kept apart from active energy).
- Scope: `GET /api/orgs/:orgId/daily-trends`, `packages/contracts/src/daily-trends.ts`, `apps/api/src/daily-trends/*`,
  the web **Trends** view, its controller, chart and table, a Today action, tests, docs. No migration, table, persisted
  aggregate, background job, cache, model call, new dependency, chart library or infrastructure. Today
  (`daily-overview-2`), the weekly review, AI insights (inputs, hashes, policies, source gates), check-in, movement and meal
  contracts, erasure and the Runner (startup, capture, recovery) are unchanged.

## Context

Today (ADR-0082) shows one date. The next product slice lets a person look across several weeks of what they recorded:
weight, sleep duration, steps and food energy. Across many dates the risks of a single day multiply: most dates are
partly empty, a missing value must not become zero in a total or an average, a line must not suggest values between two
measurements, a calorie total must not read as "what I ate", and the dates must not shift with the viewer's zone or a
daylight saving change.

## Decision 1: one owner-only read, a fixed number of range statements, one snapshot

`GET /api/orgs/:orgId/daily-trends?endDate=YYYY-MM-DD&timeZone=<IANA>`, authenticated, owner-only, `Cache-Control:
no-store` on every response (mounted before the JSON body parser, so a malformed body's `400` carries it too).

- **Range.** The 28 calendar dates ending on `endDate`, inclusive. The shared lower bound 2000-01-01 can cut it short
  (`endDate` 2000-01-10 gives 10 dates); the response then names the actual first date, `days` (the denominator of every
  coverage figure) and `shortenedByLowerBound: true`. Dates come from `addLocalDays` (calendar arithmetic on
  `YYYY-MM-DD`), never from adding 24 hours to an instant, so the 23- and 25-hour Warsaw dates are each present once
  (tested across 2026-03-29, 2026-10-25 and a leap day).
- **Validation.** A strict query object with exactly `endDate` (a real date, not before 2000-01-01) and one IANA
  `timeZone`; offsets, unknown names, repeated or extra parameters are `400 INVALID_REQUEST`. An `endDate` after today
  **in the requested zone by the injected server clock** is `400` with the server's "today" in the message (tested at the
  UTC+14 edge, at UTC-11, and across the Warsaw spring-forward midnight).
- **Statements.** One authenticated `REPEATABLE READ READ ONLY` transaction: the membership check, then three range
  statements bounded by the first and last date: check-ins (weight and sleep only), manual movement (steps only) and
  manual meals grouped by date. Never one read per date and never 28 overview requests. Each statement names the
  organization and the owner and runs under the owner-only RLS of its table; run sharing never applies (tested with a
  grantee who holds history and live grants on the owner's runs).
- **One snapshot.** The snapshot is taken by the first statement; a test-only hook (`testOnlyDailyTrendsHooks`, refused
  outside `APP_ENV=test`) commits deletions and insertions of check-ins, movement and meals between the check-in
  statement and the others: the answer is the earlier state, the next read the later one. With READ COMMITTED that test
  fails (mutation check).
- **Nothing stored.** No table, summary, cache or job; the next read after an edit or deletion over the existing APIs
  reflects it (tested over HTTP for each source). A test pins that reads change no row count of any source, the erasure
  ledger or weekly insights.

## Decision 2: stored dates only; the zone decides "today"

Every source here is a daily record that belongs to the calendar date it was stored for (`local_date`), whatever zone it
was saved in. No statement receives the requested zone; it only decides the latest allowed end date. A record saved in
Tokyo or Kiritimati stays on its date when the trends are read from Warsaw, UTC, Kiritimati, Pago Pago or Tokyo (tested).
Unlike Today, there is no timestamped source (activities, GPS runs) in this slice, so no interval is computed.

## Decision 3: four series, missing is null, two coverage levels for food energy

| Series | Per date | From |
|---|---|---|
| Recorded weight (kg) | `weightKg` or `null` | The check-in's weight; a check-in with only mood or a note has no value |
| Recorded sleep duration (min) | `sleepMinutes` or `null` | The check-in's sleep duration (a recorded 0 is a value) |
| Manually entered steps | `steps` or `null` | The manual movement row; active energy is not part of the trends |
| Food energy recorded (kcal) | `foodEnergy: { loggedEntries, entriesWithEnergy, recordedKcal }` | The manual meal entries of the date; `recordedKcal` is the exact sum over exactly the entries with energy, `null` when none has it |

Every date of the range is in `days`, also a date without any value. Nothing else is returned: no note text, meal
titles, meal types, macronutrients or stored zones.

**Food energy coverage** is two numbers kept apart: dates with an energy value (`daysWithEnergy` of `days`) and entries
with an energy value (`entriesWithEnergy` of `loggedEntries`). A title-only date has entries and no energy value. Even
when every logged entry has energy, the date is not described as a complete food diary: food that was not logged is
unknown, and the screen says so.

**Exact arithmetic.** Per date, PostgreSQL adds energy in `numeric`; across dates the contract adds integer tenths
(0.1 + 0.2 + 1,061.1 = 1,061.4, and 2 x 19,999.9 = 39,999.8, never a binary remainder). Weight differences are computed in
hundredths (72.30 - 72.35 = -0.05, not -0.04999...).

## Decision 4: modest statistics, defined once

`summarizeDailyTrendDays` in the contract defines the summary; the API computes it with that function and the strict
schema (`daily-trends-1`) refuses a summary that differs from it, days that are not every date of the range in order,
a food-energy total without an entry that records it, and a range that ends after its own "today".

- **Weight:** `daysRecorded`; `first`, `last` (date and value) and `changeKg` (last minus first) only with at least two
  recorded dates. One measurement is not a change.
- **Sleep:** `daysRecorded`, `recordedTotalMinutes` and `averageMinutes` over the recorded dates only, rounded to the
  nearest whole minute with halves up (integer arithmetic: `floor((2 x total + n) / (2 x n))`). Missing dates are left out,
  not counted as 0.
- **Steps:** `daysRecorded` and `recordedTotal` of the recorded dates only (`null` when none, `0` for recorded zeros).
- **Food energy:** `daysWithEntries`, `daysWithEnergy`, `loggedEntries`, `entriesWithEnergy` and `recordedTotalKcal`.

No prediction, correlation, target, balance, requirement, health score, medical interpretation or advice; unit and
browser tests scan the wording.

## Decision 5: the Trends view

- **Navigation.** Trends is the second navigation button (after Today). Runner stays the start view and keeps owning
  capture, the upload queue, the writer lease and recovery whatever view is shown (a Chromium test records a simulated run
  with Trends open: all six points arrive, the run is still recording and owned). Today gains "28-day trends", which opens
  Trends ending on Today's selected date; a table row's "Open" opens Today on that date through the same path as the Meal
  log's "Back to Today". App keeps the end date and the selected series per scope (session generation, person,
  organization) during ordinary navigation; sign-out forgets them.
- **Screen.** End date (2000-01-01..today) with "End today", a manual Refresh (no polling), the range label (with the
  shortening reason), a radio group for the four series, and for the selected series: its source ("Manually entered" for
  steps and food energy), coverage against the actual range, the summary sentences, a chart, the missing-data
  explanation and a table of every date (newest first, "Not recorded" for a missing value, the entry coverage for food
  energy). Loading, refreshing, empty, error with Retry and access-denied states.
- **Chart.** Plain SVG, no library: one x slot per date, a dot per recorded value, a line only between consecutive
  recorded dates, a short mark under the axis for a date with no value, never interpolation. Counts, durations and food
  energy start at 0, so a recorded zero is a dot on the baseline, distinct from a gap; weight is scaled around its values.
  One accent colour on the dark surface (a single series needs no legend; the heading names it), native titles on the
  dots, and the table as the accessible equivalent (the SVG has an `img` role and a description pointing to it). The left
  margin follows the longest axis label, so a wide font does not clip it (found by looking at a 375 px screenshot).
- **Controller.** `DailyTrendsController` follows the Today controller: the latest request wins, an end-date change
  clears the previous range at once and aborts its request, a late answer or failure for an abandoned range is dropped,
  an error keeps no previous answer, and the session signal disposes it. The screen is keyed by session, person and
  organization and mounted only while open, so every opening reads the range again and nothing crosses a change of scope.

## Privacy

Owner-only like its sources; no new data and no copy to erase; `no-store`; the request log keeps its allow-list. The
response never contains note text, titles or other free text, so a cache or a log of it could not leak them.

## Consequences

- One more read route and web view; the navigation has eight buttons (it still wraps at 375 px with a wide font,
  tested). Today has one more control.
- The trends version is independent of the overview version: a change of either does not change the other.

## Not established

- **No real iPhone or Safari evidence.** The 375 px checks are a Chromium viewport with a wide font, not a phone, Safari
  or WebKit. Nothing here ran on iOS.
- **"Today" is fixed when the screen opens**; across midnight it keeps the earlier date as the latest selectable one until
  reopened. The zone is the client's word, at most one day ahead of UTC (ADR-0074).
- The range length is fixed at 28; no other windows, comparisons between ranges, moving averages or baselines.
- No activities, GPS runs, active energy or macronutrients in the trends; movement and meals are the manual source only.
  A source-precedence read model for a later import (ADR-0078) does not exist yet.
- The chart's tooltips are the browser's native titles (pointer only); keyboard and screen-reader users read the table.
- HealthKit or any import: not started (Windows and an iPhone, no Mac/Xcode).
