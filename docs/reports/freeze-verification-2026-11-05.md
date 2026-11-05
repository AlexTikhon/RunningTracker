# Four-commit freeze verification

Date: 2026-11-05. Local Windows workstation, Node 24.11.1 / npm 11.6.2,
PostgreSQL/PostGIS in the existing healthy Docker Compose container.

## Scope and provenance

Clean base: `1c97264fa096013ee6adb7108da712dec666d67b`, `main`, initially equal to
the local `origin/main` reference. This task requested exactly four local commits
and a project freeze. No push, remote refresh or deployment was performed.

| Commit | Scope |
|---|---|
| `442c120` | Bounded per-task maintenance failure backoff; controlled-clock regressions; ADR-0070 and accepted scope |
| `e36f6cd` | Failure-streak/pending-delay metrics, recovery logs, observer containment and operator runbook |
| `eecacb7` | Real-role SQL failure/recovery and journal rollback/acknowledgement scenarios |
| Fourth commit, containing this report | Architecture review, current verification and reconciled pause/restart documentation |

Only three runtime files changed: PeriodicRunner, metric definitions and the
logger's allowed retry-delay field. Auto-finish and the six other maintenance
tasks inherit the shared scheduler policy. No migrations, role grants, HTTP
contracts, product screens, dependencies, lockfiles or private configuration edits
are part of this task.

`npm run verify` checked all runtime/unit changes at `e36f6cd`. The subsequent
integration-only test file received its own ESLint and API typecheck, then the
database suite. No runtime or unit code changed after the full verification;
the final commit only changes documentation. Browser runs start after all
contract/fixture builds finish, with no source mutation during a run.

## Executed checks

| Check | Result |
|---|---|
| First scheduler-focused API test run | 25 passed in 2 files |
| Retry/observability/logger/metrics/startup selection | 41 passed in 5 files |
| API lint/typecheck after the first slice | Exit 0 |
| `npm run verify` | Exit 0: repository lint, all workspace typechecks, 2,455 tests and production builds |
| ESLint on the new integration file, then API typecheck | Exit 0 |
| Focused `maintenance-retry.integration.test.ts` | 2 passed in 1 file, 1.96 s |
| `npm run test:integration` | Exit 0: 483 passed in 47 files, 0 skipped, 197.78 s |
| Initial Chromium demo smoke immediately after integration | Exit 1: 23 passed, 1 publication-wait timeout (4.7 min); residual integration summary backlog |
| `npm run test:e2e:smoke` after the backlog drained | Exit 0: 24 passed, retries 0, 3.4 min |
| `npx playwright test finish-result.spec.ts run-details.spec.ts --project=chromium` (from `tests/e2e`) | Exit 0: 13 passed, retries 0, 1.7 min |
| `npm run test:e2e:smoke:firefox` | Exit 0: 24 passed, retries 0, 3.4 min |
| `npm run demo:doctor` | Exit 0; existing container healthy, API/web ports free, no configured basemap token |
| Changed-document relative file links | 127 checked across 10 documents; 0 missing (anchor targets not validated) |
| `git diff --check` | Exit 0 |

The 2,455-test total is 83 script/migration tests, 1,351 API unit tests, 860 web,
144 contracts, 14 fixtures and 3 simulator tests. Integration and browser counts
are separate. The production build retains the existing Mapbox chunk-size warning.

The installed Mapbox runtime scenario passed against a local style, but its Vite
console output included a nonempty-map-container warning and two unhandled
`TypeError: this.errorCb is not a function` rejections from `mapbox-gl`.
The suite's passing assertions do not establish a clean browser console or actual
provider-basemap behavior. This remains a map-runtime investigation for resumption;
no map code or dependencies were changed in this maintenance closeout.

The first smoke failure was in archive-sharing's 120-second wait for a newly
finished run to become searchable. The API reported no maintenance-cycle error;
read-only inspection found integration fixture runs competing for the ordinary
two-worker, 60-second publication cycles, including older `fixture-v1` summaries
awaiting replacement. After those cycles completed, the candidate count was zero
and a direct production batch returned two idle workers. The complete smoke was
then rerun without application changes or a longer assertion timeout. Preserve
the failed attempt as evidence of local suite-state coupling, not an all-first-pass
claim. Hosted integration/browser jobs have separate database services.

## Failure/recovery evidence

Controlled-clock unit tests prove delay growth/cap/jitter, long-interval floor,
success reset, timer validation, stop/start, non-overlap while unsettled,
pending-delay metric semantics, sanitized default logging, a single recovery log
and containment of a throwing error observer.

The new real-database scenarios use controlled scheduler time and actual
role-separated PostgreSQL queries/transactions:

- Two `pg_sleep` statements are cancelled by the server-side maintenance statement
  budget. Retry delays grow from two to four seconds for a one-second test
  interval. A separate task using the same pool progresses during that backoff;
  recovery clears the streak and resumes normal cadence without overlap or a
  stranded checkout.
- The production deletion-journal exporter holds its batch while an injected sink
  promise is unsettled. Advancing scheduler time never launches another attempt.
  Rejected writes roll back and retain the row. A later successful sink result
  permits acknowledgement/commit; retry metrics reset and the row leaves the
  outbox. Sink behavior is injected: this is not a physical filesystem-failure or
  crash-durability experiment.

Before fixture writes, read-only probes verified the actual owner/runtime/
maintenance logins and `running_tracker_test`; the new suite repeats that proof.
Tracked `.env.example` test settings were supplied only to child processes or the
calling PowerShell process. No bootstrap, migration, development-data reset or
private `.env` edit was performed. Integration and browser suites run sequentially
because they share the disposable test database.

Raw command logs are gitignored under `.local/freeze-2026-11-05-*.log`, including
the failed initial smoke and the complete rerun. No test result directory or raw
trace is included in the commits.

## Limits and restart

Backoff is per task and process-local, with no attempt limit. A fulfilled
idle/blocked/stale result resets it. It does not establish fair summary candidate
selection, persisted attempts, quarantine or a whole-job/I/O deadline. A stopped
runner keeps its failure streak but has no pending-delay metric; a process
restart clears both. Restart alone is not evidence of recovery.

No current hosted CI, Safari/mobile/physical-phone GPS, actual provider OIDC or
basemap, production hosting, off-host storage durability or production recovery
claim follows from these checks. No live AI-provider evaluation was run. See the
[architecture review](architecture-review-2026-11-05.md) for remaining priorities
and the [pause handoff](../pause-handoff.md) for restart and verification steps.

The fourth commit closes the freeze and contains documentation only. The delivery
checkpoint is `git status --short` empty, `git rev-list --count 1c97264..HEAD`
equal to 4, and `git rev-list --left-right --count origin/main...HEAD` equal to
`0 4` against the unchanged local remote-tracking reference. Verify those after
creating this commit; its own hash is available from Git rather than embedded in
its content. Work stops at this freeze; deferred items are not started.
