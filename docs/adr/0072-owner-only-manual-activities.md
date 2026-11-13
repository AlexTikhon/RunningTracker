# ADR-0072: Owner-only manual activities

- Status: accepted; implemented and verified locally. Amended by [ADR-0073](0073-erasure-ledger-and-idempotent-activity-creation.md):
  deletions are recorded in an erasure ledger and replayed after a restore (section 4's limitation is closed for the
  recovery path), and creation takes a per-form-session idempotency key. Amended by
  [ADR-0086](0086-gpx-activity-import.md): a second, server-owned source `gpx` for GPX imports (migration 0041). Amended by
  [ADR-0091](0091-tcx-activity-import.md): a third source `tcx` for TCX imports (migration 0042).
- Date: 2026-11-06
- Amends: nothing. Runs, run points, summaries, ingestion, the GPS algorithm and its version, SSE, tiles, retention
  and AI search are unchanged.
- Scope: migration 0025, `packages/contracts`, `apps/api/src/activities`, `apps/web`, tests, docs. No new dependency.
  Step 1 of the [product direction](../product-direction.md).

## Context

The project resumes as a broader activity, health and nutrition tracker. Everything it records today is a GPS run
captured live. The first slice of the data foundation needs a generic, manually entered activity (a ride, a swim, a
strength session, a run recorded elsewhere) that later import, analytics and AI steps can build on. It is health
data, so it must be visible to its owner only, from the first row, without depending on run sharing.

## Decision

### 1. One table, owner-only

`activities (org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, source, created_at)`, primary
key `(org_id, id)` with a client-generated UUID like runs, and the same tenant-bound owner key:
`FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE RESTRICT`.

Database constraints (named, so a violation is identifiable):

| Column | Rule |
|---|---|
| `type` | one of `run`, `walk`, `ride`, `hike`, `swim`, `strength`, `other` |
| `started_at` | finite and not before `2000-01-01T00:00:00Z` |
| `duration_s` | integer, 1 to 172 800 (48 hours) |
| `distance_m` | NULL, or a finite number from 0 to 1 000 000 (PostgreSQL orders `NaN` above every number, so the upper bound excludes it; an explicit `<> 'NaN'` states it anyway) |
| `rpe` | NULL or an integer from 1 to 10 |
| `notes` | NULL or 1 to 1000 characters |
| `source` | only `manual`; import sources are added later by a migration that widens this CHECK |
| `created_at` | finite, set by the server's injected clock |

The rule that `started_at` is not more than 24 hours after server time is **not** a CHECK. `now()` is not immutable:
a CHECK using it would be evaluated against the moment a row is inserted, and a dump restored later would revalidate
old rows against a different clock. It lives in the service, against the injected `Clock`, with the same 24-hour
skew allowance as runs. The static 2000-01-01 lower bound is both a contract rule and a CHECK.

Row-level security has exactly three policies, all `TO running_tracker_runtime`, all requiring
`org_id = app_private.current_org_id() AND user_id = app_private.current_user_id() AND
app_private.has_active_membership()`: SELECT, INSERT (WITH CHECK) and DELETE. The table is revoked from PUBLIC, the
runtime role and the maintenance role, then the runtime role gets `SELECT, INSERT, DELETE` only. There is no UPDATE
grant or policy (no edit endpoint exists), no SECURITY DEFINER helper and nothing for the maintenance role. A coach,
another member, a member of another organization or an inactive member reads, inserts and deletes nothing, whatever
run sharing grants they hold: activities never consult `run_shares`. The SQL in the service also states
`user_id = <session user>`, so ownership does not rest on the policy alone.

### 2. HTTP API

Under `/api/orgs/{orgId}/activities`, session-authenticated, every request inside
`withAuthenticatedTenantTransaction` (membership rechecked in the transaction, RLS in force, runtime role). Mutations
use the existing session, Origin and CSRF protection and require JSON. Request and response schemas are strict Zod
objects in `packages/contracts`; unknown fields are a 400. Reads answer `Cache-Control: no-store`.

- `PUT /{activityId}` creates idempotently. Body: `type`, `startedAt`, `durationS`, and optional or null
  `distanceM`, `rpe`, `notes` (omitted and null are the same value). `201` with the activity when created; `200` with
  the stored activity when the same id is sent again with an equal payload; `409 ACTIVITY_CONFLICT` when the id
  already holds a different payload. Payload equality is decided by PostgreSQL column by column
  (`started_at = $::timestamptz`, `IS NOT DISTINCT FROM` for the nullable fields), so equal instants written with
  different fraction digits are equal. The insert is `ON CONFLICT (org_id, id) DO NOTHING` followed by a read of the
  owner's row, which also settles two concurrent identical requests to one row.
- `GET /` lists the caller's own activities, newest first (`started_at DESC, id DESC`), `limit` 1 to 50 (default
  20), keyset `cursor`.
- `GET /{activityId}` reads one of the caller's activities, otherwise `404 ACTIVITY_NOT_FOUND`.
- `DELETE /{activityId}` answers `204` in every case: deleted now, already deleted, never existed, or someone else's.

**Why a PUT on another member's id is a 404 and not an existence oracle.** Another member's row is invisible to the
caller, so the insert does nothing and the following read finds no row of theirs: the answer is `404
ACTIVITY_NOT_FOUND`, the same as runs. That differs from a fresh id (201), so in principle a 404 says "this id is
taken in this organization". It reveals nothing in practice: ids are random version-4 UUIDs created by the owner's
client (122 random bits), so a caller can only learn about an id they already know, and the 404 carries no owner,
type, time or content. The alternative, answering as if created, would claim a write that never happened.

**Why DELETE is always 204.** Without tombstones (see 4) the server cannot tell "already deleted by you" from "never
existed" or "someone else's". Answering all of them identically makes a retry after a lost response safe, and the
answer leaks nothing. The cost: a client that deletes a mistyped id is told it succeeded, which is true in the sense
that no such activity of theirs exists afterwards.

**Cursor.** Base64url JSON `{ version: 1, startedAt (microseconds), activityId, context }`, where `context` is a
SHA-256 digest of `['activities', 1, userId, orgId]`. A tampered, malformed, foreign-person or foreign-organization
cursor is `400 INVALID_CURSOR`. It is not signed, for the same reason as the run search cursor (ADR-0056): forging one
only moves a keyset position inside the caller's own rows, and nothing in it is trusted for authorization.

### 3. Web

An **Activity** tab beside Runner, Coach and Archive, rendered only for a ready session with a selected organization
and keyed by session lifetime, person and organization like Archive. A form (type, local date and time, duration as
hours/minutes/seconds, optional distance in km or mi, optional RPE, optional notes) and a list of the person's recent
activities with "Load more" and a confirmed delete.

Framework-free controllers own the requests: one list controller and one delete controller per scope, and a
submission that binds a client UUID to one payload. An answer that arrives after the session ended, after the person
or organization changed, or after the controller was disposed is dropped. After an unknown outcome (5xx, timeout,
network), Save again sends the same id and the same payload, which the server treats as idempotent; editing the form
first starts a new id and the screen says the previous attempt may already be saved. Distances are typed as decimals
with at most three fraction digits and converted to metres with integer arithmetic (the international mile is exactly
1609.344 m), as ADR-0056 does for search bounds.

### 4. Hard delete, no tombstones or journal

`DELETE` removes the row. No tombstone, journal or restore re-application exists for activities.

**Consequence: a restored backup can resurrect a deleted activity.** The restore tooling reapplies run deletions and
narrowed access from their journals (ADR-0037, ADR-0045); an activity deleted after the backup was taken comes back
when that backup is restored, and nothing removes it again. This is acceptable only for a local demo with synthetic
data. It **must be revisited before real participants record health data**, either with a deletion journal and
restore re-application like runs, or with an explicit retention/restore policy.

### 5. Relation to runs

`activities.type = 'run'` overlaps with the `runs` table: a GPS run captured by the Runner view lives in `runs`, a
manually entered run lives in `activities`, and nothing links or deduplicates them. Step 1 has **no dual-write** (a
finished GPS run does not create an activity) and no automatic link. The design keeps room for a later nullable run
reference; the column is deliberately not added now. A **unified read model** (a SQL view or a union over runs with
their published summaries and activities) is planned for the analytics phase, which is where double counting has to
be resolved.

## Alternatives considered

- **Reuse `runs` with nullable GPS state.** Rejected: runs carry a lifecycle, writer fencing, points, summaries,
  tiles and retention that a manual entry does not have, and changing them is out of scope.
- **A JSONB payload column.** Rejected: analytics must be SQL over typed columns with database-enforced ranges.
- **A CHECK against `now()` for future starts.** Rejected for the dump/restore reason in 1.
- **404 for a repeated DELETE.** Rejected: without tombstones it cannot be told apart from a wrong id, so a client
  could not retry safely.
- **Tombstones now.** Deferred deliberately to keep step 1 small; the limitation is recorded in 4.

## Not established

- No tombstone, deletion journal or restore re-application: a restored backup can resurrect deleted activities (4).
- **No per-user cap on the number of activities.** Every row is bounded in size and each request in rate only by the
  existing generic limits; a person can create any number of rows.
- No edit endpoint, no UPDATE grant; a mistake is corrected by delete and re-create.
- No import (GPX/TCX/FIT), no link to or deduplication with runs, no unified read model, no analytics or charts.
- No coach or other-member visibility of any kind, and no per-category grant mechanism.
- No load measurement or `EXPLAIN` on a large table; the list is served by the owner index
  `(org_id, user_id, started_at DESC, id DESC)` by design argument only.
- Browser evidence is Chromium only; no Firefox, WebKit or mobile run of the Activity tab.
