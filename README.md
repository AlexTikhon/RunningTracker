# Running Tracker

P00–P02 establish a reproducible React/Express 5/PostGIS workspace and the complete database schema/ACL boundary. P03 is complete: it provides the development/test session boundary, strict shared contracts, atomic run creation and lifecycle commands, ACL-aware run reads/share management, and clock-driven automatic finishing. P04 is complete: bounded point ingestion, revision-bound raw history, deterministic GPS simulation, and test-safe post-commit response-loss verification are implemented. P05 is complete: the API-backed runner screen, durable IndexedDB point/request buffer, retrying upload worker, fenced cross-tab writer lease, and shared Geolocation/simulator foreground capture path are implemented. Streaming, production identity, geometry processing, and maps remain later stages.

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

## Local session fixture

Local login is opt-in. In `.env`, set `LOCAL_AUTH_ENABLED=true` and list only fixture identities in `LOCAL_AUTH_USER_IDS`. The example keeps it disabled. The API refuses local auth in `APP_ENV=production` before constructing the database pool or opening a listener.

The bootstrap flow is:

1. `POST /api/session` with exact configured `Origin`, `Content-Type: application/json`, and `{ "userId": "<allowlisted UUID>" }`.
2. Retain the opaque `HttpOnly`, `SameSite=Strict`, `Path=/` cookie and the returned `csrf.token` in memory.
3. Send the token in `x-csrf-token` plus the exact configured `Origin` on authenticated mutations.
4. `GET /api/session` refreshes identity/expiry/CSRF data; `DELETE /api/session` revokes the server record and clears the cookie.

`SESSION_COOKIE_SECURE=false` is an explicit local HTTP exception allowed only in development/test. Deployed HTTPS uses `Secure`. The local store is process-memory-only, bounded by `SESSION_STORE_MAX_ENTRIES`, and loses all sessions on restart; the production identity/provider integration remains P12.

## Runner control screen

After a local session exists, the web app discovers it through same-origin `GET /api/session`. Enter an organization UUID to create a run, then use the revision-aware pause, resume, and finish controls. Each mutation carries the session CSRF token, validates the shared response contract, and disables concurrent controls until the server confirms the result.

The screen exposes recording, network, upload, and server/error state separately. Before a start or lifecycle mutation reaches the network, P05.2 stores its exact idempotency identity and payload in IndexedDB under the authenticated user. It removes that request only in the local transaction that records the server-confirmed run snapshot. Offline requests and unknown transport outcomes therefore survive reload and can use “Retry same request” after reconnection.

The same user/organization/run-scoped database atomically allocates a positive bigint `seq` and stores the canonical point. IndexedDB uses a zero-padded sequence index so bounded reads retain numeric bigint order without converting `seq` to JavaScript `number`.

P05.3 uploads at most 100 ordered points at a time and deletes only the exact sequence set after a validated acknowledgement accounts for every sent point. Network/5xx/408/425/429 outcomes retain the batch and use capped exponential full-jitter backoff; `Retry-After` is honoured for rate limiting. Other 4xx responses and incomplete success acknowledgements stop that run's worker, preserve its points, and trigger a best-effort authoritative run read. A stale lifecycle command is cleared only when a `CONTROL_REVISION_CONFLICT` can be reconciled to a successfully read and durably stored server run.

P05.4 adds a user-scoped IndexedDB lease with a per-tab UUID and monotonically increasing fencing token. One tab atomically acquires and renews the 15-second lease; stale owners cannot renew or release a successor's token. Non-owner tabs keep controls and upload work read-only and expose explicit ownership retry. This is a same-origin tab guarantee, not a distributed offline device lock; cross-device races still fail through the server's one-active-run constraint, command revisions, and canonical point conflicts.

P05.5 connects device Geolocation and the seeded `normal` simulator through one capture-source interface. Capture runs only while the server-confirmed run is recording and this tab owns the lease. Each start/resume/recovery session atomically allocates a durable `segmentId`; every source callback is serialized, rechecks ownership, and verifies the fencing token again inside the IndexedDB point transaction. Stopped generations cannot persist late callbacks, and a 100-measurement queue limit fails visibly instead of growing without bound. Offline capture remains buffered and wakes the existing uploader after every durable append. No Mapbox token contract is present in tracked configuration and no token was supplied, so recording and tests remain independent of an external map; actual device permission/background behavior still requires browser/device QA.

## Shared API contracts

`packages/contracts` is transport-only and has no Express or PostgreSQL dependency. It exports strict Zod schemas and inferred types for session/error responses, runs, commands, shares, points, track pages, archive/nearby reads, and the `live.state` SSE payload. PostgreSQL `bigint` revisions and point sequences cross HTTP as bounded decimal strings; URL numeric query inputs are parsed and range-checked by their query schemas.

The generated OpenAPI 3.1 artifact is `packages/contracts/openapi/openapi.json`. `npm run build --workspace=@running-tracker/contracts` regenerates it from the runtime schemas and ordinary-HTTP route metadata. `/live` is intentionally documented separately in `packages/contracts/sse.md`, including connection-local `streamId`/`sequence`, session-expiry disconnects, and reconnect recovery. The implemented P03 routes use the shared ordinary-HTTP contracts; SSE remains a protocol contract for P08.

P04.1 resolves D01 with one strict `PointInput`: required `seq`, `segmentId`, `recordedAt`, `longitude`, `latitude`, and `accuracyM`, with no nullable/extra fields. Parsing canonicalizes `seq` through PostgreSQL-bigint decimal form, every `-0` to `0`, and UTC `recordedAt` to millisecond precision using the same nearest-millisecond rounding as `timestamptz(3)`. The canonical values are used for validation, retry comparison, persistence, and the shared public type.

## Point ingestion

`POST /api/orgs/:orgId/runs/:runId/points` accepts `{ "points": PointInput[] }` under the existing session, Origin/CSRF, membership, tenant transaction, and RLS boundary. A request contains 1–100 entries and remains subject to the 64 KiB JSON limit; a run may contain at most 50,000 unique points. `seq` defines deterministic track order, so request order, equal timestamps, late lower sequences, and device timestamps outside the live-freshness window are accepted as raw history.

The service locks the owned run, compares every repeated `seq` with its canonical stored payload, increments `data_revision` once only when at least one unique point is new, and inserts all new rows set-wise with that `ingested_revision`. Exact retries return `200` without a revision change; conflicting payloads return `409 POINT_CONFLICT`. Recording and paused runs accept points. Finished runs accept new points through `finished_at + 24 hours`; after that, only exact retries are acknowledged (`409 UPLOAD_WINDOW_CLOSED` for new points). `purging`/`purged` raw state returns `410 RAW_HISTORY_UNAVAILABLE`. The response is `{ dataRevision, insertedCount, duplicateCount }`, and HTTP acknowledgement occurs only after the surrounding PostgreSQL transaction commits.

## Raw point history

`GET /api/orgs/:orgId/runs/:runId/points?limit=1000&cursor=...` returns canonical raw points in ascending bigint `seq` order. The default and maximum page size is 1,000. The opaque cursor is bound to the organization, run, last sequence, and `data_revision`; if that revision changes between pages, the API returns `409 HISTORY_REVISION_CHANGED` and the client restarts from the first page.

The run revision/raw state and `limit + 1` keyset page are read in one PostgreSQL statement snapshot, so a page cannot combine different committed revisions. Owners can read active or finished raw history; a non-owner needs `can_read_history` on a finished run. `can_read_live` alone is intentionally insufficient. Authorized `purging`/`purged` history returns `410 RAW_HISTORY_UNAVAILABLE`; inaccessible and missing runs return the same `404 RUN_NOT_FOUND`.

## Deterministic GPS simulator

`@running-tracker/fixtures` generates canonical `PointInput` captures and upload attempts from a uint32 seed and UTC start instant. Its explicitly advanced virtual clock provides stable FIFO timer ordering without wall-clock sleeps. The named scenarios are `normal`, `duplicates`, `reordered`, `delayed-batch`, `dropped-response`, `clock-jump`, and `gps-spike`.

The CLI replays the resulting virtual timeline as JSON Lines without network or database I/O:

```powershell
npm run simulate:gps -- --scenario reordered --seed 42
npm run simulate:gps -- --list
```

`dropped-response` marks an upload attempt as `drop-after-commit` and emits an exact retry. The P04.5 API hook is a separately injected test-only dependency: `createApp` rejects it unless `APP_ENV=test`, there is no environment/header/endpoint activation path, and the points route evaluates it only after PostgreSQL confirms `COMMIT` and before sending the HTTP result. The integration proof observes a transport-level `ECONNRESET`, verifies the committed rows and revision through SQL, retries the exact batch, reads raw history, and finishes the run.

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

`test:integration` validates runtime, migration, and maintenance URLs before creating any pool: each URL must use PostgreSQL, authenticate as its exact role, target a database ending in `_test`, and resolve to the same host, normalized port, and database. Fixture setup then verifies `current_database()` and `current_user` on its dedicated owner client before any mutation. Security assertions execute through `running_tracker_runtime`; runtime privileges are never broadened. CI deliberately points `DATABASE_URL` at a different, absent database while the three test URLs point at the service database.

`db:bootstrap` is the only privileged setup step. It creates PostGIS and three non-superuser roles, restricts database/schema creation, and transfers the existing migration metadata table to the migration owner. Normal API startup never invokes bootstrap or reads bootstrap/migration credentials. The maintenance login has no direct table DML or DDL: it has schema usage plus EXECUTE only on the owner-defined `app_private.auto_finish_runs(timestamptz)` capability.

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

P03.1 now resolves that HTTP boundary for local development/test: `userId` is accepted only from a verified server-side session. A route may select `orgId`, but `withAuthenticatedTenantTransaction` validates it, opens `withTenantTransaction` under `running_tracker_runtime`, rechecks active membership inside that same transaction, and runs subsequent SQL on the same client. External production authentication remains P12.

## Configuration

Configuration is loaded and validated before the API app and pools are created. `.env.example` contains clearly labelled fixed local development/test credentials for bootstrap, migration owner, runtime, and maintenance roles. `DATABASE_URL` must authenticate as `running_tracker_runtime`; `MAINTENANCE_DATABASE_URL` must authenticate as `running_tracker_maintenance` and target the same host, normalized port, and database. Use separate managed secrets outside local development.

`RUN_AUTO_FINISH_INTERVAL_MS` is the interval between settled maintenance cycles and defaults to 60 seconds. It is an implementation parameter, not a tighter product guarantee than “the first maintenance cycle after `created_at + 24 hours`.” Each cycle passes one injected UTC timestamp to the database function. The function atomically changes only eligible `recording`/`paused` runs to `finished`, sets `finished_at` to that timestamp, and increments `data_revision`; it does not change `control_revision`, `raw_state`, or `run_commands`. Conditional PostgreSQL updates make concurrent commands and repeated workers idempotent. Startup and signal handling remain in `main.ts`; shutdown stops future maintenance timers before closing HTTP and both pools within the shared deadline.

`DB_CONNECTION_TIMEOUT_MS` bounds pool acquisition/connection. `DB_QUERY_TIMEOUT_MS` separately bounds the readiness query; timeout destroys that client so a hung query cannot occupy the pool. `SHUTDOWN_TIMEOUT_MS` bounds HTTP drain plus pool closure with monotonic elapsed time before the controlled fallback terminates the process. UTC business-event time remains a separate clock capability.

`createApp({ config, pool, clock })` has no startup side effects. The executable entrypoint calls `main.ts`, which owns configuration loading, dependency construction, port binding, and signal handling.

Application API failures use `{ "error": { "code", "message", "requestId", "details"? } }`; `X-Request-Id` is generated server-side and matches the body. Health remains a separate operational contract with its established `{ status, checks? }` body while still receiving the response request-ID header.

Architecture and execution evidence are in `docs/`, especially `docs/SDD.md`, `docs/implementation-plan.md`, and `docs/progress.md`.
