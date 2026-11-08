# Runbook: single-host deployment

Audience: the operator who deploys and runs the service.
Design: ADR-0043. Profile: `infra/compose/docker-compose.production.yml`.

## Status: what this proves and what it does not

The profile has been brought up on a developer workstation with throwaway secrets and a
self-signed certificate, and `npm run deploy:verify` asserted its properties (listed under
"Verify a deployment"). It has **not** been run on a real host, behind real DNS, with a real
certificate authority, or with a production identity provider.

**Sign-in is OpenID Connect (P12.1, ADR-0046) and has been verified only against a test provider,
never a real one** (see `docs/runbooks/identity-provider.md`). Local login is forbidden in
production, so until a client is registered at a provider and people are provisioned, nobody can sign
in. A backup/restore drill (P12.3) has been performed on a workstation (see
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
   `PUBLIC_ORIGIN` (`https://` plus the name, plus `:port` if not 443), `OIDC_ISSUER_URL`,
   `OIDC_CLIENT_ID`, `SECRETS_DIR`, `TLS_DIR` and `DELETION_JOURNAL_HOST_DIR`. The file contains no
   secrets.
2. Generate the secrets:

   ```sh
   npm run deploy:secrets -- --dir /etc/running-tracker/secrets
   ```

   It writes six files: the PostgreSQL administrator password, four database URLs (administrator,
   owner, runtime, maintenance) each with its own random 256-bit password, and the cursor signing
   key. The directory is created `0700` and the files `0444`: containers run as unrelated uids and
   must read a bind-mounted file, so the directory is the access boundary. Keep it out of version
   control, images, and application-host backups. The command refuses to overwrite an existing set.
3. Register a client at your identity provider with the redirect URI
   `<PUBLIC_ORIGIN>/api/auth/callback` and place its secret in `<SECRETS_DIR>/oidc-client-secret`
   (`docs/runbooks/identity-provider.md`). The provider issues it, so step 2 does not create it, and
   Compose refuses to start the API without the file.
4. Put the certificate in `TLS_DIR`.
5. Make the journal directory writable by uid 1000 (`chown 1000:1000 <dir>`); the API refuses to
   start if it cannot write there.

## Maintenance SQL budgets (ADR-0069)

Production Compose passes `MAINTENANCE_DB_STATEMENT_TIMEOUT_MS` (default 60000, integer 1..300000)
and `MAINTENANCE_DB_LOCK_TIMEOUT_MS` (default 5000, integer 1..60000) to the API. Lock must not exceed
statement; zero cannot disable either. Set overrides in the private operator environment file and
recreate/restart the API to apply them to new connections. Runtime request budgets are independent.

These are PostgreSQL per-statement limits, including lock waits. A timeout fails the current cycle;
workers roll back and the existing scheduler can try a later cycle. Watch `maintenance_cycles_total`
error counts, `maintenance_cycle_duration_seconds` and `maintenance_last_success_timestamp_seconds`
when tuning against actual task costs. The defaults have local regression evidence, not production
capacity evidence. They do not bound a complete multi-statement job or journal filesystem I/O, and
do not provide fair selection beside a repeatedly failing candidate.

## Maintenance failure retries (ADR-0070)

Each task independently backs off after a rejected cycle, doubling its retry
ceiling to 300 seconds (or its normal interval if longer). Equal jitter chooses
half to all of that ceiling, with the normal interval as a floor. A fulfilled
cycle, including idle/blocked results, resets normal polling. Retry timers start
after settlement; a stuck filesystem operation still owns its worker. Backoff
state is process-local and resets on API restart. There is no attempt limit.

Scrape `maintenance_consecutive_failures{task}` and
`maintenance_retry_delay_seconds{task}` alongside cycle errors and last success.
The delay is the selected pending retry interval, not remaining seconds; zero
means no failure timer is pending, including during an attempt or after stop.
Default `maintenance.cycle.failed` logs contain `count` and `retryDelayMs`;
`maintenance.cycle.recovered` records the preceding failure count once.

For example, investigate `maintenance_consecutive_failures >= 3` sustained for
five minutes; choose thresholds for each task's normal cadence. Check SQLSTATE
and pool pressure for SQL failures, directory permissions/storage health for
journal failures. A process restart clears the streak and cannot certify recovery:
require a new successful cycle and, for journals, actual off-host files/backlog
checks. A successful idle cycle proves dependency access, not backlog progress.
One failing summary worker backs off the whole summary task; candidate fairness
and per-run quarantine remain separate work.

## Deploy and update

```sh
docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> up -d --build --wait
```

Order is enforced by Compose health conditions: PostgreSQL healthy, then `db-init` (creates or
updates the four logins and PostGIS, applies pending migrations, exits), then the API, then the
proxy. `db-init` is idempotent, so an update is the same command: it migrates first, then replaces
the API. It holds the administrator credential; no other service mounts it.

### Optional archive map token

`VITE_MAPBOX_ACCESS_TOKEN` (in the env file or the shell that runs Compose) is passed to the proxy
image build and inlined into the frontend bundle by Vite. It is **browser-visible by design**: every
visitor can read it, so use only a Mapbox public (`pk.`) token, restrict its scopes at Mapbox to the
minimum, and restrict its allowed URLs to `PUBLIC_ORIGIN`. Never put a secret token here. There is no
runtime configuration: a new or changed value takes effect only after an image rebuild
(`up -d --build`). Unset or empty builds fine and the Archive tab shows its "Map provider not
configured" notice. The same variable works for the local transport profile. `.env` files stay out of
the build context, so only this one value is passed.

An API restart ends every open live stream, but not the sessions: they are stored in
PostgreSQL (ADR-0080), so a browser's cookie keeps working after the restart until its original
expiry, and clients reconnect and recover from stored data. A sign-in that is at the identity
provider during the restart also completes afterwards: pending OIDC logins are stored in PostgreSQL
(ADR-0081). The in-memory rate limits and admission counters do not survive a restart. While the
database cannot answer a session check within `SESSION_STORE_TIMEOUT_MS`, requests get `503
SESSION_STORE_UNAVAILABLE` (no one is signed out), and sign-in answers `503
LOGIN_TEMPORARILY_UNAVAILABLE` at `/api/auth/login` or `sign_in_error=unavailable` at the callback.
Every API instance on one database should use the same `SESSION_STORE_MAX_ENTRIES` and
`OIDC_STORE_MAX_ENTRIES`, and the same `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, client secret and
`OIDC_REDIRECT_URI` (the stable public origin, not an instance address): then an OIDC callback may
reach any instance. This is not general multi-replica support: login admission, run-search
admission, the weekly insight queue, the archive tile cache and metrics are still per process
(ADR-0081, Explicit boundaries), and this profile runs one API container.

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
- `POST /api/session` answers 404 (there is no development login) and `GET /api/auth/login` answers 302 to
  the provider, or 503 `IDENTITY_PROVIDER_UNAVAILABLE` when the provider cannot be reached.

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

Every container's log is rotated at 10 MiB x 5 files. The proxy access log (stdout) records client address,
host, method, path and protocol (never the query string), status, response bytes, upstream address,
request time and `connection=N`. The query string is left out because the OIDC callback carries a one-time `code` and
`state` in it; tile URLs contain tile coordinates and period, never GPS points.

The proxy **error log** (stderr) passes an allow-listed sanitizer before Docker stores it (ADR-0062). nginx's own
entries quote the request line, upstream URI and referrer of a failed request, and nginx cannot reformat them, so
nginx writes to a private pipe and only rebuilt lines reach stderr:

```text
2026/10/22 08:09:26 [error] 34#34: *39 event=request_body_too_large bytes=262144
2026/10/22 08:09:31 [error] 35#35: *41 event=upstream_connect_failed errno=111 phase=upstream_connect
```

- Join an entry to its request with the access line that has the same number: `*39` matches `connection=39`. That
  line holds the path, status and timing.
- `event=unclassified` is an nginx message outside the sanitizer's table. Its text is withheld on purpose. Investigate
  it outside production with a debug configuration.
- `nginx-error-log: event=...` lines come from the boundary itself. `unrecognized_record`, `overlong_record` and
  `truncated_record` mean input it would not parse, reported by size only.
- `sanitizer_stopped action=stopping_nginx` means the sanitizer failed. The proxy then exits with status 70 and
  restarts (`restart: unless-stopped`), and nginx never falls back to raw logging.
- Configuration errors at startup (`nginx -t`) still print unfiltered, because nothing listens yet.
- `npm run deploy:verify` sends unique fake callback values through failing and succeeding requests on both
  listeners, then fails if any appears in the stored streams or in a writable file
  (`errorLogQueryExposedOnNginxError` must be `false`). `npm run proxy:verify-error-log` exercises the boundary's
  failure modes on the image.
- Error entries written by images built before ADR-0062 may still be in existing logs. Treat them as holding the
  callback query until they rotate out, or delete them.
- Running the image with a different entrypoint bypasses the boundary.

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
| Sign-in against a real identity provider (the mechanism is verified against a test provider only, ADR-0046), provider-side logout, the remaining process-local state before running several API replicas (login and run-search admission, the weekly insight queue, the archive tile cache, metrics; ADR-0081), provisioning through the application | operator / later |
| A scheduled daily backup on this host, off-host backup storage, key custody, and a backup-age alert (the commands and a local restore drill exist, P12.3; production RPO/RTO is not established) | operator |
| Sessions after a restore: by design none survives (backups exclude session rows and the restore runs `restore:clear-sessions`, ADR-0080), so everyone signs in again. Revoked shares and deactivated memberships are restored by the access-restriction journal (P12.4, ADR-0045) | none |
| Full Content-Security-Policy (only `frame-ancestors` is set; a script/style/connect policy must be validated against the Mapbox map in a browser) | before public launch |
| General request rate limiting at the proxy. Only sign-in initiation is limited (ADR-0048: five per minute per direct address with burst four at the edge, plus process-wide admission in the API); no other route is, because there is no measured per-client traffic model to size it | before public launch |
| Encryption of database traffic inside the Docker network (single host; unencrypted by design here) and of the data volume at rest (a host/disk concern) | operator |
| Image publication, signing, vulnerability scanning, host patching | operator |
| Confirming the journal directory is really off-host | operator |
