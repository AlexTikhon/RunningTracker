# Real-device pilot (D10): AWAITING PHYSICAL RECORDINGS

Status on 2026-10-22: **no real-device input exists.** `.local/gps-traces/raw/` is empty, no sanitized real fixture is
committed, and `docs/reports/d10-real-traces.md` reports 0 traces. Nothing in this file is a measurement. The browser
pilot has not run. D10 stays PARTIAL.

This file has two separate parts, because they test different things:

- **A. GPX replay** tests the server's v1 evaluator on positions recorded by some device and app. A GPX recorded in
  another app says nothing about Running Tracker's own Geolocation capture.
- **B. Browser pilot** tests Running Tracker's own capture, buffering and lifecycle on a real phone.

Method, privacy model and evidence thresholds: `docs/runbooks/gps-traces.md`.

## A. GPX collection checklist (owner)

Record 3 to 5 short recordings (5 to 15 min each, about 1 s sampling if the app allows it):

| # | Intended scenario | `--scenario` | Notes |
|---|---|---|---|
| 1 | Steady run, open sky | `steady_run` | Usual pace |
| 2 | Stops and starts at crossings or lights | `stop_start` | Stand still at least twice |
| 3 | Near buildings or under trees | `gps_noise` | If practical |
| 4 | About 1 min standing still, before or after a run | `stationary` | Can be its own recording |
| 5 | Short underpass or tunnel (optional) | `tunnel_or_signal_gap` | Only if one is on the way |

Before you record:

- Start and stop **a few hundred metres away from home, work and any other place you would not want a route to point
  to**. Sanitizing removes the absolute position and the clock time, but it keeps the shape of the route, its
  orientation, its stops and its pace. A fixture is "not obviously identifying". It is not anonymous.
- If you can, use two different devices or apps. Concluding anything about v2 needs at least 5 traces, 3 scenarios
  and 2 devices or apps, and even that is not proof of accuracy.

Each GPX file must contain:

- one `<trk>` with **one** `<trkseg>`;
- `lat` and `lon` on every `<trkpt>`;
- a `<time>` on every point, with a timezone (`Z` or `+hh:mm`), strictly increasing, with no duplicates;
- if possible, a horizontal accuracy in metres in an extension element named `accuracy`, `hacc` or
  `horizontalAccuracy`. HDOP does not count.

The tool rejects a file that breaks any of these and does not repair it. Export FIT files to GPX first. If accuracy is
missing, replay assumes 5 m for every point, and the accuracy table and accuracy rejections in the report are then
meaningless.

What to hand over:

1. Put the files in `.local/gps-traces/raw/` (git ignores the whole `.local/` directory). Rename them first to neutral
   names such as `t1.gpx`, because the original export name can contain a date or a place.
2. For each file, write a short note: the intended scenario, the device class (for example "Android phone, mid-range"),
   the recording app category, whether the phone was in a hand, pocket or armband, and whether it has accuracy.
   Do not include a place, a date or a serial number.
3. A reference distance only if it was measured independently (a marked track, a measuring wheel), with that method
   stated.

Commands once files exist (fixtures and the report are written by these commands, never by hand):

```powershell
npm run gps:sanitize -- .local/gps-traces/raw/t1.gpx --scenario steady_run --output apps/api/test/fixtures/gps-traces/steady_run_01.trace.json
npm run gps:analyze -- apps/api/test/fixtures/gps-traces/steady_run_01.trace.json
npm run gps:report                                # replays on the guarded _test database, rolls back
npm run gps:report -- --check
npm test --workspace=@running-tracker/api -- src/gps-traces
npm run test:integration --workspace=@running-tracker/api -- test/gps-trace-analysis.integration.test.ts test/gps-trace-report.integration.test.ts
```

## B. Browser pilot checklist (owner's phone)

### Prerequisites (currently not met)

- **Secure origin.** A browser gives Geolocation only to a secure context: HTTPS, or `localhost`/`127.0.0.1` on the
  device itself. The dev server listens on `127.0.0.1:5173` over plain HTTP. The TLS transport profile listens on
  `127.0.0.1:8443` with a certificate for `localhost`. Neither is reachable from a phone without exposing the
  server or trusting a certificate, and this pilot does neither.
  - A possible route on Android that has **not been verified**: with USB debugging enabled,
    `adb reverse tcp:5173 tcp:5173` makes the phone's own `http://127.0.0.1:5173` reach the PC. That address is a
    secure context, and it is the exact `ALLOWED_ORIGINS` value. Chrome remote debugging (`chrome://inspect`) gives
    the console that sign-in needs. `adb` is not installed on this machine. The phone stays on a cable, so this
    checks capture and recovery near the desk, not a run outdoors.
  - On iPhone, there is no route without a trusted HTTPS origin, which this pilot does not set up.
- **Sign-in.** No OpenID Connect provider exists. Sign in with the development session from `docs/runbooks/demo.md`
  step 3 as the demo runner (`…0001`). That snippet needs a console on the phone.
- **Coach view.** Since ADR-0063 the Runner tab can share the run with a coach: Share grants live and history
  access, and Revoke removes it (demo.md step 4a). The coach watches from a desktop browser signed in as the demo coach.
  This has been tested in Chromium on a desktop, not on a phone.
- **Map.** The Archive map needs `VITE_MAPBOX_ACCESS_TOKEN`. Without the token, record "map not tested". Search
  (My runs) does not need the token.

### Steps

1. Runner tab, choose **Device GPS**, start a run, and allow location access. Pass: the point count increases and
   capture health shows a live fix.
2. Lose location temporarily (cover the phone, go indoors, or switch location off briefly). Pass: the run shows
   "waiting for location" and does not stop or end, and recording continues on the next fix without Pause/Resume.
   If the location permission is denied, Retry GPS is offered.
3. Go offline while recording. Over USB, run `adb reverse --remove tcp:5173`; airplane mode does not cut the USB link.
   Pass: points keep being counted and wait locally. Restore the link. Pass: the buffered points upload, with no gap
   and no duplicate.
4. **Finish** the run. Pass: within about a minute the run gets a summary, and Archive > My runs lists it with a
   distance.
5. Coach view, desktop browser. While the phone records, press **Share** for the coach in the phone's Runner tab.
   Pass: the coach's board shows the run, and its position is first unconfirmed, then confirmed. Then press
   **Revoke**. Pass: the marker, the track option and the selection disappear, and the phone keeps recording.

### Evidence table

Record categories only: no place, route, account, device name or serial number.

| Step | Device / browser category | Result | Observed defect |
|---|---|---|---|
| 1 Foreground recording | - | not run | - |
| 2 Location loss and recovery | - | not run | - |
| 3 Offline buffering and reconnect | - | not run | - |
| 4 Finish, summary, search, archive | - | not run | - |
| 5 Share, coach view, Revoke | - | not run | - |

## Synthetic regression results (not real-device evidence)

These were run on 2026-10-22 at `ea0c41a` and use only the synthetic test traces:

- `npm test --workspace=@running-tracker/api -- src/gps-traces`: 11 files, 119 tests passed (privacy, GPX parsing,
  sanitizer, schema, statistics, report rendering).
- `npm run test:integration --workspace=@running-tracker/api -- test/gps-trace-analysis.integration.test.ts test/gps-trace-report.integration.test.ts`:
  2 files, 20 tests passed. These replay synthetic traces through the production SQL on the `_test` database.
- `npm run gps:report -- --check`: the report is current (0 traces).
- `git check-ignore -v .local/gps-traces/raw/probe.gpx`: ignored by `.gitignore:12` (`.local/`).
