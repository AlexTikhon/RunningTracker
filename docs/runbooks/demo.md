# Runbook: the local demo

Audience: anyone who wants to see the system work on one machine, and to know exactly what that does and does not
show. Related: `README.md` (setup), `docs/runbooks/identity-provider.md` (real sign-in).

The demo walks one story: a runner records a run, a coach watches it live, the run is finished and summarized, and
it appears in the archive. It needs Docker, the dependencies installed (`npm ci`) and about five minutes. A `.env` is
optional: without one, the database settings come from `.env.example`.

## 0. One command

```sh
npm run demo:doctor   # read-only: is this machine ready?
npm run demo:up       # start everything; Ctrl+C stops it
```

`demo:doctor` checks Node and npm against `engines`, the installed dependencies, the Docker CLI, engine and Compose,
the PostgreSQL container and volume, ports 3000 and 5173 (and the database port, which may only be held by the
Compose container), whether a `demo:up` is already running, and the demo configuration. It starts nothing, writes
nothing and prints no password or token: database URLs are shown as `role@host:port/database` with where each came
from. It exits 1 when `demo:up` would refuse to start, with a hint under each problem.

`demo:up` runs the same checks first and stops before changing anything if one fails. Then it runs, in order and
each with a deadline:

| Step | Command it reuses | Deadline |
|---|---|---|
| PostgreSQL | `docker compose -f infra/compose/docker-compose.yml up -d --wait --wait-timeout 120 postgres` | 10 min (the first start may pull the image) |
| Roles and PostGIS | `scripts/bootstrap-database.mjs` (`npm run db:bootstrap`) | 60 s |
| Migrations | `scripts/migrate.mjs` (`npm run db:migrate`) | 120 s |
| Demo people | `scripts/demo-seed.mjs` (`npm run demo:seed`) | 60 s |
| Shared packages | `npm run build --workspace=@running-tracker/fixtures` (builds contracts too) | 180 s |
| API | `node --import tsx src/entrypoint.ts` in `apps/api` (`npm run dev` without the watcher), ready when `/api/health/ready` answers 200 | 90 s |
| Web | Vite in `apps/web`, ready when the page and `/api/health/ready` through its proxy answer 200 | 60 s + 15 s |

When both answer it prints the app URL, `http://127.0.0.1:5173`, and the two demo identities. Open the app and press
**Demo runner** or **Demo coach** (section 3); no developer tools are needed. Play the runner with `npm run demo:run`
(section 4) in another terminal.

**Configuration.** `demo:up` never writes `.env`. It reads the four database URLs from the environment, then `.env`,
then `.env.example`, refuses any that is not the plain `running_tracker` database on a loopback host with its
expected role (the same guard as `demo:seed`), and refuses `APP_ENV=production`. It then passes these to its own
child processes only, on top of everything else in `.env`:

```text
APP_ENV=development
LOCAL_AUTH_ENABLED=true
LOCAL_AUTH_USER_IDS=dddddddd-dddd-4ddd-8ddd-dddddddd0001,dddddddd-dddd-4ddd-8ddd-dddddddd0002
ALLOWED_ORIGINS=http://127.0.0.1:5173
API_HOST=127.0.0.1          PORT=3000          METRICS_HOST=127.0.0.1
API_PROXY_TARGET=http://127.0.0.1:3000
SESSION_COOKIE_SECURE=false
RUN_SEARCH_AI_ENABLED=false
VITE_LOCAL_DEMO_ENABLED=true
```

So local sign-in works for the demo runner and coach and nobody else, the page shows the two demo sign-in buttons,
the API and Vite listen on `127.0.0.1` only (the database port is already loopback-only in the Compose file), and no
AI provider, API key or Mapbox token is needed. A `VITE_MAPBOX_ACCESS_TOKEN` in `.env` is still used for the maps.
`npm run dev` and every other command keep reading `.env` as before, so a plain `npm run dev` shows no demo buttons.

**Stopping.** Ctrl+C stops the API and Vite, and only them: each is a child of this command, and on Windows a
console Ctrl+C reaches them directly, so the API runs its own graceful shutdown. Anything still running after
8 seconds is ended with its whole process tree (`taskkill /T /F` on Windows, the child's process group on Linux and
macOS); a second Ctrl+C does that at once. PostgreSQL keeps running, and the database and its Docker volume are not
touched: nothing in `demo:up` stops a container, removes a volume or resets data. `npm run db:down` stops the
container and keeps the volume.

**Repeating it.** Every setup step is idempotent: the roles get the same passwords, applied migrations are skipped,
and the seed only inserts what is missing. Existing runs survive a restart. A second `demo:up` while one is running
stops at once with the first one's process ID and changes nothing; the lock is `.local/demo/demo-up.lock` and is
removed on exit.

**When something is in the way.** If a port is taken, `demo:up` says which and how to find its owner
(`netstat -ano | findstr :3000` on Windows, `lsof -nP -iTCP:3000 -sTCP:LISTEN` elsewhere) and starts nothing; it
never stops another process to free a port. If a step fails or a server does not become ready in time, it prints that
step's output, stops whatever it had already started and exits 1.

**Limits.**

- One browser profile is one person at a time (section 3). Showing runner and coach side by side needs two profiles,
  or an ordinary and a private window.
- The ports are fixed (3000 and 5173); the demo does not move to free ones.
- The API runs without a file watcher; restart `demo:up` after changing API code. Vite still reloads the web app.
- If the `demo:up` process itself is killed (for example from Task Manager) rather than stopped with Ctrl+C, it
  cannot clean up and the API and Vite may keep running. Find them with the `netstat` command above and stop them by
  process ID. A lock left behind by a process that no longer exists is replaced on the next start. Closing the
  terminal window is handled like Ctrl+C, but Windows allows only a few seconds for it and that path was not tried.
- Tried on Windows 11 only (see below); the Linux and macOS process-group path is covered by the same code and unit
  tests but was not run on those systems.

Sections 1 and 2 below are the same thing done by hand.

## What this demo is not

- **Sign-in is the development session, not OpenID Connect.** No real identity provider exists for this project, so
  the demo buttons sign in with `POST /api/session` (local auth, development only, rejected in production; a
  production build of the web app does not contain the buttons at all, whatever its environment says). The OpenID
  Connect flow is exercised against an in-process test provider by `npm run test:integration` (the
  `oidc-login` suite) and its production surface by `npm run deploy:verify`; neither is a real provider.
- **The runner is a script, not the browser.** `npm run demo:run` plays the runner over HTTP with a simulated route.
  The Runner tab of the web app can also record (Device GPS or its simulator) and share the run with a coach
  (step 4a, ADR-0063); the script is still the shortest way to show the coach view.
- **The maps need a Mapbox token.** Without `VITE_MAPBOX_ACCESS_TOKEN` the Archive tab shows a notice instead of a
  map, and the Coach tab says its map is unavailable; the Coach cards and track picker work either way. The token is
  public by design; never put a server secret there.
- Nothing here is a performance or recovery claim.

## What was run, and what was not

When this runbook was written, steps 1, 3 (the script) and 4 were executed against a real API and PostgreSQL: the
seed, the sign-in through the Vite proxy, a scripted run shared with the coach, the coach's live stream (positions
`unconfirmed` for the first point, then `confirmed`, and the run leaving the live state when finished), the summary
being published, and a non-empty vector tile for the run. **The browser steps (the sign-in snippet, the Coach and
Archive tabs) were not exercised in a browser.** Treat their first run as a test and report what differs.

`demo:up` and `demo:doctor` (section 0) were run on Windows 11 with Docker Desktop on 2026-10-24: the doctor and
`demo:up` with the Docker engine stopped (both report it, nothing started); a full start (it applied three pending
migrations to the development database the first time and none the second); the API and Vite listening on
`127.0.0.1` only; `POST /api/session` through the Vite proxy answering 201 for the coach and 403
`LOCAL_IDENTITY_DENIED` for another identity; `npm run demo:run -- --points 3` to a published summary; a second
`demo:up` refused while the first kept answering; a console Ctrl+C (the API logged its graceful shutdown, and the
API, Vite and the API's `esbuild` helper were all gone within 1.3 seconds); a restart with the run count unchanged;
ports 3000 and 5173 held by another process (reported, holder untouched); and an API that fails at startup (reported,
nothing left running). `.env` was byte-for-byte unchanged throughout. The browser was not used for this either.

The demo sign-in buttons (section 3) were exercised on 2026-10-24 against a real `demo:up` on Windows 11, in headless
Chromium driven by a script, with two separate browser contexts standing in for two profiles: **Demo runner** and
**Demo coach** each sent one `POST /api/session` with the fixed ID, were then reported by `GET /api/session` as exactly
that person, and had organization `…0000` discovered and selected; the runner stayed the runner after the coach signed
in elsewhere; a second tab of the runner's context was already signed in; the Coach tab opened; Sign out brought the
buttons back. `.env` was unchanged. In the browser suite, `tests/e2e/demo-sign-in.spec.ts` covers the same flow on a
dev server with the flag, plus a pending request (both buttons disabled, one request), a failure and a refusal with a
retry, a late answer after the page moved on, an unanswered session check, and the absence of the buttons without the
flag; the OpenID Connect project checks they are absent there too. A production build made with
`VITE_LOCAL_DEMO_ENABLED=true` was byte-identical to one without it and contained neither the buttons nor the demo IDs;
that check was run by hand and is not part of any suite. Nothing was tried by hand in Firefox, Safari or a real
second browser profile.

## Rehearsal: the whole story in 5–7 minutes

One pass through the browser story for a demo or an interview: two people, a simulated run, live sharing, an offline
gap, the archive, and sharing a finished run. It uses only the browser and `demo:up`; `demo:run` is not needed. The
5–7 minutes are a plan for a person who talks while doing it. Driven by a script, the same steps took 70 s and 85 s
(see "Rehearsal results" below). The only fixed waits are the simulator's ten seconds (steps 3 and 6) and the summary
worker (step 9).

Two facts shape the steps. The browser's Simulator produces **six points per capture session**, the first at once
and then one every two seconds, so about ten seconds after Start or Resume it reads `complete` and stops; the run
stays `recording` and sends nothing more until the next Resume. And capture starts only once the server has confirmed
that the run is recording, so going offline *before* Resume would leave the Resume request queued and record
nothing. The offline gap therefore has to start a moment *after* Resume.

**The day before, or an hour before: run the automated smoke.** It needs the test database (`npm run
db:bootstrap:test` and `npm run db:migrate:test` once) and the browsers (`cd tests/e2e; npx playwright install
chromium firefox`):

```sh
npm run test:e2e:smoke            # Chromium
npm run test:e2e:smoke:firefox    # Firefox, optional
```

Each runs the 18 existing tests of `demo-sign-in`, `record`, `reload-offline`, `second-tab`, `run-sharing` and
`archive-sharing`, unchanged, with the full suite's timeouts, one worker and no retries. It starts its own API (port
3100, run-search interpreter off) and two Vite servers (5273 without and 5276 with the demo buttons, both with no
Mapbox token), uses only the `running_tracker_test` database through the same `_test` guard as the full suite, removes
its scenario data after each test and its suite users at the end, and never runs `demo:up` or `demo:seed`. A check
runs first and stops before anything starts if the browser is not installed, one of the three ports is taken (the
holder is reported, never reused or stopped) or PostgreSQL does not answer for the three test roles. Failure traces
and screenshots go to `tests/e2e/smoke-results/chromium` or `…/firefox`, apart from the full suite's
`tests/e2e/test-results`. The ports differ from `demo:up`'s (3000, 5173), so the smoke can run while the demo is up,
but its data is in the test database, not the demo's. A pass says those flows work in that browser on this machine
today; it is not a promise about the next run. Recorded so far: `npm run test:e2e:smoke` on 2026-10-24 (Windows 11,
commit `4ee4d94`), 18 passed in 2.8 min, 176 s including server start-up. `test:e2e:smoke:firefox` has not been run.

**Before the audience:** `npm run demo:up` (section 0) and wait for the app URL. Open `http://127.0.0.1:5173` in two
separate browser profiles, or an ordinary and a private window, side by side: one for the Runner, one for the Coach.
Two tabs of one profile are one person (section 3).

| # | Do | Expect |
|---|---|---|
| 1 | Runner window: **Demo runner**. Coach window: **Demo coach**. | Each shows "Signed in" and organization `…0000` selected; nothing is typed. |
| 2 | Coach: open the Coach tab. | The stream is live; the position board says "No active runs are currently shared with this identity." Without a token the **Live map** panel says "Map unavailable. Positions and tracks are listed below." |
| 3 | Runner: first open the developer tools (F12) → **Network** and leave its throttling menu (*No throttling*) in view; step 6 needs it within a second or two. Then Runner tab, **Capture source** → *Simulator · normal · seed 1*, **Start run**. | Recording reads `recording`. After about ten seconds Capture reads `complete` ("segment 0 · 6 buffered") and Upload "No buffered points". Nothing more is captured until step 6; the run stays `recording`. |
| 4 | Runner: in **Share this run with a coach**, press **Share** next to `Coach …dddd0002`. | The row reads "Live and history". |
| 5 | Coach: watch the board, then tick the run under **Track selection**. | Within a poll interval (two seconds) one run card with its position appears; the track option reads "6 points · rev R" and "1 selected". About ten seconds after the last point the marker turns `stale`, which is correct: capture has ended. With a token the position and the track are drawn on the map; without one they are only listed. |
| 6 | Runner: **Pause**, then **Resume**. As soon as Recording reads `recording` again, choose *Offline* in the throttling menu. Wait until Capture reads `complete` again (about ten seconds), then choose *No throttling*. | An "Offline" notice, and Upload reads "N pending", usually 5: the first point of the new session leaves before the switch. Meanwhile the coach's track stops at that point ("7 points") and the card stays, because a recording run is still live. Back online, the notice goes, Upload returns to "No buffered points" within about a second, and within a poll the coach's track jumps to "12 points" with a revision one higher: the pending points went as one batch and one revision. If Upload never showed pending, the switch came after the last point: Pause and Resume again for six more. |
| 7 | Runner: **Revoke**. | The row reads "Not shared". The coach's card, track option and selection disappear within a poll interval, and the board says no runs are shared again; the run keeps recording. |
| 8 | Runner: **Finish**, then **New run**. | Recording reads `finished`; **New run** is enabled only when nothing is pending, and the sharing panel leaves the Runner tab. |
| 9 | Runner: Archive tab, **My runs**, press **Apply filters** every few seconds until the run is listed. | The summary worker runs once a minute (`RUN_SUMMARY_INTERVAL_MS`, 60 s in `.env.example`), so allow up to about a minute; until then a notice says the run "is still being processed". The card then shows the date, a distance of about 0.08 km, the observed duration and **Manage sharing**. Talk through the Archive map meanwhile: with a token it draws the archive, without one it says "Map provider not configured". |
| 10 | Runner: **Manage sharing** on the new card, then **Share**, then **Revoke**. | The panel opens inside the card; the coach row reads "Not shared" (the grant was revoked in step 7), then "Live and history", then "Not shared". **Close** or Escape closes it. The run never becomes the active run. The coach's window shows nothing new: a finished run is not live. |

Finish with **Sign out** in both windows (section 6). Without a Mapbox token everything above works except drawing:
the Coach live map and the Archive map show their notices. What to show instead is the coach's card and its
"N points · rev R" count changing (steps 5–7) and the runner's **My runs** card (steps 9–10). Do not promise that the
coach sees the shared finished route: the Coach tab lists live runs only, **My runs** lists only the signed-in
person's own runs, and the only place a coach could see a finished shared route is the Archive map, which needs a
token. With `demo:seed:search` run beforehand, **My runs** also holds 47 synthetic runs of the demo runner, so the new
one is the first card of the default newest-first list rather than the only one.

The offline step uses the Chromium (Chrome, Edge) DevTools throttling menu. Other browsers have different controls,
and none of them was tried.

**Automated and manual, step by step.** The smoke covers the same behaviour in the browser it runs, but not the same
way a person does it:

| Step | Covered by the smoke | Only in the rehearsal |
|---|---|---|
| 1 Demo sign-in | `demo-sign-in` (both buttons, the organization, Sign out, a pending, failed and late sign-in, no buttons without the flag) | Two real browser profiles: the tests use two browser contexts |
| 3, 8 Record, finish | `record`, `reload-offline` (a reload during recording) | — |
| 4, 5, 7 Share, coach sees the track, revoke | `run-sharing` | The coach's map with a real token; the tests run without one |
| 6 Offline and reconnect | `reload-offline` (offline buffering, a failed upload) | The developer tools' Offline switch: the tests switch the browser context offline, and they go offline without the Pause and Resume or a coach watching |
| 9 Summary wait, My runs | `archive-sharing`, which waits up to 120 s for the real summary worker | — |
| 10 Manage sharing | `archive-sharing` (after New run and a reload, one panel at a time, a deleted run, a held answer) | — |
| A second tab cannot record | `second-tab` | Not part of the rehearsal |

**Rehearsal results (2026-10-24).** Steps 1–10 and the sign-out were driven twice by a throwaway Playwright script
(not part of the repository), against a real `npm run demo:up` on Windows 11 with no Mapbox token, in headless
Chromium with two isolated browser contexts standing in for two profiles. `demo:up` was ready about 31 s after it
started (no pending migrations). Both passes completed every step:

| Step | Pass 1 | Pass 2 |
|---|---|---|
| 1–2 Sign-in buttons, Coach tab live with the tokenless notice | ok (`GET /api/session` not checked) | ok, runner `…0001`, coach `…0002` |
| 3 Capture `complete` after Start | 10.1 s, "segment 0 · 6 buffered" | 10.1 s, same |
| 5 Coach card after the share was confirmed | 1.9 s, "6 points · rev 6", `confirmed` | 1.9 s, same |
| 6 Offline 1.5 s after Resume, back online after Capture `complete` | 5 pending; coach at "7 points · rev 9" while offline; drained 0.2 s after reconnecting; coach "12 points · rev 10" 1.6 s after | 5 pending; same labels; 0.1 s; 1.5 s |
| 7 Coach card gone after the revoke was confirmed | 1.9 s, run still `recording` | 2.1 s, same |
| 9 Run listed in My runs after Finish | 26.4 s, the "still being processed" notice seen first | 41.8 s, same |
| 10 Manage sharing: Share, Revoke, Close | ok; coach showed no live card | ok, same |
| Script time, browser launch to sign-out | 70.4 s | 84.9 s |

What this does not cover: a person following the steps in two real browser profiles, the DevTools throttling menu
itself (the script used Playwright's `setOffline`, which in Chromium uses the same network emulation as DevTools),
Firefox or any other browser, and the maps with a token. Treat a first pass by hand as a test and report what
differs. The `demo:up` used for this was stopped by ending its process tree rather than with Ctrl+C, which left its
lock file behind, as "Limits" in section 0 describes.

## 1. Create the demo people

```sh
npm run db:up
npm run db:bootstrap
npm run db:migrate
npm run demo:seed
```

`demo:seed` writes one organization, a runner and a coach into the plain `running_tracker` development database
(it refuses any other database, any non-loopback host and any role but the owner) and is safe to repeat. It prints
the identifiers and two lines for `.env`:

```
LOCAL_AUTH_ENABLED=true
LOCAL_AUTH_USER_IDS=dddddddd-dddd-4ddd-8ddd-dddddddd0001,dddddddd-dddd-4ddd-8ddd-dddddddd0002
```

The organization is `dddddddd-dddd-4ddd-8ddd-dddddddd0000`, the runner `…0001`, the coach `…0002`.

## 2. Start the app

Put those two lines in `.env` (`ALLOWED_ORIGINS` stays `http://127.0.0.1:5173`; use that host name in the browser,
not `localhost`) and start both servers. The API reads `.env` at startup, so restart it if it was already running.

```sh
npm run dev
```

A plain `npm run dev` does not show the demo sign-in buttons of section 3. To have them when starting by hand, set
`VITE_LOCAL_DEMO_ENABLED=true` for that command only (PowerShell: `$env:VITE_LOCAL_DEMO_ENABLED='true'; npm run dev`;
other shells: `VITE_LOCAL_DEMO_ENABLED=true npm run dev`), or use the console snippet at the end of section 3.

## 3. Sign in as the coach

Open `http://127.0.0.1:5173`. The page says "Sign in required" and, under it, shows a **Local demo** panel with two
buttons. Press **Demo coach**. Both buttons are disabled until the sign-in has finished; the page then asks the server
for its session exactly as after a reload, and shows the one organization this person belongs to, already selected
(nothing is typed). Open the Coach tab. The stream opens with no runs.

- **Demo runner** and **Demo coach** are the two fixed people `demo:seed` created (`…0001` and `…0002`). There is no
  way to type or choose another identity, and the API accepts only those two.
- The buttons are shown only while nobody is signed in. To change person, press **Sign out** first.
- If the sign-in fails, the panel says why (for example that local sign-in is off on the API, or that the page was
  opened as `localhost`) and the buttons work again for a retry.
- **One browser profile is one person.** Its tabs and windows share the session cookie, so a second tab is the same
  person, and signing in as the other one there changes who both tabs are. For runner and coach side by side, use two
  browser profiles, or an ordinary window and a private (incognito) window.
- The **Sign in** button next to it is the OpenID Connect sign-in. It goes to `/api/auth/login`, which does not
  exist here because OpenID Connect is not configured.

The buttons appear only on a development server started with `VITE_LOCAL_DEMO_ENABLED=true`, which `npm run demo:up`
does. A production build never has them, and the API refuses local sign-in in production regardless.

**Console fallback (optional, for diagnosis).** The buttons do exactly what this does from the browser's developer
console on that page:

```js
await fetch('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: 'dddddddd-dddd-4ddd-8ddd-dddddddd0002' }),
}).then((response) => response.status)   // 201
```

Then reload. The answer's status is the quickest way to tell the causes in the table at the end apart. The session
cookie is `HttpOnly`, so the console cannot read it; that is the point.

## 4. Play the runner

In a terminal:

```sh
npm run demo:run
```

It signs in as the runner, creates a run, shares live and history access with the coach, sends one simulated point
every two seconds (60 points, two minutes; `--points N` changes that), finishes the run and waits for the summary.
Ctrl+C finishes the run early. In the Coach tab, within a poll interval (two seconds):

- the run appears with a position that is first unconfirmed (one point is not an edge) and then confirmed;
- the marker moves around a loop of about 80 m radius near Warsaw;
- when the script finishes the run, it leaves the live state, which is correct: a finished run is no longer live.

The share is what lets the coach see the run: a coach role alone grants nothing (the access suites test this; the
demo does not repeat it).

**The live map (ADR-0065).** With a token, a **Live map** panel sits above the cards. The run's position is a disc
(solid when confirmed, a ring when unconfirmed, small and faded when stale); a run without a usable position is not
drawn. Tick the run under **Track selection** to draw its track as a solid line, broken wherever the server rejected
an edge or a new capture segment began. While a newer revision loads, the older one is dashed and the panel says
"showing older rev N". The camera fits the first thing shown once; after that it stays where you leave it, and
**Fit visible runs** brings everything back into view. Without a token the panel says "Map unavailable" and the rest
of the tab is unchanged. This panel was tested in Chromium (`tests/e2e/coach-map.spec.ts`, one test with the real
runtime but a local empty style); it has not been followed by hand against a real Mapbox basemap.

## 4a. Share from the browser instead (optional)

Press **Demo runner** in a second browser profile or a private window, since one browser profile holds one session
(section 3). Keep the coach in the first. In the Runner tab, start a run with the simulator. The **Share this run with a
coach** panel under the controls lists the organization's active coaches by role and the end of their identifier (no
names exist), here `Coach …dddd0002`.

- **Share** grants live and history access together; the panel says so. The coach's board shows the run within a
  poll interval.
- **Revoke** removes the share. The coach's marker, the run's track option and its selection disappear within a
  poll interval. The run keeps recording; sharing is not a lifecycle command.
- A share made through the API with only one permission is shown as it is ("Live only", "History only"), with
  **Share live and history** to complete it.

The panel only lists and changes shares of your own run; the server checks ownership on every request. It does not
queue anything offline: an action that fails says so and offers Retry. This flow is tested in Chromium by
`tests/e2e/run-sharing.spec.ts`; following these steps by hand in a browser was not part of that change.

After **Finish** and **New run** the panel leaves the Runner tab, but the share stays on the server. Manage it from
**My runs** instead (section 5a).

## 5. Browse the archive

The summary worker runs once a minute (`RUN_SUMMARY_INTERVAL_MS`), so the script reports the summary after up to
about a minute. Then open the Archive tab; it uses the same organization. With a Mapbox token the run's line is drawn
from revision-bound tiles; the view picks up the new archive revision by itself within 30 seconds or on tab focus.
Without a token, the tab shows the token notice and nothing is drawn.

## 5a. Search my runs

The Archive tab has a **My runs** section under the map: a period (this month, previous month or custom dates), a
minimum and maximum distance, kilometres or miles, and a sort. It lists only runs you recorded; the map above can
also show routes other people shared with you, which is why the two can differ. This does not need a Mapbox token.

Fill it with synthetic data (explicit, additive, idempotent; it refuses anything but the local development database
and `APP_ENV=production`):

```sh
npm run demo:seed:search            # the current UTC month, the previous one and the one before
npm run demo:seed:search -- --month 2026-09   # a specific month
```

It writes 67 runs for the demo runner (`…0001`, the **Demo runner** button): 47 of the runner's own in
organization `dddddddd-dddd-4ddd-8ddd-dddddddd1000`, eight by two teammates (four shared with the runner, which the
search must not list), and a second organization `…1001` with the runner's long runs and a stranger's. Sign in with
**Demo runner** (section 3), open Archive and:

1. Look at **My runs** with the defaults (this month, newest first). The browser's time zone is shown.
2. Change the minimum to `5`, the maximum to `15`, the sort to *Longest first* and press **Apply filters**. The
   "Applied filters" block changes only now; editing the fields before pressing the button changes nothing in the list.
3. Press **Load more runs** for the next page. Equal distances stay in a fixed order across the page boundary.
4. Switch units to *Miles* and apply: the same runs, shown in miles; a run of 4999.96 m (shown as 5.00 km) is not in a
   5 km minimum, because the filter compares metres, not what is displayed.
5. Choose the other organization in the picker: the list is cleared and starts from the defaults.

Four of the runner's runs (three of them in the current month) have no current result yet and carry synthetic points.
The notice "… still being processed" counts them; the API's summary worker (about once a minute, only while the API
is running) processes them and they then appear in the list with a distance computed from the synthetic points. They
are never treated as matching a distance filter while they are pending. Seeding the same month again changes
nothing, including those runs after they were processed.

**Describing the search in words (optional).** The box above the filters is off unless the API was started with
`RUN_SEARCH_AI_ENABLED=true`. For a demo without a key, add `RUN_SEARCH_AI_PROVIDER=fake`: a few keyword rules answer
in-process, with no network. Try `Show my runs of at least 5 km from last month, longest first.`, then press
**Apply filters**; try `Runs of more than 5 km last month` to see why a strict bound is explained, not guessed. What
the fake does says nothing about a real model; the real one needs a key and a model name, and its quality is only
measured by the live evaluation. All of it, with the limits and the privacy notes, is in
`docs/runbooks/run-search-ai.md`.

**Sharing a finished run (optional).** Each card in **My runs** has **Manage sharing**. It opens the Runner tab's
sharing panel for that run, inside the card, named by the card's date and the start of the run ID. Only one panel is
open at a time, and **Close** or Escape closes it. The panel works as in section 4a: **Share** grants live and history
access, which for a finished run means its recorded route, distance and duration, and **Revoke** removes it. This is
also where a grant made from the Runner tab is managed after **New run** or a reload. The selected run never becomes
the active run.

Applying another search closes the panel. A run deleted in the meantime shows only the reason and Close. Nothing about
sharing is read until a panel is opened. Tested in Chromium by `tests/e2e/archive-sharing.spec.ts`; these steps were
not followed by hand.

## 6. Sign out

Press **Sign out** in the bar under the title. The page asks the server to end the session, and then shows "Sign in required" with the demo buttons again. Anything the runner had not uploaded stays in this browser for the same person.

The same call from the console, if you prefer:

```js
const { csrf } = await (await fetch('/api/session')).json();
await fetch('/api/session', { method: 'DELETE', headers: { 'x-csrf-token': csrf.token } }).then((r) => r.status) // 204
```

## If something does not work

| Symptom | Likely cause |
|---|---|
| `demo:up` says "Docker engine not reachable" | Docker Desktop (or the Docker service) is not running; start it and wait until it reports running |
| `demo:up` says a port is in use | Another program (often an earlier `npm run dev`) holds 3000 or 5173; stop it yourself, `demo:up` will not |
| `demo:up` says another demo:up is running | One is running in another terminal; use it or press Ctrl+C there. If none is, delete `.local/demo/demo-up.lock` |
| `demo:up` reports a configuration problem | A database URL in the environment or `.env` is not the local `running_tracker` database with its expected role, or `APP_ENV=production` |
| No **Local demo** panel on the signed-out page | The web app was not started by `demo:up` (or with `VITE_LOCAL_DEMO_ENABLED=true`), or it is a production build; a page that is signed in shows no buttons either |
| The demo buttons are disabled with "Press Retry session first" | The last session check got no answer, so the page cannot tell whether someone is signed in; press **Retry session** once the API answers |
| The panel says local sign-in is off (the snippet answers 404) | `LOCAL_AUTH_ENABLED` is not `true`, or the API was not restarted after editing `.env` |
| The panel says the address is not accepted (403 `ORIGIN_DENIED`) | The page was opened as `localhost`; the allowed origin is exactly `http://127.0.0.1:5173` |
| The panel says the identity is not allowed (403 `LOCAL_IDENTITY_DENIED`) | The user ID is not in `LOCAL_AUTH_USER_IDS` |
| The panel says the session check did not confirm the sign-in | The browser did not keep the cookie, typically because the API sends `Secure` cookies over plain http (`SESSION_COOKIE_SECURE` is not `false`); `demo:up` turns that off |
| The other window or tab changed person too | They share one browser profile and so one session cookie; use a second profile or a private window |
| `demo:run` says it cannot reach the API | The API is not running at `http://127.0.0.1:3000` (`--api-url` changes it; only loopback hosts are accepted) |
| `demo:run` answers 403 `ORG_ACCESS_DENIED` | `demo:seed` was not run against the database the API uses |
| The summary is not published within 150 s | The API process is not running its maintenance jobs, or the database is not the one the script's run was written to |
| The Coach tab shows nothing | The coach has no share on the run (the script creates one), or the page shows no organization: `demo:seed` was not run against the database the API uses |
| The Coach map says "The map could not be shown" | The browser has no WebGL, the token is not valid for Mapbox, or the base style could not be loaded; the cards and track picker still work |

## Removing the demo

The demo rows are ordinary rows in the development database. Delete the runs through the API as the runner, or reset
the whole development database (this deletes everything in it, not only the demo):

```sh
docker compose -f infra/compose/docker-compose.yml down -v
```

If you followed sections 1 and 2 by hand, set `LOCAL_AUTH_ENABLED` back to `false` in `.env` when you are done;
`demo:up` never changed it.
