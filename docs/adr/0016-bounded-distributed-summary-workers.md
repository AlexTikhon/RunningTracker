# ADR-0016: Bounded distributed summary workers

- Status: accepted; P06.5 implemented and locally verified
- Date: 2026-09-27
- Scope: P06.5 only

## Context

P06.4 publishes a revision-checked summary safely, but uncoordinated workers can
still calculate the same stale run concurrently. Holding an organization or run
row lock during PostGIS calculation would prevent duplicate work at the cost of
blocking ingestion, lifecycle changes, or unrelated publication. A process-only
queue would not coordinate multiple API replicas.

## Decision

1. `app_private.claim_stale_run_summary(scanLimit)` scans the existing stable
   candidate order and acquires one transaction-scoped PostgreSQL advisory lock
   derived from the organization/run identity. Already claimed candidates are
   skipped. A hash collision can only serialize unrelated work; it cannot affect
   correctness.
2. One worker transaction owns the claim through calculation and publication.
   The transaction uses `READ COMMITTED` statement snapshots and holds no
   organization/run row lock while calculating. Commit or rollback releases the
   claim automatically, including process/connection failure recovery.
3. Publication remains the only operation that takes row locks, in the existing
   organization then run order. Revision/state/tombstone checks remain the final
   correctness fence; the advisory claim is a work-deduplication mechanism.
4. `RUN_SUMMARY_CONCURRENCY` is configurable from 1 through 8 and defaults to 2.
   Each periodic cycle starts exactly that many workers and waits for every one
   to settle before the next cycle can be scheduled. The maintenance pool has
   one additional connection so auto-finish is not structurally excluded by a
   full summary batch.
5. A failed worker does not cancel its siblings. The batch reports failure only
   after all workers settle, preventing a new periodic cycle from overlapping
   still-running work.

## Consequences

- Multiple processes sharing the database skip one another's active claims
  without a new durable queue table or lease cleanup job.
- Throughput is bounded per process; aggregate deployment concurrency is bounded
  operationally by replica count. PostgreSQL claims still deduplicate the same
  run across that aggregate.
- The transaction stays open during calculation, but it holds only an advisory
  claim and uses no long-lived MVCC snapshot or row lock.
- The 1,000-candidate scan bound can temporarily leave deeper work for a later
  cycle when every scanned candidate is claimed. It prevents an unbounded scan.

## Verification

- Unit coverage proves configuration bounds, transactional commit/rollback and
  unknown-commit connection disposal, exact worker fan-out, outcome aggregation,
  and all-settled failure behavior.
- Real PostgreSQL/PostGIS coverage proves role grants, distinct claims across
  simultaneous transactions, no third claim when all candidates are owned,
  rollback release, and two-worker publication without duplicate summaries.
