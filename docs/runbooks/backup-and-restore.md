# Runbook: encrypted backups, retention, and restore

Audience: the operator who runs the service and performs restores.
Design: ADR-0044 (with ADR-0037 for the deletion journal and ADR-0045 for the access-restriction
journal). Status: the commands exist and a restore drill, including deletion and access-restriction
reapplication, passed on a developer workstation. **No production backup schedule, off-host storage, or
real recovery has been verified, so no production RPO or RTO is claimed.** A restored database stays
closed to the application until you open it deliberately (step 10 below).

## What is automated and what is yours

| Automated by the repository | Yours (the repository cannot do or verify it) |
|---|---|
| `pg_dump` custom-format archive, AES-256-GCM encryption, atomic unique file, read-back authentication (`backup:create`) | Running it daily (cron/systemd, below) |
| 7-day retention that touches only its own files (`backup:prune`) | Running it daily, after the backup |
| Key file generation and validation (`backup:keygen`) | Storing the key **away from the backups**, backing it up, controlling who can read it |
| `backup:verify`, `backup:decrypt` | Copying backups **off the host** to storage with its own failure domain, and proving it is durable |
| Backup-age metric file for the node_exporter textfile collector | Scraping it and alerting when the age exceeds your target |
| A drill that rehearses the SDD restore order, restore through access reapplication, and measures it (`restore:drill`) | Performing and timing a real restore on real hardware with real data |
| The deletion journal and the access-restriction journal: export and reapplication (ADR-0037, ADR-0045) | Keeping the journal directory off-host and for at least as long as the oldest restorable backup |

## Settings

| Variable | Used by | Meaning |
|---|---|---|
| `BACKUP_DATABASE_URL` | `backup:create` | Connection of an **administrator** (superuser) login to the database to back up. It must read every row regardless of row-level security. Not an application role, and not available to the API container. |
| `BACKUP_ENCRYPTION_KEY_FILE` | all backup commands, the drill | Absolute path of a file holding 64 hex characters (32 bytes), optionally followed by one newline. Never printed, never in the report. |
| `BACKUP_PG_DOCKER_CONTAINER` | `backup:create`, the drill | Optional. Run `pg_dump`/`pg_restore` inside this container (`docker exec`) instead of using client tools on the machine. Inside the container the server is addressed as `127.0.0.1:5432`. The version must match the server. |

These are **not** in `infra/compose/production.env.example` or in the generated production secret set on
purpose: the key must not live on the host that stores the encrypted backups, and the backup login is
not an application credential. Keep them in the backup job's own environment.

## Create the key (once)

```sh
npm run backup:keygen -- --out /safe/place/running-tracker-backup.key
```

It creates the file `0600`, creates missing parent directories, and refuses to overwrite. Store it in a
secret manager or on a different machine than the backups; keep at least one more copy somewhere that
survives loss of the backup host. **A lost key makes every backup unreadable, and there is no recovery.**
`backup:create` refuses a key file inside the backup directory, but cannot tell whether the directory is
on the same storage as the key.

## Daily backup

```sh
BACKUP_DATABASE_URL='postgresql://running_tracker_admin:<secret>@127.0.0.1:5432/running_tracker' \
BACKUP_ENCRYPTION_KEY_FILE=/safe/place/running-tracker-backup.key \
BACKUP_PG_DOCKER_CONTAINER=running-tracker-postgres-1 \
  npm run backup:create -- --out-dir /var/backups/running-tracker \
                           --metrics-file /var/lib/node_exporter/textfile/running_tracker_backup.prom
npm run backup:prune -- --dir /var/backups/running-tracker
```

`backup:create` prints the file name, creation instant, size, and duration, never the URL or key. It
writes `running-tracker-backup-<UTC>-<random>.rtbak` through a temporary file, so an interrupted run
leaves no valid-looking file (a leftover `.tmp-backup-*` can be deleted). It fails, and writes no
metrics, when the dump fails, is empty, or the finished file does not authenticate.

Scheduling is the host's job. Example, systemd:

```ini
# /etc/systemd/system/running-tracker-backup.service
[Service]
Type=oneshot
EnvironmentFile=/etc/running-tracker/backup.env   # BACKUP_* variables, mode 0600
WorkingDirectory=/opt/running-tracker
ExecStart=/usr/bin/npm run backup:create -- --out-dir /var/backups/running-tracker --metrics-file /var/lib/node_exporter/textfile/running_tracker_backup.prom
ExecStart=/usr/bin/npm run backup:prune -- --dir /var/backups/running-tracker

# /etc/systemd/system/running-tracker-backup.timer
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

or cron: `30 2 * * * cd /opt/running-tracker && set -a && . /etc/running-tracker/backup.env && npm run backup:create -- ... && npm run backup:prune -- ...`.

**Off-host.** `--out-dir` should be a mount outside this host's failure domain, or the directory must be
copied there right after the backup (rsync, object-store upload, a backup agent). The repository does not
copy anything off the host and cannot tell whether a path is off-host.

## Retention

`backup:prune` removes backups of this tool (exact file-name pattern, regular files only) that are
**strictly older than 7 days** by the timestamp in the name (`--retention-days N` changes it). It never
removes anything newer, never touches other files, and keeps the newest backup even when it is expired
unless `--allow-remove-last` is passed (so a stalled backup job does not empty the directory). Every
removed name is printed. Keep deletion-journal files at least as long as the oldest backup you keep
(the journal runbook says 14 days minimum).

Note that a backup may contain deleted data until it ages out; that is why a restore reapplies the
journal (below).

## Backup age monitoring

The API does not know about backups. `--metrics-file` writes, atomically and only after a successful
backup:

```
running_tracker_backup_last_success_timestamp_seconds <unix seconds>
running_tracker_backup_last_size_bytes <bytes>
running_tracker_backup_last_duration_seconds <seconds>
```

Point node_exporter's textfile collector at that directory and alert on
`time() - running_tracker_backup_last_success_timestamp_seconds > 25 * 3600` (daily job plus slack). A
failed backup does not update the file, so the age keeps growing and the alert fires. This was chosen
over adding a metric to the API because the API would have to read the backup directory or run a query
on every scrape, coupling the scrape endpoint to backup storage; the textfile route needs no change to
the running service. Nothing in this repository wires Prometheus or an alert rule: that is yours.

## Check a backup

```sh
BACKUP_ENCRYPTION_KEY_FILE=... npm run backup:verify -- --file /var/backups/running-tracker/<name>.rtbak
```

Reads the whole file, authenticates it (wrong key, a damaged byte, truncation, or changed metadata all
fail), and prints only technical metadata: format version, algorithm, creation instant, source database
name, PostgreSQL/PostGIS versions, migration count. Authentication proves the file is intact and was
written with this key; **only a restore proves it restores.** Do both periodically (the drill below, or
a restore into a scratch database).

## Restore (SDD order)

Do every step before the application is started against the restored data; nothing may connect as the
runtime or maintenance role in the meantime.

1. **Application offline.** No API process, no maintenance runners.
2. **Create a fresh database** on an isolated PostgreSQL/PostGIS instance and recreate the roles and
   extension with the existing bootstrap (`npm run db:bootstrap` with the `BOOTSTRAP_*` and role URLs
   pointed at it). Do not restore over a database that holds data you still need.
3. **Authenticate and decrypt, then restore.** Decrypt to a new file, restore it with `pg_restore`, then
   delete the plaintext:

   ```sh
   BACKUP_ENCRYPTION_KEY_FILE=... npm run backup:decrypt -- --file <backup>.rtbak --out /secure/tmp/restore.dump
   pg_restore --format=custom --single-transaction --exit-on-error --no-password \
     --host <host> --username <administrator> --dbname <fresh database> /secure/tmp/restore.dump
   shred -u /secure/tmp/restore.dump   # or the platform's secure delete
   ```

   `decrypt` authenticates the whole file before writing a byte and refuses to overwrite. The restored
   database is a snapshot of the past: runs deleted after the backup are back, and so are revoked shares
   and deactivated members.
4. **Run the current migrations** (`npm run db:migrate`, `MIGRATION_DATABASE_URL` as the owner). A
   mismatching checksum stops the restore; do not edit historical migrations. A second run must report
   only `skip`.
5. **Take a read-only copy of the deletion journal** from the off-host storage.
6. **Reapply deletions** as the owner role (details and outcomes in
   `docs/runbooks/deletion-journal-and-recovery.md`):

   ```sh
   RESTORE_DATABASE_URL=postgresql://running_tracker_owner:<secret>@<host>:5432/<fresh database> \
     npm run restore:reapply-deletions -- --journal-dir /path/to/journal-copy
   ```

   Run it twice; the second run must report only `marker_present`.
7. **Verify** a sample as the owner role: deleted runs have no `runs` row and have a `run_tombstones` row.
8. **Reapply access restrictions** (revoked shares, narrowed shares, deactivated memberships) from the same
   journal copy, as the owner role:

   ```sh
   RESTORE_DATABASE_URL=postgresql://running_tracker_owner:<secret>@<host>:5432/<fresh database> \
     npm run restore:reapply-access -- --journal-dir /path/to/journal-copy
   ```

   It validates every `access-journal-*.ndjson` file first, then applies each entry in its own
   transaction. It only ever removes access: it never activates a member, creates a share or widens one,
   and the file format cannot express a grant. Outcomes: `applied` (the restored data held more access and
   no longer does), `already_applied` (nothing to remove, or the share or member does not exist here),
   `skipped_unknown_organization`. Run it twice; the second run must report only `already_applied`. Every
   entry is replayed regardless of the backup's age, so a share that was revoked and granted again before
   the loss is removed again: grants are never reconstructed, they are made again by their owners.
9. **Verify access** as the owner role and as the runtime role under row-level security. For people you know
   were restricted after the backup: the membership is inactive, the share is gone or narrowed, and a
   `SET LOCAL ROLE running_tracker_runtime` query with `app.user_id` and `app.org_id` set to them no
   longer returns the run (the drill does exactly this).
10. **Open the database deliberately.** The drill and the bootstrap leave the application logins without
    `CONNECT` on the restored database. Only after steps 4 to 9 succeeded and the application version is
    the one the migrations belong to:

    ```sql
    GRANT CONNECT ON DATABASE <fresh database> TO running_tracker_runtime, running_tracker_maintenance;
    ```

    Then start the application with `DELETION_JOURNAL_DIR` pointing at the same storage. Deletions and
    restrictions reapplied above were journaled again on the new node and will be exported as new files,
    so history stays continuous. Nothing in this repository performs this step for you.

## The restore drill

`npm run restore:drill` performs and measures the SDD order up to, but not including, opening the
database (steps 1-9) on the local development server, with real PostgreSQL/PostGIS. It needs Docker, the local database (`npm run db:up`), a key file,
and the `RESTORE_DRILL_*` variables from `.env.example` (an administrator on a **loopback** server, plus
the three application-role URLs; their database names are templates only). One run takes about fifteen
seconds.

```sh
npm run backup:keygen -- --out "$PWD/.local/backup-keys/restore-drill.key"
npm run restore:drill -- --report-md docs/reports/p12-4-restore-drill.md --report-json docs/reports/p12-4-restore-drill.json
```

It creates `running_tracker_restore_drill_<suffix>_source` and `..._target`, never touches
`running_tracker`, `running_tracker_test` or `running_tracker_load_test`, and refuses any other name,
any non-loopback host, and any wrong login. The source is migrated one migration short of the
repository, so the restore proves the catch-up; after the backup it is upgraded to the repository's
schema, like a release deployed between the backup and the loss, so the access journal exists on it.
Scenario: runs A (owner-deleted after the backup), B (annual-retention-deleted after the backup), C
(survivor), and D (created and deleted after the backup). On C, after the backup: one share revoked and
one narrowed through the share API's own functions, and one member deactivated by SQL; two more people
are left untouched. The report states who could read C on the lost source, in the restored backup and
after recovery, as the runtime role under row-level security.
It exits 0 only if every check passes; otherwise it exits 1, keeps both databases, and the report says
which step failed. Flags: `--current-schema` (source at the repository's latest migration), `--keep`
(keep the databases after success), `--suffix`, `--work-dir`. `npm run restore:drill -- --cleanup`
drops every leftover drill database (and only those).

Opt-in integration tests (`apps/api/test/backup-restore.integration.test.ts`) run the same machinery
and also prove the failure paths against the real database: a damaged ciphertext, a damaged tag (no
`pg_restore` is even started), truncation and a wrong key; a migration checksum mismatch; a malformed
journal file; an access journal file that tries to grant access (rejected before any restore); an extra
replay of the access journal; and an application session still connected. They are skipped when `RESTORE_DRILL_ADMIN_URL`
is unset, which includes the repository's CI.

### Reading a drill report

The report separates **VERIFIED IN LOCAL DRILL** from **NOT VERIFIED / REQUIRES REAL TARGET
ENVIRONMENT**. Its RPO figure is `simulated_loss_at - backup_created_at` (seconds, because the drill
takes the backup moments earlier), its RTO figure is loss to verification complete, and both are
compared with 24 hours and 4 hours. They demonstrate that the procedure works and how long its parts
take for one tiny database on one workstation. They are not the production RPO or RTO.

## Failure modes and honest limits

- A lost or leaked key: lost means no backup can be read; leaked means whoever holds it and a backup can
  read the whole database. There is no rotation yet.
- A backup directory on the same disk as PostgreSQL, or with the key next to it, is not an off-host
  design, whatever the commands report.
- A restore of a large database is a single `pg_restore` stream (no parallelism with a pipe); its time
  scales with data and has not been measured beyond the drill's tiny database.
- Backups contain data deleted after them, and access revoked after them, until reapplication.
- Recovery fails closed: access granted after the backup is not reconstructed and has to be granted again,
  and a share revoked and then granted again before the loss is removed again.
- Deletions and restrictions committed but not yet exported when a node is lost are lost with it (one
  export interval while the exporter is healthy, unbounded while it is failing).
- Deletions committed but not yet exported when the node is lost are lost with it (journal recovery
  point, ADR-0037).
- Retention trusts the timestamp in the file name and does not check that a kept backup restores.
