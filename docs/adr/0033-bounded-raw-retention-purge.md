# ADR-0033: Bounded raw retention purge and summary serialization

- Status: accepted; P10.1 implemented and locally verified
- Date: 2026-09-29
- Scope: P10.1 only

## Context

Raw points must become unavailable before physical deletion starts, while the
published summary, display geometry, history grants, and archive epoch survive.
Deletion can span several transactions, so process memory cannot be the recovery
record. At the same time, the P06 summary worker calculates from raw points after
claiming the per-run transaction advisory lock
`running-tracker:run-summary:<orgId>:<runId>`. Purge must not let that calculation
observe a partially deleted point set or publish one.

P10.1 provides the state-transition primitive only. Retention age, upload-window
closure, and current-summary eligibility belong to P10.2 and must not be inferred
inside this operation.

## Decision

1. Forward migration `0014_raw_retention_purge.sql` adds
   `app_private.purge_run_raw_points_batch(org_id, run_id, batch_limit)`. It is a
   `SECURITY DEFINER` capability with `search_path = pg_catalog`; only the
   maintenance role may execute it. The runtime role also loses its legacy
   column-level `UPDATE(raw_state)` grant.
2. The function accepts one explicit run and a limit from 1 through 1,000. The
   Node maintenance boundary always supplies 1,000, matching the existing bounded
   page scale while limiting row locks, WAL, and rollback work per transaction.
   P11 may tune this value from measurements.
3. Every invocation first takes the existing per-run summary transaction advisory
   lock, then locks the run row. The run must exist and be finished. Lock order is
   therefore summary/purge advisory lock before run row; ingestion only takes the
   run row and cannot add points after the committed `purging` boundary.
4. An `available` run is updated to `purging` before the deterministic `seq`-ordered
   delete statement executes. A `purging` run resumes directly. At most one batch
   is deleted; there is no internal completion loop.
5. If points remain, the transaction returns `purging` with `has_more = true`. If
   none remain, it updates the same locked run to `purged` and returns completed.
   A `purged` retry deletes nothing and returns the same completed state.
6. The summary claimant is replaced forward-only to revalidate status, raw state,
   source revision, and staleness after obtaining the advisory lock. An already
   claimed summary transaction finishes calculation/publication before purge can
   acquire the lock. After purge acquires it and changes state, no production
   claimant can start calculation. Existing publication checks still reject any
   independently supplied result once raw state is not `available`.
7. Purge changes only `runs.raw_state` and bounded rows in `run_points`. It neither
   deletes nor rewrites `run_summaries`, run grants, or the run itself, and it does
   not create a tombstone or advance `organizations.archive_revision`; the visible
   archive dataset is unchanged.
8. A committed batch is the durable progress record. Transaction rollback restores
   both state and points. A new process resumes solely from `raw_state` and the
   remaining rows.

## Consequences

- A run with at most one batch may move from externally visible `available` to
  `purged` in one commit, but the internal `purging` update still precedes deletion.
- A multi-batch run exposes no raw remainder after the first commit even though
  rows physically remain; existing authorized HTTP paths return
  `410 RAW_HISTORY_UNAVAILABLE`, while authorization-safe `404` behavior remains.
- Purge may wait for one in-flight summary transaction or ingestion transaction;
  this is the intentional correctness boundary rather than a best-effort race.
- P10.1 deliberately does not decide that a run is retention-eligible. P10.2 adds
  seven-day/upload-window/current-summary selection and scheduling. Owner/yearly
  deletion, tombstones, tombstone expiry, and the external deletion journal remain
  P10.3-P10.5/P12.

## Verification

- Unit tests validate the typed one-call Node boundary, fixed batch limit, state
  mapping, and fail-closed handling of malformed database results.
- Real separated-role PostgreSQL/PostGIS tests cover argument/state rejection,
  privileges, bounded multi-batch progress, a new-client restart, rollback,
  idempotent retry, concurrent purge attempts, raw HTTP denial during partial
  deletion, archive/summary/grant survival, and an unchanged archive revision.
- Advisory-lock barriers prove both concurrency orders: an already-claimed summary
  publishes the complete three-point result before purge proceeds, while a
  partially purged run cannot be claimed and its independently calculated partial
  result cannot publish.
