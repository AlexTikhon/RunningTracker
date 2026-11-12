# ADR-0087: A read-only, owner-only unified activity history

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration, Chromium end-to-end). Not run
  on an iPhone, in Safari or in Firefox.
- Date: 2026-11-11
- Relates to: ADR-0072/0073 (owner-only manual activities, idempotent creation), ADR-0086 (GPX imports, elapsed
  duration), ADR-0013/0015 (revision-bound summaries; a summary is current only for the run's data revision), ADR-0056
  (owner-only run search: owner stated in SQL, keyset cursors bound to their scope), ADR-0067 (owner run details),
  ADR-0011/0047 (capture sources live in the browser), ADR-0082 (Today: one read-only snapshot).
- Amends: the Activity tab's list (ADR-0072 section 3) is replaced by the history; `GET /activities` and every write route
  are unchanged.
- Amended by: ADR-0088 (an optional local calendar day filter, `activity-history-2`, the cursor context extended with the
  day when one is set, and history actions on Today's cards).
- Scope: `GET /api/orgs/{orgId}/activity-history`, `packages/contracts/src/activity-history.ts`,
  `apps/api/src/activity-history/*`, the Activity screen (`ActivityHistoryList`, `activity-history-controller.ts`), OpenAPI,
  tests at every layer, docs. No migration, table, view, persisted aggregate, background job, cache, model call, import
  format, goal or training-load figure, and no new dependency.

## Context

The product direction plans "a unified read model over `runs` and `activities` (a view or a union)" for the analytics
phase. Today the Activity tab lists manual entries and GPX imports, while recorded GPS runs live only in Archive → My
runs. A person who wants to see "what did I do lately" has to look in two places, and nothing shows the three sources
side by side with their provenance. The first step is a read-only list, not analytics: no totals, no deduplication, no
derived numbers.

## Decision

### 1. One read endpoint over the existing tables

`GET /api/orgs/{orgId}/activity-history?source=&type=&limit=&cursor=`, session-authenticated, `Cache-Control: no-store`
on every answer (mounted before the JSON parser, as for Today). The query is a strict object: `source` (`manual`, `gpx`
or `recorded_run`) and `type` (an activity type) are optional and single-valued, `limit` 1 to 50 (default 20). A repeated,
unknown or owner-like parameter is `400 INVALID_REQUEST`.

The page is one `UNION ALL` statement of two branches, read in one `REPEATABLE READ, READ ONLY` transaction together
with the membership check (`withAuthenticatedTenantTransaction`, runtime role, RLS in force):

- **activities**: manual and GPX rows of `activities`, with their stored, server-owned `source`;
- **runs**: the person's own `finished` runs, `LEFT JOIN run_summaries`.

Nothing is copied into another table and no view is created: a migration would add a second definition to keep in step
with two tables for no gain at this size, and the union stays visible in one place in the code. Each branch has its own
`ORDER BY … LIMIT page + 1` over its owner index (`activities_owner_started_idx`, `runs_owner_started_idx`, both
`(org_id, user_id, started_at DESC, id DESC)`), and the outer query orders and limits again.

### 2. Ownership is stated in every branch

RLS on `activities` is owner-only; RLS on `runs` and `run_summaries` also admits runs **shared** with the caller
(ADR-0042). Each branch therefore states `org_id = $org AND user_id = $session_user`, so a run another person shared
never enters the history, whatever grants exist (live, history or both). A non-member or inactive member is `403
ORG_ACCESS_DENIED`; another organization's rows are never read. Tested with the existing tenant fixtures (a grantee with
history grants on three of the owner's runs, a coach in the organization, a coach in another organization with a grant
there, an inactive member); removing the run branch's owner predicate fails two of those tests (mutation check).

### 3. A total order and cursors bound to their scope

Order: `started_at DESC`, then a **kind rank** (`run` 1 before `activity` 0), then `id DESC`. Manual and GPX rows are one
kind: one table whose primary key makes the id unique within the organization. The rank, not the id, separates an
activity and a run that happen to share a UUID; nothing relies on ids being unique across tables.

The keyset predicate of each branch is the row comparison `(started_at, rank, id) < (cursor)` with the branch's constant
rank substituted, written as `started_at <= $start AND (started_at < $start OR …)` so it stays an index range.
Timestamps are compared at PostgreSQL's microsecond precision (the cursor keeps all six digits; the response drops
trailing zeros like every other timestamp).

The cursor is base64url JSON `{ version: 1, startedAt, kind, id, context }`, `context` being a SHA-256 digest of
`['activity-history', 1, userId, orgId, source ?? '*', type ?? '*']`. A tampered or malformed cursor, or one from another
person, organization or filter, is `400 INVALID_CURSOR`, decided before the transaction. Malformed includes a
`startedAt` that is not exactly `YYYY-MM-DDTHH:MM:SS.ffffffZ`, not a real calendar date and clock time (February 30,
February 29 of a common year, 24:00) or in year 0000: PostgreSQL refuses these, and `Date.parse` would roll some of them
over instead of refusing them. The string is passed on unchanged, never through a JavaScript `Date`. It is not signed, for the
reason of ADR-0056/0072: forging one only moves a position inside the caller's own rows. Consistency is that of an
unchanged dataset: pages neither repeat nor skip; a write between two page requests may move items (no cross-page
snapshot is promised).

### 4. Provenance and labelled measures, never combined

Every item has a `source`, and each source names its duration for what it is, so a client cannot confuse them:

| `source` | Fields | Meaning |
|---|---|---|
| `manual` | `enteredDurationS`, `distanceM` (nullable), `rpe`, `notes` | What the person entered (ADR-0072) |
| `gpx` | `elapsedDurationS`, `distanceM` | First to last point of the file, pauses included, not moving time; distance computed at import (ADR-0086) |
| `recorded_run` | `summary`, `finishedAt`, `captureSource` | A finished GPS run recorded in SomaLane |

The response has no total, no count across sources and no "same outing" link: the same outing entered, imported and
recorded appears up to three times, as Today and the weekly review already say. A recorded run's type is `run`; a
`type` filter other than `run` therefore excludes recorded runs.

### 5. Run metrics only from a current summary

`summary` is `{ state: 'current', distanceM, observedDurationS, gpsQuality }` only when a published summary's
`source_revision` equals the run's `data_revision`: the existing check used by run search, run details, Today and the
weekly review. Otherwise it is `{ state: 'pending' }` (no summary yet) or `{ state: 'stale' }` (a summary for an older
revision), with no metric at all: unknown, never zero and never the old values. `gpsQuality` reuses run search's
server-side classification. A summary of an older algorithm version for the current revision counts as current, as in
run search and run details (ADR-0056 "Consequences"); the summary worker republishes it.

### 6. Capture provenance: not recorded by the server, so not shown as known

The browser chooses device GPS or the simulator per run and keeps that choice only in IndexedDB (ADR-0011, ADR-0047);
no request carries it and no column stores it. The history therefore returns `captureSource: null` and the card says
**Capture source: Not recorded**. Inferring it from point accuracy or cadence would invent provenance. Recording it
would need a column on `runs`, a change to the run-creation contract and a decision about the runs that already exist;
that is a write-path change outside this read-only slice, and is left to its own decision.

### 7. One snapshot, nothing written

The page is a single statement in a `REPEATABLE READ READ ONLY` transaction whose snapshot is taken by its first
statement, before the membership check. A test-only hook (`testOnlyActivityHistoryHooks.beforePageRead`, refused outside
`APP_ENV=test`) commits deletions and an insert after the membership check; the answer is the earlier state and the next
read the later one. With READ COMMITTED that test fails (mutation check). A test pins that reads change no row count of
activities, runs, summaries, the erasure ledger or tombstones. Deletions (manual, GPX, run) are absent from the next read.

### 8. Web

The Activity screen's list becomes **Your activity history**: Source (All, Entered manually, GPX import, Recorded run)
and Activity type selects, a Refresh button, cards with **Source**, the labelled duration (Duration, Elapsed time or
Observed duration), distance, effort and notes for manual entries, GPS quality for a current run summary, and a sentence
instead of metrics for a pending or stale one. Manual entries and imports keep **Delete** with the existing confirmation
and controller; recorded runs have **Run details**, which opens the existing `RunDetailScreen` inside the Activity view
("Back to activity history" returns focus to the button). Run deletion stays in My runs. The form and the GPX import
panel are unchanged and refresh the history after a save, an import or a deletion.

`ActivityHistoryController` (framework-free, as the other Activity controllers) belongs to one organization, one filter
pair and one session: a filter change disposes it, aborting its request; the screen is keyed by session, person and
organization; an answer whose echoed `applied` filters differ from the controller's is refused; the next page uses only
the cursor the server returned; an item repeated across pages is dropped. States: loading, ready, empty (different
wording with filters), error with Retry (the first page) or a kept list with Retry (a later page), outdated cursor with
Refresh, access lost.

## Alternatives considered

- **A SQL view or a materialized table.** Rejected for now: a view adds a migration and a definition to keep in step
  with two tables; a materialized copy needs a job and a staleness rule and duplicates health data that must be erased.
- **Two requests merged in the browser.** Rejected: two snapshots, a merged cursor the server cannot validate, and the
  owner predicate for runs would live in two places.
- **Ordering ties by id only.** Rejected: an activity and a run can share a UUID (both are client-generated); a page
  boundary between them would repeat or skip one.
- **Guessing the capture source.** Rejected (section 6).
- **Deduplicating or adding sources.** Rejected by the product principles: provenance is the server's and sources stay
  side by side.

## Not established

- No load measurement or `EXPLAIN` on a large table. With a `source` or `type` filter, a branch may read past
  non-matching rows of its owner index before it fills a page (bounded by the person's own rows, not by the page size).
- `GET /activities` remains an API endpoint (contract, OpenAPI, integration tests) that no screen calls; retiring it is not
  part of this decision. Its unused web client (`listActivities` in `runner-api.ts`) and `ActivityListController` were
  removed on 2026-11-12.
- Capture provenance for recorded runs is unknown (section 6).
- Browser evidence is Chromium (desktop and a 375 px viewport) only; no Firefox, WebKit or iPhone run.
- No run deletion from the history; no edit; no totals, trends, goals or training load. (Later: per-source activity
  totals over 28 dates are ADR-0089, a separate read on Trends; the history itself still has no totals.)
