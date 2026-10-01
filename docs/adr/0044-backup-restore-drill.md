# ADR-0044: Encrypted backups, an executable restore drill, and deletion reapplication before access

- Status: accepted; P12.3 implemented and verified locally on a workstation
- Date: 2026-10-01
- Scope: P12.3 only. Current permissions after a restore are P12.4, the production identity
  provider is P12.1, and the final documentation pass is P12.5. D09 stays PARTIAL.

## Context

SDD section 12 requires a daily encrypted off-host backup kept for seven days, initial targets of
RPO <= 24 hours and RTO <= 4 hours "subject to a restore-drill verification", and a fixed order
after a restore: restore, migrate, reapply the separately preserved deletion log, restore current
access restrictions, and only then open the application. ADR-0037 built the deletion journal and the
`restore:reapply-deletions` command but explicitly left the end-to-end drill to P12.3: nothing had
ever taken a backup and restored it. This ADR makes the first three steps of that sequence a
repeatable command that runs against a real PostgreSQL/PostGIS server, and records what that does
and does not prove. It does not duplicate ADR-0037; the journal format, export, and reapplication
semantics are unchanged.

## Decision

1. **PostgreSQL's own dump, in custom format.** `pg_dump --format=custom` is the primary artifact and
   `pg_restore` the only restore path. No plain SQL dump, no database-to-database copy, and no
   fallback: if the tools cannot be started the command fails and says so. The tools run either on the
   machine (`pg_dump` on `PATH`) or inside the database container (`docker exec`, selected by
   `BACKUP_PG_DOCKER_CONTAINER`). The second mode is what makes the drill work on a Windows workstation
   without installing client tools; the password reaches the tool only through the environment
   (`docker exec -e PGPASSWORD` forwards the name, never the value), never on a command line.
   `pg_restore` runs `--single-transaction --exit-on-error`, so a failed restore leaves no half-restored
   database. The dump runs as the administrator login because it must read every row regardless of
   row-level security; the application roles are never used to back up.
2. **A small versioned envelope with standard authenticated encryption.** One file:
   `RTBACKUP` magic, a four-byte header length, a JSON header, the AES-256-GCM ciphertext of the
   archive, and the 16-byte tag. The header (`formatVersion: 1`, `algorithm: aes-256-gcm`, the nonce,
   creation instant, source database name, PostgreSQL/PostGIS versions, `pg_dump` version, migration
   count and last migration id) is validated by a strict schema and is also the GCM additional
   authenticated data, so it cannot be altered without failing authentication. It never carries
   credentials, tokens, coordinates, or run data. Node's built-in `crypto` is the only implementation;
   there is no home-grown construction and no new dependency. The 12-byte nonce is random per backup
   under a key that is only ever used with random nonces for a daily job, far inside GCM's limits.
3. **The key is an external file and never sits with the backups.** `BACKUP_ENCRYPTION_KEY_FILE` is an
   absolute path to 64 hex characters (32 bytes) with at most one trailing newline; anything else is
   rejected, and no message echoes key contents. `npm run backup:keygen` creates a `0600` key file and
   refuses to overwrite. `backup:create` refuses a key file stored inside the backup directory. The key
   is deliberately **not** part of `deploy:secrets` or the production compose secrets: putting it in
   the secret set would invite storing it on the same host as the encrypted backups, which defeats the
   encryption. Where the key is kept, backed up, and recovered is an operator decision this repository
   does not solve.
4. **Atomic, never-overwriting publication.** The artifact is encrypted into `.tmp-backup-<uuid>` (mode
   `0600`), fsynced, then published with a hard link, which fails if the name exists, and only then is
   the temporary name removed and the directory fsynced (best effort on Windows, as for the journal).
   File systems without hard links fall back to an existence check plus rename. A name is
   `running-tracker-backup-<UTC compact>-<8 hex>.rtbak`. A failed or empty dump removes the temporary
   file and never produces a final name, so a partial artifact is never a valid backup. After
   publication the file is read back and authenticated once.
5. **Retention that can only touch its own files.** `backup:prune` lists names matching the exact
   pattern above (regular files only), removes those strictly older than N days (default 7, from the
   timestamp in the name, so it is deterministic), never removes a newer one, and keeps the newest
   backup even if expired unless `--allow-remove-last` is given, so a stalled job cannot empty the
   directory. It prints what it removed. Scheduling is a host cron/systemd timer (examples in the
   runbook); there is no scheduler framework.
6. **Backup age without coupling the API.** After a successful backup, `--metrics-file` atomically
   writes a three-line Prometheus text file (`running_tracker_backup_last_success_timestamp_seconds`,
   size, duration) for the node_exporter textfile collector. Age is `time() - timestamp` in the
   monitoring system. The API does not read backups or this file, and the scrape endpoint (ADR-0038)
   runs no query and no external call. Alerting on that age is an operator task.
7. **The drill: a real recovery in a fresh isolated database.** `npm run restore:drill` runs the whole
   scenario end to end on a loopback PostgreSQL server:
   - create a source database named `running_tracker_restore_drill_<suffix>_source`, bootstrap it with
     the existing roles/PostGIS script, and migrate it with the unchanged runner **one migration short
     of the repository** (by pointing the runner's working directory at a copy of `db/migrations`
     without the newest file), so the backup really is older than the code;
   - seed runs A (owner deletes later), B (annual retention deletes later), C (survivor) with points,
     a summary and a share, take the encrypted backup, then create run D after the backup;
   - delete A and D through `deleteRun` (the service function behind the HTTP route) under the runtime
     role with tenant context, delete B through `runRetentionDeleteOnce` under the maintenance role, and
     export the journal with the real exporter and sink;
   - copy the journal to a recovery directory and make the files read-only, simulate loss (the source
     stops accepting connections and its sessions are terminated; it is dropped only after a successful
     drill);
   - recover in the SDD order: application offline, create the target, bootstrap roles and PostGIS,
     authenticate and `pg_restore` the backup, run the migration runner (it must apply exactly the
     withheld migration), run it again (it must apply nothing: a checksum-only no-op), verify the
     recovery copy is unchanged, reapply the journal, inspect, reapply again, inspect, verify;
   - verify through the owner role: A and B are absent from `runs`, `run_points`, `run_summaries` and
     `run_shares`; every deleted run has a tombstone expiring at least a year after its deletion; the
     archive revision advanced exactly once per run actually deleted; C is unchanged down to a digest
     over its PostGIS points; and the second pass reports only `marker_present` and leaves a byte-for-
     byte identical state, journal included.
8. **Fail closed at every step.** Any failed step stops the drill with a non-zero exit code and a report
   naming the step, keeps both databases for diagnosis, drops nothing, and never starts the
   application. A wrong key, a damaged or truncated artifact, a failing `pg_restore`, a migration
   checksum mismatch, a malformed journal file, a failed check, or an unmet RPO/RTO target are all
   failures. GCM only authenticates at the end of a stream, so the restore operation authenticates the
   whole artifact before it streams a byte to `pg_restore`; otherwise a damaged tag could be reported
   after the restore had already committed (a test removes this line and fails).
9. **Target safety.** Both drill databases must match `running_tracker_restore_drill` plus optional
   lowercase `_suffix` parts (63 characters at most); every `DROP DATABASE` repeats the check. All four
   connection URLs (administrator, owner, runtime, maintenance) must be loopback, name the same host
   and port, carry no identity-overriding query parameters, and use the expected logins; the
   administrator must be a superuser connecting to `postgres`, and the three role URLs must themselves
   name a drill-named database. The development, test and load-test databases are never connected to,
   created, or dropped by the drill, and error messages name variables and rules, never passwords.
10. **Recovery stops before access.** `recoverySteps` encodes the SDD order with a final step,
    `current_permissions_restored`, that this tool never completes. After the readiness checks the
    target database has `CONNECT` revoked from the runtime and maintenance logins (checked, and checked
    again by a test that tries to connect), so even a misconfigured application cannot open it, and the
    report says "application access: closed". P12.4 must implement and complete that step.
    (Update, ADR-0045: P12.4 implemented the access-restriction journal and the drill now completes
    `current_permissions_restored` after two new steps; the database is still left closed.)
11. **Measurement methodology.** Timestamps come from the clock (`backup_created_at`,
    `simulated_loss_at`, `restore_*`, `migration_completed_at`, `journal_reapply_*`,
    `verification_completed_at`); durations from a monotonic clock. Drill RPO exposure =
    `simulated_loss_at - backup_created_at`; drill RTO = loss to verification complete (including
    bootstrap, artifact authentication, restore, both migration runs, both reapplications and all
    inspections). Both are compared with 24 hours and 4 hours and a miss fails the drill. The report
    uses fixed wording that separates "VERIFIED IN LOCAL DRILL" from "NOT VERIFIED / REQUIRES REAL
    TARGET ENVIRONMENT" and never states a production RPO or RTO.

## Why deletions are reapplied before access

A restored backup is a snapshot of the past. Until reapplication, it holds runs and raw points that
people deleted afterwards; the moment the API connects, those runs are readable again, shared again
and drawn on the archive map. Reapplying first closes that window, and it must come after migrations
because an older backup does not yet have the reapplication function (migration 0018), which the drill
exercises for real. Access restrictions have the same property (a revoked share would reappear), which
is why the final step exists and is not yet implemented.

## What the local drill proves, and what it does not

Proved on a workstation, with real PostgreSQL 17.5 and PostGIS 3.5.2: the dump/encrypt/restore
pipeline works and detects tampering; an older schema is caught up by the unchanged migration runner
with checksums verified; deleted runs do not come back and keep their tombstones; reapplication is
idempotent; the application roles stay unprivileged; failures stop the drill.

Not proved: any production RPO or RTO (the drill's backup is seconds old and its database is a few
dozen rows plus the PostGIS extension, so its timings say nothing about size or a real host); that
backups or the journal are really off-host and durable; key custody; that the daily schedule runs;
that a real operator can do this under pressure; restoration of current memberships, shares and
credentials (P12.4); and any sign-in (P12.1). The drill integration tests are opt-in (they need a local
server and the tools), so the repository's CI, which only has a bare PostgreSQL service container,
does not run them.

## Consequences

- One more family of commands (`backup:create|verify|prune|keygen`, `restore:drill`) in `apps/api`;
  no new runtime dependency and no change to the running API.
- The backup administrator credential is a new secret to hold and to keep off the application hosts.
- The drill creates databases on a shared local server; a failed run leaves them in place for
  diagnosis until `npm run restore:drill -- --cleanup`, which drops every database with the drill
  prefix and nothing else.
- Backup size grows with the data and is held entirely by `pg_dump`'s own compression; encryption is
  streaming, but verification reads the file twice (once to authenticate, once to restore).

## Limitations

- A single GCM message per backup; the format version exists so a chunked format can follow if a
  backup ever approaches GCM's per-message limit (about 64 GiB), which this system is far from.
- No key rotation or multi-key envelope; a lost key means unreadable backups.
- No signed backup manifest or checkpoint of "which backups exist"; whoever can delete files from the
  directory can delete backups, which the retention command does not protect against.
- The retention command trusts the timestamp in the file name; it does not verify that a retained
  backup is restorable (use `backup:verify` for authentication and the drill for restorability).
- Parallel `pg_restore` is not used (it needs a seekable file); restore time for a large database is
  therefore a single stream and must be measured on the real data.
