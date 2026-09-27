# ADR-0019: Revision-bound live-track edge annotations

- Status: accepted; P07.3 implemented and locally verified
- Date: 2026-09-27
- Scope: P07.3 only

## Context

Snapshot and change pages already fix their point set at a target revision, but
neutral edge fields cannot drive a map. Computing only within the returned page
would lose the predecessor of its first point. Computing against current points
would also let later ingestion change annotations in an older cursor sequence.

## Decision

1. Both live-track queries materialize the complete point set satisfying
   `ingested_revision <= T`, ordered by bigint `seq`.
2. PostgreSQL derives the immediate predecessor with `lag(...)` before keyset
   page filtering. The first point in a continuation page therefore retains a
   predecessor from an earlier page when one exists.
3. Each point with a predecessor is evaluated by the existing immutable
   `app_private.evaluate_track_edge(...)` function and the cursor-bound algorithm
   version. The frontend does not duplicate sequence, segment, accuracy, time,
   distance, or speed rules.
4. `predecessorSeq` identifies the immediate predecessor even when the edge is
   rejected; only the first point in the fixed-revision track has no predecessor.
   `connectFromPrevious` is false without a predecessor or when evaluation rejects
   the edge.
5. Change pages select their repair upserts from the same materialized point set
   used for predecessor and edge evaluation. Later ingestion cannot enter either
   the repair set or its annotations during continuation.
6. The public `TrackPage` schema and database privileges remain unchanged.
   Cursor signing, user binding, expiry, and browser application remain P07.4
   and P07.5 scope.

## Consequences

- Snapshot and change pages now expose server-authoritative map connectivity
  consistent with summary processing at the same algorithm version.
- Materializing and windowing up to the 50,000-point run bound costs more than
  page-local evaluation, but it is required for stable predecessor semantics.
  Query-plan and latency measurement remain P11 work.
- A rejected edge still exposes its predecessor identity, allowing a client to
  replace a previously accepted relationship after a late insertion or quality
  change without inferring track rules.

## Verification

- Real runtime-role integration covers accepted and rejected edges, predecessors
  across snapshot and change-page boundaries, late-insertion successor repair,
  and fixed-T behavior while newer points arrive.
- Full lint, strict typechecking, unit tests, production builds, migration
  preflight, and the complete real-role/PostGIS integration suite pass.
