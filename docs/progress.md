# Implementation progress

Last updated: 2026-10-02.

| Stage | Status | Result |
|---|---|---|
| P00 | DONE | Repository root, source documents, environment, ADR, and decision backlog established |
| P01 | DONE | Reproducible Express 5/API/web workspace, persistent PostgreSQL/PostGIS, migrations, health, and CI commands verified after P01.1 review fixes |
| P02A | DONE | DB roles, identity/organization schema, tenant transaction helper, and baseline RLS verified under runtime-role |
| P02A.1 review fixes | VERIFIED | Integration fixture target guard and confirmed-COMMIT handling passed unit and real-role integration checks |
| P02B | DONE | All six run child/access tables, D02 ACL matrix, and D01 canonical `PointInput`/retry semantics passed real PostgreSQL/PostGIS role integration |
| P03 | DONE | P03.1–P03.5 session/security, contracts, run lifecycle/read/share APIs, and clock-driven auto-finish verified |
| P04 | DONE | Bounded atomic ingestion, revision-bound raw history, deterministic GPS simulation, and test-safe post-commit response-loss verification passed |
| P05 | DONE | Runner controls, durable IndexedDB buffer, upload/reconciliation, fenced writer ownership, and Geolocation/simulator foreground capture verified |
| P06 | DONE | Edge evaluation, revision-bound calculation, global simplification, atomic publication, and bounded distributed workers verified |
| P07 | DONE | Fixed snapshots, successor changes, edge annotations, signed identity-bound cursors, and atomic browser application verified |
| P08 | DONE | Authorization-safe SSE, coach UI, selected-track recovery, and the HTTPS/HTTP/2 reverse-proxy profile verified |
| P09 | DONE | Archive HTTP/RLS, PostGIS MVT, bounded cache/invalidation, React source lifecycle, and bounded tile resource usage verified |
| P10 | DONE | Bounded raw purge, eligibility, summary serialization, restart-first scheduling, owner/annual deletion with atomic tombstone/archive revision, the tombstone lifetime/late-retry contract with bounded reclamation (D08), and the durable off-host deletion journal with owner-only idempotent reapplication and recovery runbook (P10.5) verified. D09 was PARTIAL here; it is RESOLVED for the mechanism and the local drill after P12.3 and P12.4 |
| P11 | DONE | P11.1 (in-process metrics with a separate scrape listener and allow-list structured logs, ADR-0038), P11.2 (deterministic ordinary/stress datasets, ADR-0039), P11.3 (deterministic concurrent load scenario over the real HTTP/SSE/PostgreSQL/tile/summary boundaries, ADR-0040), P11.4 (EXPLAIN/BUFFERS/WAL evidence under the real roles, sizes, response bytes, lock-wait samples, a no-tile baseline, and a generated report, ADR-0041), and P11.5 (set-based run visibility policies with a narrowing live scope, migration 0019, ADR-0042, and a before/after report from the same commands) verified. Ingestion p95, fresh-latency p95, and no tile starvation are met under stated rules; summary visibility, LRU footprint, and SSE buffer are not confirmed |
| P12 | DONE (workstation only) | P12.2 (single-host deployment profile) and P12.3 (encrypted backups, retention, and an executed local restore drill with deletion reapplication) are done. P12.1 (OpenID Connect sign-in with invite-only identities and the existing session, ADR-0046, verified against a test provider only) is done; P12.4 (an access-restriction journal and a drill that proves recovered permissions equal the lost source's) is done and D09 is RESOLVED for the mechanism and the local drill. P12.5 (documentation matched to the implementation, the two sign-in routes in the OpenAPI document, three specified-but-never-built reads flagged and enforced by a route-coverage test, and a scripted local demo) is done. Nothing in P12 was verified against a real identity provider, host, browser or production backup schedule |

## P00 — verified inputs

Tasks completed:

- confirmed `C:\ForMe\Learning\Running_Tracker` as a new project root and initialized local Git on `main`;
- preserved the supplied SDD, implementation plan, and kickoff under `docs/`;
- recorded tool versions, occupied ports, Docker state, and image digest in `environment.md`;
- accepted ADR-0001 for workspace structure, direct SQL, migrations, and real PostGIS tests;
- copied D01–D10 with stage owners into `decision-backlog.md`.

Observed constraints:

- local port 5432 was already occupied, so project PostGIS uses 5433;
- Docker daemon was initially unavailable but became available after starting the installed Docker Desktop;
- no remote repository was created and nothing was published externally.

## P01/P01.1 — working scaffold and review corrections

Implemented:

- npm workspaces, strict TypeScript, exact dependency versions, and lockfile generation path;
- React/Vite status page and development proxy for same-origin `/api`;
- Express 5 API with import-safe `createApp({ config, pool, clock })`, explicit dependencies, validated configuration, and centralized error handling;
- separate connection and readiness-query deadlines plus bounded HTTP/pool shutdown with a forced fallback;
- pinned PostgreSQL 17/PostGIS 3.5 Compose service with persistent named volume and isolated test database;
- checksum/advisory-lock SQL migration runner, LF-canonical SQL hashing, and initial PostGIS extension migration;
- whole-history migration preflight under the advisory lock; missing/changed/out-of-order files and backfilled names fail before pending files execute;
- monotonic shutdown budgeting separated from UTC business-event time, with controlled-clock timeout tests;
- unit and real-PostGIS integration suites plus portable CI workflow.

Verification evidence:

- `npm ci` — clean lockfile installation succeeded; 285 packages installed, 289 audited, 0 vulnerabilities;
- `npm run verify` — lint and strict typecheck passed for API/web/contracts; migration, API, web tests passed; all production builds passed;
- `npm run db:up` — pinned container reached healthy state on `127.0.0.1:5433`;
- two consecutive `npm run db:migrate` and `npm run db:migrate:test` cycles — the checksum already stored by P01 remained compatible and every run reported `skip`;
- `npm run test:integration` — 3 tests passed against real `running_tracker_test`, including repeated `pg_sleep(10)` query deadlines with no retained pool clients;
- direct SQL — PostgreSQL `17.5`, PostGIS `3.5.2`; `PostGIS_Full_Version()` succeeded;
- smoke — web document returned 200; direct liveness/readiness returned 200; Vite-proxied `/api/health/ready` returned 200;
- database failure path — after stopping PostgreSQL, readiness returned 503 with `database=down`, while liveness remained 200; readiness returned 200 after recovery;
- shutdown — direct SIGINT logged bounded graceful shutdown; ports 3000 and 5173 had no remaining listeners;
- `docker compose ... config --quiet` and `git diff --check` — passed;
- checksum unit regression proved LF and CRLF checkout bytes hash identically, unchanged SQL skips, and a content change is rejected;
- F01 regression proved `TEST_DATABASE_URL` wins over a different `DATABASE_URL`, explicit env-file loading works before app construction, non-test URLs fail before pool creation, and partial setup has safe teardown.

Decisions and corrections:

- port 5433 avoids an unrelated listener already using 5432;
- ADR-0002 replaces only ADR-0001's NestJS choice with Express 5 for explicit configuration, dependency ownership, and lifecycle; no performance claim is made;
- NestJS, decorator compiler settings, `reflect-metadata`, and direct API RxJS dependencies were removed; Express and all runtime versions remain exact-pinned;
- SQL files are Git-enforced LF and are normalized before hashing to remain compatible with the checksum already persisted from the original LF migration;
- a vulnerable transitive `shell-quote` path was removed by updating `concurrently` to 9.2.4; the final audit is clean.

Limitations:

- the GitHub Actions workflow was defined but not executed on a hosted runner; its underlying commands and Compose configuration passed locally;
- CI now sets `DATABASE_URL` to a different absent database and `TEST_DATABASE_URL` to the service database, so accidental main-database use fails closed;
- Docker Desktop must be running for database and integration commands;
- the pinned image digest is Linux amd64-specific;
- local fixture credentials are intentionally non-production, and no deployment/secrets/auth work is part of P01.

## P02A — database boundary and tenant foundation

Implemented:

- explicit privileged bootstrap for PostGIS/role creation, separate owner/migration, runtime, and maintenance credentials, and no API fallback to migration credentials;
- `users`, `organizations` (`archive_revision >= 0`), and `memberships` (`runner|coach`, active flag) with PK/FK/UNIQUE/CHECK constraints and active-membership index;
- read-only P02A runtime matrix: current identity, current organization, and own active membership only; all require active membership for the exact user/org context;
- fail-closed RLS for missing/malformed context, absent membership, and inactive membership;
- narrow boolean `SECURITY DEFINER` membership predicate with fixed safe search path and restricted EXECUTE, avoiding recursive membership policies;
- `withTenantTransaction` with canonical UUID validation, one checked-out client, transaction-local GUCs, commit/rollback, safe release/destruction, preserved callback errors, and explicit unknown-commit outcome;
- owner-only integration fixtures; runtime and maintenance roles are non-owner, non-superuser, and without `BYPASSRLS` or DDL rights.

Verification evidence:

- `npm run lint` and `npm run typecheck` passed;
- migration unit suite passed 8 tests, including deleted/changed applied files, backfilled migration names, and out-of-order history;
- API unit suite passed 16 tests, including controlled-clock shutdown and tenant transaction failure semantics;
- privileged bootstrap and migrations applied successfully to real local `running_tracker` and `running_tracker_test`; rerun skips both unchanged migrations;
- clean scratch test database completed bootstrap, applied `0000`/`0001` from empty history, skipped both on rerun, and was then removed;
- real PostgreSQL/PostGIS integration suite passed 13 tests under runtime/maintenance roles, covering two organizations, multi-membership context switching, missing/malformed/inactive/no-membership cases, schema constraints, denied DML/DDL/metadata, commit/rollback, sequential connection reuse, concurrent context independence, role attributes, and PostGIS/readiness/query deadlines;
- `npm run verify`, production builds, Compose config, and `git diff --check` passed locally.

Limits and P02B readiness at the P02A completion boundary (historical):

- D02 is PARTIAL: identity/organization isolation is verified and run/share policies are implemented but unverified, while child-table policies remain P02B;
- D01 canonical PointInput representation also remains P02B/P04;
- P02B must still add `run_points`, `run_commands`, `run_summaries`, and `run_tombstones`, their composite tenant constraints, and direct child-table ACL tests;
- HTTP authentication remains P03; P02A context is supplied only by trusted application code or test fixtures;
- GitHub Actions configuration was updated but was not run on a hosted runner.

## P02A.1 — static-review corrections

Implemented:

- one integration-test configuration validator now checks runtime, migration, and maintenance URLs before pool construction: PostgreSQL protocol, exact role, decoded `_test` database suffix, and equal normalized host/port/database;
- tenant fixture setup checks `current_database()` and `current_user` on its checked-out owner client before the first `DELETE`/`INSERT`, performs all fixture mutations through that client, and releases/destroys it on failure;
- `withTenantTransaction` now returns the callback result only for `QueryResult.command === 'COMMIT'`; a confirmed `ROLLBACK` raises a distinct known-outcome error without another rollback, while COMMIT execution failures and unexpected commands retain conservative unknown-outcome connection destruction;
- helper ownership of the outer transaction boundary and client release is explicit in code and ADR-0003;
- unit regressions cover valid and unsafe integration configurations, actual fixture-connection identity mismatch with zero mutations, realistic PostgreSQL command mocks, confirmed rollback, unexpected COMMIT results, and preserved rollback-error behavior;
- the real-PostgreSQL integration suite includes a callback that catches `SELECT 1 / 0` and verifies that its returned value is rejected after PostgreSQL reports the transaction rollback.

Verification status in the original 2026-09-20 iteration:

- no tests, lint, typecheck, build, dependency installation, Docker command, migration, or database connection was run for P02A.1, as required for this iteration;
- the P02A verification evidence above is historical and was not repeated after these corrections;
- P02A.1 was unverified at that boundary; the 2026-09-21 corrective verification below supersedes this current-status claim without rewriting the historical result.

## P02B — first bounded runs/shares fragment

Implemented:

- forward-only `0002_runs_shares_rls.sql` creates only `runs` and `run_shares` with composite tenant keys, same-organization membership FKs, SDD state/revision/time checks, the global one-active-run partial unique index, and the required list/finished indexes;
- runtime grants are explicit: `runs` has SELECT/INSERT and column-limited lifecycle UPDATE without DELETE; `run_shares` has SELECT/INSERT/UPDATE/DELETE; maintenance receives no additional access;
- owner reads and writes its run, while an active grantee reads unfinished runs through `can_read_live` and finished runs through `can_read_history`; coach role alone grants nothing;
- only a run owner mutates shares, while direct `run_shares` reads expose only owned-run grants or the current grantee's own rows;
- two narrow owner-executed boolean predicates with fixed `pg_catalog` search paths and no PUBLIC EXECUTE remove the `runs` ↔ `run_shares` policy recursion described by D02;
- integration fixtures and runtime-role scenarios cover owners, grantees, unrelated and inactive members, multi-organization membership, all grant/status combinations, revocation, prohibited grantee mutations, owner/org reassignment, cross-tenant FKs, direct share reads, and the global second-active-run rejection;
- ADR-0004 records the bounded ACL semantics and why D02 remains partial.

Verification status in the original 2026-09-20 iteration:

- no test, lint, typecheck, build, Docker, migration, or database command was run for this fragment, as required for this iteration;
- static review covered migration ordering, SQL policy direction, grants, fixture cleanup order, TypeScript imports/types, and scenario-to-requirement mapping;
- the P02A evidence above was historical and was not evidence for P02A.1 or this P02B fragment at that boundary.

Remaining P02B scope at this fragment boundary:

- `run_points`, `run_commands`, `run_summaries`, and `run_tombstones` plus their constraints and indexes;
- direct child-table ACL and cross-tenant tests completing D02;
- D01 canonical PointInput representation and executable verification of the complete stage.

## P02B — points/summaries fragment

Implemented:

- corrected the shared `run_shares` fixture query to use a contiguous parameter list without changing the fixture rows or ACL matrix;
- forward-only `0003_run_points_summaries_rls.sql` adds `run_points` and `run_summaries` with composite parent FKs, cascading deletion, SDD keys, explicit numeric/timestamp representations, range/finiteness checks, geometry typmods, nonempty geometry checks, and the required point revision and summary GiST indexes;
- raw points deliberately have no GiST index; runtime receives SELECT/INSERT only, with INSERT restricted to the active owner and no UPDATE/DELETE privilege;
- summaries are runtime-read-only; owner access is retained, while a grantee requires a finished run and active history grant, so live-only access cannot expose a summary;
- `app_private.can_read_run_history()` is a narrow boolean `STABLE SECURITY DEFINER` helper with fixed `pg_catalog` search path and no PUBLIC EXECUTE;
- the run SELECT owner branch is explicit so owner `INSERT ... RETURNING` does not depend on a stable helper seeing the row inserted by the current statement;
- ADR-0005 records the points/summaries access matrix, `quality_stats` shape, storage decisions, and the cross-row guarantees deferred to ingestion and summary publication;
- integration scenarios cover direct and joined child reads, owner/live/history/both/no-grant access, all run states, inactive membership, multi-organization context, revocation, denied mutations, `INSERT ... RETURNING`, cross-tenant FKs, invalid numeric/geometry values, duplicate point PK immutability, representations, indexes, and maintenance denial.

Verification status in the original 2026-09-20 iteration:

- no tests, lint, typecheck, build, dependency installation, Docker command, migration, or database connection was run for this fragment, as required for this iteration;
- static review covered migration ordering, grants/policies, fixture cleanup order, SQL placeholder/argument correspondence in changed queries, TypeScript structure, and scenario-to-requirement mapping;
- all earlier P01/P02A results above are historical and were not repeated after this migration and test code were added;
- the new integration scenarios were implemented but unexecuted at that boundary; the 2026-09-21 corrective verification below supplies the runtime evidence.

Remaining P02B scope at the original points/summaries fragment boundary:

- `run_commands` and `run_tombstones`, their constraints, indexes, and child ACL;
- D01 canonical `PointInput` input/payload comparison rules remain for P04; this fragment fixes only database representation;
- targeted execution of P02A.1, runs/shares, points/summaries, and then the complete P02B ACL matrix.

## P02B corrective verification — 2026-09-21

Confirmed defects:

- passing JavaScript `[]` directly to `pg` serialized it as PostgreSQL array literal `{}`, so `$1::jsonb` became JSON object `{}` and the negative `quality_stats` case could miss the intended CHECK;
- the negative summary inserts reused an existing `(org_id, run_id)` and reached `run_summaries_pkey` before the target CHECK;
- the `Box3D` extrema check was not a proof over every vertex: PostGIS 3.5.2 accepted `NaN` at the beginning/middle of a line and inside a later component, while rejection depended on vertex position.

Corrections:

- integration tests now pass JSON values via `JSON.stringify`, distinguish JSON null from SQL NULL, cover array/scalars/null/object, and assert SQLSTATE plus constraint/column where PostgreSQL exposes it;
- negative CHECK/FK/PK cases use UPDATE or collision-free keys, including exact duplicate-point PK and unchanged-row assertions;
- forward-only migration `0004_validate_display_geom_coordinates.sql` adds an immutable, strict, parallel-safe security-invoker helper over `ST_DumpPoints`, revokes runtime/maintenance/PUBLIC EXECUTE, and replaces only the summary coordinate CHECK;
- display geometry regressions cover `NaN` at every line position and component, infinities, ranges, SRID/type, EMPTY, SQL NULL, valid global geometry, and antimeridian crossing;
- runtime-role coverage now includes the parameterized live/history/both/no-grant × recording/paused/finished matrix for points and summaries through direct SELECT and JOIN, owner access/deactivation, coach/no-membership/empty/malformed/cross-org contexts, duplicate/upsert immutability, same-transaction run/point RETURNING, statement-level READ COMMITTED revocation, bigint and timestamp round-trips, composite FK, and cascade.

Verification evidence:

- pre-mutation connection proof: every configured test URL targeted `127.0.0.1:5433/running_tracker_test`; actual roles were `running_tracker`, `running_tracker_owner`, `running_tracker_runtime`, and `running_tracker_maintenance` as intended;
- initial focused integration reproduction: 11/12 child tests passed and the JSON case failed on `run_summaries_pkey`, proving the test defect; direct SQL additionally showed JS `[]` → `{}` and accepted internal `NaN` vertices;
- `npm run verify` passed: lint, strict typecheck, 8 migration tests, 28 API unit tests, 1 web test, and all production builds;
- first `npm run db:migrate:test` skipped `0000`–`0003` and applied `0004`; the immediate rerun skipped `0000`–`0004`;
- `npm run test:integration` passed 4 files / 57 tests against real PostgreSQL/PostGIS roles;
- `git diff --check` passed.

Limitations at the corrective verification boundary:

- D01 remains TODO: storage representations are verified, but canonical `PointInput` comparison for numbers, `-0`, timestamp spelling, and retries belongs to P04;
- D02 remains PARTIAL because `run_commands`, `run_tombstones`, their ACL/constraints, and the final complete-stage matrix are absent;
- full `quality_stats` keys/types/calculation remain P06 summary-publication behavior; P02B enforces only a non-null JSON object;
- hosted CI was not run. P03 and all later stages remain unstarted.

Next bounded fragment remains P02B: `run_commands` and `run_tombstones`. P03 was not started.

## P02B — commands/tombstones and complete ACL matrix

Implemented:

- forward-only `0005_run_commands_tombstones_rls.sql` adds `run_commands` with UUID composite identity/parent FK, cascading deletion, object-only JSONB payload/response checks, finite `timestamptz(3)`, owner-only SELECT/INSERT RLS, and no runtime UPDATE/DELETE;
- live/history/both grants and coach role do not reveal command payload/response; direct SELECT and JOIN use the same owner-only result;
- `run_tombstones` stores only tenant/run/owner identifiers and finite deletion/expiry timestamps, requires `expires_at > deleted_at`, has an expiry index and same-organization membership FK with `ON DELETE RESTRICT`, and deliberately has no run FK;
- tombstone RLS directly compares `owner_user_id` and current organization/user context plus active membership, without querying `runs` or calling run/share helpers; runtime receives SELECT only;
- ADR-0006 separates SQL guarantees from future P03 command atomicity/canonical replay and P10 deletion/retention guarantees;
- shared owner fixtures now delete commands before runs and tombstones before memberships, retaining RLS/FK enforcement and sequential integration execution.

Verification evidence:

- pre-mutation proof confirmed every configured URL targeted `127.0.0.1:5433/running_tracker_test`; actual logins were bootstrap `running_tracker`, object owner `running_tracker_owner`, runtime `running_tracker_runtime`, and maintenance `running_tracker_maintenance`; owner/runtime/maintenance were non-superuser and non-BYPASSRLS;
- first `npm run db:migrate:test` skipped `0000`–`0004` and applied `0005`; the required rerun skipped `0000`–`0005`;
- focused command/tombstone regression passed 12/12 after correcting two test-only assumptions discovered by the first run;
- `npm run verify` passed lint, strict typecheck, 8 migration tests, 28 API unit tests, 1 web test, and all builds;
- `npm run test:integration` passed 5 files / 69 tests under the real PostgreSQL/PostGIS roles, re-executing the complete identity, runs/shares, points/summaries, commands/tombstones, direct/JOIN, constraints, grants, RLS, ownership, and maintenance matrix;
- `git diff --check` passed after documentation updates.

Decision/status boundary:

- D02 is RESOLVED for database authorization with trusted transaction-local tenant/user context. This does not verify or implement HTTP authentication/session establishment, which remains P03;
- D01 remains TODO for P04: JSONB object storage and `canonical_payload` naming do not define canonical numeric/timestamp forms, `-0`, or semantic retry comparison;
- D08, the retention duration/default, cleanup, behavior after expiry, run-ID reuse prevention, and atomic tombstone + run deletion + `archive_revision` transaction remain P10;
- P02B is intentionally not marked DONE while D01 remains open. P03 and later product behavior were not started; hosted CI was not run.

## P03.1 — HTTP session boundary and API error foundation

Implemented:

- `POST /api/session` as an explicitly enabled development/test-only login fixture using exact configured Origin, JSON-only requests, and a server-side UUID allowlist; missing `userId` never selects a default identity;
- `GET /api/session` for verified identity, server expiry, and session-bound CSRF data; `DELETE /api/session` revokes the server record and clears the cookie;
- random opaque session/CSRF tokens, digest-indexed bounded in-memory storage, injected clock/store, server-side expiry, no background interval/global singleton, and explicit restart session loss;
- `HttpOnly`, `SameSite=Strict`, `Path=/`, no-Domain cookies, with `Secure` by default and an explicit development/test-only local HTTP exception;
- fail-fast configuration: local auth defaults off, production rejects local auth and insecure cookies before pool construction/listener binding, and protected API has no anonymous/default-user fallback;
- reusable session → exact Origin → session-bound CSRF middleware for mutations; allowed origins are static configuration and never derived from Host/X-Forwarded headers;
- server-generated UUID request IDs before parsers/routers, matching `X-Request-Id` and the unified application `ApiError` body; invalid JSON/validation, auth, Origin/CSRF, organization, unknown routes, and unexpected errors are normalized without stacks, SQL, credentials, cookies, tokens, or internal error objects;
- the existing health body/status contract remains separate and unchanged, with only `X-Request-Id` added;
- `withAuthenticatedTenantTransaction`: derives `userId` only from the resolved session, validates client-selected `orgId`, opens `withTenantTransaction` under runtime-role, verifies current active membership inside the same transaction, and runs the DB operation on the same client;
- minimal Express/pg-independent runtime schemas for public session and ApiError responses in `packages/contracts`;
- ADR-0007 and synchronized SDD/plan/backlog/README/local configuration. D03 is split into resolved P03 `D03a` and TODO P12 production provider `D03b`.

Verification evidence:

- Docker Desktop 29.7.2/Linux engine was started; only the existing `running_tracker_test` target was bootstrapped/mutated for fixtures;
- `npm run db:bootstrap:test` succeeded; `npm run db:migrate:test` verified unchanged checksums and skipped migrations `0000`–`0005`;
- focused real-role HTTP integration passed 1 file / 4 tests for two organizations, dual membership, inactive/no membership, deactivation between requests, callback denial, identity spoof attempts, and pooled connection reuse;
- `npm run verify` passed lint, strict typecheck, 8 migration tests, 37 API unit/HTTP tests, 1 web test, and all production builds;
- full `npm run test:integration` passed 6 files / 73 tests under the real owner/runtime/maintenance roles, including the new HTTP → session → tenant transaction path and the complete prior ACL matrix;
- a real listener smoke returned session create/read/logout/reuse statuses `201/200/204/401`, with `HttpOnly`, `SameSite=Strict`, `Path=/`, `no-store`, and a response request ID observed without printing token values; SIGINT then completed controlled shutdown;
- `git diff --check` passed; migrations `0000`–`0005` were not modified.

Limitations and remaining boundary:

- the local in-memory store is intentionally single-process, bounded, and loses all sessions on restart; it is not a production availability mechanism;
- external login, provider callback/recovery, durable/distributed sessions, deployed TLS/proxy/secrets, and production identity lifecycle remain D03b/P12;
- P03.2 and P03.3 were subsequently completed as recorded below; P03.4–P03.5 run-read/share/auto-finish behavior remains TODO;
- P02B is still IN PROGRESS because D01 canonical `PointInput` remains P04-owned; P03 as a whole is not marked DONE;
- hosted CI was not run, and no commit, push, deploy, paid-provider call, main-database migration, or Docker volume deletion occurred.

## P03.2 — runtime API contracts and specification layer

Implemented:

- reusable strict Zod schemas and inferred types for UUIDs, UTC timestamps, PostgreSQL-bigint-domain revision/seq strings, run/raw states, quality statistics, run views, point input, track points/pages, and supporting finite/range-bounded primitives;
- strict request/response/path/query contracts for sessions, errors, run creation/list/detail, lifecycle commands, point ingestion/history, shares, stable live-track reads/changes, archive track/list/metadata/MVT parameters, and nearby reads;
- lifecycle and transport invariants already fixed by the SDD: finished status/time coupling, raw purge state only on finished runs, ordered revisions/date ranges, 366-day archive range, WGS84/accuracy bounds, point batch/count limits, pagination limits, and exactly one changes cursor source;
- the P03.1 public `SessionResponse` and `ApiErrorResponse` shapes retained as shared strict contracts and covered by compatibility fixtures;
- a generated OpenAPI 3.1 JSON artifact for ordinary HTTP APIs, built from the shared Zod schemas plus route metadata without adding Swagger UI or an OpenAPI runtime dependency;
- a separate `/live` SSE contract with exported strict `live.state` payload validation and explicit event framing, fresh per-connection `streamId`, connection-local monotonic `sequence`, session-expiry/revocation disconnect behavior, session check before reconnect, and no `Last-Event-ID` replay promise;
- D01 remains explicitly open: `PointInput` validates the transport value domain but does not canonicalize numeric/timestamp spelling, normalize `-0`, or decide retry equivalence.

Verification evidence on 2026-09-22:

- focused contracts suite passed 1 file / 13 tests for valid/invalid payloads, strict unknown-key rejection, lifecycle invariants, complete quality statistics, UUIDs, UTC timestamps, bigint string bounds, finite/ranged coordinates and accuracy, command enums, point batches, pagination/range/bbox/nearby queries, P03.1 compatibility, SSE payloads, and generated OpenAPI synchronization;
- `npm run verify` passed root lint and strict typecheck, 8 migration tests, 37 API tests, 1 web test, 13 contract tests, and all production builds; the contracts build regenerated the committed OpenAPI artifact;
- Docker Compose started PostgreSQL, `npm run db:bootstrap:test` succeeded, and `npm run db:migrate:test` verified unchanged checksums while skipping migrations `0000`–`0005`;
- full `npm run test:integration` passed 6 files / 73 tests under the real owner/runtime/maintenance roles, rechecking the P03.1 HTTP-to-tenant boundary and existing DB ACL matrix;
- no migration or RLS policy was changed; no run/command/share handler or DB business logic was added; no commit, push, main-database migration, or hosted CI run occurred.

Remaining P03 boundary:

- P03.4 run/list/share handlers and P03.5 clock-driven auto-finish remain separate later fragments;
- P04 still owns D01 `PointInput` canonicalization/retry equivalence and point ingestion behavior.

## P03.3 — atomic run creation and lifecycle commands

Implemented:

- `PUT /api/orgs/:orgId/runs/:runId` and `POST /api/orgs/:orgId/runs/:runId/commands` use the P03.1 authenticated mutation middleware and `withAuthenticatedTenantTransaction`, and validate paths, requests, successful responses, and persisted replay responses with the shared P03.2 Zod contracts;
- run creation checks an owner-visible tombstone, creates the run and its server `created_at` in one tenant transaction, returns `201` for the insert and `200` for an equivalent retry, rejects changed creation payload with `409 ACTIVE_RUN_EXISTS`, returns `410 RUN_DELETED` for the deleted owner run ID, and maps the named partial unique-index violation to `409 ACTIVE_RUN_EXISTS`;
- lifecycle commands lock the owned run row with `FOR UPDATE`, then query `run_commands` before any expected-revision check; a canonical payload normalizes the decimal revision string and stores only `{ expectedControlRevision, type }` beside the command UUID;
- an identical command retry returns the validated stored JSON response, while command-ID reuse with a different payload, a stale control revision, and an invalid transition return `409 CONTROL_REVISION_CONFLICT`, the existing SDD 409 code for lifecycle concurrency conflicts;
- accepted transitions are exactly `recording -> paused`, `paused -> recording`, `recording -> finished`, and `paused -> finished`; each increments `control_revision` and `data_revision` once, while finish sets the injected server timestamp once and `finished` remains terminal;
- the run update and immutable command/result insert share the outer PostgreSQL transaction, so an insert failure rolls the state/revision update back; all bigint revisions remain decimal strings at the HTTP and JSONB boundaries;
- the API now declares its workspace dependency on `@running-tracker/contracts`; API typecheck/test/build lifecycle hooks build that dependency first so a clean checkout does not depend on an ignored pre-existing contracts `dist` directory.

Verification evidence on 2026-09-22:

- focused lifecycle unit coverage passed and the complete API unit suite passed 9 files / 38 tests;
- focused real-PostgreSQL HTTP integration passed 1 file / 10 tests, covering equivalent and changed create retries, concurrent equivalent creation, two competing active-run creations, tombstone rejection, two different concurrent commands at one revision, the same command concurrently and after commit, command-ID payload mismatch, stale revisions, the complete transition path and terminal finish, and rollback after a forced command-insert failure;
- `npm run verify` passed root lint, strict typecheck, 8 migration tests, 38 API unit tests, 1 web test, 13 contract tests, and all production builds;
- Docker Compose was healthy, `npm run db:bootstrap:test` succeeded, and `npm run db:migrate:test` skipped unchanged migrations `0000`–`0005` after checksum verification;
- full `npm run test:integration` passed 7 files / 83 tests under the real owner/runtime/maintenance roles;
- `git diff --check` passed; no migration, RLS policy, P03.1/P03.2 contract, commit, push, main-database migration, hosted CI run, or P03.4+ behavior was added.

Remaining P03 boundary:

- P03.3 has no known implementation gap within its assigned scope;
- P03.4 was subsequently completed as recorded below, and P03.5 owns maintenance auto-finish;
- point ingestion/canonicalisation, history, SSE delivery, archive behavior, and tombstone creation/retention remain in their later assigned stages.

## P03.4 — run list/read and share management

Implemented:

- `GET /api/orgs/:orgId/runs` validates the documented half-open `started_at` range and limit, returns only owner/RLS-visible runs, joins published summaries in the same query, and uses deterministic descending keyset pagination on `(started_at, id)` without owner/share join duplication;
- `GET /api/orgs/:orgId/runs/:runId` returns the shared `RunView`, including decimal-string revisions and UTC timestamps, while RLS applies the live grant to recording/paused runs and the history grant to finished runs;
- inaccessible and missing concrete runs share `404 RUN_NOT_FOUND`; an owner-visible tombstone returns `410 RUN_DELETED`, while the same tombstone remains hidden from unrelated members;
- `PUT /api/orgs/:orgId/runs/:runId/shares/:userId` and the matching `DELETE` are protected by session, exact Origin, session-bound CSRF, current active caller membership, explicit run ownership, and the existing run/share RLS policies;
- share PUT uses the existing composite primary key as the concurrency authority and atomically upserts the two permission booleans; identical concurrent requests persist one row and return the same `200` representation, while DELETE is idempotent for an existing owned run;
- membership FKs reject recipients outside the organization. An inactive member may retain a dormant share row, but the authenticated transaction boundary and RLS deny access until membership becomes active; a share never grants run lifecycle mutation rights.

Verification evidence on 2026-09-22:

- focused real-PostgreSQL HTTP integration passed 1 file / 9 tests covering list visibility, half-open filtering, limits, invalid cursors, deterministic multi-page order, no duplicates, owner/shared/private reads, malformed/missing/deleted IDs, concurrent share upsert, revoke, unauthorized share management, self-share, invalid recipient, inactive membership, and read-without-mutation authorization;
- the existing focused P03.3 lifecycle suite passed 1 file / 10 tests unchanged;
- `npm run db:bootstrap:test` succeeded and `npm run db:migrate:test` skipped unchanged migrations `0000`–`0005` after checksum verification;
- full `npm run test:integration` passed 8 files / 92 tests under the real owner/runtime/maintenance roles;
- `npm run verify` passed root lint, strict typecheck, 8 migration tests, 38 API unit tests, 1 web test, 13 contract tests, and all production builds;
- no migration, RLS policy, API contract, dependency, commit, push, main-database migration, production-data write, paid-provider call, or hosted CI run occurred.

Remaining P03 boundary:

- P03.4 has no known implementation gap within the documented contract. The cursor is an opaque transport value carrying the specified `(started_at, id)` key; signed operation-bound cursors remain the separately planned P07 scope;
- P03.5 clock-driven auto-finish remains the recommended next task;
- deletion/tombstone creation and retention remain P10, production identity remains P12, and P02B remains partial only because P04 owns D01 point canonicalization.

## P03.5 — clock-driven automatic run finishing

Implemented:

- forward-only migration `0006_auto_finish_runs.sql` defines `app_private.auto_finish_runs(timestamptz)` as an owner-executed `SECURITY DEFINER` function with fixed `pg_catalog` search path and fully qualified table access; PUBLIC/runtime EXECUTE are revoked and maintenance receives only schema USAGE plus function EXECUTE, with no direct `runs` SELECT/UPDATE, DDL, superuser, or BYPASSRLS capability;
- one conditional PostgreSQL UPDATE changes eligible `recording`/`paused` rows whose `created_at <= effective_now - interval '24 hours'`, sets `finished_at` to the supplied finite UTC value, and increments `data_revision` once; it leaves `control_revision` and `raw_state` unchanged and creates no `run_commands` row;
- forward-only migration `0007_bound_run_start_for_auto_finish.sql` and matching create-service validation guarantee `started_at <= created_at + 24 hours`. P03.5 exposed this necessary compatibility bound: without it, an accepted far-future client start could conflict with the existing `finished_at >= started_at` invariant at the mandatory auto-finish deadline;
- equivalent concurrent run creation is transaction-serialized only for the same `(orgId, runId)` through a PostgreSQL advisory lock. This closes a reproduced P03.3 regression where the one-active-run partial index could win before the identical primary-key conflict was resolved; different IDs still use the existing unique constraint as concurrency authority;
- `runAutoFinishOnce` reads one injected `Clock.utcNow()` value and issues one function call without owning a timer or transaction between cycles;
- `RunAutoFinishRunner` schedules the first and subsequent cycles through the injected clock, never overlaps executions, schedules the next interval only after settlement, logs and recovers from a failed cycle, and removes pending timers on stop;
- `RUN_AUTO_FINISH_INTERVAL_MS` is validated and defaults to 60 seconds as an implementation cadence, not a product SLA. `MAINTENANCE_DATABASE_URL` must authenticate exactly as `running_tracker_maintenance` and target the runtime URL's same host, normalized port, and database;
- `main.ts` alone creates and starts the maintenance pool/runner. Controlled shutdown stops scheduling first, closes HTTP, then closes runtime and maintenance pools concurrently within the existing shared monotonic deadline.

Concurrency and revision result:

- PostgreSQL row locking and UPDATE predicate rechecks decide maintenance-versus-command and maintenance-versus-maintenance races. Explicit finish first makes maintenance skip; maintenance first makes the later command observe terminal `finished`; pause/resume first may commit its own status/revision change before maintenance performs the separate finish;
- each successful auto-finish contributes exactly one `data_revision`, never a `control_revision`; two maintenance passes cannot double-apply, `finished_at` is never rewritten, and the active-run partial unique index is released on commit.

Verification evidence on 2026-09-23:

- focused scheduler/config/shutdown/main unit run passed 4 files / 26 tests; the scheduler file itself covers 6 tests for injected time, not-before-due, due execution, non-overlap, repetition, failed-cycle recovery, and stop behavior;
- focused real-PostgreSQL P03.5 integration passed 1 file / 12 tests; combined P03.3/P03.5 regression passed 2 files / 22 tests;
- the first full integration run exposed the equivalent-create race above (`201/409` instead of `201/200`); after the advisory-lock correction, full `npm run test:integration` passed 9 files / 104 tests under real owner/runtime/maintenance roles;
- `npm run db:migrate:test` applied `0006`, then `0007`; the required final rerun verified checksums and skipped unchanged migrations `0000`–`0007`;
- `npm run verify` passed root lint, strict typecheck, 8 migration tests, 46 API unit tests, 1 web test, 13 contract tests, and all production builds;
- no existing migration `0000`–`0005`, RLS policy, dependency, commit, push, main-database migration, production-data write, paid-provider call, or hosted CI run occurred.

Status and remaining boundary:

- P03 is DONE: P03.1–P03.5 have executable unit and real-role integration evidence;
- P02B is now DONE because P04.1 resolved its only remaining item, D01 canonical `PointInput`/retry comparison;
- each API process currently owns one safe, idempotent scheduler, so multiple instances may perform redundant function calls. Durable job ownership, backoff/metrics, and hosted CI remain operational follow-up rather than P03 correctness requirements;
- P04.1 is documented below; its completion does not start raw history, simulator, browser buffering, SSE, geometry, or retention.

## P04.1 — bounded atomic point-batch ingestion

Implemented:

- canonical strict `PointInput` across shared contracts, HTTP, service, persistence comparison, and tests: required non-null `seq`, `segmentId`, `recordedAt`, `longitude`, `latitude`, `accuracyM`; unknown keys rejected; bigint decimal `seq`, negative zero, and UTC millisecond timestamp spelling normalized deterministically;
- authenticated `POST /api/orgs/:orgId/runs/:runId/points` with the existing error envelope, 1–100 entry limit, 64 KiB JSON limit, owner-only access under runtime-role RLS, and 50,000 unique points per run;
- one outer tenant transaction and owned-run `FOR UPDATE`; set-based existing-point lookup and `unnest` insert; one `data_revision` increment per batch containing new points, the same `ingested_revision` for those rows, and no `control_revision` change;
- exact retries and identical in-batch duplicate sequences are acknowledged without reinsertion; any canonical payload mismatch rejects the full batch with `POINT_CONFLICT`;
- recording and paused runs accept uploads; finished runs accept new points through `finished_at + 24h`, exact retries remain acknowledged after closure, and unavailable raw state fails before replay disclosure;
- `seq`, not arrival or timestamp, defines ordering. Unsorted/lower late sequences, equal timestamps, and device future/old timestamps are valid raw history; live freshness filtering remains later work;
- no migration was added: existing P02B PK/FK/CHECK/RLS/grants and revision columns already enforce the storage boundary.

Verification evidence on 2026-09-23:

- focused shared-contract tests passed 1 file / 13 tests; focused P04.1 real-PostgreSQL integration passed 1 file / 10 tests;
- combined P04.1 plus P03.3/P03.5 regression passed 3 files / 32 tests;
- complete `npm run test:integration` passed 10 files / 114 tests under real owner/runtime/maintenance roles;
- a stale checksum state in the disposable `running_tracker_test` database was detected before migration execution. Only that `_test` database was rebuilt from the documented bootstrap URL; migrations `0000`–`0007` then applied cleanly and the required rerun skipped all eight with matching checksums. The main database was not connected to or migrated;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 46 API unit tests, 1 web test, 13 contract tests, and all production builds;
- `git diff --check` passed. No migration, dependency, commit, push, main/production database write, paid-provider call, or hosted CI run occurred.

P04.1 is DONE. At that delivery boundary, raw history and later P04 work were intentionally still open; P04.3 below completes raw history without changing the P04.1 evidence (the former standalone P04.2 revision invariant was completed as a required part of P04.1).

## P04.3 — revision-bound raw point history

Implemented:

- authenticated `GET /api/orgs/:orgId/runs/:runId/points` uses the existing strict query/response contracts, defaults to 1,000 points, rejects limits outside 1–1,000, and returns canonical `PointInput` values ordered by bigint `seq`;
- an opaque operation-bound cursor carries `orgId`, `runId`, `dataRevision`, and the last `seq`. Reusing it for another run is `400 INVALID_CURSOR`; a changed run revision is `409 HISTORY_REVISION_CHANGED`, requiring replay from the first page;
- each page is read through one PostgreSQL statement snapshot that returns the authorized run revision/raw state and a `limit + 1` lateral keyset page together. This prevents a page from mixing a pre-ingestion revision with post-ingestion points without requiring a row-mutation lock from history-only readers;
- owners may read raw points for active or finished runs. A non-owner requires `can_read_history` on a finished run; `can_read_live` alone does not expose the raw-history endpoint. Existing session, active-membership, tenant transaction, child-table RLS, and error-envelope boundaries remain in force;
- authorization is resolved before object retention/revision information. Authorized `purging`/`purged` history returns `410 RAW_HISTORY_UNAVAILABLE`; inaccessible and missing runs remain indistinguishable as `404 RUN_NOT_FOUND`;
- no migration, RLS/grant change, dependency, or public contract change was required: the P03.2 `PointsResponse`/OpenAPI shape and P02B primary-key/index/ACL foundation were sufficient.

Verification evidence on 2026-09-25:

- focused P04.3 real-PostgreSQL integration passed 1 file / 8 tests; combined P04.3/P04.1/P03.4 regression passed 3 files / 27 tests;
- complete `npm run test:integration` passed 11 files / 122 tests under the real owner/runtime/maintenance roles;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 46 API unit tests, 1 web test, 13 contract tests, and all production builds;
- `npm run db:bootstrap:test` succeeded and `npm run db:migrate:test` verified and skipped unchanged migrations `0000`–`0007` with matching checksums;
- `git diff --check` passed. No migration, dependency, commit, push, main/production database write, paid-provider call, or hosted CI run occurred.

P04.3 is DONE; P04 remains IN PROGRESS. P04.4 below completes deterministic GPS simulation. P04.5 fault injection, browser buffering, SSE, geometry, and retention remain unstarted.

## P04.4 — deterministic GPS simulator

Implemented:

- `@running-tracker/fixtures` generates six canonical `PointInput` captures from an explicit uint32 seed and normalized UTC start instant; identical inputs produce byte-stable JSON data while different seeds vary route noise and accuracy;
- `VirtualClock` exposes UTC and monotonic time, deterministic due-time/FIFO callback ordering, explicit `advanceBy`/`advanceTo`/`runAll`, cancellation, and invalid/backwards-time guards without wall-clock sleeps;
- scenario replay emits immutable capture and upload-attempt events for `normal`, `duplicates`, `reordered`, `delayed-batch`, `dropped-response`, `clock-jump`, and `gps-spike`;
- the reordered scenario uploads `41 → 43 → 42`; delayed transmission keeps regular measurement timestamps; clock rollback changes device `recordedAt` while monotonic capture order continues; the spike exceeds 5 km between adjacent samples;
- dropped-response describes `drop-after-commit` followed by an exact retry without adding an API hook or performing network I/O, preserving the P04.5 boundary;
- `@running-tracker/gps-simulator` provides a JSON Lines CLI with strict scenario/seed argument handling and stable metadata/event output through `npm run simulate:gps`.

Verification evidence on 2026-09-26:

- focused fixtures coverage passed 3 files / 14 tests and CLI coverage passed 1 file / 3 tests; focused lint and strict typechecks passed;
- a CLI smoke replay for seed `42` emitted the required `41 → 43 → 42` upload sequence on the expected virtual timeline;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 46 API unit tests, 1 web test, 13 contract tests, 14 fixture tests, 3 CLI tests, and all production builds;
- PostgreSQL was started only for verification; process-local values from `.env.example` were used because no `.env` exists. `npm run db:bootstrap:test` succeeded, `npm run db:migrate:test` checksum-verified and skipped unchanged migrations `0000`–`0007`, and full integration passed 11 files / 122 tests under the real owner/runtime/maintenance roles;
- the Compose service was stopped afterward with its named database volume preserved; `git diff --check` is part of the final handoff check.

P04.4 is DONE. At that delivery boundary P04 remained in progress; P04.5 below closes the stage. Browser buffering, SSE, geometry, and retention remain later stages.

## P04.5 — safe post-commit response-loss injection

Implemented:

- `createApp` accepts an optional `testOnlyFaultInjector` dependency and rejects all test-only app dependencies unless validated configuration has `APP_ENV=test`, before any pool access or listener construction;
- the capability has no environment variable, request header, route, or other remotely triggerable control surface, and production `main` never supplies it;
- point ingestion evaluates the injected decision only after `withAuthenticatedTenantTransaction` returns, which occurs only after PostgreSQL reports `COMMIT`; a selected request then destroys the HTTP response before headers/body are sent;
- the deterministic integration scenario creates a run through HTTP, arms a one-shot run-specific drop, observes client `ECONNRESET`, and proves through the owner connection that two points and `data_revision=1` were already committed;
- an exact HTTP retry returns `insertedCount=0`, `duplicateCount=2`, and the same `dataRevision=1`; raw history returns exactly those two canonical points; the subsequent finish command succeeds with `controlRevision=1` and `dataRevision=2`;
- normal errors still use the existing error envelope, while the injected case deliberately produces no misleading 5xx response because the simulated failure is transport loss after commit.

Verification evidence on 2026-09-26:

- focused non-test safety coverage passed 1 file / 4 tests, proving both development and production reject the injected capability before database access;
- focused real-PostgreSQL ingestion/fault coverage passed 1 file / 11 tests, including the complete create → committed response loss → exact retry → raw history → finish demonstration;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 48 API unit tests, 1 web test, 13 contract tests, 14 fixture tests, 3 CLI tests, and all production builds;
- `npm run db:bootstrap:test` succeeded, `npm run db:migrate:test` checksum-verified and skipped unchanged migrations `0000`–`0007`, and full integration passed 11 files / 123 tests under the real owner/runtime/maintenance roles;
- no migration, third-party dependency, public API contract, externally activatable fault switch, commit, push, main/production database write, paid-provider call, or hosted CI run occurred. The Compose service was stopped afterward with its named database volume preserved; `git diff --check` is part of the final handoff check.

P04 is DONE. At that delivery boundary the smallest next planned fragment was P05.1 runner recording UI/state; P05.2–P05.5, SSE, geometry, archive maps, retention, and production identity remained unstarted.

## P05.1 — runner recording UI and state

Implemented:

- the web application now discovers the same-origin server session and exposes organization-scoped start, pause, resume, and finish controls backed by the existing strict shared contracts;
- the reducer keeps server-confirmed run state separate from pending control requests, browser connectivity, upload status, and actionable errors. Invalid lifecycle transitions and concurrent control requests are rejected by the state model;
- lifecycle commands use the current `controlRevision`; an unconfirmed mutation retains the exact run ID or command ID/payload so user-triggered retry preserves backend idempotency after an unknown transport outcome;
- online/offline events update independently of the confirmed run status. Server mutations are disabled offline and the UI states explicitly that durable offline command queueing starts in P05.2;
- the responsive runner dashboard shows elapsed foreground session time, run/revision identity, recording/network/upload/server status, structured API error references, session expiry, and API/database health;
- the web workspace now consumes `@running-tracker/contracts` directly and builds it before web test/typecheck/build, preventing the UI from drifting from server response schemas.

Verification evidence on 2026-09-26:

- focused web tests passed 4 files / 13 tests, covering initial UI rendering, API request/CSRF shapes, structured failures, lifecycle transitions, stale completions, connectivity independence, retry identity, and finished-run reset;
- focused web lint, strict typecheck, and production Vite build passed;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 48 API unit tests, 13 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- browser screenshot verification was unavailable because the computer-use environment exposed no browser surface; no visual/browser-interaction result is claimed;
- no migration, external dependency, public API change, IndexedDB storage, upload worker, geolocation, writer lease, push, paid-provider call, or hosted CI run occurred.

P05.1 is DONE. The next planned fragment is P05.2 atomic IndexedDB persistence for `seq` plus each point and durable storage of commands until acknowledgement. P05.3–P05.5, SSE, geometry, archive maps, retention, and production identity remain unstarted.

## P05.2 — durable IndexedDB runner buffer

Implemented:

- a versioned IndexedDB database separates authenticated-user profiles, run snapshots/sequence state, canonical points, and unacknowledged requests; organization and run identifiers remain part of every run-scoped key;
- point capture storage reads the next positive-bigint decimal `seq`, validates the complete shared `PointInput`, inserts the point, and advances `seq` in one `runs` + `points` read-write transaction. Failed validation/storage cannot consume a sequence independently of a point;
- an internal zero-padded 19-character sequence key preserves positive-bigint ordering for IndexedDB batch reads without converting API `seq` values to lossy JavaScript numbers;
- point reads are bounded to the server maximum of 100. Local acknowledgement deletes only the explicit sequence set passed for the sent batch, and repeating the same acknowledgement does not remove later buffered points;
- exact start/lifecycle requests are persisted before HTTP dispatch and retained on offline or failed/unknown outcomes. A server success deletes that one request only in the local transaction that also stores the new confirmed run snapshot;
- after session identity is known, reload recovery restores the active organization/run, buffered point count, and exact unacknowledged request. Offline controls can queue locally, while retry remains explicit until connectivity returns;
- clearing a finished run removes only its active UI pointer; buffered points remain available for the future P05.3 uploader. The storage schema/invariants and deferred boundaries are recorded in ADR-0008;
- `fake-indexeddb` is a web-workspace test-only dependency used to exercise IndexedDB transaction/index behavior without adding runtime bundle code.

Verification evidence on 2026-09-26:

- focused web tests passed 5 files / 20 tests, including 6 IndexedDB cases for concurrent allocation, close/reopen sequence continuity, invalid-point rollback, ordered explicit ACK behavior, exact request recovery, atomic command acknowledgement, and point retention after UI clearing;
- focused web lint, strict typecheck, and production Vite build passed;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 48 API unit tests, 20 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- no migration, public HTTP contract, database write, upload worker, geolocation source, cross-tab writer lease, commit, push, paid-provider call, hosted CI, or real-browser interaction test occurred. IndexedDB behavior is verified through the standards-compatible test implementation, not claimed as browser/device QA.

P05.2 is DONE. The next planned fragment is P05.3: bounded point upload batches, retry backoff/jitter, deletion of only server-acknowledged batches, and stop/reconciliation behavior for permanent errors. P05.4–P05.5, SSE, geometry, archive maps, retention, and production identity remain unstarted.

## P05.3 — bounded point upload and reconciliation

Implemented:

- one foreground worker per restored/active run reads ordered IndexedDB points in sequential batches of at most 100 and never mutates the in-flight payload;
- a response deletes only the explicit sent sequences after the shared success contract is valid and inserted plus duplicate counts account for the complete batch. The returned `dataRevision` is stored atomically with deletion and cannot regress when a late concurrent-tab acknowledgement arrives;
- transport/storage failures and HTTP 5xx/408/425/429 retain the batch and retry with capped exponential full jitter. `Retry-After` is parsed and honoured within a bounded five-minute scheduling ceiling; going offline cancels scheduled dispatch and reconnect wakes the durable buffer;
- other HTTP 4xx results and incomplete success acknowledgements stop automatic upload for that run, retain every unacknowledged point, expose the permanent error, and attempt an authenticated run read to refresh the durable/UI snapshot;
- `CONTROL_REVISION_CONFLICT` on a queued lifecycle command now performs terminal reconciliation: the command is removed only in the same IndexedDB transaction that stores a successfully read authoritative run. This covers an offline finish losing to server auto-finish without dropping still-uploadable points;
- a finished run cannot be cleared while it still has buffered points. The P05.3 decisions and deferred ownership/background boundaries are recorded in ADR-0009.

Verification evidence on 2026-09-26:

- focused web tests passed 6 files / 32 tests, including deterministic 100/100/5 batching, exact ACK deletion, response-loss retry of an unchanged batch, jitter and `Retry-After`, offline/reconnect, permanent stop, malformed acknowledgement rejection, monotonic local revisions, and atomic command reconciliation;
- focused web lint, strict typecheck, and production Vite build passed;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 48 API unit tests, 32 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- no migration, public HTTP contract, runtime dependency, database write, geolocation source, cross-tab writer lease, commit, push, paid-provider call, hosted CI, or real-browser interaction test occurred. Browser lifecycle/IndexedDB behavior is covered with reducer/API tests and `fake-indexeddb`, not claimed as device QA.

P05.3 is DONE. The next planned fragment is P05.4: a single writer owner across tabs with an explicit lease/lock and conflict UX. P05.5, SSE, geometry, archive maps, retention, and production identity remain unstarted.

## P05.4 — fenced cross-tab writer ownership

Implemented:

- IndexedDB schema version 2 adds one authenticated-user-scoped writer lease, matching the server's global one-active-run-per-user invariant. Each tab has an in-memory UUID owner identity;
- lease acquisition is one atomic read-write transaction. A live competing owner is returned as a conflict, while an expired lease can be taken over with a monotonically increasing decimal bigint fencing token;
- renewal requires the same owner/token and a still-live lease; release also requires the same owner/token. A stale tab therefore cannot renew or delete a successor's lease;
- the coordinator uses a 15-second lease and 5-second heartbeat, fails closed when renewal/storage fails, and releases best-effort on clear/unmount. Restored activity claims automatically; idle tabs claim lazily before start and reread durable recovery state after acquisition;
- lifecycle requests and point-upload dispatch require confirmed ownership. Non-owner tabs do not run the uploader, lifecycle controls are read-only, and conflict/loss UX shows lease expiry plus an explicit ownership retry;
- ADR-0010 records the offline/distributed trade-off: the lease coordinates same-origin tabs. It does not falsely claim global exclusivity between disconnected devices; server active-run uniqueness, control revisions, idempotent request identities, and canonical point conflict handling remain that boundary.

Verification evidence on 2026-09-26:

- focused web tests passed 7 files / 37 tests, including lossless IndexedDB v1→v2 upgrade, simultaneous acquisition by two storage instances, expiry takeover, fencing-token advancement, stale renew/release rejection, coordinator renewal, fail-closed ownership loss, and durable request recovery by a successor tab;
- focused web lint, strict typecheck, and production Vite build passed;
- `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 48 API unit tests, 37 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- no migration, public HTTP contract, runtime dependency, database write, geolocation source, commit, push, paid-provider call, hosted CI, or real-browser interaction test occurred. Cross-tab correctness is covered through two clients sharing `fake-indexeddb`, not claimed as browser/device QA.

P05.4 is DONE. The next planned fragment is P05.5: connect Geolocation and the deterministic simulator through one source interface, with stale-callback rejection and recording tests that do not depend on an external map. SSE, geometry, archive maps, retention, and production identity remain unstarted.

## P05.5 — fenced foreground Geolocation and simulator capture

Implemented:

- device Geolocation and the existing seeded fixture simulator implement one `CaptureSource` interface and emit the same source-neutral measurement shape. The simulator's fixture `seq`/`segmentId` are deliberately discarded because browser storage owns those identities;
- `CaptureController` serializes callbacks, starts only for a confirmed recording run, and invalidates its generation before pause/finish/unmount/loss cleanup. A callback stopped while ownership renewal is in flight cannot be accepted as a new measurement; a 100-measurement ceiling stops capture visibly rather than allowing an unbounded callback queue;
- IndexedDB atomically allocates a new bounded `segmentId` for each start/resume/recovered foreground session. The counter survives point upload deletion and page reload;
- every measurement renews the writer lease, then IndexedDB verifies the same owner/fencing token and live expiry inside the point write transaction. Lease takeover therefore fences both segment allocation and capture persistence, not only UI/network dispatch;
- a durable point updates visible pending state and wakes the existing uploader. Capture remains active offline and is explicitly foreground-only;
- the runner UI exposes device GPS versus deterministic simulator selection and independent capture state. ADR-0011 records the stale-callback, segment, lease, and no-background guarantees;
- no Mapbox token contract exists in tracked configuration and no token was supplied, so no paid/external map runtime was added. Core capture and verification remain tokenless; map presentation remains P08/P09 scope.

Verification evidence on 2026-09-26:

- focused web tests passed 9 files / 45 tests, including Geolocation adaptation, seeded simulator replay, bounded serialized persistence, durable segment assignment, ownership loss, stale async callback rejection, and transactional fencing across IndexedDB lease takeover;
- focused web lint, strict typecheck, and production Vite build passed;
- full `npm run verify` passed root lint, strict workspace typecheck, 8 migration-history tests, 48 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- `git diff --check` passed;
- no migration, public HTTP contract, server/database behavior, paid-provider call, Mapbox integration, commit, push, hosted CI, or real-browser/device GPS interaction occurred. Browser APIs and IndexedDB concurrency are covered with injected ports and `fake-indexeddb`, not claimed as physical-device QA.

P05 is DONE. The next planned fragment is P06.1: one versioned edge-validity rule shared by summary processing and the future live-track path. SSE, archive maps, retention, and production identity remain unstarted.

## P06.1 — versioned PostGIS track-edge evaluation

Implemented:

- `app_private.current_track_algorithm_version()` establishes `v1` as the single current version for future summary and live-track SQL;
- `app_private.evaluate_track_edge(...)` applies the SDD thresholds to consecutive raw points using spheroidal PostGIS distance and `recorded_at`, returning accepted/rejected, one stable primary rejection reason, distance, and duration;
- rejection precedence is seq gap, segment break, poor accuracy, nonpositive time delta, excessive time gap, then excessive speed. Unknown versions fail closed with SQLSTATE `22023`;
- the pure evaluator is immutable, strict, parallel-safe, security-invoker, and available only to the runtime and maintenance roles. ADR-0012 records the shared-database-algorithm boundary.

Verification evidence on 2026-09-26:

- focused real-PostGIS integration passed accepted threshold boundaries, all six rejection paths and precedence (including zero/negative time), speed-spike filtering, antimeridian/high-latitude distance, unsupported versions, and runtime/maintenance/PUBLIC privilege checks;
- full `npm run verify`, full real-role integration, migration preflight/application, and `git diff --check` passed;
- no summary aggregation/publication, geometry construction/simplification, public HTTP contract, SSE/live-track implementation, frontend behavior, retention, commit, or push occurred.

P06.1 is complete. P06.2 continues the same database boundary below; P06.3 simplification, P06.4 publication, and P06.5 job concurrency remain unstarted at this checkpoint.

## P06.2 — revision-bound summary metrics and accepted chains

Implemented:

- `app_private.calculate_run_summary(...)` reads the exact `ingested_revision <= source_revision` point set and reuses the P06.1 edge evaluator for every neighboring seq-ordered pair;
- distance and observed duration sum accepted edges only; quality output has the exact public `QualityStats` keys, with per-point poor-accuracy counting and stable primary-reason edge counters;
- accepted-point count is the unique set of endpoints participating in accepted edges. Rejections split ordered chains, isolated points produce no fake line, and zero accepted edges return zero metrics plus `insufficientData=true`;
- unsimplified accepted chains are returned as a nullable WGS84 `MultiLineString` for P06.3. The function is `STABLE SECURITY DEFINER`, executable only by maintenance, and does not broaden that role's direct table access. ADR-0013 records these semantics.

Verification evidence on 2026-09-26:

- focused P06.1/P06.2 real-PostGIS integration passed 2 files / 17 tests, including empty/isolated input, independently bounded equatorial distance, all quality categories, multiple chains, late lower-seq revision rebinding, delivery-time independence, invalid version/revision, and role privileges;
- the disposable `running_tracker_test` database was rebuilt after the new migration changed during verification; migrations `0000`–`0009` then applied from empty history and a second migration run skipped every unchanged file;
- full real-role/PostGIS integration passed 13 files / 140 tests;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 48 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- no `run_summaries` write/publication, geometry simplification or antimeridian normalization, organization/run locking, scheduler/concurrency, public HTTP contract, frontend behavior, commit, push, or hosted CI occurred.

P06 remains IN PROGRESS. P06.3 continues the geometry pipeline below; P06.4 publication and P06.5 job concurrency remain unstarted at this checkpoint.

## P06.3 — global metric display-geometry simplification

Implemented:

- `app_private.simplify_display_geometry(...)` is a pure version-bound capability executable only by the maintenance role; it accepts P06.2 accepted chains and returns only display geometry, leaving pre-simplification metrics and quality counters unchanged;
- every chain receives a cumulative spheroidal-distance M measure and is partitioned into at-most-20-km pieces with the exact same boundary point in adjacent pieces;
- each piece is simplified with a 5 metre Douglas–Peucker tolerance in its own WGS84 azimuthal-equidistant projection, preserving endpoints and material turns without using Web Mercator or degree-based tolerance;
- longitudes are unwrapped continuously, split at every crossed `180 + 360k` boundary, and translated back into `[-180, 180]`. Greenwich remains continuous, while ordinary and polar antimeridian crossings become local components with coincident `180`/`-180` endpoints;
- zero-length display pieces are omitted and an entirely display-degenerate result is `NULL`. Separate accepted chains and metric partition boundaries are not merged. ADR-0014 records these semantics.

Verification evidence on 2026-09-26:

- focused P06.3 real-PostGIS integration passed 1 file / 6 tests; combined P06.1–P06.3 integration passed 3 files / 23 tests;
- migration `0010_simplify_display_geometry.sql` applied to the disposable test database after a clean preflight, and the second migration run skipped the unchanged full history;
- full real-role/PostGIS integration passed 14 files / 146 tests;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 48 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- no `run_summaries` write/publication, summary-quality constraint change, organization/run locking, scheduler/concurrency, public HTTP contract, frontend behavior, commit, push, or hosted CI occurred.

P06.3 completed the calculation pipeline; the P06.4 continuation below adds revision-checked atomic publication. P06.5 job concurrency remains separate.

## P06.4 — revision-checked atomic summary publication

Implemented:

- `app_private.find_stale_run_summaries(limit)` exposes only finished, raw-available runs with a missing, revision-stale, algorithm-stale, or invalid-current summary to the maintenance role;
- the periodic worker processes one candidate per configurable cycle and calculates plus simplifies it in one materialized statement snapshot without holding a run mutation lock;
- `app_private.publish_run_summary(...)` locks organization before run, then rechecks existence, finished/raw state, exact `data_revision`, tombstone absence, and whether another worker already published the same revision/version;
- successful publication upserts `run_summaries` and increments `organizations.archive_revision` atomically. Stale, deleted, or duplicate results make neither change;
- the publication capability enforces the exact v1 `QualityStats` key/type/count contract while the table retains its version-agnostic object check. Maintenance has no direct table DML; ADR-0015 records the transaction and privilege boundary;
- `RUN_SUMMARY_INTERVAL_MS` defaults to 60 seconds. Both periodic tasks stop before maintenance-pool shutdown.

Verification evidence on 2026-09-26:

- focused API unit tests passed 2 files / 10 tests, including non-overlapping periodic execution and publication result validation;
- focused P06.4 real-PostGIS integration passed 1 file / 6 tests, including candidate filters, role grants, quality rejection, end-to-end geometry publication, revision race while waiting on the run lock, deletion, and concurrent duplicate publication;
- the disposable `running_tracker_test` database alone was rebuilt after the draft migration checksum changed; migrations `0000`–`0011` applied from empty history and the immediate rerun skipped all unchanged files;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 52 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- full real-role/PostGIS integration passed 15 files / 152 tests;
- no public HTTP/OpenAPI/frontend change, multi-process work claiming, configurable concurrency, commit, push, hosted CI, or main-database migration occurred.

P06.4 completed atomic publication; the P06.5 continuation below adds bounded distributed work coordination.

## P06.5 — bounded distributed summary workers

Implemented:

- `app_private.claim_stale_run_summary(scanLimit)` walks the stable stale-candidate order, takes one transaction-scoped advisory claim keyed by organization/run, and skips candidates already owned by another process;
- each worker holds the claim through calculation/publication without taking organization/run row locks during calculation. Publication keeps the existing organization → run lock order and revision/state/tombstone correctness checks;
- `RUN_SUMMARY_CONCURRENCY` defaults to 2 and is bounded to 1–8. A periodic cycle starts exactly that many workers, waits for every worker to settle, and only then permits the next cycle;
- one failed worker does not cancel siblings. Commit/rollback releases claims automatically, unknown commit outcomes destroy the connection, and the maintenance pool has `concurrency + 1` capacity so auto-finish is not structurally excluded;
- ADR-0016 records the coordination, failure, collision, and aggregate deployment-concurrency trade-offs.

Verification evidence on 2026-09-27:

- focused API unit tests passed 3 files / 29 tests, covering configuration bounds, transactional cleanup, exact worker fan-out, aggregation, all-settled failures, and the shared non-overlapping scheduler;
- focused P06.5 real-PostGIS integration passed 1 file / 8 tests, including least-privilege claims, distinct simultaneous claims, exhaustion, rollback release, bounded two-worker publication, revision races, deletion, and duplicate publication;
- migration `0012_claim_run_summary_jobs.sql` applied to the disposable `running_tracker_test` database after unchanged `0000`–`0011`; the immediate rerun skipped the complete unchanged history;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 55 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- full real-role/PostGIS integration passed 15 files / 154 tests;
- no public HTTP/OpenAPI/frontend behavior, P07 implementation, main-database migration, hosted CI, or explicit commit/push was part of this stage.

P06 is DONE. The next planned fragment is P07.1: an initial live-track snapshot at a fixed revision with bigint-sequence pagination. P07.2–P07.5, SSE, archive maps, retention, and production identity remain unopened.

## P07.1 — revision-fixed initial live-track snapshot

Implemented:

- `GET /api/orgs/{orgId}/runs/{runId}/live-track` fixes `toRevision` from the run and reads the first bounded page in one PostgreSQL statement snapshot. Continuation pages use immutable `ingested_revision <= toRevision` plus bigint `seq` keyset ordering, without holding a database transaction between HTTP requests;
- the temporary P07.1 cursor carries snapshot operation, organization, run, revision, algorithm version, and last sequence. It rejects malformed/foreign/future-revision or algorithm-mismatched continuations. Signing, user binding, and ten-minute expiry remain P07.4 scope;
- every page rechecks session, active membership, current live/history authorization, and `raw_state`. Active runs require ownership or `can_read_live`; finished runs require ownership or `can_read_history`; unauthorized objects remain hidden before retention state is exposed;
- the response uses the existing strict `TrackPage` contract, keeps PostgreSQL bigint revisions/sequences as decimal strings, and caps pages at 1,000. Until P07.3 evaluates edges on the same revision-bound set, `predecessorSeq` and `connectFromPrevious` are explicitly `null` and `false`;
- ADR-0017 records the fixed-revision statement/pagination boundary and the deliberately deferred change, edge, cursor-signing, and client-application work.

Verification evidence on 2026-09-27:

- focused P07.1 real-PostgreSQL integration passed 1 file / 7 tests, including a new late point between pages, a fresh newer snapshot, empty snapshots, sequences above JavaScript's safe-integer range, the 1,000-point default bound, active/finished ACL selection, authorization-before-retention ordering, foreign cursors, and strict query limits;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 55 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- full real-role/PostGIS integration passed 16 files / 161 tests;
- `git diff --check` passed; no migration, database privilege change, changes endpoint, edge evaluation, cursor signature/expiry, frontend synchronization, SSE, commit, push, hosted CI, or paid-provider call occurred.

P07 remains IN PROGRESS. The next planned fragment is P07.2: revision-window change pages containing new points plus their immediate successors at fixed target revision T. P07.3–P07.5, SSE, archive maps, retention, and production identity remain unopened.

## P07.2 — revision-window live-track changes

Implemented:

- `GET /api/orgs/{orgId}/runs/{runId}/live-track/changes` accepts exactly one of `afterRevision=A` or a continuation cursor and fixes the first request's current run revision as T in the same PostgreSQL statement that selects the page;
- the query materializes points ingested in `(A,T]`, unions each point's immediate successor from the point set at T, deduplicates the result, and keyset-paginates it in bigint `seq` order. Consecutive and disjoint insertions therefore update the exact future edge inputs needed after a late insertion;
- cursors retain operation, organization, run, A/T, algorithm version, and last sequence. Immutable point rows plus `ingested_revision <= T` keep later ingestion out without retaining a transaction between HTTP requests;
- every page rechecks session, active membership, current live/history authorization, and raw availability. Future source revisions, malformed/foreign/operation-mismatched cursors, and invalid query combinations fail closed;
- the existing strict `TrackPage` contract and OpenAPI route are used unchanged. P07.2 deliberately keeps `predecessorSeq=null` and `connectFromPrevious=false`; P07.3 will calculate those fields with the shared evaluator. ADR-0018 records this boundary.

Verification evidence on 2026-09-27:

- focused P07.2 real-runtime-role integration passed 1 file / 8 tests, covering new points plus immediate successors, consecutive/disjoint deduplication, fixed A/T under later ingestion, deterministic retry, empty windows, bigint cursor ordering, snapshot-plus-changes set equivalence, current ACL/raw-state checks, and invalid cursors/queries;
- `npm run db:bootstrap:test` succeeded and `npm run db:migrate:test` checksum-verified and skipped unchanged migrations `0000`–`0012`;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 55 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- full real-role/PostGIS integration passed 17 files / 169 tests;
- no migration, database privilege change, public contract shape, edge evaluation, signed/user-bound/expiring cursor, frontend synchronization, SSE, push, hosted CI, or paid-provider call occurred.

P07 remains IN PROGRESS. The next planned fragment is P07.3: compute `predecessorSeq` and `connectFromPrevious` against the same revision-bound point set T. P07.4–P07.5, SSE, archive maps, retention, and production identity remain unopened.

## P07.3 — revision-bound live-track edge annotations

Implemented:

- both initial snapshot and revision-window change queries materialize the complete `ingested_revision <= T` point set and derive the immediate seq-ordered predecessor before keyset page filtering;
- the first point on a continuation page therefore retains a predecessor from an earlier page. `predecessorSeq` identifies that point even when the edge is rejected, while only the first point in the fixed-revision set has no predecessor;
- both endpoints invoke the existing immutable `app_private.evaluate_track_edge(...)` capability. `connectFromPrevious` now uses the same versioned sequence, segment, accuracy, time, geodesic-distance, and speed rules as summary calculation;
- change-page repair selection, predecessor derivation, and edge evaluation use the same materialized T-bound set, so later ingestion cannot perturb annotations in an older pagination sequence;
- the existing strict `TrackPage` contract, OpenAPI artifact, HTTP routes, RLS boundary, and database grants are unchanged. ADR-0019 records the page-boundary and fixed-revision semantics.

Verification evidence on 2026-09-27:

- focused P07.1/P07.2/P07.3 real-runtime-role integration passed 2 files / 17 tests, including accepted and rejected edges, snapshot predecessors across pages, late-insertion repair of both accepted edges across change pages, and fixed-T predecessor behavior under newer ingestion;
- `npm run db:bootstrap:test` succeeded and `npm run db:migrate:test` checksum-verified and skipped unchanged migrations `0000`–`0012`;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 55 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- full real-role/PostGIS integration passed 17 files / 171 tests;
- no migration, database privilege change, public contract shape, cursor signing/user binding/expiry, frontend synchronization, SSE, commit, push, hosted CI, or paid-provider call occurred.

P07 remains IN PROGRESS. The next planned fragment is P07.4: signed, user-bound, expiring cursors for snapshot and changes. P07.5, SSE, archive maps, retention, and production identity remain unopened.

## P07.4 — signed, identity-bound live-track cursors

Implemented:

- snapshot and changes continuations now use a strict versioned `payload.signature` envelope with HMAC-SHA-256 over the exact base64url payload and constant-time signature comparison before payload parsing;
- signed state includes authenticated user, organization, run, operation, algorithm version, fixed target revision, last bigint sequence, and expiry; changes additionally retain the source revision with `A <= T` validation;
- decode binds the token to the current user and route, rejects snapshot/changes interchange, and maps all signature, shape, binding, and expiry failures to `400 INVALID_CURSOR` without weakening the existing per-request session, membership, ACL, raw-state, algorithm, or revision checks;
- the first continuation receives one absolute ten-minute deadline, which all later pages preserve rather than refresh;
- `LIVE_TRACK_CURSOR_SIGNING_KEY` must be canonical unpadded base64url with at least 32 decoded bytes. Development/test have an explicit documented local fixture; production rejects that value and requires deployment-specific material;
- ADR-0020 records the envelope, fixed-chain expiry, key boundary, and deliberate non-expansion to run-list/raw-history cursors or P07.5 browser state.

Verification evidence on 2026-09-27:

- focused cursor/config unit coverage passed 2 files / 22 tests for signed round trips, identity/route/operation binding, payload/signature/key tampering, exact expiry, fixed chain deadline, and production key validation;
- focused P07 real-runtime-role integration passed 2 files / 17 tests, including signed pagination, tamper and cross-user rejection, fixed revisions/edges, and current ACL/raw-state rechecks;
- `npm run db:bootstrap:test` succeeded and `npm run db:migrate:test` checksum-verified and skipped unchanged migrations `0000`–`0012`;
- full `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 60 API unit tests, 45 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- full real-role/PostGIS integration passed 17 files / 171 tests; `git diff --check` passed after final documentation updates;
- no migration, database privilege, public response schema, dependency, frontend synchronization, SSE, commit, push, hosted CI, paid-provider call, or main/production database write occurred.

P07 remains IN PROGRESS. The next planned fragment is P07.5: atomically apply snapshot/change upserts in the browser and advance the local revision only after every page succeeds. SSE, archive maps, retention, and production identity remain unopened.

## P07.5 — atomic browser live-track application

Implemented:

- browser HTTP helpers validate the shared `TrackPage` contract for snapshot and changes endpoints while preserving exact signed continuation cursors;
- `LiveTrackStore` scopes committed state and one in-flight synchronization by authenticated user, organization, and run. A snapshot starts from an empty temporary map; changes clone the last committed map;
- every page chain must retain operation-appropriate source revision, target revision, algorithm version, strict seq order, and acyclic cursor progress. Upserts remain private until the terminal page, when points and revision are replaced together;
- repeated seq-keyed upserts are idempotent. Concurrent calls for one run share the same synchronization and merge revision notifications to the highest target observed during loading;
- an algorithm change or `INVALID_CURSOR` during changes discards staged data and starts a fresh snapshot. One expired snapshot continuation may restart once; other transport, authorization, retention, or protocol failures leave the prior committed state unchanged;
- ADR-0021 records the atomicity, single-flight, identity isolation, recovery, and in-memory lifetime boundaries.

Verification evidence on 2026-09-27:

- focused HTTP/store unit coverage passed 2 files / 14 tests, covering canonical URLs, atomic multi-page commit, failure rollback, late-point successor repair, idempotent replay, algorithm and cursor recovery, target coalescing, and cross-user isolation;
- the complete web suite passed 10 files / 53 tests; strict web typechecking and lint passed;
- `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 60 API unit tests, 53 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- the disposable test database bootstrap succeeded, migrations `0000`–`0012` checksum-verified unchanged, and focused P07 real-runtime-role/PostGIS integration passed 2 files / 17 tests;
- no migration, database privilege, public response schema, dependency, SSE transport, coach UI, map rendering, commit, push, hosted CI, paid-provider call, or main/production database write occurred.

P07 is DONE. The next planned fragment is P08.1: one bounded SSE organization/tab connection with initial state, a shared two-second polling cycle, heartbeat, and backpressure policy. P08.2–P08.5, archive maps, retention, load verification, and production identity remain unopened.

## P08.1 — bounded shared SSE transport

Implemented:

- authenticated `GET /api/orgs/:orgId/live` requires an explicit event-stream Accept value, validates membership through the existing tenant boundary, emits a strict `live.state` sequence zero immediately, and keeps session tokens out of URLs;
- the runtime-role/PostGIS live-state query returns only authorized active runs, revisions, and latest positions. It reuses the versioned edge evaluator for `confirmed`, retains usable isolated/discontinuous points as `unconfirmed`, and returns null for unusable latest accuracy/time/speed;
- one process-level non-overlapping two-second scheduler groups equal user/organization subscriptions, applies bounded poll concurrency, and releases every short tenant transaction before writing to long-lived responses;
- each connection has an independent UUID stream and sequence domain. A shared 15-second heartbeat uses SSE comments and does not advance application sequence;
- backpressure stores only the newest subsequent state per connection, replaces older pending state, flushes on drain, and closes a persistently blocked writer after a configurable deadline. Open plus opening connections share a hard cap;
- graceful shutdown stops the live hub and ends streams before the runtime pool closes. ADR-0022 records the transport, database, queue, and lifecycle boundaries.

Verification evidence on 2026-09-27:

- focused SSE unit/route coverage passed 1 file / 5 tests, including immediate framing/headers, shared polling, per-stream sequence, sequence-neutral heartbeat, latest-only pending replacement, timeout closure, connection cap, authentication, and Accept validation;
- `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 66 API unit tests, 53 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- disposable database bootstrap succeeded, migrations `0000`–`0012` checksum-verified unchanged, focused real runtime-role/PostGIS integration passed 1 file / 5 tests, and the full integration suite passed 18 files / 176 tests. Coverage includes ACL-filtered active state, evaluator-bound confirmed/unconfirmed/null position quality, a later committed revision on a fresh read, empty state, and an actual immediate SSE HTTP frame;
- no migration, database privilege, shared response schema, dependency, frontend coach UI, P08.2 live-session revalidation, proxy configuration, commit, push, hosted CI, paid-provider call, or main/production database write occurred.

P08 remains IN PROGRESS. The next planned fragment is P08.2: revalidate session expiry/revocation, membership, and grants on an open connection; remove inaccessible runs and cancel stale pending state before it can be written. P08.3–P08.5, archive maps, retention, load verification, and production identity remain unopened.

## P08.2 — live authorization revalidation

Implemented:

- each open stream retains only the authenticated session digest, expiry, and user identity. The raw cookie token is not copied into the hub, and matching user/organization tabs still share one database read while session validity remains connection-specific;
- session validity is checked before and after the initial database snapshot, before each shared poll, before publish/drain/heartbeat, and by an exact expiry timer. Expiry or store revocation closes only that stream without a terminal data event;
- each successful poll still performs the active-membership check and RLS-filtered live-state read in one short runtime-role transaction. Membership denial closes all matching user/organization streams and clears pending state; transient infrastructure failures remain reconnectable transport failures rather than authorization decisions;
- a live-grant change produces a complete filtered state. For a blocked writer this state replaces the older pending state, so an authorization change discovered by the latest completed poll cannot later flush superseded run data;
- ADR-0023 fixes the authorization checkpoint: rights are those visible to the live-state statement snapshot inside the latest completed poll transaction. A revocation committed after that snapshot is observed by the next poll; bytes already accepted by the transport cannot be recalled. The stream part of D07 is resolved, while P09 still owns cache invalidation.

Verification evidence on 2026-09-27:

- focused session/SSE unit coverage passed 2 files / 17 tests, including revocation isolation across two sessions for one user, initial-read revocation, exact expiry, membership-denial cancellation, grant-filtered pending replacement, and session-store active checks;
- `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 72 API unit tests, 53 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- `npm run db:migrate:test` checksum-verified migrations `0000`–`0012` unchanged; focused real runtime-role/PostGIS integration passed 1 file / 6 tests, and the full integration suite passed 18 files / 177 tests;
- no migration, database privilege, shared response schema, dependency, frontend coach UI, P08.3 synchronization/UI work, proxy configuration, commit, push, hosted CI, paid-provider call, or main/production database write occurred.

P08 remains IN PROGRESS. The next planned fragment is P08.3: implement the coach screen for authorized active runs with confirmed, unconfirmed, and stale marker states plus explicit selected-track state. P08.4–P08.5, archive maps, retention, load verification, and production identity remain unopened.

## P08.3 — coach live-state screen

Implemented:

- the application now switches between runner and coach views while retaining the existing runner lifecycle. The coach view opens one same-origin stream only after session discovery and organization UUID validation;
- every `live.state` is parsed with the shared strict contract and atomically replaces the authorized active-run set. Non-increasing sequence values are ignored within one stream, while a new `streamId` starts a fresh ordering domain;
- confirmed/unconfirmed remain server edge-quality results. Browser freshness uses event `serverTime` plus monotonic elapsed time and marks a current position stale at the initial 10-second threshold even if the stream remains connected;
- `position=null` may retain the prior coordinate only as an explicitly stale last-known marker. A run omitted from the next full state loses current/last-known coordinates and track selection immediately;
- selected tracks are an explicit authorized run-ID set ready for P08.4. This slice does not fetch geometry, instantiate Mapbox, or require an external token;
- transport or contract failure closes native EventSource retry, clears all sensitive coach state, and offers explicit reconnect. ADR-0024 records the availability/security trade-off and leaves session-aware automatic reconnect plus selected-track revision recovery to P08.4.

Verification evidence on 2026-09-27:

- focused web typechecking passed and the web suite passed 13 files / 62 tests, including confirmed/unconfirmed/stale classification, server-relative time-driven staleness, null-position last-known behavior, run/removal selection cleanup, per-stream ordering, exact SSE URL, strict event parsing, fail-closed disconnect, and static coach-screen structure;
- `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 72 API unit tests, 62 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- Docker PostGIS remained healthy; with tracked local-only configuration loaded process-locally, `npm run db:migrate:test` checksum-verified migrations `0000`–`0012` unchanged and the complete real-role/PostGIS integration suite passed 18 files / 177 tests;
- the first integration invocation failed closed before any database work because its shell lacked `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL`; the configured rerun above is the verification result. No migration, database privilege, shared schema, dependency, commit, push, hosted CI, paid-provider call, or main/production database write occurred.

P08 remains IN PROGRESS. The next planned fragment is P08.4: bind the explicit selected-run set to `LiveTrackStore`, coalesce SSE revision targets, cancel removed/revoked work, and recover state after reconnect without partial track application. P08.5 proxy/deployment transport configuration, archive maps, retention, load verification, and production identity remain unopened.

## P08.4 — selected-track revision synchronization and reconnect recovery

Implemented:

- the coach's explicit authorized selection now drives a scoped `SelectedTrackSynchronizer` over the P07.5 atomic `LiveTrackStore`; no second page-application algorithm was introduced;
- each run retains one in-flight snapshot/change chain while repeated SSE notifications coalesce to the greatest requested `dataRevision`. The UI exposes loading/error state and only terminal-page committed point counts/revisions;
- live-track HTTP reads accept abort signals. Deselect, authorized full-state omission/revoke, identity/organization change, stream loss, and component disposal abort active reads and evict committed in-memory geometry; stale completions cannot republish into a removed coordinator entry;
- an announced algorithm-version change evicts equal-revision cached geometry and starts a fresh snapshot;
- transport loss immediately hides marker, selected, and geometry state. For the same mounted session/organization only selected run-ID intent survives; a new full state intersects it with the newly authorized run set before restoring selection and loading a fresh snapshot;
- native EventSource retry remains disabled. Recoverable transport failures use bounded 1/2/4-second application retries, stop before known session expiry, and retain explicit manual retry. Contract-invalid events fail closed without automatic retry. ADR-0025 records these boundaries.

Verification evidence on 2026-09-27:

- focused P07/P08 web coverage passed 5 files / 23 tests for atomic store behavior, abortable eviction, greatest-revision coalescing, authorization removal, algorithm replacement, reconnect selection reauthorization, retry bounds/session expiry, strict SSE parsing, and coach structure;
- `npm run verify` passed lint, strict workspace typechecking, 8 migration-history tests, 72 API unit tests, 69 web tests, 13 contract tests, 14 fixture tests, 3 simulator CLI tests, and all production builds;
- Docker PostGIS was healthy; process-local `.env.example` configuration was used, `npm run db:migrate:test` checksum-verified migrations `0000`–`0012` unchanged, and the complete real-role/PostGIS integration suite passed 18 files / 177 tests;
- `git diff --check` passed. No migration, database privilege, shared response schema, dependency, proxy configuration, map provider, commit, push, hosted CI, paid-provider call, or main/production database write occurred.

P08 remains IN PROGRESS. The next planned fragment is P08.5: configure and verify the external proxy profile for disabled response buffering, bounded upstream timeouts, and browser-to-proxy HTTP/2 without changing the application SSE protocol. Archive maps, retention, load verification, and production identity remain unopened.

## P08.5 — HTTPS/HTTP/2 reverse-proxy transport profile

Implemented:

- a pinned Nginx image serves the built React application over local TLS/HTTP/2 and forwards `/api/*` to a pinned Node/Express container over HTTP/1.1. Only loopback TLS port 8443 is published; the API remains internal to the Compose network and unknown TLS host names are rejected;
- the live location disables request/response proxy buffering, cache, gzip/upstream compression, and upstream retry. It uses empty upstream `Connection`, correct `Host`/`X-Forwarded-*`, a 75-second read timeout, bounded 30-second send timeouts, and passes the application's `X-Accel-Buffering: no` header;
- the ordinary API retains conventional proxy behavior and its application 64 KiB JSON limit, with an explicit 128 KiB edge ceiling. Existing SSE hub connection/poll/backpressure bounds are unchanged;
- a Compose overlay targets the disposable test database and preserves the same-origin Secure/HttpOnly session design. API port 3000 is not host-published;
- `transport:tls` creates a seven-day self-signed localhost certificate in gitignored `.local/tls` by using OpenSSL inside the pinned proxy image. No production key or secret is tracked;
- `transport:verify` performs real ALPN/HTTP/2, web/API, cookie-authenticated SSE, framing/header, heartbeat, PostgreSQL activity, revision propagation, backend restart/disconnect, and fresh-stream checks. ADR-0026 records the protocol, timeout, security, and production/non-production boundaries.

Verification evidence on 2026-09-28:

- `npm run transport:verify` passed against the real Nginx → Express → PostgreSQL profile: ALPN was `h2`, API health was 200, an unconfigured authority was rejected, the initial `live.state` arrived in 40 ms, `Content-Type` was `text/event-stream; charset=utf-8`, cache policy was `private, no-store`, `X-Accel-Buffering` was `no`, and no content encoding was applied;
- the stream remained healthy through the 15-second heartbeat and eight database commit/poll cycles. PostgreSQL `pg_stat_activity` showed one idle `running-tracker-api` connection and zero `idle in transaction` connections while SSE remained open;
- eight local direct commit-to-proxied-state samples measured p50 1981 ms and p95 2040 ms (values 1988, 2040, 1998, 1981, 1961, 1967, 1968, 2001 ms). The heartbeat arrived at 15042 ms and the stream remained open for 78699 ms—beyond the configured 75-second proxy read timeout—before the deliberate restart. This small Windows/Docker Desktop loopback sample measures the configured two-second poll path and is preliminary only; P11 retains final load/performance validation;
- restarting the API under the open response caused a transport disconnect. After readiness recovered, a new Secure-cookie session opened a stream with sequence zero and a different `streamId`; no replay or corrupted frame was observed;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 72 API tests, 69 web tests, 13 contract tests, 14 fixture tests, 3 simulator tests, and every production build. The complete real-role/PostGIS suite passed 18 files / 177 tests;
- the first unconfigured test attempts exposed and then fixed three harness/profile defects: a wrong simulator workspace path in the Dockerfiles, HTTP/2 request-side end handling, and explicit PostgreSQL bigint parameter casts. The successful rerun above is the acceptance evidence;
- local test bootstrap and migration checksum verification for `0000`–`0012` passed. No migration, database privilege, application auth semantics, WebSocket, durable replay, map work, commit, push, production database write, or production secret occurred.

P08 is DONE. The exact next planned fragment is P09.1: define and implement archive metadata and tile endpoints with XYZ/period validation and history ACL. P09.2+, retention, final load verification, and production identity remain unopened.

## P09.1 — archive metadata and tile authorization boundary

Implemented:

- authenticated `GET /api/orgs/:orgId/archive/metadata` reads the current organization `archive_revision` inside the runtime-role tenant transaction and returns the exact validated filter, source layer `runs`, zoom 8–16, and a concrete revision-bound tile URL template;
- both metadata and tile responses are private and non-cacheable at the HTTP layer. Archive periods are ordered half-open UTC ranges capped at 366 days; tile path values are canonical decimal integers with zoom 8–16 and `0 <= x,y < 2^z`;
- every tile request checks active organization membership and the current archive revision before invoking its pipeline. A stale value returns `409 ARCHIVE_REVISION_CHANGED` without starting generation;
- the tile pipeline receives the same runtime-role client and tenant transaction, so reads of `run_summaries` retain the existing owner/history-grant RLS policy. URL revision and period values never grant access;
- until P09.2 installs the PostGIS candidate/projection/clipping/MVT implementation, the production pipeline fails closed with `503 TILE_BUSY`; it does not return a false empty or truncated tile. ADR-0027 records this staged boundary.

Verification evidence on 2026-09-28:

- focused shared-contract coverage passed 1 file / 14 tests, including zoom, coordinate, canonical-integer, revision, order, and exact 366-day boundary cases;
- focused real runtime-role/PostGIS integration passed 1 file / 5 tests for metadata, private headers/template, history-grantee versus unrelated-member RLS visibility, revision mismatch ordering, validation, session, and active membership;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 73 API tests, 69 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- `npm run db:migrate:test` checksum-verified migrations `0000`–`0012` unchanged, and the complete real-role/PostGIS suite passed 19 files / 182 tests;
- the generated OpenAPI 3.1 artifact includes zoom 8–16 and XYZ bounds documentation;
- no migration, database privilege, dependency, spatial selection/projection/clipping, MVT generation, tile cache, frontend map, commit, push, hosted CI, production database write, or external map-provider call occurred.

P09 remains IN PROGRESS. The exact next planned fragment is P09.2: implement the indexed PostGIS candidate selection, Web Mercator projection, buffer/clipping, and MVT encoding with string `run_id`. P09.3 cache, P09.4 cache-hit invalidation, P09.5 archive UI, P09.6 resource limits, retention, final load verification, and production identity remain unopened.

## P09.2 — PostGIS archive MVT pipeline

Implemented:

- the production tile seam now executes one parameterized PostGIS statement on the existing runtime-role client. It selects only RLS-visible finished summaries in the validated half-open period and exposes only a string `run_id` plus geometry in source layer `runs`;
- normal and antimeridian candidate branches each retain an explicit GiST-compatible `display_geom && search envelope` predicate plus exact intersection. Edge tiles also select the opposite world edge and shift that copy by one Web Mercator world width after projection, avoiding PROJ longitude normalization and world-spanning lines;
- candidate geometry is clipped with `ST_ClipByBox2D` to the valid ±85.0511287798066° Web Mercator latitude range before EPSG:3857 projection. `ST_AsMVTGeom` receives the unexpanded tile bounds with extent 4096, buffer 64, and clipping enabled; selection uses the matching 64/4096 margin;
- duplicate normal/wrapped candidates are merged per run before encoding. Empty/degenerate non-line results are omitted, while no visible features produce the valid zero-byte empty MVT rather than an error or false partial result;
- a dependency-free test decoder verifies the actual protobuf layer, string property, line commands, and tile coordinates. ADR-0028 records the projection, clipping, antimeridian, privacy, and staged resource-limit boundaries.

Verification evidence on 2026-09-28:

- focused API unit coverage passed 1 file / 2 tests for the single parameterized spatial query and fail-closed database-result validation;
- focused real runtime-role/PostGIS coverage passed 1 file / 4 tests after decoding generated MVTs for adjacent buffered tiles, both antimeridian world edges, polar clipping, valid empty output, and history-grant exclusion;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 74 API unit tests, 69 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- `npm run db:migrate:test` checksum-verified migrations `0000`–`0012` unchanged, and the complete real-role/PostGIS suite passed 20 files / 186 tests;
- no migration, database privilege, shared HTTP schema, dependency, tile cache, cache-hit authorization path, frontend map, SQL/concurrency/queue/tile-byte guard, commit, push, hosted CI, production database write, or external map-provider call occurred.

P09 remains IN PROGRESS. The exact next planned fragment is P09.3: add the bounded byte-size LRU, five-minute TTL, single-flight generation, and the complete SDD cache key. P09.4 cache-hit membership/revision enforcement, P09.5 archive UI, P09.6 resource limits, retention, final load verification, and production identity remain unopened.

## P09.3 — bounded process archive tile cache

Implemented:

- each API process owns one injected/testable archive cache with a 32 MiB binary payload budget, five-minute monotonic TTL, and true access-order LRU eviction. A separate 4096-entry ceiling bounds metadata even when every cached tile is the valid zero-byte empty MVT;
- the complete SDD identity is `formatVersion / orgId / userId / archiveRevision / canonicalFilterHash / z/x/y`. UUIDs are lowercased, revision strings are canonicalized through `BigInt`, semantically empty trailing fractional timestamp zeros are removed without discarding higher precision, and the ordered period is represented by a SHA-256 hash;
- successful buffers, including empty tiles, are cached. A buffer larger than the cache capacity is returned without retention; generation failures and invalid non-buffer results are never cached;
- an in-flight promise map coalesces concurrent generation only for an identical authenticated key and removes the flight on either success or failure. Different users never share generated bytes;
- the existing route still completes session authentication, active-membership verification, and current archive-revision comparison inside the runtime-role tenant transaction before calling the cache. P09.4 retains atomic write-side epoch changes and cache-hit race verification; P09.3 does not claim those later guarantees.

Verification evidence on 2026-09-28:

- focused API unit coverage passed 2 files / 8 tests for full key identity/canonicalization, byte and entry bounds, access-order eviction, exact TTL expiry, empty/oversize/failure behavior, single-flight cleanup, and the P09.2 pipeline contract;
- focused runtime-role/PostGIS archive HTTP integration passed 1 file / 6 tests, including canonical same-user cache reuse and isolation for another authenticated user after the membership/revision boundary;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 80 API unit tests, 69 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- `npm run db:migrate:test` checksum-verified migrations `0000`–`0012` unchanged, and the complete runtime-role/PostGIS suite passed 20 files / 187 tests;
- no migration, database privilege, dependency, shared HTTP schema, public/CDN cache, write-side archive epoch change, frontend map, SQL/concurrency/queue/tile-byte guard, commit, push, hosted CI, production database write, or external provider call occurred.

P09 remains IN PROGRESS. The exact next planned fragment is P09.4: prove membership/revision validation before cache hits and make publish/delete/grant/membership changes advance the organization epoch atomically. P09.5 archive UI, P09.6 resource limits, retention, final load verification, and production identity remain unopened.

## P09.4 — atomic archive cache invalidation boundary

Implemented:

- tile transactions now call an owner-defined capability that takes the organization row `FOR SHARE`, rechecks active membership after acquiring the lock, returns the locked current archive revision, and only then permits process-cache lookup. The lock remains held through the cache result and tenant-transaction commit;
- existing summary publication retains its organization-first atomic epoch increment. Forward migration `0013_archive_cache_invalidation.sql` adds same-transaction revision triggers for published-summary deletion, effective history-grant changes, and active-membership revocation/restoration/deletion;
- history-share changes advance the epoch only when a published summary can affect archive output. Live-only changes do not churn archive URLs, and publication supplies the epoch change when a summary did not yet exist;
- runtime share mutation takes the organization row `FOR UPDATE` before run ownership/read locks. Concurrent share writers serialize on the organization and keep the existing organization-before-run publication lock order;
- rollback removes both the ACL mutation and its epoch advance. Old entries require no cross-process deletion because revision remains in the complete cache key and P09.3 TTL/LRU bounds reclaim unreachable values. ADR-0030 records the authorization ordering point and availability trade-off.

Verification evidence on 2026-09-28:

- focused API archive-cache/pipeline unit coverage passed 2 files / 8 tests; focused runtime-role/PostgreSQL coverage passed 3 files / 26 tests for archive HTTP/cache invalidation, concurrent share mutations, and revision-checked summary publication;
- cache-hit race harnesses proved both orderings: a membership revocation could not commit while a cached response held the shared organization lock, and a tile already past its initial membership check waited behind an epoch writer, rechecked the committed inactive membership, and never entered the cache;
- grant integration proved stale revision URLs return `409` before cache access, history-grant changes increment the epoch, live-only changes do not, and transaction rollback restores both grant and revision. Summary deletion and membership deactivation each advanced the same organization epoch;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 80 API unit tests, 69 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- migration `0013` applied to both documented local databases; immediate reruns checksum-verified `0000`–`0013` unchanged. The complete real runtime-role/PostGIS suite passed 20 files / 190 tests;
- no dependency, shared HTTP schema, frontend map, SQL/concurrency/queue/tile-byte limit, retention/delete endpoint, commit, push, hosted CI, production database write, or external provider call occurred.

P09 remains IN PROGRESS. The exact next planned fragment is P09.5: implement the React archive source, 30-second metadata polling, focus refresh, revision replacement, error handling, and sensitive-layer cleanup after access loss. P09.6 resource limits, retention, final load verification, and production identity remain unopened.

## P09.5 — React archive source and refresh lifecycle

Implemented:

- the application now exposes an archive view with a bounded half-open UTC period and strict shared-contract metadata loading. The source scope includes authenticated user, organization, and period; changing scope or unmounting aborts the old request and prevents stale metadata from remaining attached;
- one controller owns the initial read, fixed 30-second poll, immediate focus/visible-tab refresh, and manual/409 refresh. It permits one in-flight request and coalesces concurrent refresh intent instead of growing a request queue;
- a successful revision change updates the existing Mapbox vector source through `setTiles`. Source-layer or zoom-shape changes rebuild only the archive source/layer; identical metadata preserves the existing source and visible tile state;
- HTTP 401/403 from metadata or the archive tile source clears metadata and removes the archive line layer before its source. Transient network/5xx failures preserve the last successfully authorized layer but expose an explicit error and retry path;
- Mapbox GL JS 3.31.0 is exact-pinned and loaded as a separate browser chunk. The real map is instantiated only when the public `VITE_MAPBOX_ACCESS_TOKEN` is configured; controller, source-adapter, and React tests remain tokenless and make no external provider call. ADR-0031 records the cleanup and availability trade-off.

Verification evidence on 2026-09-28:

- focused web coverage passed 5 files / 21 tests for canonical metadata HTTP, initial/poll/focus/409 refresh, coalescing, transient retention, 401/403 clearing, source creation, `setTiles`, removal order, and tokenless React structure;
- the complete web suite passed 17 files / 82 tests; web lint, strict typecheck, and the production Vite build passed. The build emitted the Mapbox runtime as a separate lazy chunk and reported its expected size warning;
- full `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 80 API unit tests, 82 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- as a combined-worktree regression check for the pre-existing P09.4 changes, `npm run db:migrate:test` checksum-skipped unchanged migrations `0000`–`0013` and the real separated-role PostgreSQL/PostGIS suite passed 20 files / 190 tests. P09.5 itself changes no database behavior;
- `npm audit` reported zero vulnerabilities after adding the exact dependency;
- no shared HTTP schema, API route, database behavior, SQL/concurrency/queue/tile-byte limit, retention/delete endpoint, commit, push, hosted CI, production database write, Mapbox token, or external provider call occurred in P09.5.

At the P09.5 checkpoint, P09 remained IN PROGRESS and P09.6 was the exact next planned fragment. The continuation below completes those resource limits.

## P09.6 — bounded archive tile resource usage

Implemented:

- tile handling now uses a two-phase admission boundary: one short authenticated transaction locks and validates the organization revision before the first cache probe, then every miss leaves the transaction and pool before waiting for generation capacity;
- a process-local deterministic scheduler admits at most two generation candidates and sixteen waiters. Request nineteen fails immediately with `503 TILE_BUSY`; completion and failure release one permit, and a queued disconnected request is removed when no same-key waiter remains;
- per-key single-flight sits outside the scheduler, so identical authenticated keys share one queue position and one SQL generator. After admission a fresh tenant transaction repeats membership/revision validation and the cache lookup, preserving ADR-0030 ordering and safely accepting a tile populated during the wait;
- the admitted transaction applies PostgreSQL `SET LOCAL statement_timeout = '2000ms'` before rendering. Only the matching PostgreSQL statement-timeout cancellation maps to `503 TILE_TIMEOUT`; rollback/release remains owned by the existing transaction helper;
- complete raw MVT buffers up to and including 1 MiB are accepted. Larger buffers return `422 TILE_TOO_COMPLEX` before cache insertion; empty tiles remain cacheable and no SQL feature `LIMIT` or buffer truncation was added;
- the SDD values remain explicit product constants rather than environment configuration. The default ten-client runtime pool retains capacity beyond the two active tile transactions; queued work holds no database resource. ADR-0032 records the lifecycle, authorization, single-flight, cancellation, and failure semantics.

Verification evidence on 2026-09-28:

- focused archive unit coverage passed 4 files / 14 tests, including exact 2-active/16-waiting admission, request nineteen, failure release, queued cancellation, no-client queue waiting, unrelated transaction capacity, same-key single-flight, empty/normal/exact-1-MiB/oversized results, retry after oversize, PostgreSQL timeout classification, and the absence of a feature `LIMIT`;
- focused real PostgreSQL/PostGIS archive coverage first passed 3 files / 16 tests for timeout/size limits plus P09.4 and geometry regressions; after adding the saturation proof, the focused resource-limit file passed 1 file / 4 tests. Together these cover a deliberate ten-second statement cancelled around the two-second bound, `503 TILE_TIMEOUT`, reusable pool state, saturated tile work with an available third pool client, request-nineteen `TILE_BUSY`, raw-size errors/cache exclusion, membership/revision/cache races, string `run_id`, adjacent/antimeridian/polar geometry, empty MVT, and `private, no-store`;
- `npm run db:migrate:test` checksum-skipped unchanged migrations `0000`–`0013`; P09.6 adds no migration or environment setting;
- full `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 86 API unit tests, 82 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- the complete separated-role PostgreSQL/PostGIS integration suite passed 21 files / 194 tests.

P09 is DONE. The exact next planned fragment is P10.1: implement the `available → purging → purged` retention state machine with bounded, restart-safe deletes. P10.2–P12 remain unopened.

## P10.1 — bounded restart-safe raw point purge

Implemented:

- forward-only migration `0014_raw_retention_purge.sql` adds a maintenance-only `SECURITY DEFINER` capability for one explicit finished run. It shares the P06 per-run summary advisory-lock namespace, locks the run row, changes `available` to `purging` before deletion, removes at most one deterministic `seq`-ordered batch, and changes to `purged` only after confirming that no points remain;
- the accepted limit range is 1–1,000 and the typed Node boundary always uses 1,000. There is no internal completion loop or candidate scanner. A committed partial batch remains `purging`; a new process resumes from remaining rows; rollback restores both rows and state; `purged` retries return a deterministic zero-delete completion;
- the summary claimant now revalidates finished/raw-available/revision/staleness state after acquiring its transaction advisory lock. An already-claimed summary completes before purge, while a committed `purging` run cannot enter production calculation. Existing publication checks still reject independently supplied partial/stale calculations;
- the runtime role's legacy column-level `UPDATE(raw_state)` grant is revoked. Runtime/PUBLIC cannot execute the purge function, maintenance has no direct application-table SELECT/UPDATE/DELETE, and the capability fixes `search_path` to `pg_catalog`;
- raw purge preserves the run, summary, display geometry/statistics, history grants, and `archive_revision`. Existing authorized ingestion/history/live snapshot/change paths return `410 RAW_HISTORY_UNAVAILABLE` as soon as `purging` commits; unauthorized callers retain the authorization-safe `404` boundary. ADR-0033 records the state, lock order, crash recovery, and deferred scope.

Verification evidence on 2026-09-29:

- focused maintenance unit coverage passed 1 file / 4 tests; focused separated-role PostgreSQL/PostGIS coverage passed 1 file / 6 tests, including 1,001-point bounding, new-client resume, rollback, idempotency, concurrent purge attempts, HTTP denial while one point physically remained, archive/grant survival, and unchanged archive revision;
- controlled advisory-lock barriers proved that a claimed three-point summary published completely before purge proceeded, while a partially purged run was not claimable and a direct partial calculation could not publish;
- only the disposable `running_tracker_test` database was rebuilt after the uncommitted migration changed, then migrations `0000`–`0014` applied from empty history. Main/production databases were not connected to or migrated;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 90 API unit tests, 82 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- the complete separated-role PostgreSQL/PostGIS integration suite passed 22 files / 200 tests, covering the new purge suite plus all ingestion, raw-history, live-track, summary, archive HTTP/MVT/cache, and role/RLS regressions. The immediate migration rerun checksum-skipped unchanged migrations `0000`–`0014`, and `git diff --check` passed.

P10.1 is DONE. P10 remains IN PROGRESS. The continuation below completes P10.2 retention eligibility and scheduling.

## P10.2 — retention eligibility and restart-first scheduling

Implemented:

- forward-only migration `0015_raw_retention_eligibility.sql` replaces the direct purge signature with a controlled-clock capability that revalidates eligibility after the shared summary/purge advisory lock and run-row lock. An `available` run must be finished, at least seven days past `finished_at`, strictly beyond the 24-hour upload window, and have a summary matching its current data revision, algorithm version, and quality schema;
- the transactional claimant scans at most 1,000 candidates, prioritizes committed `purging` recovery, skips advisory-locked runs without waiting, and only then selects new eligible work in stable oldest-first order. A committed partial purge resumes without rechecking eligibility; a `purged` explicit retry remains deterministic;
- each non-overlapping periodic cycle uses one injected UTC instant, claims at most one run, and commits at most one 1,000-point batch. `RUN_RAW_PURGE_INTERVAL_MS` defaults to 60 seconds, and the maintenance pool reserves independent capacity for summary workers, auto-finish, and raw purge;
- when no work is claimable, a maintenance-only existence check detects an overdue upload-closed run blocked by a missing/stale summary. The process emits an identity-free warning while leaving the run and raw points unchanged; structured metrics and alert routing remain P11.1;
- the claim, blocker, and mutating functions are `SECURITY DEFINER` with fixed `pg_catalog` search paths. Runtime/PUBLIC cannot execute them, and maintenance still has no direct application-table DML. ADR-0034 records the time boundaries, revalidation point, recovery priority, and deferred deletion scope.

Verification evidence on 2026-09-29:

- focused maintenance unit coverage passed 1 file / 9 tests for bounded SQL arguments, claim/commit ordering, completed/idle/blocked mapping, malformed database results, invalid clocks, and unknown commit outcomes;
- focused separated-role PostgreSQL/PostGIS coverage passed 1 file / 9 tests, including function privileges, exact 24-hour/seven-day gates, current-summary enforcement, eligible-only selection, identity-free blocker reporting, durable resume, rollback, concurrency, summary serialization, and archive/raw-HTTP regressions;
- migration `0015` applied only to the disposable `running_tracker_test` database after checksum-skipping unchanged `0000`–`0014`; no main/production database was connected to or migrated.
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 95 API unit tests, 82 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- the complete separated-role PostgreSQL/PostGIS integration suite passed 22 files / 203 tests across ingestion, raw history, live/summary/archive behavior, P10.1 recovery, and P10.2 eligibility/scheduling regressions.

P10.2 is DONE. P10 remains IN PROGRESS. The exact next planned fragment is P10.3: implement owner deletion and annual retention with an atomic tombstone and archive revision change. P10.4–P12 remain unopened.

## P10.3 — owner deletion and annual retention with tombstone/archive revision

Implemented:

- forward-only migration `0016_run_deletion.sql` adds a shared, non-`SECURITY DEFINER` primitive `app_private.execute_run_deletion` (granted to nobody; reachable only from inside a `SECURITY DEFINER` caller's owner context, the same internal-helper pattern as `run_summary_quality_stats_valid`) plus two authorization-separated `SECURITY DEFINER` wrappers: `delete_run_as_owner` (runtime-only) and `delete_run_for_retention` (maintenance-only), backed by `claim_run_deletion_candidate` (maintenance-only, non-blocking per-run advisory claim, oldest-`finished_at`-first, mirroring `claim_run_raw_purge_candidate`);
- both wrappers take, in order, the shared per-run advisory lock `running-tracker:run-summary:<orgId>:<runId>` (the same namespace P10.1/P10.2 already serialize on), `organizations FOR UPDATE`, then the run row `FOR UPDATE` — the same organization-before-run order ADR-0030/ADR-0015 already establish, so deletion cannot deadlock with ingestion, commands, share mutation, tile reads, raw purge, or summary publication; owner deletion blocks on that lock (`pg_advisory_xact_lock`), annual-retention candidate scanning does not (`pg_try_advisory_xact_lock`);
- `execute_run_deletion` inserts the tombstone (real owner, injected UTC `deleted_at`, `expires_at` one year later, the SDD's documented tombstone period) and then deletes `run_summaries` before `run_shares` before the run row itself (cascading `run_points`/`run_commands`). Deleting the summary first lets the existing migration-`0013` summary-delete trigger perform the one required `archive_revision` increment; deleting shares next means the history-share trigger observes no summary left and adds none. A run without a summary gets one explicit increment instead — exactly one increment per deleted run either way, without disabling or duplicating the existing trigger;
- `DELETE /api/orgs/:orgId/runs/:runId` (`apps/api/src/runs/run.routes.ts`, `runs/run-service.ts`) reuses the existing session/Origin/CSRF/membership/tenant-transaction boundary. `delete_run_as_owner` locks `runs` filtered by `org_id`, `run_id`, and `user_id = requesting_user_id` (the same owner-scoped pattern `ingestRunPoints`/`applyRunCommand` already use); a missing match is `already_deleted` (`204`) only when a tombstone already exists with this caller as `owner_user_id`, and `not_found` (`404 RUN_NOT_FOUND`) for every other case — a non-owner, a share grantee, or a stranger cannot distinguish "never existed" from "someone else deleted it";
- `apps/api/src/maintenance/run-retention-delete.ts` follows the existing `run-raw-purge.ts` shape exactly: one connection, one transaction, one claim, one deletion, committed or rolled back together, wired through the existing `PeriodicRunner` via a new `RUN_RETENTION_DELETE_INTERVAL_MS` (validated, defaults to 60 seconds, documented in `.env.example`/README/config tests) rather than a second scheduling framework; `main.ts` starts/stops it alongside the other maintenance runners;
- existing `PUT` tombstone-retry behavior (ADR-0006/P03.3, `410 RUN_DELETED`) and existing archive cache-hit invalidation (ADR-0030, revisioned cache keys, no manual purge) needed no changes and were reverified end-to-end after deletion. ADR-0035 records the full design, including why the ordering choice above is deliberate and not incidental.

Verification evidence on 2026-09-29:

- focused maintenance unit coverage for `run-retention-delete.ts` passed 1 file / 8 tests: claim/delete/commit ordering, idle mapping, malformed candidate/result rejection, unknown-commit-outcome client destruction, and rollback on a failed claim;
- focused real separated-role PostgreSQL/PostGIS integration passed 1 file / 17 tests covering: the privilege matrix (runtime/maintenance/PUBLIC execute grants on all three new functions and `execute_run_deletion`, and the absence of direct `DELETE` on `runs`/`run_points`/`run_summaries`/`run_commands`/`run_tombstones` for both roles); full cascade deletion of an owned run with a summary, exactly one tombstone, and exactly one archive-revision increment; the same for a run without a summary; idempotent repeated and concurrent-duplicate owner deletes; denial for a non-owner and a history-share grantee without leaking tombstone existence; `410 RUN_DELETED` on a subsequent `PUT`; stale archive-revision tile rejection and a matching metadata-revision increase after deletion; transactional rollback leaving the run/summary/tombstone untouched; deletion serializing behind an in-flight raw purge and an already-claimed in-flight summary on the shared advisory lock; and the one-year annual-retention boundary (`55000` one instant before, eligible exactly at and after), oldest-first candidate ordering plus an idle cycle, a valid tombstone/archive-revision result matching owner deletion, and two concurrent maintenance workers never deleting the same run twice;
- the first unconfigured attempt exposed two real defects, both fixed before the passing run above: a `runs_finished_state_consistent` CHECK violation in a test fixture helper (annual-retention `finishedAt` values earlier than a hardcoded `started_at`), and two HTTP-based concurrency tests that could hang past the 10-second test timeout under Windows/Node's per-request ephemeral `supertest` server overhead after many prior requests in the same file; both concurrency tests were rewritten to call the database functions directly through a `runtimePool` client (mirroring this repo's established raw-purge/summary concurrency-test convention) and then passed reliably across repeated runs;
- `npm run db:migrate:test` applied `0016` from unchanged `0000`–`0015`; the required rerun checksum-skipped all seventeen files;
- `npm run verify` passed lint, strict workspace typechecking, 10 infrastructure/migration tests, 103 API unit tests, 82 web tests, 14 contract tests, 14 fixture tests, 3 simulator tests, and every production build;
- the complete separated-role PostgreSQL/PostGIS integration suite passed 23 files / 220 tests (up from 22/203 at the P10.2 checkpoint), covering the new deletion suite plus every existing ingestion, raw-history, live-track, summary, archive, and role/RLS regression;
- `git diff --check` passed (only benign LF→CRLF checkout notices, no whitespace errors). No historical migration `0000`–`0015` was modified, no commit, push, or main/production database write occurred.

P10.3 is DONE. P10 remains IN PROGRESS: D08 (tombstone-expiry replay contract) is intentionally still open, and P10.4 (tombstone lifetime/late-retry contract) and P10.5 (deletion export journal) remain unopened. The exact next planned fragment is P10.4.

## P10.4 — tombstone lifetime and late-retry contract (D08)

Implemented:

- ADR-0036 fixes the contract. A tombstone row is authoritative while it exists; the request path never compares `expires_at`. For one year (`expires_at = deleted_at + 1 year`, unchanged from P10.3) a deleted ID answers `410 RUN_DELETED` to the owner's `PUT`/`GET` and `204` to a repeated owner `DELETE`. `expires_at` only marks when maintenance *may* reclaim the row; a delayed reclaim only lengthens protection. The ID is reusable only after the row is actually removed, after which `DELETE` returns `404 RUN_NOT_FOUND` and `PUT` creates a new run. Retries later than the window are explicitly outside the idempotency guarantee. No permanent used-ID registry was added;
- forward-only migration `0017_tombstone_expiry.sql` adds `app_private.reclaim_expired_run_tombstones(effective_now, batch_limit)` (`STRICT`, `SECURITY DEFINER`, `search_path = pg_catalog`, `EXECUTE` only for `running_tracker_maintenance`; batch 1..1000, non-finite time rejected). It deletes at most one batch of `expires_at <= effective_now` rows, oldest first, via `FOR UPDATE SKIP LOCKED`, and re-checks expiry on the locked row. Neither role gained any table privilege on `run_tombstones`;
- the same migration replaces `execute_run_deletion` so its tombstone write is an `ON CONFLICT (org_id, run_id) DO UPDATE` takeover with `expires_at = GREATEST(existing, new)`. This fixes a real P10.3 defect found during race analysis: the tombstone `SELECT` policy is owner-scoped, so another member's `PUT` can create a live run under an ID carrying someone else's marker; deleting that run (and annual retention of it) then failed on the primary key, and retention would have retried the same oldest candidate forever;
- locking analysis: `createRun` uses advisory key `<org>:<run>` while all P10 paths use `running-tracker:run-summary:<org>:<run>`; they do not serialize, and the design does not need them to. The tombstone row is the only shared state with two writers (deletion insert/takeover, reclaim delete) and is the last lock in every path, so there is no cycle. No advisory lock is taken by reclaim. Existing lock order (ADR-0035) is unchanged;
- `apps/api/src/maintenance/run-tombstone-reclaim.ts` (`runTombstoneReclaimOnce`, batch 500) runs on the existing `PeriodicRunner` with new `RUN_TOMBSTONE_RECLAIM_INTERVAL_MS` (default 300000, max 24 h; `.env.example`, README, config test). `run-service.ts` `isTombstoned` now documents why it ignores `expires_at`; no HTTP error carries age, owner, or expiry;
- `docs/SDD.md`, `README.md`, `docs/implementation-plan.md`, and `docs/decision-backlog.md` updated; D08 is RESOLVED. D09 (deletion journal / restore drill) remains open for P10.5/P12.

Verification evidence on 2026-09-29 (all commands run from the repository root against the disposable `running_tracker_test` database, using `--env-file=.env.example` because no `.env` exists):

- `node --env-file=.env.example scripts/migrate.mjs --test` applied `0017` from unchanged `0000`–`0016`; the immediate rerun checksum-skipped all eighteen files;
- focused integration `run-tombstone-expiry.integration.test.ts` passed 15/15 (privilege/catalog matrix and `42501` denials, argument bounds, exact `expires_at - 1 ms / = / + 1 ms` boundary with injected time, one-year expiry for owner and annual paths, full HTTP contract, delayed cleanup and non-disclosure to other members, 500-marker bounded batches with oldest-first order, retry/empty cycles, rollback, two-worker exclusivity, reclaim-vs-create ordering, and three takeover cases plus annual retention);
- `npm run lint` and `npm run typecheck` passed with no errors; `npm run test:migrations` passed 10/10;
- `npm run verify` exited 0: 115 API unit tests (20 files, +12: 11 in `run-tombstone-reclaim.spec.ts` and the interval bounds test), 82 web, 14 contracts, 14 fixtures, 3 simulator, 10 infrastructure tests, and every build;
- the complete separated-role integration suite passed 24 files / 235 tests (up from 23 / 220), including every P10.3 deletion, raw-purge, summary-publication, RLS, and tenant-isolation regression;
- `git diff --check` exited 0 (only LF→CRLF checkout notices). No historical migration was edited, and nothing was committed or pushed.

Limitations: the maintenance clock is trusted like the other P10 jobs; cross-member reuse of an ID inside the window remains possible (no leak, and its deletion now works); the maintenance pool size was not changed for the extra runner.

P10.4 is DONE. P10 remains IN PROGRESS. The exact next planned fragment is P10.5 — deletion export/log and recovery runbook.

## P10.5 — durable deletion journal, reapplication tool, and recovery runbook (D09)

Implemented:

- forward-only migration `0018_deletion_journal.sql` adds `run_deletion_journal` (identity `journal_seq`, org, run, owner, `deleted_at`; identifiers and one timestamp only, no foreign keys, no runtime/maintenance table privilege) and replaces `execute_run_deletion` (same signature, same grants) so the single primitive behind owner deletion and annual retention inserts the journal row in the same transaction as the tombstone and cascade delete. A committed deletion always has its row; a rolled-back one never leaves one; a repeated idempotent owner delete adds none;
- maintenance-only `claim_deletion_journal_batch(1..1000)` (`FOR UPDATE SKIP LOCKED`, oldest first) and `ack_deletion_journal_batch(bigint[])` (at most 1000). `runDeletionJournalExportOnce` holds one transaction across claim, durable file write, acknowledgement, and COMMIT, so rows leave the database only after the file exists; any earlier failure rolls back and keeps them, and a crash between write and COMMIT re-exports (at-least-once). The file sink writes a temporary file, fsyncs, renames, and fsyncs the directory (best effort on Windows), and file names never repeat (export instant, sequence range, random suffix) because the source sequence restarts after a restore;
- `DELETION_JOURNAL_DIR` (absolute; required in production, optional otherwise with a startup warning) and `RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS` (default 30000, max 24 h) in configuration, `.env.example`, and README. With the directory set, startup proves it writable before the listener binds; a sixth `PeriodicRunner` exports batches of at most 500 rows;
- strict journal format (`v: 1` JSON lines, unknown keys, non-canonical UUIDs/instants, blank lines, and a missing final newline reject the whole file) so a deletion is never silently skipped;
- owner-only `app_private.reapply_journaled_deletion` (granted to nobody) and `npm run restore:reapply-deletions -- --journal-dir <dir>` with `RESTORE_DATABASE_URL`. The command refuses any role but `running_tracker_owner`, reads every file before touching the database, applies each entry in its own transaction, is idempotent, and prints only counts. It deletes a run that still exists and existed at the journaled instant (journaling it again on the new node), leaves a run created after the deletion (ID reuse) alone, restores or lengthens but never shortens a missing/shorter tombstone, and skips expired windows and organizations/members absent from the restored data;
- ADR-0037, `docs/runbooks/deletion-journal-and-recovery.md` (configuration, monitoring, file retention, ordered restore procedure, failure modes, P12.3 drill checklist), SDD section 12, README, implementation plan, and decision backlog updated.

Verification evidence on 2026-09-29 (repository root, disposable `running_tracker_test` database, process-local values from `.env.example`):

- before the migration was applied, the new integration file failed at its first fixture query (`relation "run_deletion_journal" does not exist`), the intended RED; `node scripts/migrate.mjs --test` then applied `0018` from unchanged `0000`–`0017`, and a rerun checksum-skipped all nineteen files;
- `apps/api/test/run-deletion-journal.integration.test.ts` passed 18/18, three consecutive runs: table/function privilege matrix and `42501` denials for runtime and maintenance, argument bounds, exactly-one identifier-only row per owner deletion and per annual-retention deletion, none for a repeated delete or a rolled-back deletion, export drain with rows removed only after the file, sink failure keeping every row and a later retry succeeding, simulated crash between write and COMMIT with duplicate tolerance, two concurrent exporters taking disjoint batches while a 1,200-row backlog drained completely in order, and reapplication for every outcome plus idempotence, archive-revision advance exactly once, `410 RUN_DELETED` on `PUT` after reapplication, and resumption after a failed entry;
- `npm run verify` exited 0: 147 API unit tests (24 files, +32 over P10.4: journal format, sink, exporter, reapplication and command line, configuration bounds and the production requirement), 82 web, 14 contracts, 14 fixtures, 3 simulator, and every build;
- complete separated-role integration suite: 25 files / 253 tests (up from 24 / 235), rerunning every earlier deletion, purge, summary, archive, RLS, and tenant-isolation regression;
- built-command smoke against the test database: owner role exit 0 with counts only; the runtime role refused with exit 1; a corrupt journal file refused before any database access with exit 1;
- `git diff --check` reported only benign LF→CRLF checkout notices. No historical migration was edited, and nothing was committed or pushed.

Limitations:

- no backup or restore was performed: the procedure and tool are tested against a real database, but RPO/RTO are not claimed as achieved and the drill is P12.3;
- deletions not yet exported when a node is lost are lost with it; the window is about one export interval while the exporter is healthy and unbounded while it fails. The only failure signal today is a logged cycle failure; backlog-age metrics and alerting are P11.1;
- the application cannot verify that `DELETION_JOURNAL_DIR` is off-host or durable, does not sign or encrypt journal files, and does not prune them (the runbook gives the retention rule);
- reapplication does not restore revoked shares or memberships; that is P12.4;
- the sixth maintenance runner was added to the existing maintenance pool without resizing it.

P10.5 is DONE and with it P10. D09 is PARTIAL. The exact next planned stage is P11 — load verification and operational limits, starting with P11.1 metrics and structured logs without coordinates or secrets.

## P11.1 — metrics and structured logs without coordinates or secrets

Implemented:

- `apps/api/src/observability/`: a dependency-free `MetricsRegistry` (counter, gauge, fixed-bucket histogram; Prometheus text 0.0.4; label-value escaping; per-metric series cap with one `_overflow` series and `metrics_series_overflow_total`; scrape-time collectors that survive a throwing collector); code-defined instruments in `api-metrics.ts`; an allow-list JSON logger (`createLogger`, `describeError`); the HTTP middleware; pool, process, and tile-cache collectors; and the scrape server;
- `GET /metrics` is served by its own listener only when `METRICS_PORT` is set (`METRICS_HOST` defaults to `127.0.0.1`, `METRICS_PORT` must differ from `PORT`); it serves nothing else, answers 405/404 otherwise, and a failed bind fails startup with the pools closed;
- HTTP: count/duration/in-flight by method and route **template** (UUIDs and numbers replaced; every unmatched path collapses to `unmatched`); event streams are counted but excluded from the latency histogram; only 5xx responses are logged, once, with request ID, route template, duration, and the error class and short code left by the shared error handler;
- ingestion: commit latency by `ok|rejected|error` (checkout through COMMIT), inserted/duplicate point counters, rejections by application code;
- live SSE: open streams, streams opened, connection-limit rejections, backpressure closes, poll failures, and poll-cycle duration; tiles: hit/miss/error/aborted, served bytes, generation time (only for tiles that ran SQL), cache entries/bytes, scheduler queue depth and active count;
- maintenance: per-task cycle outcome, duration, and last-success time for all six periodic jobs through the shared `PeriodicRunner`, plus `raw_purge_blocked_total` for a retention overrun;
- pool checkout wait (including failed or timed-out checkouts) and total/idle/waiting counts for the runtime and maintenance pools; process RSS, heap, event-loop delay p99, and uptime;
- every remaining application `console.*` call now goes through the logger (the default sink still uses the console methods). The old periodic-runner failure line passed the whole error object; the new line carries only class name and short code;
- ADR-0038, README ("Metrics and logs (P11.1)" and configuration), `.env.example`, SDD section 15, and the implementation plan updated.

Verification evidence on 2026-09-29 (repository root, disposable `running_tracker_test` database, `--env-file=.env.example`):

- RED was observed for the logger, HTTP-middleware, runtime-metrics/listener, periodic-runner, live-hub, and tile-coordinator specs (missing module, or the metric absent from the output) before their implementation; the registry, ingestion-helper, and configuration specs were written in the same step as their code, so those three have no observed RED;
- one regression found and fixed while wiring: a request that hit an unhandled error produced two log lines (the handler's and the middleware's) and broke the existing "exactly one error log" expectation in `session.spec.ts`; the handler now only records the error description and the middleware emits the single line, covered by a new spec;
- one flaky assertion fixed in my own new test: a `not.toMatch(/abc/)` guard could match hex inside the random request ID;
- `npm run verify` exited 0: lint, strict typecheck, 10 infrastructure tests, 183 API unit tests (31 files, up from 147 / 24 at P10.5), 82 web, 14 contract, 14 fixture, 3 simulator tests, and every build;
- complete separated-role integration suite: 26 files / 254 tests (up from 25 / 253), including the new `observability.integration.test.ts`, which ingests through HTTP against real PostgreSQL (new points, an exact retry, a conflicting payload), scrapes a real listener, and asserts the inserted/duplicate/rejected counts, templated routes, pool and process series, and that **neither the exposition nor the captured logs contain the distinctive coordinates, run/org/user IDs, the session cookie value, or the CSRF token**;
- built-process smoke: the API started with `PORT=3111 METRICS_PORT=9464`, `/api/health/live` returned 200, `/metrics` on the API port returned 404, and the metrics port returned the request, pool, and memory series; startup logs were JSON lines with no message text; both listeners were confirmed closed afterward;
- `git diff --check` reported only benign LF→CRLF checkout notices. No migration was added or edited, no dependency was added, and nothing was committed or pushed.

Limitations:

- metrics are per process and reset on restart; there are no shipped dashboards or alert rules, and the scrape endpoint is unauthenticated by design (bind address and network are the control);
- the SDD signals that need database reads are not exported yet: data age, summary lag, dead tuples (P11.4), and backup age (P12.3); GPS-to-browser latency is an end-to-end measurement for P11.3;
- the tile `miss` counter includes requests that joined another request's in-flight generation;
- `observePool` wraps the promise form of `Pool.connect` in place and leaves the callback form alone, which nothing in the codebase uses;
- the uncommitted P10.4/P10.5 work and this change are still in the working tree together; nothing has been committed.

P11.1 is DONE. P11 remains IN PROGRESS. The exact next planned fragment is P11.2 — the seeded ordinary (126k raw points, 3,650 summaries) and stress (3M raw points) datasets with a reproducible ACL/geography distribution.

## P11.2 — deterministic ordinary and stress datasets

Implemented:

- `apps/api/src/loadtest/`: a pure planner (`dataset-plan.ts`), a single-transaction owner-role seeder (`seed-dataset.ts`), and the `npm run load:seed -- --profile ordinary|stress|smoke [--seed N] [--as-of <UTC instant>] [--reset]` command (`LOAD_DATABASE_URL`, documented in `.env.example` and the README). It prints a JSON manifest: organization and member IDs, counts, per-phase timings, relation sizes, and a reproducibility digest;
- the SDD volumes are exact: 10 members × 365 days = 3,650 finished runs and summaries; `ordinary` holds 126,000 raw points (70 runs of 1,800 points in the last seven days) and `stress` holds 3,000,000 (42,857 or 42,858 points per run, about 23.8 hours at 2 s, under the 24-hour and 50,000-point limits). Older runs are `purged` with only a summary. Runs carry the batch-derived `data_revision` (`ceil(points/100) + 1`), and summaries carry the current algorithm version and valid `quality_stats`, so `find_stale_run_summaries` does not list them;
- geography: eight anchors (both hemispheres, equator, high latitude) and one route centred on 180° whose raw points fall on both sides and whose display MultiLineString splits into parts (365 multipart summaries, exactly that member's runs); ACL: the last two members are coaches with both grants from every runner, and every other ordered pair draws a standing none/history/live/both policy (40/20/10/30%) applied to all of the owner's runs;
- everything derives from SHA-256 of `seed:key` (plan) or `md5(seed:run:seq)` (per-point noise, in SQL), so the same seed and instant give the same rows;
- safety: only databases ending in `_load_test` are accepted by the command; `--reset` (TRUNCATE of the dataset tables) works only there; a non-empty database is refused without `--reset`; the seeder requires the `running_tracker_owner` role. The suffix still ends in `_test`, so the existing bootstrap/migration scripts work on it with the URL variables pointed at `running_tracker_load_test` and no script changed. ADR-0039 records the decisions.

Verification evidence on 2026-09-29 (repository root, `--env-file=.env.example` values):

- RED observed for the seeder: the first integration run failed with `window function calls cannot be nested` (the summary geometry query) and, after that fix, with the smoke profile having four members and therefore no antimeridian member (raised to five) and an assertion that every antimeridian-member run splits, which is false for the short 60-point archived runs (now asserted as at least one split run). The plan and CLI specs were written together with their code, so those two files have no observed RED;
- `dataset-plan.spec.ts` 14 tests and `seed-dataset-cli.spec.ts` 5 tests; the new `load-dataset.integration.test.ts` passed 9 tests against real PostgreSQL/PostGIS: exact volumes, every constraint, point contiguity/order/revision consistency, valid current summaries, antimeridian coverage, reproducible digest and a different one for another seed, whole-transaction rollback, target/role/non-empty refusals, and per-member visible runs, summaries, and points under the runtime role matching the planned history grants, with a member of another organization seeing nothing;
- `npm run verify` exited 0: 202 API unit tests (33 files, +19 over P11.1), 82 web, 14 contracts, 14 fixtures, 3 simulator, and every build;
- complete separated-role integration suite: 27 files / 263 tests (up from 26 / 254);
- real seeding into a new `running_tracker_load_test` database (created with `CREATE DATABASE`, then the existing bootstrap and migrations `0000`–`0018`): `ordinary` produced 126,000 points, 3,650 summaries, and 21,900 shares in about 15 s with `run_points` at 45.6 MB (about 361 bytes per point including indexes) and digest `7c83dac6…`; a second seed with `--reset` gave the same digest and a run without `--reset` refused; `stress` produced 3,000,000 points in about 78 s with `run_points` at 1.09 GB (about 363 bytes per point) and a different digest; all summaries were valid geometries. The database was then reseeded with `ordinary`;
- `git diff --check` reported only benign LF→CRLF notices. No migration or dependency was added, and nothing was committed or pushed.

Limitations:

- the seeded runs have no `run_commands`, tombstones, or active runs, so replay of their original commands is not exercised; P11.3 creates live runs through the API;
- the display geometry is analytic, not the output of the production simplifier, and the simplifier's cost on 42,857-point runs remains a P11.3/P11.4 measurement;
- the digest is stable on one PostgreSQL/PostGIS build only;
- the bytes-per-point figures are a first observation on a fresh load, before any bloat or WAL and without the measurement method P11.4 requires; they are not a P11.4 result;
- the load database persists in the local Docker volume (about 1.1 GB while the stress data is loaded); hosted CI does not run it.

P11.2 is DONE. P11 remains IN PROGRESS. The exact next planned fragment is P11.3 — concurrent ingestion, viewers, pan/zoom, jobs, and offline batches against the seeded datasets.

## P11.3 — concurrent ingestion, observers, pan/zoom, summary job, and offline catch-up scenario

Implemented (ADR-0040):

- `npm run load:run -- --profile smoke|ordinary|stress [--seed N] [--as-of <UTC instant>] [--results-dir <path>] [--no-cleanup | --cleanup-only]` (`apps/api/src/loadtest/load-*.ts`). It starts the real API (`src/entrypoint.ts`) as a child process on free loopback ports and drives it only over HTTP and SSE. The runner touches the database as the object owner only to verify the dataset before the run and to delete its own runs afterwards;
- safety: the owner, runtime, and maintenance URLs (`LOAD_DATABASE_URL`, `LOAD_RUNTIME_DATABASE_URL`, `LOAD_MAINTENANCE_DATABASE_URL`) must name the same loopback host and a database ending in `_load_test`; each role's live session is asked for `current_database()`/`current_user`; the dataset instant is recovered from the seeded rows (or `--as-of`) and the whole plan is verified (run IDs and start times, members, exact point and summary totals, no active run) before anything starts, so leftovers fail closed with counts only. No flag names a URL, a database, or a reseed. The child gets a scrubbed environment (no owner or bootstrap credentials; local sessions only for the planned members; the production guard is untouched);
- real sessions through `POST /api/session`; the cookie and CSRF token live in private fields of `LoadSession`, whose JSON, `inspect`, and string forms show the user ID only;
- scenario: one active run per member (unique-index rule), the summary run owned first by member 0, who finishes it and then creates their active run; deterministic run and command IDs; shares created through the API from the planned policy; ten per-member SSE observers (distinct subscriptions, so the live poll reads ten times); rounds of ten concurrent 100-point offline batches (`smoke` 2, `ordinary` 3, `stress` 10; each round a barrier), then an exact retry and an overlapping retry (50 new + 50 duplicate); two overlapping tile-burst streams (eight 3×3 viewports per burst across zoom 9/11/13, pan east and back, eight regions in a fixed order starting with the antimeridian route whose viewport wraps columns 0 and 2^z−1, later cycles shifting the centre for new keys); the summary run's finish command followed by the existing worker; then fresh points every two seconds per member until the summary is visible and the archive revision has advanced (at least 30 s ordinary, 60 s stress). Fresh latency is measured from the point's creation to the first state on each expected observer whose position for that run has reached its `seq`. The first fresh point per run is a "bridge" (its predecessor is more than 10 s older, so the live state cannot show it); it is flagged and excluded from the convenience summary, and the raw samples keep it;
- failures stop new load, abort in-flight requests, close every stream, and still return a partial report, classified as transport, timeout, sse, unexpected-response, application-rejection, or load-runner; expected rejections (tile revision change, documented load shedding) are counted, not failures; Ctrl-C takes the same path;
- result: one JSON file per run in `.local/load-results/` (gitignored), schema `running-tracker.load-result` v1: provenance (commit, Node, PostgreSQL, PostGIS, effective non-secret API settings), phase intervals, every HTTP, tile, and fresh sample with start and end relative to the scenario origin, observer reports, the summary-publication timeline with a before/after tile comparison, full metrics before and after plus bounded snapshots, a server-log tally by level and event, and convenience percentiles. `assertSafeResult` rejects any session or CSRF value and any coordinate-, cookie-, or token-named key before anything is written;
- README ("Concurrent load scenario (P11.3)") and `.env.example` document the variables; the README seed example now uses the default instant (see below).

Verification evidence on 2026-09-30 (repository root, dedicated `running_tracker_load_test` and disposable `running_tracker_test`):

- tests were written before their modules for statistics, bounded concurrency, the Prometheus parser, the HTTP client, sessions, SSE parsing and correlation, planning, target refusal, child environment, results, arguments, the dataset-instant warning, and CLI refusal (each observed failing on the missing module or missing behaviour first); the dataset-identity integration file, the fault-injecting orchestrator spec, and the whole-scenario smoke integration were written together with their code;
- `npm run lint` and `npm run typecheck` passed; `npm run verify` exited 0: 293 API unit tests (47 files, up from 202 / 33), 82 web, 14 contracts, 14 fixtures, 3 simulator, 10 infrastructure tests, and every build;
- `node --env-file=.env.example scripts/migrate.mjs --test` skipped all nineteen already-applied files; the complete separated-role integration suite passed 29 files / 270 tests (up from 27 / 263), including `load-dataset-check.integration.test.ts` (5) and `load-runner.integration.test.ts` (2), which runs the whole smoke scenario against the real Express app, SSE hub, tile pipeline, and summary worker on real PostgreSQL/PostGIS and asserts structure only (no timing threshold); `git diff --check` reported only LF→CRLF notices;
- `load-orchestrator.spec.ts` runs the orchestrator against a fault-injecting fake API: an ingestion 500, a hung request, a reset connection, a dropped observer stream, and an external cancel each fail with the right class, close all ten streams, stop tile load, leave no open connection, and produce a partial report that passes the secret scan.

Real runs against `running_tracker_load_test` (seed 42, dataset instant 2026-09-30T00:00:00.000Z, PostgreSQL 17.5, PostGIS 3.5, Node 24.11.1; API settings from the defaults: pool 10, query timeout 1000 ms, SSE poll 2000 ms, summary interval 60000 ms, summary concurrency 2; runner, API, and database on one Windows machine). Both finished with status `ok`; all ten observers stayed connected with no protocol errors, backpressure closes, or server error log lines; cleanup removed exactly the 11 created runs and re-verified the dataset. Figures are client-measured milliseconds and are reported without interpretation:

| | ordinary (126,000 raw points) | stress (3,000,000 raw points) |
|---|---|---|
| catch-up requests (10 concurrent × 100 points × rounds) | 30 requests, 3,000 points: p50 103, p95 136, max 144 | 100 requests, 10,000 points: p50 149, p95 241, max 347 |
| fresh single-point ingestion | 297 requests: p50 37, p95 58, max 169 | 539 requests: p50 94, p95 196, max 387 |
| fresh point → observer (bridge points excluded) | 1,410 samples: p50 1,053, p95 2,015, p99 2,093, max 2,159; 0 unresolved | 2,594 samples: p50 1,148, p95 2,117, p99 2,303, max 3,347; 0 unresolved |
| tiles (started / ok / revision changed) | 1,138 / 1,132 / 6; z9 p95 1,205, z11 p95 956, z13 p50 10, p95 882 | 1,547 / 1,541 / 6; z9 p95 2,678, z11 p95 1,211, z13 p50 13, p95 1,345 (max 3,975) |
| server tile cache result (miss / hit / error) | 550 / 584 / 6 | 720 / 823 / 6 |
| finish acknowledged → summary visible to the owner | 1.2 s → 61.1 s | 1.6 s → 111.6 s |
| archive revision advanced (first metadata poll) | 60.3 s | 110.7 s |
| summary worker cycle duration (server metric) | not retained | 50.8 s |
| process RSS / tile cache bytes at the end | 115 MB / 2.7 MB | 143 MB / 2.5 MB |

The same tile before and after publication differed in size in both runs (33,941 → 34,035 and 21,829 → 22,020 bytes), which shows the new summary reached the map source. The server's `point_ingest_points_total` matched the runner's counts exactly (ordinary: 3,647 inserted = 300 setup + 3,000 catch-up + 50 overlap + 297 fresh; 150 duplicates = 100 + 50). The result files are in `.local/load-results/` (local, not committed).

Failures found and fixed on the way (none in production code):

- the first real ordinary run failed with "observer stream closed unexpectedly": the HTTP client applied its 30 s request deadline to the open SSE stream. Fixed with a header-phase-only deadline and a test that failed first;
- a dataset seeded for 2032-03-01 (the README's earlier example) lies outside the 366-day archive window that ends now, so tiles were near-empty and fast; that first "success" was discarded. The README example now uses the default instant, the runner warns when the dataset instant is far from now, and the dataset was reseeded for 2026-09-30;
- with the default cadence, the API's own raw-purge and annual-retention jobs ran on the aging dataset during the measurement and rewrote seeded rows (the post-run verification caught it and failed the run); one annual-retention deletion cycle took 82.2 s concurrently with the tile bursts, and the summary cycle was equally long. That run was discarded and its result file removed. The child API now parks those jobs at 24 h unless `LOAD_KEEP_RETENTION_JOBS=true`;
- the first fresh point per run cannot appear in the live state (its predecessor is more than 10 s older), which the `bridge` flag records instead of leaving a misleading latency in the summary.

Observations for P11.4 (not analysed, not fixed):

- summary publication took 61 s (ordinary) and 112 s (stress) from finish to visibility with the 60 s worker cadence; in the stress run one worker cycle lasted 50.8 s. A single `pg_stat_activity` sample during an ordinary run showed the summary transaction waiting on a lock held by a tile transaction. An earlier ordinary run in which lifecycle steps (a run creation and nine share changes) ran under continuous tile bursts spent 17.6 s in that step, and its summary cycle spent 17.3 s; the order was then changed so the hand-over precedes the bursts (ADR-0040). Whether tile transactions delay organization-level writers is a hypothesis, not a finding;
- catch-up latency grows across rounds within a run (stress: request medians about 100 ms in round 1 to about 190 ms in round 7, while each run holds up to 1,000 points), and tile latency at z9 and z11 is higher than at z13 under the burst load;
- fresh-to-observer latency ranged from 0.04 s to 3.3 s with a median close to the 2 s poll interval; the stress maximum was 3.3 s;
- ingestion stayed in the tens to low hundreds of milliseconds while the tile bursts ran, but no starvation conclusion is drawn from two runs.

Limitations:

- one machine hosts the runner, the API, and PostgreSQL, so CPU competes; two real runs per profile are not a statistical basis, and no SDD target (ingestion p95 500 ms, fresh p95 5 s, summary visibility 60 s, LRU and SSE buffer stability, no tile starvation) is confirmed by them. Tile hit or miss per request is not inferred, only the server counters and a `repeatOfEarlier` flag;
- the tile burst gesture, region order, viewer assignment, and cadence are fixed choices, not a model of real users; the tile window is 366 days ending an hour after now;
- cleanup deletes with owner SQL and leaves no tombstone or journal row; the API's own deletion path is covered by the P10 suites;
- retention jobs are parked by default (opt-in `LOAD_KEEP_RETENTION_JOBS`), so concurrent retention plus tile load is not part of the standard scenario;
- the database currently holds the ordinary dataset (reseeded after the stress run; digest `decc8c2f…` for 2026-09-30).

P11.3 is DONE. P11 remains IN PROGRESS. The exact next stage is P11.4 — collect EXPLAIN ANALYZE BUFFERS, relation/index sizes, response bytes, memory and complete performance measurements.

## P11.4 — plans, sizes, response bytes, lock waits, and the generated report

Implemented (ADR-0041):

- the hot statements were moved unchanged into exported constants (`renderArchiveTileSql`, `liveStateSql`, `listRunsSql`, `rawPointsPageSql`, `liveTrackSnapshotSql`, `liveTrackChangesSql`, `insertPointsSql`, `publishCandidateSql`) so the tooling measures the production text; no SQL text was edited;
- `npm run load:explain -- --profile … [--repetitions N] [--keep-plans]` (same `LOAD_*` guards and dataset verification as `load:run`): 40 statements (24 tiles over eight regions × zoom 9/11/13 including the antimeridian route, run list, raw history first and deep page, snapshot first and deep page, one changes page, summary claim and publication, live state, a 100-point insert, and three owner-versus-RLS count-scan pairs) run as `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` under `running_tracker_runtime`/`_maintenance`/`_owner` with the tenant context, always rolled back. Live state and insert need recording runs, so each member's newest run is set to `recording` and restored from its saved `finished_at` text in a finally path; a failing statement is recorded by SQLSTATE and class only. It also measures the real service call (bytes, time, JSON serialization time), relation/index sizes, tuple counters, and plan-shaping settings, and writes one sanitized JSON result (`--keep-plans` writes raw plans to a separate file);
- `load:run` samples `pg_locks` every 250 ms (no statement text; a role without `pg_read_all_stats` cannot see another role's wait events, but it can see ungranted lock requests) and accepts `--no-tiles` for a baseline; finer-grained SDD metrics (data age, summary lag, dead tuples) are not exported to the scrape endpoint, deliberately (ADR-0041);
- `npm run load:report` generates `docs/reports/p11-measurements.md` from the raw result files: environment, goals met / not met / not confirmed under explicit rules, pooled percentiles per group, EXPLAIN tables, sizes.

Verification evidence on 2026-09-30 (repository root, `--env-file=.env.example` values, real PostgreSQL 17.5/PostGIS 3.5):

- tests were written before their modules for the plan summarizer, statement planner, argument parsers, CLI refusals, lock summary, orchestrator hooks (`lockSamples`, `tileStreams`), report data, renderer, and report CLI, each observed failing on the missing module or behavior first; the collector integration file was written before the collector and failed on the missing module, then on a real bug (a text alias `seq` shadowed the column in `ORDER BY`, picking the wrong tail point), then passed; the lock-sampler integration test passed on its first run and was mutation-checked (flipping the filter made it fail; the source was restored);
- `npm run verify` exited 0 after four lint findings in my code were fixed (a throw inside `finally`, an unused assignment, two `any` accesses): 376 API unit tests (55 files, up from 293 / 47), 82 web, 14 contracts, 14 fixtures, 3 simulator, and every build;
- the complete separated-role integration suite passed 31 files / 279 tests (up from 29 / 270), including the collector against real roles (rollback, fixture restoration after a failure and after cancellation, executed identity per role), the real lock wait, and every existing suite that exercises the refactored SQL constants;
- `git diff --check` reports only LF→CRLF notices. No migration or dependency was added; nothing was committed or pushed. The load database ends holding the ordinary dataset (digest `decc8c2f…`, identical to the one recorded at the end of P11.3).

Measurements (`docs/reports/p11-measurements.md`; seed 42, dataset instant 2026-09-30T00:00:00Z; three runs per group, ordinary and stress, with and without tile bursts; one Windows machine, AMD Ryzen AI 7 350, 16 logical CPUs, 15 GiB RAM, NVMe SSD, Docker Desktop VM 7.4 GiB with no container limit; PostgreSQL defaults such as shared_buffers 160 MB):

- 12 load runs in the report and 2 EXPLAIN collections behind it finished with zero failed runs, zero unexpected responses, zero server error log lines, and zero observer problems;
- met under the stated rules: ingestion p95 (ordinary 89 ms, stress 218 ms, client-side over loopback), fresh point → observer p95 (ordinary 1,991 ms, stress 2,072 ms, bounded by the 2 s poll), no ingestion starvation from two overlapping tile streams (stress 218 ms with tiles, 158 ms without);
- not confirmed: summary visibility (60.3–63.0 s from the finish command, which includes the 60 s worker cadence; publication cannot be timed from the client), LRU footprint (3.5 MiB of 32 MiB, so eviction never ran), SSE pending buffer (no such metric; no stream dropped);
- the same count scan costs 0.3–1.8 ms as the table owner and 83–185 ms under RLS (ordinary), and 4 ms against 2,024 ms for one 42,857-point run: about 45–50 µs and 8 buffer hits per checked row, which is nearly all of the cost of the archive tile (360–510 ms, three sequential scans of `run_summaries`, GiST index unused), the run list (404 ms ordinary, 577 ms stress), and raw reads;
- a live-track snapshot page or one changes page for a 96-byte answer takes about 2.4–2.6 s at 42,857 points (343,000 buffers) because the plan reads the whole run before it limits the page; raw history takes 57 ms for the same run;
- summary recalculation and publication of the largest run takes 0.45 s (ordinary) to 0.84 s (stress) at the median, so it is not what made P11.3's worker cycle 50.8 s; that cycle and its 111 s visibility did not reproduce in six later stress runs, and their cause was not established;
- a 100-point insert takes 5–14 ms and writes 66–70 KB of WAL; `run_points` is 1.09 GB at 3 M points with the revision index (359 MB) larger than the primary key (307 MB);
- the P11.3 lock hypothesis: with tile bursts the maintenance backend waited for a lock in 8–14 of about 750 samples per group (2–3.5 s) and no API backend waited; without tiles 0–1 samples. Tile transactions delay summary publication by seconds and do not block ingestion in this workload;
- resident memory 86–113 MiB, pool acquire p95 upper bound 5 ms, tile queue observed at most 4, no tile shed.

Limitations:

- one machine hosts the runner, the API, and PostgreSQL; three runs per group are a sample of that machine, not a capacity claim; histogram percentiles are bucket upper bounds; metric snapshots are every 15 s and lock samples every 250 ms;
- "first execution" in EXPLAIN is not a cold-cache figure (the working set fits in memory; shared reads were near zero); statements inside PL/pgSQL functions appear as one node;
- no browser was driven: frame time, rendering, and the web application's own polling are unmeasured; the published EXPLAIN numbers are database execution time only;
- the earlier P11.3 result files were excluded from the report by `--since`, because they predate lock sampling and the first stress run followed a fresh seed; they remain in `.local/load-results/` and in the P11.3 section above.

P11.4 is DONE. P11 remains IN PROGRESS. The exact next stage is P11.5 — apply only the optimizations these measurements confirm (candidates: the RLS predicate cost on `run_summaries`/`runs`/`run_points`, page-limited snapshot and changes reads, a tile query shape that can use the spatial index, the revision index size) and keep a before/after report produced by the same commands.

## P11.5 — set-based run visibility (the one optimization P11.4 confirmed)

Implemented (ADR-0042, migration `0019_set_based_run_visibility.sql`):

- `app_private.readable_run_keys()` and `app_private.history_readable_run_keys()` return, in one statement, the `(org_id, run_id)` pairs for which `can_read_run` and `can_read_run_history` are true. The SELECT policies on `run_points`, `run_summaries`, and the shared-row branch of `runs` now use `(org_id, run_id) IN (SELECT ... FROM set_function())`, which PostgreSQL builds once per statement into a hash table (previously a definer function ran once per row at about 8 buffers and 45–50 µs). The per-row functions and every other policy and grant are unchanged;
- a narrowing-only transaction setting `app.visibility_scope = 'live'` (`withTenantTransaction` option `visibilityScope`, set in the same statement as the identity) makes `readable_run_keys()` return only recording or paused runs. Only the live SSE hub uses it, and the EXPLAIN catalogue declares it for the live-state statement. It is needed because the set costs the same however few rows a statement reads: without it the live-state poll went from 2 ms to 24 ms in the first after-measurement;
- the migration's four-branch function uses one-time filters so the switched-off branches do not run; any setting value other than the exact string `live` leaves the full set.

Verification evidence on 2026-09-30 (repository root, `--env-file=.env.example` values, real PostgreSQL 17.5/PostGIS 3.5):

- RED observed: the new `rls-set-policies.integration.test.ts` failed 5 of 5 on the missing functions before the migration; `tenant-transaction.spec.ts` (2 tests) failed before the option existed; the scope, EXPLAIN-catalogue, and hub tests were mutation-checked (narrowing disabled in the test database, the catalogue's scope removed, the hub's option removed: each made exactly its test fail, then the code was restored). The scope integration tests and the catalogue and hub tests were written together with their code and therefore have no separate RED, only the mutation checks;
- set equivalence: for both functions, every fixture user (seven, plus an unknown user) in both tenants equals the rows the per-row function allows, with at least three non-empty sets; a missing, empty, or malformed context returns nothing; the scope test compares the narrowed set with the unscoped set filtered by status for every identity, rejects widening by any other value (`''`, `LIVE`, `all`, `history`, `live ` with a trailing space, `1`, an injection-shaped string), leaves the archive set untouched, and shows through the policies under the runtime role that the scope is transaction-local;
- unit: 380 API tests (55 files; +4), 82 web, 14 contracts, 14 fixtures, 3 simulator; `npm run lint` and `npm run typecheck` clean. Complete separated-role integration suite: 32 files / 288 tests (up from 31 / 279; the unchanged D02/ACL, tile, live-track, raw-history, deletion, and load-runner suites all pass on the new policies);
- two wrong turns on the way: an integration run without the environment file failed in 10 files on missing test URLs (the same suite with `--env-file=.env.example` passed); and the first draft of the migration had no scope, so its measurement is what showed the live-state regression. Migration 0019 was rewritten before any commit, after its first version was rolled back by hand on the two disposable databases;
- prototypes rejected on measurement (rolled back, not committed): inlinable `current_org_id`/`current_user_id` (slower, about 215–270 ms against 160–175 ms), and an inlinable view with a correlated `EXISTS` (PostgreSQL turns it into the same hashed sub-plan and it was slower).

Before/after with the P11.4 commands (`docs/reports/p11-measurements.md` before; `docs/reports/p11-5-measurements-after.md` after, generated with `npm run load:report -- --since 2026-09-30T11:33:29.000Z`; the load database was reseeded for stress and back to ordinary; result files are in the gitignored `.local/load-results/`); the full table with buffers is in ADR-0042:

- database execution, ordinary → stress medians in ms: archive tile 360 → 56 and 365 → 42; run list 358 → 37 and 355 → 36; count of a run's points as a coach 83 → 9 and 2,024 → 16; live-track snapshot page 58 → 24 and 2,058 → 39; changes page 87 → 18 and 2,102 → 78; live-state poll 2.0 → 2.3 and 2.1 → 2.5 (24 without the scope); insert 4.2 → 4.5 and 4.2 → 4.9; summary publication unchanged (388 → 373 and 762 → 726);
- load: 12 runs, 0 failed, 0 unexpected responses, 0 server error lines, 0 observer problems. Ingestion p95 89 → 95 ms (ordinary) and 218 → 105 ms (stress); fresh point → observer p95 1,993 and 2,009 ms; client tile p95 under the bursts fell from 0.7–1.3 s to 0.13–0.20 s, and the two closed-loop tile streams now sent about five times as many requests (17,630 and 17,560 against 3,942 and 3,352); summary visibility stayed 60.4–61.0 s (cadence-bound); the maintenance backend waited for a lock in 4 and 4 of about 720 samples (was 14 and 8);
- the same targets are met and the same three remain not confirmed.

Findings and limits:

- the only visible difference in response content is the order of the parts inside multi-part geometries of the antimeridian tiles (up to about 15 bytes): the same tile was decoded under the old and new policies in one rolled-back transaction and all 365 features have identical properties, order, and sets of parts; the SQL never ordered parts and MVT gives the order no meaning;
- with tile bursts the API's resident memory peaked at 207–217 MiB (was 109–113) and the tile cache at 6.8–10.7 MiB (was 1.7–3.5) because faster tiles let the same wall time serve five times the tiles; nothing was shed. One no-tile stress run showed API-side lock waits (2 samples, peak 9) that earlier runs did not; not investigated;
- a member who is not a coach with every grant builds a smaller set; a coach reading a few rows of another member's run now pays one set build (about 8–12 ms) instead of a few point lookups. The hash table is not bounded by `work_mem` and its memory was not measured;
- the page-limited snapshot read, a GiST-friendly tile shape, and the revision index were evaluated against the new numbers and deliberately not changed (ADR-0042);
- same single-machine limits as P11.4: three runs per group, EXPLAIN is database execution only, no browser was driven.

P11.5 is DONE and P11 is DONE: the limits are known from measurements, with summary visibility, LRU footprint, and SSE buffer still not confirmed by this workload. The exact next stage is P12 — production identity provider integration, deployment configuration and runbook, backup/restore drill with subsequent deletions, current-permission recovery, and the final documentation pass. Each needs an external identity provider or target environment that has not been provided, so the independent configuration and tests come first and the external blockers are flagged.

## P12.2 — single-host deployment profile, file-based secrets, production config rules

P12.1 (identity provider) needs a provider decision and credentials that have not been provided, so P12.2 was taken first: it needs no external account. P12.1, P12.3 and P12.4 remain open.

Implemented (ADR-0043):

- `infra/compose/docker-compose.production.yml`: a standalone profile (`postgres` on an internal-only network, one-shot `db-init` running the existing bootstrap and migration scripts, `api`, `proxy`). Only the proxy publishes ports (80, 443). Every service has memory (no swap), CPU and pids limits, `cap_drop: ALL`, `no-new-privileges`, and bounded logs; `db-init`, `api` and `proxy` have read-only root file systems. Required inputs use `${VAR:?}`; `infra/compose/production.env.example` lists them and holds no secret. Bind mounts use the long syntax because Windows drive letters break the short one;
- secrets as files: `npm run deploy:secrets -- --dir <dir>` (`scripts/production-secrets.mjs`) writes the administrator password, four database URLs with independent 256-bit passwords, and the cursor key (directory 0700, files 0444, refuses to overwrite without `--force`; `--rotate-roles` replaces only the three application logins because PostgreSQL reads the administrator password only at first initialization). The API resolves `DATABASE_URL_FILE`, `MAINTENANCE_DATABASE_URL_FILE` and `LIVE_TRACK_CURSOR_SIGNING_KEY_FILE` (`config/secret-files.ts`; both forms together is an error; errors never contain file content);
- one new production startup rule: `ALLOWED_ORIGINS` must be non-empty and HTTPS-only;
- images: a `tools` stage in `infra/api/Dockerfile` (scripts and migrations, for `db-init`) and a `production` stage in `infra/proxy/Dockerfile`; the historical last stages (`runtime`, `transport`) stay the default targets and the transport Compose file now names its targets;
- edge: `nginx.production.conf` plus an envsubst site template. HTTP only redirects to the configured `PUBLIC_ORIGIN`; unknown TLS names are refused at the handshake; HSTS, `nosniff`, Referrer-Policy, Permissions-Policy, and `frame-ancestors 'none'`; the ADR-0026 SSE policy is unchanged; hashed assets are cached immutable, `index.html` is `no-cache`; a plain-HTTP `/healthz` serves the container health check (a check by IP fails because a request without SNI is refused);
- `docs/runbooks/deployment.md` (setup, update, verification, limits, metrics, credential rotation, certificate renewal, gaps).

Verification evidence on 2026-09-30 (repository root, Docker 29.7.2 on Windows Docker Desktop, PostgreSQL 17.5/PostGIS 3.5 image, nginx 1.28.0):

- RED observed first: `secret-files.spec.ts` failed on the missing module, the new origin test failed with "expected [Function] to throw", and the two role-rotation tests failed before the `rotateRoles` option existed. `npm run verify` initially failed once on an existing health test that built a "valid production" config without an origin; the test now supplies `https://tracker.example`. After that `npm run verify` exited 0: 389 API unit tests (56 files, up from 380 / 55), 82 web, 14 contracts, 14 fixtures, 3 simulator, 25 script tests (15 new), lint, typecheck, and every build. The integration suite was not re-run: the change touches only production-mode config validation and new files, and integration tests run with `APP_ENV=test`;
- `npm run deploy:verify` exited 0 on the final code (four earlier runs failed and were fixed: Windows drive letters in short volume syntax; the proxy health check by IP being refused for lacking SNI; a literal newline in the health response; `docker compose ps -q` skipping the exited `db-init`). It builds the three images and asserts on the running stack: HTTP/2 negotiated via ALPN; readiness through the proxy; SPA fallback and immutable hashed assets; security headers on `/`, `/assets/` and `/api/`; no `Server` version; HTTP 301 to the configured origin even for `Host: evil.invalid`; a refused handshake for an unknown SNI; `POST /api/session` answering 404 with no cookie; only 80/443 published, none on PostgreSQL, API or `db-init`, and the data network internal; memory, no-swap, CPU, pids, dropped capabilities, `no-new-privileges`, log size, read-only root file systems and a non-root API user as configured; no secret value in container configuration or logs; roles owner, runtime and maintenance without superuser, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`; `password_encryption=scram-sha-256`, every non-loopback `pg_hba` rule SCRAM, `max_connections=40`, `shared_buffers=512MB`; the metrics scrape working inside the API container and not from the host; an API restart recovering; a second `db-init` applying nothing; `nginx -s reload` succeeding in the read-only, capability-dropped proxy; and role rotation (the old runtime password rejected, the new one accepted, the recreated API ready);
- mutation check: removing the security-header include from the `/assets/` location made `deploy:verify` fail with "HSTS missing on /assets" (a first mutation on `/api/`, which inherits the server-level headers, correctly did not fail); the file was restored.

Limits and unverified claims:

- one Windows workstation, a self-signed certificate, high ports. Not exercised: a Linux host (bind-mount ownership for uid 1000 is documented, not run), real DNS, a real CA or renewal, ports 80/443, and a journal directory on genuinely off-host storage;
- the resource limits are starting values from the P11 measurements (API RSS peaked near 217 MiB), and the P11 load scenarios ran against a process, not these limits; capacity under them is not re-measured;
- there is no sign-in: local login is forbidden in production and the identity provider is P12.1, so the deployment serves the web app and health checks but cannot authenticate anyone. Sessions remain in process memory;
- not done: a full Content-Security-Policy (needs a browser check against Mapbox), proxy rate limiting (no traffic model), encryption of database traffic inside the host or of the data volume, image signing or scanning, log shipping;
- a README edit through a shell one-liner let the shell interpret backticks and run a few nonexistent commands, all of which failed harmlessly; the README was repaired by hand.

P12.2 is DONE. P12 remains IN PROGRESS. The next stage is P12.1 (blocked on an external decision: which identity provider and protocol, its issuer, client credentials, and redirect URLs) or P12.3 (a backup/restore drill that can be built and timed locally in an isolated environment: encrypted dump to off-host storage, restore into a scratch database, `restore:reapply-deletions`; real-environment RPO/RTO figures still need a target environment).

## P12.3 — encrypted backups, retention, an executed restore drill, and deletion reapplication

P12.1 stays blocked (no identity provider, issuer, client credentials or redirect URLs were chosen; nothing external was created), P12.4 and P12.5 were not started. P12.3 makes steps 1-3 of the SDD restore order (restore, migrate, reapply the deletion journal) executable and rehearses them against real PostgreSQL/PostGIS on this workstation.

Implemented (ADR-0044, `apps/api/src/backup/`):

- `backup:create`: `pg_dump --format=custom` (as an administrator, so row-level security cannot hide rows) -> AES-256-GCM with Node's built-in crypto -> a versioned envelope (magic, header length, strict-schema JSON header authenticated as GCM AAD, ciphertext, tag) -> `running-tracker-backup-<UTC>-<random>.rtbak`, written to a `0600` temp file, fsynced, published with a hard link so an existing file is never replaced, directory fsynced, then read back and authenticated. A failed or empty dump leaves nothing under a backup name. Header fields: format version, algorithm, nonce, creation instant, source database name, PostgreSQL/PostGIS and `pg_dump` versions, migration count and last id; no credentials, tokens, coordinates or run data.
- key handling: `BACKUP_ENCRYPTION_KEY_FILE` (64 hex characters, at most one trailing newline, absolute path, errors never echo contents); `backup:keygen` creates a `0600` file and never overwrites; `backup:create` refuses a key inside the backup directory. The key is intentionally not in `deploy:secrets` or the production env example.
- `backup:prune`: only this tool's file-name pattern and regular files, strictly older than 7 days by the name's timestamp (configurable), never anything newer, keeps the newest backup unless `--allow-remove-last`, prints what it removed. `backup:verify` authenticates a backup and prints only technical metadata; `backup:decrypt` authenticates then writes the archive for `pg_restore` (new file only).
- backup age: `--metrics-file` atomically writes a node_exporter textfile after a successful backup. The API does not read backups and the scrape endpoint is unchanged (a design choice recorded in ADR-0044 and the runbook); wiring Prometheus and an alert is the operator's.
- tool access: real `pg_dump`/`pg_restore`, locally or inside the database container via `docker exec` (`BACKUP_PG_DOCKER_CONTAINER`), password only in the environment, a clear failure if the tool is missing and no fallback.
- `restore:drill`: see ADR-0044 section 7. Fixture runs A (owner-deleted after the backup), B (annual-retention-deleted after the backup), C (survivor) and D (created and deleted after the backup); source migrated one migration short using the unchanged runner; deletions through `deleteRun` (runtime role, tenant context) and `runRetentionDeleteOnce` (maintenance role); the real exporter and sink; a read-only recovery copy of the journal; simulated loss; restore into a fresh isolated database; `migrate.mjs` twice; `runReapplyCli` twice; verification through the owner role. It exits 1, keeps both databases and prints the failed step on any failure.
- safety: drill databases must match `running_tracker_restore_drill[_suffix]`; every drop repeats the check; all URLs must be loopback with the expected logins and no identity-overriding parameters; an ordered `recoverySteps` tracker ends with `current_permissions_restored`, which nothing completes, so the report always says "application access: closed", and the runtime and maintenance logins have `CONNECT` revoked on the restored database.
- one small production-code change: `syncDirectory` in `deletion-journal-sink.ts` is now exported and reused. Nothing in the running API changed.
- docs: ADR-0044, `docs/runbooks/backup-and-restore.md` (new), the deployment and deletion-journal runbooks, README, SDD section 12, `.env.example`, `docs/reports/p12-3-restore-drill.md` and `.json`.

Exact drill commands (repository root, Docker Desktop on Windows, the PostgreSQL 17.5/PostGIS 3.5.2 image already running via `npm run db:up`):

```
npm run backup:keygen -- --out C:/ForMe/Learning/Running_Tracker/.local/backup-keys/restore-drill.key
npm run restore:drill -- --cleanup
npm run restore:drill -- --report-md docs/reports/p12-3-restore-drill.md --report-json docs/reports/p12-3-restore-drill.json
```

Measured results of the final clean-state run (commit 17bbce2 plus the uncommitted P12.3 work; `docs/reports/p12-3-restore-drill.md`):

| Item | Value |
|---|---|
| backup artifact / source database | 146 KiB / 15.9 MiB (the PostGIS extension dominates; a few dozen fixture rows) |
| backup duration | 667 ms |
| restore duration (decrypt + `pg_restore` through `docker exec`) | 281 ms |
| migration duration (1 applied, 19 skipped; second run 0 applied, 20 skipped) | 758 ms |
| journal entries / reapplication duration | 3 / 62 ms |
| first pass | deleted 2, marker_restored 1 |
| second pass | marker_present 3, state identical |
| total recovery duration (loss to verification complete) = measured drill RTO | 3.4 s (SDD target <= 4 hours) |
| measured drill RPO exposure (loss minus backup) | 902 ms (SDD target <= 24 hours) |
| checks | 20 of 20 pass |

These are timings of a workstation rehearsal on a tiny database whose backup was taken seconds before the simulated loss. **They are not a production RPO or RTO, and no production claim is made.**

Verification evidence (final code, repository root, 2026-10-01):

- RED observed first for each module: every new `*.spec.ts` failed on the missing module before its implementation (key, envelope, store/retention, `pg-tools`, safety, orchestration/evaluation, report, CLIs, operator paths); the key test for a missing parent directory failed before the `mkdir`; the CLI decrypt tests failed on the unknown command; the two older-schema orchestration tests failed before the `migrationsBehind` logic.
- `npm run lint`, `npm run typecheck`, `npm run test:migrations` (25 of 25) and `npm run verify` exit 0. Unit tests: API 515 (67 files; about 130 are new, in `src/backup/`), then 82, 14, 14 and 3 in the other workspaces; the production build passes.
- `npm run test:integration`: 33 files, 295 tests pass, including 7 new tests in `test/backup-restore.integration.test.ts` that run the real drill and the real failure paths: a full drill at an older schema; a full drill at the current schema; a damaged ciphertext, a damaged authentication tag, a truncated file and a wrong key (each rejected; for the tag case no `pg_restore` is started and no table appears); a migration checksum mismatch (the drill stops at `migrate`, never reapplies deletions, keeps the databases); a malformed journal file (the drill stops before any restore); an application login still connected (refused); and the runtime login unable to connect to the restored database. They skip when `RESTORE_DRILL_ADMIN_URL` is unset, which includes CI.
- mutation check: removing the "authenticate before streaming" line from the restore operation made the damaged-tag integration test fail (`pg_restore` was spawned); the line was restored. The pure evaluation has a unit test per failure (resurrected row, missing or short tombstone, wrong archive revision, changed survivor, wrong outcomes, non-idempotent second pass).
- the drill leaves the other databases alone: before and after the final run, `running_tracker`, `running_tracker_test` and `running_tracker_load_test` had identical migration counts, table counts and cumulative row-write counters, and the database list was unchanged; no drill database was left after the run.
- `git diff --check` exits 0 (only the existing CRLF notices); no trailing whitespace in the new files.

Failures during development, all fixed:

- the first real drill failed at `delete-after-backup`: fixture run D had `finished_at` before `created_at`, which `runs_finished_state_consistent` forbids (a fixture bug found only by the real database; the failure path correctly exited 1 and kept the databases);
- `backup:keygen` failed when the parent directory did not exist (now created, with a test);
- a test hung because a file-handle write stream with `autoClose: false` never signals completion to `pipeline` (replaced by a path-based stream plus an explicit fsync);
- relative `--report-md` / `--out-dir` paths landed under `apps/api` because npm runs workspace scripts there (now resolved against npm's `INIT_CWD`, with a test); the stray report was removed;
- a GCM tag can fail only after every plaintext byte has streamed to `pg_restore`, which could already have committed; the restore operation now authenticates the whole file first (see the mutation check);
- several of my own shell edits mangled string escapes in a spec (fixed with direct edits), and lint findings (`preserve-caught-error`, unused variables, async generators without `await`) were fixed;
- `.env` did not exist in this checkout, so the integration tests could not have run as they were: a local, gitignored `.env` was created from `.env.example` (development fixtures only) and the drill variables were added to both.

What remains unverified (also stated in the report):

- any production RPO or RTO; a real daily schedule, off-host storage and its durability, backup-age alerting, key custody and loss; restore time for a database of realistic size and on real hardware (a single `pg_restore` stream is used);
- that a retained backup restores (retention trusts file names; use `backup:verify` and the drill);
- the drill runs on the local Docker server only, and CI does not run the drill tests;
- `deploy:verify` was not re-run: no compose profile or image changed (only a comment in `production.env.example`);
- the case "a newer run reused a deleted run's ID" is covered by the existing P10.5 integration tests and was not repeated in the drill.

P12.1 (blocked on an external identity provider decision), P12.4 (current permissions after a restore) and P12.5 (final documentation/demo) were NOT implemented. D09 remains PARTIAL: the mechanism, the journal and now the restore drill with deletion reapplication exist, but restoring current access restrictions (P12.4) does not, and the restored database is deliberately left closed to the application. P12 stays IN PROGRESS. The next stages are P12.1 (when a provider is chosen), P12.4, and P12.5.

## P12.4 — access-restriction journal, current permissions after a restore

P12.1 stays blocked (no identity provider, issuer, client credentials or redirect URLs were chosen; nothing external was created) and P12.5 was not started. P12.3 ended with a restored database that revoked shares and deactivated memberships could still reach: a backup is a snapshot of the past for access just as it is for deletions. P12.4 closes that, with the same idea as the deletion journal (ADR-0045, migration `0020_access_restriction_journal.sql`).

Implemented:

- the sources of current permissions are `memberships.active` and `run_shares`. Shares change through the API (`PUT`/`DELETE /runs/{runId}/shares/{userId}`) and through the cascade of a run deletion; memberships have no application path yet (identity provider, P12.1), so an administrator's SQL changes them. Sessions are in process memory and no credential exists, so there is nothing else to restore;
- row triggers on both tables write `access_restriction_journal` in the changing transaction, for exactly three kinds: `membership_deactivated`, `share_revoked`, `share_narrowed` (with the new two booleans). A grant, a re-activation, a widening and a role change are never journaled; a rolled-back change leaves no row. The application roles hold no privilege on the table; maintenance may only claim and acknowledge batches;
- the export transaction of the deletion journal was extracted (`journal-export.ts`) and both exporters are thin wrappers (the deletion exporter's tests are unchanged and green). `runAccessJournalExportOnce` writes `access-journal-*.ndjson` to the same `DELETION_JOURNAL_DIR` sink on the same interval via one more periodic runner; no new setting;
- `access-journal-format.ts` is a strict discriminated-union reader: there is no kind for a grant, so a forged or stale file cannot express one (tested, and tested again by a real drill that plants a `share_granted` file);
- `app_private.reapply_access_restriction` (owner-only) deactivates, deletes a share, or ANDs a share's booleans with the journaled ones; absent rows are `already_applied`; the existing archive-revision triggers advance the organization's revision and the journal triggers record each change again. `npm run restore:reapply-access -- --journal-dir <copy>` validates all files first, applies each entry in its own transaction, prints counts only, requires the owner login;
- replay is unconditional and order-free (no filtering by the backup's age), so recovery fails closed: a grant made after the backup is not reconstructed, and a share revoked then granted again before the loss is removed again. This is recorded in ADR-0045, the runbook, the report and the README;
- the drill (`restore-drill*.ts`): the source is upgraded to the repository's schema after the backup (a release deployed before the loss; the restored backup then lacks the journal table and function and the unchanged migration runner provides them); after the backup it revokes a share with `revokeRunShare`, narrows one with `upsertRunShare` (both as the owner under the runtime role) and deactivates a member by SQL; it exports both journals, restores, migrates, reapplies deletions, then access, each twice, and probes who can read the surviving run as `running_tracker_runtime` under row-level security (`SET LOCAL ROLE`, no `CONNECT` needed) on the source before the loss, on the restored backup, and on the recovered database. `recoverySteps` gained `access_restrictions_reapplied` and `access_outcomes_verified`; `current_permissions_restored` is now completed by the drill. The database is still left with `CONNECT` revoked and the report says "application access: closed": opening it is an explicit `GRANT CONNECT` in the runbook, never done by a tool;
- docs: ADR-0045, `docs/runbooks/backup-and-restore.md` (steps 8-10, drill description, limits), the deletion-journal and deployment runbooks, README, SDD section 12, the plan, the backlog (D09 RESOLVED for the mechanism and the local drill) and `docs/reports/p12-4-restore-drill.md` and `.json` (the P12.3 report is kept as history). Not changed: `deploy:verify`/compose (no profile or image changed), `.env.example` (no new variable).

Measured results of the final clean-state run (commit 17bbce2 plus the uncommitted P12.3/P12.4 work; `docs/reports/p12-4-restore-drill.md`):

| Item | Value |
|---|---|
| backup artifact / source database | 151 KiB / 15.9 MiB |
| backup duration | 516 ms |
| restore duration (decrypt + `pg_restore` through `docker exec`) | 320 ms |
| migration duration (1 applied, 20 skipped; second run 0 applied, 21 skipped) | 697 ms |
| deletion journal | 3 entries; first pass deleted 2, marker_restored 1; second pass marker_present 3 |
| access journal | 5 entries; first pass applied 3, already_applied 2 (cascade removals of deleted runs' shares); second pass already_applied 5, state and outbox identical |
| who could read the surviving run (source / restored backup / recovered) | grantee, granteeTwo, leaver: no / yes / no; owner, keeper: yes / yes / yes |
| total recovery duration (loss to verification complete) = measured drill RTO | 3.4 s (SDD target <= 4 hours) |
| measured drill RPO exposure (loss minus backup) | 1.5 s (SDD target <= 24 hours) |
| checks | 30 of 30 pass |

These are timings of a workstation rehearsal on a tiny database whose backup was taken seconds before the simulated loss. **They are not a production RPO or RTO, and no production claim is made.**

Verification evidence (final code, repository root, 2026-10-01):

- RED observed first for the 15 new database integration tests (the table did not exist; they passed once migration 0020 was applied), for the format spec (confirmed by moving the module away), and for the sink, exporter, reapplication, evaluation, report and orchestration specs (each failed on the missing module or behavior). Two changes were made together with their spec and were not watched failing first: the `restore-safety` step list and the extraction of the shared export function (the latter is covered by the unchanged deletion exporter spec, which stayed green);
- `npm run verify` exits 0: lint, typecheck, `test:migrations` (25 of 25), unit tests API 574 (71 files), then 82, 14, 14 and 3 in the other workspaces, and the production build;
- `npm run test:integration`: 34 files, 312 tests pass (17 more than before: 15 in `access-restriction-journal.integration.test.ts` and 2 in `backup-restore.integration.test.ts`: a forged grant file stops the drill before any restore, and an extra replay is a no-op), including the full drill at the older and at the current schema;
- mutation check: making `reapplyAccessRestrictions` skip `share_revoked` entries made the real drill fail with `access-first-pass-outcomes, restrictions-applied, recovered-access-matches-source`; the change was reverted;
- `npm run restore:drill -- --cleanup` found no leftover drill database before the final run, and the final run dropped its own;
- `git diff --check` has no whitespace findings (only the existing CRLF notices).

Failures and mistakes during development, all fixed:

- three of my own spec expectations were wrong when first written (the evaluation was right): one asserted "reads added" with a state that did not add a read, one asserted a reactivation against a backup where the member was already active, and the report test assumed a column order the report did not use;
- a `sed` replacement with `\|` in a basic regular expression (alternation) mangled a spec file; I reconstructed it from the known original text and re-ran it (11 of 11). Later edits used script files instead;
- shell heredocs mangled backslashes and quotes in a few patch scripts, so those edits were redone with files written directly.

What remains unverified (also stated in the report):

- any production RPO or RTO; a real daily schedule, off-host storage and its durability, key custody and loss, restore time for a realistic size; the drill runs on the local Docker server only and CI does not run its tests;
- restrictions committed but not yet exported when a node is lost (one export interval while healthy, unbounded while the exporter fails); `TRUNCATE` and a superuser disabling triggers are not journaled;
- credentials and sessions after a restore: none exist yet, and there is no identity provider (P12.1), so no sign-in was exercised;
- membership changes have no application path, so only SQL-driven deactivation was exercised; if P12.1 adds one, the triggers already cover any path through the table;
- the journal rows written for the cascade removal of a deleted run's shares are noise bounded by shares per run; exporter load was not measured.

P12.1 (blocked on an external identity provider decision) and P12.5 (final documentation/demo) were NOT implemented. D09 is RESOLVED for the mechanism and the local drill; no production RPO or RTO is claimed. P12 stays IN PROGRESS. The next stages are P12.1 (when a provider is chosen) and P12.5.

## P12.1 — OpenID Connect sign-in, invite-only identities, the existing session

The provider decision that blocked this stage was made on 2026-10-02: a generic OpenID Connect provider chosen by configuration, not a specific product. No real provider was available, so everything below was verified against an in-process test provider (`oidc-provider`, a test-only dependency) and the production profile with an unreachable issuer. P12.5 was not started.

Implemented:

- configuration (`oidc-config.ts`, wired into `validateEnvironment`): `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (file-capable) and `OIDC_REDIRECT_URI` are required together; in production they are required, `https` only, and the redirect must be exactly `<origin>/api/auth/callback` on an origin in `ALLOWED_ORIGINS`; plain `http` only for a loopback issuer outside production. The raw variables are stripped from the configuration object, which exposes one `OIDC` value;
- `oidc-client.ts`: authorization code, PKCE S256, `state` and `nonce` through `openid-client` 6.8.8, client_secret_basic, lazy cached discovery (so a provider outage never stops startup), fail closed when the provider does not advertise S256, and a split of failures into rejected (validation, OAuth errors) and provider-unavailable (network, timeout, 5xx, non-conforming responses);
- `oidc-login-store.ts`: a bounded, TTL'd, single-use, digest-keyed in-memory record of pending logins; `oidc-http.ts`: `GET /api/auth/login` and `GET /api/auth/callback` (callback URL rebuilt from configuration, 4,096-character query limit, fixed failure codes, success as a 200 meta-refresh page because the session cookie is `SameSite=Strict`, `no-store` and `no-referrer`, a `Lax` login cookie, outcome-only logs). Mounted only when OIDC is configured; the session manager, cookie, CSRF token and logout are the unchanged ones;
- migration `0021_login_identity_resolution.sql`: `app_private.resolve_login_user(text)`, read-only `SECURITY DEFINER`, returns only a user id, executable by the runtime role only; `identity-resolver.ts` maps `<issuer>|<subject>` to a provisioned user. Nobody is created by signing in;
- web: `sign-in.tsx` (a Sign in link as a real navigation, four fixed failure messages, never reflecting URL text), shown when the session is required, and the failure code is removed from the URL after it is read;
- deployment profile: Compose passes `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and the derived redirect URI, takes the secret from `<SECRETS_DIR>/oidc-client-secret` (not generated: the provider issues it), structural guards in `production-profile.test.mjs`, and `deploy:verify` asserts the production sign-in surface;
- ADR-0046, `docs/runbooks/identity-provider.md` (registering the client, provisioning, removing access, troubleshooting), README, `.env.example`, SDD, plan and backlog (D03b).

Verification evidence (final code, repository root, 2026-10-02):

- RED observed first for: the six configuration specs (all failed because `OIDC` did not exist), the login store (module missing), the routes (module missing; after implementation two tests failed only because my test app lacked the request-id and error middleware the real app has, so the harness was fixed), the identity function (module missing), the end-to-end suite (seven route tests returned 404 before the routes were mounted; the two that used the real client directly already passed), the web notice (module missing), and the two compose guards. Two cases were **not** watched failing first: the PKCE-advertisement test was written after the code and instead checked by mutation (disabling the check made it fail; restored), and `oidc-production.spec.ts` passed on its first corrected run;
- `npm run verify` exits 0: lint, typecheck, `test:migrations` 27 of 27 (two new compose guards), API unit tests 601 in 75 files (27 more than before), web 86 (4 more), contracts 14, fixtures 14, simulator 3, and the production build;
- `npm run test:integration`: 36 files, 326 tests pass (14 more: 4 for the identity function, 10 for the full flow against a real provider: login, tenant read under row-level security, logout, unprovisioned identity, altered state, no cookie, callback replay, nonce/PKCE/state mismatch rejected by the real client, wrong client secret, a provider without S256, an unreachable provider);
- `npm run deploy:verify` exits 0 with the new assertions: the API starts and stays ready with an unreachable issuer, `POST /api/session` is 404, `/api/auth/login` answers 503 `IDENTITY_PROVIDER_UNAVAILABLE`, the client secret is a file and appears in neither container configuration nor logs;
- the runbook's provisioning SQL was executed against the test database inside a rolled-back transaction: the identity resolved to the inserted user and the deactivation was journaled.

Failures and mistakes during development, all fixed:

- one full-suite integration run failed `archive-resource-limits` (`allows normal, empty, and exactly 1 MiB raw MVT buffers`, a 10 s timeout); it passed twice alone and in the next full run. I did not establish why it timed out once and do not claim it is understood;
- a `.invalid` issuer in the first production test did not fail at once on this machine (name resolution took longer than the 5 s provider timeout), so the test uses a closed loopback port;
- `oidc-provider` 9 cannot be configured to offer `plain` PKCE, so the PKCE-advertisement test serves a minimal discovery document instead of a real provider;
- `openid-client`'s declaration file does not compile under this repository's `exactOptionalPropertyTypes`; `apps/api/tsconfig.json` now sets `skipLibCheck: true` for the API package only (the base stays false), which relaxes declaration checking for all of that package's dependencies;
- a Bash heredoc with an apostrophe failed to parse (the known shell gotcha), I added a duplicate identifier to `verify-production-profile.mjs` (caught by `node --check`; I had started `deploy:verify` in the same batch, so that first run failed immediately and was rerun), lint rejected unbound-method and unused-variable patterns I had written, and two existing tests that build a valid production configuration needed the new required settings.

What remains unverified (also stated in ADR-0046 and the runbook):

- any real identity provider (Keycloak, Google, Auth0 or another), real TLS to a provider, provider key rotation, clock skew, and issuer-spelling differences; a real browser (the `SameSite` and meta-refresh reasoning was not exercised in one); load;
- a person disabled at the provider keeps an existing application session until `SESSION_TTL_MS` (8 hours by default) or an API restart; deactivating the membership applies at the next request. No provider-side re-validation, no RP-initiated logout, no shared session store;
- a flood of `GET /api/auth/login` can fill the 100-entry pending store for ten minutes (503 until it drains); request-rate limiting is not built, and the proxy is where it belongs;
- provisioning people is manual SQL by design for now; the SDD status header was not rewritten (P12.5).

P12.1 is DONE. D03b is RESOLVED for the mechanism, not for any real provider. P12 stays IN PROGRESS. The next stage is P12.5 — update the README, SDD, API specification and progress to match what is implemented, and prepare the final demo.

## P12.5 — documentation matched to the implementation, API specification, local demo

Scope: bring the README, SDD, API specification, backlog and plan in line with what is built, and prepare the final demo. The question the previous stage left open (how the demo signs in) was not answered by the user; I chose the development session because it needs nothing external, and the demo and its runbook say so. A real provider (Keycloak in Docker was the suggested option) was not tried.

Done:

- **OpenAPI** (`packages/contracts/src/openapi.ts`, regenerated artifact): added `GET /api/auth/login` and `GET /api/auth/callback` as unauthenticated browser redirects (a 302 with a `Location` and the login cookie; a 200 HTML page on success, because a redirect chain begun at the provider would not carry the `SameSite=Strict` session cookie; failures as a 302 with one of four fixed codes), stated to exist only when OIDC is configured.
- **Spec drift found and recorded**: three operations in the SDD and the OpenAPI document were never built and answer `404 ROUTE_NOT_FOUND`: `GET /runs/{runId}/track`, `GET /archive/runs`, `GET /live/nearby` (archive display uses metadata plus tiles, live positions use SSE; no stage ever owned them). They are kept as the intended contract, flagged `x-implemented: false` in OpenAPI and "not implemented" in SDD §11.3. `apps/api/test/openapi-routes.spec.ts` builds the real app and requests every documented operation: a documented operation that is not mounted fails, and so does a flagged one that has become mounted, and the flagged set must be exactly those three. The reverse direction (a mounted route missing from the document) was checked by reading the route files once, not by a test.
- **SDD**: the status header (it still listed P00–P09 and P10.1–P10.4), §11.0 (the sign-in routes, "forbidden in production until a pool/listener exists", "the production provider remains P12"), §11.3, a §12 sentence that said no credential exists yet, and §17's identity-provider bullet.
- **README**: the opening paragraph (it said retention and production identity were later stages), "managed certificates ... remain P12", "external production authentication remains P12", and the contract note; it now links the demo.
- **Backlog D07**: PARTIAL → RESOLVED. The SDD header already said the cache part was resolved in ADR-0030 and the backlog had not caught up. D10 (real-world GPS tolerances) is TODO and I did not touch it: no stage produced evidence for it.
- **Demo**: `npm run demo:seed` (one organization, a runner and a coach in the plain `running_tracker` development database as the owner role; refuses any other database, any non-loopback host, any other role; idempotent), `npm run demo:run` (the runner played over HTTP: development session, run, a live+history share with the coach, a simulated 4 m/s loop sent in real time at two-second intervals, finish, wait for the summary; loopback-only; Ctrl+C finishes the run), and `docs/runbooks/demo.md`. The pure parts are in `scripts/demo-plan.mjs` with nine tests.
- ADR-0043, 0044 and 0045 still contain sentences such as "production has no sign-in until P12.1". They were true when written and I left accepted ADRs unedited.

Verification evidence (final code, repository root, 2026-10-02):

- RED observed first for: the contracts sign-in test (the paths did not exist), the nine demo-plan tests (module missing), and the route-coverage spec (exactly the three unmounted routes and the exact-set assertion failed; the other 21 operations, including both sign-in routes, passed). `demo-seed.mjs` and `demo-run.mjs` have no unit tests; they were exercised by running them.
- `npm run verify` exits 0: lint, typecheck, scripts/migration tests 36 (9 new), API unit tests 626 in 76 files (25 more), web 86, contracts 15 (1 more), fixtures 14, simulator 3, and the production build. I did not rerun `test:integration` or `deploy:verify`: no runtime code changed (only the spec document, one new unit spec, scripts and documents).
- The demo was run against a real API and PostgreSQL on this workstation (the development database was behind the repository and `db:migrate` applied the pending migrations through 0021 first): the seed; sign-in through the Vite proxy on 5173 (201, `HttpOnly` `SameSite=Strict` cookie); three scripted runs (12, 8 and 8 points) that the coach's SSE stream saw, with no runs before, then the position first `unconfirmed` (one point is not an edge) and `confirmed` afterwards, with the run leaving the live state when it finished; the summary published for every run (for example 0.06 km over 14 s for eight points, 0.09 km over 22 s for twelve); archive revision 3 after three finished runs; and a 206-byte, non-empty vector tile at zoom 16 over the loop.

Failures and mistakes during development, all fixed:

- the first coach check I wrote assumed the wrong shape for the position object and crashed after the first run event, which I first read as the stream ending early; the second attempt printed the raw event and showed the stream was fine;
- the first draft of the runbook's troubleshooting table quoted three error codes from memory (`ORGANIZATION_NOT_FOUND`, and 400/401 for an unlisted user and a wrong origin). I then called the API: the real answers are `ORG_ACCESS_DENIED`, `LOCAL_IDENTITY_DENIED` and `ORIGIN_DENIED`, all 403, and the table now says that. A sentence suggesting an experiment I had not run (a share without live access) was replaced by a pointer to the access suites;
- `packages/contracts/openapi/openapi.json` appeared as modified in `git status` at the start of this stage although `git diff` showed no content change. It was a stale index entry under `core.autocrlf` (the working copy and the index are both LF), not an edit; after regeneration the diff is only the real additions. The earlier hand-off note calling it a build-step line-ending change was a guess that I have not confirmed;
- a Bash heredoc with an apostrophe failed to parse once more (the known shell gotcha); the text was written with the Write tool instead.

What remains unverified or not done:

- **The browser steps of the demo**: the sign-in snippet run in a console, the Coach and Archive tabs, the Sign in notice, and any rendering of the archive map (it needs a public `VITE_MAPBOX_ACCESS_TOKEN`, which this workstation does not have). Everything the browser would call was exercised over HTTP instead.
- The demo does not use OpenID Connect and its runner is a script. A real provider (Keycloak in Docker) was not tried, so the sign-in claim of P12.1 is unchanged: verified against a test provider only.
- The demo left data in the development database: the demo organization and users, and three finished runs with summaries. `LOCAL_AUTH` was passed to the API process through its environment only; `.env` was not changed.
- Production gaps recorded in `docs/runbooks/deployment.md` and ADR-0046 stand: rate limiting at the proxy, a full Content-Security-Policy, session re-validation against the provider, and a real host, CA, schedule, key custody and capacity.
- D10 is open; no production RPO or RTO is claimed.

P12.5 is DONE. P12 is DONE as a workstation-verified stage; its production claims remain limited as above. There is no further stage in the plan.

## Browser E2E findings

> **Update 2026-10-03:** both reload findings below were ruled defects and are fixed; see "Browser reload resilience and E2E completion" at the end of this file. The text below is kept as the record of what was observed before the fix, including the workaround test that has since been deleted.

- The simulator capture source could not run in a real browser. `SimulatorCaptureSource` (`apps/web/src/capture-source.ts`) stored the global `setTimeout` and `clearTimeout` in private fields and called them as `this.#setTimer(...)`, so the native function received the source object as `this` and Chromium threw `TypeError: Illegal invocation`. The Runner showed "Capture stopped: Illegal invocation" and the Capture card went to `error` on the first start with the simulator. The unit tests inject fake timers and never saw it.
- Found by the first browser scenario, `tests/e2e/record.spec.ts`, and confirmed in isolation in Chromium. Fixed in a separate commit, 1e0e011 (`fix(web): call the default timers without the capture source as receiver`): the defaults are bound to `globalThis`. Its unit test stubs the global timers with receiver-checking functions and fails without the fix. The e2e scenario is the end-to-end regression proof.
- Reload mid-run (spec scenario 2) showed two web-app defects (first thought to be for the maintainer to rule on as defects or accepted limits; ruled defects and fixed on 2026-10-03). Both were measured in Chromium against the real app by `tests/e2e/reload-offline.spec.ts`, with 1 point acknowledged before the reload.
  - **The tab conflicts with its own lease after a reload, and nothing retries.** `WriterLeaseCoordinator` (`apps/web/src/writer-lease.ts`) releases its lease only when the React effect is disposed, which a reload does not run. The lease (15 s, renewed every 5 s) stays live in IndexedDB, so the reloaded page shows Writer `conflict` ("Another tab may own recording") and Capture `idle`. Observed: `conflict` from 0.3 s to 16.0 s after the reload, `owned` at about 17.6 s when "Retry ownership" was clicked every 1.5 s. The claim effect reruns only when the run or an error changes, so without a click it stays in `conflict`.
  - **The capture source is not persisted, so the Simulator is not restored.** `captureSourceKind` is React state that starts as `geolocation` (`apps/web/src/App.tsx`), and the "Capture source" select is disabled while the run is `recording`. After a reload and a re-claim the app captures from Device GPS. With no geolocation permission (the default in the e2e browser) the Capture card goes to `error` ("Location permission was denied. Choose the simulator or allow location access.") and no more points arrive. With permission and a fixed position, capture resumes.
  - What holds today: after the re-claim the run is still `recording`, the pre-reload point is kept, new points continue the sequence (seq 1 then 2: no reuse, no gap) and the buffer drains. This is the passing test `reload: after re-claiming ownership the run continues without losing or reusing a sequence` (lets the Simulator finish and the buffer drain, grants geolocation, reloads, waits for the conflict, clicks "Retry ownership" until `owned`, then needs a Device GPS point above the earlier max seq; about 32 s).
  - The spec'd test `reload (needs lease auto-recovery and a persisted capture source ...)` stays `test.fixme` with its assertions unchanged (Writer `owned` right after the reload, a Simulator run that completes). Decided on 2026-10-03: both are defects. The product was fixed, the `fixme` test is now an ordinary passing test and the passing sibling (the Retry ownership workaround) was deleted.

## Browser reload resilience and E2E completion (2026-10-03)

Both reload findings under "Browser E2E findings" were ruled defects and fixed. The browser suite from the previous plan was also brought to its planned end (mutation checks, README, status of the plan). ADR-0047 records the design.

**The two defects and their root causes**

1. *A reload conflicted with its own lease for about 17 s.* The lease lives in IndexedDB for 15 s after its last renewal and was released only by React cleanup, which a reload never runs. The new page has a new random owner id, so `acquireWriterLease` correctly saw a live lease of "another tab", and nothing retried.
2. *The Simulator was not restored.* `captureSourceKind` was React state starting at `geolocation`; the select is disabled while recording; the resumed run therefore started Device GPS, which fails without permission.

**Design (details and invariants in ADR-0047)**

- *Writer reload recovery.* Each coordinator holds a Web Lock named after its random owner id for the life of its document (`writer-presence.ts`); the browser drops it when the document is destroyed, with no cleanup involved. A claimant that meets a live lease waits, bounded to 3 s and event-driven (no polling), for that owner's lock. If it frees, `acquireWriterLease(..., [holder])` replaces exactly that owner inside the same IndexedDB transaction with a higher fencing token. Fencing checks in renew, release, segment allocation and point append are unchanged.
- *Second-tab protection.* A live second tab, or a copy of one, never frees the lock, so it reports `conflict` after the bound and stays read-only. No identity is reused: a per-tab id in `sessionStorage` was rejected because "Duplicate tab" copies `sessionStorage`, which would give two live documents the same owner id and, through the existing same-owner branch, the same fencing token. Without Web Locks the behaviour is the previous one (wait for expiry).
- *Capture source.* An optional `captureSource` in the existing `profiles` record (no schema bump), preserved by every profile rewrite, validated on read with a Device GPS default for old or invalid records. In `App` the source is `null` until restored and capture requires it, set in the same batch as `storage-restored`, so Device GPS cannot start first.

**Measured:** from the start of a reload to Writer `owned`: 199, 197 and 232 ms (three reloads, one run); before, about 17 s plus a manual click.

**Tests**

- RED observed first. Unit: the new specs failed on missing modules and methods (`capture-source-kind`, `writer-presence`, `saveCaptureSource`, the replaceable-owner argument and the coordinator `presence` option). Browser: the rewritten reload test, run against the original `App.tsx`, `writer-lease.ts` and `runner-storage.ts` (stashed), failed with Writer stuck at `conflict` for the 10 s bound; run with only the source restore neutered, it failed at `expectSimulatorSelected` (select showed `geolocation`).
- Not red first: the copied-`sessionStorage` second-tab test (the app never used `sessionStorage`, so it passes by construction and is a regression guard), and the upload-failure test (written after mutation A showed the gap; it passed on clean code and failed under the mutation).
- Unit: web 111 tests (24 new), all passing; `npm run verify` exit 0 (lint, typecheck, `test:migrations` 36, API 626, web 111, contracts 15, fixtures 14, simulator 3, production build); `npm ci --dry-run` exit 0.
- Browser, Chromium, Node 24.11.1 / npm 11.6.2, dedicated `running_tracker_test` database through the unchanged environment guard: `npm run test:e2e` 27 passed in 1.7 min (about 1 m 45 s wall; the deliberate `test.fail()` in the harness suite is one of the 27). The clean-code result for every file (`record` 1, `reload-offline` 3, `second-tab` 2, `coach-live` 2, `environment`, `harness`, `smoke`) is that one full run; `record`, `reload-offline` and `second-tab` were also run on their own during development, and `coach-live` on its own only under mutation C.
- Replaced: `test.fixme` reload test is now the ordinary `reload: a recording Simulator run recovers on its own and keeps its sequence` (reload, Writer owned within 10 s, no Retry ownership button, Simulator selected, Device GPS never used (a spy on the Geolocation API over the whole context), capture completes, buffer drains, run finishes, server sequences unique and gap-free and the acknowledged prefix intact). The 90 s workaround test that clicked Retry ownership was deleted; it only documented the defect.
- Added: `upload failure: points of a failed send are kept and delivered exactly once...` (503 on the points endpoint while the browser is online) and a second-tab variant whose page inherits the first page's `sessionStorage`.

**Mutation checks** (each applied to clean committed code, run, observed, reverted; `git status` clean after each)

| Mutation | Test run | Result |
|---|---|---|
| A. `point-upload-worker.ts` acknowledges (deletes) the batch before awaiting `send` | `reload-offline.spec.ts` as it was | **Not detected**: both tests passed. The offline test never fails a send (the uploader stops while the browser is offline). This was a real gap in the previous suite. |
| A, after adding the upload-failure test | `reload-offline.spec.ts` | Upload-failure test FAILED in `expectUniqueAndGapFree`: server sequences `[1, 4, 5, 6]`, seq 2 and 3 missing. The other two tests still passed. |
| B. `writer-lease.ts`: a competing claimant is made to succeed | `second-tab.spec.ts` | Both tests FAILED at `expectReadOnly`: Writer expected `conflict`, received `owned`. |
| C. `live-state.ts`: an org's last non-empty live state is served when the current one is empty (a revoked run stays in the stream) | `coach-live.spec.ts` | Revoke test FAILED at `coach.markers()` `toHaveCount(0)`: 1 marker; the "appears live" test passed. |
| D (extra). `App.tsx` ignores the stored capture source | reload test | FAILED at `expectSimulatorSelected`: `geolocation`. |

The server filters live runs with row-level security inside the query, so mutation C wraps `readLiveState` instead of changing the SQL.

**Mistakes and deviations**

- My first duplicate-tab test called `runId` before the start was acknowledged and failed; fixed by waiting for `recording`.
- The first `geolocation-spy` typed its loop generically and failed typecheck and lint; rewritten explicitly with a scoped `unbound-method` exemption.
- The updated expectations of two existing exact-shape `loadRecovery` assertions (they now include `captureSource`).
- `docs/superpowers/plans/2026-10-02-browser-e2e.md`: checkboxes were all unchecked although tasks 1 to 6 were committed. They are now reconciled with the commits and the runs above; RED-first steps of tasks 1 to 6 that cannot be evidenced from the repository stay unchecked with a note, not claimed.

**Remaining browser limitations**

- Chromium only. Firefox, WebKit, mobile and device behaviour (background throttling, real GPS and permission prompts) are not verified; Web Lock release timing on navigation was observed only in Chromium, and a back/forward cache is not covered.
- Chrome's "Duplicate tab" cannot be driven by Playwright; the test models inherited `sessionStorage` only.
- A genuine second tab shows Writer `acquiring` for up to 3 s before `conflict`.
- A tab on an older build holds no lock and is treated as gone by a newer tab; it is fenced at its next renew or append.
- No real OpenID provider, no real GPS, no Mapbox rendering; the suite is not part of `npm run verify`. A separate `browser` job was added to `.github/workflows/ci.yml` afterwards (own PostGIS service, `npm run build`, `playwright install --with-deps chromium`, `npm run test:e2e`, test-results uploaded on failure). It has never run on a GitHub runner: I could only reproduce its commands locally from a checkout without `dist/` (build, then `smoke` and `record` passed), so CI browser coverage is not claimed.
- The sequence of the Simulator restarts after a reload (a new segment with six more points), by design of the source.
