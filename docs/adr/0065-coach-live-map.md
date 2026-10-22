# ADR-0065: The coach's live state on a map

- Status: accepted; implemented and verified locally (web unit, Chromium with a fake map runtime, one Chromium
  smoke with the installed Mapbox runtime and no provider)
- Date: 2026-10-22
- Amends: ADR-0024 §5 and ADR-0025 (the board now also has a map); ADR-0031 is unchanged
- Scope: the web app and the browser suite. No route, contract, stream, migration, RLS or dependency change.

## Context

The Coach tab already receives the authorized `live.state` (ADR-0024) and synchronizes explicitly selected tracks
to complete, revision-bound snapshots (ADR-0025). It showed them as position cards and point counts. Mapbox GL JS
3.31.0 and its lazy loader exist for the Archive (ADR-0031), behind the optional public `VITE_MAPBOX_ACCESS_TOKEN`.

## Decision

1. **Geometry is a pure function of what is authorized.** `coachMapGeometry` (`coach-map-geometry.ts`) reads the
   reducer state and the synchronizer's snapshots and nothing else:
   - Markers come only from `markerForRun`, so confirmed, unconfirmed, stale and unavailable mean what they mean
     on the cards. An unavailable run has no point. A retained last-known position is drawn only as `stale`.
   - A track is drawn only for a run in the current full state **and** in the explicit selection, and only from a
     committed snapshot of the announced algorithm version. A snapshot still being assembled draws nothing.
   - Older committed geometry kept during a refresh or after a failed one is drawn dashed and dimmed, and the
     map's track list says "showing older rev N"; only a finished synchronization at the announced revision is
     "latest".
2. **Lines follow the server's edges exactly.** Points are ordered by `BigInt(seq)`. A point continues the line
   only if `connectFromPrevious` is true, `predecessorSeq` equals the previous point's `seq` in that snapshot, and
   both share a `segmentId`. Otherwise a new line starts; a point that no edge touches is drawn as a small dot.
   A sequence gap alone never breaks a server-accepted edge. The geometry is recomputed from the whole snapshot
   on every update, so a late upsert that rejects or moves an edge replaces the old line.
3. **One map per session, person and organization.** `App` keys `CoachScreen` by a per-session generation, the
   user and the organization, and passes `session.signal`. `CoachMapController` (`coach-map-source.ts`) owns one
   map through an injected factory (`CoachMapPort`). The real `mapboxgl.Map` fits that port structurally; the
   hand-written runtime types gained the six methods it uses, with no `any`.
   - The controller keeps only the latest geometry and applies it when the map reports `load`.
   - Disposal, an abort of the session signal, or unmount aborts the factory. A map that arrives afterwards is
     removed at once and never drawn on (React StrictMode included).
   - If an update cannot be applied, the map is removed instead of being left with old geometry.
4. **Updates replace sources.** Two GeoJSON sources (markers, tracks) and four layers are added once. Each update
   calls `setData` with the complete collection; an unchanged collection is skipped, so the one-second freshness
   tick does not churn the map. A committed snapshot's geometry is computed once (a `WeakMap` on the snapshot
   object), and the track source is compared by a key of run, algorithm, revision and "latest" rather than by
   serializing up to 50,000 points per run.
5. **The camera moves only twice by itself.** One fit when there is first something to show; afterwards only the
   **Fit visible runs** button. No following, clustering, animation or editing.
6. **Quality is more than colour.** Confirmed is a solid disc, unconfirmed a ring, stale a small faded disc; a
   latest track is a solid line, an older one a dashed line. A legend says this in words. A text summary counts
   the positions by quality, and the cards remain the accessible list of every run.
7. **Tokenless and failure paths.** Without a token the panel says "Map unavailable. Positions and tracks are
   listed below." and no map code is imported. A runtime, WebGL or style failure shows "The map could not be
   shown. …"; a later base-map error shows "Part of the base map could not be loaded.". Provider messages, URLs,
   tokens and coordinates are never shown or logged. The Archive map is unchanged; it only reads the same style
   constant from `mapbox-runtime.js`.

## Consequences

- Revocation, deselection, a lost stream, a contract error, another organization or person, and the end or
  replacement of the session remove the matching geometry, because they already change the state or the scope
  that the geometry is computed from.
- Recovery after a lost stream still needs a fresh full state and a fresh snapshot (ADR-0025).
- The bounds ignore the antimeridian: a run crossing it would be fitted the long way round.
- With a token, the base map comes from Mapbox. No provider basemap was exercised in this change.

## Verification

- Unit: 18 geometry tests (connections, rejected edge, segment restart, missing and mismatched predecessor,
  sequences past `Number.MAX_SAFE_INTEGER`, empty and single-point tracks, late updates, the authorized boundary,
  freshness, the per-snapshot cache and key) and 16 controller tests with a fake port (replacement, revocation, deselection, late initialization,
  disposal and session abort, StrictMode remount, stable instance and camera, failures).
- Chromium `coach-map.spec.ts`: the tokenless fallback with no map request; a fake runtime served in place of the
  `mapbox-gl` module for share → marker → select → line → deselect → revoke; a dropped stream, its recovery and
  sign-out. A separate Vite server on port 5275 has a placeholder token.
- One smoke loads the real `mapbox-gl` in Chromium with WebGL. The style request is answered in the browser with
  an empty local style. The runtime's telemetry and map-session requests are aborted in the browser. It draws the
  marker and the line with no map error. This is not evidence for a provider basemap or for any other browser.
