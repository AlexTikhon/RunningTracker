# Pause handoff (updated 2026-11-05)

The project is paused as a locally verified demo/portfolio application after the
user-requested four-commit maintenance closeout. The accepted architecture remains
React + Express + PostgreSQL/PostGIS. No further product work is required for this
freeze. Start with the [current verification report](reports/freeze-verification-2026-11-05.md)
and [architecture review](reports/architecture-review-2026-11-05.md).

## Latest closeout

Starting point: `1c97264` (maintenance SQL budgets, ADR-0069), with a clean worktree.
ADR-0070 extends that safeguard with independent, jittered failure backoff for each
maintenance task. A failed cycle doubles its retry ceiling to five minutes (or the
normal interval if longer); a fulfilled cycle resets normal polling. It never
releases an unsettled worker. Failure streak and pending retry delay are exported
as metrics, and recovery is logged once. The deployment runbook explains their
meaning and operator response.

Delivery is exactly four local commits: retry scheduling; retry/recovery
observability; real-role failure/recovery scenarios; final review, verification
and this handoff. The final report records the hashes of the first three; the
fourth contains that report. No push or deployment belongs to this closeout.

This does not supply per-run fairness/quarantine, persisted retry attempts, durable
sessions or a complete job/filesystem deadline. A failing summary batch can still
delay healthy candidates in that task. An idle/blocked fulfilled cycle is a
scheduler success, not proof that a backlog advanced.

## Product state retained

Finished-run review includes the revision-aware published archive track
(ADR-0066), owner details from My runs (ADR-0067), and the explicit
**Finish -> View result -> Back to Runner -> New run** flow (ADR-0068).

App retains capture/uploader/lifecycle/IndexedDB/writer ownership across result
navigation. Pending or rejected device uploads and obsolete server revisions hide
route/statistics until synchronization settles. Restored finished runs need fresh
server confirmation. Publication may still be pending or stale; use Refresh run.
There are no URL deep links or automatic result polling.

## Returning to the project

1. Read `git status --short --branch` and `git log --oneline -6`. The freeze adds
   exactly four commits after `1c97264`; compare their actual manifests with the
   report before relying on recorded evidence. A later commit requires its own
   verification. Local remote-tracking refs may be stale.
2. Start Docker Desktop. Node 24/npm 11 are required. Run `npm ci` only if needed
   after checking the lockfile. Browser installation, when needed:
   `cd tests/e2e; npx playwright install chromium firefox; cd ../..`.
3. Run `npm run demo:doctor`. It is read-only. Then `npm run demo:up` starts the
   local API/web stack; Ctrl+C stops those processes and keeps PostgreSQL data.
4. Open the URL in two **separate browser profiles/contexts** for runner and
   coach. Follow [the demo rehearsal](runbooks/demo.md). Two tabs in one profile
   share one person's session. Without a map token the statistics remain usable.
5. Before editing, select one bounded task from the architecture review. The
   original P00-P12 plan has no unfinished implementation stage; D10 remains
   partial until physical-device evidence exists.

## Verification on return

Run integration and browser commands sequentially: both mutate the dedicated test
database. Do not rebuild contracts/fixtures or edit source while browser tests run;
Vite HMR can reload the page and invalidate a scenario.

Sequential execution alone does not remove integration fixture backlogs. This
closeout's first Chromium smoke timed out waiting for a new summary while older
integration summaries consumed the default 60-second cycles. Before a browser
publication scenario, use an isolated clean test target or confirm that
`app_private.find_stale_run_summaries(1000)` returns no rows after maintenance
drains the fixtures. A zero candidate count is a setup check, not a production
progress guarantee. Do not change the development database to fix a test setup.

| Change | Checks |
|---|---|
| Documentation | Relative file links and `git diff --check` |
| API/web behavior | Focused tests, `npm run verify`, affected browser specs |
| SQL, maintenance, access or persistence | Also `npm run test:integration` under the validated test roles |
| Before showing the demo | `npm run demo:doctor`, `npm run test:e2e:smoke`; Firefox smoke if used |
| Full browser/transport profile | `test:e2e`, `test:e2e:firefox`, `deploy:verify`, `transport:verify`, `proxy:verify-error-log`, as applicable |

Use the documented `TEST_*` values from `.env.example` in the calling process when
local values are absent. The suites reject non-test targets. Prove live database
and role identities before fixture writes. Bootstrap/migrate the test database
only when needed; this closeout did neither. Never repoint the suites at the demo
or development database. The current report lists precisely which checks ran.

## What persists

- PostgreSQL uses the Compose volume `running_tracker_postgres` (Docker's name is
  prefixed by the Compose project). `db:down` and demo Ctrl+C keep it; Compose
  `down -v` removes development and test data and is not part of restart.
- `.env` and `.local/` are private, gitignored machine state: configuration, TLS,
  demo lock, raw GPS files and verification logs. They are not included in Git.
- Opaque sessions and OIDC login transactions remain in memory. Restarting the
  API loses them; reauthenticate. Retry state/metrics also reset on restart.

## Evidence limits and deferred work

All new evidence is local to one Windows workstation. Historical full-matrix
results are in [the October pause report](reports/pause-verification.md); the
[November 2 report](reports/maintenance-sql-budgets-2026-11-02.md) records the prior
SQL-budget slice. Neither is a current hosted-CI or production claim.

Still deferred: physical-phone capture/GPS accuracy and background behavior;
current hosted CI; Safari/WebKit/mobile validation; actual provider OIDC and
Mapbox basemap; production hosting and off-host backup/journal/restore evidence;
durable sessions; candidate fairness and whole-job/I/O cancellation. AI search is
optional/off by default, and no live-provider accuracy is established. The new
journal failure test injects sink failures; it does not simulate physical storage
failure or prove crash durability.

The new Chromium detail assertions passed, but the installed Mapbox runtime test
logged a container warning and two unhandled `this.errorCb is not a function`
rejections. Its screenshot shows the route against a local style. Investigate
this separately before claiming a clean map console or using a provider basemap.

When resuming, prioritize the physical pilot and operational gaps in the review;
keep deployment and new features as separately authorized work.
