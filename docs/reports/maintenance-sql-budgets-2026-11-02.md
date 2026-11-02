# Maintenance SQL budgets: bounded closeout (2026-11-02)

Base: `9776af9`. The user requested one additional step and one local commit after the finished-run
freeze. ADR-0069 implements the first maintenance-progress safeguard from the architecture review.
The project pauses again after this slice.

## Delivered behavior

The API maintenance pool now supplies separate PostgreSQL connection startup settings:
`MAINTENANCE_DB_STATEMENT_TIMEOUT_MS` (60000 by default, 1..300000) and
`MAINTENANCE_DB_LOCK_TIMEOUT_MS` (5000 by default, 1..60000, no greater than statement).
They cancel SQL execution/lock waits on the server, before an indefinite query can keep a worker
occupied. Runtime budgets remain separate. Production Compose accepts operator overrides; the
example environment and deployment runbook describe bounds, restart and tuning.

Existing worker rollback ends the failed transaction and its transaction-scoped advisory claim.
PeriodicRunner waits for the operation to settle and can execute a later healthy cycle using its
existing failure metrics and cadence. There is no Promise.race or new client-side timeout wrapper.

No migration, database role grant, HTTP/UI/session behavior, dependency, retention or calculation
change. Local `.env` is untouched. The SDD's earlier blanket assertion about job timeouts is narrowed:
these are per-statement limits, not complete job, filesystem or idle-transaction deadlines.

## Verification

Windows, Node 24.11.1 / npm 11.6.2, existing local PostgreSQL/PostGIS. Read-only preflight verified
owner/runtime/maintenance URLs and live identities on `running_tracker_test` before fixture writes.
No bootstrap, migrations or development-database reset was performed.

| Check | Result |
|---|---|
| Focused configuration/pool unit tests | 30 passed in 2 files |
| Initial focused integration run | 22 passed / 1 failed: the new standalone `pool.query` test incorrectly expected the errored connection to be retained |
| Corrected focused integration run | 23 passed in 2 files; 15.3 s |
| Production Compose configuration rendering | Default 60000/5000 and operator override 15000/2500 both reach the API environment; no service started |
| `npm run verify` | Exit 0: lint, all workspace typechecks, 2,437 tests and production builds |
| `npm run test:integration` | Exit 0: 481 passed in 46 files, 0 skipped, 193.25 s |
| Whitespace, links and commit scope | Passed: 17 changed/new files, 33 relative file links; exact staged scope reviewed |

The 2,437 tests comprise scripts 83, API 1,333, web 860, contracts 144, fixtures 14 and simulator 3.
Production builds retain the existing Mapbox chunk-size warning and exit successfully.

Inspection of the installed `pg-pool` implementation confirmed that `pool.query` releases its failed
client with the error, which removes that connection. The corrected assertion checks replacement,
maintenance identity and recovered pool capacity. The production worker uses an explicit checkout,
rolls back and releases normally; its separate test proves same-connection recovery. No application
change was needed for that distinction, and the cancellation/elapsed-time assertions remain intact.

The real-role regression evidence covers:

- independent defaults on new/replacement maintenance connections;
- server cancellation of `pg_sleep`, bounded settlement and capacity for a healthy query;
- a scheduler error followed by a successful cycle, existing metrics and no overlapping operations;
- the production summary worker blocked by an owner-held organization row lock: SQLSTATE 55P03,
  no partial summary/archive revision, claim release proven by another maintenance connection, and
  successful later publication through the original rolled-back connection;
- the existing runtime timeout/HTTP cancellation regressions, preserved in the same database-budget suite.

Logs are ignored under `.local/maintenance-budget-{unit,integration-focused,integration-focused-final,verify,integration}.log`.
Full verification and database suites run sequentially. There is no browser suite/build overlap.

## Remaining boundary

These limits do not establish a whole-job deadline or cancellation of journal filesystem writes.
They also do not impose a client-side network round-trip deadline.
Repeatedly failing candidates still have no persisted attempts/backoff/fairness contract. They can
fail again at a later cadence, including legitimate work exceeding a budget; operator tuning needs
task-cost measurements on the target host. Durable sessions and physical-phone evidence remain deferred.

Browser suites and container/deployment verifiers were not run for this backend/configuration slice.
Compose evidence is configuration rendering only. Earlier browser/restore/hosting evidence retains
its original scope and date. This closeout did not run hosted CI, configure a provider, deploy or push.
