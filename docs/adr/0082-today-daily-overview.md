# ADR-0082: Today, a read-only daily overview with stored-date and start-time attribution, and the SomaLane name

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration, Chromium end-to-end including a
  375 px viewport). Hosted CI: see the final report of the change.
- Date: 2026-11-08
- Relates to: ADR-0074 (a check-in belongs to a local calendar date; "today" by the server clock in the client's zone),
  ADR-0078 (manual movement with server-owned provenance; sources never added), ADR-0077/0079 (the weekly review's one
  snapshot, explicit coverage and code-written wording), ADR-0072/0073 (owner-only activities), ADR-0056 (local day
  intervals from the zone's own rules).
- Scope: `GET /api/orgs/:orgId/daily-overview/:localDate`, `packages/contracts/src/daily-overview.ts`,
  `apps/api/src/daily-overview/*`, the web **Today** view and its controller, a small navigation intent into the existing
  Check-in editors, the visible application name, tests, docs. No migration, table, persisted summary, background job,
  cache, model call, new dependency, routing library or infrastructure. Weekly review, AI insights, stored insights,
  check-in and movement contracts are unchanged.

## Context

The data foundation now has check-ins, manual movement, manual activities and GPS runs, each on its own tab. Nothing
shows one day across them. The next product-facing slice is a **Today** view built only from existing data, plus the
working product name **SomaLane** (`docs/product-direction.md`) in the visible application. A day is harder than it
looks: check-ins and movement are stored per calendar date with the zone of their first write, while activities and runs
are instants; a local day is 23 or 25 hours around a daylight saving change; manual and GPS records can describe the
same session; and a missing value must never read as zero.

## Decision 1: one owner-only read endpoint, one snapshot, no writes

`GET /api/orgs/:orgId/daily-overview/:localDate?timeZone=<IANA>`, authenticated, owner-only, `Cache-Control: no-store`
on every response (mounted before the JSON body parser, so even a malformed body's `400` carries it, as for movement).

- **Validation.** The path is strict (`localDate` a real `YYYY-MM-DD` not before the shared lower bound 2000-01-01, `orgId`
  a UUID); the query is a strict object with exactly one IANA `timeZone` (offsets, unknown names, repeated or extra
  parameters are `400 INVALID_REQUEST`). A date after today **in the requested zone by the injected server clock** is
  `400` with the server's "today" in the message (ADR-0074's rule; tested at the UTC+14 edge).
- **One snapshot.** One authenticated `REPEATABLE READ READ ONLY` transaction: the membership check, then a
  day-record statement (check-in and movement) and a timestamped-source statement (activities and runs). The snapshot is
  taken by the transaction's first statement, so a write committed between the two statements is not seen; a test-only
  hook (`testOnlyDailyOverviewHooks`, refused outside `APP_ENV=test`) commits deletes and inserts there and the answer is
  the earlier state; the next read sees the later one. With READ COMMITTED that test fails (mutation check).
- **Ownership.** Row-level security plus explicit organization and owner predicates in both statements. GPS runs are
  filtered by `run.user_id`, so runs that sharing grants make readable never count; removing that predicate fails the
  grantee test (mutation check). Another member, a grantee and another organization see only their own data or `403`.
- **Nothing stored.** No table, summary, cache or job; the response is recomputed per read, so the next read after a
  deletion commits excludes the record (tested over HTTP for a check-in, a movement day and an activity). A test pins
  that reads change no row count of any source, the erasure ledger or weekly insights.

## Decision 2: two attribution rules, by the nature of the record

| Source | Belongs to | Why |
|---|---|---|
| Check-in, movement | Their **stored** `local_date`, whatever zone they were saved in and whatever zone the overview is viewed in | They describe a calendar day the person named (ADR-0074, ADR-0078). Re-reading them in another zone would move, split or merge days. |
| Manual activities, GPS runs | The date on which they **started** in the requested zone: `[start of date, start of next date)` | They are instants. Start time is unambiguous; splitting a duration across midnight would invent a per-day figure nobody entered. |

- **Stored zone is provenance, not a filter.** The response returns each record's stored zone; the screen explains a
  difference ("This check-in was saved in Asia/Tokyo. It belongs to this calendar date in any time zone; activities and
  GPS runs below are counted by when they started in Europe/Warsaw."). Tested with Tokyo and Kiritimati records viewed
  from four zones and their neighbouring dates.
- **The interval is computed, never assumed.** `startOfLocalDate` (ADR-0056) locates each local midnight from the
  zone's own offset history, so the Warsaw spring-forward date is 23 hours (`2026-03-28T23:00Z`..`2026-03-29T22:00Z`)
  and the fall-back date 25 hours (`2026-10-24T22:00Z`..`2026-10-25T23:00Z`, both 02:30s included); the response carries
  `startsAt`/`endsAt` and the screen says when a date is not 24 hours. Tested at the millisecond either side of each
  midnight.
- **Duration is named for what it is.** `enteredDurationS` is the full duration the person entered for the activities
  that **started** on the date, also one that continued past midnight (an activity at 23:30 for 3 hours counts 10,800 s
  on its start date and nothing on the next). The screen says so beside the figure.
- **GPS runs.** Only the person's own `finished` runs. A distance comes only from a summary whose `source_revision`
  equals the run's `data_revision`; `withCurrentDistance` and `withoutCurrentDistance` are returned separately and
  `currentDistanceM` is the sum over exactly the former (rounded once, to the metre), or `null` when there are none,
  never 0. A partial total says which runs it covers ("5.01 km from 1 of 2 runs; 1 run has no distance yet").
- **Sources stay apart.** Manual activities and GPS runs are separate sections and never added (one may describe the
  other; the screen says so when both exist). Movement is never added to either, and activity calories, if any later
  existed, would not be added to active energy; nothing is estimated.

**Unlike the weekly review**, the overview always uses the requested zone for the timestamped sources. The weekly
review reads its week in the zone stored on that week's check-ins because its aggregate is an AI input that must not
change with the device's zone; the overview is a view of "my day where I am" with no stored derivative, and its stored
records do not move either way. This difference is deliberate and visible in both responses (`week.timeZoneSource`,
`day.timeZone`).

## Decision 3: only what the screen needs

The contract (`daily-overview-1`) is strict and self-checking: the day (date, zone, interval, `inProgress`); the
check-in's five numeric values, `recorded`, `hasNote` and stored zone; movement's two values, `recorded`, `source` and
stored zone; activity `count` and `enteredDurationS`, in total and by type (types in `ACTIVITY_TYPES` order, counts and
durations must add up); GPS run counts and the current-distance total; provenance (`computed_by_app`, `persisted: false`,
`single_read_only_transaction`, version, computation time). Not returned: note text, activity notes, distances or effort,
run identifiers, points or geometry. **A note-only check-in is a record** (`recorded: true`, all values `null`,
`hasNote: true`), so the day is not empty; the screen says a note exists and that the check-in editor shows it.
`null` is unknown and `0` is a recorded zero, in the contract, the API and the screen.

## Decision 4: the Today view and a small navigation intent

- **Navigation.** Today is the first button of the existing view switcher. **Runner stays the start view**: its startup
  restores and confirms an active run, and that behaviour is not changed in this slice. Runner remains mounted while
  hidden and App keeps owning capture, the upload queue, the writer lease and recovery whatever view is shown. A
  Chromium test starts a simulated run, opens Today while most points are still to be captured, and sees all six reach
  the server while Today is visible, with the same run still recording and the writer still owned.
- **Screen.** Today's date by default (the device zone, fixed when the screen opens, as for the Check-in tab), a date
  picker limited to 2000-01-01..today, "Go to today", a manual Refresh (no polling), the date and zone, and one section
  per source with "Not recorded" for missing values, "Manually entered" on steps and active energy, explicit empty,
  partial-distance, zone and 23/25-hour notes; loading, refreshing, error with Retry and access-denied states. A
  movement-only day, a note-only check-in and a recorded zero are not empty days. No target, judgement, trend or advice
  (a unit test scans the rendered text for such words).
- **Controller.** `DailyOverviewController` follows the weekly review controller: the latest request wins, a date
  change clears the previous date at once and aborts its request, a late answer or failure for an abandoned date is
  dropped, an error keeps no previous answer, and the session signal disposes it. The screen is keyed by session,
  person and organization and mounted only while open, so every opening reads the day again (after an edit or deletion
  in another view too) and nothing crosses a change of scope.
- **Actions.** "Add/Edit check-in", "Add/Edit movement" (both for the selected date), "Open Activities", "Open Runner".
  A `TodayAction` becomes an `EditorIntent` `{ localDate, section, scope }`; the Check-in screen reads it once when it
  mounts, opens that section's existing editor on the date (the other editor on today) and focuses its heading. No form
  is duplicated and no routing dependency is added. The intent and Today's kept date carry the scope they were made in
  and are ignored under any other; sign-out clears both. An ordinary navigation button opens a view without an intent
  and Today keeps its selected date.

## Decision 5: the visible name is SomaLane

The header, the brand's accessible label, its initials mark (SL, in the existing mark style) and the browser title are
"SomaLane". Package names, the repository, database identifiers, cookies, environment variables and API paths keep the
Running Tracker names (`docs/product-direction.md`). No redesign.

## Privacy

Owner-only like its sources; no new data, no copy to erase, `no-store`, and the request log keeps its allow-list (route,
status, timing). The overview never returns note text, so a cache or a log of a response could not leak it either.

## Consequences

- One more read route, one more web view, a navigation list in `App.tsx` instead of six hand-written buttons, and an
  optional `intent` prop on the Check-in screen (with `initialDate`/`focusOnOpen` on its Movement section).
- The view switcher has six buttons; at 375 px it wraps as before (tested with a wide font).

## Not established

- **No real iPhone or Safari evidence.** The 375 px check is a Chromium viewport with a wide font, not a phone, Safari
  or WebKit. Nothing here was run on iOS.
- **"Today" is fixed when the screen opens**; across midnight it keeps the earlier date as the latest selectable one until
  reopened (the server still refuses a date after its own today).
- **The zone is the client's word**, at most one day ahead of UTC (ADR-0074).
- **Overlap is reported, not resolved**: a manual run and a GPS run of the same session are both counted in their own
  sections. A unified read model and deduplication remain deferred (ADR-0077).
- GPS run distance only; no GPS duration, pace or per-run list on Today. No trends, comparisons, targets or
  recommendations by design.
- Today is not the start view; making it so needs its own decision about run recovery on startup.
- HealthKit or any phone/watch import: not started. The next planned phase is an iPhone/HealthKit integration spike that
  must first establish access to macOS/Xcode and a physical iPhone.
