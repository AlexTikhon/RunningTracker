# ADR-0023: Live-stream authorization revalidation

- Status: accepted; P08.2 implemented and locally verified
- Date: 2026-09-27
- Scope: P08.2 and the stream portion of D07

## Context

P08.1 opens one bounded SSE stream per organization/tab and shares database
polls across connections for the same user and organization. Authentication at
the initial HTTP request is insufficient for a long-lived response: the local
session can expire or be revoked, membership can become inactive, and individual
live grants can change while data is waiting behind transport backpressure.

The server cannot retract bytes already accepted by the HTTP transport. It can,
however, define an auditable authorization checkpoint and ensure that a change
observed there invalidates every application-owned pending value.

## Decision

1. Every connection retains the authenticated session's digest, expiry, and user
   identity. The raw cookie token is not copied into the live hub. Database reads
   remain grouped by user and organization, but session validation is performed
   independently for every connection so revoking one browser session does not
   terminate another session for the same user.
2. The hub validates the session store record before and after the initial
   database read, before shared poll work, before publish, before flushing a
   blocked pending state, and before heartbeat writes. A connection-local timer
   closes the stream at its recorded expiry even when no other work is due.
3. Every successful poll performs the active-membership check and RLS-filtered
   live-state query in one short runtime-role transaction. An authorization
   denial closes all streams for that user/organization subscription and clears
   their pending states. Infrastructure failures are logged and retried on the
   later polling cycle; they are not misclassified as revocation.
4. Run grants are represented by the complete state returned under RLS. When a
   grant disappears, the next state omits that run. If the connection is blocked,
   this newest filtered state replaces the older pending state; a later drain
   cannot flush the superseded value.
5. The authorization checkpoint is the PostgreSQL snapshot used by the
   live-state statement inside the latest completed poll transaction. A
   revocation committed after that snapshot is observed by the next poll. Data
   already written to Node's transport buffer or delivered to the client cannot
   be recalled. Clients remove both current and last-known run data when a run
   disappears from a complete state.
6. Disconnect is the only terminal signal for session or membership loss. The
   client follows the existing SSE contract: call `GET /api/session`, reconnect
   only for a valid session, and rebuild from the next authoritative initial
   state. No authorization details are sent in a terminal SSE event.

## Consequences

- Session revocation is isolated to the exact stored session while database poll
  sharing remains efficient across tabs and sessions for one identity.
- Membership and grant changes are bounded by the two-second polling interval
  plus one short database transaction. This is explicit eventual revocation,
  not an impossible promise to revoke already delivered data.
- Application-owned queued state is constant-size and authorization-safe after
  the latest completed check. Node's already-accepted writable buffer remains a
  transport boundary and is closed by the existing backpressure deadline.
- P08 resolves the stream half of D07. P09 must apply the same checkpoint model
  to cache lookup, fill, and invalidation before D07 is fully resolved.

## Verification

- Unit tests cover revocation isolation for two sessions of one user,
  revocation during the initial database read, exact expiry closure,
  membership-denial cancellation, and grant-filtered replacement of a blocked
  pending state.
- Session tests cover active, identity-mismatched, revoked, and expired stored
  records.
- Real runtime-role/PostGIS integration changes live grants and membership after
  connection, verifies the filtered full state, then verifies disconnect with no
  additional frame.
- The complete repository verification and 18-file/177-test integration suite
  pass without migrations, privilege changes, dependencies, or schema changes.
