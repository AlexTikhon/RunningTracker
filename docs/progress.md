# Implementation progress

Last updated: 2026-09-19.

| Stage | Status | Result |
|---|---|---|
| P00 | DONE | Repository root, source documents, environment, ADR, and decision backlog established |
| P01 | DONE | Reproducible workspace, API/web, persistent PostgreSQL/PostGIS, migrations, health, and CI commands verified |
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

## P01 — working scaffold

Implemented:

- npm workspaces, strict TypeScript, exact dependency versions, and lockfile generation path;
- React/Vite status page and development proxy for same-origin `/api`;
- NestJS API with validated environment, PostgreSQL pool, liveness, readiness, and shutdown hooks;
- pinned PostgreSQL 17/PostGIS 3.5 Compose service with persistent named volume and isolated test database;
- checksum/advisory-lock SQL migration runner and initial PostGIS extension migration;
- unit and real-PostGIS integration suites plus portable CI workflow.

Verification evidence:

- `npm ci` — clean lockfile installation succeeded; 321 packages audited, 0 vulnerabilities;
- `npm run verify` — lint passed; strict typecheck passed for API/web/contracts; 5 unit tests passed; all production builds passed;
- `npm run db:up` — pinned image pulled, named volume created, container reached healthy state on `127.0.0.1:5433`;
- `npm run db:migrate` and `npm run db:migrate:test` — migration applied to main and test databases; repeated execution reported `skip` with the same checksum;
- `npm run test:integration` — 2 tests passed against real `running_tracker_test`;
- direct SQL — PostgreSQL `17.5`, PostGIS `3.5.2`; `PostGIS_Full_Version()` succeeded;
- dev smoke — web document returned 200; direct liveness/readiness returned 200; Vite-proxied `/api/health/ready` returned 200;
- database failure path — after stopping PostgreSQL, readiness returned 503 with `database=down`, while liveness remained 200; readiness returned 200 after recovery;
- shutdown — after terminating `npm run dev`, ports 3000 and 5173 had no listeners;
- `docker compose ... config --quiet` and `git diff --check` — passed;
- SHA-256 of all three copied source documents exactly matched their supplied originals.

Decisions and corrections:

- port 5433 avoids an unrelated listener already using 5432;
- Nest constructor dependencies use explicit `@Inject` tokens so the `tsx` development path does not rely on emitted decorator metadata;
- a vulnerable transitive `shell-quote` path was removed by updating `concurrently` to 9.2.4; the final audit is clean.

Limitations:

- the GitHub Actions workflow was defined but not executed on a hosted runner; its underlying commands and Compose configuration passed locally;
- Docker Desktop must be running for database and integration commands;
- the pinned image digest is Linux amd64-specific;
- local fixture credentials are intentionally non-production, and no deployment/secrets/auth work is part of P01.

## P02 prerequisites

P02 may start only after P01 verification is complete. Its scope begins with business migrations and database roles. It must resolve D01 where schema representation is involved and D02 in full; integration tests must execute as the non-owner runtime role. No P02 schema or RLS is implemented in the current stage.
