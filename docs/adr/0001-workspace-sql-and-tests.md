# ADR-0001: npm workspace, direct SQL migrations, and real PostGIS tests

- Status: accepted; framework choice in item 2 superseded by ADR-0002
- Date: 2026-09-19
- Scope: P00–P01

## Context

The original SDD called for one modular monolith, a React client, NestJS API, PostgreSQL/PostGIS, explicit SQL, and later RLS/security tests. The project was new and had no repository conventions to preserve. ADR-0002 later replaced only the NestJS choice; the workspace, database, migration, and test decisions below remain active.

## Decision

1. Use npm workspaces with `apps/api`, `apps/web`, and framework-independent `packages/contracts`. Do not add Nx/Turborepo until measured build or orchestration needs justify it.
2. Use Node 24 LTS, strict TypeScript, React/Vite, and NestJS. This historical framework choice is superseded by ADR-0002. Pin dependency resolution in `package-lock.json`; pin the PostGIS container by version and digest.
3. Access PostgreSQL through `pg` and parameterized SQL. Do not add an ORM: the critical design depends on explicit transactions, RLS, locking, and PostGIS expressions.
4. Use a small sequential SQL migration runner. It applies immutable files in lexical order, stores SHA-256 checksums, uses an advisory lock, and wraps each migration in a transaction.
5. Separate fast unit tests from integration tests. Integration tests use the real `running_tracker_test` PostGIS database and reject a URL whose database name does not end in `_test`.

## Consequences

- Database behavior stays visible and testable under the exact roles introduced in P02.
- Schema changes require forward-only SQL and explicit rollback/recovery decisions; generated ORM migrations are unavailable.
- A single repository command set works locally and in CI, but Docker is required for integration evidence.
- `packages/contracts` must remain independent from the server framework, `pg`, secrets, and infrastructure code.
