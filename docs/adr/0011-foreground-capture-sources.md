# ADR-0011: Fenced foreground capture sources and durable segments

- Status: accepted; P05.5 implemented and locally verified
- Date: 2026-09-26
- Scope: P05.5 only

## Context

The browser runner already has durable sequence allocation, upload recovery, and
a fenced single-writer lease, but no source can create measurements. Browser
Geolocation and the deterministic simulator have different callback and timing
APIs. Lifecycle transitions, permission failures, late callbacks, and lease
takeover must not produce points in the wrong capture session.

## Decision

1. Device Geolocation and the existing seeded fixture simulator implement one
   `CaptureSource` interface. Sources emit measurements without `seq` or
   `segmentId`; IndexedDB remains the only allocator of those identities.
2. A `CaptureController` owns one foreground source subscription while the
   confirmed run is `recording`. Pause, finish, unmount, source failure, or
   writer loss invalidates its generation before stopping the source. A callback
   from an invalidated generation cannot be persisted, including one delayed
   behind an asynchronous ownership check.
3. Source callbacks are serialized. Before every point, the controller renews
   ownership, and IndexedDB compares the same user/owner/fencing token and lease
   expiry inside the point write transaction. A stale tab therefore cannot
   append after a successor takes over between the callback and persistence.
   At most 100 measurements may wait behind storage; overflow stops capture with
   a visible error instead of creating an unbounded in-memory queue.
4. IndexedDB atomically allocates a monotonically increasing non-negative
   `segmentId` when a capture session starts. Start, resume, and recovery create
   a new segment, making lifecycle and foreground interruptions explicit without
   deriving them from device timestamps.
5. A successful append wakes the existing upload worker. Network state does not
   gate capture; offline measurements remain in the durable buffer.
6. The simulator reuses `@running-tracker/fixtures` with a fixed UI seed and
   current capture start time, but its fixture `seq` and `segmentId` never enter
   runner storage.
7. No Mapbox token contract exists in the tracked environment configuration and
   no token was supplied for this task. P05.5 keeps capture and its tests
   independent of an external map; archive/live map work remains in P08/P09.

## Consequences

- Geolocation permission and availability failures are visible capture state,
  without logging coordinates.
- Segment allocation can leave an empty segment when a source fails before its
  first point. This is preferable to reusing an identity after an uncertain
  interruption.
- The guarantee is foreground-only. Browser suspension and screen locking can
  stop callbacks; the client does not synthesize points to maintain cadence.
- Device permission UX and actual GPS quality still require real-device QA.

## Verification

- Unit tests adapt Geolocation and the deterministic simulator through the same
  measurement shape.
- Controller tests cover ordered persistence, one durable segment per session,
  stale callback rejection while ownership is in flight, and fail-closed lease
  loss.
- Shared fake-IndexedDB tests cover fenced segment allocation and point writes
  across lease expiry/takeover.
