# ADR-0034: Raw retention eligibility and scheduler

- Status: accepted; P10.2 implemented and locally verified
- Date: 2026-09-29
- Scope: P10.2 only

## Context

P10.1 introduced a restart-safe one-run purge primitive, but deliberately did
not decide when an `available` run could enter `purging`. The production worker
must not trust a candidate scan across a race with summary publication or late
upload. It also needs to resume committed partial work before starting more
purges and make a missed retention target visible without exposing run identity
or coordinates.

## Decision

1. Migration `0015_raw_retention_eligibility.sql` replaces the three-argument
   purge capability with
   `purge_run_raw_points_batch(org_id, run_id, batch_limit, effective_now)`.
   The maintenance process supplies one finite injected UTC instant for both
   selection and mutation.
2. An `available` run can enter `purging` only when it is finished, its
   `finished_at + 7 days` target has been reached, its 24-hour upload window is
   strictly closed, and its summary matches the run data revision, current
   algorithm version, and quality-statistics schema. These predicates are
   revalidated after the shared summary/purge advisory lock and run-row lock.
3. `claim_run_raw_purge_candidate(effective_now, scan_limit)` scans at most
   1,000 candidates and uses a non-blocking transaction advisory claim. It
   prioritizes committed `purging` runs, which are already past the irreversible
   logical boundary, then orders eligible new work by `finished_at`,
   organization, and run ID.
4. A committed `purging` run resumes without rechecking time or summary. Its
   durable state and remaining point rows are still the recovery record. A
   `purged` explicit retry remains idempotent.
5. `runRawPurgeOnce` owns one transaction, one candidate, and one P10.1 batch.
   A settled periodic runner invokes it every 60 seconds by default; cycles do
   not overlap. The maintenance pool reserves one connection beyond the summary
   workers for auto-finish and one for raw purge.
6. If no candidate is claimable,
   `has_overdue_raw_purge_summary_blocker(effective_now)` reports only whether
   an upload-closed run is overdue because its summary is missing or stale. The
   process emits an identity-free warning. Structured metrics and alert routing
   remain P11.1.
7. Candidate, blocker, and purge functions remain `SECURITY DEFINER` with
   `search_path = pg_catalog`; only the maintenance role may execute them. The
   maintenance role still has no direct application-table DML.

## Consequences

- Selection is an optimization; eligibility remains authoritative inside the
  mutating capability, so a direct or stale candidate cannot bypass retention.
- At exactly seven days the retention age predicate is satisfied; the upload
  window is already strictly closed. Before either boundary, raw state and
  points remain unchanged.
- A failed or stale summary delays deletion and produces a warning rather than
  silently discarding raw history. Summary workers can repair the blocker in a
  later cycle.
- One large run can require multiple cycles, intentionally bounding row locks,
  WAL, and rollback work. P11 may tune the interval or batch size from measured
  backlog and transaction latency.
- Owner deletion, annual retention, tombstones, archive revision changes,
  tombstone expiry, and the external deletion journal remain P10.3-P10.5.

## Verification

- Unit tests cover the fixed 1,000-row call, transactional claim/commit,
  idle/blocked outcomes, malformed results, unknown commit outcome, and invalid
  clocks.
- Real separated-role PostgreSQL/PostGIS tests cover function privileges,
  the exact upload/age boundary, missing-summary blocking, eligible-only
  selection, durable resume, rollback, concurrent purges, summary serialization,
  raw HTTP denial, and archive/grant preservation.
