# Running Tracker

P00–P01 establish a reproducible React/NestJS/PostGIS workspace. Business tables, authentication, RLS, GPS ingestion, streaming, and maps start in later stages.

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

`test:integration` uses `running_tracker_test`, rejects a non-test database URL, and executes against real PostgreSQL/PostGIS. CI runs the same portable commands with a PostGIS service container.

## Database migrations

`npm run db:migrate` applies sorted SQL files from `db/migrations`. The runner:

- serializes concurrent runners with a PostgreSQL advisory lock;
- records file name and SHA-256 in `schema_migrations`;
- rejects a changed migration that was already applied;
- applies each new file atomically.

P01 contains only the PostGIS extension migration. Product schema and database roles belong to P02.

## Configuration

Configuration is validated at API startup. `.env.example` contains only fixed local-development fixtures. Do not reuse those credentials outside the local Compose environment.

Architecture and execution evidence are in `docs/`, especially `docs/SDD.md`, `docs/implementation-plan.md`, and `docs/progress.md`.

