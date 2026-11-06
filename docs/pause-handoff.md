# Pause handoff (updated 2026-11-06)

## Resumed on 2026-11-06 with a new direction

The pause below has ended. The project is resumed as a broader activity, health and nutrition tracker with an AI
coach on a local Ollama model; the roadmap and the principles every later slice must follow are in
[product-direction.md](product-direction.md). Work proceeds one small vertical slice at a time.

- **Step 1 (done, committed locally as `d0224c2` on branch `feat/activities`):** owner-only manual activities, [ADR-0072](adr/0072-owner-only-manual-activities.md):
  migration `0025_activities.sql`, strict contracts and OpenAPI, `/api/orgs/:orgId/activities`, an **Activity** tab, and
  tests at every layer. Runs, ingestion, the GPS algorithm, SSE, tiles, retention and AI search are unchanged. Evidence
  is in the [progress entry](progress.md) "Resumed: owner-only manual activities (step 1)".
- **Integrity follow-up (done, committed as `66f274e`):** [ADR-0073](adr/0073-erasure-ledger-and-idempotent-activity-creation.md):
  migration `0026_erasure_ledger.sql` records every activity deletion in an outbox exported beside the run deletion
  journal, and `npm run restore:reapply-erasures` replays it after a restore (the restore drill covers it); migration
  `0027_activity_idempotency_keys.sql` and a per-form-session key stop duplicates after an unknown save outcome.
  Evidence: the progress entry "Integrity follow-up: erasure ledger and idempotent activity creation".
- **Step 2 (done, uncommitted at hand-off):** daily check-in, [ADR-0074](adr/0074-daily-check-in-local-date-and-put-replace.md):
  migration `0028_daily_metrics.sql` (one row per person per local date, owner-only RLS, value-column-only UPDATE,
  database timestamps, erasures in the ledger as `daily_metric`), `0029_activity_created_at_database_clock.sql`
  (activity creation instants from the database clock), `/api/orgs/:orgId/daily-metrics`, a **Check-in** tab, and a
  restore drill that also erases a check-in day. Evidence: the progress entry "Step 2: daily check-in metrics".
- **Migration state:** `0025`-`0029` were applied to the `running_tracker_test` database only. The development
  database is not migrated by that work; `npm run demo:up` (or `npm run db:migrate`) applies them on the next start.
- **Remaining limitations:** an erasure committed but not yet exported when the node is lost (one export interval
  while healthy) can still come back with an old backup, as for run deletions (ADR-0037). There is no stored profile
  time zone (the browser's zone is sent with each check-in write), and two devices editing one day overwrite each other.
- **Suggested next step:** GPX/TCX/FIT import into activities, or the meal log (owner-only, same template, erasures
  through the ledger's extension point).

The rest of this document is the pause handoff as written for the map lifecycle closeout. Its restart and
verification instructions still apply; "no further product work" no longer does.

## Paused state before resuming

The project is paused as a locally verified demo/portfolio application after four
new map lifecycle commits. The architecture remains React + Express +
PostgreSQL/PostGIS. Start with the [current verification report](reports/freeze-verification-2026-11-06.md)
and [architecture review](reports/architecture-review-2026-11-06.md). No further
product work is required for this freeze.

## Latest closeout

Clean starting point: `8c4f9e2`, which documented the previous maintenance freeze.
The new boundary is exactly four local commits after it:

1. `cf7704b`: exclusive empty archive map host, responsive canvas and ADR-0071.
2. `d006133`: shared asynchronous map allocation/control-setup cleanup, aborted
   import handling, ArchiveMap lifetime guards and Coach attachment containment.
3. `ff03b31`: installed-runtime lifecycle/failure regressions, uncaught-error and
   container-warning assertions, explicit local provider protocol fixtures.
4. The documentation commit containing this handoff: architectural assessment,
   regression evidence and renewed pause. Obtain its hash with `git log -1`.

Mapbox owns its canvas subtree; React owns sibling notices. Each map owner still
removes its successfully initialized instance. The shared factory removes an
instance if control setup fails and never allocates after an aborted import.
The browser scenarios exercise archive/details, refresh, reopening, sign-out and
HTTP 503 base-style failure, alongside the existing capture/result workflows.

The installed Mapbox 3.31.0 source map identifies a separate dependency hazard:
removal nulls event/session error callbacks that failed pending requests may
still call. The old fixture aborted those requests. Successful-runtime tests now
answer auth/telemetry locally and still fail on uncaught page errors; they do not
patch the dependency or establish correctness under actual provider network
failure. Investigate that boundary against a real provider before participant use.

## Product and operational state retained

- Capture, offline IndexedDB buffer, fenced writer ownership and exact lifecycle
  retries remain owned by App across result navigation.
- Finished-run review uses published archive tracks (ADR-0066), owner details
  (ADR-0067) and explicit **Finish -> View result -> Back to Runner -> New run**
  (ADR-0068). Pending/rejected device uploads or obsolete summary revisions hide
  the route/statistics. Restored runs need fresh server confirmation; publication
  can remain pending/stale. Refresh is explicit, without deep links or polling.
- Maintenance SQL has independent statement/lock budgets (ADR-0069). Per-task
  jittered failure backoff, metrics and recovery logs are retained (ADR-0070).
  They do not provide per-candidate fairness, durable attempts or whole-job/I/O
  cancellation. An idle successful cycle does not prove backlog progress.
- AI search is optional/off by default. Sessions, OIDC login transactions and
  retry state remain process-local and are lost on API restart.

## Returning to the project

1. Inspect `git status --short --branch` and `git log --oneline -6`. This closeout
   is exactly four commits after `8c4f9e2`; later work needs new evidence. A local
   `origin/main` comparison does not refresh the remote or establish hosted CI.
2. Start Docker Desktop; use Node 24/npm 11. Run `npm ci` only if required by the
   dependency/lockfile state. Browser installation when needed:
   `cd tests/e2e; npx playwright install chromium firefox; cd ../..`.
3. Run `npm run demo:doctor`, then `npm run demo:up`. Ctrl+C stops that stack and
   keeps PostgreSQL data. Authenticate again after restarting the API.
4. Use separate browser profiles/contexts for runner and coach. Follow
   [the rehearsal](runbooks/demo.md). Two tabs in one profile share a session.
   The map token is absent on this workstation; statistics and tokenless demo
   remain usable. Do not treat a synthetic local style as a provider basemap.
5. Select one bounded task from the architecture review before making changes.
   P00-P12 have no unfinished implementation stage; D10 remains partial until
   the physical-device pilot has actual sanitized traces/evidence.

## Verification on return

Integration and browser commands share the dedicated test database and must run
sequentially. Do not edit source or rebuild contracts/fixtures while browser
servers are running: Vite HMR can invalidate a scenario. Supply documented
`TEST_*` values from `.env.example` in process scope if absent. The suites reject
non-test targets; verify live database/role identities before fixture writes.
Never repoint them to development data.

Before publication-dependent browser scenarios, confirm an isolated clean test
DB or zero candidates in `app_private.find_stale_run_summaries(1000)`. Sequential
commands alone do not drain fixture backlogs. This closeout verified the live
`running_tracker_test` / `running_tracker_maintenance` identity and zero remaining
candidates before browser work; no publication was needed for setup.

| Change | Checks |
|---|---|
| Documentation | Relative file links and `git diff --check` |
| Map behavior | Focused map tests, `npm run verify`, affected Chromium details/coach/result specs and the applicable Firefox gate |
| SQL, maintenance, authorization or persistence | Also `npm run test:integration` under validated test roles |
| Before a demo | `npm run demo:doctor`, `npm run test:e2e:smoke`; Firefox smoke if used |
| Full browser or transport profile | Full Chromium/OIDC and Firefox gates, deploy/transport/proxy checks as applicable; not implied by focused results |

## What persists and what remains deferred

PostgreSQL uses the existing Compose volume. `db:down` and demo Ctrl+C keep it;
`down -v` is not a restart step. `.env` and `.local/` contain private gitignored
configuration, traces and local evidence. No secrets or local screenshots/logs
are part of the commits. Test runners own and stop their servers; keep the
existing database container and unrelated processes intact.

All current evidence is local to one Windows workstation. The current report
names exactly which checks ran; older reports remain historical snapshots.
Still deferred: physical-phone capture/GPS accuracy/background behavior; current
hosted CI; Safari/WebKit/mobile browser evidence; actual provider OIDC/basemap and
Mapbox auth/telemetry failure behavior; production hosting and off-host
backup/journal recovery; durable sessions; maintenance candidate fairness and
whole-job/I/O cancellation. No migration, dependency update, push or deployment
belongs to this closeout.
