# Running Tracker

A learning project: record a run in the browser (or from a simulator), let a coach with explicit permission watch it live, and keep an archive of finished runs drawn on a map. A React web app and an Express 5 API sit on PostgreSQL/PostGIS, with row-level security as the tenant and sharing boundary.

What exists, stage by stage (the evidence for each is in [docs/progress.md](docs/progress.md), the design in [docs/SDD.md](docs/SDD.md) and the ADRs in [docs/adr/](docs/adr/)):

- P00–P02: the reproducible workspace and the complete database schema and ACL boundary.
- P03–P08: the session/API lifecycle, durable runner capture with an offline buffer, versioned summaries, revision-fixed live-track reads, authorized SSE with coach recovery, and a verified HTTPS/HTTP/2 transport profile.
- P09: the revisioned archive HTTP boundary, RLS-filtered PostGIS vector tiles, a bounded cache with atomic invalidation, and the archive map source lifecycle.
- P10: raw-point retention, owner and annual run deletion with tombstones, and the off-host deletion journal.
- P11: metrics and logs, reproducible load datasets, a concurrent load scenario, plan and size measurements, and one confirmed optimization.
- P12: OpenID Connect sign-in with invite-only identities, a single-host production profile, encrypted backups with an executed restore drill, and recovery of current permissions.

**What this does not establish.** Everything was verified on one workstation: sign-in only against a test OpenID provider (no real provider and no real browser), the production profile with throwaway secrets and a self-signed certificate, the restore drill on a tiny database, and the load limits on a local dataset. No production RPO or RTO is claimed. Three read endpoints named in the SDD (`/runs/{runId}/track`, `/archive/runs`, `/live/nearby`) were never built. To see it working locally, follow [docs/runbooks/demo.md](docs/runbooks/demo.md).

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

`SESSION_COOKIE_SECURE=false` is an explicit local HTTP exception allowed only in development/test. Deployed HTTPS uses `Secure`. The local store is process-memory-only, bounded by `SESSION_STORE_MAX_ENTRIES`, and loses all sessions on restart. Production sign-in is OpenID Connect, below.

## Runner control screen

After a local session exists, the web app discovers it through same-origin `GET /api/session`. Enter an organization UUID to create a run, then use the revision-aware pause, resume, and finish controls. Each mutation carries the session CSRF token, validates the shared response contract, and disables concurrent controls until the server confirms the result.

The screen exposes recording, network, upload, and server/error state separately. Before a start or lifecycle mutation reaches the network, P05.2 stores its exact idempotency identity and payload in IndexedDB under the authenticated user. It removes that request only in the local transaction that records the server-confirmed run snapshot. Offline requests and unknown transport outcomes therefore survive reload and can use “Retry same request” after reconnection.

The same user/organization/run-scoped database atomically allocates a positive bigint `seq` and stores the canonical point. IndexedDB uses a zero-padded sequence index so bounded reads retain numeric bigint order without converting `seq` to JavaScript `number`.

P05.3 uploads at most 100 ordered points at a time and deletes only the exact sequence set after a validated acknowledgement accounts for every sent point. Network/5xx/408/425/429 outcomes retain the batch and use capped exponential full-jitter backoff; `Retry-After` is honoured for rate limiting. Other 4xx responses and incomplete success acknowledgements stop that run's worker, preserve its points, and trigger a best-effort authoritative run read. A stale lifecycle command is cleared only when a `CONTROL_REVISION_CONFLICT` can be reconciled to a successfully read and durably stored server run.

P05.4 adds a user-scoped IndexedDB lease with a per-tab UUID and monotonically increasing fencing token. One tab atomically acquires and renews the 15-second lease; stale owners cannot renew or release a successor's token. Non-owner tabs keep controls and upload work read-only and expose explicit ownership retry. This is a same-origin tab guarantee, not a distributed offline device lock; cross-device races still fail through the server's one-active-run constraint, command revisions, and canonical point conflicts.

P05.5 connects device Geolocation and the seeded `normal` simulator through one capture-source interface. Capture runs only while the server-confirmed run is recording and this tab owns the lease. Each start/resume/recovery session atomically allocates a durable `segmentId`; every source callback is serialized, rechecks ownership, and verifies the fencing token again inside the IndexedDB point transaction. Stopped generations cannot persist late callbacks, and a 100-measurement queue limit fails visibly instead of growing without bound. Offline capture remains buffered and wakes the existing uploader after every durable append. Recording and tests remain independent of the optional public Mapbox token introduced by P09.5; actual device permission/background behavior still requires browser/device QA.

## Shared API contracts

`packages/contracts` is transport-only and has no Express or PostgreSQL dependency. It exports strict Zod schemas and inferred types for session/error responses, runs, commands, shares, points, track pages, archive/nearby reads, and the `live.state` SSE payload. PostgreSQL `bigint` revisions and point sequences cross HTTP as bounded decimal strings; URL numeric query inputs are parsed and range-checked by their query schemas.

The generated OpenAPI 3.1 artifact is `packages/contracts/openapi/openapi.json`. `npm run build --workspace=@running-tracker/contracts` regenerates it from the runtime schemas and ordinary-HTTP route metadata. It documents the browser sign-in routes `GET /api/auth/login` and `GET /api/auth/callback` as redirects (they exist only when OpenID Connect is configured), and flags three operations the SDD specified but no stage built (`/runs/{runId}/track`, `/archive/runs`, `/live/nearby`) with `x-implemented: false`. `apps/api/test/openapi-routes.spec.ts` requests every documented operation from the real app and fails if one is missing or a flagged one has appeared. `/live` is intentionally documented separately in `packages/contracts/sse.md`, including connection-local `streamId`/`sequence`, session-expiry disconnects, and reconnect recovery. P08.1 implements framing, polling, heartbeat, and bounded transport; P08.2 adds open-stream authorization revalidation; P08.3 consumes the strict events in the coach screen; P08.4 binds selected runs to atomic snapshot/change synchronization.

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

Deletion inserts the `run_tombstones` row (real owner, injected UTC `deleted_at`, `expires_at` one year later per the SDD's documented tombstone period) in the same transaction that removes `run_summaries`, `run_shares`, and the run itself (cascading `run_points`/`run_commands`). `run_summaries` is deleted before `run_shares` so the existing migration-`0013` summary-delete archive-revision trigger fires the one required increment and the history-share trigger sees no summary left to react to; a run without a summary gets one explicit increment instead. Either way the organization's archive epoch advances exactly once per deleted run, invalidating cached tiles/metadata through the existing revisioned-key mechanism (ADR-0030) with no separate cache-purge step. `PUT` of the same run ID still returns `410 RUN_DELETED` while the tombstone is retained (unchanged from ADR-0006/P03.3). ADR-0035 records the full design.

### Tombstone lifetime and late retries (P10.4)

A tombstone is authoritative for as long as its row exists; the request path never compares `expires_at`. For one year after deletion (`expires_at = deleted_at + 1 year`) a deleted run ID is protected: the owner's `PUT` and `GET` return `410 RUN_DELETED`, and a repeated owner `DELETE` returns `204`. Other members keep getting `404 RUN_NOT_FOUND` and never learn that a marker exists.

`expires_at` only says when the maintenance-only `app_private.reclaim_expired_run_tombstones` **may** remove the row. Until it actually does, protection continues (a delayed cleanup only lengthens it). After removal the ID is unknown: `DELETE` returns `404 RUN_NOT_FOUND` and `PUT` creates a brand-new run. A creation or deletion retry that arrives after the one-year window (plus any cleanup delay) is therefore outside the idempotency guarantee, and clients must not hold a retry that long. There is no permanent used-ID registry. ADR-0036 records the contract, the row-lock concurrency model, and the marker takeover rule that keeps a later deletion of the same ID from failing.

### Deletion journal and restore (P10.5)

A backup restored after a deletion would bring the deleted run back, and tombstones live in the same database as the runs. Every deletion, owner or annual retention, therefore also writes an identifier-only row (`run_deletion_journal`: organization, run, owner, deletion instant; no coordinates or payload) in the same transaction as the tombstone and the cascade delete. A maintenance runner exports pending rows to files in `DELETION_JOURNAL_DIR` (one JSON object per line) and removes them from the database only after the file is fsynced and renamed, so a failed export keeps every row and a crash re-exports a batch (duplicates are harmless). `DELETION_JOURNAL_DIR` must be storage outside the database host and is required in production; the code cannot verify that the mount really is off-host.

After restoring a backup, and before the application can reach the database, run `npm run restore:reapply-deletions -- --journal-dir <copy of the journal directory>` with `RESTORE_DATABASE_URL` set to the object-owner role. It validates every file first, then reapplies each deletion idempotently in its own transaction; it never touches a run created after the journaled deletion and prints counts only. The ordered procedure, retention rule for journal files, failure modes, and the P12.3 drill checklist are in [docs/runbooks/deletion-journal-and-recovery.md](docs/runbooks/deletion-journal-and-recovery.md); the design is ADR-0037.

While the exporter is healthy a deletion is off-host within about one export interval (default 30 s); deletions not yet exported when a node is lost are lost with it. The P12.3 restore drill (see "Backups and the restore drill (P12.3)" below) has exercised this on a workstation; it does not establish a production RPO or RTO. Access restrictions are recovered by a second journal, described next.

### Access-restriction journal and restoring current permissions (P12.4)

A backup also holds shares and memberships as they were, so an old one would bring back access that was revoked later. Triggers on `memberships` and `run_shares` therefore write an identifier-only row (`access_restriction_journal`: organization, user, run, two booleans for a narrowed share, an instant) in the same transaction as the change, for three kinds only: a membership deactivated, a share revoked, a share narrowed. A grant, a re-activation or a widening is never journaled. The same maintenance machinery exports these rows to `access-journal-*.ndjson` files in `DELETION_JOURNAL_DIR` (same sink, same interval, nothing new to configure) and removes them only after the file is durable.

After `restore:reapply-deletions`, run `npm run restore:reapply-access -- --journal-dir <copy of the journal directory>` with `RESTORE_DATABASE_URL` set to the object-owner role. It validates every file first, then replays each entry in its own transaction, idempotently and in any order. It only deactivates, deletes a share, or intersects a share's booleans with the journaled ones; it never activates a member, creates a share or widens one, and the file format cannot express a grant, so a forged or stale file can at worst remove access. Recovery therefore fails closed: access granted after the backup is not reconstructed and has to be granted again, and a share revoked and then granted again before the loss is removed again. Restrictions not yet exported when a node is lost are lost with it (the same recovery point as deletions). The restored database stays closed to the application until the operator opens it with an explicit `GRANT CONNECT` (step 10 of [docs/runbooks/backup-and-restore.md](docs/runbooks/backup-and-restore.md)); the design is ADR-0045.

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
managed certificates and external secrets are the production profile (P12.2, below) and production sign-in is OpenID Connect (P12.1, below).

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

`METRICS_PORT` (unset by default, so no listener) starts a separate scrape endpoint at `http://METRICS_HOST:METRICS_PORT/metrics` in Prometheus text format; `METRICS_HOST` defaults to `127.0.0.1` and `METRICS_PORT` must differ from `PORT`. The endpoint has no authentication and serves only `GET /metrics`, so exposing it beyond a trusted network is a deliberate deployment choice. See "Metrics and logs (P11.1)" below and ADR-0038.

## Metrics and logs (P11.1)

Start the API with `METRICS_PORT=9464` and run `curl http://127.0.0.1:9464/metrics`. The exposed signals are HTTP request count/duration/in-flight, point-ingestion commit latency and inserted/duplicate/rejected counts, live stream count/backpressure/poll-cycle time, archive tile cache result/bytes/generation time/queue depth, per-job maintenance cycle outcome/duration/last success (plus `raw_purge_blocked_total` for a retention overrun), database pool checkout time and state for the runtime and maintenance pools, and process memory/event-loop delay. Alert on the age of `maintenance_last_success_timestamp_seconds` per task to detect a stuck job such as the deletion-journal exporter. Route labels are templates (`/api/orgs/:uuid/runs/:uuid/points`), never concrete identifiers.

Logs are one JSON line per event with an allow-listed set of technical fields (request ID, route template, status, duration, task, error class and short code, and a few counters). Coordinates, request bodies, cookies, tokens, and error messages are dropped by construction, and only failed (5xx) requests are logged. Data age, summary lag, and dead tuples are not exported by the API. Backup age is deliberately not an API metric either: the backup job writes it to a node_exporter textfile (P12.3, `docs/runbooks/backup-and-restore.md`), so the scrape endpoint never touches backups. Metrics are per process and reset on restart.

## Load datasets (P11.2)

`npm run load:seed -- --profile ordinary|stress|smoke [--seed N] [--as-of <UTC instant>] [--reset]` writes one deterministic organization into a dedicated database and prints a JSON manifest (organization and member IDs, counts, per-phase timings, relation sizes, and a reproducibility digest). It is never pointed at `running_tracker` or `running_tracker_test`: the command refuses any database whose name does not end in `_load_test`, and it connects as `running_tracker_owner` because the seeder is a test-data writer, not application code.

```powershell
# one-time: create the database, then reuse the existing bootstrap/migration scripts with the URLs pointed at it
docker compose -f infra/compose/docker-compose.yml exec -T postgres psql -U running_tracker -d postgres -c "CREATE DATABASE running_tracker_load_test"
# set TEST_BOOTSTRAP_/TEST_MIGRATION_/TEST_/TEST_MAINTENANCE_DATABASE_URL to .../running_tracker_load_test, then:
npm run db:bootstrap:test
npm run db:migrate:test
$env:LOAD_DATABASE_URL = 'postgresql://running_tracker_owner:owner_local_only@127.0.0.1:5433/running_tracker_load_test'
npm run load:seed -- --profile ordinary   # the default instant is today's UTC midnight; keep it for load runs
```

- `ordinary` is the SDD estimate: 10 members, one finished run per member per day for 365 days (3,650 runs and summaries), and 126,000 raw points (seven days of 1,800-point runs).
- `stress` keeps the same archive and holds 3,000,000 raw points, split over the same 70 recent runs (42,857–42,858 points, about 23.8 hours each, below the 50,000-point run limit).
- `smoke` is a five-member, seconds-long profile used by the integration test.
- Runs older than seven days are `purged` and keep only their summary, matching the retention rules. There are no active runs, so P11.3 creates its live runs through the API.
- Geography: members are spread over eight anchors (Lisbon, New York, Tokyo, Sydney, Reykjavik, Nairobi, Buenos Aires, and a route centred on the antimeridian near Taveuni, whose display geometry is split into several parts). Routes are loops with a few metres of deterministic GPS noise.
- ACL: the last two members are coaches with history and live grants from every runner; every other ordered member pair draws a standing policy (40% none, 20% history only, 10% live only, 30% both) applied to all of the owner's runs.
- The same seed and `--as-of` give the same rows: every value derives from a SHA-256 of the seed and a key, and the manifest `digest` (an MD5 over runs, points, summaries, and shares) is identical after `--reset`. It is stable on one PostgreSQL/PostGIS build; it is not promised across builds with different floating-point formatting.
- The seeded data does not contain `run_commands`, tombstones, or an active session, so it exercises reads, tiles, live state, summaries, and retention, not idempotent replay of the original create/finish commands.

A run without `--reset` refuses a database that already holds any user, organization, or run. Seeding is one transaction and is followed by `ANALYZE`, so a failure leaves nothing behind and planner statistics match the data.

## Concurrent load scenario (P11.3)

`npm run load:run -- --profile ordinary|stress|smoke [--seed N] [--as-of <UTC instant>] [--results-dir <path>] [--no-cleanup | --cleanup-only]` runs the SDD workload against a **seeded** dedicated database: it starts the real API as a child process on free loopback ports and drives it only over HTTP and SSE. It needs the three role URLs of the load database (the owner URL is the seeder's; the runtime and maintenance URLs are what the API itself connects with):

```powershell
$env:LOAD_DATABASE_URL = 'postgresql://running_tracker_owner:owner_local_only@127.0.0.1:5433/running_tracker_load_test'
$env:LOAD_RUNTIME_DATABASE_URL = 'postgresql://running_tracker_runtime:runtime_local_only@127.0.0.1:5433/running_tracker_load_test'
$env:LOAD_MAINTENANCE_DATABASE_URL = 'postgresql://running_tracker_maintenance:maintenance_local_only@127.0.0.1:5433/running_tracker_load_test'
npm run load:seed -- --profile ordinary --reset   # the dataset must be freshly seeded and untouched
npm run load:run -- --profile ordinary
```

- The runner refuses anything but a loopback database whose name ends in `_load_test`, checks each role's live session (`current_database()`, `current_user`), and verifies that the database holds exactly the planned dataset (runs and start times, points, summaries, members, no active run). It never reseeds. The child API gets a scrubbed environment: no owner or bootstrap credentials, local sessions only for the ten planned members. There is no flag for a URL, a database, or a reseed.
- Scenario: ten SSE observers (one per member, each with its own session), ten concurrent 100-point offline batches per round (`smoke` 2 rounds, `ordinary` 3, `stress` 10) followed by an exact retry and an overlapping retry, archive pan/zoom tile bursts on two overlapping streams across eight regions (including the antimeridian route), the finish of a run that the existing summary worker publishes, and fresh points every two seconds per member whose latency to each expected observer is measured. The fresh phase lasts until the summary is visible and the archive revision has advanced, so with the default 60 s worker cadence a run takes one to a few minutes.
- The result is one JSON file in `.local/load-results/` (gitignored) with raw per-request samples, fresh-point latency samples, observer reports, tile samples and bytes, the summary-publication timeline, metrics before/after, and convenience percentiles. It never contains cookies, CSRF tokens, session tokens, or coordinates. A failed run still writes a partial result and exits non-zero.
- Afterwards the runner deletes exactly the runs it created (deterministic IDs) and verifies the dataset again, so the next run starts from the same rows. `--cleanup-only` does that alone, for a run that was killed. `--no-cleanup` keeps the runs for inspection; the next run then refuses until `--cleanup-only`.
- The dataset ages with the clock (seven-day raw retention, one-year run retention), so the child API parks the raw-purge, annual-retention, and tombstone jobs at their 24-hour maximum. Set `LOAD_KEEP_RETENTION_JOBS=true` to run them at their normal cadence; they will then rewrite the seeded rows and the next run needs a reseed. The summary worker keeps its normal cadence (`RUN_SUMMARY_INTERVAL_MS`).
- Ordinary `npm test` and CI never run this: the smoke scenario runs inside the integration suite against `running_tracker_test`, and asserts structure, not performance. The SDD targets are decided from P11.4's analysis of these results, not by the runner. See ADR-0040.

## Measurements and report (P11.4)

Same three `LOAD_*` variables and the same `*_load_test` guards as the runner; the dataset must be the planned, untouched one.

```powershell
npm run load:explain -- --profile ordinary|stress|smoke [--repetitions 5] [--keep-plans]
npm run load:run -- --profile ordinary --no-tiles          # baseline without tile bursts, for the starvation comparison
npm run load:report -- --since <UTC instant> --out <absolute path>   # relative paths resolve from apps/api
```

- `load:explain` runs a fixed catalogue of the production SQL (the exported statement constants, never copies): 24 archive tiles (8 regions × zoom 9/11/13, including the antimeridian route), the run list, raw history, live-track snapshot and changes pages, the live-state poll, a 100-point insert, the summary claim and publication, and paired count scans as the table owner (no RLS) and as a coach (RLS). Each runs as `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` under its real role and tenant context, several times, always inside a transaction that is rolled back. The live-state and insert statements need recording runs, so each member's newest run is switched to `recording` for the duration and restored to its exact `finished_at` afterwards (also on failure or Ctrl-C); the dataset is verified again at the end. It also measures the real service call's response bytes and time, and records relation/index sizes, tuple counts, and the plan-shaping PostgreSQL settings.
- The result is `.local/load-results/explain-<profile>-<start>.json` (summaries only). `--keep-plans` additionally writes the raw first plan of each statement to a separate `explain-plans-…` file, because plans can quote literal values; it is never included in the summary and never committed.
- `load:run` now also samples which API and maintenance backends wait for a lock (`pg_locks`, every 250 ms, no statement text) and accepts `--no-tiles`.
- `load:report` turns the result files into `docs/reports/p11-measurements.md`: environment, goals met / not met / not confirmed under explicit rules, per-profile pooled percentiles, EXPLAIN tables, and sizes. Everything in it is computed from the result files. See ADR-0041.

## Set-based run visibility (P11.5)

The SELECT policies on `runs`, `run_points`, and `run_summaries` no longer call a definer function per row. Migration `0019` adds `app_private.readable_run_keys()` and `app_private.history_readable_run_keys()`, which return the readable `(org_id, run_id)` pairs once per statement; the policies probe that set. The per-row functions remain the specification, and `test/rls-set-policies.integration.test.ts` compares the sets with them for every fixture identity. A caller that reads only a few live rows (the live SSE poll) may declare `visibilityScope: 'live'` on `withTenantTransaction`; it can only narrow the result. The before/after numbers, produced by the same `load:explain`, `load:run`, and `load:report` commands, are in `docs/reports/p11-measurements.md` (before) and `docs/reports/p11-5-measurements-after.md` (after); see ADR-0042. To re-measure, apply the migration to the load database with the existing scripts pointed at it and rerun the commands above.

## Sign-in with OpenID Connect (P12.1)

Production sign-in is the OpenID Connect authorization code flow with PKCE (S256), `state` and `nonce`, through `openid-client`, against any compliant provider you configure. `GET /api/auth/login` sends the browser to the provider; `GET /api/auth/callback` validates the response, finds the person, and creates the same session record, `HttpOnly` cookie, and CSRF token as the development fixture, so `GET`/`DELETE /api/session` and every authorization rule are unchanged. The routes exist only when OIDC is configured; `LOCAL_AUTH_ENABLED` stays forbidden in production, so production has no development login.

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER_URL` | The provider's issuer. `https` in production; `http` only for a loopback issuer in development/test |
| `OIDC_CLIENT_ID` | The client registered for this deployment |
| `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_SECRET_FILE` | The client secret; production uses the file |
| `OIDC_REDIRECT_URI` | Exactly `<origin>/api/auth/callback`, on an origin in `ALLOWED_ORIGINS` |
| `OIDC_SCOPES`, `OIDC_LOGIN_TTL_MS`, `OIDC_POST_LOGIN_PATH`, `OIDC_STORE_MAX_ENTRIES` | Optional: `openid`, 10 minutes, `/`, 100 pending logins |

The first four are all required together, and in production they are required. The service is **invite-only**: a person signs in only if `users.external_identity` already holds `<issuer>|<subject>` (the ID token's `iss` and `sub`); an unknown identity is refused and nothing is created. Registering the client, provisioning and removing people, rotating the secret, and troubleshooting are in [docs/runbooks/identity-provider.md](docs/runbooks/identity-provider.md); the design and its limits are ADR-0046. When sign-in fails the app shows one of four fixed messages (`sign_in_error`).

Tests: the unit suites cover the configuration, the pending-login store and the routes; `npm run test:integration` runs the whole flow against a real in-process OpenID provider (`oidc-provider`, test only) and PostgreSQL, and `npm run deploy:verify` checks the production surface (no development login, a 503 for an unreachable provider, the secret as a file). **This does not establish that sign-in works with any particular real provider, in a real browser, or that provider-side account changes end sessions**: a disabled provider account keeps its application session until it expires (`SESSION_TTL_MS`) or the API restarts, so also deactivate the membership.

## Deployment profile (P12.2)

`infra/compose/docker-compose.production.yml` is a standalone single-host profile: PostgreSQL/PostGIS on an internal-only network, a one-shot `db-init` job (role bootstrap plus migrations), the API, and an nginx edge with an operator-supplied certificate, HTTP-to-HTTPS redirect, security headers, and the verified SSE policy. Secrets are files, not environment values: `npm run deploy:secrets -- --dir <dir>` generates them, and the API reads `DATABASE_URL_FILE`, `MAINTENANCE_DATABASE_URL_FILE`, `LIVE_TRACK_CURSOR_SIGNING_KEY_FILE`, and `OIDC_CLIENT_SECRET_FILE` (the one secret the provider issues, so `deploy:secrets` does not create it). Production startup also requires `ALLOWED_ORIGINS` to be non-empty and HTTPS-only.

`npm run deploy:verify` builds the images, starts the stack on ports 19080/19443 with throwaway secrets and a self-signed certificate, asserts transport, headers, exposure, resource limits, secret handling, database roles, restart, idempotent re-migration, certificate reload, and credential rotation, then removes everything. It needs Docker and about five minutes. Sign-in is OpenID Connect (P12.1, below) and was verified only against a test provider, so this profile has not been run against a real identity provider. Setup, update, rotation, and the list of what is not done are in `docs/runbooks/deployment.md`; the design is ADR-0043.

## Backups and the restore drill (P12.3)

`npm run backup:create` takes a `pg_dump --format=custom` archive of a database, encrypts it with AES-256-GCM (Node's built-in crypto; key from `BACKUP_ENCRYPTION_KEY_FILE`, 64 hex characters, never stored with the backup), writes it atomically under a unique name (`running-tracker-backup-<UTC>-<random>.rtbak`, never overwriting), and reads it back to authenticate it. `backup:prune` removes only this tool's files strictly older than 7 days and keeps the newest backup unless forced; `backup:verify` authenticates a backup and prints its technical metadata; `backup:decrypt` writes the archive for `pg_restore`; `backup:keygen` creates a key file. Scheduling, off-host copying, key custody and the backup-age alert are the operator's; examples and the full restore order are in [docs/runbooks/backup-and-restore.md](docs/runbooks/backup-and-restore.md), and the design is ADR-0044.

`npm run restore:drill` (Docker, the local database, `RESTORE_DRILL_*` and `BACKUP_ENCRYPTION_KEY_FILE` from `.env.example`) rehearses the SDD recovery order against real PostgreSQL/PostGIS in fresh `running_tracker_restore_drill_*` databases: backup an older-schema database, upgrade the source (a release deployed before the loss), delete runs afterwards through the real owner-deletion and annual-retention paths and revoke a share, narrow a share and deactivate a member, export both journals, simulate loss, restore, migrate, reapply the deletions and then the access restrictions, each twice, and verify that deleted runs stay deleted with tombstones and exactly one archive revision each, that the recovered permissions equal the lost source's (checked as the runtime role under row-level security), and that nobody gained access. It fails closed with exit code 1, never touches the development, test or load-test databases, and leaves the restored database **closed to the application**: opening it is an explicit operator step. The report (`docs/reports/p12-4-restore-drill.md`; the P12.3 report is kept as history) separates what the local drill verified from what needs a real environment. **It does not establish a production RPO or RTO.**

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

P03.1 now resolves that HTTP boundary for local development/test: `userId` is accepted only from a verified server-side session. A route may select `orgId`, but `withAuthenticatedTenantTransaction` validates it, opens `withTenantTransaction` under `running_tracker_runtime`, rechecks active membership inside that same transaction, and runs subsequent SQL on the same client. Production authentication is OpenID Connect (P12.1, "Sign-in with OpenID Connect" below); it ends in the same verified server-side session.

## Configuration

Configuration is loaded and validated before the API app and pools are created. `.env.example` contains clearly labelled fixed local development/test credentials for bootstrap, migration owner, runtime, and maintenance roles. `DATABASE_URL` must authenticate as `running_tracker_runtime`; `MAINTENANCE_DATABASE_URL` must authenticate as `running_tracker_maintenance` and target the same host, normalized port, and database. Use separate managed secrets outside local development.

`RUN_AUTO_FINISH_INTERVAL_MS` is the interval between settled maintenance cycles and defaults to 60 seconds. It is an implementation parameter, not a tighter product guarantee than “the first maintenance cycle after `created_at + 24 hours`.” Each cycle passes one injected UTC timestamp to the database function. The function atomically changes only eligible `recording`/`paused` runs to `finished`, sets `finished_at` to that timestamp, and increments `data_revision`; it does not change `control_revision`, `raw_state`, or `run_commands`. Conditional PostgreSQL updates make concurrent commands and repeated workers idempotent. Startup and signal handling remain in `main.ts`; shutdown stops future maintenance timers before closing HTTP and both pools within the shared deadline.

`RUN_SUMMARY_INTERVAL_MS` independently defaults to 60 seconds. Each settled cycle starts `RUN_SUMMARY_CONCURRENCY` workers (default 2, maximum 8), waits for all of them, and then schedules the next cycle. Each worker owns a transaction-scoped database claim through calculation/publication; commit or rollback releases it. The maintenance pool reserves capacity for the bounded batch plus auto-finish, and shutdown stops both timers before pool closure.

`RUN_RAW_PURGE_INTERVAL_MS` also defaults to 60 seconds. Each settled cycle claims at most one run and deletes at most one 1,000-point batch. A new purge starts only after the seven-day target, after the 24-hour upload window is closed, and with a current valid summary; committed `purging` work is resumed first. An overdue run without a current summary emits an identity-free warning and remains intact. The maintenance pool reserves separate capacity for summary workers, auto-finish, and raw purge.

`RUN_RETENTION_DELETE_INTERVAL_MS` also defaults to 60 seconds. Each settled cycle claims and whole-run-deletes at most one finished run whose `finished_at` is at least one year old, oldest first; a claimed run's eligibility is independently reconfirmed after its locks are acquired. This is the same maintenance-only annual retention path documented in "Run deletion and annual retention" above, sharing the deletion primitive and per-run advisory lock with owner `DELETE`, raw purge, and summary publication.

`RUN_TOMBSTONE_RECLAIM_INTERVAL_MS` defaults to 300000 (five minutes; validated as a positive integer up to 24 hours). Each settled cycle reclaims at most 500 tombstones whose `expires_at` has passed (oldest first, through the maintenance-only `app_private.reclaim_expired_run_tombstones`, hard cap 1,000). Cleanup is restart-safe and skips rows another worker holds; a delayed or stopped cleanup only extends tombstone protection, it can never free a run ID early. See "Tombstone lifetime and late retries (P10.4)" above.

`BACKUP_ENCRYPTION_KEY_FILE`, `BACKUP_DATABASE_URL`, `BACKUP_PG_DOCKER_CONTAINER` and the `RESTORE_DRILL_*` URLs configure the backup commands and the local restore drill (see "Backups and the restore drill (P12.3)"); the API never reads them, and they are intentionally absent from the production secret set.

`DELETION_JOURNAL_DIR` is an absolute directory for exported deletion journal files; it is required when `APP_ENV=production` and optional otherwise (unset keeps deletions in the database outbox and logs a startup warning). When set, startup proves it is writable before the listener binds. `RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS` defaults to 30000 (positive integer up to 24 hours); each settled cycle exports at most 500 rows. See "Deletion journal and restore (P10.5)" above.

`LIVE_SSE_POLL_INTERVAL_MS` defaults to 2 seconds and `LIVE_SSE_HEARTBEAT_INTERVAL_MS` to 15 seconds. `LIVE_SSE_MAX_CONNECTIONS` bounds open and opening streams (default 64), `LIVE_SSE_POLL_CONCURRENCY` bounds simultaneous identity/organization reads (default 2, maximum 8), and `LIVE_SSE_BACKPRESSURE_TIMEOUT_MS` closes a writer that remains blocked for 10 seconds by default.

`DB_CONNECTION_TIMEOUT_MS` bounds pool acquisition/connection. `DB_QUERY_TIMEOUT_MS` separately bounds the readiness query; timeout destroys that client so a hung query cannot occupy the pool. `SHUTDOWN_TIMEOUT_MS` bounds HTTP drain plus pool closure with monotonic elapsed time before the controlled fallback terminates the process. UTC business-event time remains a separate clock capability.

`createApp({ config, pool, clock })` has no startup side effects. The executable entrypoint calls `main.ts`, which owns configuration loading, dependency construction, port binding, and signal handling.

Application API failures use `{ "error": { "code", "message", "requestId", "details"? } }`; `X-Request-Id` is generated server-side and matches the body. Health remains a separate operational contract with its established `{ status, checks? }` body while still receiving the response request-ID header.

Architecture and execution evidence are in `docs/`, especially `docs/SDD.md`, `docs/implementation-plan.md`, and `docs/progress.md`.
