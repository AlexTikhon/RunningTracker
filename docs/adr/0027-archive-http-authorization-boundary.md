# ADR-0027: Archive HTTP and authorization boundary

- Status: accepted; P09.1 implemented and locally verified
- Date: 2026-09-28
- Scope: P09.1 only

## Context

Archive metadata and vector tiles share a revisioned URL contract, but the tile
pipeline must not trust the URL revision or date filter as authorization. It must
run only after session and active-membership checks and must read summaries under
the authenticated runtime-role tenant context so the existing history RLS policy
continues to separate owners, history grantees, and live-only readers.

P09.1 owns the HTTP and authorization boundary. Spatial candidate selection,
projection, clipping, and MVT encoding remain P09.2; caching and cache-hit
revalidation remain P09.3–P09.4.

## Decision

1. `GET /archive/metadata` and the tile route are mounted under the existing
   session and `withAuthenticatedTenantTransaction` boundary. Metadata returns
   the current organization `archive_revision`, the exact validated half-open
   filter, zoom 8–16, source layer `runs`, and a concrete revision-bound tile URL
   template. Responses are `private, no-store`.
2. Archive periods are absolute UTC timestamps with `from < to` and at most 366
   days. Tile path values are canonical nonnegative decimal integers, zoom is
   8–16, and both `x` and `y` must be less than `2^z`.
3. Each tile request re-reads the current organization revision inside its tenant
   transaction before invoking the pipeline. A mismatch returns `409
   ARCHIVE_REVISION_CHANGED` with only the current revision.
4. The pipeline receives the same runtime-role `PoolClient` whose transaction has
   the authenticated `app.user_id` and `app.org_id`. It must select
   `run_summaries` through the existing history RLS policy; revision/filter values
   never grant access.
5. Until P09.2 installs PostGIS generation, the production pipeline
   fails closed with the existing retryable `503 TILE_BUSY` error. P09.1 does not
   return a false empty tile or partially encoded feature set.

## Consequences

- Validation, membership, revision ordering, response headers, and the RLS-bound
  pipeline seam can be verified independently of spatial SQL.
- P09.2 can replace only the pipeline implementation without weakening the HTTP
  authorization boundary.
- The tile URL is intentionally non-cacheable at the HTTP layer; later process
  caching remains private and must re-check membership/revision before a hit.

## Verification

- Contract tests cover zoom/XYZ boundaries, canonical path integers, revision,
  ordered periods, and the inclusive 366-day ceiling.
- Real runtime-role/PostGIS integration proves metadata and revision behavior,
  unauthenticated/inactive rejection, and different RLS-visible finished-summary
  sets for a history grantee and an unrelated active member.
