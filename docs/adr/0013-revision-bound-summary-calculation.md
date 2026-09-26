# ADR-0013: Revision-bound summary calculation and accepted chains

- Status: accepted; P06.2 implemented and locally verified
- Date: 2026-09-26
- Scope: P06.2 only

## Context

Summary metrics and future archive geometry must be derived from exactly the
same revision-bounded point set and the P06.1 edge rule. The calculation also
needs stable quality-counter semantics before P06.4 can persist and publish a
summary.

## Decision

1. `app_private.calculate_run_summary(org, run, sourceRevision, version)` is a
   read-only `STABLE SECURITY DEFINER` maintenance capability. It reads only
   points with `ingested_revision <= sourceRevision`, orders them by `seq`, and
   calls `app_private.evaluate_track_edge(...)` for every neighboring pair.
2. `distanceM` and `observedDurationS` sum accepted edges only. Delivery time is
   irrelevant. With no accepted edge, both metrics are zero and
   `insufficientData` is true.
3. `acceptedPointCount` counts distinct endpoints participating in at least one
   accepted edge. Isolated points do not become accepted points or fabricated
   lines. `poorAccuracyPointCount` counts raw points above the versioned
   accuracy threshold; the remaining reason counters count the evaluator's
   stable primary reason for each rejected neighboring pair.
4. Consecutive accepted edges form one ordered chain. A rejected edge ends the
   current chain, so later valid points cannot bridge a gap, pause, bad point,
   invalid time delta, or speed spike. The function returns the unsimplified
   chains as a nullable WGS84 `MultiLineString`; P06.3 owns metric
   simplification and antimeridian normalization.
5. Unknown algorithm versions and negative source revisions fail with SQLSTATE
   `22023`. PUBLIC and the HTTP runtime role cannot execute the function. The
   maintenance role can execute it but retains no direct table access.

## Consequences

- Late lower-sequence points deterministically change a later revision's edges
  without changing the result calculated for an earlier source revision.
- Quality counters intentionally do not need to sum to the number of raw
  points: edge reasons classify neighboring pairs, while poor accuracy is a
  per-point count.
- P06.2 neither simplifies geometry nor writes `run_summaries`, locks runs or
  organizations, advances `archive_revision`, schedules jobs, or exposes HTTP.

## Verification

- Real PostGIS integration covers empty and isolated inputs, all counter
  categories, multiple accepted chains, independently bounded equatorial
  distances, revision rebinding after a late point, delivery-time independence,
  invalid inputs, and runtime/maintenance/PUBLIC privileges.
- Repository lint, strict typecheck, unit tests, production builds, migration
  preflight, and the full real-role integration suite pass.
