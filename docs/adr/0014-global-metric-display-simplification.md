# ADR-0014: Global metric display-geometry simplification

- Status: accepted; P06.3 implemented and locally verified
- Date: 2026-09-26
- Scope: P06.3 only

## Context

P06.2 returns revision-bound metrics and unsimplified accepted WGS84 chains.
Archive display geometry must be materially smaller without changing those
metrics, bridging rejected edges, treating angular degrees as metres, or
drawing an antimeridian crossing across the whole map. A single regional
projection or Web Mercator would not satisfy the global boundary.

## Decision

1. `app_private.simplify_display_geometry(acceptedChains, version)` is a pure,
   immutable, strict, parallel-safe, security-invoker PostGIS capability. Only
   the maintenance role may execute it. It returns display geometry only and
   cannot change the P06.2 distance, duration, or quality result.
2. Each accepted chain receives an explicit cumulative spheroidal-distance M
   measure. `ST_LocateBetween` partitions that measured line into pieces no
   longer than 20 km and includes the exact same cut point in adjacent pieces.
   This avoids relying on angular length and preserves original endpoints.
3. Every piece uses a local WGS84 azimuthal-equidistant projection centred on
   that piece. Douglas–Peucker simplification runs there with a 5 metre
   tolerance and `preserveCollapsed=true`, after which the result is transformed
   back to longitude/latitude. Web Mercator is not part of metric processing.
4. Longitudes are unwrapped into a continuous series before processing map
   boundaries. The result is split at every crossed `180 + 360k` meridian and
   each component is translated into `[-180, 180]`. This handles eastbound,
   westbound, ordinary-latitude, and polar antimeridian crossings without a
   Greenwich discontinuity.
5. Separate accepted chains and metric partition boundaries stay separate.
   Zero-length display pieces are omitted; if no drawable line remains, the
   result is SQL `NULL`. This does not change whether P06.2 reported accepted
   stationary edges or insufficient data.
6. Unknown algorithm versions, wrong geometry type/SRID/dimension, and invalid
   WGS84 coordinates fail closed with SQLSTATE `22023`.

## Consequences

- A long accepted chain can produce several display components even without an
  edge rejection: metric chunk boundaries are deliberate and share endpoints.
- Antimeridian components use `180` on one side and `-180` on the other. They
  are geographically coincident but cannot create a world-spanning map edge.
- P06.3 does not publish `run_summaries`, validate publication-time revision or
  run state, lock organizations/runs, advance `archive_revision`, or schedule
  work. Those remain P06.4–P06.5.

## Verification

- Real PostGIS integration covers role privileges and function attributes,
  malformed inputs, empty and stationary-degenerate chains, sub-five-metre
  noise, endpoint and sharp-turn preservation, cumulative 20 km partitioning
  with shared boundaries, Greenwich continuity, and ordinary/polar
  antimeridian normalization.
- Repository lint, strict typecheck, unit tests, production builds, migration
  preflight, and the full real-role integration suite pass.
