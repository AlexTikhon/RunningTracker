# Runbook: single-host deployment

Audience: the operator who deploys and runs the service.
Design: ADR-0043. Profile: `infra/compose/docker-compose.production.yml`.

## Status: what this proves and what it does not

The profile has been brought up on a developer workstation with throwaway secrets and a
self-signed certificate, and `npm run deploy:verify` asserted its properties (listed under
"Verify a deployment"). It has **not** been run on a real host, behind real DNS, with a real
certificate authority, or with a production identity provider.

**This deployment cannot sign anyone in.** Local login is forbidden in production and the identity
provider integration (P12.1) does not exist yet, so the application starts, serves the web app and
answers health checks, but `POST /api/session` returns 404. Do not publish it as a service until
P12.1 is done. A backup/restore drill (P12.3) has been performed on a workstation (see
`docs/runbooks/backup-and-restore.md`), but no backup schedule, off-host storage, or restore has been
verified on a real host, so no production RPO/RTO is claimed.

## Prerequisites

- A Linux host with Docker Engine and Compose v2 (the profile was exercised on Docker 29.7.2 with
  Compose v2 on Windows Docker Desktop; Linux-specific behaviour, such as bind-mount ownership, is
  described below but was not run).
- A DNS name pointing at the host, and a certificate for it as `fullchain.pem` and `privkey.pem` in
  one directory. Issuing and renewing it (ACME or otherwise) is yours; nothing here contacts a CA.
- Storage for the deletion journal that **survives loss of this host**: a separate disk, a network
  volume, or another machine's mount. The application cannot check this; a directory on the same
  disk as PostgreSQL defeats the purpose (ADR-0037).
- Inbound 80 and 443 only. PostgreSQL, the API, and the metrics listener publish no host port.

## One-time setup

1. Copy `infra/compose/production.env.example` to a private path and set `PUBLIC_HOSTNAME`,
   `PUBLIC_ORIGIN` (`https://` plus the name, plus `:port` if not 443), `SECRETS_DIR`, `TLS_DIR`
   and `DELETION_JOURNAL_HOST_DIR`. The file contains no secrets.
2. Generate the secrets:

   ```sh
   npm run deploy:secrets -- --dir /etc/running-tracker/secrets
   ```

   It writes six files: the PostgreSQL administrator password, four database URLs (administrator,
   owner, runtime, maintenance) each with its own random 256-bit password, and the cursor signing
   key. The directory is created `0700` and the files `0444`: containers run as unrelated uids and
   must read a bind-mounted file, so the directory is the access boundary. Keep it out of version
   control, images, and application-host backups. The command refuses to overwrite an existing set.
3. Put the certificate in `TLS_DIR`.
4. Make the journal directory writable by uid 1000 (`chown 1000:1000 <dir>`); the API refuses to
   start if it cannot write there.

## Deploy and update

```sh
docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> up -d --build --wait
```

Order is enforced by Compose health conditions: PostgreSQL healthy, then `db-init` (creates or
updates the four logins and PostGIS, applies pending migrations, exits), then the API, then the
proxy. `db-init` is idempotent, so an update is the same command: it migrates first, then replaces
the API. It holds the administrator credential; no other service mounts it.

An API restart ends every open live stream and, until P12.1, every session (the store is
in-memory). Clients reconnect and recover from stored data.

## Verify a deployment

`npm run deploy:verify` does this on a scratch stack (ports 19080/19443, torn down afterwards).
Against a real host, check the same things by hand:

- `https://<name>/api/health/ready` answers 200 and the connection negotiated HTTP/2.
- `http://<name>/...` answers 301 to the `PUBLIC_ORIGIN` URL.
- Responses carry HSTS, `nosniff`, a `frame-ancestors 'none'` policy, and a Referrer-Policy on the
  page, on `/assets/`, and on `/api/`.
- `docker ps` shows only the proxy publishing ports; `docker inspect` shows memory, CPU, pids
  limits, dropped capabilities, and a read-only root file system on API and proxy.
- Secret values do not appear in `docker inspect` output or `docker compose logs`.
- The three application logins are not superuser, not `BYPASSRLS`, cannot create databases or roles.

## Resource limits

| Service | Memory | CPUs | Notes |
|---|---|---|---|
| postgres | 2 GiB (`POSTGRES_MEM_LIMIT`) | 4 | `shared_buffers=512MB`, `max_connections=40`, `shm_size=256m` |
| api | 512 MiB (`API_MEM_LIMIT`) | 2 | Node heap capped at 320 MiB; DB pool 10 runtime + 4 maintenance |
| proxy | 128 MiB (`PROXY_MEM_LIMIT`) | 1 | |

These are starting values chosen from the P11 measurements (API resident memory peaked near 217 MiB
under the heaviest tile load), **not** a capacity claim. The P11 load runs were made on one
workstation against a process, not against these limits; they have not been re-run under them. One
query shape (the set of readable runs built per statement, ADR-0042) holds a hash table that
`work_mem` does not bound; watch PostgreSQL memory if organizations grow far beyond the measured
one. Raise limits with the environment variables; do not remove them.

Every container's log is rotated at 10 MiB x 5 files. The proxy access log records client address,
host, request line and status; tile URLs contain tile coordinates and period, never GPS points.

## Metrics

The API serves Prometheus text on port 9464 inside the container network only. It has no
authentication and is not published. Scrape it from a container attached to the `edge` network, or
add a scraper service to this file; do not publish the port.

## Rotate database credentials

Application logins (owner, runtime, maintenance):

```sh
npm run deploy:secrets -- --dir /etc/running-tracker/secrets --rotate-roles
docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> run --rm --no-deps db-init
docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> up -d --no-deps --force-recreate --wait api
```

`--rotate-roles` keeps the administrator password and the cursor key and replaces only the three
role passwords; `db-init` applies them to PostgreSQL; the recreated API reads the new files. Between
the second and third command the running API still holds connections opened with the old runtime
password, and new connections it tries will fail, so run them back to back. `deploy:verify`
exercises this sequence, including that the old runtime password is rejected afterwards.

Do not use `--force` on a running deployment: it also regenerates the administrator password, but
PostgreSQL only reads that at first initialization, so the bootstrap job would then be locked out.
Change the administrator password in PostgreSQL (`ALTER ROLE running_tracker_admin PASSWORD ...`)
and then update `postgres-password` and `bootstrap-database-url` to match. Rotating the cursor key
invalidates outstanding pagination cursors; clients recover with a fresh snapshot.

## Renew the certificate

Replace `fullchain.pem` and `privkey.pem` in `TLS_DIR`, then:

```sh
docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> exec proxy nginx -s reload
```

`deploy:verify` confirms the reload succeeds in the read-only, capability-dropped proxy and traffic
continues. It cannot exercise a real renewal.

## Backups and restore

The production profile does **not** back up the database by itself, and it deliberately has no backup
encryption key among its secrets: the key must live apart from the host that stores the encrypted
backups. The operator runs `npm run backup:create` / `backup:prune` from a scheduled job (systemd timer
or cron examples in `docs/runbooks/backup-and-restore.md`) with an administrator database login and a
key file kept elsewhere, copies or mounts the backup directory **off this host**, and monitors backup
age through the node_exporter textfile that `--metrics-file` writes. The scheduler, the off-host
storage, the key custody, and the alert are not provided by the profile and have not been exercised on
a real host. The restore order (offline, restore, migrate, reapply the deletion journal, restore
current permissions, open) and the local drill are in the same runbook.

## Not done here, and why it matters

| Gap | Owner |
|---|---|
| Production sign-in (identity provider, sessions, logout, expiry) | P12.1; needs a provider decision and credentials |
| A scheduled daily backup on this host, off-host backup storage, key custody, and a backup-age alert (the commands and a local restore drill exist, P12.3; production RPO/RTO is not established) | operator |
| Restoring current shares and memberships from an old backup | P12.4 |
| Full Content-Security-Policy (only `frame-ancestors` is set; a script/style/connect policy must be validated against the Mapbox map in a browser) | before public launch |
| Request rate limiting at the proxy (no measured per-client traffic model to size it) | before public launch |
| Encryption of database traffic inside the Docker network (single host; unencrypted by design here) and of the data volume at rest (a host/disk concern) | operator |
| Image publication, signing, vulnerability scanning, host patching | operator |
| Confirming the journal directory is really off-host | operator |
