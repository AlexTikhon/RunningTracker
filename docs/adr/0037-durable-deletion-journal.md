# ADR-0037: Durable deletion journal and restore-time reapplication

- Status: accepted; P10.5 implemented and locally verified
- Date: 2026-09-29
- Scope: P10.5; closes the mechanism half of D09. The restore drill and the
  recovery of access restrictions stay in P12.3/P12.4.

## Context

SDD section 12 requires that, before a restored database is returned to access,
deletions made after the backup are reapplied "from a separately preserved
deletion log". Nothing in the system did that. Tombstones (ADR-0006, ADR-0036)
live in the same database: they are lost with the node, they are not present in
an older backup, and they are reclaimed after a year. A plain table in a lost
database is exactly what D09 says is insufficient, and a backup restore would
resurrect deleted runs and their raw points.

The decision has three parts: what is recorded, how it leaves the database
host, and how it is applied after a restore. It must not need a message broker;
the plan explicitly rules out a system-wide queue for this.

## Decision

1. **Record every deletion in the deletion transaction.** Migration
   `0018_deletion_journal.sql` adds `run_deletion_journal` (identity `journal_seq`,
   `org_id`, `run_id`, `owner_user_id`, `deleted_at`). `execute_run_deletion`, the
   single primitive behind owner deletion and annual retention, inserts the
   journal row in the same transaction as the tombstone and the cascade delete.
   A committed deletion therefore always has its row, and a rolled-back one never
   leaves an orphan. The row holds identifiers and one timestamp: no coordinates,
   no payload, no session or provider data. There are no foreign keys, so a row
   outlives the run, membership and tombstone it describes. Runtime and
   maintenance have no privilege on the table.
2. **Export through an outbox, durable before removal.** A maintenance runner
   (`runDeletionJournalExportOnce`, `RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS`,
   default 30 s) runs one transaction that claims at most 500 rows with
   `claim_deletion_journal_batch` (`FOR UPDATE SKIP LOCKED`, oldest first),
   writes them to the configured directory, calls `ack_deletion_journal_batch`,
   and commits. The file is written under a temporary name, fsynced, renamed to
   its final name, and the directory is fsynced (best effort on Windows, which
   cannot fsync a directory). The rows are deleted only after that, so a failure at
   any earlier point rolls back and the rows stay. A crash between the durable
   write and COMMIT re-exports the batch: export is at-least-once.
3. **Where the files go is an operator decision, and the code cannot verify it.**
   `DELETION_JOURNAL_DIR` is an absolute path that the operator mounts on storage
   outside the database host and outside its failure domain. It is required in
   production. Development and test may leave it unset: rows then stay in the
   database outbox and a warning is logged at startup. With the directory set,
   startup verifies it is writable (creating it, writing and fsyncing and removing
   a probe file) before the listener binds. Nothing in the repository proves that
   the mount really is off-host; the runbook states this as an operational
   requirement.
4. **File format.** One JSON object per line, newline-terminated,
   `{ v: 1, seq, orgId, runId, ownerUserId, deletedAt }`, in files named
   `deletion-journal-<export instant>-<first seq>-<last seq>-<random>.ndjson`.
   The name never repeats and never overwrites an older file: the source sequence
   restarts after a restore and two exporters may run. The reader is strict: an
   unknown key, malformed UUID, non-canonical instant, missing final newline or
   blank line rejects the whole file and therefore the whole restore, because a
   silently skipped deletion is a privacy failure.
5. **Reapply on a restored database that is not open to the application.**
   `app_private.reapply_journaled_deletion(org, run, owner, deleted_at, now)` is
   granted to nobody, so only the object owner can call it, and the restore
   command (`npm run restore:reapply-deletions -- --journal-dir <dir>`) refuses any
   other role. It reads all files first, then applies each entry in its own short
   transaction, so it can be interrupted and simply run again. Per entry:
   - the run exists and was created no later than `deleted_at`: full deletion through the same
     primitive (tombstone, summary/share/points removal, one archive-revision
     increment). The deletion is journaled again, so the recovered node keeps
     exporting it;
   - the run exists but was created after `deleted_at`: it is a different run that
     reused the ID; it is left alone (`skipped_newer_run`);
   - the run is absent: a missing tombstone is restored and a shorter one is
     lengthened but never shortened (`marker_restored`, `marker_present`), unless the
     one-year window already ended (`expired`);
   - the organization or the owner's membership is not in the restored data:
     nothing to protect and no marker can be stored (`skipped_unknown_*`).
   Reapplication is idempotent; the report prints counts and outcome names, never
   identifiers.
6. **No extra machinery.** No message broker, no second database, no permanent
   used-ID registry, no change to the HTTP contract, and no change to ordinary
   deletion behavior.

## Recovery point and what is honestly claimed

- **Journal RPO.** While the exporter is healthy, a deletion is off-host within
  one export interval (default 30 s) plus one cycle. If the node is lost before
  that, the deletion is lost with it and the run can reappear after a restore; the
  owner would have to delete it again. If the exporter or the mount is failing,
  the window grows without bound until it is repaired, and today the only signal is
  a logged cycle failure. Structured metrics and alerting on backlog age are P11.1.
- **Backup RPO** is separate: a daily backup, 24 hours (SDD 12). Reapplication
  covers deletions after that backup. The two RPOs do not add: the journal only has
  to cover the interval since the oldest backup that might be restored.
- **Nothing here claims RPO 24 h / RTO 4 h as achieved.** No backup or restore was
  performed. The procedure and the reapplication tool are prepared and tested
  against a real database; the end-to-end drill is P12.3.

## Concurrency

- Deletion writes the journal row inside the existing lock order (advisory lock,
  organization, run); the journal insert takes no new lock beyond the sequence.
- Export takes row locks on journal rows only and waits on nothing else.
  `SKIP LOCKED` gives two exporters disjoint batches. The identity sequence is not
  commit-ordered, but rows are removed rather than tracked by a high-water mark, so
  a late-committing lower sequence is simply exported in a later batch.
- Reapplication takes the same per-run advisory lock and organization lock as
  deletion, so a reapplied deletion cannot interleave with maintenance jobs on that
  run, although the restore is intended to run with the application offline.

## Consequences

- One more maintenance runner (a sixth) on the existing maintenance pool. Each idle
  cycle is one short transaction; a busy cycle holds one connection for the file
  write. It was not resized here.
- The journal directory contains run and user identifiers of deleted runs. They are
  pseudonymous personal data. It needs the same access control as the database and
  a retention rule (see the runbook): keep files at least as long as the oldest
  restorable backup, and no longer than needed.
- `ack_deletion_journal_batch` trusts the maintenance role to name only rows it
  exported; the role can already delete data through other capabilities, so no new
  authority is granted.

## Limitations

- Files are not signed or encrypted by the application. A person who can write to
  the directory can add an entry; the worst effect on restore is deleting a run that
  existed before the fabricated instant. Storage permissions are the control; file
  signing is deferred.
- The directory is not pruned by the application.
- Restoring access restrictions (revoked grants, deactivated memberships) is not
  handled here; an old backup may still contain them as they were. That is P12.4.
- Deletion instants come from the trusted maintenance/application clock.
- The exporter does not detect a mount that accepts writes but is not actually
  durable or off-host.

## Verification

Real separated-role PostgreSQL/PostGIS integration
(`apps/api/test/run-deletion-journal.integration.test.ts`, 18 tests) plus unit
suites for the format, file sink, exporter, reapplication and command line, and the
configuration test. See `docs/progress.md` for the executed results.
