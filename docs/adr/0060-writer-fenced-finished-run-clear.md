# ADR-0060: "New run" clears only the expected finished run, for the live writer epoch

- Status: accepted; implemented and verified locally
- Date: 2026-10-21
- Amends: ADR-0059 (closes the gap it left open: `clearActiveRun` was unfenced)
- Relates to: ADR-0053 (the monotonic fencing epoch), ADR-0055 (scoped run authority)
- Scope: `apps/web` only. No API, SQL, schema, migration, dependency or server lease.

## Context

"New run" called `clearActiveRun(userId)`, a profiles-only transaction that set the active-run pointer to null. It got
neither the run it was meant to clear nor a writer capability, and it checked nothing: not the run's status, not the
buffered points, not the queued requests. The button was disabled from React state, which goes stale when the lease
expires or another tab takes over. Reproduced on 9211f08: A shows finished run A, its lease expires, B takes the next
epoch, clears A, starts run B and buffers a point. A's delayed clear then cleared B's pointer. `loadRecovery` returned
`run: null` and `pendingPointCount: 0` while B's point was still in IndexedDB and B's lease was valid. The point was
hidden from recovery, not deleted.

## Decision

1. **Fenced clear.** `clearFinishedRun(scope, lease)` replaces `clearActiveRun`. One `readwrite` transaction over
   `leases`, `points`, `profiles`, `requests` and `runs` checks, in order, before its only write: the lease is the
   live epoch; the profile points at exactly this user, organization and run; the stored run is `finished`; no point
   of it is buffered; no lifecycle request of this user is queued. Then it sets the pointer to null and keeps
   everything else (run record and point sequence, capture preference).
2. **Outcomes, not errors.** `{ outcome: 'cleared' }`, `obsolete` (`writer-lost`, `not-active`) or `blocked`
   (`not-finished`, `points-buffered`, `request-pending`). Anything but `cleared` writes nothing.
3. **Completion ownership** (`finished-run-clear.ts`, used by `App`). The page records the session signal, the
   coordinator and an operation token when the clear begins; a suspended session drops the token. The coordinator
   proves the lease first, and the transaction uses the lease that proof returned. On completion:
   - a replaced session or operation gets nothing: no dispatch, no release, no error shown;
   - only the same session, operation and coordinator, still holding the same epoch, dispatches
     `finished-run-cleared` (which carries the run id; the reducer ignores a clear of another run) and releases.
     The release is checked and started in the same turn, so it never releases a successor's epoch;
   - anything else (stale or lost epoch, wrong run, pending work, or a newer epoch at completion) re-reads
     IndexedDB and dispatches `storage-restored`. If the transaction found the lease lost, the lease is proven again
     first, so the writer state shows the loss.
4. **Test seeding stays outside the product path.** `activateRunSnapshot` is documented as test and fixture setup
   only. Tests that need a pointer moved off an unfinished run use `detachActiveRunForTest` in
   `runner-storage-test-support.ts`, which no application module imports. There is no unfenced clear on the storage
   class.

## Consequences

- A stale tab can no longer hide another epoch's run or points, nor a run of its own with buffered points or an
  unresolved request. A blocked clear shows the durable state (for example, the points still waiting for upload).
- The normal flow is unchanged: finished, uploaded, nothing queued, then "New run" and "Start run".
- The browser's proof of the lease and the transaction are separate steps. A takeover between them is caught by the
  transaction (rule 1), not by the proof.

## Verification

`finished-run-clear.spec.ts` (19 tests): two storage instances on one `IDBFactory`, an injected clock and deferred
barriers. It covers stale A after B started another run, the same owner under a newer token, a released lease,
another organization or run, a second clear, recording and paused runs, buffered points, an unresolved Finish, the
positive control (clear, then Start another run, reload), and the completion rules: a session replaced while the
clear is pending, a newer epoch at completion, a stale page following B's run, an ownership proof that fails, a
blocked clear, and failures. `runner-state.spec.ts` covers the run-scoped `finished-run-cleared`. In the browser,
`tests/e2e/new-run-takeover.spec.ts` (Chromium, real IndexedDB, real API, two live pages) takes over by the normal
claim path after expiry. Page A's renewal timer is held by a page-scoped init script, so the click is caught by the
lease proof before the transaction. Durable state is checked after a reload. A positive control in the same file
covers New run, reload, Start and reload. Results are in `docs/progress.md`.
