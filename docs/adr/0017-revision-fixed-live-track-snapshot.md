# ADR-0017: Revision-fixed initial live-track snapshot

- Status: accepted; P07.1 implemented and locally verified
- Date: 2026-09-27
- Scope: P07.1 only

## Context

The coach client needs an initial live-track point set that remains reproducible
while ingestion continues. Holding a PostgreSQL transaction across paginated
HTTP requests would consume connections and still complicate authorization
changes. Ordering and revisions also use PostgreSQL bigint domains and must not
pass through lossy JavaScript numbers.

## Decision

1. The first `live-track` request reads `runs.data_revision` as R and its first
   point page in one PostgreSQL statement snapshot. Points are ordered by `seq`
   and limited to `ingested_revision <= R`.
2. A continuation uses immutable point rows, the same R, and `seq > lastSeq`.
   New ingestion may advance the run but cannot enter an older snapshot. No
   transaction or connection is retained between HTTP requests.
3. Pages contain at most 1,000 records. Revisions and sequences remain canonical
   decimal strings through SQL, cursor parsing, runtime validation, and JSON.
4. Each request rechecks session, active membership, `can_read_run` authorization,
   and raw availability. This selects live grants for active runs and history
   grants for finished runs, while hiding an unauthorized run before revealing
   retention state.
5. The P07.1 cursor is an internal base64url payload bound to snapshot operation,
   organization, run, R, algorithm version, and last seq. P07.4 will replace
   this temporary integrity boundary with a signed, user-bound, expiring cursor.
6. P07.1 returns the existing `TrackPage` shape. Edge annotations are deliberately
   neutral (`predecessorSeq=null`, `connectFromPrevious=false`) until P07.3
   computes them with the shared versioned evaluator on the same revision set.

## Consequences

- A late lower-sequence point cannot perturb an in-progress initial snapshot;
  starting a fresh snapshot exposes the newer revision and point.
- A caller can currently alter an unsigned cursor payload, but cannot cross the
  current ACL, organization/run binding, raw-state boundary, current revision,
  or supported algorithm. Cursor authenticity and expiry are not claimed before
  P07.4.
- P07.1 does not implement `changes(A,T)`, predecessor/edge evaluation, client
  upsert application, SSE notifications, or frontend track rendering.

## Verification

- Real runtime-role integration covers fixed-R continuation after concurrent
  ingestion, a fresh newer snapshot, empty results, live/history grants,
  authorization-before-retention ordering, malformed/foreign cursors, and query
  bounds.
- Full lint, strict typechecking, unit tests, production builds, and the complete
  real-role/PostGIS integration suite pass.
