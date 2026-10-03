# Runbook: real GPS traces for D10 (collect, sanitize, replay, report)

Audience: the person who records the traces and decides, later, whether the GPS algorithm needs a second version.
Related: `docs/reports/d10-gps-tolerances.md` (synthetic measurements), `docs/reports/d10-real-traces.md` (generated
from the traces), `apps/api/test/fixtures/gps-traces/README.md`.

## What this is for, and what it is not

The tooling answers one question: **what would the current Running Tracker implementation (algorithm `v1`) do with a
trace recorded by a real device?** It replays a trace through the production code and reports what came out. It does
not tune anything. The speed rule, the accuracy cutoff, the gap limit, the canonical distance and the 5 m display
simplification are untouched, and the algorithm version is still `v1`.

Replay uses the production pieces rather than a copy of them:

| Step | Production code used |
|---|---|
| Point validation | `pointInputSchema` from `@running-tracker/contracts` |
| Writing points | `insertPointsSql`, the statement the ingestion route runs |
| Per-edge verdict and reason | `app_private.evaluate_track_edge` |
| Canonical distance, accepted chains | `app_private.calculate_run_summary` |
| Display line | `app_private.simplify_display_geometry` |

The replay runs in a transaction on the `_test` database that is always rolled back. The connection comes from
`loadIntegrationTestConfiguration`, which refuses any database whose name does not end in `_test`, so development and
production data are never touched. The per-edge query only wires `evaluate_track_edge` the way `calculate_run_summary`
does; the report checks its totals against the production summary and prints `DISAGREES` if they differ.

## Privacy model

A raw GPS recording shows where a person lives, works and trains, when, and on which route.

**Raw files** (GPX exports) are private local input.

- They live in `.local/gps-traces/raw/`, which `.gitignore` excludes (`.local/`), and raw GPS extensions (`.gpx`,
  `.tcx`, `.fit`, `.kml`, `.kmz`, in any letter case) are ignored anywhere in the repository as a second layer.
- A test (`apps/api/src/gps-traces/privacy.spec.ts`) asks git whether those paths are ignored and fails if the
  repository tracks a raw GPS file or anything under `.local/`.
- Do not paste raw coordinates into issues, logs, commits or documentation. The tools never print them: error
  messages name a point number and a field, not a value.

**Sanitized fixtures** (`*.trace.json`) are what is committed.

- Position becomes east/north metres from the **first fix** of the trace (a geodesic azimuthal-equidistant frame on
  WGS84). The first point is therefore (0, 0) and the real origin is stored nowhere.
- Time becomes milliseconds since the first fix. No date, no time of day.
- Names, device, creator, serial, waypoints, elevation and the original file name are never read into the fixture.
- Metres are rounded to 1 mm, accuracy to 0.01 m.
- Replay places the metric shape around a fixed synthetic anchor (50.000 N, 10.000 E) at a fixed epoch
  (2000-01-01 UTC). Neither is anyone's location or time.

**What the sanitizer guarantees:** the fixture contains no original latitude or longitude, no absolute timestamp and
no device or owner metadata, and strict runtime validation rejects any field outside the schema. Segment lengths,
point order, elapsed time and so derived speeds survive to within about 2 mm per segment.

**What it does not guarantee.** This is removal of the location and the clock, not anonymity.

- The **shape of the route, its orientation to north, its stops and its pace are kept**. Someone with a map and the
  fixture could try to match a distinctive route to a street network. Treat a fixture as "not obviously identifying",
  not as mathematically anonymous.
- A trace that starts or ends at a home, a workplace or another sensitive address still has that start and end *shape*.
  Start and stop recording away from such places (below); the sanitizer cannot do that for you.
- Several fixtures from the same person can be correlated with each other.
- The scan in `privacy-scan.ts` is a heuristic safety net, not a proof.

## Workflow

```powershell
# 1. export a GPX from the phone or watch and move it into the private directory
New-Item -ItemType Directory -Force .local/gps-traces/raw
Move-Item ~/Downloads/<export>.gpx .local/gps-traces/raw/

# 2. sanitize (prints counts and timing only, never coordinates)
npm run gps:sanitize -- .local/gps-traces/raw/<export>.gpx --scenario steady_run --output apps/api/test/fixtures/gps-traces/steady_run_01.trace.json

# 3. look at the fixture: it must contain only elapsedMs, xM, yM and accuracyM
# 4. analyze one fixture
npm run gps:analyze -- apps/api/test/fixtures/gps-traces/steady_run_01.trace.json

# 5. regenerate the aggregate report for every committed fixture (needs the _test database: npm run db:up, db:bootstrap:test, db:migrate:test)
npm run gps:report

# 6. run the privacy checks and the rest of the suite
npm test; npm run test:integration

# 7. stage the fixture and the report only, and read the staged file list before committing
git add apps/api/test/fixtures/gps-traces/steady_run_01.trace.json docs/reports/d10-real-traces.md
git status --short
```

Notes:

- `gps:sanitize` refuses to overwrite a fixture without `--force`, refuses to write into the raw directory, and
  accepts only neutral file names (`^[a-z0-9][a-z0-9_-]*\.trace\.json$`). Use `steady_run_01`, not a person or a place.
- Scenarios: `steady_run`, `city_run`, `stop_start`, `gps_noise`, `tunnel_or_signal_gap`, `stationary`. Choose the
  one you *intended to record*; it is never inferred from the location.
- `--reference-distance-m <metres>` is optional: use it only for an independently measured length (a marked track, a
  measuring wheel). The report then shows both distances against it, and still does not call either ground truth.
- Relative paths are resolved from the directory you ran `npm` in, not from `apps/api`.
- `gps:report --check` fails when `docs/reports/d10-real-traces.md` is out of date; an integration test does the same
  on every `npm run test:integration`. `gps:report --stdout` prints instead of writing.

## Input formats

- **GPX** (1.0 and 1.1) is supported: one `<trk>` with **one** `<trkseg>`, every `<trkpt>` with `lat`, `lon` and a
  `<time>` that carries a timezone (`Z` or `+hh:mm`). Horizontal accuracy in metres is read from an extension
  element named `accuracy`, `hacc` or `horizontalAccuracy` (any namespace prefix). HDOP is not metres and is ignored.
- **FIT, TCX, KML, GeoJSON, CSV: not read.** Export FIT to GPX first, with the device vendor's export or a
  converter you trust. The tool does not parse binary FIT.
- Rejected, with an actionable message and no repair: no track points, fewer than two points, several segments, a
  missing or unparsable time, a time without a timezone, duplicate timestamps, time that goes backwards, latitude
  outside -90..90, longitude outside -180..180, exactly 0, 0, non-numeric coordinates, accuracy on some points only,
  DTDs and entity declarations. Fix the export or trim the file; do not expect the tool to guess.
- A fixture holds at most 10 000 points and stays within 50 km of its first point; longer recordings must be split.

**Accuracy matters.** The product stores an accuracy with every point (the browser's Geolocation reports one). Many
GPX exports omit it. Open the file in a text editor and search for `accuracy`: if it is absent, the fixture has no
accuracy, replay assumes 5 m for every point, and the report says so. Rejections by accuracy and the accuracy table
are then not meaningful. Prefer a source that writes it.

## How to record the first traces

Prefer **3 to 5 short recordings of 5 to 15 minutes** to one long one. A sampling interval of about 1 s is
the most useful (the synthetic tests used 2 s); note the device and the app, because device class matters for any
later decision.

1. A **normal steady outdoor run** in open sky (`steady_run`). Run at your usual pace.
2. A **stop/start route with traffic lights or crossings** (`stop_start` or `city_run`).
3. A route **near buildings or under trees** where the signal is weaker (`gps_noise`).
4. A **short stationary period** before or after running: stand still for about a minute with the recording on
   (`stationary`, or include it in one of the runs).
5. Optionally, a route with a **temporary GPS gap** (`tunnel_or_signal_gap`), such as a short underpass or a tunnel.

You do **not** need a home-to-home route, and you should not use one. Start and stop recording away from your home,
your workplace and anywhere else you would not want a route to point to: begin a few hundred metres from them and stop
before you reach them. The sanitizer removes the location regardless, but collection hygiene is another layer.

Check each file before sanitizing: one track, one segment, a time on every point.

## Reading the report

The report is descriptive. Its signals (isolated and paired excessive-speed edges, gaps, large accuracy, repeated
coordinates, the jitter ratio, the rejection rate per accuracy bucket) say *what is in the data*; none of them says the
algorithm is wrong. Two distances are shown side by side, the **raw observed polyline** and the **canonical accepted
distance**, and neither is ground truth: a phone's polyline is a noisy measurement.

### Evidence thresholds (not verdicts)

These say how much evidence a statement needs before it is worth making. They are about the *sample*, and they do not
decide the algorithm. The numeric triggers are rules of thumb, chosen only to prompt a closer look; they were not
derived from data and may be revised once traces exist.

| Question | Where to look | What counts as a signal worth following up | What you can say with little data |
|---|---|---|---|
| Does normal running hit the 12 m/s cutoff through GPS spikes? | `excessive_speed` count and runs in `steady_run`, `city_run` traces | Any `excessive_speed` edge in a normal-run trace is worth looking at; a pair is the out-and-back spike signature | "Not observed in N traces", never "cannot happen" |
| How often are edges rejected? | rejected share per trace and pooled | More than about 5 % of edges rejected in a normal-run trace | The share for these N traces on this device |
| Does rejection remove noise or real movement? | accuracy buckets, max speed of accepted edges, speed of rejected edges | Rejected edges below about 15 m/s on a running trace, or rejections in the best accuracy bucket | Cases, not a rate |
| How much does GPS noise inflate raw distance? | jitter ratio, canonical vs raw | Jitter ratio clearly above 1.1, or canonical within a few percent of raw while the jitter ratio is high | One trace's ratio |
| Does the canonical distance reduce that inflation? | canonical vs raw, and vs a reference distance if there is one | Only comparable when an independent reference distance exists | Nothing about truth without a reference |
| How do long gaps behave? | gap count, `excessive_time_gap`, chain count | A gap that splits a chain whose two halves are clearly the same run | Behaviour on the gaps that occurred |
| Does reported accuracy relate to bad edges? | accuracy table | Rejections concentrated above about 10 m, or none anywhere | Needs a source that reports accuracy |
| Is the 5 m display line reasonable on real paths? | max display deviation | Any value above the 5 m tolerance would be a defect to report; values below it are expected | Geometric closeness to the accepted fixes, not visual quality |
| Do per-edge verdicts agree with the production summary? | the consistency line | Any `DISAGREES` is a tooling defect: stop and report it | - |

Minimum before concluding anything about algorithm `v2`: at least **5 traces** covering at least **3 scenarios** and
at least **2 devices or apps**, and state the count with every number. Below that, record the observation and keep
collecting. One or two traces cannot show that 12 m/s is right, or that smoothing is needed.

## Limits of this tooling

- Replay anchors every trace at one synthetic place and time, so it says nothing about behaviour elsewhere on the
  globe; the worldwide behaviour is covered by the synthetic test in `docs/reports/d10-gps-tolerances.md`.
- A fixture is one continuous segment; pauses recorded as separate segments are not modelled.
- The jitter ratio is a diagnostic: the path length at full rate divided by the length of the track sampled about every
  10 s. It is not a smoother and changes nothing.
- No real-device trace is committed unless `docs/reports/d10-real-traces.md` lists it.
