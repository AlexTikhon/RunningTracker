# ADR-0066: A coherent published archive-track read

- Status: accepted; implemented, local verification recorded in `docs/progress.md`
- Date: 2026-11-01
- Amends: SDD section 11.3, the previously specified but unimplemented archive-track read
- Scope: contracts, one read-only API service/route and tests; no migration, recording or web behavior change

## Context

The archive map uses MVT tiles, while My runs shows summary metrics. A finished-run detail view needs a complete
published route, including after the seven-day raw purge. Raw points have a different retention policy; decoding
tiles would lose the complete geometry and tie the detail contract to map clipping and zoom.
Late point delivery can also make a published summary older than the run's current data revision.

## Decision

`GET /api/orgs/{orgId}/runs/{runId}/track?mode=archive` returns HTTP 200 with a GeoJSON Feature. The query is strict:
`mode=archive` is required and no other query key is accepted. Only finished runs are eligible.

Every Feature contains `properties.runId`, `startedAt`, `finishedAt`, `dataRevision`, `rawState` and `summaryState`:

| summaryState | sourceRevision / algorithmVersion | geometry | distanceM / observedDurationS / qualityStats |
|---|---|---|---|
| pending | null / null | null | null / null / null |
| stale | published revision / published algorithm | null | null / null / null |
| ready | published revision equals dataRevision / published algorithm | MultiLineString or null | published metrics and quality statistics |

A null geometry in `ready` is a valid empty track, for example a run with insufficient usable data. It differs
from a missing or outdated summary. Readiness compares source/data revisions, not the published algorithm against
today's algorithm: an archived, raw-purged run retains its original provenance and cannot be recomputed from raw
points. `observedDurationS` retains its existing meaning, time covered by accepted edges, not moving time.

The service reads run metadata and its summary/geometry in one SQL statement snapshot. It reads
`run_summaries.display_geom`, never raw points. PostGIS serializes the stored geometry at 15 decimal digits, without
reconnecting segments, clipping to Web Mercator or further simplification. Coordinates remain WGS84, longitude
first. An uncommitted publication/deletion is not observed; a read may return the complete preceding committed
snapshot, and a later request observes the commit. Reads do not hold archive locks or promise to revoke data
already returned.

The existing authenticated tenant transaction and runtime-role RLS apply. Active membership is required. A coach
role alone grants nothing; a grantee needs history permission for this finished run. An unavailable/inaccessible
or active run returns 404 `RUN_NOT_FOUND`; an owner's retained tombstone returns 410 `RUN_DELETED`, while other
identities cannot discover that tombstone. Inactive/missing organization membership returns 403. All route
responses, including authentication/validation/errors, set `Cache-Control: private, no-store`.

Resource limits are 100,000 total vertices and 1,048,576 bytes of complete UTF-8 JSON before compression. The
vertex ceiling leaves room for segmentation of a maximum-size raw run. SQL guards geometry encoding by the vertex
limit and withholds an oversized encoded value from Node; the service also checks the entire serialized Feature,
including metadata. Exceeding a limit returns 422 `ARCHIVE_TRACK_TOO_COMPLEX` with `maxBytes` and `maxVertices`.
No truncated route is returned. Existing runtime SQL/lock budgets apply. Pending/stale summaries do not encode
their old geometry, even when it exceeds these limits.

## Consequences

- A future detail screen receives matching geometry, metrics and provenance, and works after raw purge.
- Existing archive tiles, raw-point reads and live-track synchronization are unchanged.
- The previously unimplemented response schema is extended before its first runtime consumer exists. OpenAPI
  now marks this operation implemented; two other SDD reads remain unimplemented.
- Pending/stale results need an explicit refresh in a future screen; this route does not create a background job.
- Reconsider geometry delivery if legitimate published routes exceed the limit. Pagination or another display
  representation would require a new contract; do not weaken the bound or silently simplify at read time.

## Validation

Contract tests cover strict mode, state/provenance consistency, null versus unavailable geometry, global
coordinates, invalid geometry and vertex limits. Real PostgreSQL/PostGIS integration tests use runtime RLS for
owner/history access, live-only/coach/cross-tenant/inactive denial, maintenance raw purge, publication/deletion
transactions, revocation and oversized geometry. Exact executed commands and results are in progress notes.
