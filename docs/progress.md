# Implementation progress

Last updated: 2026-09-20.

| Stage | Status | Result |
|---|---|---|
| P00 | DONE | Repository root, source documents, environment, ADR, and decision backlog established |
| P01 | DONE | Reproducible Express 5/API/web workspace, persistent PostgreSQL/PostGIS, migrations, health, and CI commands verified after P01.1 review fixes |
| P02A | DONE | DB roles, identity/organization schema, tenant transaction helper, and baseline RLS verified under runtime-role |
| P02A.1 review fixes | IMPLEMENTED, NOT VERIFIED | Integration fixture target guard and confirmed-COMMIT handling added; checks intentionally not run in this iteration |
| P02B | IN PROGRESS — PARTIAL, NOT VERIFIED | `runs`, `run_shares`, constraints, minimal grants, and non-recursive ACL/RLS implemented; child tables and full D02 matrix remain |
| P03 | TODO | Session boundary, commands, and API contracts |
| P04 | TODO | Ingestion, raw history, and GPS simulator |
| P05 | TODO | Browser recording and local buffer |
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

Limits and P02B readiness:

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

Verification status:

- no tests, lint, typecheck, build, dependency installation, Docker command, migration, or database connection was run for P02A.1, as required for this iteration;
- the P02A verification evidence above is historical and was not repeated after these corrections;
- P02A.1 remains unverified until the focused unit/static checks and real-PostgreSQL integration scenario are executed.

## P02B — first bounded runs/shares fragment

Implemented:

- forward-only `0002_runs_shares_rls.sql` creates only `runs` and `run_shares` with composite tenant keys, same-organization membership FKs, SDD state/revision/time checks, the global one-active-run partial unique index, and the required list/finished indexes;
- runtime grants are explicit: `runs` has SELECT/INSERT and column-limited lifecycle UPDATE without DELETE; `run_shares` has SELECT/INSERT/UPDATE/DELETE; maintenance receives no additional access;
- owner reads and writes its run, while an active grantee reads unfinished runs through `can_read_live` and finished runs through `can_read_history`; coach role alone grants nothing;
- only a run owner mutates shares, while direct `run_shares` reads expose only owned-run grants or the current grantee's own rows;
- two narrow owner-executed boolean predicates with fixed `pg_catalog` search paths and no PUBLIC EXECUTE remove the `runs` ↔ `run_shares` policy recursion described by D02;
- integration fixtures and runtime-role scenarios cover owners, grantees, unrelated and inactive members, multi-organization membership, all grant/status combinations, revocation, prohibited grantee mutations, owner/org reassignment, cross-tenant FKs, direct share reads, and the global second-active-run rejection;
- ADR-0004 records the bounded ACL semantics and why D02 remains partial.

Verification status:

- no test, lint, typecheck, build, Docker, migration, or database command was run for this fragment, as required for this iteration;
- static review covered migration ordering, SQL policy direction, grants, fixture cleanup order, TypeScript imports/types, and scenario-to-requirement mapping;
- the P02A evidence above remains historical and is not evidence for P02A.1 or this P02B fragment.

Remaining P02B scope:

- `run_points`, `run_commands`, `run_summaries`, and `run_tombstones` plus their constraints and indexes;
- direct child-table ACL and cross-tenant tests completing D02;
- D01 canonical PointInput representation and executable verification of the complete stage.

Next work remains P02B after targeted verification of P02A.1 and this fragment. P03 was not started.
