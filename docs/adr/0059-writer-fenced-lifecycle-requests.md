# ADR-0059: Lifecycle requests are fenced by the writer capability they began with

- Status: accepted; implemented and verified locally
- Date: 2026-10-21
- Amends: ADR-0055 (closes its remaining gap: `queueRequest` and the three acknowledgements checked ownership just
  before, not inside, their transactions)
- Relates to: ADR-0053 (the monotonic fencing epoch), ADR-0058 (rejected-Start abandonment, unchanged)
- Scope: `apps/web` only. No API, SQL, schema, migration, dependency or server lease.

## Context

`executeRunnerRequest` queued the request, sent the mutation and only then asked a boolean `assertOwned()`. A tab that
had already lost the lease still sent the Pause, Resume, Finish or Start. The acknowledgements (`acknowledgeStart`,
`acknowledgeCommand`, `acknowledgeReconciledRequest`) and `queueRequest` wrote without checking the lease in their
transaction, and every one of them moved the active-run pointer. A tab that passed its external check, lost the lease
before its acknowledgement transaction opened, and then wrote late could undo a newer owner: B acknowledged the same
idempotent Pause and moved to another run, and A's late acknowledgement pointed the profile back at the old run. A
boolean cannot tell "still the owner" from "the owner again under a newer epoch".

## Decision

1. **The capability.** A lifecycle request carries the `WriterLease` it began with (user, owner, fencing token; the
   expiry is not part of it) and the session's `AbortSignal`.
2. **Fenced writes.** `queueRequest`, `acknowledgeStart`, `acknowledgeCommand` and `acknowledgeReconciledRequest` take
   that lease and run one `readwrite` transaction over `leases`, `profiles`, `requests` and `runs`. Before any write it
   checks, in order: the lease is the live epoch (owner, token, unexpired, unreleased); the queue holds exactly this
   request (same identity and payload); the active run is the one the request applies to. Otherwise the result is
   `{ outcome: 'obsolete', reason: 'writer-lost' | 'superseded' | 'not-active' }` and nothing is written.
3. **Initial Start.** A Start is queued only while no run is active, and acknowledged only while no run is active (or
   this run already is). Its acknowledgement is the one lifecycle write that moves the pointer. Queueing and command
   acknowledgements merge into the active run's record and never move it. Control and data revisions keep merging
   independently (`mergeRunSnapshot`).
4. **Dispatch.** Right before the mutation is sent, the coordinator renews the lease and the result must be the same
   epoch, with the session still live. Otherwise nothing is sent. This is not atomic with the server's execution: a
   mutation already sent when another tab takes over relies on the server's revisions and idempotency, and its answer
   is acknowledged only if rule 2 still holds.
5. **Completion.** `performRunnerRequest` reports success, failure or reconciliation only while the page still has the
   same session and operation, and still holds the same epoch, asked after the durable write finished. A replaced or
   suspended session gets nothing (the page releases the request when the session is suspended). A changed epoch or an
   obsolete write gets `request-obsolete`: the pending marker is released and the page follows the durable state it
   reads back. No success, failure, refusal or reconciliation effect is dispatched.
6. **Kept.** The current writer queues without a network. Unknown outcomes keep the exact `runId`, `startedAt`,
   `commandId` and payload for a later owner's idempotent retry. Losing the lease deletes no buffered point, queued
   request or rejection marker. Rejected-Start abandonment and refused-run discard are unchanged.

## Consequences

- A stale tab can no longer send a mutation after it knows it lost the lease, and its late answers write nothing.
- A late answer of an old epoch can leave the server ahead of this browser (the Pause was committed). The new epoch's
  authority read or retry learns it; this is the existing ADR-0055 model.
- `activateRunSnapshot` (tests and seeding only) and `clearActiveRun` (clearing a finished run) remain unfenced; they are
  not lifecycle requests and were out of scope.

## Verification

`runner-request-fencing.spec.ts`: two storage instances on one `IDBFactory`, an injected clock, deferred promises. It
covers Start, commands and reconciliation; ownership lost before dispatch; takeover between the check and the write;
B acknowledging and moving on before A's late completion; same owner under a newer token; superseded and inactive
requests; session abort; offline queueing, reload and the next owner's retry; and completions that must not reach a
replaced page. `runner-state.spec.ts` covers `request-obsolete`. Browser: `tests/e2e/lifecycle-takeover.spec.ts`
(Chromium, real IndexedDB, real API) holds a committed Pause answer across a takeover and a same-owner reacquisition.
Results are in `docs/progress.md`.
