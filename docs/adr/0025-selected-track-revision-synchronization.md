# ADR-0025: Selected-track revision synchronization and reconnect recovery

- Status: accepted; P08.4 implemented and locally verified
- Date: 2026-09-27
- Scope: P08.4 only

## Context

The live stream announces complete authorization-filtered run state and each
run's `dataRevision`, while P07.5 already provides atomic snapshot/change page
application. The coach must connect explicit track selection to that store
without starting duplicate page chains, exposing partial geometry, retaining a
revoked track, or treating SSE replay as durable recovery.

Transport loss is ambiguous: it may be transient or caused by authorization
loss. Coordinates and geometry must disappear immediately, but a same-session
reconnect should be able to restore the user's selection after a fresh
authorization-filtered state.

## Decision

1. A `SelectedTrackSynchronizer` owns one `LiveTrackStore` per mounted
   user/organization coach scope. It reconciles only the intersection of the
   current full `live.state` run set and explicit selected run IDs.
2. Each selected run delegates to the store's existing single-flight page
   chain. Repeated SSE notifications retain the greatest requested revision;
   the store may run a follow-up changes traversal but publishes geometry only
   after a terminal page.
3. Deselecting a run, omitting it from a later authorized state, changing
   identity/organization, or losing the stream aborts the active HTTP request
   and evicts its committed in-memory track. A late completion is ignored by
   identity checking even if an injected page source does not honor abort.
4. A changed announced algorithm version evicts the old track and starts a
   fresh snapshot. Revision equality alone is therefore not enough to reuse
   geometry across algorithm versions.
5. On transport loss, visible markers, selection, and geometry are cleared.
   Only the selected run-ID intent is retained temporarily for the same mounted
   session/organization. The first new full state intersects that intent with
   newly authorized runs before restoring selection and starts from a fresh
   snapshot. A full-state omission permanently drops the intent.
6. Native `EventSource` retry remains disabled. Recoverable transport failure
   uses bounded delays of 1, 2, and 4 seconds and never schedules a retry at or
   beyond the known session expiry. Invalid contract data does not retry
   automatically; manual retry resets the bounded sequence.

## Consequences

- SSE remains a revision notification channel, not a replay log. A reconnect
  obtains current authorization and revision from a new stream, then uses
  snapshot/changes HTTP reads.
- Track removal is fail-closed and releases network work, at the cost of a full
  snapshot after a transient disconnect. This favors authorization safety over
  retaining reconstructible geometry.
- Coalescing is per run, so different selected runs may load concurrently. The
  50,000-point per-run bound and broader browser concurrency/memory measurement
  remain P11 concerns.
- P08.4 exposes synchronized point counts and revisions without adding a map
  SDK or token. Geographic rendering remains P09.

## Verification

- Store tests cover abortable eviction while preserving atomic page-chain
  behavior.
- Coordinator tests cover one in-flight run, greatest-revision coalescing,
  authorization removal, and algorithm-version replacement.
- Coach state/client tests cover hidden selection intent across a bounded
  same-session reconnect, fresh-state reauthorization, retry bounds, and
  session-expiry cutoff.
