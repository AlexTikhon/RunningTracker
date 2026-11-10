# ADR-0073: Erasure ledger for owner-only health data, and idempotent activity creation

- Status: accepted; implemented and verified locally
- Date: 2026-11-06
- Amends: ADR-0072 sections 2 and 4 (the hard-delete limitation is closed for the recovery path; the create contract
  gains a required idempotency key). RLS semantics of ADR-0072 are unchanged: the 32 access tests pass unmodified.
- Amended by: [ADR-0074](0074-daily-check-in-local-date-and-put-replace.md), which uses the extension point for daily
  check-ins (`daily_metric`) and makes activity creation instants come from the database clock (migration 0029), so the
  "frozen or repeating application clock" item below no longer applies to activities created through the API.
- Scope: migrations 0026 and 0027, `apps/api` (maintenance export, restore replay command, activity service, restore
  drill), `packages/contracts`, `apps/web`, tests, docs. No new dependency and no new infrastructure service.

## Context

The Step 1 report left two data-integrity risks before more health data (daily metrics) is added:

1. **Deletion does not survive a restore.** Activities are hard-deleted without a tombstone. Restoring a backup taken
   before a DELETE brings the activity back, and nothing removes it again. For health data that is a privacy failure.
2. **A duplicate after an unknown outcome.** The activity id makes one exact payload idempotent. If a save's outcome is
   unknown and the person edits the form and saves again, the client must use a new id, and if the first save had
   gone through, two activities exist.

## Decision A: an erasure ledger that leaves the database host

### What is recorded

`erasure_ledger (ledger_seq, entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)`. Identifiers
and timestamps only; no activity content (type, times, distance, effort or notes). `record_created_at` is not content:
it names the exact *version* of the record that was erased. Activities have no tombstone, so a deleted id can be
used again; replay must not delete a later record that reused it. Comparing creation instants for equality needs no
clock comparison between the erasure and the creation, so clock skew between the application and the database cannot
cause a skipped erasure. The instants travel through the export with microsecond precision.

### Where it lives: options considered

| Option | For | Against |
|---|---|---|
| **A separate small database** | Restoring the main database leaves it alone | On the same PostgreSQL host it shares the failure domain; a DELETE and a ledger write in two databases are not one transaction (it needs two-phase commit or an outbox anyway); one more database, role set, migration path and backup to run |
| **A separate schema with its own, more frequent backup** | One transaction with the DELETE | A whole-database restore replaces it too unless every restore is made selective; two backup schedules to keep consistent; same host, same failure domain |
| **Append-only file storage outside the database host** | Survives the loss or restore of the database by construction; already built, mounted and verified for run deletions (ADR-0037) and access restrictions (ADR-0045): durable write (temp file, fsync, rename, directory fsync), strict reader, owner-only replay, restore drill | Not one transaction with the DELETE: needs an outbox, and has a recovery point of one export interval |

**Chosen: the file option, through an in-database outbox, reusing the existing journal path.** It is the simplest
option that works with the current Docker setup, because it adds no service at all:

- the ledger table is the **outbox**, written in the deleting statement;
- the maintenance process exports it to `DELETION_JOURNAL_DIR` (the same operator-mounted, off-host directory as the run
  deletion and access journals; production already requires it), as `erasure-ledger-*.ndjson`, and removes rows only
  after the file is durable (claim and acknowledge in one transaction; at-least-once);
- `npm run restore:reapply-erasures -- --journal-dir <copy>` replays the files on a restored database before it is
  opened, as the object owner, after deletions and access restrictions.

### Writing the ledger with the deletion, and what happens when that fails

An `AFTER DELETE ... FOR EACH ROW` trigger on `activities` (a SECURITY DEFINER function, granted to nobody) inserts the
ledger row **in the deleting statement**. It is a trigger, not service code, so every path journals: the API, the
owner's own SQL under RLS (which ADR-0072 allows) and the replay itself. The runtime and maintenance roles have no
privilege on the table; maintenance can only claim and acknowledge.

**If the ledger write fails, the deletion fails.** The trigger's error aborts the DELETE statement and its transaction:
the activity stays, no ledger row exists, and `DELETE /activities/:id` answers `500 INTERNAL_ERROR` instead of `204`. The
client already treats a 5xx as "not confirmed, trying again is safe" (ADR-0072). An erasure without its record can
therefore never commit. If the *export* fails, rows stay in the outbox and are retried each cycle (ADR-0037 behaviour),
with the existing per-task failure metrics and logs (ADR-0070).

DELETE keeps answering `204` in every other case (deleted, already gone, never existed, someone else's).

### Replay

`app_private.reapply_erasure(entity_type, org, record, owner, record_created_at)`, granted to nobody:

- `erased`: the exact erased record is present (same owner and creation instant): it is deleted again, and the trigger
  journals it again on the recovered node;
- `absent`: no record with this id: nothing to do. A second replay of the same ledger therefore reports only `absent`;
- `skipped_different_record`: a record with this id exists but was created at another instant or by another owner (it
  reused the id after the erasure): left alone.

An unknown entity type is an error, in the CHECK and in the replay; it is never skipped.

### Extension point for daily metrics

One table, one entity now. The next owner-only entity adds its name to `erasure_ledger_entity_type_known`, a trigger
like `activities_record_erasure` on its table, an `ELSIF` branch in `app_private.reapply_erasure`, and its name to
`erasureEntityTypes` in `erasure-ledger-format.ts`. The export, file format, replay command and drill wiring stay.

## Decision B: one idempotency key per form session

- The create body gains a required `idempotencyKey` (UUID), generated by the web client once per form session and kept
  across edits until a confirmed save or until the person starts a new activity. It is stored in a nullable
  `activities.idempotency_key` column (rows created before migration 0027 and direct SQL have none) with
  `UNIQUE (org_id, user_id, idempotency_key)`: per owner, per organization. Keys of different people never interact, and
  a collision reveals nothing about another owner.
- Same key, same details: `200` with the existing activity (no duplicate), even under another activity id; the answer
  then carries the saved activity's id.
- Same key, different details: `409 ACTIVITY_ALREADY_SAVED` with `details.activityId` naming the saved activity. Nothing
  is stored. The web form says the earlier save went through and that the changed details were not saved, and offers
  **Open saved activity** (reads it) and **Start a new activity** (a new form session and key).
- The id rules of ADR-0072 still apply first: the same id with another payload or key is `409 ACTIVITY_CONFLICT`; an id of
  another member is `404`.
- Correctness under concurrency rests on the constraint, not on the reads: the insert is `ON CONFLICT DO NOTHING`
  without a target, so a racing save of the same form session waits on the unique index, inserts nothing, and then finds
  the winner by key. A test interleaves two transactions explicitly to prove it.
- A deleted activity frees its key: saving again from the same form session after deleting creates it again.

## Consequences

- One more maintenance runner (`Erasure ledger export`) on the existing pool and interval, enabled by the same
  `DELETION_JOURNAL_DIR`; one more restore step (`erasures_reapplied`, `erasure_outcomes_verified`) before readiness.
- The journal directory now also holds pseudonymous identifiers of erased health records: the same access control and
  retention rule as the deletion journal apply (keep files at least as long as the oldest restorable backup).
- Activity DELETE now depends on the ledger insert succeeding; a broken ledger makes deletions fail loudly rather than
  silently.

## Not established

- **Erasures committed but not yet exported when the node is lost** come back with an old backup. While the exporter is
  healthy the recovery point is one export interval (default 30 s) plus the time to drain any backlog ahead of the
  erasure, because a cycle exports at most 500 rows and the next cycle waits a full interval (ADR-0037). It is unbounded
  while the exporter fails. `journal_export_oldest_unexported_age_seconds{journal="erasure"}` reports the window in force
  (the age of the oldest unexported ledger row, 0 when drained); a successful cycle alone does not mean the ledger is
  drained.
- That `DELETION_JOURNAL_DIR` is really off-host and durable; in local runs it is a local directory.
- `TRUNCATE activities` fires no row trigger and is not journaled. The runtime role cannot truncate; the owner uses it
  only in the load-test seeder on a `_load_test` database.
- Ledger files are neither signed nor encrypted; a person who can write the directory can add an entry, whose worst
  effect is erasing the exact record version it names.
- A frozen or repeating application clock could give a re-created id the same creation instant as the erased version;
  replay would then erase the newer one. Real clocks make this a microsecond coincidence.
- No per-user activity cap (unchanged from ADR-0072); no edit endpoint; keys are not expired, and a form session that
  is never finished simply keeps its key in the browser's memory until the page closes.
