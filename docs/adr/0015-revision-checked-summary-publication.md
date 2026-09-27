# ADR-0015: Revision-checked atomic summary publication

- Status: accepted; P06.4 implemented and locally verified
- Date: 2026-09-26
- Scope: P06.4 only

## Context

P06.1–P06.3 can calculate and simplify a summary for a fixed run revision, but
the expensive calculation must not hold mutation locks. Late point ingestion,
run deletion, duplicate workers, and organization archive invalidation can all
race with publication. The maintenance login must also remain unable to write
tables directly.

## Decision

1. `app_private.find_stale_run_summaries(limit)` exposes only finished,
   raw-available runs whose summary is missing, behind `data_revision`, uses an
   old algorithm version, or fails the current version's quality shape.
   Discovery does not reserve work or take mutation locks; distributed claiming
   and concurrency limits remain P06.5.
2. One worker cycle selects at most one candidate. A single materialized SQL
   statement calculates metrics/chains for that `source_revision`, simplifies
   display geometry, and then invokes the publication capability. Statement
   MVCC provides the short calculation snapshot without holding a run lock.
3. `app_private.publish_run_summary(...)` locks the organization first and the
   run second. Under those locks it requires the run to still exist, remain
   finished and raw-available, have the exact source revision, have no
   tombstone, and still lack a current summary. Failed checks discard the
   result without a write or archive revision change.
4. A successful publication upserts `run_summaries` and increments
   `organizations.archive_revision` in the same transaction. Concurrent
   duplicate publishers therefore produce one summary and one archive change.
5. The publication capability validates the exact v1 `QualityStats` key set,
   scalar types, nonnegative integer count range, and boolean
   `insufficientData`. The table retains its version-agnostic object check so
   old and future algorithm versions are not coupled to the v1 shape.
6. Discovery and publication are `SECURITY DEFINER` capabilities granted only
   to the maintenance role. That role keeps no direct read/write privilege on
   `runs`, `run_points`, `run_summaries`, organizations, or tombstones.

## Consequences

- A point committed while calculation is running advances `data_revision`; the
  old result waits for the run lock and is then rejected.
- A deleted run cannot be recreated because publication never inserts a parent
  and rejects a missing run after acquiring the organization lock.
- The process-local runner is non-overlapping and the maintenance pool has one
  connection, but multi-process work claiming, fairness, and throughput limits
  remain explicitly P06.5.

## Verification

- Real PostgreSQL/PostGIS integration covers candidate filtering, role
  privileges, exact quality validation, end-to-end calculation/simplification,
  atomic archive advancement, a blocked-ingestion revision race, deletion, and
  duplicate concurrent publishers.
- The disposable test database applied migrations `0000`–`0011` from empty
  history and skipped the unchanged history on rerun.
