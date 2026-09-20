# Implementation progress

Last updated: 2026-09-19.

| Stage | Status | Result |
|---|---|---|
| P00 | DONE | Repository root, source documents, environment, ADR, and decision backlog established |
| P01 | DONE | Reproducible Express 5/API/web workspace, persistent PostgreSQL/PostGIS, migrations, health, and CI commands verified after P01.1 review fixes |
| P02 | TODO | Product schema, roles, RLS, and access matrix |
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

## P02 prerequisites

P02 may start only after P01 verification is complete. Its scope begins with business migrations and database roles. It must resolve D01 where schema representation is involved and D02 in full; integration tests must execute as the non-owner runtime role. No P02 schema or RLS is implemented in the current stage.
