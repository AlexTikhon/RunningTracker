# ADR-0002: Express 5 with explicit dependencies and lifecycle

- Status: accepted
- Date: 2026-09-19
- Scope: P01.1 and later backend stages
- Supersedes: the NestJS framework choice in ADR-0001 item 2

## Context

The P01 NestJS scaffold preserved the required HTTP behavior, but configuration and database construction were tied to module evaluation and framework DI. This caused the integration suite to capture `DATABASE_URL` before it selected `TEST_DATABASE_URL`. Review also found that readiness bounded connection acquisition but not a query whose connection was already established, while framework shutdown hooks did not provide a bounded fallback.

The project is intended to expose backend architecture mechanics for study. It benefits from visible dependency construction, configuration boundaries, and lifecycle control. There is no measured evidence that changing the framework improves application performance, so performance is not a reason for this decision.

## Decision

1. Use pinned Express 5 with strict TypeScript. Remove NestJS, decorator configuration, `reflect-metadata`, and direct RxJS usage.
2. `createApp({ config, pool, clock })` is an import-safe composition root for HTTP routes and middleware. It neither opens a port nor creates infrastructure dependencies.
3. `main.ts` explicitly loads and validates configuration, creates `pg.Pool`, creates the app and HTTP server, binds the port, and registers signal handling. The executable entrypoint is the only import with startup behavior.
4. Keep routes, environment loading, database probing, and shutdown lifecycle in small concrete modules. Do not introduce a DI container or empty business layers.
5. Keep separate connection-acquisition and query deadlines. A timed-out query releases its client with an error so `pg` destroys the connection instead of returning a still-busy slot to the pool.
6. Graceful shutdown first stops accepting HTTP traffic, then closes the pool within one shared deadline. The fallback closes remaining HTTP connections and terminates the process with a failure status if resources do not close in time.

## Consequences

- Tests construct the exact app and pool they need; test configuration is validated before either is created.
- Infrastructure ownership and shutdown order are explicit and can be regression-tested without framework hooks.
- Cross-cutting behavior previously supplied by NestJS must be added deliberately as concrete Express middleware when required.
- Future P02 modules should receive dependencies through factory arguments and should not read process environment or open connections during import.
