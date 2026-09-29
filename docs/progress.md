# Implementation progress

Last updated: 2026-09-29.

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
| P10 | IN PROGRESS | P10.1–P10.3 bounded raw purge, eligibility, summary serialization, restart-first scheduling, and owner/annual deletion with atomic tombstone/archive revision verified; tombstone lifetime/late-retry contract remains |
| P11 | TODO | Load verification and operational limits |
| P12 | TODO | Production auth and recovery |

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
