# ADR-0070: Bounded maintenance failure backoff

Date: 2026-11-05. Status: accepted.

## Context

ADR-0069 bounds individual SQL statements and lock waits. After a settled failure,
PeriodicRunner still retries at its ordinary interval, including the one-second
summary interval. An unavailable database or failing journal filesystem can thus
produce repeated work and logs at the normal polling frequency.

## Decision

Apply process-local exponential backoff independently to each PeriodicRunner,
including auto-finish. The initial and every successful cycle use the configured
interval. Each consecutive failure doubles a retry ceiling up to five minutes
(or the configured interval if longer). Equal jitter chooses between half that
ceiling and the ceiling, with the normal interval as a floor. Timers begin only
after the underlying operation settles. Idle/blocked/stale fulfilled results count
as success; this is exception backoff, not a progress detector.

A success resets the ceiling. Stop cancels the pending timer; stop/start retains
the failure state and never overlaps an unsettled operation. A new process starts
with normal polling. Validate intervals against Node's signed 32-bit timer limit.
Inject randomness for deterministic verification; no new environment setting is
needed for this single-process demo profile.

## Consequences

Retries continue indefinitely at a bounded frequency; a recovered dependency can
wait up to the selected delay plus actual cycle time before it is used again.
Each maintenance task has independent state, so another task retains its cadence.
Cycle success/error, duration and last-success metrics keep their existing meaning.
The follow-up observability slice exposes failure streak and scheduled retry delay.

This does not cancel a hung SQL transaction or filesystem operation, persist
attempts across restarts, quarantine a failing run, or make candidate selection
fair. Summary batches still wait for all workers; partial batch failure backs off
that task, including healthy summary candidates. Do not use this as evidence that
healthy summaries progress beside a poisonous candidate. SQL budgets remain in
force; whole-job/I/O deadlines, candidate fairness and durable sessions are deferred.

## Verification

Controlled-clock tests cover growth/cap/jitter, success reset, long intervals,
stop/start, unsettled work and timer overflow. Real-role integration verification
will cover actual SQL failures, independent-task progress and recovery. Results
belong in the final freeze report, not in an inferred production-readiness claim.
