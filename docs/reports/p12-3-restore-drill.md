# P12.3 — Backup / restore drill report

Generated: 2026-10-01T09:51:45.506Z. Application commit: 17bbce2 (with uncommitted changes). Result: **passed**.

## DRILL RESULT

- measured local drill RTO: 3.4 s
- SDD target: <= 4 hours
- production RTO status: not established by this workstation drill

The isolated drill achieved an RPO exposure of 902 ms. Production RPO remains subject to the real backup schedule, storage durability, and target environment.

## Checks

| Check | Result |
|---|---|
| The restored database (after migrations, before reapplication) has the same row counts, archive revision and surviving-run data as the database at backup time | pass |
| Runs A and B exist in the restored backup with their points, summary and share, and have no tombstone: the backup really contains data deleted later | pass |
| The first reapplication deleted the two resurrected runs, restored the marker of the run that never reached the backup, and reported no other outcome | pass |
| After reapplication, deleted runs have no runs, run_points, run_summaries or run_shares rows | pass |
| After reapplication, every deleted run has a tombstone | pass |
| No tombstone expires earlier than one year after its deletion instant | pass |
| The archive revision advanced exactly once per run that was actually deleted, and not for a restored marker | pass |
| The surviving run is unchanged and the table counts moved only by the deleted runs | pass |
| The second reapplication changed nothing: every entry reported marker_present and none was deleted again | pass |
| The database state after the second reapplication is identical to the state after the first: same rows, tombstone expiry, archive revision and journal | pass |
| The owner, runtime and maintenance roles exist and can log in | pass |
| The three application roles are not superuser, have no BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION | pass |
| The runtime and maintenance roles have no access to the deletion journal table or the reapplication function | pass |
| The runtime and maintenance roles cannot connect to the restored database: it stays closed until current permissions are restored (P12.4) | pass |
| No application login has a session on the restored database | pass |
| PostGIS is installed and callable in the restored database | pass |
| Every migration file of this repository is recorded as applied | pass |
| The original journal directory is byte-identical to what the exporter wrote | pass |
| The read-only recovery copy of the journal was not modified by reapplication | pass |
| The source database was not used after the simulated loss | pass |

## Backup

| Item | Value |
|---|---|
| backup format | pg_dump-custom |
| envelope version | 1 |
| encryption algorithm | aes-256-gcm |
| backup artifact size | 146 KiB |
| source database size | 15.9 MiB |
| backup duration | 667 ms |
| PostgreSQL / PostGIS | PostgreSQL 17.5 (Debian 17.5-1.pgdg110+1) / PostGIS 3.5.2 |
| client tools | pg_dump (PostgreSQL) 17.5 (Debian 17.5-1.pgdg110+1); pg_restore (PostgreSQL) 17.5 (Debian 17.5-1.pgdg110+1); run inside the database container (docker exec) |

## Recovery timeline and measurements

| Item | Value |
|---|---|
| backup_created_at | 2026-10-01T09:51:40.861Z |
| deletions completed (after backup) | 2026-10-01T09:51:41.695Z |
| journal exported | 2026-10-01T09:51:41.724Z |
| simulated_loss_at | 2026-10-01T09:51:41.763Z |
| restore_started_at | 2026-10-01T09:51:43.143Z |
| restore_completed_at | 2026-10-01T09:51:43.424Z |
| migration_completed_at | 2026-10-01T09:51:44.182Z |
| journal_reapply_started_at | 2026-10-01T09:51:44.987Z |
| journal_reapply_completed_at | 2026-10-01T09:51:45.048Z |
| verification_completed_at | 2026-10-01T09:51:45.192Z |
| restore duration | 281 ms |
| migration duration | 758 ms |
| journal reapplication duration | 62 ms |
| total recovery duration | 3.4 s |
| measured drill RPO | 902 ms (simulated_loss_at − backup_created_at); SDD target <= 24 hours; within target in this drill: yes |
| measured drill RTO | 3.4 s (loss to verification complete); SDD target <= 4 hours; within target in this drill: yes |

## Migrations

The backup was 1 migration behind this repository: its source database was migrated with the latest 1 migration file withheld, using the unchanged migration runner.

The current migration runner ran after the restore: 1 applied, 19 skipped. A second run was a checksum-only no-op (0 applied, 20 skipped).

## Deletion journal reapplication

| Item | Value |
|---|---|
| journal files | 1 |
| journal entries | 3 |
| recovery copy read-only enforced by the file system | yes |
| first pass outcomes | deleted: 2, expired: 0, marker_present: 0, marker_restored: 1, skipped_newer_run: 0, skipped_unknown_membership: 0, skipped_unknown_organization: 0 |
| second pass outcomes (idempotency) | deleted: 0, expired: 0, marker_present: 3, marker_restored: 0, skipped_newer_run: 0, skipped_unknown_membership: 0, skipped_unknown_organization: 0 |

Fixture runs are labelled A, B, C and D; no identifier is printed. A: owner deletion after the backup. B: annual retention deletion after the backup (effective clock = real time; the fixture run finished 400 days earlier). C: untouched survivor. D: created and deleted after the backup, so the backup never contained it and only its tombstone is restored.

## Roles and security

| Role | superuser | BYPASSRLS | CREATEDB | CREATEROLE |
|---|---|---|---|---|
| running_tracker_maintenance | false | false | false | false |
| running_tracker_owner | false | false | false | false |
| running_tracker_runtime | false | false | false | false |

## Recovery sequence and application access

Completed in order: application_offline, database_created, roles_and_postgis_bootstrapped, backup_restored, migrations_applied, migration_checksums_verified, journal_copy_readonly, deletions_reapplied, deletion_outcomes_verified, readiness_verified.

Pending: current_permissions_restored.

Application access: closed. The restored database revokes CONNECT from the runtime and maintenance logins and no application process was started against it. Restoring current memberships, shares, credentials and revoked grants is P12.4; until it exists and has run, the database must not be opened to the application, so this drill never declares it safe for access.

## VERIFIED IN LOCAL DRILL

- A real pg_dump custom-format archive of a real PostgreSQL/PostGIS database was encrypted (AES-256-GCM, key from a separate file), written atomically, and read back and authenticated.
- The archive was restored with pg_restore into a fresh, isolated database with the existing role model, then the current migration runner ran, and a second run was a checksum-only no-op.
- Runs A and B existed in the backup with their points, summary and share. Their deletions (an owner deletion and an annual retention deletion) happened after the backup and were exported by the existing journal exporter.
- After `restore:reapply-deletions` from a read-only copy of the journal, A and B had no run, point, summary or share rows, every deleted run had a tombstone of at least one year, and the archive revision advanced exactly once per deleted run. D received its tombstone. The surviving run C was unchanged.
- A second reapplication was idempotent: only marker_present outcomes, and an identical database state.
- The three application roles are not superuser and have no BYPASSRLS, CREATEDB or CREATEROLE.
- Failure paths fail closed: wrong key, corrupted or truncated backup, malformed journal, migration checksum mismatch, and an out-of-order recovery step are covered by automated tests.

## NOT VERIFIED / REQUIRES REAL TARGET ENVIRONMENT

- Production RPO. The backup here was taken seconds before the simulated loss; the real figure depends on the backup schedule actually running daily, the storage it writes to, and monitoring of backup age.
- Production RTO. The measured time is one small database on one workstation with the database tools in a local container. It says nothing about the size, hardware, network or staffing of a real recovery.
- That backups and the deletion journal are really off-host, durable, and in a different failure domain than the database. Here both are local directories.
- Encryption key custody. The key was a local file. Storing it separately from the backups, backing it up, rotating it and recovering it are operator decisions that this repository does not solve.
- Restoring current memberships, shares, credentials and revoked grants (P12.4). A restored backup can still contain access that was revoked after it was taken.
- Production sign-in (P12.1): no identity provider is selected, so no end-to-end login was exercised.
- Deletions that were committed but not yet exported when a node is lost (journal recovery point, ADR-0037), and a mount that accepts writes but is not durable.
- Daily scheduling and 7-day retention running unattended on a host: the commands exist and are tested; nothing here ran on a schedule.

## Commands

```text
npm run restore:drill -- --report-md docs/reports/p12-3-restore-drill.md --report-json docs/reports/p12-3-restore-drill.json
docker exec -i running-tracker-postgres-1 pg_dump --version
docker exec -i running-tracker-postgres-1 pg_restore --version
node scripts/bootstrap-database.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t095137_source)
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t095137_source)
docker exec -i running-tracker-postgres-1 pg_dump --version
docker exec -i -e PGPASSWORD running-tracker-postgres-1 pg_dump --format=custom --no-password --host 127.0.0.1 --port 5432 --username running_tracker --dbname running_tracker_restore_drill_20261001t095137_source
node scripts/bootstrap-database.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t095137_target)
docker exec -i -e PGPASSWORD running-tracker-postgres-1 pg_restore --format=custom --single-transaction --exit-on-error --no-password --host 127.0.0.1 --port 5432 --username running_tracker --dbname running_tracker_restore_drill_20261001t095137_target
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t095137_target)
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t095137_target)
restore:reapply-deletions --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of running_tracker_restore_drill_20261001t095137_target)
restore:reapply-deletions --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of running_tracker_restore_drill_20261001t095137_target)
```
