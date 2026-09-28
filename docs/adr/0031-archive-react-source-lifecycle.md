# ADR-0031: Archive React source lifecycle

- Status: accepted; P09.5 implemented and locally verified
- Date: 2026-09-28
- Scope: P09.5 only

## Context

P09.1–P09.4 expose authorized revision-bound metadata and private MVT tiles,
but a browser map can retain visible tiles after the underlying revision or
authorization changes. Cache TTL is not a client freshness or revocation
mechanism. The archive consumer also needs to remain testable without a paid
provider token or external network.

## Decision

1. A provider-independent controller owns one user/organization/period scope.
   It performs an initial metadata read, polls every 30 seconds, and refreshes
   immediately when the page regains focus/visibility or an archive tile
   reports HTTP 409. Only one read is active; additional refresh intent is
   coalesced into one following read.
2. Metadata is parsed with the shared strict response contract. An unchanged
   response retains object identity and does not churn Mapbox. A revision URL
   change calls `VectorTileSource.setTiles`; a source-layer or zoom-shape change
   recreates only the archive source and line layer.
3. HTTP 401/403 is an authorization-loss signal. The controller removes all
   metadata, and the React adapter removes the archive layer before its source.
   Scope change and unmount abort pending reads and destroy the map. Network and
   5xx failures keep the last successfully authorized source visible with an
   explicit error because they do not prove revocation.
4. Mapbox GL JS is exact-pinned at 3.31.0 and dynamically loaded only when a
   public `VITE_MAPBOX_ACCESS_TOKEN` is present. Tokenless execution still runs
   the complete controller/source lifecycle tests and performs no provider
   request. The browser token is public configuration, not a server secret.

## Consequences

- The target 60-second freshness is not coupled to the five-minute backend
  cache TTL: the active client checks at 30 seconds and on focus.
- Revocation detected by metadata or tile HTTP removes sensitive archive state;
  transient availability failures deliberately retain the last authorized
  visualization until a later authorization result says otherwise.
- Mapbox adds a large lazy browser chunk. It does not affect runner/coach startup
  execution, but bundle size and provider/browser smoke testing remain visible
  operational considerations.
- P09.6 still owns SQL timeout, generation concurrency/queue limits, and the
  uncompressed tile-size guard. Production token/domain restrictions remain
  deployment work, not a P09.5 authorization mechanism.

## Verification

- Controller tests cover initial/poll/focus/409 refresh, coalescing, abort,
  transient retention, and 401/403 clearing.
- Adapter tests cover source creation, revision replacement via `setTiles`,
  layer-before-source removal, and filtering archive tile errors from unrelated
  base-map errors.
- React/static and API tests cover the tokenless state, bounded period controls,
  canonical same-origin metadata request, and archive navigation entry.
