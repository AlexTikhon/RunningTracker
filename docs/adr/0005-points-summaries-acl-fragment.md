# ADR-0005: run_points and run_summaries storage and ACL fragment

- Status: accepted; implemented scope verified against PostgreSQL/PostGIS
- Date: 2026-09-20
- Scope: bounded second fragment of P02B and D02

## Context

Direct reads from `run_points` and `run_summaries` must enforce the same current
run authorization as parent reads. The two child tables have different access
semantics: live access includes raw points of unfinished runs, while summaries
are archival data and require history access. This fragment defines storage and
database authorization, but does not implement ingestion or summary publication.

## Decision

1. Store point sequence and revision values as PostgreSQL `bigint`, segment IDs
   as `integer`, timestamps as `timestamptz(3)`, point coordinates in PostGIS
   `geometry(Point,4326)`, and measurements as finite `double precision`. Future
   JavaScript boundaries must expose `bigint` values as decimal strings or
   `BigInt`, never coerce them to `number`.
2. Store summary revisions as `bigint`, `algorithm_version` as a nonblank UTF-8
   string of at most 128 bytes, timestamps as `timestamptz(3)`, metrics as finite
   nonnegative `double precision`, and `display_geom` as nullable
   `geometry(MultiLineString,4326)` with a GiST index.
3. `quality_stats` is a JSON object versioned by `algorithm_version`. Its
   documented keys are nonnegative integer counts (`rawPointCount`,
   `acceptedPointCount`, `acceptedEdgeCount`, `poorAccuracyPointCount`,
   `seqGapCount`, `segmentBreakCount`, `nonpositiveTimeDeltaCount`,
   `excessiveTimeGapCount`, `excessiveSpeedCount`) plus boolean
   `insufficientData`. Exact validation and calculation belong to the future
   summary-publication transaction.
4. Apply this runtime access matrix, always requiring the exact current
   organization and an active membership:

   | Relation | Owner | Active grantee | Runtime writes |
   |---|---|---|---|
   | `run_points` | read own run | read unfinished points with live grant or finished points with history grant | owner INSERT only; no UPDATE/DELETE |
   | `run_summaries` | read own summary | read only a finished run with history grant | none |

   A coach role without an applicable grant has no access. Direct child reads
   and reads joined to `runs` use the same matrix.
5. Reuse `app_private.can_read_run()` for point SELECT and
   `app_private.is_run_owner()` for point INSERT. Add the narrower
   `app_private.can_read_run_history()` for summary SELECT; it is a boolean
   `STABLE SECURITY DEFINER` function with `search_path = pg_catalog`, fully
   qualified relations, and no PUBLIC EXECUTE.
6. Make the `runs` owner branch explicit in its SELECT policy. This preserves
   the ACL while allowing `INSERT INTO runs ... RETURNING` to authorize the
   newly inserted row without depending on a `STABLE` helper querying that row
   through the statement snapshot. Point `INSERT ... RETURNING` authorizes
   against its already existing parent run.
7. Validate every `display_geom` vertex through the pure
   `app_private.display_geom_coordinates_valid(geometry)` helper. It is
   `IMMUTABLE`, `STRICT`, `PARALLEL SAFE`, security invoker, and has a fixed
   `pg_catalog` search path with qualified PostGIS calls. PUBLIC, runtime, and
   maintenance EXECUTE are revoked. The row CHECK still permits SQL NULL and
   rejects empty, non-finite, and out-of-range geometry; valid routes crossing
   the antimeridian remain valid.

## Database guarantees in this fragment

- Composite PK/FK constraints prevent cross-tenant child links and cascade
  child deletion with the parent run.
- Point keys, ranges, finite values, SRID/type, and nonempty geometry are
  enforced by SQL types, PostGIS typmods, and CHECK constraints.
- Summary revision/version, finite metrics, JSON object shape, SRID/type, and
  every coordinate of nonempty geometry when non-null are enforced similarly.
- Raw points have the revision/sequence index required by change recovery and
  deliberately have no GiST index; summaries have the archive GiST index.
- RLS plus narrow grants protects direct child-table access. Runtime cannot
  mutate existing raw points or publish/change/delete summaries.

## Guarantees deferred to future services

- P04 ingestion must canonicalize `PointInput`, compare duplicate payloads,
  serialize `bigint` safely, lock the parent run, and atomically advance
  `data_revision` with new points.
- P06 publication must validate the full `quality_stats` contract, compute the
  geometry/metrics, compare `source_revision` with the locked run, and publish
  the summary with the organization archive revision atomically.
- Cross-row relationships between run revisions/status and child revisions
  cannot be expressed as row-local CHECK constraints and are not simulated by
  triggers in this schema fragment.
- Commands, tombstones, deletion, retention, and executable verification of the
  complete P02B matrix were outside this fragment. ADR-0006 now implements and
  verifies commands/tombstones and D02; deletion/retention remain P10.

## Consequences

- Owner fixtures may insert summaries directly to test ACL combinations that a
  future publication service would not publish, including an unfinished run.
  This is deliberate test setup, not a runtime publication path.
- D01 remains open because storage representation alone does not define input
  canonicalization for numbers, negative zero, timestamp spelling, and retries.
- At this fragment boundary D02 remained PARTIAL. ADR-0006 records its later
  resolution under the real runtime role and its trusted-context boundary.

## Verification

On 2026-09-21, migrations `0002`–`0004` and 57 integration scenarios passed in
the isolated `running_tracker_test` PostgreSQL/PostGIS database under the real
owner, runtime, and maintenance roles. Coverage includes direct/JOIN ACL for all
live/history/both/no-grant and run-status combinations; owner and denied
mutations; statement-level revocation; duplicate and upsert immutability;
bigint/timestamp/binary64 representation; JSON object/array/scalar/null
semantics; composite FK/cascade; and per-vertex geometry validation. D01,
summary-publication validation, commands, and tombstones remain outside this
verified fragment.
