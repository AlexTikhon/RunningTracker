# ADR-0068: Review the current finished run directly from Runner

- Status: accepted; implemented, verification recorded in `docs/progress.md`
- Date: 2026-11-02
- Depends on: ADR-0066/0067 (published track read and owner details)
- Scope: web navigation and result presentation, focused tests and documentation

## Decision

Runner offers **View result** once its current run is finished and the lifecycle is confirmed by the
server, with no unresolved lifecycle request. This action opens the existing RunDetailScreen for that
exact run without searching My runs or waiting for a published summary. The direct view uses kilometres
and the browser's supported IANA timezone (UTC fallback); Archive details keep their applied search units.

The action is explicit; Finish does not navigate automatically. **Back to Runner** returns to the finished
controls and restores focus to View result. **New run** retains its existing writer-fenced clear and
empty-buffer requirements and is reached through Back. No URL router or automatic polling is introduced.

## Synchronization is separate from publication

The direct result shows this device's synchronization status independently of the server read. It keeps
route/metrics/quality hidden while measurements remain buffered, upload is rejected/suspended/unsettled,
or the tab no longer owns synchronization. Offline work explains that upload resumes on reconnection;
rejected work points back to the existing export/recovery controls. Opening/closing the result never
clears local points, acknowledges commands or starts a separate uploader.

An empty buffer does not make an already displayed ready summary current: the run data revision known
from upload ACKs may have advanced after the detail read. The screen compares decimal revisions through
BigInt. If the read predates that revision, its route/metrics stay hidden and the person is asked to
Refresh run. Once the read includes acknowledged uploads, ADR-0066's pending/stale/ready states still
govern publication. A current summary is an authorized point-in-time read, not a guarantee against future
uploads from some other client.

Archive details have no active-run synchronization input and preserve ADR-0067's existing behavior.

## Ownership and lifetime

App continues to own writer, uploader, lifecycle requests, storage recovery and capture. The Runner
presentation stays mounted and hidden while its result is open; opening changes presentation only.
The selection carries user, organization, run and session signal, and is rendered only while those
still match the current finished run. Session suspension clears it; top-level navigation closes it.
RunDetailController retains read cancellation, stale-completion rejection and displayed-map lifetime.
Losing the writer while the result remains open removes route/metrics until synchronization can be
confirmed again. Back changes no recording capability.

A restored finished run and a finished run seen offline use the existing authoritative read on load or
reconnection. Finished remains terminal and capture stays stopped, but deletion/membership changes can
still make its result unavailable. The action waits for this read rather than trusting IndexedDB.

## Validation and boundaries

Unit tests cover result entry for confirmed/unconfirmed lifecycle and synchronization decisions,
including failure states with a zero count. Browser tests use native IndexedDB and the real API for
Finish, saved offline command retry, retained uploads, catch-up while the result is open, old-ready
summary suppression after ACKs, recovery, Back/New run, deletion and late reads across navigation/sign-out.
The test fixture invokes the production calculation/publication SQL on one guarded test run so ready
results do not depend on the periodic worker timer. Pending/stale presentation in one scenario is
substituted at the browser transport boundary, not claimed as a worker integration test.

No HTTP contract, database/migration, retention, metric algorithm, dependency, provider setting,
deployment or background-recording guarantee changes in this slice. Physical-phone evidence remains
a separate milestone.
