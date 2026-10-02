# Runbook: the local demo

Audience: anyone who wants to see the system work on one machine, and to know exactly what that does and does not
show. Related: `README.md` (setup), `docs/runbooks/identity-provider.md` (real sign-in).

The demo walks one story: a runner records a run, a coach watches it live, the run is finished and summarized, and
it appears in the archive. It needs Docker, the repository set up as in the README's "Start from a clean checkout",
and about five minutes.

## What this demo is not

- **Sign-in is the development session, not OpenID Connect.** No real identity provider exists for this project, so
  the demo signs in with `POST /api/session` (local auth, development only, rejected in production). The OpenID
  Connect flow is exercised against an in-process test provider by `npm run test:integration` (the
  `oidc-login` suite) and its production surface by `npm run deploy:verify`; neither is a real provider.
- **The runner is a script, not the browser.** `npm run demo:run` plays the runner over HTTP with a simulated route.
  The Runner tab of the web app can record with its own 6-point simulator, but it has no control for sharing a run
  with a coach, so a coach would see nothing from it.
- **The map needs a Mapbox token.** Without `VITE_MAPBOX_ACCESS_TOKEN` the Archive tab shows a notice instead of a
  map. The token is public by design; never put a server secret there.
- Nothing here is a performance or recovery claim.

## What was run, and what was not

When this runbook was written, steps 1, 3 (the script) and 4 were executed against a real API and PostgreSQL: the
seed, the sign-in through the Vite proxy, a scripted run shared with the coach, the coach's live stream (positions
`unconfirmed` for the first point, then `confirmed`, and the run leaving the live state when finished), the summary
being published, and a non-empty vector tile for the run. **The browser steps (the sign-in snippet, the Coach and
Archive tabs) were not exercised in a browser.** Treat their first run as a test and report what differs.

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

## 3. Sign in as the coach

Open `http://127.0.0.1:5173`. The page says "Sign in required"; its Sign in button goes to `/api/auth/login`, which
does not exist here because OpenID Connect is not configured. Instead, open the browser's developer console on that
page and run:

```js
await fetch('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: 'dddddddd-dddd-4ddd-8ddd-dddddddd0002' }),
}).then((response) => response.status)   // 201
```

Reload. Open the Coach tab and enter the organization ID. The stream opens with no runs. The session cookie is
`HttpOnly`, so the console cannot read it; that is the point.

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

## 5. Browse the archive

The summary worker runs once a minute (`RUN_SUMMARY_INTERVAL_MS`), so the script reports the summary after up to
about a minute. Then open the Archive tab with the same organization ID. With a Mapbox token the run's line is drawn
from revision-bound tiles; the view picks up the new archive revision by itself within 30 seconds or on tab focus.
Without a token, the tab shows the token notice and nothing is drawn.

## 6. Sign out

```js
const { csrf } = await (await fetch('/api/session')).json();
await fetch('/api/session', { method: 'DELETE', headers: { 'x-csrf-token': csrf.token } }).then((r) => r.status) // 204
```

## If something does not work

| Symptom | Likely cause |
|---|---|
| Sign-in snippet answers 404 | `LOCAL_AUTH_ENABLED` is not `true`, or the API was not restarted after editing `.env` |
| Sign-in snippet answers 403 `ORIGIN_DENIED` | The page was opened as `localhost`; the allowed origin is exactly `http://127.0.0.1:5173` |
| Sign-in snippet answers 403 `LOCAL_IDENTITY_DENIED` | The user ID is not in `LOCAL_AUTH_USER_IDS` |
| `demo:run` says it cannot reach the API | The API is not running at `http://127.0.0.1:3000` (`--api-url` changes it; only loopback hosts are accepted) |
| `demo:run` answers 403 `ORG_ACCESS_DENIED` | `demo:seed` was not run against the database the API uses |
| The summary is not published within 150 s | The API process is not running its maintenance jobs, or the database is not the one the script's run was written to |
| The Coach tab shows nothing | The organization ID is wrong, or the coach has no share on the run (the script creates one) |

## Removing the demo

The demo rows are ordinary rows in the development database. Delete the runs through the API as the runner, or reset
the whole development database (this deletes everything in it, not only the demo):

```sh
docker compose -f infra/compose/docker-compose.yml down -v
```

Set `LOCAL_AUTH_ENABLED` back to `false` in `.env` when you are done.
