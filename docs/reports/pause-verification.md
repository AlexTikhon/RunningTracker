# Pause verification (2026-10-28)

Audience: whoever picks this project up after the pause, and needs to know what was last verified, on what, and
what was not. History: `docs/progress.md`; the earlier review closeout: `docs/reports/review-closeout.md`.

## Result

**Every entry of the matrix passed on its first and only attempt: 0 failed, 0 flaky, 0 skipped, retries 0.** No
regression was reproduced, so no application code, test, assertion, retry or timeout was changed. The one change
under test is the smoke allowlist, which now also selects `demo-simulator` and `run-deletion`.

These are local results on one workstation. They do not show that this version passes on a GitHub-hosted runner:
the last hosted run was of commit `83f804f` (2026-10-14; see the README), and the Firefox CI entry has never run
hosted.

## What was tested

- Base commit: `d088ba5` (feat(web): a two-minute simulator for the local demo), branch `main`.
- Uncommitted changes in the tested working tree:
  - `tests/e2e/playwright.smoke.config.ts`: the smoke spec allowlist gains `demo-simulator` and `run-deletion`
    (18 → 24 tests per smoke project). Servers, database guard, preflight, timeouts, retries, cleanup and output
    directories are unchanged; the `firefox-core` allowlist in `playwright.config.ts` is unchanged.
  - `docs/runbooks/demo.md`, `docs/progress.md`: the 2026-10-28 `demo:up` rehearsal evidence (documentation only),
    plus this pass's documentation updates, which were written after the runs.

## Environment

| Item | Version or state |
|---|---|
| OS | Windows 11 Home 10.0.26300 |
| Node / npm | 24.11.1 / 11.6.2 |
| Docker Engine | 29.7.2 (Docker Desktop), Compose container `running-tracker-postgres-1`, loopback port 5433 |
| PostgreSQL / PostGIS | 17.5 / 3.5.2 |
| Test database | `running_tracker_test`, 25 of 25 migrations applied before the runs (no bootstrap or migration was needed or run) |
| Playwright | `@playwright/test` 1.63.0; Chromium 153.0.8010.12 (build 1243), Firefox 155.0 (build 1543), headless |
| Configuration | `.env` read as is, never changed (same SHA-256 before and after); no process-local override was needed |

The development database `running_tracker` was not used by any of these commands.

## Matrix

Run one after another from PowerShell, in this order, because the integration and browser suites share
`running_tracker_test`. Durations are wall-clock for the whole npm command, including builds, server start-up and,
for the smoke, its preflight.

| Command | Outcome | Counts | Duration |
|---|---|---|---|
| `npm run verify` | exit 0 | lint, typecheck; scripts 83, API 1332, web 820, contracts 132, fixtures 14, simulator 3 (2,384 unit tests); build | 350 s |
| `npm run test:integration` | exit 0 | 463 passed in 45 files, 0 skipped | 202 s (Vitest 191 s) |
| `npm run test:e2e` | exit 0 | 115 passed: 106 `chromium` + 9 `chromium-oidc`; 0 failed, 0 flaky, 0 skipped | 611 s (Playwright 10.1 min) |
| `npm run test:e2e:firefox` | exit 0 | 18 passed (`firefox-core`) | 198 s (3.2 min) |
| `npm run test:e2e:smoke` | exit 0 | preflight ok; 24 passed (`smoke-chromium`) | 192 s (3.1 min) |
| `npm run test:e2e:smoke:firefox` | exit 0 | preflight ok; 24 passed (`smoke-firefox`) | 201 s (3.3 min) |

Before the runs, `npx playwright test --list` (from `tests/e2e`) showed the selections:

| Project | Selected |
|---|---|
| `smoke-chromium`, `smoke-firefox` (each) | 24 tests in 8 files: `archive-sharing` 4, `demo-sign-in` 6, `demo-simulator` 1, `record` 1, `reload-offline` 3, `run-deletion` 5, `run-sharing` 2, `second-tab` 2 |
| `firefox-core` | 18 tests in 7 files (unchanged) |
| `chromium` + `chromium-oidc` | 115 tests in 27 files |

Reading the results:

- In the full Chromium list `harness.spec.ts:66` is printed with `x`. It calls `test.fail()` on purpose, to prove
  that the scenario fixture removes a failed test's data, and Playwright counts it among the 115 passed.
- The integration suite's nine restore-drill tests (`backup-restore.integration.test.ts`) are skipped when
  `RESTORE_DRILL_ADMIN_URL` is empty. Here the four `RESTORE_DRILL_*` variables were set in `.env` (checked for
  presence only; no value printed) and the run reported 0 skipped, so the drill ran and passed. It is the local drill
  against the Compose server, not a restore of a production backup.
- `npm run verify` under PowerShell printed one `NativeCommandError` record. That is PowerShell 5.1 wrapping a line
  npm wrote to stderr, not a failure; the command exited 0.

## Failures, fixes and skips

None. No test failed or was retried, nothing was skipped, and nothing was changed to make a run pass. No step was
unavailable.

## Browser coverage boundaries

- **Chromium**: the full suite (106 tests) and the OpenID Connect project (9), plus the 24-test smoke.
- **Firefox (desktop, Windows, headless)**: the 18 `firefox-core` tests and the 24 smoke tests. This was the first
  Firefox run of the smoke, and so the first Firefox run of `demo-sign-in`, `demo-simulator` and `run-deletion`; all
  passed. The rest of the suite (OpenID Connect sign-in, the real-runtime map smoke, run search and the remaining
  specs) has not run in Firefox.
- **Not covered**: Safari/WebKit, mobile browsers, real devices and real GPS, a real identity provider, a real
  Mapbox basemap (the Coach map runs against a placeholder token and a local empty style), and a person following
  the steps by hand.
- The smoke reuses specs that are also in the full suite. It shows they pass against the smoke's smaller stack (API
  on 3100 with the run-search interpreter off, Vite on 5273 and 5276 without a Mapbox token); it adds no new
  assertions.

## Remaining limitations

- One run of each command. A single pass is not a measure of stability; the timing-dependent specs (the simulator's
  real-time capture, the 60–120 s summary-worker waits) are the ones to watch.
- No hosted CI run for this version, and the Firefox CI matrix entry has never run on a hosted runner.
- The demo-simulator browser test covers about 30 s of its two minutes; exhaustion after 60 points is proven with
  fake timers only.
- The live OpenAI run-search interpreter has never been run (no key or model in this environment); the suites use
  the in-process fake.
- The `demo:up` Ctrl+C evidence of the same day used a console control event sent to the demo's console, not a key
  typed in an interactive terminal (see `docs/runbooks/demo.md`).

## Cleanup

After the last run nothing listened on 3000, 3100, 3101, 5173, 5273, 5274, 5275, 5276 or 9100, no Playwright browser
process remained, and two Node processes that were running before this pass were left untouched. Logs were kept in
a session scratch directory and deleted afterwards. The test database keeps whatever the suites' own cleanup leaves,
as after any run; no volume or database was reset.
