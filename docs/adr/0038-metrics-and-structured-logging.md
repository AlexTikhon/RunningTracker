# ADR-0038: In-process metrics, a separate scrape listener, and allow-list logging

- Status: accepted; P11.1 implemented and locally verified
- Date: 2026-09-29
- Scope: P11.1 only. Load datasets, load runs, EXPLAIN evidence, and optimizations are P11.2–P11.5.

## Context

SDD section 15 lists the signals the system must expose (commit latency, duplicates and
conflicts, live-cycle duration, SSE backpressure, tile bytes/time/hit ratio, pool wait,
purge failures) and requires that logs carry request IDs and technical identifiers but no
GPS, payload, or session tokens. Before P11.1 the code wrote free-form `console.*` lines
(one of them passed a whole error object, whose message can embed connection strings or
row values), and nothing was measurable. P11.3 and P11.4 need trustworthy numbers, so the
instrumentation has to exist, and be safe, before any load is generated.

## Decision

1. **A small in-process registry, no dependency.** `MetricsRegistry` provides counters,
   gauges, and fixed-bucket histograms and renders Prometheus text (version 0.0.4). The
   instruments are code-defined in `api-metrics.ts`. Collectors refresh gauges (pool state,
   tile cache and scheduler state, memory, event-loop delay) when the endpoint is scraped, so
   no timer is added. A `prom-client` dependency was not needed for three instrument kinds and
   would add a supply-chain surface for no measured benefit.
2. **Bounded cardinality by construction.** Label values come from code vocabularies, never
   from identifiers, coordinates, or user input. HTTP `route` is the request path with UUID
   segments and numbers replaced (`/api/orgs/:uuid/runs/:uuid/points`) and is the single value
   `unmatched` for anything that matched no route. Every metric also has a series cap
   (default 100); further combinations fold into one `_overflow` series and increment
   `metrics_series_overflow_total`, so a scanner or a labelling mistake cannot grow memory.
3. **A separate listener.** `GET /metrics` is served by its own `http.Server` on
   `METRICS_HOST` (default `127.0.0.1`) and `METRICS_PORT` (unset means disabled; it must
   differ from `PORT`). It has no session, tenant, or CORS surface, serves nothing else, and a
   failed bind fails startup rather than running unobserved. Who may scrape is a network
   decision (bind address, firewall, proxy), not something an application role can grant.
4. **Logs are allow-listed, not filtered.** `createLogger` writes one JSON line and keeps only
   fields on a fixed allow-list (`requestId`, `route`, `status`, `durationMs`, `task`,
   `errorName`, `errorCode`, `orgId`, `runId`, and a few counters). Anything else is dropped
   and only counted in `droppedFields`, so a new sensitive field is safe by default instead of
   safe only if someone remembers a deny pattern. Values must be primitives and are truncated.
   Errors are described by class name and a short code (`describeError`, for example a
   SQLSTATE) and never by message or stack. Logging cannot throw into the caller.
   The default sink still uses the `console` methods so container log routing and test spies
   keep working.
5. **One failure line per failed request.** The HTTP middleware logs only responses with
   status 500 or more, once, with the request ID, route template, duration, and the error
   class and code stored by the shared error handler. Successful requests are counted, not
   logged, so a load run does not become a logging benchmark.
6. **Measure the waits, not just the work.** Pool checkout time is recorded by wrapping
   `connect()` (including failed and timed-out checkouts) and pool size, idle, and waiting
   counts are exported per pool (`runtime`, `maintenance`). Point-ingestion latency covers
   checkout through COMMIT and excludes request parsing. Event streams are excluded from the
   latency histogram because their duration is the connection lifetime.

## Exposed signals

HTTP requests, duration, and in-flight; point-ingestion commit latency, inserted and duplicate
points, and rejections by application code; live streams opened, open, limit rejections,
backpressure closes, poll failures, and poll-cycle duration; archive tile requests
(hit/miss/error/aborted), bytes, generation time, cache entries and bytes, generation
queue depth and active count; per-task maintenance cycle outcome, duration, and last-success
time, plus a blocked-raw-purge counter (retention overrun); pool checkout time and state;
process memory, heap, event-loop delay p99, and uptime.

## Consequences and limits

- Metrics are per process and reset on restart. Several API instances would each need a scrape
  target; that is consistent with the single-node scope of this stage.
- `maintenance_last_success_timestamp_seconds` is a gauge of when a job last succeeded; alerting
  on its age is how a stuck exporter (P10.5) or purge is detected. No alert rules or dashboards
  are shipped yet.
- Signals in the SDD list that need database reads are **not** exported yet: data age, summary
  lag, table dead tuples, and backup age. Summary lag and dead tuples belong with the P11.4
  measurement work; backup age belongs with P12.3.
- GPS-to-browser latency cannot be derived from server metrics alone and is measured
  end-to-end in P11.3.
- The scrape endpoint is unauthenticated by design; exposing `METRICS_HOST` beyond a trusted
  network must be a deliberate deployment decision.
- The restore command keeps its own plain stdout/stderr output; it is a one-shot CLI whose
  output is the operator interface, and it already prints counts only.
- The tile `hit`/`miss` split counts a request that joined another request's in-flight
  generation as a miss; only requests that ran SQL contribute to the generation-time histogram.

## Verification

Unit suites for the registry, logger, HTTP middleware, pool and process collectors, metrics
listener, maintenance runner, live hub, tile coordinator, ingestion helper, and configuration,
plus a real-PostgreSQL integration test that ingests, conflicts, scrapes the listener, and
asserts that no coordinate, run/org/user identifier, cookie, or CSRF token appears in either the
exposition or the captured logs. See `docs/progress.md` for the executed results.
