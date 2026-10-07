# ADR-0050: Server-side SQL execution and lock-wait budgets for the runtime pool

- Status: accepted; implemented and verified locally
- Date: 2026-10-07
- Amends: ADR-0032 (the 2 s tile render limit stays, but it is no longer the only SQL bound)

## Context

The technical review of 2026-10-07 (finding R1) measured a real runtime connection with `statement_timeout = 0` and
`lock_timeout = 0`. Pool acquisition was bounded, ordinary SQL was not: a membership query, a run lock, the identity
lookup or the archive authorization lock (`FOR SHARE` / `FOR UPDATE` on the organization row, taken before the
render's own 2 s limit) could wait indefinitely. A browser or proxy timeout stops the HTTP wait, not the database
work, so retries piled up behind the same lock and held the small runtime pool.

## Decision

1. **PostgreSQL enforces the budgets.** `createDatabasePool` passes `statement_timeout`
   (`DB_STATEMENT_TIMEOUT_MS`, default 5000) and `lock_timeout` (`DB_LOCK_TIMEOUT_MS`, default 2000) as connection
   startup parameters. Both are 1..60000, and the lock budget may not exceed the statement budget because
   `statement_timeout` also counts lock waiting, so a larger lock budget could never fire.
2. **Why startup parameters rather than `SET LOCAL` in the transaction helper.** They are in force before the first
   statement of every checkout, including the paths that do not use a transaction helper (identity resolver,
   health probe, `pool.query`) and the first lock of an authorization probe, with no extra round trip and nothing a
   future caller can forget. Nothing in this codebase issues a session-level `SET`, so the values cannot drift
   between borrowers; a transaction may tighten them with `SET LOCAL` (the tile render does, to 2 s) and
   PostgreSQL restores the pool values when it ends. The real-database tests prove both the revert after COMMIT
   and after a timed-out ROLLBACK, and that the next borrower of the same backend sees the configured values.
3. **Not set: `idle_in_transaction_session_timeout`.** It would bound a callback that stalls while holding locks, but
   when the server ends a checked-out connection `pg` emits an unhandled client `error`, which was observed to
   terminate the Node process. Enabling it needs an error listener on every checked-out client; that is separate work.
   Application callbacks hold a transaction only across database calls and, in the tile path, an in-process cache read.
4. **Two stable wire errors, both 503.** PostgreSQL `57014` with a statement-timeout message maps to
   `503 DB_STATEMENT_TIMEOUT` and `55P03` to `503 DB_LOCK_TIMEOUT`, in the central error handler, with fixed messages
   (no SQL, table or SQLSTATE reaches the client). 503, not 409/504, because the condition is transient server-side
   capacity or contention, the same semantics as `TILE_BUSY` / `TILE_TIMEOUT`, and the client runner already retries
   5xx and treats 4xx as final. A user cancel (`57014` without a timeout message) and every other database error
   stay `500 INTERNAL_ERROR`. A wrapped error (for example `TenantTransactionCommitError`, outcome unknown) is not
   classified. `TILE_TIMEOUT` is unchanged for the render statement.
5. **Rollback and release are unchanged and now tested.** `runScopedTransaction` already issues `ROLLBACK` before
   `release`, and destroys the client only when the rollback itself fails. A timed-out statement leaves the
   transaction aborted, the rollback succeeds, and the same backend is reused.
6. **Observability.** The existing `http.request.failed` line carries `errorCode` (`DB_LOCK_TIMEOUT` /
   `DB_STATEMENT_TIMEOUT`), `reason` (`lock` / `statement`), `timeoutMs` (the configured budget), `requestId`
   and `route`; nothing from the SQL text.

## Consequences

- Each limit is per statement. A request that issues many fast statements can still run longer than the statement
  budget in total; the browser/proxy deadline and the pool bound still apply to the whole request.
- Under contention a request that used to wait now fails after at most `DB_LOCK_TIMEOUT_MS` per lock and is safe to
  retry (transactions roll back; idempotency and revision fencing are unchanged).
- A client that disconnects no longer leaves an unbounded statement behind: the server-side budget frees the
  connection (tested with an abandoned tile request while the organization row stays locked).
- Maintenance and operator pools are deliberately unbounded here: they run heavier PostGIS and batch statements and
  need their own budgets, which should be set from measurement (follow-up).
- `DB_QUERY_TIMEOUT_MS` still only bounds the readiness probe.
