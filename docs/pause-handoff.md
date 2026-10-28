# Pause handoff (2026-10-28)

Audience: whoever returns to this project after the pause, including its author. It says where things stand, how to
get the demo running again, and what is still not established. History is in [progress.md](progress.md); the last
verification, with its environment and tables, is in [reports/pause-verification.md](reports/pause-verification.md).

## Status

**Ready to pause as a locally verified demo/portfolio project.** The five-step closeout plan is complete and no
further product work is required for this pause. The "Future options" at the end are deferred, not unfinished.

## What the closeout completed

| # | Step | Commit |
|---|---|---|
| 1 | Owner deletion of a finished run from Archive → My runs (inline confirmation, unknown-outcome retry) | `8e6e4a3` |
| 2 | Manage sharing stays blocked for a run whose DELETE is still pending, across searches | `d4a27b2` |
| 3 | A two-minute browser simulator for the local demo only (60 points, two seconds apart) | `d088ba5` |
| 4 | The rehearsal through `demo:up`, a second `demo:up` refused, console Ctrl+C, restart with data kept | recorded in `d2438da` |
| 5 | Final regression: the smoke gains `demo-simulator` and `run-deletion` (18 → 24 tests), full matrix | `d2438da` |

Step 4's evidence is in [runbooks/demo.md](runbooks/demo.md) ("Rehearsal results (2026-10-28)" and "Ctrl+C and
restart, 2026-10-28"). Step 5's is the verification report.

## The tested snapshot

- **Tested:** base `d088ba5` plus one uncommitted harness change, the smoke allowlist in
  `tests/e2e/playwright.smoke.config.ts`. Every command of the matrix passed on its first attempt (2026-10-28,
  Windows 11, one run each); see [the report](reports/pause-verification.md) for the commands, counts and durations.
- **Committed since:** `d2438da` contains that allowlist change and documentation only. Outside `docs/` and
  `README.md`, `git diff d088ba5 d2438da` touches only that file, so the code and tests at `d2438da` are the ones
  tested. The documentation in `d2438da` was written after the runs.
- **Uncommitted at the time of writing:** this handoff pass, documentation only: this file, `README.md`,
  `docs/interview.md` and `docs/progress.md`. No application code, test, dependency or configuration was changed.
  If `git status` still lists these four, the handoff was never committed; commit them or discard them deliberately.

## Returning to the project

1. **Git state.** `git status` and `git log --oneline -5`. Expect `main` at `d2438da` or a commit that adds this
   handoff. Anything else changed after the pause and needs its own reading before you trust the results above.
2. **Dependencies, when needed.** Start Docker Desktop. Run `npm ci` if `node_modules` is missing or
   `package-lock.json` changed. Node 24 and npm 11 are required (`engines`). For browser tests:
   `cd tests/e2e; npx playwright install chromium firefox; cd ../..`.
3. **Check the machine.** `npm run demo:doctor` is read-only and says what `demo:up` would refuse, with a hint.
4. **Start the demo.** `npm run demo:up`, wait for the app URL, then open `http://127.0.0.1:5173` in **two separate
   browser contexts**: two browser profiles, or an ordinary and a private window. One profile is one person, so two
   tabs of one profile cannot be runner and coach. Press **Demo runner** in one and **Demo coach** in the other, and
   follow the rehearsal in [runbooks/demo.md](runbooks/demo.md). Ctrl+C stops the API and Vite; PostgreSQL keeps
   running.
5. **Choose the verification that fits the change** (all from PowerShell, one after another, because the
   integration and browser suites share `running_tracker_test`; it needs `npm run db:bootstrap:test` and
   `npm run db:migrate:test` once):

   | Situation | Run |
   |---|---|
   | Documentation only | relative-link check, `git diff --check` |
   | Before showing the demo | `npm run test:e2e:smoke` (Chromium); `npm run test:e2e:smoke:firefox` optional |
   | Web or API change | `npm run verify`, then the affected Playwright specs with `--project=chromium` |
   | SQL, migration or access-control change | also `npm run test:integration` |
   | Full regression, as recorded | the report's order: `verify`, `test:integration`, `test:e2e`, `test:e2e:firefox`, both smokes |
   | Production profile, transport, proxy log | the Docker verifiers `deploy:verify`, `transport:verify`, `proxy:verify-error-log` (not part of the pause matrix) |

## What persists, and where

- **PostgreSQL data** lives in the Compose volume `running_tracker_postgres` (Docker lists it as
  `running-tracker_running_tracker_postgres`). `npm run db:down` and Ctrl+C on `demo:up` keep it;
  `docker compose -f infra/compose/docker-compose.yml down -v` deletes it, with every development and test row.
  The demo rehearsal runs are ordinary rows in the development database `running_tracker`.
- **Outside Git:** `.env` (local configuration, gitignored) and `.local/` (development TLS files, the `demo:up`
  lock, raw GPS exports, load results). Neither is backed up by the repository, and neither should be committed or
  pasted anywhere. Without `.env`, `demo:up` falls back to `.env.example` for the database settings.

## Remaining limits

- **Local only.** Every recent result is from one Windows 11 workstation, one run per command. A single pass is not a
  measure of stability.
- **No hosted CI evidence for this version.** The last GitHub-hosted run is of `83f804f` (2026-10-14, 87 browser
  tests then). The Firefox CI entry has never run on a hosted runner.
- **D10 is PARTIAL.** No physical GPS recording has been analysed; the tooling waits for recordings
  ([reports/real-device-pilot.md](reports/real-device-pilot.md)).
- **Browsers.** Chromium runs the full suite (115 tests with OpenID Connect). Desktop Firefox on Windows runs the
  18-test core gate and the 24-test smoke; OpenID Connect sign-in and the real map runtime were not run in Firefox.
  Nothing ran in Safari/WebKit, a mobile browser or on a real device.
- **Provider and map.** Sign-in was tested only against test OpenID providers, never a real one, and provider-side
  logout does not exist. The Coach map ran with a fake runtime and, in Chromium only, one real-runtime smoke against
  a local empty style; no real Mapbox basemap was rendered in any test.
- **AI search.** The optional interpreter is off by default. OpenAI has never been called and no live evaluation has
  run; the suites use a deterministic fake. A local Ollama run (`qwen3:8b`, CPU, 2026-10-14) missed the 10 s deadline
  for every search case, so no accuracy is claimed for any model ([runbooks/run-search-ai.md](runbooks/run-search-ai.md)).
- **Demo.** The rehearsals were scripted in headless Chromium with Playwright's offline switch; nobody has followed
  them by hand in two real profiles, and the Ctrl+C was a console control event, not a key typed in a terminal.

## Future options (deferred)

None of these is required for the pause or blocks it. In order of value if work resumes:

1. A hosted CI run of the current commit, including the first hosted run of the Firefox entry (the workflow has a
   `workflow_dispatch` trigger).
2. D10 with physical recordings: the GPX replay and the real-phone browser pilot in
   [reports/real-device-pilot.md](reports/real-device-pilot.md).
3. A person following the rehearsal by hand in two real profiles, with a Mapbox token, before any live demo.
