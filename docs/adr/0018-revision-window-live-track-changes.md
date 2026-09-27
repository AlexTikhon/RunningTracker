# ADR-0018: Revision-window live-track change pages

- Status: accepted; P07.2 implemented and locally verified
- Date: 2026-09-27
- Scope: P07.2 only

## Context

A client that already holds a track at revision A must advance without
downloading the complete point history. Returning only newly ingested points is
insufficient: a late point inserted before an existing point changes that
existing point's predecessor relationship. Pagination must also remain stable
while newer ingestion advances the run.

## Decision

1. `GET /live-track/changes?afterRevision=A` reads the current run revision as T
   and its first page in one PostgreSQL statement snapshot. A must not exceed
   the current revision.
2. The statement materializes points with `A < ingested_revision <= T`. For each
   changed point it selects the immediate higher-sequence point from the complete
   point set with `ingested_revision <= T`. SQL `UNION` deduplicates changed
   points that are also successors, and the result is ordered by bigint `seq`.
3. Continuations retain A, T, algorithm version, and last seq. Point immutability
   and the fixed ingestion bound reproduce the same change set without holding a
   transaction or database connection across requests.
4. Pages contain at most 1,000 upserts and use `seq > lastSeq` keyset pagination.
   Every request rechecks session, membership, current live/history authorization,
   and raw availability before returning point data.
5. The P07.2 cursor is an internal base64url payload additionally bound to the
   changes operation and organization/run. Signing, user binding, and ten-minute
   expiry remain P07.4 scope.
6. P07.2 identifies the complete repair set but returns neutral edge annotations.
   P07.3 will compute `predecessorSeq` and `connectFromPrevious` against the same
   `ingested_revision <= T` point set.

## Consequences

- Applying all upserts to a snapshot at A produces the same point set as a fresh
  snapshot at T, including late lower-sequence insertion cases.
- The server may scan and deduplicate the full bounded revision window before
  applying a page limit. A run is capped at 50,000 points; production query-plan
  and latency measurements remain P11 work.
- A cursor is not yet an authenticity or replay-expiry boundary. Current ACL and
  raw-state checks still apply independently on every request.
- P07.2 does not calculate edges, apply upserts in the browser, sign cursors,
  publish SSE state, or render a live map.

## Verification

- Real runtime-role integration covers consecutive and disjoint changes,
  immediate-successor deduplication, fixed A/T continuation under later
  ingestion, deterministic retries, empty windows, bigint sequences,
  snapshot-plus-changes set equivalence, and current ACL/raw-state enforcement.
- Full lint, strict typechecking, unit tests, production builds, migration
  preflight, and the complete real-role/PostGIS integration suite pass.
