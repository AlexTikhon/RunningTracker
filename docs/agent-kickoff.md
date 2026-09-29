# First assignment for the coding agent — Running Tracker P00–P01

Work in the user-selected Running Tracker repository. If the repository or target directory is not yet specified, clarify only that first; do not pick a random existing project and do not use the documents folder as the application root without justification.

Source documents:
- C:/Users/optim/Documents/Codex/2026-09-19/vyt/outputs/running-tracker-sdd-v1.0.md
- C:/Users/optim/Documents/Codex/2026-09-19/vyt/outputs/running-tracker-implementation-plan-v1.0.md

Read both documents and the repository instructions. Execute only P00 and P01 from the plan: environment verification and bootstrapping a reproducible skeleton. Product scope — a future React/TypeScript + NestJS + PostgreSQL/PostGIS Running Tracker.

Start by inspecting the working directory and git status. Preserve any existing changes. For a new empty repository, use the proposed workspace structure; for an existing one, adapt to its established conventions.

Move the SDD and the plan into docs/SDD.md and docs/implementation-plan.md, create docs/progress.md and short ADRs for significant technical decisions. Verify supported versions against official documentation, and pin lockfile and container image versions.

Required outcome:
1. Minimal React web and NestJS API run.
2. PostgreSQL/PostGIS runs locally with a persistent volume.
3. There is a migration runner, a separate test database, and a PostGIS check.
4. Liveness/readiness, validated config, and graceful shutdown work.
5. Same-origin /api is configured in development, along with lint/typecheck/build/test commands.
6. The README allows reproducing the setup from a clean checkout.
7. Progress contains real verification results and P02 prerequisites.

Work autonomously within this scope: implement, verify, and fix issues you find. Make ordinary technical decisions on your own and document them. If a required system component or permission is missing, name the specific blocker and stop the independent work rather than presenting unverified work as done.

Do not implement business tables/RLS, ingestion, GPS logic, SSE, tiles, production auth, or public deployment in this assignment. Do not add Redis, Kafka, Kubernetes, or an ORM without a confirmed need. Do not create a remote repository or publish changes to external services.

Finish with a report: what runs, which checks actually passed, what is constrained by the environment, what decisions were made, and what will be implemented in P02. Do not automatically proceed to P02.
