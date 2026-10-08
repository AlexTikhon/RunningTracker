# ADR-0052: Explicit local recovery discard for a run the server refuses

- Status: accepted; implemented and verified locally
- Date: 2026-10-07
- Amends: ADR-0051 decisions 5 and 6 (a refused run now has a deliberate way out), ADR-0048 (the discard of rejected points stays as it was)
- Amended by: ADR-0055 (the same refusal now also arrives from an upload or a command on an open page, without a reload)

## Context

ADR-0051 made the browser ask the server before it resumes a restored run, and made a definite "no" (`refused`) stop
capture without deleting anything. That left a trap. When the server answers 410 `RUN_DELETED`, 404 `RUN_NOT_FOUND` or
403 `ORG_ACCESS_DENIED`, the browser can never finish the run (a command needs the run), never upload for it, and the
only discard that exists (`discardRejectedRun`, ADR-0048) requires an upload rejection **and** a finished run. The
active-run pointer in IndexedDB therefore stays for ever, the Start button stays unavailable, and "Check again" can
only repeat the same answer.

## Decision

1. **Refused is kept apart from unreachable, and now carries the server's error code.** `RunAuthority.refused` is
   `{ code, message }`. The code is the `RunnerApiError.code` of the answer; nothing is decided from the message, and
   no response body, request reference or status is stored. `unreachable` (network, timeout, 5xx, 408/425/429,
   unreadable body, local write failure) never carries a code and never opens anything destructive. 401 still belongs
   to the session layer.
2. **Which refusals open the discard is an allowlist of codes, not "any 4xx"**: `RUN_DELETED`, `RUN_NOT_FOUND`,
   `ORG_ACCESS_DENIED` (`refusedRunMayBeDetached`). They are the server answers that mean this identity cannot use
   this run, now or later. Every other refusal (`INVALID_REQUEST`, `ROUTE_NOT_FOUND`, `ORIGIN_DENIED`,
   `HTTP_ERROR`, a conflict...) is about the request or the deployment, says nothing about the run, and offers only
   "Check again" and the export.
3. **A refusal never deletes anything.** Capture stays stopped; the run pointer, the buffered points and the queued
   requests stay, as in ADR-0051, until the person acts. The points can be exported first.
4. **One new local operation, `discardRefusedRun(scope, lease)`**, sharing a private transaction with
   `discardRejectedRun` (whose preconditions and error are unchanged). In one `readwrite` transaction over leases,
   points, requests, profiles and runs it:
   - verifies the writer lease itself (owner, fencing token, expiry), so a stale or non-writer tab fails inside
     IndexedDB whatever its React state says, and a lease of another user is refused;
   - requires the profile to still point at exactly this user, organization and run, so a late callback for run A
     cannot clear run B, and nothing is cleared twice;
   - deletes the buffered points of that exact `(user, org, run)`;
   - deletes the queued requests (start, pause, resume, finish) of that exact run, so no retry can resurrect it;
   - clears the active org and run pointer, keeping the per-user capture source.
   Any failure aborts the transaction and leaves the run fully recoverable.
5. **The run record stays, inactive**, exactly as after the existing discard. It holds the run snapshot and the next
   point sequence; it has no points and no pointer, so it blocks nothing, and keeping it means a sequence number of
   that run is never issued twice. It is one small record per discarded run, bounded by what the person discards.
6. **It is local only.** The page does not call FINISH, DELETE, PAUSE or any other endpoint, does not mark the run
   finished (that would be a lie about the server and would fake a control revision), and does not claim the server
   run was resolved. The reducer event is `local-recovery-discarded { runId }`: it returns the state to idle
   (`run: null`, upload idle and zero, authority neutral, no recovered request), is ignored for a run that is not the
   one shown, and is distinct from `rejected-run-discarded` and from any lifecycle event.
7. **The flow in the page** (`discardRefusedRecovery`): require the current writer lease, stop the capture controller
   and the uploader, run the transaction, dispatch the event, release the writer lease. If it fails the storage
   error is shown and the run stays as it was.
8. **The UI** (`RefusedRunNotice`) offers, for a refused run: Check again, Export buffered points and, only for the
   allowlisted codes, Discard local recovery. The discard needs a second explicit press on a confirmation that says it
   only clears this browser's copy, that it does not restore the run or delete anything on the server, that the unsent
   points will no longer be recoverable from here, and to export first. The button is disabled for a tab that does not
   own the lease and while a request is in flight. For such a run the blocked-upload notice is not shown beside it,
   since its discard (finished run only) cannot apply.

## Consequences

- A deleted or inaccessible run no longer traps the browser: after the discard the person is idle and Start follows
  the normal organization rules.
- Discarding is destructive for the unsent points of that browser. The only safeguards are the two-step confirmation
  and the export; there is no archive of discarded points (deliberately: not a new subsystem).
- After an access loss the server still holds the old run as the person's one active run until it is finished or
  auto-finished, so a new Start in a restored organization can be answered `ACTIVE_RUN_EXISTS`. That is the server's
  rule; this change does not alter it.
- The uploader is not gated by the authority (ADR-0051 left it so); for a deleted run its first upload is answered
  410, which marks the stored run as upload-rejected. That marker is harmless to the discard, which does not require it.

## Verification

Unit: classification by code (including that 5xx/429/408 never carry a code), reducer allowlist and the new event,
the storage transaction (exact points and requests removed, neighbouring runs and users untouched, stale and expired
lease, lease taken over by another tab, wrong run, wrong organization, another user's lease, delayed discard after a
newer run, already cleared, injected failure part-way, reload), and the notice and Runner view markup (refused versus
unreachable, writer and busy gating, confirmation text, idle after discard). Browser
(`tests/e2e/refused-run-recovery.spec.ts`, real API and database): a deleted run (data kept, export, cancel, discard,
no mutating request, new run), access loss, an unreachable server (never offered), and a second tab (disabled until
it owns the lease).
