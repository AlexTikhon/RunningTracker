# ADR-0008: Durable runner buffer and local acknowledgement boundary

- Status: accepted; P05.2 implemented and locally verified
- Date: 2026-09-26
- Scope: P05.2 only

## Context

Browser recording must not reuse a point sequence or lose a captured point when
the page reloads between separate local writes. Lifecycle requests also carry
the idempotency identity needed to recover from an unknown server outcome. An
in-memory retry object protects neither invariant.

JavaScript `number` cannot represent the complete PostgreSQL positive-bigint
domain. IndexedDB string keys sort lexicographically, so canonical decimal
`seq` values cannot be used directly for ordered batch reads.

## Decision

1. One versioned IndexedDB database contains `profiles`, `runs`, `points`, and
   `requests` stores. Every durable record is partitioned by authenticated
   `userId`; run data is additionally scoped by `orgId` and `runId`.
2. A read-write transaction over `runs` and `points` reads the next decimal
   bigint sequence, validates the complete canonical `PointInput`, inserts the
   point, and advances the sequence. A failed validation or storage operation
   aborts both changes.
3. Canonical `seq` remains a decimal string in the payload. A separate internal
   19-character zero-padded key preserves positive-bigint numeric ordering in
   the IndexedDB compound index without a lossy `number` conversion.
4. Point reads are bounded to the server batch maximum of 100. The local ACK
   operation deletes only the explicit sequence set supplied by the caller and
   is idempotent; it never clears a run-wide buffer implicitly.
5. The exact start or lifecycle request is persisted before its HTTP mutation.
   Start/run IDs, command IDs, expected control revision, and command type are
   preserved. Network failure and offline state retain the record.
6. A successful server response and deletion of its request are represented by
   one local transaction that also stores the new confirmed run snapshot. If
   that local transaction fails after the server commit, the request remains
   retryable against the server's idempotent endpoint.
7. The active run pointer and pending request are restored only after the
   authenticated session identifies the user. Clearing a finished run removes
   the UI pointer but deliberately retains any buffered points.

## Consequences

- Reload and temporary offline state no longer reset the sequence, point
  buffer, confirmed run snapshot, or exact unacknowledged lifecycle request.
- IndexedDB transaction serialization prevents duplicate local sequence
  allocation, but it is not the P05.4 single-writer policy. A writer lease and
  explicit conflicting-tab UX remain required.
- P05.2 exposes bounded point read/explicit ACK primitives but does not schedule
  uploads, classify HTTP failures, or implement backoff/jitter; those remain
  P05.3.
- Geolocation and simulator capture remain P05.5. Browser foreground execution
  is still not a background GPS guarantee.

## Verification

- IndexedDB tests execute against `fake-indexeddb` and cover concurrent
  allocation, close/reopen recovery, validation rollback, bounded ordered
  reads, duplicate explicit ACK, exact request recovery, atomic server-state
  acknowledgement, and retention of buffered points after UI clearing.
- reducer coverage verifies restoration of the run, pending point count, and
  exact unacknowledged request.
