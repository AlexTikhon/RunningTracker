# D10 - measured GPS tolerances of the v1 edge evaluator and display simplifier

Date: 2026-10-03. Test: `apps/api/test/gps-tolerance.integration.test.ts` (run with `npm run test:integration --workspace=@running-tracker/api -- gps-tolerance`; set `D10_REPORT_JSON=<path>` to write the raw measurements). The tables below are generated from that output.

## What this is, and what it is not

The test sends **synthetic** runs through the real SQL functions `app_private.evaluate_track_edge` and `app_private.simplify_display_geometry` (algorithm `v1`) on the local PostGIS test database. A runner moves on a circular loop of 150 m radius at a constant speed, sampled every 2 s (157 edges at 3 m/s), with seeded Gaussian position noise of standard deviation sigma on each axis. The reported accuracy is `max(3, 1.5 * sigma)` m. Eleven sites are used, from the equator to 89.5 degrees north and 78 degrees south, plus two antimeridian sites.

**This is not real-world validation.** The noise is independent between fixes (white). Real receivers produce correlated error: slow drift, multipath near buildings, jumps, and gaps in tunnels. White noise inflates the distance between consecutive fixes more than correlated error does, and hides drift entirely. No recorded trace, no urban canyon, no tunnel gap and no phone model was measured. D10 therefore stays **PARTIAL**: the algorithms' behaviour on a known truth is measured; their behaviour on real traces is not.

## Results at running pace (3 m/s), eleven sites

| noise sigma (m) | reported accuracy (m) | edges accepted (%) | accepted chains | vertices: recorded, then displayed (median) | display line vs recorded points, worst (m) | display line vs true loop, worst per site (m) | summary distance vs true (%) | display length vs true (%) |
|---|---|---|---|---|---|---|---|---|
| 0 | 3 | 100 | 1 | 158, 17 | 3.00 | 0.4 to 1.5 | 100 | 99 |
| 3 | 4.5 | 100 | 1 | 158, 45 | 4.99 | 7.5 to 9.8 | 120 to 134 | 108 to 119 |
| 8 | 12 | 83 to 90 | 15 to 22 | 155, 118 | 5.00 | 17.9 to 29.6 | 174 to 202 | 158 to 195 |
| 15 | 22.5 | 38 to 55 | 29 to 40 | 105, 95 | 4.94 | 26.6 to 38.0 | 92 to 137 | 90 to 135 |
| 20 | 30 | 20 to 36 | 23 to 36 | 74, 69 | 4.55 | 33.6 to 69.0 | 51 to 97 | 51 to 97 |
| 25 | 37.5 | 0 | 0 | - | - | - | - | - |

Per site (the same figures at the extremes of latitude and at the antimeridian):

| site | latitude | longitude | sigma 0: display vs recorded (m) | sigma 3: display vs recorded (m) | sigma 8: edges accepted | sigma 15: edges accepted |
|---|---|---|---|---|---|---|
| Quito (equator) | -0.18 | -78.47 | 2.99 | 4.93 | 137/157 | 74/157 |
| Singapore | 1.35 | 103.82 | 2.99 | 4.98 | 133/157 | 61/157 |
| Cape Town (south) | -33.92 | 18.42 | 3.00 | 4.99 | 141/157 | 87/157 |
| Greenwich (prime meridian) | 51.48 | 0 | 3.00 | 4.98 | 137/157 | 71/157 |
| Warsaw | 52.23 | 21.01 | 3.00 | 4.88 | 137/157 | 67/157 |
| Tromso (70N) | 69.65 | 18.96 | 3.00 | 4.93 | 130/157 | 71/157 |
| Longyearbyen (78N) | 78.22 | 15.65 | 3.00 | 4.88 | 133/157 | 76/157 |
| Near the North Pole (89.5N) | 89.5 | 0 | 3.00 | 4.83 | 135/157 | 64/157 |
| McMurdo (78S) | -77.85 | 166.67 | 3.00 | 4.98 | 137/157 | 70/157 |
| Antimeridian (Fiji) | -16.8 | 179.999 | 2.99 | 4.87 | 133/157 | 70/157 |
| Antimeridian (Chukotka, 65N) | 64.8 | -179.999 | 3.00 | 4.99 | 136/157 | 59/157 |

Speed rule, noiseless loop at the Warsaw site:

| speed | edges accepted | rejections |
|---|---|---|
| 11 m/s (39.6 km/h) | 42/42 | {} |
| 13 m/s (46.8 km/h) | 0/36 | {"excessive_speed":36} |

## Findings

1. **The 5 m display tolerance holds worldwide.** The worst distance from any recorded point to the simplified line over all runs was 4.998 m, including 89.5 degrees north, 78 degrees south and both antimeridian sites; the result does not depend on latitude. On a clean circle the simplifier keeps 17 to 21 of 158 vertices, so the line deviates from the recorded points by up to about 3 m.
2. **The simplifier does not remove noise above its tolerance.** It guarantees 5 m against what was *recorded*, not against the truth. With sigma = 3 m the display line is up to about 10 m from the true loop, with sigma = 8 m up to 18-30 m. Treat the display line's error as the receiver's error plus up to 5 m.
3. **Edges are rejected by speed long before the 30 m accuracy cutoff.** At sigma = 8 m (12 m reported accuracy) 10-17% of edges fail the 12 m/s rule. At sigma = 15 m (22.5 m reported, inside the cutoff) 45-62% fail it, and the track is fragmented into dozens of short chains. At sigma = 20 m (30 m reported, exactly at the cutoff) 64-80% fail. At sigma = 25 m (37.5 m reported) every edge is rejected as `poor_accuracy`. In practice the usable limit is a reported accuracy of roughly 12 m or better.
4. **The run distance is overstated with noise and understated when edges are rejected.** The summary distance is the sum of the unsimplified accepted edges (migration 0009), so every metre of jitter counts. With white noise of 3 m the distance is 120-134% of the truth, with 8 m 174-202%. At 20 m so many edges are rejected that it falls to 51-97%. The inflation is an upper bound for correlated real-world noise, but it shows that the reported distance is only trustworthy for a clean signal. The displayed line, by contrast, is smoothed (108-119% at 3 m).
5. **The speed rule is a runner's model.** 11 m/s (39.6 km/h) is accepted; 13 m/s (46.8 km/h) is rejected on every edge, so a downhill cyclist or a vehicle produces an empty track.
6. **Nothing here depends on position on the globe.** The antimeridian and polar sites behave like the rest: coordinates stay valid and no edge is lost to the crossing.

## What this changes, and what it does not

No algorithm or SQL was changed. Findings 3 and 4 are properties of `v1` as designed (a 12 m/s cap on raw edges and a distance summed over raw accepted edges). Improving them would be a new algorithm version (`v2`), for example smoothing before the speed test or a distance taken from a filtered track. That needs real recorded traces to tune and to prove it does not make things worse, so it is recommended only after such traces exist.

The test asserts these limits with margin (see `documented limits` in the file), so a change of algorithm version that moves them fails the test and must be re-measured.

## Still open for D10

- Recorded traces from real devices (walking, running, cycling), under trees and between buildings, with their reported accuracy. The privacy-safe workflow to sanitize and replay them through the same SQL now exists (`docs/runbooks/gps-traces.md`; results will appear in `docs/reports/d10-real-traces.md`); as of this writing no real trace has been collected, so this item is still open.
- Tunnel and signal-loss behaviour: gaps longer than 10 s are rejected by rule (`excessive_time_gap`), but no realistic gap pattern was measured.
- Other device classes: wearables report different accuracy and rate (1 s, 5 s intervals); only a 2 s interval was measured.
- A decision whether runs faster than 12 m/s are a supported use case.
