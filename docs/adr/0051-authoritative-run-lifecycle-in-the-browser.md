# ADR-0051: Authoritative, monotonic run lifecycle in the browser

- Status: accepted; implemented and verified locally
- Date: 2026-10-07
- Amends: ADR-0048 decision 1 (the lifecycle merge rule), ADR-0047 (reload recovery now asks the server before capture)
- Amended by: ADR-0052 (a refused run with RUN_DELETED, RUN_NOT_FOUND or ORG_ACCESS_DENIED can be discarded locally, on purpose)

## Context

A technical review reproduced two ways for the browser to bring a finished run back to life.

1. **Ties at the same control revision.** Auto-finish (`app_private.auto_finish_runs`) changes `status`,
   `finished_at` and `data_revision` and does not touch `control_revision`, because it is not a control command.
   The snapshot merge let the incoming side win a tie (`incoming.controlRevision >= current.controlRevision`), so a
   PAUSE response that was still in flight when the run was auto-finished (control revision N, paused) replaced the
   known FINISHED snapshot (control revision N) in the reducer and in IndexedDB.
2. **Recovery trusted IndexedDB.** After a reload, a run stored as recording started capture at once. The server was
   asked about the run only when a command conflicted or an upload was refused for good; a finished run still
   accepts points inside its upload window, so nothing told the page.

## Decision

1. **The ordering model is the one the server already has; no new field.** `controlRevision` keeps its meaning: it
   counts control commands and is the compare-and-set token of the next command. Auto-finish is deliberately not
   one, and it is not made one (that would need a migration and would not repair snapshots already stored). The
   server's state machine decides the order: `finished` is absorbing (only `recording` and `paused` can become
   finished, nothing leaves it), and otherwise each command advances `controlRevision` by one.
2. **Merge rule** (`mergeRunSnapshot`, used by the reducer and by every IndexedDB write): a finished snapshot
   supersedes every non-finished one; between two non-finished snapshots the strictly higher `controlRevision`
   wins; equal revisions describe the same state and the current snapshot stays (so replays are idempotent). A
   known `finishedAt` is never replaced. `dataRevision` is still merged independently, as a maximum. This is not a
   status priority: `paused -> recording` stays valid, `finished -> anything` does not.
3. **A lifecycle read from IndexedDB, or recorded while offline, is recoverable data, not authority.** The runner
   state carries `authority`: `confirmed` (a server answer in this page lifetime), `restored`, `offline`,
   `confirming`, `unreachable`, `refused`. Capture runs only when the run is recording and the authority is
   `confirmed`, or `offline` (the existing offline behaviour: record locally, confirm on reconnection), or
   `confirming` a read begun from `offline` (so reconnecting does not interrupt a capture).
4. **Confirmation is one authoritative `GET` of the run** (`readAuthoritativeRun`), made when a restored run's page is
   online, when the browser comes back online (any offline period ends a confirmation), and on request. The answer is
   merged, stored by the writer tab only, and decides: finished stops capture for good, paused or recording follows
   the server. Each read has an attempt number; a late answer for a superseded read, another run or no read is
   dropped. The controls wait while the read is in flight.
5. **Failure is not a verdict.** No answer (network, timeout, 5xx, 408/425/429, local write failure) is
   `unreachable`: capture stays stopped, nothing is concluded or deleted, the read repeats every 5 seconds and on a
   button. An answer that the run cannot be read (other 4xx) is `refused`: capture does not resume and nothing is
   deleted. 401 is left to the session layer. While the browser itself is offline an unanswered read is the
   `offline` case.
6. **Nothing local is deleted by not resuming.** The run pointer, the buffered points and the queued requests stay;
   the existing upload, export and discard paths are unchanged.

## Consequences

- A server that is down when a tab reloads delays capture until it answers (offline, as reported by the browser,
  still records). A runner whose connection is reported online but does not work is held until the next successful
  read. This is the deliberate cost of never resuming from unconfirmed state; the buffered data is not at risk.
- If the server's data were rolled back to a state before a finish the browser already knows (a restore from
  backup), the browser keeps finished: finished is terminal by contract. That case needs the operator procedures of
  ADR-0044/0045, not a client rule.
- Focus and visibility do not trigger a read; only a restore, a reconnection or a request do.

## Verification

Unit: the merge table (including the exact tie), reducer sequences for the delayed PAUSE, the replayed response,
reinitialisation, idempotent FINISHED, every recovery and reconnection case, failure classification and storage
preservation with real IndexedDB (fake-indexeddb), and a capture controller stopped during its own start. Browser
(`tests/e2e/lifecycle-authority.spec.ts`, real API, database and the real `auto_finish_runs`): the delayed PAUSE
across an auto-finish, a reload after an auto-finish with the answer held, a reload of a live run with the answer
held, a failing server, and reconnection with an active and with a finished run. With the old merge restored, the
browser race test fails.
