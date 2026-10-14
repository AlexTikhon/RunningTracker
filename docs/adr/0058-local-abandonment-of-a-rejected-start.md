# ADR-0058: Explicit local abandonment of a Start the server definitively rejected

- Status: accepted; implemented and verified locally
- Date: 2026-10-14
- Amends: ADR-0051 (a Start that is answered for good no longer has to be retried for ever), ADR-0055 decision 12 (the
  classifier now has a Start-specific member)
- Relates to: ADR-0052 (the discard of a refused *run*, which this cannot reuse: a rejected Start has no run)
- Scope: `apps/web` only. No API, SQL, schema, session, dependency or upload change.

## Context

A Start is queued in IndexedDB before it is sent. When the server answers it with a valid 403 `ORG_ACCESS_DENIED`
(the membership is gone) the request stays queued, which is right for an unknown outcome and wrong here: the page shows
"Request not confirmed", Start is disabled because an error is present, and a reload restores the same request. The
only action is "Retry same request", which gets the same answer. The existing escape, `discardRefusedRun`
(ADR-0052), needs an active run, and the discard of rejected points needs a finished one. A rejected Start has neither:
the queue holds one request, there is no run record, no points and no active pointer.

## Decision

1. **A narrow, answered rejection.** `definitiveStartRejectionOf(error)` accepts only a `RunnerApiError` with status
   403 and code `ORG_ACCESS_DENIED`. The client produces that code only from a readable error envelope; a 403 whose body
   is unreadable is reported as `HTTP_ERROR` and does not qualify. Not accepted: network failure, timeout, abort,
   unreadable body, 5xx, 408/425/429 (whatever code they carry), 401 (the session layer's), any other 403 code, and any
   other status. Every one of them keeps the exact queued request for a retry, as before.
2. **The answer is not stored.** The classification lives in the reducer as `RunnerFailure.rejection`, set by
   `request-failed` for a Start only, replaced by every later attempt and cleared by `request-started`. A request
   restored after a reload carries no answer, so the abandonment is not offered until a fresh retry has been answered
   definitively again. No schema change, and no stale metadata that could outlive a restored membership.
3. **One new local operation, `abandonQueuedStart(userId, request, lease)`.** In one `readwrite` transaction over
   `leases`, `profiles` and `requests` it checks the writer lease (owner, fencing token, expiry, release), requires the
   queued record to be a start with the same organization, run id and `startedAt`, requires that the profile points at
   no run, and deletes that one request. Points, run records, other users and other requests are not read for deletion.
4. **A stale call is an outcome, not damage.** `{ outcome: 'obsolete', reason }` with `writer-lost`, `not-queued`
   (acknowledged, already abandoned, replaced, a different `startedAt`) or `run-active`; no store is written. A lease of
   another user, or a command request, is a programming error and throws. A transaction failure rejects and leaves the
   request queued.
5. **Local only.** The operation never calls the server and never says anything about a server run. A Start that was
   accepted by the server after an earlier unknown outcome and then rejected on retry leaves that run on the server; it
   follows the same rule as ADR-0052 (the server's one-active-run rule applies to the next Start).
6. **The page.** `abandonRejectedStart` requires `rejectedStartMayBeAbandoned`, the writer lease, and no request in
   flight; while it runs `executeRequest` refuses to begin another, so the reducer is never asked to restore durable
   state under a request in flight. On `abandoned` it dispatches `start-abandoned { request }` (ignored for another
   request, a request in flight or a shown run), forgets the run organization, releases the writer lease and reloads
   organization discovery, so a lost membership shows "no organization" and a restored one is offered again. On
   `obsolete` it follows the durable state instead of acting on a stale screen: it reloads recovery and restores it,
   which may be a newer request. A thrown error is shown in the notice and leaves the Start saved and retryable.
7. **The UI.** The "Request not confirmed" notice gains "Abandon this Start" only when the rule above holds. It sits
   beside "Retry same request", is disabled for a tab that does not own the lease and while a request is in flight, and
   says that it only removes the saved Start request from this browser and does not create, finish or delete anything
   on the server. One explicit press: there is nothing unsent to lose, unlike the discard of a run.

## Consequences

- A lost membership no longer traps the browser in a Start that can never succeed: abandon, then Start follows the
  organizations the server lists now.
- After a reload the person presses "Retry same request" once before the abandonment appears. That costs one request
  and is what keeps the offer tied to a current answer.
- The identity of a retried Start is untouched by any of this; only an explicit abandonment removes it.

## Verification

Unit: reducer (`runner-state.spec.ts`: offered only for the definitive answer of this lifetime, never for a restored,
unknown, command or in-flight case, withdrawn by the retry, abandonment ignored for another request or a shown run);
classification and the retained request identity under each unknown outcome, with the real API client for a valid and
an unreadable 403 (`runner-requests.spec.ts`); the storage transaction on fake-indexeddb (`runner-storage.spec.ts`:
exact record only, neighbouring user and newer request untouched, stale/foreign/released/expired/taken-over writer,
acknowledged or replaced Start, active run, different `startedAt`, command, reload, injected failure then success);
and the notice markup (`RunnerView.spec.tsx`). Browser (`tests/e2e/rejected-start-recovery.spec.ts`, real API and
native IndexedDB): 403 before and after a reload, the identical retry request, abandonment, discovery refresh and a
new Start; unknown outcomes keeping the same path and body and never offering it.
