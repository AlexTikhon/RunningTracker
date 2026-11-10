# Runbook: deletion journal and restoring without resurrecting deleted runs

Audience: the operator who runs the service and performs restores.
Design: ADR-0037 (journal) and ADR-0044 (backups and the drill). Status: tested against a real
database in P10.5, and rehearsed end to end by the P12.3 restore drill on a developer workstation
(`npm run restore:drill`, `docs/reports/p12-4-restore-drill.md`). **That drill is not a production
recovery: no production RPO or RTO is claimed.** Revoked shares and deactivated memberships are restored
by the access-restriction journal (ADR-0045), which this runbook references. Backups,
encryption, retention, and the rest of the restore are in `docs/runbooks/backup-and-restore.md`.

## What this protects, and what it does not

A backup can contain runs that were deleted after it was taken. If it is restored
as is, those runs and their raw points come back. Every deletion is therefore also
written to a journal that leaves the database host. After a restore, and before the
application can reach the database, the journal is reapplied.

Reapplying deletions does **not** restore access restrictions. A backup may still contain
shares or memberships that were revoked afterwards. That is the access-restriction journal's job
(`npm run restore:reapply-access`, step 7 below and ADR-0045), and it must run before access is opened.

## Configuration

| Setting | Meaning |
|---|---|
| `DELETION_JOURNAL_DIR` | Absolute directory that receives journal files. **Must be storage outside the database host and outside its failure domain** (a separately replicated volume, an object-store mount, another machine). Required in production. The application cannot check that the mount is really off-host or durable. |
| `RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS` | How often a batch of at most 500 pending deletions is exported. Default 30000. While healthy, a deletion is off-host within one interval plus the time to drain any backlog ahead of it (one more interval per 500 older rows); see "Backlog age" below. |

At startup with the directory set, the API creates it if missing and proves it can
write, fsync and remove a probe file. If that fails the API does not start.

The directory holds run and user identifiers of deleted runs (no coordinates or
payload). Treat it like the database: restrict access to the service account and to
the operators who perform restores, and do not put it on shared or public storage.

## Normal operation

- New files named `deletion-journal-<timestamp>-<firstSeq>-<lastSeq>-<random>.ndjson`
  appear shortly after deletions. Files are complete or absent; a `.tmp-*` file is
  a leftover of an interrupted write and is ignored (delete it).
- Duplicated lines across files are expected after a crash (at-least-once export)
  and are harmless.
- Backlog check on the live database, as the owner role:

  ```sql
  SELECT count(*) AS pending, min(deleted_at) AS oldest FROM run_deletion_journal;
  ```

  `pending` should be near zero. A growing `oldest` means the exporter cannot
  write or cannot keep up: check the API log for `maintenance.cycle.failed`, the mount,
  free space and permissions. Nothing is lost while rows remain in the database, but
  a node loss in that state loses exactly those deletions.
- **Backlog age** is the signal to watch. `journal_export_oldest_unexported_age_seconds`
  with `journal="deletion"` (run deletions) or `journal="erasure"` (activities, check-ins,
  movement, meals) is the age of the oldest row not yet exported, 0 when the outbox is
  drained. It is measured after every export cycle, successful or not. A cycle exports at
  most 500 rows and the next one waits a full interval, so a backlog drains at about 500
  rows per interval even while every cycle succeeds, and
  `maintenance_last_success_timestamp_seconds` alone does not show it. The age is the
  recovery window actually in force; alert when it stays above a few intervals.

## Retention of journal files

Keep every file at least as long as the **oldest backup you could still restore**
(7 days by SDD 12), plus a safety margin; 14 days is a reasonable minimum. Do not
prune by file count, and never prune a file newer than the oldest retained backup.
The application does not delete files. Applying an old entry to a newer database is
harmless (see the outcomes below), so keeping files longer only costs storage and
identifier exposure.

## Restore procedure (ordered)

Perform every step before the application is started against the restored data.
Nothing may connect as the runtime or maintenance role in the meantime.

1. **Keep the application offline.** No API process, no maintenance runners.
2. **Restore the backup** into a fresh PostgreSQL/PostGIS instance on an isolated
   network. Recreate the roles (`npm run db:bootstrap`) if the instance is new. Backups are
   encrypted `pg_dump` archives: authenticate and decrypt with `npm run backup:decrypt` and restore
   with `pg_restore` as in `docs/runbooks/backup-and-restore.md`.
3. **Run migrations** (`npm run db:migrate`). This must come before reapplication:
   a backup older than migration `0018` does not yet contain the reapplication
   function. Migration checksums are verified; any mismatch stops the restore.
4. **Get a read-only copy of the journal directory** from the off-host storage.
5. **Reapply deletions** as the owner role:

   ```
   RESTORE_DATABASE_URL=postgresql://running_tracker_owner:<secret>@<host>:5432/<db> \
     npm run restore:reapply-deletions -- --journal-dir /path/to/journal-copy
   ```

   Where dev dependencies are not installed, run the built command instead:
   `node apps/api/dist/restore/reapply-deletions-main.js --journal-dir ...` with the
   same environment variable.

   The command refuses any other role, reads **all** files first and stops before
   changing anything if one is malformed, then applies each entry in its own short
   transaction. It prints only counts:

   | Outcome | Meaning |
   |---|---|
   | `deleted` | The run existed in the backup; it is deleted, tombstoned, and the archive revision advanced. |
   | `marker_restored` | The run was already absent but its tombstone was missing; restored. |
   | `marker_present` | Nothing to do (already applied or already marked). |
   | `expired` | The one-year window ended; no marker needed. |
   | `skipped_newer_run` | A run with this ID exists but was created after the deletion (ID reuse); left alone. |
   | `skipped_unknown_organization` / `skipped_unknown_membership` | Not present in the restored data; nothing to protect. |

   Exit code 0 means every entry was processed. Any error means the step is
   incomplete: fix the cause and **run the same command again**; it is idempotent.
6. **Verify.** `deleted` should equal the number of journaled deletions that
   happened after the backup and whose runs the backup still held. For a sample of
   known deleted run IDs, confirm as the owner role that `runs` has no row and
   `run_tombstones` has one.
7. **Reapply access restrictions** (revoked shares, narrowed shares, deactivated
   memberships) from the same journal copy with `npm run restore:reapply-access --
   --journal-dir <copy>`, exactly as in step 5 (owner login, run it twice; the second run
   must report only `already_applied`). It only removes access and never reconstructs a
   grant. Procedure, outcomes and limits: `docs/runbooks/backup-and-restore.md` step 8
   and ADR-0045. Do not open access until it is done and verified.
8. **Replay erasures of owner-only health records** (activities, ADR-0073; daily check-ins, ADR-0074; daily movement,
   ADR-0078, entity type `daily_movement`) from the same
   journal copy with `npm run restore:reapply-erasures -- --journal-dir <copy>`, owner
   login, exactly as in step 5. It reads every `erasure-ledger-*.ndjson` file first and
   stops on a malformed one. Outcomes: `erased` (the erased record was back in the
   restored data and is deleted again), `absent` (nothing to do), `skipped_different_record`
   (a record that reused the id after the erasure; left alone). Run it twice; the second
   run must report no `erased`. Do not open access until it is done.
9. **Open the database and start the application** with `DELETION_JOURNAL_DIR` pointing
   at the same storage (opening is an explicit `GRANT CONNECT`, see the backup runbook,
   step 10). Deletions, restrictions and erasures reapplied above were journaled again on
   the new database and will be exported as new files, so history stays continuous.

## Failure modes and honest limits

- Deletions committed but not yet exported when the node is lost are gone; the run
  can reappear after a restore. Its owner must delete it again. While the exporter is
  healthy the window is one export interval plus the time to drain any backlog queued
  ahead (about one more interval per 500 older rows); it is unbounded while the exporter
  is failing. The backlog-age metric above shows the window in force. The same holds for
  activity, check-in, movement and meal erasures in the erasure ledger (ADR-0073, ADR-0074, ADR-0078, ADR-0083).
- If the erasure ledger cannot be written, an activity, check-in or movement DELETE fails (HTTP 500)
  and the record stays; nothing is erased without its record. Fix the database, then the
  owner retries.
- Files are not signed. Whoever can write to the directory can add an entry, which
  on restore deletes a run that existed before the entry's instant. Control write
  access to the storage.
- A mount that accepts writes but loses them, or that turns out to be on the same
  host as the database, defeats the purpose. Confirm this when the environment is
  set up and again during the P12.3 drill.
- Reapplication acts on identifiers alone. It never changes runs created after the
  journaled deletion instant.
- Access restrictions follow the same export, the same directory (`access-journal-*.ndjson`)
  and the same recovery point; a restriction not yet exported when the node is lost comes
  back with an old backup. Recovery fails closed: grants are not reconstructed.

## Drill (P12.3)

`npm run restore:drill` automates the checklist below on the local development server and writes a
report with the measured numbers (`docs/reports/p12-4-restore-drill.md`): backup, owner and annual
retention deletions and access restrictions after it, journal export, simulated loss, restore into a
fresh isolated database, migrations, two reapplication passes of each journal, and verification that
deleted runs stay deleted and revoked access stays revoked. Its recovery point and recovery time
describe the drill on one small database, not production, and it deliberately stops with the
application still closed (step 8 is an explicit operator step). For a real environment, perform the
same checklist by hand and record actual numbers; do not reuse the targets.

1. Take a backup; record its time.
2. Delete several runs (owner deletion and annual retention) after it; wait for the
   journal files; note the time of the last deletion and the last file.
3. Simulate node loss and restore per the procedure. Measure elapsed time.
4. Confirm the outcome counts, that deleted runs are absent and `PUT` on their IDs
   returns 410, and that a revoked share is not silently back (step 7).
5. Record the achieved journal recovery point and total recovery time next to the
   SDD targets (RPO 24 h, RTO 4 h) and state whether each was met.
