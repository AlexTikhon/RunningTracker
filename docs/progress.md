# Implementation progress

Last updated: 2026-09-26.

| Stage | Status | Result |
|---|---|---|
| P00 | DONE | Repository root, source documents, environment, ADR, and decision backlog established |
| P01 | DONE | Reproducible Express 5/API/web workspace, persistent PostgreSQL/PostGIS, migrations, health, and CI commands verified after P01.1 review fixes |
| P02A | DONE | DB roles, identity/organization schema, tenant transaction helper, and baseline RLS verified under runtime-role |
| P02A.1 review fixes | VERIFIED | Integration fixture target guard and confirmed-COMMIT handling passed unit and real-role integration checks |
| P02B | DONE | All six run child/access tables, D02 ACL matrix, and D01 canonical `PointInput`/retry semantics passed real PostgreSQL/PostGIS role integration |
| P03 | DONE | P03.1–P03.5 session/security, contracts, run lifecycle/read/share APIs, and clock-driven auto-finish verified |
| P04 | DONE | Bounded atomic ingestion, revision-bound raw history, deterministic GPS simulation, and test-safe post-commit response-loss verification passed |
| P05 | IN PROGRESS | P05.1 controls/state, P05.2 durable IndexedDB buffer, and P05.3 upload/reconciliation complete; writer ownership and capture remain |
| P06 | TODO | Geometry and archive summaries |
| P07 | TODO | Versioned snapshot and changes |
| P08 | TODO | SSE and coach screen |
| P09 | TODO | MVT, cache, and archive map |
| P10 | TODO | Retention, deletion, and maintenance |
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
