# Browser end-to-end tests (runner recording and coach live view)

Date: 2026-10-02. Status: implemented and verified in Chromium on a workstation (updated 2026-10-03); the scenarios below describe what is verified, and "Verification of the tests themselves" records what the mutations showed.
Audience: the maintainer of this repository and the agent that implements it.
Source of the requirement: `docs/implementation-plan.md` section 7 ("Browser: recording, IndexedDB reload/offline,
observer reconnect, grant revoke, archive refresh"). No browser test exists today; every claim about the web app
rests on jsdom unit tests and on HTTP-level integration tests.

## 1. Goal and success criteria

Prove in a real browser, against the real API and PostgreSQL, the parts of the runner and coach flows that jsdom
cannot show: IndexedDB survival across a reload, the offline/online transition, the cross-tab writer lease, the SSE
stream in the coach view, and the effect of revoking access on an open stream.

Success means:

1. `npm run test:e2e` passes on a clean checkout that has Docker, the database set up as in the README, and Chromium
   installed with one documented command.
2. Each of the six scenarios in section 4 was seen **failing before** the behavior it checks was in place or
   deliberately broken (RED), and passing afterwards.
3. At least two mutations of product code (section 6) make the matching scenario fail, and were reverted.
4. No product code changes, unless a scenario proves a real defect; such a defect is reported and fixed in its own
   change, not hidden in the test change.

## 2. Scope

In: runner recording with the Simulator source, reload, offline, a second tab, the Coach tab with a shared run,
revoking the share. Chromium only. Local execution only.

Out (each is a separate, later task): the archive view and Mapbox (needs a public token; the archive is covered by
network-level assertions elsewhere), Firefox and WebKit, mobile emulation, real device GPS, CI integration (there is
no remote repository or hosted runner on which to verify it, and a CI step that was never run would be an unverified
claim), real OpenID Connect sign-in.

## 3. Architecture

### 3.1 Placement

A new workspace `tests/e2e` named `@running-tracker/e2e`, added to the root `workspaces` list. Its dependencies are
exact-pinned like the rest of the repository (`@playwright/test` and `pg`). Its script is `e2e`, **not** `test`:
the root `npm test` runs `test` in every workspace and would pull a slow browser suite into the fast gate. The root
gets `"test:e2e": "npm run e2e --workspace=@running-tracker/e2e"`. `npm run verify` is unchanged.

Chromium is installed by `npx playwright install chromium` (about 150 MB in the user's Playwright cache, outside the
repository). The README documents it; the suite fails with a clear message if the browser is missing.

### 3.2 Servers

Playwright's `webServer` starts two processes and stops them afterwards:

| Process | Address | Notes |
|---|---|---|
| API: `node --import tsx src/entrypoint.ts` run in `apps/api` (the `dev` script without `--watch`, so a file change cannot restart it mid-test) | `127.0.0.1:3100` | `APP_ENV=test`, `DATABASE_URL` = the `running_tracker_runtime` login on `running_tracker_test`, `MAINTENANCE_DATABASE_URL` likewise, `LOCAL_AUTH_ENABLED=true`, `LOCAL_AUTH_USER_IDS` = the generated runner and coach IDs, `ALLOWED_ORIGINS=http://127.0.0.1:5273`, `SESSION_COOKIE_SECURE=false`. Variables set in the process environment win over `.env`, which `process.loadEnvFile` never overrides, so a developer's `.env` cannot redirect the suite. |
| Vite dev server | `127.0.0.1:5273` | `API_PROXY_TARGET=http://127.0.0.1:3100`; same-origin `/api` as in development |

The page is always opened as `http://127.0.0.1:5273`, never `localhost`: the Origin check compares exactly.

Ports differ from development (3000, 5173) so the suite can run while a developer server is up. It does **not**
touch the `running_tracker` development database or `.env`. It does share `running_tracker_test` with
`npm run test:integration`; the two must not run at the same time (documented in the README; `workers: 1` inside the
suite).

### 3.3 Test data

A small helper in `tests/e2e/support/` connects as the object owner (`TEST_MIGRATION_DATABASE_URL`, the same login
the integration fixtures use; it refuses a database whose name does not end in `_test`) and, per test, creates an
organization with fresh random UUIDs, a runner (active `runner` membership) and a coach (active `coach` membership).
It deletes its own rows in `afterEach`, in dependency order (commands, points, summaries, shares, runs, tombstones,
memberships, organizations), touching only IDs it created. Because `LOCAL_AUTH_USER_IDS` is read at API
startup, the runner and coach are **two fixed IDs** (`eeeeeeee-eeee-4eee-8eee-eeeeeeee0001` and `...0002`, constants in
`support/environment.ts`) handed to the API process through its environment; organizations and runs stay per-test.
They are not generated per run: `playwright.config.ts` is imported again in every Playwright worker, so a random ID
created there would differ between the API process and the tests. The two users are inserted idempotently
(`ON CONFLICT DO NOTHING`) and are only removed by the suite's global teardown.

Sign-in: the browser has no development sign-in control. Each browser context signs in with
`context.request.post('/api/session', { data: { userId }, headers: { origin } })`; the cookie lands in the context's
cookie jar and the page then loads authenticated. The CSRF token for API calls made by the test itself (granting a
share, reading state) comes from `GET /api/session`.

### 3.4 Selectors

Only what the app already exposes: roles, labels and `aria-label`s (`Run controls`, `Application view`,
`Capture source`, `Organization ID`, `Live run markers`, `Selected live tracks`, `role=status`, `role=alert`, the
button names). No `data-testid` is added. If a scenario cannot be written without one, that is recorded as a finding
instead of silently changing product markup.

### 3.5 Server-side assertions

Browser behavior is judged by what the server holds, not by pixels: the test reads
`GET /api/orgs/{org}/runs/{run}` and the raw history endpoint as the runner (through `context.request`) and checks
status, `dataRevision` and the set of `seq` values. This is what turns "the UI said sent" into "the server has it".

## 4. Scenarios

All use the Simulator source (`normal`, seed 1: 6 points two seconds apart, about 10 s of real time, so no fake
clock is needed). Test timeouts are set from that, not from sleeps; waits are on observable state.

1. **Record and finish.** Runner opens Runner, enters the organization ID, selects the Simulator, starts, waits until
   capture completes and the buffer is empty, finishes. Server: run `finished`, 6 distinct `seq`, contiguous.
2. **Reload mid-run (verified).** Reload after a point was acknowledged by the server. Verified behaviour: the run is
   restored as `recording`; the tab owns the writer lease again without a click and well inside the old lease's 15 s
   (the test allows 10 s; about 0.2 s was measured), with a new fencing token; no "Retry ownership" button is offered;
   the Simulator remains the selected source and the Geolocation API is never called (spied across the reload);
   capture restarts in a new segment and completes; the buffer drains; the run finishes. Server: every `seq` unique,
   the set gap-free, the points acknowledged before the reload intact at the start, and the count at least those plus
   the points captured after the reload. The Simulator restarts after a reload, so more than 6 points exist. The two
   defects first found by this scenario (a reload conflicting with its own lease; the capture source lost) are fixed;
   see ADR-0047 and `docs/progress.md`.
3. **Offline then online.** `context.setOffline(true)` after the run starts. Expected: the offline notice shows,
   points keep accumulating in IndexedDB, nothing reaches the server. After `setOffline(false)` the buffer drains.
   Server: all `seq` present exactly once, none missing.
4. **Second tab.** The same signed-in user opens a second page in the same context while the first is recording.
   Expected: the second page shows the writer-conflict notice (after a bounded wait of up to 3 s), its controls are
   disabled, and the server receives no point from it (the `seq` set equals the first tab's). A variant gives the
   second page a copy of the first page's `sessionStorage`, the closest model Playwright offers of Chrome's "Duplicate
   tab"; the real menu item cannot be driven.
5. **Coach sees live.** A second browser context, signed in as the coach, opens Coach with the organization ID.
   The test (as owner, through the API) grants the coach live access to the runner's run while the runner records
   in the browser. Expected: the run appears under `Live run markers`, first as unconfirmed and then as confirmed
   once an edge exists. The run is not visible before the grant.
6. **Revoke removes data.** With scenario 5's setup, the owner deletes the share through the API. Expected: within
   the live poll interval (2 s, bounded wait of a few cycles) the run disappears from the coach's markers and from
   `Selected live tracks`, including any last-known data.

The share is created through the API because the Runner tab has no sharing control (`docs/runbooks/demo.md`). This is
a product gap, noted, not worked around in product code.

## 5. Failure handling and flakiness policy

- `workers: 1`, `fullyParallel: false`, `retries: 0`. A retry would hide exactly the timing bugs this suite exists to
  find; a flaky scenario is investigated, not retried.
- Waits use Playwright's auto-waiting and `expect.poll` on server state with explicit timeouts. No fixed sleeps.
- On failure, Playwright keeps trace, screenshot and the page's console log under `tests/e2e/test-results/`
  (gitignored). Network logs are not allowed to contain session tokens: the trace is for local use and is not
  attached to reports.
- The suite refuses to start if `running_tracker_test` is not reachable or the migrations are behind, with the
  command to run (`npm run db:bootstrap:test && npm run db:migrate:test`).

## 6. Verification of the tests themselves

Passing tests prove little if they cannot fail. Besides RED-first, the implementation runs these mutations against a
scratch edit of product code, confirms the named scenario fails, and reverts the edit:

| Mutation | Scenario that must fail |
|---|---|
| In `point-upload-worker.ts`, delete points from the buffer before the server acknowledges the batch | **Not scenario 3** (measured: it passed, because the uploader stops while offline and never fails a send). Caught by the added upload-failure scenario (503 on the points endpoint while online) |
| In `writer-lease.ts`, make a second claimant succeed | 4 (second tab) |
| In the live-state server filter, keep a revoked run in the stream | 6 (revoke) |

The mutations are never committed. The report states which ones were run and what failed. Results (2026-10-03) are in `docs/progress.md`: the first mutation exposed a gap in scenario 3 and led to the extra scenario; the other two failed the scenarios named above.

## 7. Documentation

README: how to install Chromium, run `npm run test:e2e`, the shared-database warning, what is and is not covered.
`docs/implementation-plan.md` section 7 is not rewritten; `docs/progress.md` gets a new section with the commands
run and their real results, and states that the archive view, other browsers and CI are not covered. The decision
to keep the suite out of CI and out of `npm run verify` is recorded there.

## 8. Risks and open points

- **Timing of the Simulator after reload** is observed, not assumed (scenario 2).
- **Rendering of the Coach markers** has no map, only the marker list; the assertions rely on its accessible text,
  which is read from the component when the scenario is written.
- **Playwright version and browser download** are pinned and verified at implementation time; if the download is
  blocked on the machine, scenarios cannot run and that is reported as blocked, not skipped silently.
- **Shared `running_tracker_test`**: a concurrent integration run corrupts both. Mitigated by documentation and
  unique IDs, not by locking.
