# ADR-0056: Owner-only archive search over published summaries

- Status: accepted; implemented and verified locally
- Date: 2026-10-11
- Amends: nothing. `GET /api/orgs/{orgId}/runs` keeps returning every run the person may read, shared runs included.
- Scope: `packages/contracts`, `apps/api/src/runs`, `apps/web`, `scripts`, tests. No migration, no new dependency,
  no change to an existing authorization, ingestion or lifecycle behaviour.

## Context

A person could browse the archive only as a map and as the generic run list, which is a half-open `started_at`
interval of everything row-level security lets them read. There was no way to ask "my finished runs of last month,
between 5 and 10 km, longest first" and see them as a list. The next stage will translate natural language into
exactly this request, so the request has to be a strict, verified contract first; no language model is involved here.

## Decision

### 1. A separate endpoint, not a mode of the list

`GET /api/orgs/{orgId}/runs/search`, session-authenticated, read-only, `parameters` in the query string like every
other read. It is registered **before** `/:runId`, so the static segment can never be read as a run id (a test
requests it and a sub-path to show which handler answered). The run list and its semantics are untouched: other
consumers (the map's list, a coach) legitimately need shared runs, and widening or narrowing that endpoint would
change them.

### 2. "My runs" is stated, not inherited from row-level security

Every request runs through `withAuthenticatedTenantTransaction` (membership rechecked inside the transaction, RLS in
force, runtime role). RLS also lets this role read runs that were shared with the person, so the SQL names the owner
itself: `run.org_id = $1 AND run.user_id = $2 AND run.status = 'finished'`, with `$2` the session's `userId`. The
query contract is a strict object: an owner, a user, an organization or a status in the query is a 400. The
organization comes from the validated route and is authorized by the transaction.

### 3. Results are runs with a current published summary

An item needs a distance, an observed duration and quality statistics, and these come only from `run_summaries`,
joined on `summary.source_revision = run.data_revision`. No raw point is read and nothing is recalculated in the
request (a test asserts the statements never name `run_points`). A finished run of the person in the period whose
summary is missing or was made for an older data revision is **not** an item; it is counted in
`pendingSummaryCount`. That count is taken over the same owner and period but **before** any distance bound and
without the cursor, because whether such a run would match is unknown until its summary exists. The screen says
they are still being processed and, when a distance filter is applied, that it is not known whether they match.

### 4. Periods: local dates in a zone, converted on the server

- Input is either a preset (`this-month`, `previous-month`: whole calendar months in the zone) or both of
  `fromDate` and `toDate`, **inclusive** local calendar dates, at most 366 days (the existing archive bound), plus
  a required IANA `timeZone`. Offsets (`+01:00`) and abbreviations are refused: they do not say what a calendar day
  is in a place. Years 1970 to 2100.
- The server converts to `[from, to)` over `runs.started_at`: `from` is the start of `fromDate`, `to` is the start
  of the day **after** `toDate`, found by calendar arithmetic, never by adding 24 hours. Filtering is on
  `started_at` (when the run began), not `finished_at`, so a run that starts at 23:50 and ends after midnight
  belongs to the day it started.
- "Now" for presets is the injected `Clock`; the client sends no time.
- The start of a local day is the first instant from which every later instant has a local date on or after it,
  computed from the zone's own offset history (`Intl`; Node 24 has no stable Temporal, and a library would add a
  dependency for one function). That gives 23- and 25-hour days, a 23.5-hour day at Lord Howe, a day that begins
  at the instant of the jump when local midnight does not exist (America/Sao_Paulo 2018-11-04), the earlier of two
  midnights (America/Havana 2023-11-05), the later of two when clocks go back from 00:00 to 23:00 (the 25-hour
  2023-03-25 in America/Asuncion), and an empty interval for a date that was skipped (Pacific/Apia 2011-12-30).
  A test walks a year of days in eight zones and checks that days tile the timeline and that every probed instant
  carries the date of its day.

### 5. Distance bounds

`minDistance` and `maxDistance` are decimal strings of at most three fraction digits, up to 100000, with a
required `distanceUnit` (`km` or `mi`, the international mile of exactly 1609.344 m); a unit without a bound is
refused as ambiguous, and `min > max` is a 400. They are converted to metres from the decimal digits with integers
(both numerator and denominator stay below 2^53, so one division is correctly rounded), because binary
multiplication is one unit off for some inputs (`0.017 mi`). Bounds are inclusive and compared with the stored
metres. What a card shows is rounded to two decimals and never feeds back: 4999.96 m shows as `5.00 km` and is
still below a 5 km minimum.

### 6. Keyset paging for every sort

Sorts are `newest` (`started_at DESC`), `longest` (`distance_m DESC, started_at DESC`) and `shortest`
(`distance_m ASC, started_at DESC`), each ending in `run.id DESC`, which makes the order total. There is one fixed
SQL statement per sort, chosen from a table (an unknown sort throws; nothing is interpolated), and its keyset
predicate matches its `ORDER BY`. The cursor carries `{ version, sort, startedAt (microseconds), distanceKey
(double precision::text), runId, context }`. `context` is a SHA-256 digest of the person, the organization, the
zone, the resolved `[from, to)`, both bounds in metres and the sort, so a cursor from another query, person,
organization, period or order is a 400 `INVALID_CURSOR`. It is **not signed**: forging one can only move a keyset
position inside the person's own authorized rows, and nothing in it is trusted for authorization. A month preset
that rolls over between two pages changes `from`/`to` and therefore invalidates the cursor; the screen offers a new
search. Consistency is that of an unchanged dataset: pages neither omit nor repeat. No snapshot across concurrent
changes is promised, and the page and the pending count are two statements in one transaction.

### 7. GPS quality label

`gpsQuality` is derived on the server from the summary's statistics so the screen has no rule of its own:
`insufficient` when `insufficientData`, `poor` when fewer than 80 % of the raw measurements were used
(`acceptedPointCount * 5 < rawPointCount * 4`), otherwise `good`. The 80 % line is a presentation choice, not a
property of the summary algorithm, and can be changed without touching stored data. `observedDurationS` is labelled
"Observed duration"; the screen offers no pace, no moving time and no recommendation. *Correction (2026-10-12, ADR-0057):*
this section first described the value as the time between the first and last accepted measurements. It is not:
`app_private.calculate_run_summary` (migration 0009) computes `sum(edge.duration_s) FILTER (WHERE edge.accepted)`, the
sum of the durations of the accepted edges, as ADR-0013 already says. Time across rejected edges, gaps and pauses is
not in it. The contract comment, the screen's note and this paragraph were corrected; the algorithm and its numbers
were not touched.

### 8. The screen

`RunSearchPanel` sits under the archive map. The editable draft and the **applied** filters are separate state;
results always belong to the applied ones, an "Applied filters" block shows them (with the period the server
resolved), and a note says when the draft has not been applied. Applying always starts a new search.
`RunSearchController` (framework-free, one instance per organization and applied filters) aborts its request on
disposal and ignores any later answer; one page is in flight at a time, the cursor is only ever the one the server
returned for the previous page, and a run repeated across pages is dropped. The panel is keyed by person and
organization, so switching either starts from a clean draft with no results, cursor or request carried over. A
401 goes through the existing announcement (the session is suspended and sign-in is shown); a 403 clears the list
and says access was lost; any other failure shows the server's message with Retry, and a failed next page keeps the
pages already shown. The browser's zone is the default and is displayed; an unusable name falls back to UTC. The
panel says plainly that the list is only runs the person recorded and that the map can also show shared routes; the
map and its authorization are unchanged.

### 9. Demo data

`npm run demo:seed:search` (`scripts/demo-search-*.mjs`) is additive and idempotent: every insert is
`ON CONFLICT DO NOTHING`, nothing is updated or deleted, and a run's summary and points are written only when the
run itself is new. It reuses `requireDevelopmentDatabase` (loopback, owner role, database `running_tracker`) and
refuses `APP_ENV` other than development. New people and both organizations have fixed demo identifiers; the runner
is the existing demo runner. 67 synthetic runs for a month: 47 of the runner's in the main organization (equal
distances, one pair equal in start and distance, 4999.96 m, poor and insufficient quality, three with no current
summary), eight teammates' runs (four shared with the runner), and a second organization with the runner's long
runs and a stranger's. The runs without a current summary carry synthetic points, so the API's summary worker
really processes them within about a minute, which is what "still being processed" means; synthetic summaries
carry the current algorithm version so the worker does not rebuild them from the absent points.

## Alternatives considered

- **`?owner=me` on the existing list.** Rejected: it changes an endpoint other consumers rely on and keeps the
  `from`/`to` instant interval, which cannot express a local calendar date.
- **POST with a JSON body.** Rejected: the request is a read, and GET is the repository's convention for reads.
- **A date library (Temporal polyfill, luxon).** Rejected: one function and a test matrix that already pins the
  odd zones; a dependency would also have to be kept in step with the platform's zone database.
- **Signing the cursor.** Not needed for the reasons in 6; the existing signed live-track cursors protect a
  revision window that a client must not choose, which does not exist here.
- **Including pending runs as cards without a distance.** Rejected: the card is distance, duration and quality;
  a card without them would be a different component and a distance filter could not treat it honestly.
- **A migration (an index on distance).** Not shown to be needed: the statement is bounded by one person's finished
  runs in at most 366 days inside one organization, served by `runs_owner_started_idx` for the owner and period.
  This is a design argument, **not a measurement**: no load run or `EXPLAIN` on a production-size table was made.

## Consequences and limits

- A summary made by an older **algorithm version** but for the current data revision still counts as current: the
  summary worker republishes those, and search follows the rule given for this stage (existence and source revision).
- Browser and server may disagree about a very new zone name (each uses its own zone database); the server then
  answers 400 and the screen shows it.
- The cursor is invalid once a preset's month changes, by design.
- No keyboard-shortcut, saved-search or export features; no detail page; the card is not a link.
- Next stage: a language model may produce this same request. The strict contract, the owner rule and the
  `INVALID_REQUEST` details are what it can be checked against.
