# ADR-0061: Foreground device GPS recovers from temporary location failures

- Status: accepted; implemented and verified locally (unit tests and Chromium with a simulated receiver)
- Date: 2026-10-21
- Amends: ADR-0011 (capture sources) and ADR-0047 (persisted capture source); keeps ADR-0053, ADR-0059 and ADR-0060
- Scope: `apps/web` and `tests/e2e` only. No API, SQL, schema, migration, contract, dependency or GPS threshold.

## Context

`GeolocationCaptureSource` turned every `GeolocationPositionError` into a plain `Error` passed to `sink.error`, and
`CaptureController` treated every source error as terminal. It ended the generation, called `clearWatch` and dropped the
segment. The capture effect in `App` did not restart on `capture.status`, and the Runner view only said "Capture
stopped", with no way to retry. One TIMEOUT therefore ended device capture for the rest of the run, while the server
run stayed `recording`. On 6b9e1a4, one TIMEOUT followed by a valid fix gave one `clearWatch`, the state `error` and
no durable point. The new browser test shows the same thing in Chromium: "Capture stopped. The location provider
timed out…".

The W3C Geolocation API keeps a registered watch across acquisition attempts: after a timeout or an unavailable
position the watch keeps acquiring. A permission denial removes the watch, and `clearWatch` is the caller's own
removal.

## Decision

1. **Classified failures at the source boundary.** `LocationFailure` carries a `kind`: `timeout`,
   `position-unavailable`, `permission-denied`, `unknown` or `unsupported`. Only `timeout` and `position-unavailable`
   are `temporary`. The source reports them through a new `sink.interrupted(failure)`, and the watch is not touched.
   Every other kind goes to `sink.error`. A missing `navigator.geolocation` throws `LocationFailure('unsupported')`.
   An exception that is not a `LocationFailure` is never temporary.
2. **A temporary failure is a state of the same watch.** The controller queues it in callback order, behind any fix
   still being persisted, and through the same bounded queue as measurements. The state stays `capturing`, with
   `signal: 'waiting'`, a count of consecutive failures and the provider's message. The watch, segment and seq are
   unchanged. The next genuine fix is persisted as usual and sets `signal: 'live'`. Nothing restarts the watch on a
   timer, and nothing is fabricated or repeated to keep a rate.
3. **Terminal failures stay distinct.** `error` carries a `reason`: `permission-denied`, `location` (a receiver failure
   with an unknown code), `unsupported`, `source` (an unclassified exception), `storage` (anything thrown while proving
   the lease or persisting) or `overflow`. A lost writer is still the separate `lost` state. Each of them stops the
   watch once and ignores later callbacks. None of them pauses, finishes or discards anything.
4. **Explicit Retry GPS only.** `CaptureController.retry()` is refused after `stop()` (pause, finish, source change,
   session replacement, writer change), while a start is in flight (so repeated clicks start one watch), and after
   `storage`, `overflow`, `unsupported`, `source` or `lost`. Otherwise it ends the current generation and stops the
   old watch first, then runs the normal start. That start proves the writer lease again, allocates the next durable
   segment with `allocateCaptureSegment` and starts one new watch. Seq continues from the durable counter, and
   buffered points are untouched. `App` calls it only while the capture effect itself would run: the same session
   with its signal not aborted, ready storage, an owned writer, a run that `captureMayRun` allows, an unblocked
   upload and Device GPS. Retry sends no lifecycle request.
5. **Capture health.** `captureHealth(state, nowMs)` (`capture-health.ts`) returns one of these: no fix yet, capturing,
   waiting for location, no recent location, location permission blocked, capture stopped or capture complete, with
   the age of the last persisted point. The facts (count, last recorded time, last persisted time) survive temporary
   failures and retries and are labelled "(stale)" once they no longer describe a live fix. Times come from an
   injected monotonic clock (`performance.now()` in the page). `CAPTURE_STALE_AFTER_MS` (15 s) is a display rule
   only; it is not the server's edge gap or speed rule. Retry GPS is offered for a denial, a receiver failure, a
   waiting watch, or no fix within that bound. It is never offered for storage, overflow, unsupported, a lost writer
   or the simulator.

## Consequences

- A watch that times out and then gets a fix keeps recording without Pause/Resume, a reload or any server command.
- A denied permission stays stopped until the user acts. The guidance names the browser setting and Retry GPS.
- A deliberate restart costs one segment id. A callback still queued from the replaced watch is dropped, the same as
  on pause. Points already written stay buffered.
- Upload and recording remain separate: offline, eligible capture continues and points wait in IndexedDB.

## Verification

- `capture-recovery.spec.ts` (19 tests) runs the real `IndexedDbRunnerStorage` on fake-indexeddb, with a scripted
  source whose replaced subscriptions can still call back, an injected monotonic clock and fake timers. It covers
  TIMEOUT and POSITION_UNAVAILABLE recovering through one watch, consecutive failures, no first fix, callback order,
  no fabricated points, a denial with no automatic retry (no timers), a retry after denial (new segment, continuous
  seq, facts kept), a retry on a silent watch (old watch stopped first, late callbacks ignored), rapid retries,
  retries refused after stop or a takeover, and storage, overflow, unsupported, unclassified and takeover failures
  staying terminal.
- `capture-source.spec.ts` (+5 tests) covers the classification and a stopped watch. `capture-health.spec.ts`
  (13 tests) covers the health model, and `RunnerView.spec.tsx` (+5 tests) covers the notices and when Retry GPS is
  offered and enabled.
- `tests/e2e/gps-recovery.spec.ts` (3 tests, Chromium, real app, native IndexedDB, real API). The receiver is
  **simulated** at the `Geolocation.prototype` boundary. The tests cover TIMEOUT, then POSITION_UNAVAILABLE, then an
  offline fix that uploads on reconnection: same watch, same segment, gap-free seq, no lifecycle mutation. They also
  cover a denial, a late callback to the removed watch and a double-click Retry GPS (one new watch, a new segment, no
  lifecycle mutation), and Pause while waiting followed by a late callback (nothing saved).

## Limits

The browser tests do not show how any physical receiver, mobile browser, OS power policy or background/locked tab
behaves. Background tracking is not supported. D10 stays PARTIAL: the real-trace report still holds zero device
traces, and simulated callbacks do not replace them.
