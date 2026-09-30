# Running Tracker — step-by-step implementation plan for the coding agent

Version: 1.0
Date: September 29, 2026
Status: P00–P09 complete and verified locally: archive HTTP/RLS boundary, PostGIS MVT pipeline, bounded process cache, atomic invalidation, React/Mapbox source lifecycle, and bounded tile resource usage. P10 complete: bounded raw purge, retention eligibility/scheduling, owner deletion, annual retention with atomic tombstone/archive revision, the tombstone lifetime/late-retry contract with bounded reclamation, and the durable deletion journal with reapplication tool and runbook. P11.1 complete: in-process metrics with a separate scrape listener and allow-list structured logging. D01, D02, D04, D05, D06, and D08 are resolved; the stream portion of D07 is fixed in ADR-0023. The next exact increment is P11.2, the seeded ordinary and stress datasets. D03 is split: the local HTTP/session boundary is complete, production identity integration remains P12.
Basis: running-tracker-sdd-v1.0.md, sections 1–17.

## 1. Execution mode

The unit of work is a single Pxx stage, explicitly named in the assignment. By default, the first assignment covers P00–P01. Later stages may be combined at the user's request; do not attempt to implement the entire SDD in a single change.

Within an assigned stage, the agent independently performs the implementation, the necessary checks, and any fixes. Do not request approval for each file or for ordinary technical choices. Completing a stage is the natural boundary for a report and for learning, not a separate approval workflow.

Before starting:
1. Read the SDD, this plan, the repository instructions, and the current progress.
2. Check the working directory, git status, existing structure, and tooling.
3. Preserve the user's existing work; do not overwrite it for the sake of a template.
4. Select the first incomplete stage within the assigned range whose dependencies are satisfied.
5. Briefly explain the stage's goal, the concrete outcome, and the main checks.

After a stage, update docs/progress.md: tasks, outcome, commands run, actual results, constraints, decisions, and the next stage. Do not mark a failed test as passing; do not treat generated code as a verified implementation.

Public deployment, paid resources, creating a remote repository, and pushing changes to external services are not part of this plan by themselves.

## 2. Sources of truth and change management

- docs/SDD.md — product and architecture requirements.
- docs/implementation-plan.md — task order and acceptance criteria.
- docs/adr/ — significant decisions with rationale and consequences.
- Runtime schemas/API spec — the exact machine contract once implemented.
- Migrations — the actual data schema.
- docs/progress.md — evidence of completion.

When code and the SDD diverge, the agent does not adjust the documentation to match an incidental implementation. It first explains the discrepancy and chooses a fix.

Ordinary technical clarifications within the bounds of the requirements are decided by the agent on its own. Contradictions that change product meaning — for example, shortening history, dropping global geography, or changing coach permissions — require a user decision. While an answer is pending, continue with independent tasks.

Dependencies and supported versions are verified against official documentation at implementation time, then pinned via lockfile and image versions. Do not use `latest` tags as a reproducible configuration.

## 3. Target repository structure

For a new empty project — a single workspace, without additional orchestration frameworks:

~~~text
apps/
  api/                 Express 5: HTTP, ingestion, access, live, jobs, tiles
  web/                 React + TypeScript
packages/
  contracts/           Runtime schemas for requests/responses and public types
  fixtures/            Deterministic GPS scenarios
tools/
  simulator/           GPS transmission and network failure simulation
db/
  migrations/
  test-support/        Roles/fixtures for an isolated test database
infra/
  compose/
  proxy/
docs/
  SDD.md
  implementation-plan.md
  progress.md
  adr/
  runbooks/
~~~

If a repository already exists, adapt to its conventions.

Baseline choice: npm workspaces, React + Vite, Express 5, PostgreSQL/PostGIS, parameterized SQL via `pg`, and sequential SQL migrations. Express was chosen in ADR-0002 for explicit control over dependencies, configuration, and lifecycle; this is not a claim of a performance win. The migration runner choice is fixed in P01. Do not add an ORM purely for CRUD if the critical queries require SQL/PostGIS anyway.

packages/contracts does not depend on Express or the DB driver. apps/web does not import server models, secrets, or infrastructure code.

Geodetic calculations are performed by PostGIS. The client uses the server-computed connectFromPrevious; there is no separate independent GPS-filtering algorithm on the frontend.

## 4. Stage map

| Stage | Outcome | Dependency |
|---|---|---|
| P00 | Verified inputs and a local decision backlog | — |
| P01 | Reproducible skeleton, API/web, PostgreSQL/PostGIS | P00 |
| P02A | Roles, identity/organization schema, tenant helper, and baseline RLS | P01 |
| P02B | Run/point/share schema, constraints, and the full ACL/RLS matrix | P02A |
| P03 | Run creation, commands, HTTP/session contracts | P02B |
| P04 | Reliable ingestion, raw history, and a GPS simulator | P03 |
| P05 | Browser recording with a local buffer | P04 |
| P06 | Geo-processing and consistent summary publication | P04 |
| P07 | Snapshot/changes with resilient pagination | P06 |
| P08 | SSE and a working coach screen | P05, P07 |
| P09 | MVT, cache, archive layer, and invalidation | P06, P08 |
| P10 | Retention, deletion, tombstones, and recovery jobs | P09 |
| P11 | Measurements, load limits, and operational metrics | P08–P10 |
| P12 | Production auth, recovery, and deployment readiness | P11 |

Default working order: P00 → P01 → P02A → P02B → P03 → … → P12. The possibility of independent branches is not an instruction to launch additional agents.

Milestones:
- P04: the backend can reliably store and read a single run.
- P05: the user records a run in the browser.
- P08: the coach sees and can recover a live track.
- P09: a finished run appears in its own tiles.
- P12: a verified deployment configuration is ready; public publication is a separate action.

## 5. Detailed stages

### P00 — Verifying initial conditions

SDD reference: 1–5, 17.

Tasks:
- P00.1 Verify the selected repository and environment: Node, package manager, Docker, PostGIS image availability, occupied ports. Do not install system components unless necessary.
- P00.2 Move the SDD and the plan into docs/, preserving their original meaning; create progress with tasks P00–P12.
- P00.3 Record concrete tool versions and a short ADR on the workspace, SQL access, and testing approach.
- P00.4 Create a list of required implementation clarifications from section 6 of this plan, with owning stages.

Done when:
- a correct project root has been chosen;
- environment constraints are recorded separately from architectural constraints;
- install and run commands have defined prerequisites;
- product code does not yet paper over unresolved requirements.

### P01 — Working skeleton and environment

SDD reference: 3, 13.

Tasks:
- P01.1 Set up the workspace, TypeScript strict mode, Express 5 API and web, lockfile, lint/typecheck/build; fix integration config isolation, checksum portability, and bounded DB/shutdown deadlines.
- P01.2 Bring up PostgreSQL with PostGIS and a persistent volume; prepare a migration runner and a separate test database.
- P01.3 Implement health/liveness and readiness with a DB check, graceful shutdown, validated env config, and a .env.example without secrets.
- P01.4 Configure same-origin /api access for the frontend in development; minimal connection and status pages.
- P01.5 Add CI checks or portable CI commands: build, typecheck, lint, integration tests against real PostGIS.

Checks:
- runs from a clean checkout per the README;
- `SELECT PostGIS_Full_Version()` succeeds;
- loss of the DB flips readiness but does not masquerade as an HTTP process crash;
- a hung health query completes within its deadline and does not hold a pool slot;
- the same SQL has the same checksum after an LF vs. Windows checkout, while a substantive change is rejected;
- web and API are reachable at documented addresses.

Boundaries: no auth provider, no business-table RLS, no map, no Redis, no streaming.

### P02A — Identity/organization schema and baseline tenant isolation

SDD reference: 5, 8.

Tasks:
- P02A.1 Create users, organizations with archive_revision, and memberships with role/active, along with PK/FK/UNIQUE/CHECK constraints and indexes.
- P02A.2 Separate privileged bootstrap, migration/object owner, runtime, and maintenance credentials; grant privileges explicitly.
- P02A.3 Implement a single-client transaction helper with a transaction-local tenant/user context, explicit rollback/commit semantics, and safe release.
- P02A.4 Fix the minimal matrix of identity/organization reads and implement fail-closed, non-recursive RLS.
- P02A.5 Prepare separate owner fixtures for two organizations, multi-membership, and inactive/no-membership cases.

Checks:
- real SQL queries run under the runtime role, not the owner;
- allowed SELECT and denied SELECT/INSERT/UPDATE/DELETE per the P02A matrix;
- connection reuse from the pool does not carry over the previous request's context;
- concurrent tenant transactions do not mix context;
- the runtime role does not own tables, has no superuser/BYPASSRLS, and performs no DDL;
- privileged maintenance access is unreachable from ordinary HTTP code.

Done when an executable P02A access matrix exists under the real runtime role. Repository mocks are not proof of RLS.

### P02B — Run schema and the full ACL/RLS matrix

SDD reference: 5, 8.

Tasks:
- P02B.1 Create runs, run_points, run_commands, run_summaries, run_shares, run_tombstones, and the SDD's indexes.
- P02B.2 Add CHECK/UNIQUE/FK constraints, states, revisions, units, and range limits. SQL fields used for payload comparison must not silently lose precision.
- P02B.3 Complete D02: non-recursive runs/shares policies and child-table ACLs that cannot be bypassed by direct reads.
- P02B.4 Verify cross-tenant composite FKs, owner/grantee access, and denied mutations under the runtime role.

Done when the executable matrix covers run/share/child tables, and direct reads of points/summaries cannot bypass the ACL.

Status as of 2026-09-23: P02B.1–P02B.4 and D02 are verified against a real database; D01 canonical `PointInput`/retry comparison was resolved in P04.1. This removes the remaining reason to keep P02B open, so P02B is considered DONE.

### P03 — Session boundary, commands, and the API foundation

SDD reference: 6.1, 8, 11.

Tasks:
- P03.1 Implement the session boundary, CSRF/Origin checks, requestId, and a unified ApiError. The local identity fixture is allowed only in development/test; production startup with it is forbidden. **Completed and verified 2026-09-21; ADR-0007.**
- P03.2 Create runtime contracts, OpenAPI for ordinary HTTP, and an SSE description; bigint/seq are serialized as strings. **Completed and verified 2026-09-22; D01 canonicalization deliberately deferred to P04.**
- P03.3 Implement PUT run and POST commands: idempotency, expectedControlRevision, terminal finish, one active run per user. **Completed and verified 2026-09-22 against real PostgreSQL: row lock, concurrent create/commands/replay, and rollback atomicity.**
- P03.4 Implement GET run/list, share management, and an active-membership check. **Completed and verified 2026-09-22 against real PostgreSQL: owner/shared ACL, keyset pagination, owner-only share upsert/revoke, and the active-membership boundary.**
- P03.5 Implement auto-finish via an injectable clock and a repeatable maintenance job. **Completed and verified 2026-09-23: a narrow SECURITY DEFINER capability, an injected UTC clock, a non-overlapping scheduler, bounded shutdown, and concurrent real-PostgreSQL checks.**

Checks:
- retrying create and a command returns a consistent result;
- the same commandId with a different payload is rejected;
- a command retry is checked before expectedControlRevision;
- concurrent pause/resume/finish do not break the state machine;
- a GPS-driven data_revision change does not create a control_revision conflict;
- mutating requests without valid CSRF/Origin protection are rejected.

Boundaries: external identity integration remains P12; the API already has a full session boundary.

### P04 — Ingestion, history, and the simulator

SDD reference: 6.2–6.3, 8, 11.2–11.3.

Tasks:
- P04.1 Implement bounded atomic batches, canonical payload comparison, FOR UPDATE, and ACK after commit. **Completed and verified 2026-09-23, including `ingested_revision` only for new points and no revision bump on retries.**
- P04.2 The previously separate revision invariant is absorbed into P04.1, since it is part of the atomic ingestion contract; no separate implementation remains.
- P04.3 Add raw history with a limit, cursor, revision-mismatch handling, and access checks. **Completed and verified 2026-09-25: a single statement snapshot, keyset pagination by `seq`, a cursor bound to `data_revision`, history ACL, and retention/error ordering.**
- P04.4 Build a simulator with a seed/virtual clock: normal, duplicates, reordered, delayed batch, dropped response, clock jump, GPS spike. **Completed and verified 2026-09-26: reusable fixtures, a deterministic FIFO virtual clock, a JSONL CLI, and all seven scenarios; server-side fault hook deferred to P04.5.**
- P04.5 Add safe fault injection in the test environment for the case where the commit succeeded but the response was lost. **Completed and verified 2026-09-26: the injected dependency is available only under `APP_ENV=test`, the disconnect happens after a confirmed COMMIT, and retry/history/finish are proven by HTTP and SQL.**

Checks:
- two concurrent identical batches produce exactly one set of rows;
- one conflicting point rejects the whole batch;
- the order 41 → 43 → 42 reads back correctly;
- old retries after the upload window are confirmed, new points are rejected;
- raw_state=purging/purged yields an explicit error;
- body/batch/run maximums are checked before unbounded resource consumption;
- the API preserves exact source values within the accepted canonicalization.

Demonstration: create a run → send points → lose the ACK → retry → read history → finish. The result is confirmed via SQL and HTTP, without a map UI.

### P05 — Browser recording and local buffer

SDD reference: 2, 6, 11.

Tasks:
- P05.1 Implement the runner screen: start/pause/resume/finish, recording/upload/offline/error states. **Completed and verified 2026-09-26: same-origin session discovery, shared-contract validation, revision-aware API controls, exact-request retry, and a responsive state dashboard.**
- P05.2 Store seq and the point in a single IndexedDB transaction; also store commands until confirmed. **Completed and verified 2026-09-26: user/run-scoped bigint seq allocation, a canonical point buffer, explicit batch-ACK deletion, a durable exact-request queue, and reload recovery.**
- P05.3 Upload worker: bounded batches, backoff/jitter, deletion of only the confirmed batch, stopping on a permanent error. **Completed and verified 2026-09-26: sequential batches ≤100, exact ACK verification/deletion, capped full jitter and Retry-After, offline/reconnect handling, permanent stop, and authoritative reconciliation.**
- P05.4 A single recording owner across tabs; fix the lease/lock mechanism and detection of a conflicting writer. **Completed and verified 2026-09-26: a user-scoped IndexedDB lease, a per-tab UUID, a fencing token, bounded expiry/renewal, stale-owner rejection, and an explicit read-only conflict UX.**
- P05.5 Connect Geolocation and the simulator through the same source interface. Add Mapbox when a token is available, while preserving the ability to test recording without an external map. **Completed and verified 2026-09-26: a shared source/controller, a bounded callback queue, durable segment allocation, transactional lease fencing, stale-callback rejection, a seeded simulator, and a tokenless recording UI; Mapbox was not activated because there is no tracked token contract and no token was provided.**

Checks:
- reload and a temporary offline period do not reset seq/buffer;
- a duplicate ACK does not delete points that are not yet confirmed;
- an offline finish and a server auto-finish are handled via reconciliation;
- a stale GPS callback is not presented as a new measurement;
- a second tab does not start an independent recording of the same run;
- a browser test verifies recovery after a network disconnect.

Boundaries: foreground recording. Do not present a PWA as a solution for background GPS.

### P06 — Geometry and archive summaries

SDD reference: 7.

Tasks:
- P06.1 Implement a single versioned edge check, used by both summary and live-track. **Completed and verified 2026-09-26: a `v1` PostGIS evaluator, stable rejection precedence, geodesic distance, and least-privilege EXECUTE for runtime/maintenance; ADR-0012.**
- P06.2 Compute distance/observed_duration in PostGIS, quality counters, segments, and insufficient_data. **Completed and verified 2026-09-26: revision-bound maintenance calculation, exact `QualityStats`, accepted chains without bridging, and ADR-0013.**
- P06.3 Perform metric simplification and normalization of global geometry. Edge cases are implemented, not replaced by a regional assumption. **Completed and verified 2026-09-26: cumulative-geodesic parts ≤20 km, a local azimuthal-equidistant projection, Douglas–Peucker at 5 m, endpoint preservation, and antimeridian split/normalization; ADR-0014.**
- P06.4 Add a job that finds stale summaries, snapshots, compares revisions, and atomically publishes with archive_revision. **Completed and verified 2026-09-26: one candidate per cycle, a materialized calculation snapshot without a run lock, organization → run publication locks, revision/state/tombstone comparison, atomic summary upsert + archive revision increment, and ADR-0015.**
- P06.5 Bound job concurrency; respect the organization → run lock order. **Completed and verified 2026-09-27: transaction-scoped advisory claims across processes, a configurable 1–8 worker batch, all-settled cycles, maintenance pool headroom, and ADR-0016.**

Checks:
- simple geometric references with an independently defined expected result;
- stationary GPS noise, a sharp turn, an outlier, a seq gap, a negative dt, a pause;
- late delivery does not break continuous measurements;
- antimeridian, high latitude, a single point, an empty line;
- simplification does not change the stored distance;
- a new point arriving during the job excludes publication of a stale summary;
- a deleted run is not resurrected by the background job.

Done when fixtures show not only successful calculation but also explainable reasons for excluding data.

### P07 — Versioned snapshot and changes

SDD reference: 9.2, 11.1–11.3.

Tasks:
- P07.1 Implement an initial snapshot at a fixed R, paginated by seq. **Completed and verified 2026-09-27: a single statement fixes R and a bounded keyset page, the cursor stores R/algorithmVersion/last seq, late ingestion does not change the continuation, ACL/raw-state are rechecked on every page; ADR-0017.**
- P07.2 Implement changes(A,T): new points plus their immediate successors at T. **Completed and verified 2026-09-27: the first statement fixes T, a materialized `(A,T]` set is unioned with immediate successors at T, the set is deduplicated and keyset-paginated by bigint seq; ACL/raw-state are rechecked on every page; ADR-0018.**
- P07.3 Compute predecessorSeq/connectFromPrevious over the same set with ingested_revision ≤ T. **Completed and verified 2026-09-27: the full point set is materialized at T, the predecessor is computed before the page filter, and a shared PostGIS evaluator produces server-authoritative connectivity for both snapshot and changes; ADR-0019.**
- P07.4 Sign cursors with user/org/run, operation kind, A/T, algorithmVersion, the last key, and expiry. **Completed and verified 2026-09-27: a versioned HMAC-SHA-256 envelope, identity/route/operation binding, a single ten-minute deadline across the page chain, and a production key guard; ADR-0020.**
- P07.5 Implement client-side upsert application, advancing the revision only after all pages. **Completed and verified 2026-09-27: a user/org/run-scoped `LiveTrackStore`, staged seq-keyed application, atomic terminal-page commit, single-flight target coalescing, and a snapshot fallback for invalid cursors/algorithm changes; ADR-0021.**

Checks:
- a late insert at 42 fixes the connection to 43;
- inserting several sequential/scattered points correctly updates successors;
- new points arrive between pages: the result for the old T is unchanged;
- retrying and restarting pages creates no duplicates;
- a change in algorithmVersion/expiry, or loss of local state, triggers a snapshot;
- revoke/finish/purge between pages stops delivery per current permissions;
- the server does not hold a DB transaction between HTTP requests.

Equivalence check: an initial snapshot at A plus all changes up to T yields the same set of points and edges as a fresh snapshot at T.

### P08 — SSE and the coach screen

SDD reference: 9, 11.4.

Tasks:
- P08.1 Implement one SSE connection per organization/tab, initial state, a shared 2 s cycle, heartbeat, and a bounded queue. **Completed and verified 2026-09-27: process-level grouped polling, short runtime-role snapshots, per-stream ordering, heartbeat, connection/poll bounds, and latest-only backpressure with a timeout; ADR-0022.**
- P08.2 Recheck session/membership/grants on the live connection, dropping runs that are no longer accessible. **Completed and verified 2026-09-27: per-connection session digest/expiry validation, an exact expiry timer, membership-denial disconnect, grant-filtered full-state replacement, and cancellation of pending state; ADR-0023.**
- P08.3 Coach screen: available runs, confirmed/unconfirmed/stale markers, selected tracks. **Completed and verified 2026-09-27: a strict SSE client, a full-state coach reducer, server-relative 10-second freshness, fail-closed last-known cleanup, explicit authorized track selection, and a responsive tokenless UI; ADR-0024.**
- P08.4 Revision-based synchronization: one load per run, coalescing notifications, recovery after reconnect. **Completed and verified 2026-09-27: a selected-run coordinator on top of the atomic `LiveTrackStore`, greatest-revision coalescing, abort/eviction on removal/revoke/disconnect, algorithm-version snapshot replacement, and bounded same-session reconnect recovery; ADR-0025.**
- P08.5 Configure proxy buffering/timeouts and browser-to-proxy HTTP/2 for a verifiable deployment profile. **Completed and verified 2026-09-28: a pinned Nginx HTTPS/HTTP/2 edge, an internal HTTP/1.1 Express upstream, an SSE-specific no-buffer/no-cache/no-compression/no-retry policy, reproducible local TLS, and an actual ALPN/restart/DB-activity/latency harness; ADR-0026.**

Checks:
- a DB commit without an SSE notification is still discovered by the next cycle;
- a backend restart leads to snapshot/changes, without losing stored points;
- a slow reader does not cause unbounded memory growth;
- an open stream does not hold a DB connection;
- can_read_live does not expose finished history;
- GPS loss marks the position stale even while the connection is up;
- a revoke clears both current and last-known data.

Measure a preliminary end-to-end p95; the final result is P11.

### P09 — MVT, cache, and the archive map

SDD reference: 10, 11.5.

Tasks:
- P09.1 Implement metadata, the tile endpoint, XYZ range checks, period validation, and history ACL. **Completed and verified 2026-09-28: revision-bound metadata/template, strict zoom 8–16 and XYZ/366-day validation, active-membership/revision checks, a runtime-role RLS pipeline boundary, and a fail-closed handoff to P09.2; ADR-0027.**
- P09.2 PostGIS pipeline: indexed selection, projection, buffering, clipping, MVT; run_id remains a string. **Completed and verified 2026-09-28: GiST-compatible WGS84 candidate branches, Web Mercator world clipping/projection, extent 4096 + buffer 64 MVT, shifted antimeridian copies, decoded adjacent/polar/empty tiles, and runtime-role history RLS; ADR-0028.**
- P09.3 Add a byte-bounded LRU, TTL, single-flight, and all the SDD's key components. **Completed and verified 2026-09-28: a process-local 32 MiB/4096-entry LRU, a monotonic five-minute TTL, canonical full identity, empty-tile caching, failure/oversize exclusion, and per-key single-flight; ADR-0029.**
- P09.4 Check membership/revision before a cache hit; publish/delete/grant changes bump the epoch atomically. **Completed and verified 2026-09-28: a shared organization epoch lock before cache lookup, repeated membership/revision validation, atomic summary-delete/history-grant/membership triggers, an organization-first share-mutation lock order, and rollback/concurrent cache-hit proof; ADR-0030.**
- P09.5 React archive source, metadata polling every 30 s, refresh on focus, error handling, and cleanup after revoke. **Completed and verified 2026-09-28: a pinned Mapbox adapter, a bounded metadata controller, focus/409 refresh, `setTiles` revision replacement, transient-error retention, and 401/403 sensitive-layer cleanup; ADR-0031.**
- P09.6 Bound SQL/concurrency/queue/tile bytes; never return the first N features as a complete tile. **Completed and verified 2026-09-28: two-phase admission with no DB client held during the queue wait, per-key single-flight, 2 active + 16 waiting, a PostgreSQL-local 2-second timeout, an inclusive 1 MiB raw-buffer bound, and explicit `TILE_BUSY`/`TILE_TIMEOUT`/`TILE_TOO_COMPLEX`; ADR-0032.**

Checks:
- decode the MVT and verify the source layer/properties/geometry;
- adjacent tiles, crossing ±180°, polar clipping, an empty tile;
- one user does not receive another's tile on a warm cache;
- concurrent requests for the same key trigger a single generation;
- a revision mismatch causes a metadata refresh;
- a stationary map receives a new summary within the target time;
- a feature count over the limit is not hidden by silent truncation.

The cache is an optimization. Clearing or losing it does not change the correctness of the result.

### P10 — Retention, deletion, and maintenance

SDD reference: 6.1, 12.

Tasks:
- P10.1 Implement available → purging → purged, bounded deletes, and safe restart. **Completed and verified 2026-09-29: a maintenance-only one-run primitive, 1,000-row `seq` batches, durable restart state, rollback/idempotency, shared summary advisory-lock serialization, and runtime `raw_state` mutation revoked; ADR-0033.**
- P10.2 Allow purge only when the summary is current and the upload window is closed. **Completed and verified 2026-09-29: seven-day/upload-window/current-summary revalidation inside the locked purge capability, a bounded transactional claim, restart-first periodic scheduling, and an identity-free overdue warning; ADR-0034.**
- P10.3 Implement owner deletion and annual retention with tombstone and archive revision. **Completed and verified 2026-09-29: a shared SQL primitive `execute_run_deletion`, separate runtime/maintenance `SECURITY DEFINER` capabilities, a shared per-run advisory lock → organization → run lock order, an atomic tombstone + cascade delete + exactly one archive_revision increment regardless of whether a summary exists, an idempotent/concurrency-safe owner DELETE, and an annual maintenance retention worker; ADR-0035.**
- P10.4 Fix the tombstone's lifetime and the late-retry contract; resolve the SDD's ambiguity via an ADR. **Completed and verified 2026-09-29: one-year guaranteed window with the tombstone row authoritative until reclaimed, a maintenance-only bounded `SKIP LOCKED` reclaim (`0017_tombstone_expiry.sql`, `RUN_TOMBSTONE_RECLAIM_INTERVAL_MS`), reuse only after reclamation, marker takeover so a later deletion never fails on an existing marker; D08 resolved; ADR-0036.**
- P10.5 Prepare a deletion export/log and a recovery runbook; end-to-end restore is P12. **Completed and verified 2026-09-29: an identifier-only `run_deletion_journal` written in the deletion transaction (`0018_deletion_journal.sql`), an at-least-once maintenance export to `DELETION_JOURNAL_DIR` that removes rows only after the file is durable, an owner-only idempotent `restore:reapply-deletions` command that never touches a run created after the deletion, and `docs/runbooks/deletion-journal-and-recovery.md`; D09's mechanism is done, its restore drill and access recovery remain P12.3/P12.4; ADR-0037.**

Checks:
- an injectable clock replaces waiting seven days;
- a crash after several deletion batches does not leave a partial summary;
- DELETE competes safely with ingestion/summary/tiles;
- a repeated DELETE is idempotent, and a retried create does not bring back a deleted run within the guaranteed window;
- raw replay is unavailable after purge, the archive summary remains;
- a summary failure produces an observable retention overrun, not a silent loss of history.

### P11 — Load testing and operational limits

SDD reference: 13–15.

Tasks:
- P11.1 Add metrics/structured logs without coordinates and secrets. **Completed and verified 2026-09-29: an in-process registry (counters/gauges/histograms, bounded label cardinality) behind an optional loopback `METRICS_PORT` listener, allow-list JSON logging with error class/code only, and instrumentation of HTTP, ingestion commit latency, live SSE, archive tiles, pool checkout wait, maintenance cycles, and process memory; data age, summary lag, dead tuples, and backup age remain for P11.4/P12.3; ADR-0038.**
- P11.2 Generate the SDD's ordinary and stress datasets with a seed and a reproducible ACL/geography distribution. **Completed and verified 2026-09-29: `npm run load:seed` writes one deterministic organization (10 members, 3,650 finished runs and summaries, and 126,000 or 3,000,000 raw points in the seven most recent days) into a dedicated `*_load_test` database as the object owner in one transaction, with eight geography anchors including an antimeridian route, a coach/runner ACL distribution, and a reproducibility digest; ADR-0039.**
- P11.3 Test ingestion + viewers + pan/zoom + jobs concurrently, including batches after offline periods.
- P11.4 Collect EXPLAIN ANALYZE BUFFERS, real table/index sizes, response bytes, and memory.
- P11.5 Apply only confirmed optimizations; keep a before/after report.

The report must contain:
- the application commit, DB/image versions, CPU/RAM/disk;
- duration, concurrency, warm/cold cache, and data distribution;
- p50/p95/p99, errors, timeouts, pool wait, queue depth;
- actual GPS→browser latency;
- goals met and not met, listed separately.

Done when the limits are known from measurements. A nice-looking graph without a methodology does not confirm an SLO.

### P12 — Production auth and recovery

SDD reference: 12–13, 17.

Tasks:
- P12.1 Connect the chosen identity provider via a standard protocol, with real sessions and logout/expiry; production contains no dev login.
- P12.2 Prepare TLS/proxy/config/secrets, resource limits, and a deployment runbook for a single region.
- P12.3 Perform backup/restore in an isolated environment, verify RPO/RTO, and apply subsequent deletions.
- P12.4 Verify recovery of current permissions; an old backup must not silently restore revoked grants.
- P12.5 Update the README, SDD, API spec, and progress to match the actual implementation; prepare the final demo.

If credentials/a provider/a target environment are unavailable: complete the independent configuration and tests, and explicitly flag the specific external blocker. Do not create an account or a paid resource on a guess. A local substitute does not count as completing production auth/restore.

The stage's outcome is verified deployment readiness. Publication happens only as a separate assignment.

## 6. Required clarifications the agent must close

| ID | Question | Owner | Expected outcome |
|---|---|---|---|
| D01 | Exact canonicalization of PointInput for retries: numbers, -0, timestamps, seq | P02B/P04 | RESOLVED in P04.1: strict shape, bigint decimal seq, `-0` → `0`, UTC nearest-ms timestamp, canonical retry equality |
| D02 | RLS for runs/shares without recursion or child-table ACL bypass | P02A/P02B | P02A identity baseline + P02B run/share matrix and runtime-role tests |
| D03a | Session endpoint, local identity, CSRF/Origin, and a production guard | P03 | Explicit HTTP/session contract and a fail-fast local-auth guard — RESOLVED in ADR-0007 |
| D03b | Production identity/session provider integration | P12 | Standard provider/protocol without a local/anonymous fallback; TODO |
| D04 | Single recording tab/device, reload, and writer conflict | P05 | A concrete lease/ownership mechanism; not relying on the UI alone |
| D05 | Offline command queue after a server auto-finish | P05 | Terminal reconciliation, preserving remaining GPS within the allowed window |
| D06 | Initial pagination and changes with a fixed T | P07 | RESOLVED: fixed-revision chains, successor repair, atomic client application, and equivalence coverage; ADR-0017–0021 |
| D07 | Membership revoke racing an active stream/cache | P08/P09 | A clear check point, cancellation of not-yet-sent data; no promise to revoke delivered data |
| D08 | Replay of creation after tombstone expiry | P10 | A time-bounded guarantee or another mechanism; an indefinite promise on TTL is not allowed | RESOLVED in P10.4 (ADR-0036)
| D09 | Deletion log/ACL surviving node loss | P10/P12 | An explained order, RPO, and a restore drill; a plain table in a lost DB is insufficient. PARTIAL — P10.5 + ADR-0037: off-host deletion journal, export order, reapplication tool, and runbook; the restore drill and ACL recovery remain P12.3/P12.4 |
| D10 | Real-world GPS tolerances and worldwide simplification | P06/P11 | Fixtures + results, explicit accuracy limits |

Do not let these clarifications become an unnoticed scope expansion. For example, D09 might need a separate small reliable-export mechanism; that is not grounds to introduce Kafka for the whole system.

## 7. Verification strategy

- Unit: pure rules, canonicalization, cursors, the client reducer, and upload states. Do not duplicate an implementation with a test that repeats the same algorithm.
- Integration: real PostgreSQL/PostGIS and the runtime role; transactions, constraints, RLS, revisions, geo-operations.
- Contract: runtime schemas, error codes, bigint serialization, and OpenAPI conformance.
- Browser: recording, IndexedDB reload/offline, observer reconnect, grant revoke, archive refresh.
- Load/failure: separate from fast CI; reproducible seeds and a report.

Synchronize concurrency tests with barriers/hooks, not random sleeps. Inject time via a clock abstraction. Test the external map integration separately; core ingestion and ACL do not depend on a Mapbox token.

After changes, run the relevant checks, then the general typecheck/build. Rerun the full expensive load suite only after changes that could affect its conclusions.

## 8. General Definition of Done

A stage is complete if:
1. The assigned scope is done and dependencies are respected.
2. The stage's significant happy/failure/security paths are verified.
3. The code runs per the documentation; migrations are reproducible.
4. Contracts and documentation match the implementation.
5. There are no secrets, no GPS payload in logs, and no unbounded queues.
6. Constraints and unverified claims are explicitly noted.
7. Progress contains evidence and the next stage.

If a check could not be run due to the environment, the stage's status is partially done/blocked, not done. Do not fabricate success output.

## 9. Agent report format

~~~text
Stage: Pxx
Outcome: concrete observable behavior.
Changes: key files/modules.
Verification: commands run and their results.
Decisions: ADRs/SDD changes with rationale.
Constraints: what is not implemented or not verified.
Demonstration: how to reproduce the result.
Next stage: Pyy and its prerequisites.
~~~

Technical explanation for the user: brief, at a senior frontend/fullstack level. Explain new backend/DB trade-offs using concrete code, rather than repeating basic JavaScript concepts.

## 10. Current status

P00–P02A.1 and the full DB schema/ACL sub-part of P02B (`runs`, `run_shares`, `run_points`, `run_summaries`, `run_commands`, `run_tombstones`) are verified locally by reproducible unit/build and real PostgreSQL/PostGIS integration commands. D02 is resolved within the bounds of the trusted tenant context. Authoritative commands and evidence live in `README.md` and `progress.md`.

P02B is DONE after resolving D01 in P04.1. P03.1–P03.5 are complete: the session boundary, shared strict runtime contracts, the OpenAPI 3.1 ordinary-HTTP artifact, a separate SSE protocol contract, atomic `PUT run`/`POST commands`, ACL-aware run list/read, owner-only share management, and clock-driven maintenance auto-finish. P04.1 bounded atomic point ingestion, P04.3 revision-bound raw history, P04.4 deterministic GPS simulator, and P04.5 safe test-only response-loss injection are complete; P04 is DONE. P05.1–P05.5 are complete: runner control UI/state, durable IndexedDB persistence, bounded point upload/reconciliation, fenced single-writer ownership, and a shared Geolocation/simulator foreground capture path; P05 is DONE. P06.1–P06.5 are complete: versioned PostGIS edge validation, revision-bound calculation, global metric display simplification, atomic publication, and bounded distributed job claiming; P06 is DONE. P07.1–P07.5 are complete: revision-fixed snapshot/change reads, revision-bound edge annotations, signed identity-bound cursors, and atomic browser application; P07 is DONE. P08.1–P08.5 are complete: authorization-safe SSE, coach/selected-track recovery, and a verified external HTTPS/HTTP/2 proxy profile; P08 is DONE. P09.1–P09.6 are complete: a revisioned archive HTTP/RLS boundary, the PostGIS MVT pipeline, a bounded process cache, an atomic cache-hit invalidation boundary, the React/Mapbox source lifecycle, and bounded resource admission; P09 is DONE. P10.1–P10.3 are complete: a maintenance-only bounded raw purge, summary serialization, authoritative retention eligibility, restart-first periodic scheduling, an owner-executed `DELETE`, and annual retention deletion with an atomic tombstone/archive revision; P10 is IN PROGRESS. The next exact increment is P10.4, tombstone lifetime and late retry contract. The production identity/session provider remains P12.
