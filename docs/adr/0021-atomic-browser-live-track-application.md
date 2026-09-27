# ADR-0021: Atomic browser live-track application

- Status: accepted; P07.5 implemented and locally verified
- Date: 2026-09-27
- Scope: P07.5 only

## Context

P07.1-P07.4 provide stable, signed snapshot and change page chains, but directly
applying each page would expose a point set at target revision T while the local
revision still represented A. A failed continuation could then leave a partially
updated track, and overlapping notifications could start redundant traversals.

## Decision

1. The browser `LiveTrackStore` keys state by authenticated user, organization,
   and run. Each key permits one in-flight synchronization.
2. Snapshot pages populate a new seq-keyed map. Change pages clone the last
   committed map and apply upserts to that private copy. The public point array,
   algorithm version, and revision change together only after `nextCursor=null`.
3. Every chain retains its source revision, target revision, and algorithm
   version; upserts are strictly seq-ordered and continuation cursors cannot
   repeat. Contract or transport failure preserves the previously committed state.
4. Repeated upserts replace the same seq key. Concurrent revision notifications
   share the current synchronization and retain the greatest requested revision;
   after one chain commits, another changes traversal runs only when needed.
5. Missing local state starts a snapshot. An algorithm-version mismatch or
   `INVALID_CURSOR` during changes discards staged data and starts a snapshot.
   One invalid snapshot continuation may restart once rather than loop forever.
6. State remains in memory. Reload therefore loses it intentionally and starts a
   new snapshot; IndexedDB durability is unnecessary for reconstructible coach
   views and remains reserved for the runner's unsent write buffer.

## Consequences

- Rendering never observes a revision paired with only part of its fixed page
  chain, and retries cannot create duplicate points.
- User-scoped keys prevent a new session from reusing another identity's cached
  track even when organization and run identifiers are the same.
- A full temporary map briefly doubles per-track point memory during changes.
  The accepted run bound is 50,000 points; measurement and broader memory limits
  remain P11 work.
- SSE transport, run selection, cancellation on revocation, markers, and map
  rendering remain P08 and do not enter this state primitive.

## Verification

- Unit coverage proves atomic multi-page commit, rollback on continuation failure,
  late-insert successor repair, idempotent replay, algorithm/cursor snapshot
  recovery, single-flight target coalescing, and cross-user state isolation.
- The repository-wide verification gate and focused P07 real-role/PostGIS HTTP
  integration pass with unchanged migrations and contracts.
