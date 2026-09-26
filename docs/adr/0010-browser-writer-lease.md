# ADR-0010: Browser single-writer lease and fencing boundary

- Status: accepted; P05.4 implemented and locally verified
- Date: 2026-09-26
- Scope: P05.4 only

## Context

IndexedDB serializes point sequence allocation, but that does not designate one
tab as the recording writer. Without an ownership boundary, two tabs can issue
lifecycle requests and run upload workers independently. A UI-only warning is
not sufficient because both tabs can observe stale state and act concurrently.

The runner must also continue to work offline. Therefore a globally exclusive
cross-device lease cannot be guaranteed: an offline device cannot renew or
observe a server-side lease without giving up offline capture availability.

## Decision

1. IndexedDB schema version 2 adds one user-scoped `leases` record. Active runs
   are already unique per user at the server, so the lease uses the same scope
   rather than a user/organization/run key that could allow two creation races.
2. Each tab creates an in-memory UUID owner identity. Acquisition is one atomic
   IndexedDB read-write transaction: a live lease owned by another tab is a
   conflict; a missing, expired, or same-owner lease can be written.
3. A new owner increments a decimal bigint fencing token. Renewal requires the
   same user, owner, token, and a lease that has not expired. Release requires
   the same owner and token, so a stale tab cannot renew or delete a successor's
   lease.
4. The production timing policy is a 15-second lease renewed every 5 seconds.
   A restored run or request claims automatically. An idle tab claims lazily
   immediately before start, then reloads durable state so it cannot create a
   second run after taking over from a crashed tab.
5. Lifecycle dispatch and point upload require confirmed ownership. The worker
   is not created in a non-owner tab, and every network dispatch renews the
   lease first. Server responses are durably acknowledged only after another
   ownership check; otherwise the exact request remains queued for its new
   owner to retry idempotently.
6. A conflicting or fenced-out tab is explicitly read-only and can retry
   ownership after the displayed expiry. Graceful clear/unmount releases the
   lease; crash/reload recovery relies on bounded expiry and a new fencing token.
7. This is a same-origin browser-tab lease, not a distributed device lock.
   Cross-device split-brain is detected rather than hidden by the existing
   server boundaries: one active run per user, command control revisions,
   canonical `(run, seq)` point identity, and point conflict responses. A true
   cross-device exclusive lease would require online coordination and would
   conflict with the stated offline recording requirement.

## Consequences

- At most one cooperating tab owns controls and upload work for an authenticated
  user. Atomic IndexedDB acquisition, not render state, decides ownership.
- A throttled or suspended tab can lose its expired lease. It fails closed on
  the next renewal/assertion while a successor uses a higher fencing token.
- The lease does not make an in-flight HTTP request transactional with browser
  ownership. Existing request IDs, control revisions, and idempotent point
  ingestion remain the authoritative server reconciliation mechanisms.
- P05.5 must require the current lease before accepting source measurements;
  this ADR does not add Geolocation, simulator adapters, or background capture.

## Verification

- Two storage instances sharing one fake IndexedDB race for the lease and only
  one wins.
- Upgrading a populated P05.3 version-1 database creates the lease store while
  preserving the active durable run snapshot.
- Expiry/takeover increments the fencing token; the stale owner cannot renew or
  release the successor's record.
- Coordinator coverage verifies renewal and fail-closed ownership loss.
- Existing runner tests verify the extra writer state channel, while all P05.1
  through P05.3 web tests remain green.
