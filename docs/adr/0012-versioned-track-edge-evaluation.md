# ADR-0012: Versioned PostGIS track-edge evaluation

- Status: accepted; P06.1 implemented and locally verified
- Date: 2026-09-26
- Scope: P06.1 only

## Context

Archive summaries and the future live-track path must make the same connection
decision for two neighboring raw points. Reimplementing the rule in a worker,
an HTTP service, and the browser would allow distance, threshold, or boundary
semantics to drift. The rule also needs an explicit version because live cursors
and persisted summaries bind their results to an algorithm version.

## Decision

1. PostgreSQL owns one pure `app_private.evaluate_track_edge(...)` function.
   Both summary processing and live-track SQL will call it; the frontend will
   consume the server's future `connectFromPrevious` result and will not run an
   independent GPS filter.
2. `app_private.current_track_algorithm_version()` identifies the current
   version as `v1`. The evaluator requires a requested version and fails with
   SQLSTATE `22023` when it is unsupported. A future version must be added
   explicitly and must not silently change the behavior associated with `v1`.
3. `v1` accepts an edge only when sequence numbers are consecutive, segment IDs
   match, both accuracies are at most 30 metres, recorded-time delta is in
   `(0, 10]` seconds, and spheroidal PostGIS distance divided by that delta is
   at most 12 metres per second.
4. Rejections have stable precedence: sequence gap, segment break, poor
   accuracy, nonpositive recorded-time delta, excessive time gap, then
   excessive speed. The evaluator returns that primary reason plus geodesic
   distance and recorded-time duration; later summary aggregation can count one
   edge break deterministically and sum metrics only for accepted edges.
5. The evaluator is `IMMUTABLE`, `STRICT`, `PARALLEL SAFE`, security-invoker,
   and has a fixed `pg_catalog` search path with fully qualified PostGIS calls.
   PUBLIC execution is revoked. Runtime and maintenance roles receive EXECUTE
   because future live reads and summary work use different least-privilege
   database roles.

## Consequences

- `received_at` is deliberately absent. Offline delivery timing cannot break a
  track whose `seq`, segment, and recorded-time relationship is valid.
- P06.1 does not aggregate quality counters, construct chains, persist a
  summary, publish an archive revision, or add a live-track endpoint. Those are
  later P06/P07 fragments.
- Invalid raw geometries and negative accuracy are excluded by existing
  `run_points` constraints; the evaluator does not duplicate row validation.

## Verification

- Real PostGIS integration covers accepted boundaries, every rejection reason
  and its precedence, zero/negative time, a GPS-speed spike, antimeridian and
  high-latitude distance, unsupported versions, and runtime/maintenance/PUBLIC
  privileges.
- Repository lint, strict typecheck, unit tests, production builds, migration
  preflight, and the full real-role integration suite pass.
