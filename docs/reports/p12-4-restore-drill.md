# P12.4 — Backup / restore drill report with access recovery

Generated: 2026-10-01T10:27:20.622Z. Application commit: 17bbce2 (with uncommitted changes). Result: **passed**.

## DRILL RESULT

- measured local drill RTO: 3.4 s
- SDD target: <= 4 hours
- production RTO status: not established by this workstation drill

The isolated drill achieved an RPO exposure of 1.5 s. Production RPO remains subject to the real backup schedule, storage durability, and target environment.

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
| Just before the loss, the source had one share revoked, one narrowed to no history grant and one member deactivated, and those three people could no longer read the surviving run | pass |
| The restored backup still holds all of that access: every membership active, every share present and wide, and everyone able to read the surviving run | pass |
| The first access reapplication processed the five journaled restrictions: three changed the restored data, two (cascade removals of deleted runs' shares) were already in effect, and nothing was skipped | pass |
| After reapplication the revoked share is gone, the narrowed share has no history grant, the deactivated member is inactive, and those people cannot read the surviving run, while the owner and the untouched reader still can | pass |
| The permissions of the recovered database equal the permissions the lost source held | pass |
| Recovery added no access: no membership was activated, no share created or widened, and nobody can read what they could not read in the restored backup | pass |
| Each restriction that reapplication changed was recorded again in the recovered database's own outbox, so the history stays continuous | pass |
| The second access reapplication changed nothing: every entry reported already_applied | pass |
| The permissions and the outbox after the second pass are identical to those after the first | pass |
| The owner, runtime and maintenance roles exist and can log in | pass |
| The three application roles are not superuser, have no BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION | pass |
| The runtime and maintenance roles have no access to the deletion journal table or the reapplication function | pass |
| The runtime and maintenance roles have no access to the access-restriction journal table or its reapplication function | pass |
| The runtime and maintenance roles cannot connect to the restored database: the drill leaves it closed, and opening it is an explicit operator step | pass |
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
| backup artifact size | 150.9 KiB |
| source database size | 15.9 MiB |
| backup duration | 516 ms |
| PostgreSQL / PostGIS | PostgreSQL 17.5 (Debian 17.5-1.pgdg110+1) / PostGIS 3.5.2 |
| client tools | pg_dump (PostgreSQL) 17.5 (Debian 17.5-1.pgdg110+1); pg_restore (PostgreSQL) 17.5 (Debian 17.5-1.pgdg110+1); run inside the database container (docker exec) |

## Recovery timeline and measurements

| Item | Value |
|---|---|
| backup_created_at | 2026-10-01T10:27:15.435Z |
| deletions completed (after backup) | 2026-10-01T10:27:16.753Z |
| journal exported | 2026-10-01T10:27:16.838Z |
| simulated_loss_at | 2026-10-01T10:27:16.933Z |
| restore_started_at | 2026-10-01T10:27:18.105Z |
| restore_completed_at | 2026-10-01T10:27:18.425Z |
| migration_completed_at | 2026-10-01T10:27:19.122Z |
| journal_reapply_started_at | 2026-10-01T10:27:19.862Z |
| journal_reapply_completed_at | 2026-10-01T10:27:19.897Z |
| verification_completed_at | 2026-10-01T10:27:20.289Z |
| restore duration | 320 ms |
| migration duration | 697 ms |
| journal reapplication duration | 34 ms |
| total recovery duration | 3.4 s |
| measured drill RPO | 1.5 s (simulated_loss_at − backup_created_at); SDD target <= 24 hours; within target in this drill: yes |
| measured drill RTO | 3.4 s (loss to verification complete); SDD target <= 4 hours; within target in this drill: yes |

## Migrations

The backup was 1 migration behind this repository: its source database was migrated with the latest 1 migration file withheld, using the unchanged migration runner.

The current migration runner ran after the restore: 1 applied, 20 skipped. A second run was a checksum-only no-op (0 applied, 21 skipped).

## Deletion journal reapplication

| Item | Value |
|---|---|
| journal files | 2 |
| journal entries | 3 |
| recovery copy read-only enforced by the file system | yes |
| first pass outcomes | deleted: 2, expired: 0, marker_present: 0, marker_restored: 1, skipped_newer_run: 0, skipped_unknown_membership: 0, skipped_unknown_organization: 0 |
| second pass outcomes (idempotency) | deleted: 0, expired: 0, marker_present: 3, marker_restored: 0, skipped_newer_run: 0, skipped_unknown_membership: 0, skipped_unknown_organization: 0 |

Fixture runs are labelled A, B, C and D; no identifier is printed. A: owner deletion after the backup. B: annual retention deletion after the backup (effective clock = real time; the fixture run finished 400 days earlier). C: untouched survivor. D: created and deleted after the backup, so the backup never contained it and only its tombstone is restored.

## Access restriction reapplication

| Item | Value |
|---|---|
| access journal entries | 5 |
| first pass outcomes | applied: 3, already_applied: 2, skipped_unknown_organization: 0 |
| second pass outcomes (idempotency) | applied: 0, already_applied: 5, skipped_unknown_organization: 0 |

Fixture people: owner (owns every run), grantee, granteeTwo, leaver and keeper. After the backup, through the application's own paths: the share of grantee on run C was revoked (the API's revocation, as the runtime role), the share of granteeTwo was narrowed so that its history grant is gone, and the membership of leaver was deactivated. Owner and keeper were not touched. Deleting runs A and B also removed their shares, which the journal records as well, so two of the five entries were already in effect once the deletions had been reapplied.

Who can read the surviving run C, queried as the application runtime role under row-level security:

| Person | lost source (truth) | restored backup, before reapplication | recovered |
|---|---|---|---|
| owner | yes | yes | yes |
| grantee | no | yes | no |
| granteeTwo | no | yes | no |
| leaver | no | yes | no |
| keeper | yes | yes | yes |

The journal can only express removals (a deactivated membership, a revoked share, a narrowed share), and the reapplication function only removes access: it never reconstructs a grant, so a forged or stale journal file cannot add access. The price is that recovery fails closed. A grant made after the backup is lost with the node and has to be made again, and a share that was revoked and then granted again before the loss is removed again.

## Roles and security

| Role | superuser | BYPASSRLS | CREATEDB | CREATEROLE |
|---|---|---|---|---|
| running_tracker_maintenance | false | false | false | false |
| running_tracker_owner | false | false | false | false |
| running_tracker_runtime | false | false | false | false |

## Recovery sequence and application access

Completed in order: application_offline, database_created, roles_and_postgis_bootstrapped, backup_restored, migrations_applied, migration_checksums_verified, journal_copy_readonly, deletions_reapplied, deletion_outcomes_verified, access_restrictions_reapplied, access_outcomes_verified, readiness_verified, current_permissions_restored.

Pending: none.

Application access: closed. Every recovery step completed, including restoring current permissions (revoked shares and deactivated memberships, verified against the permissions of the lost source). Even so, the restored database still has CONNECT revoked from the runtime and maintenance logins and no application process was started against it: opening it is an explicit operator step described in docs/runbooks/backup-and-restore.md, and this drill never performs it.

## VERIFIED IN LOCAL DRILL

- A real pg_dump custom-format archive of a real PostgreSQL/PostGIS database was encrypted (AES-256-GCM, key from a separate file), written atomically, and read back and authenticated.
- The archive was restored with pg_restore into a fresh, isolated database with the existing role model, then the current migration runner ran, and a second run was a checksum-only no-op.
- Runs A and B existed in the backup with their points, summary and share. Their deletions (an owner deletion and an annual retention deletion) happened after the backup and were exported by the existing journal exporter.
- After `restore:reapply-deletions` from a read-only copy of the journal, A and B had no run, point, summary or share rows, every deleted run had a tombstone of at least one year, and the archive revision advanced exactly once per deleted run. D received its tombstone. The surviving run C was unchanged.
- A second reapplication was idempotent: only marker_present outcomes, and an identical database state.
- Access that was revoked after the backup (a share revoked, a share narrowed, a member deactivated) was still present in the restored backup, and was removed again by `restore:reapply-access` from the exported journal: the recovered permissions equal those of the lost source, and the people concerned can no longer read the surviving run as the runtime role under row-level security. Nobody gained access, the second pass changed nothing, and the changes were journaled again on the recovered node.
- The three application roles are not superuser and have no BYPASSRLS, CREATEDB or CREATEROLE.
- Failure paths fail closed: wrong key, corrupted or truncated backup, malformed journal, migration checksum mismatch, and an out-of-order recovery step are covered by automated tests.

## NOT VERIFIED / REQUIRES REAL TARGET ENVIRONMENT

- Production RPO. The backup here was taken seconds before the simulated loss; the real figure depends on the backup schedule actually running daily, the storage it writes to, and monitoring of backup age.
- Production RTO. The measured time is one small database on one workstation with the database tools in a local container. It says nothing about the size, hardware, network or staffing of a real recovery.
- That backups and the deletion journal are really off-host, durable, and in a different failure domain than the database. Here both are local directories.
- Encryption key custody. The key was a local file. Storing it separately from the backups, backing it up, rotating it and recovering it are operator decisions that this repository does not solve.
- Access restrictions that were committed but not yet exported when a node is lost (the same recovery point as the deletion journal): a revoked share or deactivated membership in that window comes back with an old backup, and the exporter's health decides how large the window is.
- Access granted after the backup, and shares that were revoked and granted again: by design these are not reconstructed from the journal, so they have to be granted again.
- Credentials and sessions. Sessions are held in process memory and are gone after a restart, and no identity provider exists yet (P12.1), so no credential was restored or exercised.
- Production sign-in (P12.1): no identity provider is selected, so no end-to-end login was exercised.
- Deletions that were committed but not yet exported when a node is lost (journal recovery point, ADR-0037), and a mount that accepts writes but is not durable.
- Daily scheduling and 7-day retention running unattended on a host: the commands exist and are tested; nothing here ran on a schedule.

## Commands

```text
npm run restore:drill -- --report-md docs/reports/p12-4-restore-drill.md --report-json docs/reports/p12-4-restore-drill.json
docker exec -i running-tracker-postgres-1 pg_dump --version
docker exec -i running-tracker-postgres-1 pg_restore --version
node scripts/bootstrap-database.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t102712_source)
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t102712_source)
docker exec -i running-tracker-postgres-1 pg_dump --version
docker exec -i -e PGPASSWORD running-tracker-postgres-1 pg_dump --format=custom --no-password --host 127.0.0.1 --port 5432 --username running_tracker --dbname running_tracker_restore_drill_20261001t102712_source
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t102712_source)
node scripts/bootstrap-database.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t102712_target)
docker exec -i -e PGPASSWORD running-tracker-postgres-1 pg_restore --format=custom --single-transaction --exit-on-error --no-password --host 127.0.0.1 --port 5432 --username running_tracker --dbname running_tracker_restore_drill_20261001t102712_target
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t102712_target)
node scripts/migrate.mjs  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to running_tracker_restore_drill_20261001t102712_target)
restore:reapply-deletions --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of running_tracker_restore_drill_20261001t102712_target)
restore:reapply-deletions --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of running_tracker_restore_drill_20261001t102712_target)
restore:reapply-access --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of running_tracker_restore_drill_20261001t102712_target)
restore:reapply-access --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of running_tracker_restore_drill_20261001t102712_target)
```
