# ADR-0028: PostGIS archive MVT pipeline

- Status: accepted; P09.2 implemented and locally verified
- Date: 2026-09-28
- Scope: P09.2 only

## Context

P09.1 established validated revision-bound tile URLs and passed one authenticated,
runtime-role tenant client to the tile pipeline. P09.2 must turn the summaries
visible through that client's history RLS policy into correct MVT without moving
full WGS84 geometry into Node.js or weakening the authorization boundary.

The hard spatial cases are the Web Mercator latitude limit, the buffer shared by
candidate selection and tile clipping, and opposite world copies at ±180°.
Projection libraries normalize longitudes outside the conventional world, so a
WGS84 longitude shift before projection cannot reliably place an antimeridian
copy in the adjacent edge tile.

## Decision

1. Generation is one parameterized PostGIS statement executed on the P09.1
   RLS-bound client. Finished-run and half-open period filters are applied before
   encoding. The tile row exposes only `run_id::text` and geometry.
2. Each normal/wrapped candidate branch has its own `display_geom && envelope`
   predicate, followed by exact `ST_Intersects`. This keeps the existing
   `run_summaries_display_geom_gist_idx` usable without combining spatial cases
   behind one broad `OR` predicate.
3. Selection expands the tile by `64 / 4096` of its width. Geometry is clipped
   with `ST_ClipByBox2D` to the valid Web Mercator latitude world before
   EPSG:3857 projection. The rectangular clip also avoids a GEOS overlay issue
   observed with fully contained horizontal lines in the pinned local image.
4. For `x=0` and `x=2^z-1`, the opposite WGS84 edge is selected separately. Its
   projected geometry is translated by one full EPSG:3857 world width toward the
   requested tile. Normal and shifted copies are merged by run before clipping.
5. `ST_AsMVTGeom` uses extent 4096, buffer 64, the unexpanded tile bounds, and
   `clip_geom=true`. Null, empty, and non-line results are excluded before
   `ST_AsMVT`; an empty visible set returns an empty byte string, which is a valid
   empty protobuf tile.

## Consequences

- Adjacent tiles share buffered geometry, and both antimeridian edges render the
  corresponding split summary without a world-spanning segment.
- Polar inputs cannot reach projection outside the supported Web Mercator world.
- UUIDs remain MVT string properties and are not encoded as numeric feature IDs;
  names, raw GPS points, and summary metrics are absent.
- P09.2 does not add cache state, SQL timeout, generation concurrency, queue, or
  tile-byte limits. Those remain explicit P09.3–P09.6 work; the pipeline does not
  silently truncate features in the meantime.

## Verification

- Unit coverage checks the single-query contract, canonical parameters, spatial
  primitives, text UUID projection, and invalid database payload rejection.
- Real runtime-role/PostGIS tests decode the generated protobuf and verify layer,
  string properties, line geometry, adjacent tiles, both antimeridian edges,
  polar clipping, empty output, and history-RLS exclusion.
