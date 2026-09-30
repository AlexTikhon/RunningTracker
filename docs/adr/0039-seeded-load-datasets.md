# ADR-0039: Deterministic seeded load datasets in a dedicated database

- Status: accepted; P11.2 implemented and locally verified
- Date: 2026-09-29
- Scope: P11.2 only. Concurrent load runs, EXPLAIN evidence, and optimizations are P11.3–P11.5.

## Context

SDD section 14 fixes two datasets: an ordinary one (126,000 raw points, 3,650 summaries) and a stress
one (3,000,000 raw points). P11.3 and P11.4 must run against the same data every time, or a before/after
comparison in P11.5 measures the data, not the change. The integration suites also assume a nearly empty
`running_tracker_test` and clean up their own fixtures, so bulk data must not live there.

## Decision

1. **Dedicated database.** The seeder writes only to a database whose name ends in `_load_test`
   (`running_tracker_load_test` locally). The suffix still ends in `_test`, so the existing bootstrap,
   migration, and integration-URL guards accept it unchanged and no script gained a new mode. The command
   refuses every other name, and `--reset` (TRUNCATE of the dataset tables) works only on this suffix. The
   library function takes the allowed suffixes as an argument so the integration test can seed the normal
   test database with a small profile and remove exactly what it wrote.
2. **Object-owner writer, one transaction.** Rows are inserted as `running_tracker_owner`, which RLS does
   not constrain, because seeding is test tooling and the runtime role must never gain insert rights to
   `runs` in bulk. Every CHECK, FK, and index still applies. One transaction means a failure leaves no
   partial dataset; `ANALYZE` follows so plans reflect the data.
3. **Deterministic by construction.** A pure planner (`dataset-plan.ts`) derives every identifier and
   parameter from SHA-256 of `seed:key`, independent of call order. IDs are RFC-4122 version-4 shaped so the
   shared contract UUID check accepts them. The per-point GPS noise, timestamps, accuracy, and revisions are
   produced in SQL from `md5(seed:run:seq)`, so 3,000,000 points need no client-side row stream and the
   result does not depend on the planner's row order. The manifest records an MD5 digest over runs, points,
   summaries, and shares; reseeding the same seed and instant reproduces it.
4. **Volumes match the SDD exactly.** 10 members × 365 days = 3,650 finished runs and summaries. The raw
   budget is spread over the 70 runs of the last seven days (`ordinary`: 1,800 points each = 126,000;
   `stress`: 42,857 or 42,858 each = 3,000,000, about 23.8 hours at 2 s, under the 24-hour and 50,000-point
   limits). Older runs are `purged` with only a summary, consistent with the seven-day raw retention and
   one-year archive. `data_revision` is `ceil(points/100) + 1` (one revision per 100-point batch plus the
   finish), `control_revision` is 1, and each summary carries the current algorithm version and a valid
   `quality_stats`, so the summary worker does not consider seeded runs stale.
5. **Reproducible geography and ACL.** Eight regional anchors cover both hemispheres, the equator, a high
   latitude, and one route centred on 180° so raw points fall on both sides and the display
   MultiLineString splits into parts. The last two members are coaches with both grants from every runner;
   other ordered pairs draw none/history/live/both (40/20/10/30%) as a standing policy copied to each run
   of the owner. This covers every ACL combination for archive and live-visibility queries; it does not
   create live runs, which P11.3 creates through the API so ingestion, SSE, and commit paths are exercised.
6. **Stress speed.** Stress runs are 23.8 hours long, so the profile uses 0.4–0.8 m/s. The synthetic route
   remains a city-scale loop; stress measures volume and index behaviour, not realistic pace. Display
   vertices scale with laps (24 per lap, 48–600), so each loop stays resolvable.

## Consequences

- Seeded runs have no `run_commands`, tombstones, or journal rows, so they cannot demonstrate replay of
  their original create/finish commands. That behaviour is covered by the lifecycle suites.
- Display geometry is generated analytically, not by the production simplification function; raw points and
  the geometry follow the same route, but the seeded summary is not evidence of the simplifier's output.
  The simplifier's cost on 42,857-point runs is a P11.3/P11.4 measurement, not seeded data.
- The digest is stable on one PostgreSQL/PostGIS build. Different floating-point text formatting across
  builds would change it without changing the data's meaning.
- The stress load occupies about 1.1 GB of the Docker volume until the database is reset or dropped.

## Verification

Unit tests cover the profile volumes and limits, ID/hash determinism, slot fit, retention windows,
non-overlap, geography, ACL classes, and argument parsing. A real-PostgreSQL integration test seeds the
`smoke` profile and checks counts, all constraints, point contiguity and ordering, revision consistency,
summary validity and freshness (via `find_stale_run_summaries`), antimeridian coverage, reproducibility,
whole-transaction rollback, target refusal, and the exact rows each member sees under the runtime role
and RLS, including a member of another organization seeing nothing.
