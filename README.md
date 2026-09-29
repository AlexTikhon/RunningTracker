# Running Tracker

P00–P02 establish a reproducible React/Express 5/PostGIS workspace and the complete database schema/ACL boundary. P03–P08 add the session/API lifecycle, durable runner capture, versioned summaries, revision-fixed live-track reads, authorized SSE/coach recovery, and a verified HTTPS/HTTP/2 transport profile. P09 provides the revisioned archive HTTP boundary, RLS-filtered PostGIS MVT generation, bounded process cache, atomic invalidation, the archive React/Mapbox source lifecycle, and bounded tile generation resources; retention and production identity remain later stages.

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

The example `LIVE_TRACK_CURSOR_SIGNING_KEY` is a fixed local-only HMAC key. Every
deployment must supply independent canonical base64url key material of at least
32 bytes; production startup rejects the example value.

- Web: http://127.0.0.1:5173
- API liveness: http://127.0.0.1:3000/api/health/live
- API readiness: http://127.0.0.1:3000/api/health/ready

The Vite server proxies `/api` to the API, so browser requests remain same-origin in development. Liveness describes the HTTP process only; readiness returns `503` when PostgreSQL cannot be reached.

The archive view loads without an external provider during tests and local API work. To render the interactive base map, set the public `VITE_MAPBOX_ACCESS_TOKEN` value before starting Vite. The token is exposed to browser code by design; do not place a secret server credential in this variable.

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

P05.5 connects device Geolocation and the seeded `normal` simulator through one capture-source interface. Capture runs only while the server-confirmed run is recording and this tab owns the lease. Each start/resume/recovery session atomically allocates a durable `segmentId`; every source callback is serialized, rechecks ownership, and verifies the fencing token again inside the IndexedDB point transaction. Stopped generations cannot persist late callbacks, and a 100-measurement queue limit fails visibly instead of growing without bound. Offline capture remains buffered and wakes the existing uploader after every durable append. Recording and tests remain independent of the optional public Mapbox token introduced by P09.5; actual device permission/background behavior still requires browser/device QA.

## Shared API contracts

`packages/contracts` is transport-only and has no Express or PostgreSQL dependency. It exports strict Zod schemas and inferred types for session/error responses, runs, commands, shares, points, track pages, archive/nearby reads, and the `live.state` SSE payload. PostgreSQL `bigint` revisions and point sequences cross HTTP as bounded decimal strings; URL numeric query inputs are parsed and range-checked by their query schemas.

The generated OpenAPI 3.1 artifact is `packages/contracts/openapi/openapi.json`. `npm run build --workspace=@running-tracker/contracts` regenerates it from the runtime schemas and ordinary-HTTP route metadata. `/live` is intentionally documented separately in `packages/contracts/sse.md`, including connection-local `streamId`/`sequence`, session-expiry disconnects, and reconnect recovery. P08.1 implements framing, polling, heartbeat, and bounded transport; P08.2 adds open-stream authorization revalidation; P08.3 consumes the strict events in the coach screen; P08.4 binds selected runs to atomic snapshot/change synchronization.

## Archive tiles

`GET /api/orgs/:orgId/archive/metadata?from=...&to=...` returns the current archive revision, the validated half-open filter, zoom 8–16, source layer `runs`, and a concrete revision-bound tile URL template. Periods are capped at 366 days. Tile requests require canonical XYZ coordinates with `x,y < 2^z`, re-check active membership and archive revision inside a runtime-role tenant transaction, and pass that same RLS-bound client to the tile pipeline. A stale URL returns `409 ARCHIVE_REVISION_CHANGED`; responses are `private, no-store`.

P09.2 generates source layer `runs` in one PostGIS statement over RLS-visible finished summaries in the requested half-open period. Candidate branches retain GiST-compatible `display_geom && envelope` predicates, then clip to the valid Web Mercator latitude range, project to EPSG:3857, and call `ST_AsMVTGeom` with extent 4096, buffer 64, and clipping enabled. Edge tiles select and shift the opposite antimeridian world copy after projection. The only feature property is string `run_id`; empty result sets return a valid empty MVT.

P09.3 adds a process-local 32 MiB binary LRU with a five-minute monotonic TTL and single-flight generation. Its key includes format version, organization, authenticated user, canonical archive revision, a SHA-256 hash of the canonical period, and XYZ. Empty tiles are cached; errors and over-capacity values are not. P09.4 serializes every cache hit behind active-membership/current-revision validation and advances the organization epoch atomically with archive-visible summary, history-grant, and membership changes.

P09.5 pins Mapbox GL JS 3.31.0 and adds an archive view with a bounded UTC period. A controller validates metadata through the shared contract, polls every 30 seconds, refreshes immediately on focus and stale-revision tile responses, and coalesces overlapping reads. A new revision calls `VectorTileSource.setTiles`; 401/403 removes the archive layer before its source and clears metadata, while transient network/5xx failures retain the last authorized source with an explicit error. Scope changes and unmount abort in-flight reads and destroy map state.

P09.6 bounds each process to two active tile generations and sixteen queued distinct keys. Queue waiting happens after the initial authorization/cache probe and before reopening a tenant transaction, so waiters retain neither pool clients nor organization locks. The admitted transaction revalidates membership/revision and cache state, applies PostgreSQL-local `statement_timeout=2000ms`, and accepts complete raw MVT buffers up to and including 1 MiB. Overflow is explicit (`TILE_BUSY`, `TILE_TIMEOUT`, or `TILE_TOO_COMPLEX`); failures and oversized buffers are not cached, and SQL never truncates to a first-N feature subset.

P04.1 resolves D01 with one strict `PointInput`: required `seq`, `segmentId`, `recordedAt`, `longitude`, `latitude`, and `accuracyM`, with no nullable/extra fields. Parsing canonicalizes `seq` through PostgreSQL-bigint decimal form, every `-0` to `0`, and UTC `recordedAt` to millisecond precision using the same nearest-millisecond rounding as `timestamptz(3)`. The canonical values are used for validation, retry comparison, persistence, and the shared public type.

## Point ingestion

`POST /api/orgs/:orgId/runs/:runId/points` accepts `{ "points": PointInput[] }` under the existing session, Origin/CSRF, membership, tenant transaction, and RLS boundary. A request contains 1–100 entries and remains subject to the 64 KiB JSON limit; a run may contain at most 50,000 unique points. `seq` defines deterministic track order, so request order, equal timestamps, late lower sequences, and device timestamps outside the live-freshness window are accepted as raw history.

The service locks the owned run, compares every repeated `seq` with its canonical stored payload, increments `data_revision` once only when at least one unique point is new, and inserts all new rows set-wise with that `ingested_revision`. Exact retries return `200` without a revision change; conflicting payloads return `409 POINT_CONFLICT`. Recording and paused runs accept points. Finished runs accept new points through `finished_at + 24 hours`; after that, only exact retries are acknowledged (`409 UPLOAD_WINDOW_CLOSED` for new points). `purging`/`purged` raw state returns `410 RAW_HISTORY_UNAVAILABLE`. The response is `{ dataRevision, insertedCount, duplicateCount }`, and HTTP acknowledgement occurs only after the surrounding PostgreSQL transaction commits.

## Raw point history

`GET /api/orgs/:orgId/runs/:runId/points?limit=1000&cursor=...` returns canonical raw points in ascending bigint `seq` order. The default and maximum page size is 1,000. The opaque cursor is bound to the organization, run, last sequence, and `data_revision`; if that revision changes between pages, the API returns `409 HISTORY_REVISION_CHANGED` and the client restarts from the first page.

The run revision/raw state and `limit + 1` keyset page are read in one PostgreSQL statement snapshot, so a page cannot combine different committed revisions. Owners can read active or finished raw history; a non-owner needs `can_read_history` on a finished run. `can_read_live` alone is intentionally insufficient. Authorized `purging`/`purged` history returns `410 RAW_HISTORY_UNAVAILABLE`; inaccessible and missing runs return the same `404 RUN_NOT_FOUND`.

## Run deletion and annual retention

`DELETE /api/orgs/:orgId/runs/:runId` uses the existing session, Origin/CSRF, membership, and tenant transaction boundary. Only the actual run owner may delete; a coach role or a live/history share grant confers no deletion right, and both cases return the same `404 RUN_NOT_FOUND` a non-owner already gets for a run that never existed, so a tombstone's existence is never revealed to an unauthorized caller. A successful delete and a repeated delete by the same owner while its tombstone is retained both return `204`; two concurrent duplicate deletes are also safe.

Owner deletion and the maintenance annual-retention worker (finished runs at least one year past `finished_at`, oldest first, bounded per-cycle work like the existing raw-purge/summary workers) share one database primitive, `app_private.execute_run_deletion`, reached only through two separately authorized `SECURITY DEFINER` capabilities: `delete_run_as_owner` (runtime-only) and `delete_run_for_retention` (maintenance-only). Neither role has direct `DELETE` on `runs`, `run_points`, `run_summaries`, `run_commands`, or `run_tombstones`. Both paths take the shared per-run advisory lock used by raw purge and summary publication, then `organizations FOR UPDATE`, then the run row, so deletion serializes safely with ingestion, commands, raw purge, summary publication, and archive tile/ACL reads without deadlocking.

Deletion inserts the `run_tombstones` row (real owner, injected UTC `deleted_at`, `expires_at` one year later per the SDD's documented tombstone period) in the same transaction that removes `run_summaries`, `run_shares`, and the run itself (cascading `run_points`/`run_commands`). `run_summaries` is deleted before `run_shares` so the existing migration-`0013` summary-delete archive-revision trigger fires the one required increment and the history-share trigger sees no summary left to react to; a run without a summary gets one explicit increment instead. Either way the organization's archive epoch advances exactly once per deleted run, invalidating cached tiles/metadata through the existing revisioned-key mechanism (ADR-0030) with no separate cache-purge step. `PUT` of the same run ID still returns `410 RUN_DELETED` while the tombstone is retained (unchanged from ADR-0006/P03.3). ADR-0035 records the full design; tombstone cleanup, reuse after expiry, and the post-expiry `PUT` contract remain P10.4 (D08 stays open).

## Versioned live-track reads

`GET /api/orgs/:orgId/runs/:runId/live-track` fixes the current `dataRevision` as R in the same PostgreSQL statement that reads the first seq-ordered page. Continuations retain R and exclude later ingestion without holding a transaction or connection between requests.

`GET /api/orgs/:orgId/runs/:runId/live-track/changes?afterRevision=A` similarly fixes target T. It returns the deduplicated, seq-ordered union of points ingested in `(A,T]` and each changed point's immediate successor in the point set visible at T. This lets a later lower-sequence insertion repair both its own edge and the next point's relationship. Every continuation retains A, T, algorithm version, and last seq while rechecking current membership, run authorization, and raw availability.

P07.4 signs strict versioned cursor payloads with HMAC-SHA-256 and binds them to the authenticated user, organization, run, operation, revisions, algorithm version, last sequence, and expiry. A pagination chain keeps one absolute ten-minute deadline; tampered, expired, cross-user, cross-run, or operation-swapped tokens return `400 INVALID_CURSOR`. Cursor integrity never replaces the per-request session, membership, ACL, retention, algorithm, and revision checks.

For both endpoints, P07.3 materializes the complete `ingested_revision <= T` point set, derives each point's immediate seq-ordered predecessor before page filtering, and calls the same versioned PostGIS edge evaluator used by summaries. `predecessorSeq` therefore remains correct on the first row of every continuation page, while `connectFromPrevious` is true only when the shared sequence, segment, accuracy, time, and speed rules accept that edge. Later ingestion cannot alter either annotation in an older fixed-revision page.

P07.5's browser `LiveTrackStore` stages every page in a temporary seq-keyed map and exposes the new point set and revision only after the terminal page succeeds. State and in-flight work are isolated by authenticated user, organization, and run; concurrent revision notifications coalesce to the latest requested target. Repeated upserts are idempotent, while an invalid/expired continuation or algorithm-version change discards staged work and starts a fresh snapshot.

## Live SSE transport

`GET /api/orgs/:orgId/live` requires the session cookie and an explicit `Accept: text/event-stream`. It performs the initial membership/RLS-protected snapshot before opening the stream, rechecks that the same stored session remains active, emits `live.state` sequence 0 immediately, and releases the tenant transaction and database client before the response remains open. Each state contains only authorized `recording`/`paused` runs, their revisions, and the latest usable position. The shared PostGIS edge evaluator marks an accepted latest edge `confirmed`; an isolated point or discontinuity is `unconfirmed`; invalid latest accuracy, time, or speed yields `position=null`.

One process-level scheduler polls every two seconds and groups tabs by user and organization so matching subscriptions share one short database read. Session validity remains per connection: the hub retains a digest reference rather than the raw cookie, closes exactly at expiry, and rechecks store revocation before poll, publish, drain, and heartbeat. Membership loss closes the affected user/organization streams and clears pending data; grant loss yields a complete filtered state that replaces any older blocked state. Per-connection `streamId` and sequence domains remain independent. A 15-second comment heartbeat is transport-only. When `response.write` reports backpressure, the hub retains only the newest not-yet-written state, replaces older pending state, and closes the connection after a bounded blocked-writer timeout. Connection count and poll concurrency are also bounded, and graceful shutdown ends streams before closing the runtime pool.

The Coach view opens one stream for a validated organization and renders only the full authorized run set. Confirmed and unconfirmed describe the server-evaluated latest edge; stale is a separate browser freshness state anchored to `serverTime` plus monotonic elapsed time, initially at 10 seconds. A null current position may retain its prior coordinate only as stale. Selected tracks reuse the P07 atomic store, coalesce SSE revisions to the greatest target per run, and abort/evict work on deselection, authorization removal, identity change, or disconnect. Bounded 1/2/4-second reconnects stop before known session expiry; visible state remains cleared until a new full state reauthorizes any recoverable selection. No external map token is required for this screen.

## HTTPS/HTTP/2 transport verification

P08.5 adds an opt-in Compose overlay with a pinned Nginx reverse proxy. Nginx
serves the production web build, terminates local TLS/HTTP/2 on
`https://localhost:8443`, and forwards to the internal Express service over
HTTP/1.1. The SSE location explicitly disables buffering, caching, compression,
and upstream retry; its 75-second read timeout is five times the 15-second
heartbeat. Only the TLS proxy is host-published. ADR-0026 records the security and
timeout decisions.

Generate a seven-day development-only certificate, prepare the disposable test
database, and start the profile:

```powershell
npm run db:up
node --env-file=.env.example scripts/bootstrap-database.mjs --test
node --env-file=.env.example scripts/migrate.mjs --test
npm run transport:tls
npm run transport:up
npm run transport:verify
```

`transport:verify` uses an actual TLS HTTP/2 client; it does not infer HTTP/2
from configuration text. It checks the normal API, cookie-authenticated SSE
headers and prompt framing, the 15-second heartbeat, database activity during an
open stream, backend restart/disconnect, new-stream recovery, and eight local
commit-to-visible latency samples. It creates and removes one exact fixture in
`running_tracker_test`. Stop the API/proxy overlay without deleting the database
volume with `npm run transport:down`; `npm run db:down` retains the named volume.

The certificate and private key are generated under gitignored `.local/tls` and
must never be reused outside local verification. The overlay deliberately uses
the existing development identity fixture and tracked local database credentials;
managed certificates, external secrets, and production identity remain P12.

## Deterministic GPS simulator

`@running-tracker/fixtures` generates canonical `PointInput` captures and upload attempts from a uint32 seed and UTC start instant. Its explicitly advanced virtual clock provides stable FIFO timer ordering without wall-clock sleeps. The named scenarios are `normal`, `duplicates`, `reordered`, `delayed-batch`, `dropped-response`, `clock-jump`, and `gps-spike`.

The CLI replays the resulting virtual timeline as JSON Lines without network or database I/O:

```powershell
npm run simulate:gps -- --scenario reordered --seed 42
npm run simulate:gps -- --list
```

`dropped-response` marks an upload attempt as `drop-after-commit` and emits an exact retry. The P04.5 API hook is a separately injected test-only dependency: `createApp` rejects it unless `APP_ENV=test`, there is no environment/header/endpoint activation path, and the points route evaluates it only after PostgreSQL confirms `COMMIT` and before sending the HTTP result. The integration proof observes a transport-level `ECONNRESET`, verifies the committed rows and revision through SQL, retries the exact batch, reads raw history, and finishes the run.

## Summary calculation

`app_private.evaluate_track_edge(...)` is the single versioned PostGIS rule used by summary processing and live-track reads. P06.2 builds on it with the maintenance-only `app_private.calculate_run_summary(...)` capability: points are fixed by `ingested_revision <= sourceRevision`, ordered by bigint `seq`, and reduced to accepted-edge distance/duration, exact `QualityStats`, and unsimplified accepted `MultiLineString` chains. Rejected edges terminate a chain, isolated points never become synthetic lines, and `received_at` does not affect continuity.

P06.3 adds the separate pure `app_private.simplify_display_geometry(...)` capability. It partitions each accepted chain by cumulative geodesic length into at-most-20-km pieces with shared boundaries, simplifies each piece at 5 metres in a local azimuthal-equidistant projection, then unwraps and splits crossings at every antimeridian world boundary before returning WGS84. Endpoints and separate chains are preserved; display-degenerate zero-length pieces are omitted. Summary distance remains the pre-simplification accepted-edge total.

P06.4 calculates and simplifies a stale finished run in one materialized statement snapshot without a run mutation lock. Publication then locks organization before run, validates the exact v1 `QualityStats` shape, rejects changed revisions, non-finished/raw-unavailable/deleted runs, tombstones, and duplicate current summaries, and atomically upserts the summary with one organization `archive_revision` increment. P06.5 adds transaction-scoped advisory claims: simultaneous processes skip an already claimed organization/run while publication retains the row-lock correctness fence. The maintenance role can execute only the narrow claim/calculation/publication functions and still cannot write the underlying tables directly.

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

`RUN_SUMMARY_INTERVAL_MS` independently defaults to 60 seconds. Each settled cycle starts `RUN_SUMMARY_CONCURRENCY` workers (default 2, maximum 8), waits for all of them, and then schedules the next cycle. Each worker owns a transaction-scoped database claim through calculation/publication; commit or rollback releases it. The maintenance pool reserves capacity for the bounded batch plus auto-finish, and shutdown stops both timers before pool closure.

`RUN_RAW_PURGE_INTERVAL_MS` also defaults to 60 seconds. Each settled cycle claims at most one run and deletes at most one 1,000-point batch. A new purge starts only after the seven-day target, after the 24-hour upload window is closed, and with a current valid summary; committed `purging` work is resumed first. An overdue run without a current summary emits an identity-free warning and remains intact. The maintenance pool reserves separate capacity for summary workers, auto-finish, and raw purge.

`RUN_RETENTION_DELETE_INTERVAL_MS` also defaults to 60 seconds. Each settled cycle claims and whole-run-deletes at most one finished run whose `finished_at` is at least one year old, oldest first; a claimed run's eligibility is independently reconfirmed after its locks are acquired. This is the same maintenance-only annual retention path documented in "Run deletion and annual retention" above, sharing the deletion primitive and per-run advisory lock with owner `DELETE`, raw purge, and summary publication.

`LIVE_SSE_POLL_INTERVAL_MS` defaults to 2 seconds and `LIVE_SSE_HEARTBEAT_INTERVAL_MS` to 15 seconds. `LIVE_SSE_MAX_CONNECTIONS` bounds open and opening streams (default 64), `LIVE_SSE_POLL_CONCURRENCY` bounds simultaneous identity/organization reads (default 2, maximum 8), and `LIVE_SSE_BACKPRESSURE_TIMEOUT_MS` closes a writer that remains blocked for 10 seconds by default.

`DB_CONNECTION_TIMEOUT_MS` bounds pool acquisition/connection. `DB_QUERY_TIMEOUT_MS` separately bounds the readiness query; timeout destroys that client so a hung query cannot occupy the pool. `SHUTDOWN_TIMEOUT_MS` bounds HTTP drain plus pool closure with monotonic elapsed time before the controlled fallback terminates the process. UTC business-event time remains a separate clock capability.

`createApp({ config, pool, clock })` has no startup side effects. The executable entrypoint calls `main.ts`, which owns configuration loading, dependency construction, port binding, and signal handling.

Application API failures use `{ "error": { "code", "message", "requestId", "details"? } }`; `X-Request-Id` is generated server-side and matches the body. Health remains a separate operational contract with its established `{ status, checks? }` body while still receiving the response request-ID header.

Architecture and execution evidence are in `docs/`, especially `docs/SDD.md`, `docs/implementation-plan.md`, and `docs/progress.md`.
