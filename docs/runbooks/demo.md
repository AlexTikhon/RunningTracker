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
  The Runner tab of the web app can also record (Device GPS or its simulator) and share the run with a coach
  (step 4a, ADR-0063); the script is still the shortest way to show the coach view.
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

Reload. The page shows the one organization this person belongs to, already selected (nothing is typed). Open the Coach tab. The stream opens with no runs. The session cookie is
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

## 4a. Share from the browser instead (optional)

Sign in as the runner (step 3 with `…0001`) in a second browser or a private window, since one browser profile holds one
session. Keep the coach in the first. In the Runner tab, start a run with the simulator. The **Share this run with a
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

It writes 67 runs for the demo runner (`…0001`, the same person you signed in as in step 3): 47 of the runner's own in
organization `dddddddd-dddd-4ddd-8ddd-dddddddd1000`, eight by two teammates (four shared with the runner, which the
search must not list), and a second organization `…1001` with the runner's long runs and a stranger's. Sign in as the
runner (step 3 with `…0001`), open Archive and:

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

Press **Sign out** in the bar under the title. The page asks the server to end the session, and then shows "Sign in required". Anything the runner had not uploaded stays in this browser for the same person.

The same call from the console, if you prefer:

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
| The Coach tab shows nothing | The coach has no share on the run (the script creates one), or the page shows no organization: `demo:seed` was not run against the database the API uses |

## Removing the demo

The demo rows are ordinary rows in the development database. Delete the runs through the API as the runner, or reset
the whole development database (this deletes everything in it, not only the demo):

```sh
docker compose -f infra/compose/docker-compose.yml down -v
```

Set `LOCAL_AUTH_ENABLED` back to `false` in `.env` when you are done.
