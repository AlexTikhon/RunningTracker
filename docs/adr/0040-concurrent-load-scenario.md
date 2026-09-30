# ADR-0040: A deterministic concurrent load scenario over the real boundaries

- Status: accepted; P11.3 implemented and locally verified
- Date: 2026-09-30
- Scope: P11.3 only. Measuring plans and sizes (P11.4) and any optimization (P11.5) come later; the runner creates a
  reproducible workload and raw samples, it does not decide whether a target is met.

## Context

The SDD stress case is ten concurrent offline batches of 100 points, ten observers, archive pan/zoom bursts, and a
concurrent summary job on top of the seeded dataset (ADR-0039), plus a fresh-measurement-to-observer latency that P11.4
must be able to compute. Calling service functions or SQL directly would skip exactly the parts that are expensive:
the session boundary, the connection pool, the SSE hub, the tile scheduler and cache, and the summary worker.

## Decision

1. **A separate process under load, driven only over HTTP.** `npm run load:run -- --profile smoke|ordinary|stress`
   starts the real API (`src/entrypoint.ts`, exactly as `npm run dev` without the watcher) on free loopback ports and
   talks to it through Node's `http` module with an explicit keep-alive agent sized for the scenario, so the client
   never queues silently. Latency is measured from the socket hand-off to the last body byte on a monotonic clock. The
   runner itself uses the database only as the object owner, to verify the dataset before the run and to remove its own
   runs afterwards.
2. **Fail-closed target.** Three variables are required: `LOAD_DATABASE_URL` (owner, as for the seeder),
   `LOAD_RUNTIME_DATABASE_URL`, and `LOAD_MAINTENANCE_DATABASE_URL`. All must name the same loopback host, port, and a
   database ending in `_load_test`, with the expected role. Each role then connects and asks the live session for
   `current_database()` and `current_user`. There is no flag for a URL, a database, or a reseed. The child receives a
   scrubbed environment: every `*DATABASE_URL` variable of the runner is removed, so the owner credentials never reach
   the API, and only the runtime and maintenance URLs are set. Local sessions are enabled only for the ten planned member
   IDs. The production guard is untouched: `APP_ENV=test`, and configuration validation is the API's own.
3. **The dataset must be exactly the planned one.** The dataset instant is recovered from the seeded run of member 0 (its
   start time minus a constant that depends on the profile and seed) or given with `--as-of`, then the whole plan is
   verified: organization, members, every run ID with its start time, no run or point beyond the plan, no active run,
   raw-point and summary totals. Leftovers of an earlier run therefore fail the check with counts only.
   `--cleanup-only` removes exactly the runs the scenario creates (deterministic IDs) and verifies again.
4. **Real sessions.** Every identity logs in through `POST /api/session` with the allowed origin, keeps the cookie and
   CSRF token in private fields of a `LoadSession`, and uses them for mutations. Serialization, `util.inspect`, and
   string conversion expose only the user ID.
5. **The run model follows the lifecycle rules.** A member can have one active run (unique index), so the scenario uses
   one active run per member, and the summary run belongs to member 0, who finishes it and only then creates the active
   run. Run and command IDs derive from `deterministicUuid(seed, 'load-run' | 'load-command', n)`. Shares are created
   through the API from the planned standing policy so the observers' ACL matches the dataset. Cleanup deletes exactly
   those run IDs as the owner; it leaves no tombstone or journal row, so the IDs stay reusable.
6. **Timeline.** Setup (summary run created and loaded with its batches, other active runs created, baseline revision and
   a verification tile read) and ten SSE observers opened, then one overlap window in which the following run together:
   two overlapping tile-burst streams; the archive metadata poll; the summary run's finish command; the summary watcher;
   `catchupRounds` rounds of one 100-point batch per member issued concurrently (a barrier per round, so each round is
   exactly ten concurrent requests); an exact retry of an already committed batch and an overlapping retry (50 duplicate,
   50 new); then the fresh phase, one point per run every two seconds (5 points/s for ten members, the SDD rate), which
   lasts until the summary is visible in the run view and the archive revision has advanced, and at least the profile
   minimum. `stress` uses ten rounds, `ordinary` three, `smoke` two. Concurrency is always explicit and bounded
   (`runBounded`); nothing is an unbounded `Promise.all` over arbitrary work.
7. **Offline batches versus fresh points.** Catch-up points sit on the device's two-second grid from the run's start and
   all precede the upload instant; their coordinates are a pure function of the run and the elapsed time, so a retry is
   byte-identical. Fresh points continue the same path and numbering with `recordedAt` equal to the actual creation
   instant. Latency is measured from that instant (immediately before the request) to the first live state on a given
   observer whose position for that run has reached the point's `seq`; correlation is by run and sequence.
8. **The bridge point.** The live state shows a position only if the track edge to its predecessor is acceptable, and an
   edge with a gap over 10 s is not. The first fresh point after a backlog is more than that after the last catch-up point,
   so it becomes visible with the next point. Its latency is recorded with `bridge: true` and excluded from the convenience
   summary; the raw samples include it.
9. **Ten meaningful observers.** One SSE stream per member with that member's own session, so each is a distinct
   `user:organization` subscription and the live-state poll reads once per member, not once for ten identical
   subscribers. Expected observers of a run are the grantees with a planned live grant, never the owner. A stream that
   ends or errors, a protocol error (unknown event, unparseable state, sequence or stream ID discontinuity), or a missing
   first state fails the run.
10. **Pan/zoom bursts without a browser.** Metadata is read first, and tile URLs come from its template, so revision
    validation is not bypassed. A burst is eight 3×3 viewports (zoom 9, 11, 13, pan east twice and back, zoom out), 72
    requests with repeated tiles, on one of eight regions in a fixed order starting with the antimeridian route (its
    viewport wraps across columns 0 and 2^z−1). Even and odd bursts share a region and viewer with the odd one shifted a
    tile, and later cycles move the centre so new keys appear. A 409 `ARCHIVE_REVISION_CHANGED` refreshes the metadata and
    continues; `TILE_BUSY`, `TILE_TIMEOUT`, and `TILE_TOO_COMPLEX` are recorded as load shedding; any other status is a
    failure. Cache outcome is not inferred per request; the flag `repeatOfEarlier` and the before/after metrics carry it.
11. **Summary publication through the normal path.** The summary run is created, loaded, and finished through the API and
    left to the existing worker. The owner polls the run for its summary; the archive poll sees the revision advance
    (share changes before publication do not advance it because the run has no summary yet). The same tile before and
    after publication shows whether the new summary reached the map source.
12. **Failures.** The first failure stops new load and aborts every in-flight request, closes every stream, and still
    yields a partial report. Kinds: `transport`, `timeout`, `sse`, `unexpected-response`, `application-rejection`,
    `load-runner`. Expected rejections (revision change, load shedding) are counted, not failures. Ctrl-C is a failure
    with the message "cancelled" and the same cleanup.
13. **Results.** One JSON document per run in `.local/load-results/` (gitignored), schema `running-tracker.load-result`
    version 1: provenance (commit, Node, PostgreSQL, PostGIS, effective non-secret API settings), phase intervals, every
    HTTP sample with start/end relative to the scenario origin, fresh-point and observer samples, tile samples,
    the summary-publication timeline, full metrics before and after plus bounded snapshots, a server log tally by level
    and event only, and convenience percentiles. Before writing, `assertSafeResult` rejects any session or CSRF value
    anywhere in the document and any key named like a coordinate, cookie, or token.
14. **The dataset ages in real time, so the retention jobs are parked.** A dataset seeded at midnight has raw points
    that pass seven days and a year-old run that passes one year during the day. Left at their default cadence the
    raw-purge and annual-retention jobs rewrote the seeded rows during the first measurement (see below). The child API
    therefore runs them at their longest interval (24 h) unless `LOAD_KEEP_RETENTION_JOBS=true`; the summary worker and
    auto-finish keep the default cadence, and the effective settings are recorded in the result. The runner warns when the
    dataset instant is far from now, because the tile window (366 days ending an hour after now) would miss seeded runs.

## Consequences

- One process per scenario keeps the API's pools, tile cache, and SSE hub cold and isolated, so a rerun starts from the
  same state. The runner and the API share one machine, so their CPU competes; a remote or containerized API is future work.
- Cleanup by owner SQL is test tooling. The API's own deletion path (tombstone, journal, archive revision) is covered
  by the P10 suites and is not part of this workload.
- Concurrent retention and tile traffic can be studied deliberately with `LOAD_KEEP_RETENTION_JOBS=true` on a freshly
  seeded dataset; afterwards the dataset check refuses until it is reseeded.
- The gesture, region order, viewers, and cadence are fixed choices, not a model of real users. The results describe this
  workload only.
- Nothing in the API, database, pool sizes, limits, cache, or intervals changed. Bottlenecks the scenario exposes are
  recorded for P11.4 and are not fixed here.

## Verification

Unit tests cover statistics, bounded concurrency and cancellation, the Prometheus parser, the HTTP client (deadlines,
abort, streaming), session handling and secrecy, the SSE parser and fresh-latency correlation, scenario planning (IDs,
batches, geometry including the antimeridian, tile validity and overlap), target refusal, child environment scrubbing,
result sanitization, argument validation, and failure handling against a fault-injecting fake API (500, hang, reset,
dropped stream, external cancellation). Real-PostgreSQL integration tests verify the dataset identity checks and run the
whole smoke scenario against the real Express app, SSE hub, tile pipeline, and summary worker.
