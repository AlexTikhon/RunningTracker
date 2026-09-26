# ADR-0009: Foreground point upload acknowledgement and retry boundary

- Status: accepted; P05.3 implemented and locally verified
- Date: 2026-09-26
- Scope: P05.3 only

## Context

IndexedDB contains canonical, run-scoped points, but P05.2 intentionally did
not decide when a point can be removed or how failed HTTP attempts resume. A
transport failure can happen after PostgreSQL commits, multiple tabs may run
the uploader before P05.4 adds ownership, and a lifecycle command can become
stale when server auto-finish wins while the browser is offline.

## Decision

1. One foreground worker processes one run sequentially. It reads at most 100
   points in numeric `seq` order and keeps that exact array immutable until the
   attempt settles.
2. A successful response is accepted only when the shared response contract is
   valid and `insertedCount + duplicateCount` equals the sent batch length.
   IndexedDB then deletes only those explicit sequences and monotonically
   records the returned `dataRevision` in the same local transaction.
3. Transport failures, storage failures, HTTP 5xx, 408, 425, and 429 retain the
   complete batch. Retries use exponential full jitter capped at 30 seconds;
   a valid `Retry-After` can extend the delay up to five minutes. Going offline
   cancels a scheduled retry, and reconnecting wakes the same durable buffer.
4. Other HTTP 4xx responses and an incomplete success acknowledgement are
   permanent for that worker instance. Automatic upload stops, buffered points
   remain intact, and the client attempts an authenticated run read to refresh
   the durable and visible server snapshot.
5. A lifecycle `CONTROL_REVISION_CONFLICT` is terminal for its stored command.
   The client reads the authoritative run and only then atomically removes the
   stale command while storing that run. If the read or local transaction
   fails, the original command remains queued.
6. A finished run cannot be cleared from the UI while buffered points remain.
   This keeps its scope reachable until upload succeeds or a permanent error is
   surfaced for reconciliation.

## Consequences

- A lost HTTP response causes an exact retry, which the server ingestion
  endpoint already handles idempotently. Concurrent P05.3 workers may duplicate
  network work but cannot broaden local deletion beyond acknowledged sequences.
- Automatic retry is deliberately conservative: permanent client/domain errors
  require user-visible intervention rather than an infinite request loop.
- The worker runs only while the page is active. P05.3 does not claim background
  browser delivery, implement a service worker, capture GPS, or solve the
  P05.4 cross-tab writer policy.

## Verification

- Deterministic fake-timer tests cover 205 points as 100/100/5 batches, exact
  ACK deletion, response-loss retry of the unchanged batch, jitter and
  `Retry-After`, offline/reconnect, permanent-stop behavior, and rejection of
  an incomplete acknowledgement.
- IndexedDB tests cover monotonic acknowledged revisions and atomic stale-command
  reconciliation while retaining the existing explicit duplicate-ACK checks.
