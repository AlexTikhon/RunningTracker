# ADR-0035: Owner deletion and annual retention with atomic tombstone and archive revision

- Status: accepted; P10.3 implemented and locally verified
- Date: 2026-09-29
- Scope: P10.3 only

## Context

P10.1/P10.2 bound raw-point purge and its seven-day eligibility, but a whole
run — including its published summary, shares, and commands — still had no
deletion path. Two entry points must exist: an explicit `DELETE` by the run
owner, and an automatic annual deletion of finished runs one year past
`finished_at` (SDD section 12). Both must, in one transaction: validate
authorization/eligibility, serialize against concurrent run processing,
create a `run_tombstones` marker, remove every run-owned row, and advance
`organizations.archive_revision` exactly once. Migration `0013` already adds
an `AFTER DELETE` trigger on `run_summaries` that advances
`archive_revision`, and a naive explicit second increment for the run itself
would double-count whenever a summary existed.

## Decision

1. Forward migration `0016_run_deletion.sql` adds a shared, non-`SECURITY
   DEFINER` primitive, `app_private.execute_run_deletion(org_id, run_id,
   owner_user_id, effective_now)`. Like `run_summary_quality_stats_valid`
   (migration `0011`), it has no grants of its own and only ever runs inside
   the calling `SECURITY DEFINER` function's owner context. It assumes its
   caller already holds the per-run advisory lock and locked
   `organizations`/`runs` rows and has already confirmed authorization or
   retention eligibility.
2. Two `SECURITY DEFINER` wrappers call that shared primitive with separate
   authorization rules: `app_private.delete_run_as_owner(org_id, run_id,
   requesting_user_id, effective_now)` is granted only to
   `running_tracker_runtime`; `app_private.delete_run_for_retention(org_id,
   run_id, effective_now)` is granted only to `running_tracker_maintenance`.
   Neither role receives direct `DELETE` on `runs`, `run_points`,
   `run_summaries`, `run_commands`, or `run_tombstones`; `execute_run_deletion`
   itself is revoked from `PUBLIC`, runtime, and maintenance alike.
3. Lock order is the shared per-run advisory lock
   `running-tracker:run-summary:<orgId>:<runId>` (the same namespace P10.1/
   P10.2 use for raw purge and summary publication), then
   `organizations` `FOR UPDATE`, then `runs` `FOR UPDATE` — the same
   organization-before-run order ADR-0030 and `publish_run_summary`
   (ADR-0015) already use. Owner deletion uses the blocking
   `pg_advisory_xact_lock` because a caller may legitimately wait for an
   in-flight purge or summary publication to finish; annual-retention
   candidate selection uses `pg_try_advisory_xact_lock` so one blocked run
   never stalls an unrelated maintenance scan. Because every writer that
   touches `organizations.archive_revision` (deletion, ACL changes, tile
   reads) takes that row before any run-level lock, no cycle exists between
   deletion and ingestion/commands (which never lock `organizations`) or
   share mutation/tile reads (which lock `organizations` first, exactly like
   deletion).
4. `execute_run_deletion` inserts the tombstone first, using the already
   confirmed real owner (never caller-controlled) and the injected clock for
   `deleted_at`. It then deletes `run_summaries` for the run before
   `run_shares`, then finally deletes the `runs` row (cascading
   `run_points`/`run_commands`, which carry no archive-revision trigger). If
   no summary existed, it performs one explicit `archive_revision + 1`
   update itself.
5. This ordering is deliberate, not incidental: deleting `run_summaries`
   first lets the existing migration-`0013`
   `advance_archive_revision_for_summary_delete` trigger perform the single
   required increment when a summary existed. Deleting `run_shares` next
   means its own `advance_archive_revision_for_history_share` trigger
   observes that the summary row is already gone and therefore adds no
   second increment. Leaving both deletes to unordered `ON DELETE CASCADE`
   from the run row would make their relative trigger firing order
   unspecified and risk double-incrementing when a run had both a summary
   and a history-share grant. The explicit two-step order, plus the explicit
   increment only in the no-summary branch, guarantees exactly one
   increment per deleted run in both cases without disabling or
   reimplementing the existing trigger.
6. `app_private.delete_run_as_owner` is idempotent for the real owner: it
   locks `runs` filtered by `org_id`, `run_id`, and `user_id =
   requesting_user_id` (the same owner-scoped `WHERE` pattern
   `ingestRunPoints`/`applyRunCommand` already use). If that row is missing,
   it distinguishes a repeat delete from every other case by checking
   whether a tombstone already exists for this run *with this caller's user
   ID as `owner_user_id`*; only then does it report `already_deleted`
   (mapped to `204`). A run owned by someone else, a run that never
   existed, and a run tombstoned under a different owner all report
   `not_found` (mapped to `404 RUN_NOT_FOUND`) — an unrelated caller cannot
   distinguish "never existed" from "someone else deleted it."
7. `app_private.claim_run_deletion_candidate(effective_now, scan_limit)`
   scans at most 1,000 finished runs whose `finished_at` is at least one
   year old, oldest first, taking the same per-run advisory lock
   non-blockingly and revalidating status/age before returning a candidate
   — mirroring `claim_run_raw_purge_candidate` (ADR-0034). Selection is an
   optimization only: `delete_run_for_retention` independently reacquires
   the advisory lock and organization/run locks and re-checks `status =
   'finished'` and `finished_at <= effective_now - interval '1 year'` before
   deleting, raising `55000` if a claimed run is somehow no longer eligible.
8. `apps/api/src/maintenance/run-retention-delete.ts` follows the existing
   `run-raw-purge.ts` shape: one connection, one transaction, one claim, one
   deletion, committed or rolled back together, wired through the existing
   `PeriodicRunner` with a new `RUN_RETENTION_DELETE_INTERVAL_MS` (default
   60 seconds, validated and documented like the sibling intervals) rather
   than a second scheduling framework. `runId`/`orgId` are not logged in
   ordinary cycles beyond the existing structured result the caller may log,
   matching the raw-purge precedent of not printing identity in warnings.
9. The tombstone's `expires_at` is `deleted_at + interval '1 year'`, the
   annual period the SDD already documents for tombstone retention
   (`docs/SDD.md` section 6.1: "the tombstone... is retained for up to
   one year"). Cleanup, reuse after expiry, and the exact post-expiry `PUT`
   contract remain P10.4 (D08); this stage only assigns the stored value.
10. `PUT /runs/:runId` already rejects a tombstoned run ID with `410
    RUN_DELETED` by querying `run_tombstones` under RLS scoped to
    `owner_user_id = current_user_id()` (ADR-0006); P10.3 changes nothing
    there and confirms the existing behavior still holds after both
    deletion paths.

## Consequences

- Owner `DELETE` and annual retention share one deletion algorithm and
  differ only in how they establish authorization/eligibility before
  calling it, per the shared-primitive requirement: neither caller can
  reach the other's authorization path, and neither can bypass eligibility
  merely by knowing a run ID.
- A deletion may wait behind an in-flight raw purge or summary publication
  for the same run (bounded by their own transaction lengths) but cannot
  deadlock with them, ingestion, commands, or share mutation/tile reads,
  because every path that could contend on both `organizations` and a `runs`
  row locks them in the same order.
- Cache correctness reuses the existing ADR-0030 mechanism unchanged: the
  new archive revision is part of every cache key, so old entries become
  unreachable and expire under the existing 32 MiB/five-minute bounds; nested
  tile reads racing a deletion behave exactly as ADR-0030 already describes
  for any other epoch writer.
- D08 (tombstone-expiry replay contract) remains explicitly unresolved.
  P10.3 assigns tombstones a one-year `expires_at` but implements no
  cleanup, no reuse-after-expiry path, and no post-expiry `PUT` behavior.

## Verification

- Real separated-role PostgreSQL/PostGIS integration coverage: privilege
  matrix (runtime/maintenance/PUBLIC execute grants and the absence of
  direct table `DELETE`), full cascade of an owned run with a summary and
  exactly one archive-revision increment, the same for a run without a
  summary, idempotent repeated and concurrent-duplicate owner deletes,
  denial for a non-owner and a history-share grantee without leaking
  tombstone existence, `410 RUN_DELETED` on a subsequent `PUT`, stale
  archive-revision tile rejection after deletion, transactional rollback
  leaving the run/summary/tombstone untouched, deletion serializing behind
  an in-flight raw purge and an in-flight claimed summary on the shared
  advisory lock, and the one-year eligibility boundary (`55000` one instant
  before, eligible exactly at and after), oldest-first candidate ordering,
  an idle cycle, and two concurrent maintenance workers never deleting the
  same run twice.
- Unit coverage for the maintenance boundary: claim/delete/commit ordering,
  idle mapping, malformed candidate/result rejection, unknown-commit-outcome
  client destruction, and rollback on a failed claim.
