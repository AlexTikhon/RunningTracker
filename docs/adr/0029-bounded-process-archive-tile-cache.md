# ADR-0029: Bounded process archive tile cache

- Status: accepted; P09.3 implemented and locally verified
- Date: 2026-09-28
- Scope: P09.3 only

## Context

P09.1 established the authenticated tenant transaction and revision-bound tile
URL. P09.2 generates a complete MVT under runtime-role history RLS. Repeating
that spatial query for identical requests wastes database work, but a cache key
that omits identity or filter state can disclose another user's tile. Empty MVTs
also have zero payload bytes, so a byte limit alone does not bound cache metadata.

## Decision

1. Each application instance owns one explicitly constructed process cache. It
   stores at most 32 MiB of tile buffers and 4096 entries. The entry ceiling is
   a metadata guard for zero-byte tiles, not an additional tile-size limit.
2. Entries use access-order LRU eviction and expire five monotonic minutes after
   successful generation. Expired entries are removed on lookup or insertion;
   the cache owns no background timer or external lifecycle resource.
3. The key is `formatVersion / orgId / userId / archiveRevision /
   canonicalFilterHash / z/x/y`. UUIDs are lowercased, revisions use canonical
   bigint decimal form, and the ordered filter hash is SHA-256 over canonical
   UTC `from`/`to` values that retain significant fractional precision. The format version must change when tile
   encoding semantics become incompatible.
4. Successful buffers, including empty MVTs, are cached. A buffer larger than
   the total cache capacity is returned but not stored. Rejections and invalid
   loader values are not stored.
5. One in-flight promise is retained per complete key. Identical callers await
   that promise; success populates the LRU, while both success and failure remove
   the flight. Because `userId` is part of the key, single-flight never merges
   different authorization views.
6. The route calls the cache only after the existing session, active-membership,
   and current-revision checks in the runtime-role tenant transaction. P09.4
   still owns write-side atomic revision changes and concurrent cache-hit
   invalidation proof.

## Consequences

- Hot tiles avoid repeated PostGIS encoding without introducing Redis or a
  public/CDN cache. Multiple API replicas deliberately keep independent caches.
- Byte usage and zero-byte entry metadata are bounded. Buffers are not truncated
  to fit the cache, so a miss remains semantically identical to P09.2.
- A request waiting on another request's single-flight currently keeps its own
  tenant transaction open. P09.6 retains generation concurrency, queue, SQL
  timeout, and tile-size resource guards.
- TTL is an eviction bound, not an authorization mechanism. Database validation
  remains before cache lookup, and P09.4 must complete the archive epoch rules.

## Verification

- Unit tests cover every key component, canonical equivalence, LRU promotion,
  byte and entry eviction, exact TTL expiry, empty and oversize tiles, failure
  exclusion, and single-flight cleanup.
- Runtime-role integration proves canonical reuse for one authenticated user and
  a distinct generation for another user after membership/revision validation.
