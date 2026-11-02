# ADR-0069: Independent server-side SQL budgets for maintenance

- Status: accepted; implemented, verification in `docs/progress.md`
- Date: 2026-11-02
- Scope: the API process's maintenance pool, configuration, production profile and regression evidence

## Context

The runtime pool already supplies PostgreSQL statement/lock deadlines as connection startup parameters.
The maintenance pool has connection-acquisition bounds but no SQL deadlines. A statement or lock wait
can therefore prevent a worker from settling, retain its connection/transaction/claim and stop that
PeriodicRunner from scheduling another cycle. The November 2 review identified this separately from
durable sessions, job fairness and filesystem deadlines.

## Decision

Give `createMaintenanceDatabasePool` independent startup parameters:

| Setting | Default | Allowed range |
|---|---|---|
| `MAINTENANCE_DB_STATEMENT_TIMEOUT_MS` | 60,000 ms | Integer 1..300,000 ms |
| `MAINTENANCE_DB_LOCK_TIMEOUT_MS` | 5,000 ms | Integer 1..60,000 ms, no greater than the statement budget |

They map to PostgreSQL `statement_timeout` and `lock_timeout` before the first statement of each
connection, including replacement connections. Runtime budgets stay independent. Production Compose
passes both settings through from its operator environment with the same defaults. Other API entry
paths use the configuration defaults or explicit process environment. Restart the API to apply changes.

PostgreSQL cancels the statement, including its lock wait, rather than a JavaScript timer merely
abandoning the promise. Existing workers await failure and their rollback before releasing their
client; a transaction-scoped advisory claim ends with rollback. A failed cycle uses existing error
metrics/logging and is scheduled again at its existing cadence. There is no new retry loop or early
release of a worker slot. `pool.query` discards its failed client; explicit worker transactions can
roll back and reuse theirs. Both paths must leave capacity for subsequent healthy work.

## Trade-offs and limits

The maintenance defaults are longer than runtime deadlines because calculation and purge have different
costs. They are initial safety limits, not measured production service objectives. A legitimately slow
statement now fails and can be attempted again on a later cycle; tune against task timings and failure
metrics on the target host. Raising the limit also lengthens possible pool/lock occupancy.

This is a per-statement pool safeguard, not a per-task cost model or a whole-transaction/job deadline.
The timer resets for each statement and does not bound journal filesystem writes or idle transactions.
It also supplies no client-side network round-trip deadline.
Do not use `idle_in_transaction_session_timeout` as a substitute: it terminates the connection rather
than cancelling the active statement. Persisted attempts, backoff, poison-candidate fairness, task-specific
limits and filesystem cancellation remain deferred. This change does not make unattended operation ready.
Operator backup/load/restore tools that construct their own connections are outside this pool boundary.

No schema/migration, role grant, HTTP contract, session lifetime, retention or metric algorithm changes.

## Verification

Configuration and pool unit tests cover separate settings, defaults, validation and startup parameters.
Real-role PostgreSQL tests cover default settings on replacement connections, statement cancellation,
pool recovery and PeriodicRunner error-to-success progression without overlap. A production summary
worker blocked by an owner-held organization lock must time out, leave no partial summary/archive
publication, release its advisory claim for another maintenance connection, and subsequently publish
using its original rolled-back connection. The full integration suite remains the broader regression gate.
