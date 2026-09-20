# Running Tracker

P00–P01.1 establish a reproducible React/Express 5/PostGIS workspace. Business tables, authentication, RLS, GPS ingestion, streaming, and maps start in later stages.

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
npm run db:migrate:test
npm run test:integration
```

`test:integration` loads and validates `TEST_DATABASE_URL` before creating the app or pool, rejects a non-test database URL, and executes against real PostgreSQL/PostGIS. The API and test SQL checks receive the same pool. CI deliberately points `DATABASE_URL` at a different, absent database while `TEST_DATABASE_URL` points at the service database.

## Database migrations

`npm run db:migrate` applies sorted SQL files from `db/migrations`. The runner:

- serializes concurrent runners with a PostgreSQL advisory lock;
- records file name and SHA-256 in `schema_migrations`;
- normalizes SQL line endings to LF before hashing, with `*.sql text eol=lf` enforced by Git;
- rejects a changed migration that was already applied;
- applies each new file atomically.

P01 contains only the PostGIS extension migration. Product schema and database roles belong to P02.

## Configuration

Configuration is loaded and validated before the API app and pool are created. `.env.example` contains only fixed local-development fixtures. Do not reuse those credentials outside the local Compose environment.

`DB_CONNECTION_TIMEOUT_MS` bounds pool acquisition/connection. `DB_QUERY_TIMEOUT_MS` separately bounds the readiness query; timeout destroys that client so a hung query cannot occupy the pool. `SHUTDOWN_TIMEOUT_MS` bounds HTTP drain plus pool closure before the controlled fallback terminates the process.

`createApp({ config, pool, clock })` has no startup side effects. The executable entrypoint calls `main.ts`, which owns configuration loading, dependency construction, port binding, and signal handling.

Architecture and execution evidence are in `docs/`, especially `docs/SDD.md`, `docs/implementation-plan.md`, and `docs/progress.md`.
