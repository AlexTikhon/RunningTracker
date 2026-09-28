# ADR-0032: Bounded archive tile generation admission

- Status: accepted; P09.6 implemented and locally verified
- Date: 2026-09-28
- Scope: P09.6 only

## Context

P09.3 single-flight originally ran inside the P09.4 tenant transaction. Adding a
semaphore around the PostGIS call there would make up to sixteen queued requests
retain PostgreSQL clients and organization share locks. That is larger than the
default ten-connection runtime pool and could exclude ingestion and ordinary API
work while weakening the intended organization-lock ordering.

The limiter must also coexist with per-user cache keys, cache-hit authorization,
atomic archive-revision changes, request disconnects, and a PostgreSQL-side SQL
deadline. Returning a partial feature set is not an acceptable overload policy.

## Decision

1. A tile request first opens a short authenticated tenant transaction, takes the
   P09.4 organization share lock, validates active membership/current revision,
   and probes the cache. A hit returns under that transaction's ordering point.
2. A miss leaves that transaction before entering the process-local generation
   scheduler. The scheduler admits at most two active candidates and sixteen
   waiters. Request nineteen fails immediately with `503 TILE_BUSY`; queued work
   holds neither a pool client nor an organization lock.
3. Single-flight remains outside admission and is keyed by the complete P09.3
   authenticated key. Same-key waiters therefore consume one queue/admission
   position and at most one SQL generation. Disconnected waiters detach; shared
   work is cancelled only when no waiter remains, so one disconnect cannot fail
   another authorized request.
4. After admission, the leader opens a fresh authenticated tenant transaction,
   reacquires the organization share lock, revalidates membership/revision, and
   probes the cache again. This handles a tile populated during the wait without
   SQL and preserves the P09.4 fail-closed ordering for revoke/revision races.
5. Before the MVT statement, the transaction sets `SET LOCAL statement_timeout =
   '2000ms'`. Only PostgreSQL cancellation code `57014` whose message identifies
   `statement timeout` maps to `503 TILE_TIMEOUT`; unrelated database errors keep
   their existing path. The transaction helper rolls the failed transaction back
   before releasing the client.
6. The complete raw `Buffer` is accepted when its size is at most 1 MiB. A larger
   result returns `422 TILE_TOO_COMPLEX` before cache insertion. SQL has no feature
   `LIMIT`, and no output is truncated.
7. The 2/16/2-second/1-MiB values are SDD constants, not environment knobs. The
   existing default runtime pool of ten leaves capacity beyond the two active tile
   transactions. P11 will add formal queue/time/size metrics rather than P09.6
   introducing a parallel observability subsystem.

## Consequences

- Cache hits still pay one short authorization/revision transaction, while misses
  pay a second transaction only after admission.
- Independent cache misses may use at most two runtime clients. The bounded queue
  is process-local, matching the existing process-local LRU and single-backend MVP.
- A disconnected active SQL statement is not client-cancelled mid-query, but its
  PostgreSQL deadline bounds occupancy and the permit is released in `finally`.
- A tile that cannot meet the time or complete-size bound fails explicitly and is
  eligible for a later full retry; it never poisons the cache.

## Verification

- Deterministic unit tests use deferred barriers to prove two active generators,
  sixteen waiters, request-nineteen rejection, exact permit release, queued
  cancellation, no pool client held while queued, unrelated transaction capacity,
  same-key single-flight, and no permit leak after failure.
- Boundary tests cover empty, normal, exactly 1 MiB, and 1 MiB plus one byte output;
  oversized retries execute generation again.
- Real PostgreSQL integration runs a deliberate `pg_sleep(10)` under the local
  timeout, observes `503 TILE_TIMEOUT` around two seconds, then proves the pool and
  transaction connection are reusable. Existing archive authorization, cache-race,
  PostGIS geometry, antimeridian, polar, string-ID, and response-header tests remain
  green.
