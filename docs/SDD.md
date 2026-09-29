# Running Tracker — System Design Document v1.0

Date: September 21, 2026
Status: agreed architecture draft; P00–P09 and P10.1–P10.2 verified locally, and the DB fragments under separated PostgreSQL roles. D01 resolved in P04.1, D02 resolved for the trusted tenant context, D03 split into a completed local session boundary and a remaining P12 production identity integration, D04 resolved in ADR-0010 with an explicit offline/cross-device boundary, D05 — in ADR-0009, D06 — in P07/ADR-0017–0021; the stream part of D07 is resolved in ADR-0023, the cache part is resolved in ADR-0030. P09.1 fixes metadata/tile HTTP validation, active membership, revision check, and the history-RLS pipeline boundary (ADR-0027); P09.2 implements PostGIS MVT generation and world-edge handling (ADR-0028); P09.3 adds a bounded process LRU and single-flight (ADR-0029); P09.4 serializes cache hits with atomic archive epoch changes (ADR-0030); P09.5 adds a React/Mapbox source lifecycle with bounded polling and fail-closed cleanup (ADR-0031); P09.6 bounds SQL/concurrency/queue/raw tile bytes without holding DB clients during the queue wait (ADR-0032). P10.1 adds a maintenance-only bounded/restart-safe raw purge with a shared summary advisory-lock boundary (ADR-0033); P10.2 adds authoritative eligibility and a restart-first scheduler (ADR-0034). The next exact fragment is P10.3, owner/annual deletion.
Scope: a personal learning project for practicing backend, geospatial, and full-stack architecture.

This document supersedes fragments v0.1–v0.5. In case of discrepancy, v1.0 governs. Numeric limits not specified by the user are initial design parameters, subject to verification.

## 1. Purpose and boundaries

The user records a run. A coach with explicit permission observes the current position and track. After completion, history, statistics, and an archived line on the map are stored.

Organizations are running clubs. A run belongs to a single user and a single organization. Membership or a coach role does not automatically expose someone else's coordinates.

Mapbox provides the base map. Our Node.js backend generates MVT tiles for archived runs. The active track and markers are drawn as a separate dynamic layer.

In scope:

- reliable ingestion of measurements, retries, and offline catch-up;
- GPS quality processing, history, archive summaries;
- organization isolation and run permissions;
- live observation, state recovery;
- generation and caching of private tiles.

Out of scope: routing, dispatch, map matching, chat, remote recording control by a coach, background guarantees for mobile GPS, multiregion, and high availability.

This is practice for competencies adjacent to the Mapbox Data Tooling role, not a copy of Mapbox's internal architecture.

## 2. Requirements and load estimate

| Parameter | Decision |
|---|---|
| Users | Up to 10; one active run per user |
| Geography | Global storage in WGS84; the map is bounded by Web Mercator |
| Recording | Browser in the foreground, or a reproducible GPS simulator |
| Run source | A single device; a run cannot be handed off to another device |
| Frequency | Target: one new point every 2 s; the device API does not guarantee the interval |
| Duration | Up to 24 hours from the moment the run is created on the server |
| Batch | 1–100 unique seq; up to 64 KiB JSON |
| Safety limit | 50,000 raw points per run |
| Offline | Local buffer, catch-up up to 24 hours after server-side completion |
| Raw retention | Target 7 days after finished_at |
| Archive | 1 year after finished_at, or until deleted by the owner |
| Live | Target p95 ≤ 5 s from a fresh measurement to the observer's screen under normal connectivity |
| Archive map | Target ≤ 60 s after the commit of a published summary, in an active tab |
| Deployment | One region, one backend process, one PostgreSQL instance |
| Budget | Target ≤ €30/month excluding maps; pricing and configuration not yet chosen |

Load: 10 / 2 = 5 new points/s. With a one-hour daily run for each user, that is 18,000 points/day and 126,000 per week. With continuous recording, roughly 3.0 million per week. Over a year, roughly 3,650 archived runs under the ordinary scenario.

An initial estimate of 200–400 bytes/point predated the final index set. For v1.0 planning we reserve 300–600 bytes with indexes: roughly 38–76 MB for 126,000 points; WAL, backups, bloat, and free space are estimated separately. We verify the real figure via pg_total_relation_size on the final schema.

10 observers, each watching all 10 runners: up to 100 compact state records per cycle. For SSE that is up to 5 messages/s at a 2 s cycle with one message per observer. Track changes are fetched separately.

Browser-based recording is not guaranteed with a hidden tab / locked screen. We do not create new points from a stale measurement just to satisfy the target frequency. Real background tracking would require a mobile client. [Geolocation](https://www.w3.org/TR/geolocation/)

## 3. Architecture

~~~mermaid
flowchart LR
    R["React: runner + local buffer"] -->|"HTTPS: commands, GPS"| API["Express 5 API"]
    C["React: coach"] -->|"HTTP: snapshots / changes"| API
    API -->|"SSE: current states"| C
    API --> DB[("PostgreSQL + PostGIS")]
    W["Background jobs in backend"] --> DB
    C -->|"Z/X/Y + revision"| T["Tile handler + LRU"]
    T --> DB
    R --> M["Mapbox: base map"]
    C --> M
~~~

A single modular monolith: Identity/Access, Runs/Ingestion, TrackProcessing, Live, ArchiveTiles, Maintenance. Background jobs are modules of the same deployment; job state is recovered from the DB.

The HTTP adapter is implemented with Express 5. Configuration is validated before dependencies are created; `pg.Pool`, the clock, and downstream services are passed explicitly, without a DI container. Importing modules does not open a port, a DB connection, or timers. This choice replaces the original NestJS skeleton per ADR-0002 and is made for explicit lifecycle and learning transparency, not on the basis of an unproven performance gain.

Geometry for MVT is processed in PostGIS rather than being fully moved into Node.js. LRU stores ready-made binary tiles. Redis, Kafka, Kubernetes, and a separate time-series database are not needed for the MVP.

## 4. Decision and alternatives registry

| Decision | Rationale | What would change the choice |
|---|---|---|
| PostgreSQL + PostGIS | Integrity constraints, ACLs, SQL, and spatial operations | An existing Mongo stack with document-oriented scenarios and less geo-processing |
| Separate immutable points | Idempotency, late delivery, sequential reads | We do not switch to a growing array as load grows |
| SSE + HTTP | Observation is one-directional; recording is already HTTP | Frequent bidirectional exchange might justify WebSocket |
| Polling remains an alternative | Sufficient for 10 users every 2 s | Preferable if operational simplicity matters more than streaming practice |
| On-demand MVT in PostGIS | Processing near the data, per-request permissions | Very high load or public stable datasets → pre-generation |
| Process-local LRU | Single backend, small volume | Multiple replicas benefiting from a shared cache → Redis |
| Full recompute of the final summary | Simple handling of late points | Large runs/expensive processing → incremental or partitioned computation |
| No run_latest | Indexed retrieval of latest points is cheap | A large volume of proximity queries → a separate current-position projection |

MongoDB 2dsphere is suitable for proximity and geo-areas. At five points per second there is no basis for declaring one database "faster" without measurements. MongoDB time-series collections have separate limitations, including unique indexes and some geo-operations; they cannot be treated as a transparent substitute for a regular collection. [MongoDB](https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/)

## 5. Logical schema

UUIDs are used for identifiers, timestamptz for time, bigint for seq/revisions. PostgreSQL `bigint` has a signed 64-bit range; a schema CHECK additionally requires non-negative revisions and a positive seq. The standard `pg` parser returns `int8` as a decimal string even without `::text`; the API preserves this form, and the client compares via `BigInt`, not lexicographically.

`segment_id` is stored as a PostgreSQL `integer`: a physical range from -2,147,483,648 to 2,147,483,647, with an application-level CHECK narrowing it to 0…2,147,483,647. PostGIS `geometry` coordinates are represented as IEEE-754 binary64 (`double precision`): they are not decimal fixed-point values. For a `Point` and every vertex of a `MultiLineString`, finiteness and longitude/latitude ranges are checked; a nullable `display_geom` remains valid. `timestamptz(3)` stores millisecond precision, normalizes the timezone, and rounds more precise input to the nearest millisecond.

D01 canonical `PointInput` resolved in P04.1. The object is strict and contains exactly six required non-null fields from §11.1. `seq` is accepted as a positive decimal bigint string and canonicalized via `BigInt(...).toString()`; `segmentId` is an integer 0…2,147,483,647; longitude/latitude are finite binary64 within −180…180/−90…90; `accuracyM` is a finite non-negative binary64. JSON numeric spelling is discarded during parsing, `-0` is normalized to `0`. `recordedAt` accepts only ISO UTC `Z`, is rounded to the nearest millisecond with second carry, and is serialized with exactly three fractional digits. Retry equality compares only these six canonical fields; `received_at` and `ingested_revision` do not participate.

### 5.1 Tables

| Table | Key fields |
|---|---|
| users | id, external identity identifier |
| organizations | id, archive_revision |
| memberships | org_id, user_id, role, active |
| runs | org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state |
| run_commands | org_id, run_id, command_id, canonical_payload, response, received_at |
| run_points | org_id, run_id, seq, segment_id, recorded_at, received_at, geom, accuracy_m, ingested_revision |
| run_summaries | org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats, computed_at |
| run_shares | org_id, run_id, grantee_user_id, can_read_history, can_read_live |
| run_tombstones | org_id, run_id, owner_user_id, deleted_at, expires_at; no coordinates |

run_tombstones has no FK to the deleted run. Its owner is linked to a membership in the same organization via `ON DELETE RESTRICT`, so deactivating a membership preserves the tombstone. Writing the tombstone, verifying the actual owner of the run being deleted, deleting the run, and changing archive_revision must all happen atomically in a future P10 transaction. The schema alone does not prevent a repeated INSERT of the same run ID. Exporting a deletion log for disaster recovery is a separate operational responsibility, described in section 12.

`run_commands.canonical_payload` and `response` are non-null JSONB objects. This storage alone does not provide canonicalization, semantic retry comparison, command validation, or atomicity with changes to `runs`; those are responsibilities of the P03 transaction.

raw_state: available → purging → purged. status: recording ↔ paused → finished. finished is a terminal state.

geom: geometry(Point,4326), longitude first. display_geom: geometry(MultiLineString,4326), nullable when there are no valid segments.

Composite PK for run_points: (org_id, run_id, seq). Composite FK to runs(org_id,id), ON DELETE CASCADE. Similar relations for shares, summaries, and commands.

Memberships are deactivated rather than having their related record deleted: leaving a club must not cascade-destroy runs. Deactivation forbids new access and participation in shares.

### 5.2 Revisions

| Revision | Scope | When it changes |
|---|---|---|
| data_revision | A single run | New points or a status change |
| control_revision | A single run | An accepted lifecycle command |
| ingested_revision | A single point | Fixed at first insert; immutable |
| source_revision | A single summary | The run version the calculation was based on |
| archive_revision | Organization | Summary publication, deletion, archive ACL/membership changes |
| algorithm_version | Track processing | A change to filtering/geometry rules |

control_revision is separated from data_revision: GPS records must not constantly conflict with pause/resume.

### 5.3 Indexes

- runs: PK (org_id,id); (org_id,user_id,started_at DESC,id DESC).
- runs: partial UNIQUE(user_id) WHERE status IN ('recording','paused').
- runs: (finished_at) WHERE status='finished'.
- run_points: PK (org_id,run_id,seq).
- run_points: (org_id,run_id,ingested_revision,seq) for reading back changes.
- run_summaries: PK (org_id,run_id), GiST(display_geom).
- run_shares: PK (org_id,run_id,grantee_user_id).
- run_commands: PK (org_id,run_id,command_id).
- run_tombstones: PK (org_id,run_id); (expires_at) for future cleanup.

There is no GiST on raw points. History is read by run, not by an arbitrary area of the world.

## 6. Recording and lifecycle

### 6.1 Creation and commands

Starting a recording requires successfully creating a run online; offline creation of a new run is out of scope for the MVP. After creation, the device may buffer GPS and commands locally.

The client creates runId and commandId once and stores them until confirmed. Retrying creation with the same id and the original payload returns the existing run; a changed original payload is a conflict. Deleted run identifiers are not reused: a coordinate-free tombstone is retained for up to one year.

Allowed commands: pause, resume, finish. A command carries expectedControlRevision and a unique commandId. The duplicate-command check precedes the expectedControlRevision check. A retry returns the stored response; a new conflicting transition returns 409.

Commands from the local queue are sent sequentially. After resume, the client increments segment_id; after a measurement gap it also starts a new segment. segment_id is a grouping label, not proof of server-side pause duration.

Auto-finish runs no later than the nearest maintenance cycle after created_at + 24 hours. finished_at is set by the server exactly once. It determines the catch-up/retention windows, but is not used as the precise duration of the actual run.

### 6.2 The ingestion transaction

1. Verify the session, organization, run ownership, and body size.
2. Verify coordinate ranges, number finiteness, seq > 0, segment_id ≥ 0, accuracy_m ≥ 0.
3. Begin READ COMMITTED; lock the run row via FOR UPDATE.
4. Check raw_state and compare existing seq against the canonical payload.
5. For new points, check the catch-up window and the total point-count limit.
6. If there are new points, bump data_revision once; insert them with this ingested_revision.
7. COMMIT, then ACK.

The same key with different source content rejects the whole batch. received_at and ingested_revision do not participate in comparing the client payload. A single ON CONFLICT DO NOTHING is not sufficient.

After the catch-up window closes, we confirm exact retries while the raw rows are still available; new points are rejected. After purging has begun, we no longer promise to recognize an old retry — we return RAW_HISTORY_UNAVAILABLE.

Pause/finish do not reject previously recorded points solely due to the current status. The catch-up window is governed by server time; it does not guarantee the trustworthiness of the device's claimed timestamps.

We store device time as-is. For live eligibility we only accept a recorded_at no older than 15 s and no more than 5 s ahead of server time. Violating this condition does not destroy the offline history.

### 6.3 Durability guarantee

A local IndexedDB buffer stores the measurement and seq until a specific batch's ACK. Retries use backoff and jitter; a permanent 4xx error is not retried indefinitely.

In P05.5, Geolocation and the deterministic simulator use a single foreground `CaptureSource`. Starting, resuming, and recovering a recording atomically allocate a new local `segment_id`; callbacks are serialized and accepted only by the current capture generation. The owner/fencing-token check is re-performed within the same IndexedDB transaction that allocates the seq and stores the point, so a stale tab cannot write a measurement after a lease takeover. Being offline does not stop capture, but a hidden tab / locked screen gets no background guarantees.

ACK means a PostgreSQL commit under fsync=on and synchronous_commit=on. This protects against an ordinary process crash on healthy persistent storage. Disk/node loss without a replica can lose confirmed data; backups have a separate RPO. [PostgreSQL WAL](https://www.postgresql.org/docs/current/runtime-config-wal.html)

## 7. Geospatial processing

Track order is determined by seq; recorded_at is used for intervals. received_at does not break the track after an offline catch-up.

A valid edge between seq-adjacent points requires:

- consecutive seq and the same segment_id;
- accuracy_m ≤ 30 for both points;
- 0 < time difference ≤ 10 s;
- geodesic speed ≤ 12 m/s.

The thresholds are algorithm_version parameters, not a promise of GPS accuracy. An invalid point/edge does not create an automatic connection by skipping over it. In P06.1, `app_private.current_track_algorithm_version()` returns `v1`, and a single `app_private.evaluate_track_edge(...)` performs the PostGIS/geography check for both future summary and live-track queries. An unknown version is rejected; the primary rejection reason is chosen in the order seq gap → segment break → poor accuracy → nonpositive recorded-time delta → excessive time gap → excessive speed (ADR-0012).

distance_m is the sum of ST_Distance(a.geom::geography,b.geom::geography) over valid edges, before simplification. observed_duration_s is the sum of their time intervals; we do not call it moving time. Elevation is not accounted for. [ST_Distance](https://postgis.net/docs/ST_Distance.html)

We store counts of raw points, poor accuracy, and gaps by cause. `acceptedPointCount` counts unique endpoints of at least one valid edge; isolated points do not become accepted. When there are no valid edges, distance and observed duration are 0, and `insufficientData=true`.

In P06.2, `app_private.calculate_run_summary(org, run, sourceRevision, algorithmVersion)` reads only points with `ingested_revision <= sourceRevision`, applies the single evaluator to seq-ordered neighbors, and returns the metrics, the full `QualityStats`, and the uncompressed valid chains as a nullable `MultiLineString`. The function is available to the maintenance role without direct SELECT on the tables; it does not publish the summary and does not change the archive revision (ADR-0013).

We build a MultiLineString from the valid chains. Single points do not become fictitious lines. For the archive, we use Douglas–Peucker with an initial tolerance of roughly 5 m in a local metric projection:

- segments up to 20 km by cumulative length, sharing a boundary point;
- a local azimuthal-equidistant projection;
- endpoint-preserving simplification, then transformed back to 4326;
- normalization/splitting at the antimeridian.

This is an engineering approximation for display, not a strict global metric guarantee. Web Mercator is not used for precise distance. ST_Simplify measures tolerance in the units of the input SRS. [ST_Simplify](https://postgis.net/docs/ST_Simplify.html), [ST_Transform](https://postgis.net/docs/ST_Transform.html)

In P06.3, `app_private.simplify_display_geometry(acceptedChains, algorithmVersion)` implements this pipeline as a separate pure maintenance capability. A cumulative geodesic M-measure splits each chain into segments no longer than 20 km sharing a boundary point; each segment is simplified with a 5 m tolerance in a local azimuthal-equidistant projection. After transforming back, longitudes are unwrapped into a continuous sequence, crossings of each `180 + 360k` boundary are split, and the components are mapped back into the `[-180, 180]` range. Zero-length display components are discarded; the P06.2 metrics are not recomputed from the simplified geometry (ADR-0014).

A full recompute of finished runs runs once a minute:

1. Fix the source revision, then read revision-bound points and perform the calculation/simplification within a single short statement snapshot.
2. Compute the result without holding a lock on the run.
3. When publishing, lock the organization, then the run; recheck the revision, state, and the absence of a deletion.
4. Write the summary and bump archive_revision in a single transaction.
5. On a revision mismatch, discard the result and retry later.

P06.4 implements this protocol via the maintenance-only `find_stale_run_summaries` and `publish_run_summary`. Calculation and simplification run in a single materialized statement, so they use one MVCC snapshot without a run lock. Publication locks the organization, then the run, and under those locks rechecks status/raw state, the exact `data_revision`, the absence of a tombstone, and whether a summary is already current. The successful upsert and the archive_revision bump happen atomically; a stale/deleted/duplicate result changes neither the summary nor the revision. The exact v1 shape of `QualityStats` is checked by the publication capability, while the table CHECK remains a version-agnostic object guard (ADR-0015).

P06.5 adds `claim_stale_run_summary`: each worker obtains a transaction-scoped advisory claim for an organization/run pair in an explicit transaction and skips already-claimed candidates. The claim is held through calculation/publication but does not lock the organization/run rows; row locks appear only inside the earlier publication capability, in organization → run order. `RUN_SUMMARY_CONCURRENCY` bounds a single process to 1–8 parallel workers (default 2), the cycle waits for all workers to settle, and the maintenance pool has one extra slot for auto-finish. Commit/rollback/connection loss automatically release the claim; the revision/state checks remain the correctness fence (ADR-0016).

All operations that need both locks respect the organization → run order. Ingestion locks only the run and never subsequently requests an organization lock.

## 8. Reads, permissions, and consistency

An owner reads their own run. For someone else's run, an active membership and an explicit grant are required:

- can_read_live — an unfinished run, including its current track;
- can_read_history — history, the summary, and archive tiles;
- modifying points/status — owner only;
- shares are modified by the owner only.

RLS is enabled on all tenant-owned tables. The runtime role is not the owner, not a superuser, and has no BYPASSRLS. The tenant/user context is set by the server transaction-locally after authentication. The API remains the trusted boundary; the client does not connect directly to PostgreSQL.

The ACL applies to points/summaries even on a direct query, not only when reading runs. Policies are verified via integration tests under the real runtime role. Maintenance uses a separate restricted role. [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

P02A fixes the minimal matrix before the run/share API exists: the runtime reads only its own `users` row, the current `organizations` row, and its own active `memberships`, and all three require an active membership for the transaction-local user/org pair. The runtime role has no DML granted on these tables; fixtures are executed by the migration/object owner. An empty or invalid context returns zero rows. `app_private.has_active_membership()` is a narrow `SECURITY DEFINER`: it returns only a boolean, is owned by the object owner, has a fixed `search_path`, is revoked from PUBLIC, and is executed only by the runtime role. This eliminates the `memberships` policy's recursive self-reference, but does not replace RLS.

P02A roles: the privileged bootstrap creates extensions/roles and is not used by the API; `running_tracker_owner` runs migrations and owns application objects; `running_tracker_runtime` is what the API connects as; `running_tracker_maintenance` currently has only CONNECT, with no table/DDL privileges. The runtime role's ability to call `set_config` does not protect against arbitrary SQL with stolen DB credentials. P03.1 now controls the HTTP context: `userId` is taken only from a verified server-side session, the client-selected `orgId` is validated, and active membership is rechecked inside the same runtime-role transaction before the application callback runs. This is a local development/test boundary; the production identity/provider remains P12.

P02B storage/ACL is described in ADR-0004/0005/0006. A live grant applies only to `recording`/`paused`, a history grant only to `finished`; the coach role by itself grants no access. Mutual recursion between policies is eliminated by narrow boolean `SECURITY DEFINER` predicates with a fixed `search_path`; PUBLIC EXECUTE is revoked. `run_points` inherits its current parent ACL and allows owner INSERT without UPDATE/DELETE; `run_summaries` is available to the runtime for history reads only. `run_commands` allows SELECT/INSERT only to the active owner of the parent run and grants the runtime no UPDATE/DELETE; the grants do not expose command payload/response. `run_tombstones` is available to the runtime only for SELECT of its own marker under active membership, and does not touch an already-deleted run. Direct SELECT and JOIN, grant/status combinations, revocation, invalid context, and denied mutations are verified under the real runtime role. The forward-only migration `0004` checks every vertex of `display_geom`, and `0005` adds commands/tombstones. D02 is resolved within the bounds of the trusted transaction-local context; the HTTP authentication/session boundary remains P03.

History: an indexed pass over (org_id,run_id,seq), pages up to 1,000 points. For raw replay, the cursor contains data_revision; a version change requires restarting the read. Live uses a different stable protocol, described in section 9.

Archive area: ST_Intersects(display_geom,envelope4326), ACL, and the period, before pagination. Up to 100 runs per page, cursor (started_at,id). The semantics are an intersection of the displayed simplified line, not proof of actually being at that point.

Current positions within a radius: eligible recording runs → the two most recent points via LATERAL → the quality of the latest edge and freshness → ST_DWithin(...::geography,...,radius_m). Up to 10 candidates; no spatial index on current positions. We do not substitute an unusable latest point with an older one and present it as fresh.

## 9. Live and recovery

### 9.1 SSE state

A single tab opens a single GET /api/orgs/{orgId}/live. Authentication is a same-origin Secure/HttpOnly session cookie. State-changing HTTP requests are protected by an Origin/CSRF check; tokens are never placed in the URL.

SSE: text/event-stream, private/no-store, proxy buffering disabled, a heartbeat every 15 s, HTTP/2 at the external edge. The native EventSource automatically reconnects, but does not create a durable replay. [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)

The first live.state is sent immediately. Then a shared backend cycle runs every 2 s, fetching revisions, the latest points, and current permissions, batching the queries. An SSE connection does not hold a DB connection/transaction the whole time.

P08.1 implements this transport as a single process-local hub: the initial state is read via a short runtime-role tenant transaction before the stream opens, and a shared non-overlapping cycle groups connections by user/organization and bounds read concurrency. A stream has its own `streamId`/`sequence`; the heartbeat is sent as an SSE comment and does not change the sequence. The connection/opening count is bounded by configuration (ADR-0022).

A message is the full compact list of accessible unfinished runs. When a run disappears, the client removes it from the live layer. If access to history remains, it loads the finished run separately.

Under backpressure, only the latest pending state is kept per connection; a connection blocked for too long is closed. The number of concurrent connections is bounded. Before a new send, we account for detected permission changes and cancel any not-yet-sent stale state. Data already sent cannot be recalled.

When `response.write=false`, P08.1 keeps a single newest pending state, replaces the previous one, and closes the stream after a bounded timeout; an already-accepted Node writable buffer is not considered a replay queue. P08.2 rechecks the session store before and after the initial read, before poll/publish/drain/heartbeat, and closes the stream at an exact expiry timer. A membership denial closes the corresponding user/org group and clears pending state; a grant-filtered full state replaces the pending state. The authorization checkpoint is the live-state snapshot statement inside the short poll transaction: a revoke after the snapshot is detected on the next cycle, and already-delivered bytes are not revoked (ADR-0023).

A position is confirmed only with a valid last edge; with a single usable point it is unconfirmed; with poor accuracy/timing it is null. The client computes age relative to serverTime; a GPS loss is flagged even with a working SSE connection.

With position=null, the client may keep the previously shown marker as an explicitly stale last-known position, but must not treat it as current. When a run disappears from the allowed list, both the current and last-known data for that run are removed.

P08.3 implements the browser coach state as a full replacement on every accepted `live.state`. Sequence is compared only within a single `streamId`; a disappeared run immediately loses its marker, last-known coordinate, and selection. Freshness is computed from `serverTime` plus monotonic browser elapsed time: an initial threshold of 10 seconds moves even the current position to stale without a new message. `position=null` retains the previous coordinate only as stale. A transport/contract failure closes the EventSource and clears the state; a manual reconnect does not create an infinite auth retry. An explicit set of selected runs prepares the boundary for P08.4, but P08.3 does not load geometry and requires no map token (ADR-0024).

P08.4 links only explicitly selected and freshly re-authorized runs to the P07.5 `LiveTrackStore`. SSE revisions collapse to the greatest target with one in-flight chain per run; geometry remains atomic up to the terminal page. Deselection, full-state omission/revoke, an identity/org change, and disconnect all abort the HTTP request and evict the cached track. On an algorithm-version change, a fresh snapshot begins. Transport reconnect is bounded by 1/2/4-second pauses and a known session expiry; until a new authorization-filtered full state arrives, the marker, selection, and geometry are hidden. The prior selection intent is then intersected with the currently allowed set and restored via a fresh snapshot, without `Last-Event-ID` replay (ADR-0025).

P08.5 fixes a verifiable external transport: a pinned Nginx terminates TLS 1.2/1.3 and HTTP/2, serves the production React build, and forwards `/api` to the internal Express over HTTP/1.1. For `/api/orgs/*/live`, proxy buffering/cache/gzip/upstream compression and retry are disabled; `proxy_read_timeout=75s`, send timeouts are 30s, and `X-Accel-Buffering: no` is passed to the client. The same-origin Secure/HttpOnly cookie remains the sole credential channel. A local certificate is generated for seven days in a gitignored directory; managed TLS/secrets/production identity remain P12 (ADR-0026).

### 9.2 Snapshot and changes

SSE reports dataRevision but does not carry the full history. The client synchronizes only the tracks it displays.

An initial live-track fixes R and returns points with ingested_revision ≤ R. Pagination is sorted by seq; the cursor is server-signed and includes org/run/user, R, algorithmVersion, the last seq, and a 10-minute expiry.

In P07.1, the first HTTP request fixes `runs.data_revision` as R within the same SQL statement snapshot that selects the page; continuations read only `ingested_revision <= R` and therefore do not hold a transaction across requests. The earlier P07.1 temporary cursor linked org/run, the operation, R, algorithmVersion, and the last seq; P07.4 replaced it with a signed user-bound envelope with expiry. Every request still rechecks the session, membership, live/history ACL, and raw-state on each call (ADR-0017, ADR-0020).

Changes(afterRevision=A) fixes T ≥ A. The changed items are:

- points with A < ingested_revision ≤ T;
- their immediate existing successors in the set at version T.

The set is deduplicated and sorted by seq. For each entry the server computes predecessorSeq and connectFromPrevious over points with ingested_revision ≤ T. This corrects the connection to the next point on a late insert.

In P07.2, the first `/live-track/changes` request fixes the current `runs.data_revision` as T within the same SQL statement, a materialized `(A,T]` set is combined with immediate successors via `UNION`, and keyset pagination proceeds over bigint `seq`. The cursor links the operation, org/run, A/T, algorithmVersion, and the last seq; P07.4 added the signature, user binding, and expiry (ADR-0018, ADR-0020).

In P07.3, both live-track requests materialize the full `ingested_revision <= T` set and compute the immediate predecessor via `lag(...)` before the keyset page filter. So the first point of a continuation page retains its predecessor from the previous page. `predecessorSeq` returns the immediate seq-ordered predecessor even for a rejected edge; only the very first point of the set gets `null`. `connectFromPrevious` is computed by the single `app_private.evaluate_track_edge(...)` and is not duplicated on the frontend. Changes after T do not affect either the predecessor or the edge result of an old cursor (ADR-0019).

In P07.4, a strict versioned cursor payload is signed with HMAC-SHA-256 and includes the authenticated user, org/run, the operation, A/T where applicable, algorithmVersion, the last seq, and an absolute expiry. Snapshot/changes cursors are not interchangeable; tampering, cross-user/route replay, and expiry all return a single `INVALID_CURSOR`. The first continuation fixes a ten-minute deadline, and later pages do not extend it. Production requires a separate key of at least 256 bits; every request independently rechecks authorization/raw state (ADR-0020).

In P07.5, the browser `LiveTrackStore` isolates state and a single in-flight sync per user/org/run. The entire cursor chain is applied to a temporary seq-keyed map; the public points/revision are replaced only after the terminal page. Concurrent revision notifications collapse to the greatest target revision, repeated upserts are idempotent, and `INVALID_CURSOR` or an algorithmVersion change discards staged changes and triggers a fresh snapshot (ADR-0021).

In P08.4, the selected-track coordinator passes `dataRevision` from the full SSE state into `LiveTrackStore`, without creating a second page-application algorithm. Deselecting, a run disappearing from the authorized state, or a disconnect cancels the current load and removes the cached geometry. Reconnect starts a fresh snapshot only after a new full state and a recheck of the selected run (ADR-0025).

All pages fix T and algorithmVersion; changes after T do not appear in them. A DB snapshot is not held across HTTP requests: reproducibility is provided by immutable points and ingested_revision. Every request rechecks the ACL and raw_state.

After all pages are received, the client atomically applies the upserts and advances the local revision. On a retry, the same keys are applied; there is one sync per run at a time. SSE versions arriving during the load are merged into the latest target revision.

On an expired cursor, a new algorithmVersion, or loss of local state — a new snapshot. On finish, the live right ends; continuing the history requires can_read_history. While purging/purged, the detailed track is unavailable.

The run seq is not a change cursor. Last-Event-ID is not used as a promise of SSE replay. On a failure after a DB commit, the next state check will still discover the new revision.

## 10. Archive tiles and cache

### 10.1 Generation

XYZ, z=8…16; 0 ≤ x,y < 2^z. Below z8 the layer is hidden; above z16 is overzoom. At low zoom, a switch to separate aggregates is possible in the future.

Source: published summaries, finished runs, history ACL, an absolute date range. The latest published summary is returned; if it lags behind data_revision due to late points, the details show a pending recompute, and publishing a new summary updates archive_revision.

PostGIS pipeline:

1. ST_TileEnvelope(z,x,y) in 3857.
2. Candidate selection over the expanded area and GiST(display_geom) in 4326.
3. Access/period filters.
4. Clip to the valid Web Mercator area, ST_Transform into 3857.
5. ST_AsMVTGeom with extent=4096, buffer=64, clip_geom=true.
6. Drop empty/degenerate non-linear results, ST_AsMVT.

For selection, margin=64/4096; unexpanded tile bounds are passed into ST_AsMVTGeom. At the antimeridian, the search envelope is split and, if needed, an adjacent world-copy is shifted before clipping. [ST_TileEnvelope](https://postgis.net/docs/ST_TileEnvelope.html), [ST_AsMVTGeom](https://postgis.net/docs/ST_AsMVTGeom.html)

MVT layer: runs. The run_id property is a string UUID, not a numeric feature ID. Personal names and raw GPS data are not included. A single run can appear in multiple tiles. [ST_AsMVT](https://postgis.net/docs/ST_AsMVT.html)

There is no pagination or LIMIT 100 in MVT. Initial safeguards: up to 1 MiB of uncompressed tile, up to 2 s of SQL, at most 2 parallel generations per process, a queue of up to 16 requests. Exceeding these is not masked with truncated geometry: an explicit error, a metric, and a suggestion to narrow the period/zoom in.

### 10.2 Cache and revision

Process-local LRU: 32 MiB of binary data, TTL 5 minutes, single-flight for a given key. Key:
formatVersion / orgId / userId / archiveRevision / canonicalFilterHash / z/x/y.

Empty tiles are cached; errors and access denials are not. Membership and the current archive_revision are checked before reading the cache, from the DB. ACL changes and a revision change are atomic.

On a cache miss, the revision, ACL, and geometry are read within a consistent snapshot. A request with a stale revision gets a 409 ARCHIVE_REVISION_CHANGED, not a historical tile. Under a concurrent change, authorization has a point-in-time check; a response already started/delivered cannot be retroactively revoked.

Publishing/deleting a summary, changing archive grants, and deactivating a membership all bump the organization's archive_revision. Coarse invalidation affects all of an organization's tiles; for 10 users this is acceptable.

Tile HTTP: application/vnd.mapbox-vector-tile, Cache-Control: private, no-store. Mapbox may keep visible tiles in memory. Ready network responses are served from the LRU; a public CDN is not used for them.

P09.3 implements a process-local LRU: a 32 MiB payload budget, a separate 4096-entry limit for bounded metadata on empty tiles, a monotonic 5-minute TTL, and single-flight on the full key. UUIDs, revisions, and timestamps are canonicalized before hash/key construction; empty buffers are stored, oversized buffers and rejected generations are not. P09.4 adds a DB ordering point: the tile transaction takes the organization `FOR SHARE`, then rechecks active membership/current revision, and only then reads the cache; publish, summary delete, effective history-grant, and membership active-state changes all atomically advance the organization epoch. A runtime share mutation first takes the organization `FOR UPDATE`, preserving the organization-before-run lock order. Old cache entries become unreachable by revision key and expire per the P09.3 bounds (ADR-0030).

P09.6 splits a cache miss into a short authenticated/locked probe, a bounded wait with no PostgreSQL client held, and a repeated authenticated/locked transaction after admission. A single process allows at most two concurrent generations and 16 pending distinct cache keys; same-key callers remain a single single-flight. The second transaction rechecks membership/revision and the cache, then sets a transaction-local `statement_timeout=2000ms`. A full raw MVT of exactly up to 1 MiB inclusive is cached/returned; a larger one is not cached and gets `422 TILE_TOO_COMPLEX`. Queue overflow and a statement timeout are distinguished as `503 TILE_BUSY` and `503 TILE_TIMEOUT`; feature `LIMIT`/truncation are not used (ADR-0032).

An active client checks archive metadata every 30 s; on returning to the tab, immediately. On a new revision, it changes the template URL via setTiles; on access revocation, it clears the layer. TTL is not a mechanism for enforcing the 60 s target. [Mapbox VectorTileSource](https://docs.mapbox.com/mapbox-gl-js/api/sources/#vectortilesource)

P09.5 implements this lifecycle as a separate controller, decoupled from the Mapbox runtime: one metadata request is active per scope, extra poll/focus/409 refreshes collapse together, and a user/org/period change cancels the old request. The React adapter applies a new revision via `setTiles`, but removes the layer and source on 401/403. A transient network/5xx error keeps the last successfully authorized source with a visible error state; the source is always removed before the provider map is removed. Mapbox GL JS 3.31.0 loads as a separate browser chunk only when a public `VITE_MAPBOX_ACCESS_TOKEN` is present; tokenless tests do not call the external provider (ADR-0031).

## 11. API contracts

Application API base prefix: /api/orgs/{orgId}; the session API uses `/api/session`. All dates are ISO 8601 UTC, coordinates are longitude/latitude. The user identifier is taken from the verified server-side session, not from headers/body/query.

### 11.0 Session boundary

| Method and path | Requirements | Success |
|---|---|---|
| POST /api/session | Only when explicitly enabled development/test local auth; exact configured Origin; application/json; `{ userId }` from a server allowlist | 201 `{ identity: { userId }, expiresAt, csrf: { headerName, token } }` + session cookie |
| GET /api/session | A valid, unexpired/unrevoked session cookie | 200 with the same public session response |
| DELETE /api/session | Session cookie + exact Origin + session-bound `x-csrf-token` | 204, server-side revoke and a cleared cookie |

The opaque session token is stored client-side only in an `HttpOnly` cookie and indexes the server-side record by digest. The cookie uses `SameSite=Strict`, `Path=/`, no `Domain`; `Secure` is required for HTTPS, and an explicit exemption is allowed only in development/test for local HTTP. All session responses use `Cache-Control: no-store`. Expiry is checked server-side via an injectable clock.

The local in-memory store is bounded, injectable, creates no background timers, and loses session state on restart. Local auth is disabled by default and forbidden in production until a pool/listener exists. Bootstrap login is protected by an exact configured Origin and a JSON-only request; the allowed Origin is not derived from Host/X-Forwarded. The remaining state-changing session-authenticated routers reuse the session → Origin → CSRF middleware chain. The production provider/real login remains P12.

### 11.1 Common types

~~~ts
type UUID = string;
type Revision = string;
type Seq = string;
type Time = string;
type RunStatus = "recording" | "paused" | "finished";

interface RunView {
  runId: UUID; status: RunStatus;
  startedAt: Time; finishedAt: Time | null;
  dataRevision: Revision; controlRevision: Revision;
  rawState: "available" | "purging" | "purged";
  summary: null | {
    sourceRevision: Revision; algorithmVersion: string;
    distanceM: number; observedDurationS: number;
    qualityStats: QualityStats;
  };
}
interface QualityStats {
  rawPointCount: number;
  acceptedPointCount: number;
  acceptedEdgeCount: number;
  poorAccuracyPointCount: number;
  seqGapCount: number;
  segmentBreakCount: number;
  nonpositiveTimeDeltaCount: number;
  excessiveTimeGapCount: number;
  excessiveSpeedCount: number;
  insufficientData: boolean;
}
interface PointInput {
  seq: Seq; segmentId: number; recordedAt: Time;
  longitude: number; latitude: number; accuracyM: number;
}
interface TrackPoint {
  seq: Seq; segmentId: number; recordedAt: Time;
  coordinates: [number, number]; accuracyM: number;
  predecessorSeq: Seq | null; connectFromPrevious: boolean;
}
interface TrackPage {
  fromRevision: Revision | null; // null for the initial snapshot
  toRevision: Revision;
  algorithmVersion: string;
  upserts: TrackPoint[];
  nextCursor: string | null;
}
interface ApiError {
  error: { code: string; message: string; requestId: string;
    details?: Record<string, unknown> };
}
~~~

TypeScript does not replace runtime validation at either boundary.
`QualityStats` counters are non-negative integers, `insufficientData` is a boolean. The current P02B CHECK guarantees only a JSON object; full key/type validation and value computation belong to P06 summary publication.

### 11.2 Recording and control

| Method and path | Request | Success |
|---|---|---|
| PUT /runs/{runId} | { startedAt } | 201 RunView; retry 200 RunView |
| POST /runs/{runId}/commands | { commandId, type: pause/resume/finish, expectedControlRevision } | 200 { commandId, status, controlRevision, dataRevision, finishedAt } |
| POST /runs/{runId}/points | { points: PointInput[] } | 200 { dataRevision, insertedCount, duplicateCount } |
| DELETE /runs/{runId} | — | 204, cascading delete + archive revision |
| PUT /runs/{runId}/shares/{userId} | { canReadLive, canReadHistory } | 200 with the stored booleans |
| DELETE /runs/{runId}/shares/{userId} | — | 204 |

POST points is atomic: on success, all unique seq values in the request are either stored or match existing ones. Duplicates within a batch are normalized; a content conflict rejects the batch.

DELETE is idempotent for the owner, accounting for the tombstone. A repeated PUT on a deleted run returns 410 RUN_DELETED.

### 11.3 Reads

| Method and path | Parameters | Response |
|---|---|---|
| GET /runs | from, to, limit≤100, cursor | { items: RunView[], nextCursor } |
| GET /runs/{runId} | — | RunView |
| GET /runs/{runId}/points | cursor, limit≤1000 | { dataRevision, points: PointInput[], nextCursor } |
| GET /runs/{runId}/live-track | cursor, limit≤1000 | TrackPage |
| GET /runs/{runId}/live-track/changes | afterRevision or cursor, limit≤1000 | TrackPage |
| GET /runs/{runId}/track | mode=archive | GeoJSON Feature with MultiLineString/null, sourceRevision, algorithmVersion |
| GET /archive/runs | bbox, from, to, limit≤100, cursor | { items: RunView[], nextCursor } |
| GET /live/nearby | longitude, latitude, radiusM≤5000 | { serverTime, items: [{ runId, coordinates, recordedAt, distanceM }] } |

from/to define a half-open interval over started_at. For the archive period, the maximum is 366 days. bbox: west,south,east,north; west>east means crossing the antimeridian. nearby uses only confirmed/fresh positions.

The raw points endpoint returns raw data only per history ACL/ownership; live-track returns unfinished runs per live ACL or finished runs per history ACL. This allows catching up on the final state if the history right remains.

### 11.4 SSE

GET /live → event: live.state, JSON:
~~~ts
interface LiveState {
  streamId: UUID; sequence: number; serverTime: Time;
  algorithmVersion: string;
  runs: Array<{
    runId: UUID; status: "recording" | "paused";
    dataRevision: Revision;
    position: null | {
      seq: Seq; coordinates: [number, number];
      recordedAt: Time; accuracyM: number;
      quality: "confirmed" | "unconfirmed";
    };
  }>;
}
~~~

streamId is new on each connection, sequence orders messages only within that connection. On session loss, the connection is closed; the client checks the session endpoint and does not enter an infinite auth-error loop. Session-expiry checking also happens on a live connection.

### 11.5 Tiles

GET /archive/metadata?from=...&to=...
~~~json
{
  "archiveRevision": "81",
  "filter": {"from": "2026-09-01T00:00:00Z", "to": "2026-10-01T00:00:00Z"},
  "tiles": ["/api/orgs/{orgId}/tiles/runs/{z}/{x}/{y}.mvt?revision=81&from=...&to=..."],
  "sourceLayer": "runs",
  "minzoom": 8,
  "maxzoom": 16
}
~~~

The URL is a template; the server supplies the real orgId/filter values. The revision and filter do not grant authorization.

GET /tiles/runs/{z}/{x}/{y}.mvt?revision=...&from=...&to=... → 200 binary MVT; an empty set is a valid empty MVT. Errors are a JSON ApiError with the appropriate HTTP status. The frontend handles tile-source errors and refreshes metadata on a revision mismatch.

P09.1 implements the metadata and tile HTTP boundary: zoom is bounded 8–16, `x/y` are canonical integers in `[0,2^z)`, the period is ordered and does not exceed 366 days. Both endpoints go through session/active-membership checks and a runtime-role tenant transaction; before the pipeline, the tile handler rereads the current `archive_revision` and returns `409 ARCHIVE_REVISION_CHANGED` on a mismatch. The pipeline receives the same RLS-bound client, so history ACL is not superseded by revision/filter. Before P09.2 is wired in, this seam fails closed with `503 TILE_BUSY`, rather than a false empty tile (ADR-0027).

P09.2 connects the production pipeline to this seam: separate `&&` candidate branches preserve GiST selection for the ordinary and the opposite antimeridian envelopes, geometry is clipped to the valid Web Mercator world before projection, world copies are shifted after projection, and `ST_AsMVTGeom` uses extent 4096, buffer 64, and clipping. The result contains only a string `run_id`; an empty set is encoded as an empty MVT. P09.4 closes cache invalidation, P09.5 the frontend source lifecycle, P09.6 bounded SQL/concurrency/queue/raw-byte resource usage (ADR-0028, ADR-0030–0032).

### 11.6 Errors

Application errors use the single `ApiError` envelope from 11.1; the server-generated UUID matches in `X-Request-Id` and `error.requestId`, and an inbound request-id header is not reflected. `details` allows only safe validation metadata. Stack traces, SQL, credentials, cookies, session/CSRF tokens, and internal error objects are never returned. Health endpoints remain a separate operational contract with their previous status/body semantics `{ status, checks? }`, but they also get `X-Request-Id`.

| Status | Codes and behavior |
|---|---|
| 400 | INVALID_REQUEST, INVALID_CURSOR; fix the request |
| 401 | AUTH_REQUIRED; restore the session |
| 403 | ORG_ACCESS_DENIED; stop the organization's subscriptions |
| 404 | RUN_NOT_FOUND; also for a specific run that is inaccessible |
| 409 | POINT_CONFLICT, CONTROL_REVISION_CONFLICT, ACTIVE_RUN_EXISTS, UPLOAD_WINDOW_CLOSED, ARCHIVE_REVISION_CHANGED, HISTORY_REVISION_CHANGED, CURSOR_EXPIRED, ALGORITHM_CHANGED |
| 410 | RAW_HISTORY_UNAVAILABLE, RUN_DELETED |
| 413 | BATCH_TOO_LARGE |
| 422 | RUN_POINT_LIMIT, TILE_TOO_COMPLEX |
| 429 | RATE_LIMITED; honor Retry-After |
| 503 | DATABASE_UNAVAILABLE, TILE_BUSY, TILE_TIMEOUT; bounded retry with jitter |

Conflict/error details never contain someone else's points. Authorization is checked before any retention or object-conflict information is revealed.

## 12. Retention, deletion, backups

Seven days after finished_at, maintenance checks for a closed upload window and a current summary. Under a run lock it sets raw_state=purging; new raw requests get 410, and recomputation from raw data is forbidden. It then deletes points in bounded batches and sets purged. Retrying the job is safe.

P10.1 implemented an explicit one-run primitive: a transaction advisory lock shared with the summary worker, then a run-row lock, a transition to `purging` before deletion, one `seq`-ordered batch of at most 1,000 rows per transaction, and an atomic `purged` when nothing remains. Committed `purging` state plus any remaining rows are the sole recovery state; a rollback restores both the rows and the state. The runtime can no longer change `raw_state` directly. P10.2 below adds selection by the seven-day window, a closed upload window, and summary currency; the initial limit of 1,000 is subject to measurement/tuning in P11.

P10.2 threads a single managed UTC instant through the bounded transactional claimant and purge. New work starts only when `finished_at + 7 days <= now`, the 24-hour upload window is strictly closed, and the summary is current for `data_revision`/algorithm/quality schema; the same conditions are rechecked inside the mutating capability after the shared advisory lock and the run-row lock. Committed `purging` is always selected ahead of new work and resumes without a re-eligibility check. One settled cycle deletes at most one batch; an overdue run without a current summary is left unchanged and produces an identity-free warning. Structured metrics/alert routing remain P11.1 (ADR-0034).

If a summary has not been built, deletion is deferred with an alert: seven days is a target, not a hard legal promise. After purged, only the summary and the archived geometry are available; exact replay/recompute is impossible.

After one year, the run and its associated data are deleted; archive_revision is bumped. Explicit owner deletion takes effect earlier and also clears local server caches via a key-version change. Old unreachable LRU entries are evicted/expire after at most 5 minutes.

A daily encrypted off-host backup; retention 7 days. Initial disaster-recovery targets: RPO ≤24 hours, RTO ≤4 hours, subject to a restore-drill verification. Backups may contain deleted data until it expires; before returning a restored DB to access, subsequent deletions must be reapplied from a separately preserved deletion log, and current access restrictions must be restored.

This is a separate operational task. Until a verified restore process exists, the service does not claim the corresponding RPO/RTO as achieved.

## 13. Deployment and operations

Locally: Docker Compose, PostgreSQL/PostGIS, Express 5, React, the GPS simulator. Demo: a single host/region, a TLS reverse proxy, a persistent DB volume, an external backup. The backend and PostgreSQL have independent resource limits.

Initial limits: a DB pool of 10 connections per backend, at most 2 concurrent tile queries, at most 2 summary jobs. Long-lived SSE connections do not occupy pool slots. Requests and background jobs have timeouts. Limits are refined by measurement, not by user count alone.

Production authentication is wired in during P12 via a verified identity provider; registration/password recovery are not implemented as a custom cryptographic protocol. P03.1 provides only an explicitly enabled development/test identity/session fixture with an opaque token and a bounded process-local store; production startup with it is forbidden, and a restart loses local sessions.

Graceful shutdown stops accepting new HTTP connections, waits a bounded time for active requests and pool closure, and forcibly closes HTTP connections and exits with an error if the overall deadline is exceeded. After startup, jobs discover unfinished work in the DB.

## 14. Bottlenecks and evolution

| Node | Risk | Signal | Next step |
|---|---|---|---|
| PostgreSQL write path | WAL, indexes, catch-up spikes | commit p95, I/O, pool wait | batching, quotas; then queue evaluation |
| Summary processing | Full recomputes of large runs | revision lag, CPU | partitioned computation/separate workers |
| Tile generation | Too much geometry in one tile | bytes, SQL p95, timeout | LOD, subdivision, a projected index; then pre-generation |
| Organization revision | Coarse invalidation/hot row | miss ratio, lock wait | dataset/per-user scope versions |
| Live reconciliation | Growing viewers and ACL queries | cycle duration >2 s | commit notifications + periodic reconciliation |
| Raw retention | DELETE/autovacuum falling behind | dead tuples, table growth | partitioning after revisiting keys |
| Single server | Unavailability/node loss | health/backup failures | managed DB/replica, multiple API instances |

Time-based partitioning is not added mechanically: global uniqueness of (org_id,run_id,seq) must be preserved, and PostgreSQL requires the partition key to be included in the relevant unique constraints. Deduplication design would need to be revisited.

With multiple API instances, the shared tile cache could become Redis. Cross-instance notifications do not replace recovery from the DB. Guaranteed per-event processing by separate services would require a durable outbox; switching SSE → WebSocket does not solve this by itself.

## 15. Verification and acceptance criteria

### Correctness

- Retry and concurrent retry of a batch: one row per key.
- Commit succeeds, ACK is lost: a retry is safe.
- The same seq with a different payload: an atomic rejection.
- Order 41,43,42: the edge to 43 is corrected.
- Changes pagination at a fixed T is unaffected by new inserts.
- Concurrent pause/resume, finish, and GPS: controlled transitions.
- Exact retries after the upload window are confirmed before the raw purge.
- A summary of a stale revision is not published.
- Purge resumes after a crash; incomplete history is not recomputed.
- A deleted run is not resurrected by a retry, a summary job, or a backup restore.

### Geometry

- Stationary GPS, a known distance, sharp turns, an outlier, a clock rollback.
- A measurement gap is distinguished from a transmission delay.
- Simplification does not change the stored distance_m.
- The antimeridian, Web Mercator's polar limit, adjacent tiles.
- An empty/degenerate track has an explicit quality state.

### Access

- Cross-tenant reads, writes, shares, and cache hits.
- Bypassing the API via SQL under the runtime role is still constrained by RLS.
- can_read_live does not expose finished history.
- Grant/membership revocation is verified across SSE, snapshots, changes, tiles.
- Someone else's counts/existence errors cannot be obtained via a geo query.

### Load

Ordinary dataset: 126k raw points, 3,650 summaries. Stress: 3M raw points, 10 concurrent offline batches of 100 points, 10 observers, pan/zoom bursts, and a concurrent summary job.

Initial targets:

- ingestion HTTP p95 ≤500 ms excluding client-side network;
- fresh GPS → screen p95 ≤5 s;
- summary publication → active map ≤60 s;
- a stable LRU footprint and SSE pending-buffer size;
- no ingestion starvation from tile jobs.

EXPLAIN (ANALYZE,BUFFERS) evaluates SQL; JSON/MVT bytes, serialization, and frontend frame time are measured separately. A small sequential scan is not by itself a bug. None of the targets are yet confirmed by tests.

Metrics: point commit latency, duplicates/conflicts, data age, live-cycle duration, SSE reconnects/backpressure, summary lag, tile bytes/time/hit ratio, pool wait, dead tuples, backup age, purge failures. Logs contain requestId and technical identifiers, no GPS, payload, or session tokens.

## 16. Implementation order

1. P02A foundation: Compose, migration owner/runtime/maintenance roles, trusted fixtures, organizations/memberships, the transaction helper, and baseline RLS.
   Done when identity/tenant integration tests pass under the runtime role.
2. P02B schema/ACL: runs, points, commands, summaries, shares, tombstones, composite FKs, and the full D02 matrix.
   Done when direct child-table reads and cross-tenant links cannot bypass run/share ACL.
3. Vertical scenario: create run → batch → retry → history → finish; IndexedDB and the simulator.
   Done when data survives a lost response and a reconnect.
4. Track processing: edge rules, summary, revisions, late points, purge.
   Done when geometric fixtures and concurrent recompute are verified.
5. Live: SSE state, snapshot/changes, reconnect, ACL revocation, React markers/track.
   Done when the recovery contract is respected and live p95 is measured.
6. Archive tiles: MVT, world boundaries, ACL, LRU, revision refresh.
   Done when adjacent tiles are correct and a stationary map updates.
7. Operations: limits, metrics, load, a restore drill, and launch documentation.
   Done when the measured limits are known and recovery is verified.

We do not start with microservices or Redis. The first demonstrable result is a single reliably recorded and recovered run; infrastructure is added per verifiable requirements.

## 17. What to clarify during implementation

- Actual GPS quality thresholds and distance error on real tracks.
- The behavior of the chosen browser/device; background tracking will need a separate client.
- Exact runtime/PostGIS/Mapbox SDK versions: pin lockfiles/images after a smoke test.
- The Mapbox and hosting provider and pricing; the budget is a design target for now.
- Rendering rules for very dense tiles, after measurement.
- The identity provider and a verified recovery process with a deletion log.

These items do not block implementing the vertical scenario, but must not be presented as already-verified properties of the system.
