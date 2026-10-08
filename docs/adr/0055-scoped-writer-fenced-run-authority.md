# ADR-0055: Scoped, writer-fenced run authority across React, IndexedDB and every refusal path

- Status: accepted; implemented and verified locally
- Date: 2026-10-08
- Amends: ADR-0051 decision 4 (how a read is ordered, cancelled and stored), ADR-0052 decisions 1 and 7 (a definitive
  refusal now also arrives from an upload or a command, not only from a read), ADR-0053 (the writer epoch now fences the
  storing of a server answer, not only capture and discard)
- Scope: `apps/web` only. No API, SQL, schema, dependency, session or geospatial change.

## Context

ADR-0051 made the browser ask the server about a restored run and ADR-0052 gave a refused run a way out, but two things
were still not true.

1. **A read could change durable recovery after the page had moved on.** `readAuthoritativeRun` stored its answer
   (`saveRunSnapshot`) *before* returning the event that the reducer validates, and `saveRunSnapshot` always pointed
   the profile at the incoming run and checked neither the writer lease nor the expected active run. Dropping the
   reducer event afterwards cannot undo an IndexedDB write. Reproduced against the real helper and storage class
   (fake-indexeddb, recovery reopened afterwards): an old read of A finishing after A was cleared and B started left
   A active and recording instead of B; after an explicit discard it restored A as the active run; after the writer
   was released and a newer epoch acquired it wrote under the obsolete epoch.
2. **A refusal during recording missed the recovery flow.** The upload worker's permanent-error callback ran its own
   `readRun -> saveRunSnapshot -> run-reconciled`; for a deleted run or a revoked membership that read fails, the worker
   swallows it, upload turns *blocked* but the authority stays *confirmed* and no discard is offered until a reload.
   A lifecycle command refused with the same codes only became "Request not confirmed".

## Decision

### Durable boundary (`runner-storage.ts`)

1. **Activating a run and refreshing the active run are different operations.** `activateRunSnapshot` (the former
   `saveRunSnapshot`) is the write that points the profile at a run. `refreshActiveRun(scope, run, lease)` merges a
   server answer into the record of the run the profile already points at and **never moves the pointer and never
   creates a record**.
2. **The checks are in the write's own transaction.** One `readwrite` transaction over `leases`, `profiles` and `runs`
   verifies that the lease is the live record for exactly that owner and fencing token (so a renewal still counts, a
   release, an expiry, another tab and the same owner's *newer epoch* do not), and that the profile still names exactly
   that user, organization and run and the run record exists. Only then does it put the merged record.
3. **An obsolete write is an outcome, not an error and not a success.** `StorageWriteOutcome` is
   `{ outcome: 'applied' }` or `{ outcome: 'obsolete', reason: 'writer-lost' | 'not-active' }`. In the obsolete case no
   store is written at all (asserted by comparing every store before and after, and after reopening the database).
   A lease of another user, or a snapshot of a run other than the scoped one, is a programming error and throws.
4. **`rejectUpload(scope, message, lease)` uses the same fenced write**, so a late upload failure of a run that was
   cleared, discarded or replaced, or of a writer that was lost, marks nothing.

### One owner of the read lifetime (`run-authority.ts`, `RunAuthority`)

5. **Scope is asked, not remembered.** The page gives the coordinator four accessors read at the moment of use: the
   writer lease it holds (`WriterLeaseCoordinator.currentLease()`, in memory), the user/organization/run it shows,
   the session lifetime signal and whether the browser is online. A completion is compared with those, never with what
   was true when the read began.
6. **At most one read is in flight.** Asking again for the same scope, writer epoch and purpose returns the running
   read (deduplication); anything else replaces it (supersession), except that a background reconciliation joins the ordinary confirmation of the same scope
   already running (replacing it would leave the attempt the reducer awaits unanswered). The replaced read is aborted, but the abort is only
   cleanup: when a transport ignores it and the answer arrives, eligibility is decided from the page's present state.
   The number of reads that can still report is therefore 0 or 1, however many answers arrive late.
7. **Gate before durable work, then fence inside it.** After an answer: (a) not current -> dropped, nothing written,
   nothing dispatched; (b) writer held -> `refreshActiveRun` with the captured lease; an `obsolete` result is not
   confirmed; it is reported as *unreachable* with a message that the answer was not saved ("not-saved"), which the
   existing 5 s retry turns into a fresh read for the current scope and writer; (c) re-check after the await; only then
   `authority-confirmed`. A tab that is not the writer (no lease) **shows an eligible answer and never stores it**.
8. **Invalidation.** The page ends the read in flight when the run, identity, organization, session or writer epoch
   changes (an effect keyed on `user|organization|run|epoch` and on the session signal), when the page unmounts,
   immediately before a finished-run clear or either discard, and when a definitive refusal is accepted. A restore from
   storage after a claim also invalidates, because it replaces the state the read was asked about.
9. **Reads are numbered by the coordinator and the numbers only grow.** The reducer accepts `authority-requested` when
   the attempt is newer than every one seen, including while a read is in flight (a restart after a writer change keeps
   an offline capture running), and still drops an equal or older number and the answer to any read but the current one.
10. **Reads wait until the writer question is settled** (not `unclaimed`, not `acquiring`, not while an explicit claim is
    taking over the previous owner's state), so a normal reload asks once, as the tab that will store the answer.
11. **401 stays with the session layer**: it yields no event. Transport failures, 408/425/429, 5xx and malformed bodies
    are *unreachable*, never a refusal, whatever error code they carry.

### Refusals join the same flow

12. **One classifier.** `refusalOf(error)` is a 4xx that is neither 401 nor 408/425/429; `unrecoverableRefusalOf` adds the
    ADR-0052 allowlist (`RUN_DELETED`, `RUN_NOT_FOUND`, `ORG_ACCESS_DENIED`). Reads, uploads and commands all use them.
13. **New reducer event `authority-refused { runId, code, message }`**: a definitive answer that did not come from a read.
    Ignored for a run that is not the one shown; otherwise authority becomes `refused` (ending a read in flight), leaving
    the run, upload count, blocked upload and any failed request exactly as they were. `coordinator.refuse(scope, ...)`
    accepts it only for the page's current scope and invalidates the read in flight first.
14. **Upload.** On a permanent error the callback checks the scope, stops capture, marks the queue rejected through the
    fenced write and, for an allowlisted refusal, dispatches the refusal at once (stop capture, points kept and
    exportable, explicit discard shown, no reload). Any other permanent rejection (a 400/409/413 about the request) asks
    the server what the run is through a *reconcile* read of the same coordinator (merge on success, the same refusal on
    a definitive answer, silence when unreachable), replacing the independent `readRun/saveRunSnapshot`.
15. **Commands.** A command failing with an allowlisted refusal is reported as before (`request-failed`; the exact
    request stays queued under its own id and expected revision) and *also* as an authority refusal for that run. A
    revision-conflict reconciliation read that is itself refused for good surfaces that refusal. A network failure, 5xx,
    408/425/429 or any unknown outcome is only a failed request, retried with the identical command identity.
16. **Discard.** After the explicit ADR-0052 discard the page reloads organization discovery, so a lost membership shows
    "no organization" and the next run follows what the server lists now. The "Server state" card shows `refused` rather
    than `error` when both apply.

## Consequences

- A delayed or refused network completion can no longer make React, the durable recovery and the writer lease disagree:
  it is dropped before durable work when the page moved on, and fenced inside the transaction when it did not.
- A read-only tab can show a refusal or a confirmation and cannot store it.
- Reconnection, restore and "Check again" still ask the server; the extra reads in a reload that the old effect
  produced by accident are gone (one read per writer epoch).
- `acknowledgeStart`, `acknowledgeCommand`, `acknowledgeReconciledRequest` and `queueRequest` still use the activation
  write with the ownership check made just before it by the caller (`assertOwned`), not inside the transaction. They are
  tied to a queued request identity and were out of this change; the residual race is described below.
- The uploader is still not gated by the authority (ADR-0052): after a refusal it can make one more attempt, which
  receives the same answer. Its `upload-changed` reports are dropped when they are for another scope.

## Verification

Unit, on the real storage class (fake-indexeddb, every store compared before/after, database reopened):
`runner-storage-refresh.spec.ts` (refresh merges for the current writer; monotonic merge; renewal keeps the capability;
A answer after A finished/cleared and B started; after an explicit discard; release then same-owner reacquire; expired
and taken-over lease; a release queued ahead of or behind the refresh transaction; wrong organization/run/user; fenced
`rejectUpload`). `run-authority.spec.ts` drives `RunAuthority` against that storage with held reads and a transport that
ignores abort (all three review interleavings, supersession, duplicates, out-of-order answers, attempt numbers,
read-only tab, the not-saved outcome, 401, abort, classification table, refusal gating, reconcile mode).
`runner-requests.spec.ts` (allowlisted refusal versus transient failures and the identity of the retried command).
Reducer: `authority-refused`, newer-attempt supersession. `writer-lease-epoch.spec.ts`: `currentLease()`.

Browser (`tests/e2e/authority-reconciliation.spec.ts`, real API and database): see `progress.md` for the red run on the
previous implementation and the green run.

## Remaining limitations

- The acknowledge/queue writes above keep a preflight ownership check; fencing them in their transactions would be the
  same change again for each, with their request-identity rules.
- A browser aborts the fetch of a superseded read, so the mounted "old read after B started" scenario cannot reproduce
  the original defect in Chromium by itself; the durable-boundary defect is covered by the real-storage and coordinator
  tests, which make the transport ignore the abort.
- Two tabs of the same person are arbitrated by the existing lease only; nothing here adds cross-tab messaging.

## Executed results

On the working tree: `npm run verify` passed (scripts 36, API 771, web 390, contracts 18, fixtures 14, simulator 3);
`npm run test:e2e` passed with 74 Chromium tests, 7 of them new. The seven new browser scenarios were first run against
the previous source: five failed for the reasons above, two passed (see `progress.md`). `test:integration` was not run:
nothing outside `apps/web` changed.
