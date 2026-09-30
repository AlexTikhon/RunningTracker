# ADR-0036: Tombstone lifetime, reclamation, and the late-retry contract

- Status: accepted; P10.4 implemented and locally verified
- Date: 2026-09-29
- Scope: P10.4 only; resolves D08

## Context

P10.3 (ADR-0035) writes `expires_at = deleted_at + interval '1 year'` on every
tombstone, but the runtime only checks that a tombstone *row exists*, and no
job ever removes one. `expires_at` therefore had no behavioral effect and a
deleted run ID stayed blocked forever, which is exactly the indefinite promise
D08 forbids. Cleanup cannot be a bare `DELETE ... WHERE expires_at <= now()`:
it must be bounded, safe against a concurrent create, owner delete, annual
retention delete, and a second cleanup worker.

Lock namespaces matter here, so they are stated precisely:

- `createRun()` takes `pg_advisory_xact_lock(hashtextextended(orgId || ':' ||
  runId, 0))`.
- Every P10 path (raw purge, summary publication, owner deletion, annual
  retention) takes `pg_advisory_xact_lock(hashtextextended(
  'running-tracker:run-summary:' || orgId || ':' || runId, 0))`.

They are different keys and **do not serialize each other**. This ADR does not
change either, and does not need them to: the design below makes the tombstone
row itself the serialization point.

## Decision

### The contract (answers to the required questions)

1. **What is guaranteed for one year.** From `deleted_at` until
   `expires_at = deleted_at + 1 year`, the deleted run ID is protected against
   resurrection: `PUT /runs/:runId` by the owner returns `410 RUN_DELETED`,
   reads by the owner return `410`, and repeated owner `DELETE` returns `204`.
   Any other member keeps receiving the same `404 RUN_NOT_FOUND` as for a run
   that never existed.
2. **What happens at `expires_at`.** The marker becomes *eligible for
   reclamation*. Nothing else changes at that instant: the runtime does not
   look at `expires_at`. From `expires_at` on, the guarantee is over and is not
   promised. A marker that has not yet been reclaimed still answers `410`, but
   nobody may rely on that.
3. **When the same run UUID can be reused.** Only after the maintenance job
   has actually deleted the marker row. Reuse is decided by the row's absence,
   never by a clock comparison in the request path, so reuse never precedes
   safe reclamation.
4. **A very late `PUT` retry.** Once the marker is reclaimed, `PUT` with that
   ID is an ordinary create and returns `201` with a new empty run. A client
   retrying creation more than one year (plus cleanup delay) after the delete
   is outside the idempotency/replay guarantee and cannot be told apart from a
   fresh create. Clients must not hold a creation retry that long.
5. **A repeated `DELETE` after expiry.** After reclamation the ID is unknown,
   so owner `DELETE` returns `404 RUN_NOT_FOUND`. Idempotent `DELETE` is
   therefore also a one-year-plus guarantee, not an indefinite one. Between
   `expires_at` and reclamation it still returns `204`.
6. **How cleanup is bounded and restart-safe.**
   `app_private.reclaim_expired_run_tombstones(effective_now, batch_limit)` is
   one SQL statement that removes at most `batch_limit` (1..1000; the worker
   uses 500) markers with `expires_at <= effective_now`, oldest first, using the
   existing `run_tombstones_expires_at_idx`. There is no in-process state: a
   crash or rollback leaves every marker in place and a rerun is a no-op for
   anything already gone. The worker is `runTombstoneReclaimOnce`, run by the
   existing `PeriodicRunner` every `RUN_TOMBSTONE_RECLAIM_INTERVAL_MS`
   (default 300 000 ms, max 24 h). One statement per cycle keeps the
   transaction tiny; a large backlog drains at 500 markers per cycle.
7. **Locking that prevents the races.** See "Concurrency" below.
8. **If cleanup is delayed.** Protection only lengthens: the marker keeps
   answering `410`/`204`. A stalled worker can never cause early reuse, and
   there is no user-visible failure. The only cost is a larger table.
9. **Why a time-bounded guarantee.** The database stores one row per deleted
   run. Keeping it forever would be a permanent used-ID registry that grows
   without bound and would silently turn a TTL column into an indefinite
   promise. Bounding the promise to one year (matching SDD §6.1 "up to one
   year") lets storage be reclaimed while stating honestly what a client may
   rely on. A permanent registry is not introduced because no correctness issue
   requires it: a reused ID is a new, independent run with no inherited data.
10. **What remains for P10.5.** The deletion export/log that survives node loss
    and the recovery runbook (D09). Reclamation deliberately drops the marker;
    a durable deletion journal outside this table is P10.5/P12.

### Database changes (`0017_tombstone_expiry.sql`)

- `app_private.reclaim_expired_run_tombstones(timestamptz, integer)`: `STRICT`,
  `SECURITY DEFINER`, `search_path = pg_catalog`, `EXECUTE` revoked from
  `PUBLIC` and `running_tracker_runtime`, granted only to
  `running_tracker_maintenance`. The maintenance role still has **no** table
  privilege on `run_tombstones` (not even `SELECT`), and runtime keeps only
  `SELECT`. The effective time is injected, so boundary tests need no sleeping.
  Non-finite times raise `22007`; a batch limit outside 1..1000 raises `22023`.
- `execute_run_deletion` is replaced (`CREATE OR REPLACE`, same signature, still
  granted to nobody) so its tombstone write is `INSERT ... ON CONFLICT (org_id,
  run_id) DO UPDATE`. See "Marker takeover".
- No table shape, RLS policy, or grant changes; `owner_user_id`, `deleted_at`,
  and `expires_at` keep their meaning, and no coordinates or payload are stored.

### Concurrency

The tombstone row has exactly two writers: `execute_run_deletion` (insert or
takeover) and the reclaim function (delete). Both are `SECURITY DEFINER`
functions and both touch the row under ordinary row locks.

- **Reclaim vs reclaim.** The candidate scan is `FOR UPDATE SKIP LOCKED`, so a
  second worker skips markers another transaction holds instead of waiting or
  double-counting. The `DELETE` repeats `expires_at <= effective_now` on the
  locked row version.
- **Reclaim vs create (`PUT`).** `createRun` reads the marker at READ COMMITTED.
  While a reclaim is uncommitted the marker is still visible, so `PUT` returns
  `410`; once the reclaim commits the marker is gone and `PUT` creates the run.
  Each outcome is a valid serial order. Nothing can insert a marker between the
  create's check and its `INSERT INTO runs`, because a marker is only written
  when a run exists and the create is serialized against other creates by its
  own advisory lock. The two lock namespaces therefore do not need to be merged.
- **Reclaim vs owner/annual delete of the same ID.** A deletion normally finds
  no marker, because a live run and a marker do not coexist. The one exception
  is documented under "Marker takeover". There, the deletion's upsert either
  waits for an uncommitted reclaim and then inserts a fresh marker, or updates
  the row first, in which case the reclaim skips it (`SKIP LOCKED`) or, if it
  raced past the lock, re-evaluates `expires_at` on the updated row and does not
  match. A reclaim can therefore never delete a marker that belongs to a newer
  deletion, and a newer deletion can never lose its marker.
- **Repeated owner `DELETE` around expiry.** `delete_run_as_owner` looks up the
  marker without locking it: it answers `204` while the row exists and `404`
  once it is gone. Either answer linearizes against the reclaim.
- **Deadlocks.** Deletion locks advisory → organization → run → tombstone row;
  reclaim locks only tombstone rows and waits on nothing else. The tombstone row
  is last in every path, so no cycle exists. The advisory lock ordering
  established in ADR-0035 is unchanged.
- **Why no advisory lock for reclaim.** Row locks already give a total order on
  the only shared state, and taking the per-run advisory lock would add a
  waiting edge with no protection benefit.

### Marker takeover

Run IDs are unique per organization, but the runtime tombstone `SELECT` policy
is deliberately owner-scoped (ADR-0006), so a different member's `PUT` cannot
see another member's marker and may create a live run under a tombstoned ID.
P10.3's plain `INSERT` would then fail with a primary-key violation when that
run is deleted, and annual retention would fail on the same candidate every
cycle. `execute_run_deletion` now lets the newer deletion take over the marker:
`owner_user_id` and `deleted_at` follow the new deletion and
`expires_at = GREATEST(existing, new)`, so a takeover never shortens protection.
This does not change what `PUT` reveals to other members: they still cannot
observe the marker, and no error distinguishes it. Closing that cross-member
reuse entirely would need cross-owner visibility, which ADR-0006 rejects, so it
stays an accepted limitation (below).

### API

`isTombstoned()` keeps its existence check and now documents why it ignores
`expires_at`. HTTP errors are unchanged and carry no age, owner, deletion time,
or expiry.

## Consequences

- Run-ID reuse is possible, but only after the marker has been reclaimed at
  least one year after deletion.
- The guarantee is at least one year and at most one year plus cleanup delay;
  clients that need exact behavior must not depend on the upper bound.
- `RUN_TOMBSTONE_RECLAIM_INTERVAL_MS` adds a fifth maintenance runner on the
  existing pool (`RUN_SUMMARY_CONCURRENCY + 2` connections). Each cycle is a
  single short statement, so pool waits stay short; it is not resized here.
- The maintenance clock is trusted like the other P10 jobs. A clock set far
  into the future would make markers eligible early; a DB-side clock guard would
  break the injected-time tests and is left to P11/P12 operations.

## Limitations

- After reclamation there is no record that the ID was ever used (by design).
  A durable deletion journal is P10.5/D09.
- Cross-member ID reuse within the window remains possible (see "Marker
  takeover"); it is neither a leak nor a resurrection of the original owner's
  run, and deletion of the reused run now works.
- Idempotent `DELETE` and creation-retry protection are both bounded by the
  same window, not indefinite.

## Verification

Real separated-role PostgreSQL/PostGIS coverage in
`apps/api/test/run-tombstone-expiry.integration.test.ts`, plus unit coverage in
`run-tombstone-reclaim.spec.ts` and `environment.spec.ts`:

- privilege/catalog matrix: maintenance-only `EXECUTE`, no runtime/PUBLIC
  execute, no direct tombstone `DELETE`/`UPDATE`/`INSERT` for runtime, no table
  privilege for maintenance, `SECURITY DEFINER`, fixed `search_path`, owner role;
  direct `DELETE` and the capability are rejected with `42501`;
- exact boundary with injected time: `expires_at - 1 ms` keeps the marker,
  `expires_at` and `expires_at + 1 ms` reclaim it;
- one-year `expires_at` for owner and annual deletion;
- HTTP contract: `410`/`204` inside the window, still protected one millisecond
  before expiry, reclaim at expiry, then `404` on `DELETE`, `201` on `PUT`, the
  ordinary active-run `409`s, and a fresh full window for a later deletion;
- delayed cleanup keeps the marker authoritative and hidden from other members;
- bounded 500-marker batches, oldest-first order, function-level limits, empty
  and repeated cycles, and rollback leaving every marker in place;
- two workers never reclaim the same marker (deterministic via an uncommitted
  claim, and concurrently);
- reclaim vs create ordered by an uncommitted reclaim (no resurrection window);
- takeover: a deletion waiting behind an uncommitted reclaim inserts a fresh
  marker; a reclaim never removes a marker a newer deletion just extended;
  takeover never shortens expiry; annual retention does not wedge.
