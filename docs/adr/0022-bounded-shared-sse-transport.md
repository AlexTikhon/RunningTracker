# ADR-0022: Bounded shared SSE transport

- Status: accepted; P08.1 implemented and locally verified
- Date: 2026-09-27
- Scope: P08.1 only

## Context

P07 provides durable revision-based track recovery over ordinary HTTP. The live
channel therefore needs to announce compact current state and revisions, not act
as a durable event log. A stream per run would multiply connections, while a
poll loop per response would duplicate database work and make memory growth under
slow readers difficult to bound.

## Decision

1. One authenticated `GET /api/orgs/:orgId/live` stream represents one tab and
   organization. It requires an explicit `Accept: text/event-stream`; tokens are
   never accepted in the URL. The initial tenant/RLS-protected state is read
   before stream headers are sent.
2. The live-state query returns authorized active runs and their revisions. It
   reads at most the two greatest sequences per run and reuses the versioned
   PostGIS edge evaluator. An accepted edge is `confirmed`; an isolated point or
   sequence/segment discontinuity is `unconfirmed`; unusable latest accuracy,
   time, or speed produces `position=null`.
3. A process-level hub owns one non-overlapping two-second schedule. Subscriptions
   are grouped by user and organization, so matching tabs share a database read.
   Poll reads use bounded concurrency and short tenant transactions; no pool
   client or transaction survives for the SSE response lifetime.
4. Each connection receives a fresh UUID `streamId` and its own safe-integer
   sequence starting at zero. The complete current state is emitted immediately
   and after every successful poll. Fifteen-second comment heartbeats do not
   consume application sequence values.
5. A false `response.write` result marks the connection blocked. The hub keeps
   only the latest subsequent state in application memory, replacing older
   pending values. Drain sends that value; a blocked-writer deadline closes the
   stream. Opening streams count toward a configurable global connection limit.
6. Shutdown stops scheduling and ends all streams before runtime pool closure.
   P08.2 retains responsibility for session expiry/revocation rechecks, explicit
   authorization cancellation of pending data, and resolution of D07.

## Consequences

- A missed process notification or backend restart cannot lose durable points:
  the next poll/reconnect state carries the database revision used by P07 HTTP
  recovery.
- Grouping by identity and organization preserves runtime-role RLS semantics but
  cannot combine different viewers into one privileged query. Poll concurrency
  prevents the live channel from consuming the entire runtime pool.
- The transport has a constant one-state application queue per blocked stream;
  Node's already-accepted writable buffer remains outside that queue and is
  bounded in time by forced disconnect.
- The hub is process-local. A multi-replica deployment may perform the same poll
  in each replica; correctness still comes from PostgreSQL, not cross-node events.

## Verification

- Unit coverage proves immediate sequence zero, exact SSE headers, grouped reads,
  per-connection ordering, one-state replacement, blocked-writer closure,
  connection caps, authentication, and the explicit Accept requirement.
- Real runtime-role/PostGIS integration proves active-run ACL selection,
  confirmed/null position quality, observation of a later committed revision in
  a fresh snapshot, empty visible state, and an actual immediate HTTP SSE frame.
- API lint, strict typechecking, the complete API unit suite, and repository diff
  checks pass without migrations, privileges, dependencies, or schema changes.
