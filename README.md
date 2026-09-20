# Running Tracker

P00–P02A establish a reproducible React/Express 5/PostGIS workspace plus the identity/organization schema, separated database roles, transaction-local tenant context, and baseline RLS. Run data, authentication, GPS ingestion, streaming, and maps remain later stages.

## Prerequisites

- Node.js 24 LTS (`>=24.11.0 <25`) with ICU
- npm 11 (`>=11.6.0 <12`)
- Docker Engine/Desktop with Compose v2
- free local ports: API `3000`, web `5173`, PostGIS `5433`

The database uses `5433` because `5432` was already occupied on the initial Windows workstation. The Compose service is bound to `127.0.0.1` only.

## Start from a clean checkout

```powershell
Copy-Item .env.example .env
npm ci
npm run db:up
npm run db:bootstrap
npm run db:bootstrap:test
npm run db:migrate
npm run db:migrate:test
npm run dev
```

On POSIX systems, replace the first command with `cp .env.example .env`.

- Web: http://127.0.0.1:5173
- API liveness: http://127.0.0.1:3000/api/health/live
- API readiness: http://127.0.0.1:3000/api/health/ready

The Vite server proxies `/api` to the API, so browser requests remain same-origin in development. Liveness describes the HTTP process only; readiness returns `503` when PostgreSQL cannot be reached.

Stop the local database without deleting its named volume:

```powershell
npm run db:down
```

## Verification

```powershell
npm run verify
npm run db:up
npm run db:bootstrap:test
npm run db:migrate:test
npm run test:integration
```

`test:integration` loads and validates `TEST_DATABASE_URL` before creating the app or pool, rejects a non-test database URL, and executes security assertions through `running_tracker_runtime`. Fixtures use `TEST_MIGRATION_DATABASE_URL`, never broaden runtime privileges. CI deliberately points `DATABASE_URL` at a different, absent database while `TEST_DATABASE_URL` points at the service database.

`db:bootstrap` is the only privileged setup step. It creates PostGIS and three non-superuser roles, restricts database/schema creation, and transfers the existing migration metadata table to the migration owner. Normal API startup never invokes bootstrap or reads bootstrap/migration credentials.

## Database migrations

`npm run db:migrate` applies sorted SQL files from `db/migrations` with `MIGRATION_DATABASE_URL`; the API uses only `DATABASE_URL`. The runner:

- serializes concurrent runners with a PostgreSQL advisory lock;
- records file name and SHA-256 in `schema_migrations`;
- normalizes SQL line endings to LF before hashing, with `*.sql text eol=lf` enforced by Git;
- preflights the complete applied history before running any pending file: missing/changed files, gaps, out-of-order history, and backfilled file names are rejected;
- applies each new file atomically.

The privileged bootstrap owns extension/role creation. `running_tracker_owner` owns application objects and runs migrations; `running_tracker_runtime` is the API login; `running_tracker_maintenance` has CONNECT only until a later maintenance use case grants a narrower capability.

## P02A tenant transactions and access

`withTenantTransaction(pool, { userId, orgId }, callback)` validates canonical UUIDs, acquires one client, starts a transaction, and sets `app.user_id`/`app.org_id` with transaction-local `set_config`. The callback must use the supplied client and must finish before an HTTP response or SSE lifetime begins. A callback error is preserved even if rollback also fails; that connection is destroyed. A COMMIT transport error is reported as an unknown outcome and the connection is destroyed without a misleading rollback attempt.

The P02A runtime matrix is intentionally narrow:

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `users` | current user only, with active membership in the current organization | denied |
| `organizations` | current organization only, with active membership | denied |
| `memberships` | current user's active membership in the current organization only | denied |
| `schema_migrations` | denied | denied |

Missing/malformed context, absent membership, and inactive membership expose no rows. Setting these GUCs is not a security boundary against arbitrary SQL run with runtime credentials; the trusted application/session boundary supplies them, while real HTTP authentication remains P03.

## Configuration

Configuration is loaded and validated before the API app and pool are created. `.env.example` contains clearly labelled fixed local development/test credentials for bootstrap, migration owner, runtime, and maintenance roles. Use separate managed secrets outside local development.

`DB_CONNECTION_TIMEOUT_MS` bounds pool acquisition/connection. `DB_QUERY_TIMEOUT_MS` separately bounds the readiness query; timeout destroys that client so a hung query cannot occupy the pool. `SHUTDOWN_TIMEOUT_MS` bounds HTTP drain plus pool closure with monotonic elapsed time before the controlled fallback terminates the process. UTC business-event time remains a separate clock capability.

`createApp({ config, pool, clock })` has no startup side effects. The executable entrypoint calls `main.ts`, which owns configuration loading, dependency construction, port binding, and signal handling.

Architecture and execution evidence are in `docs/`, especially `docs/SDD.md`, `docs/implementation-plan.md`, and `docs/progress.md`.
