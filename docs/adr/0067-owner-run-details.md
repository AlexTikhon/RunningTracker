# ADR-0067: Owner finished-run review in the Archive

- Status: accepted; implemented, local checks recorded in `docs/progress.md`
- Date: 2026-11-01
- Depends on: ADR-0066 (published archive-track read)
- Scope: web UI, browser adapter/controllers and tests; no API, database, retention or algorithm change

## Decision

My runs offers **View details** for each listed run. The detail view uses the new archive-track endpoint for run
times, distance, observed duration, quality and complete published geometry. It does not reconstruct a track from
raw points or MVT and does not reuse a list card's potentially older metrics as the detail result.

The view presents the units and time zone of the applied search, independent of unapplied draft changes. It shows
that observed duration excludes gaps/rejected intervals and is not moving time. GPS quality starts with accepted
versus recorded measurements (or insufficient data), with the diagnostic counts in an expandable breakdown.
Algorithm/source revision and raw-retention status live under Processing details.

Pending and stale summaries are explicit states with no old route/metrics and a Refresh action. A current summary
with null geometry still displays its statistics and explains the missing usable route. Missing/deleted/access-lost
and too-complex responses display bounded messages without the server/provider's raw text. Transient failure has
Retry; no automatic retry or polling is added. Displayed data is reauthorized on each explicit refresh, not revoked
retroactively when another process changes permission.

## Navigation and lifetime

- ArchiveScreen owns the selected run. Its overview/search subtree stays mounted but hidden during details, so
  Back to My runs preserves the applied filters, unapplied draft, loaded pages and sharing/deletion state.
- The overview map is unmounted while details are open, so two map runtimes are not retained for one Archive.
  Its camera returns to its initial state on Back; map camera persistence is not part of this slice.
- Opening focuses the detail heading; Back restores the originating button when it still exists, or the list
  heading. A run whose deletion confirmation is open or whose DELETE is pending cannot open details.
- The Archive screen is keyed by session generation, identity and organization, matching the Coach boundary.
  The selected detail also carries its scope/session. No detail selection survives those boundaries.
- RunDetailController gives each read an AbortController whose signal also owns the displayed map. Refresh aborts
  that signal and clears the result before asking again. Closing, a scope change or session end aborts it too.
  A result from a replaced/closed read is ignored even if its transport ignores cancellation. A mismatched run ID
  is rejected at the browser adapter and controller boundaries.
- The browser adapter uses the existing body-inclusive request deadline and same-origin credentials, requests
  no-store, and validates the complete runtime contract. This adds local Archive navigation, not URL/deep-link routing.

## Route display

With the existing optional public Mapbox token, the detail view lazily loads the existing runtime and creates one
GeoJSON source/line layer with the complete published MultiLineString. It does not reconnect segments or simplify
again. A new read creates a new map lifetime; listeners and instances are removed on disposal, including factories
that resolve after cancellation. Provider failures never expose their raw error/URL/token to the person.

Camera fitting uses the smallest longitude arc, including an east bound past 180 at the antimeridian. Only camera
latitude is clamped to Web Mercator's limit; stored geometry is unchanged, and a polar track gets an explanation
of the display limit. Initial load fits once; Fit route is the explicit subsequent camera action.

Without a token, no map runtime/provider request is made. Statistics and quality remain usable, and the route
section states that the map is unavailable. Empty geometry does not create a map.

## Validation

Controller/adapter tests cover summary states, refresh, cancellation, late completions, session end, mismatched
responses and typed failures. Map tests cover exact disconnected geometry, antimeridian/polar camera bounds,
load/disposal races and sanitized failures. Browser tests use the real API/test database and exercise navigation,
retained filters/pages/draft/focus, raw-purged history, stale/pending/empty/error states, deletion and session/scope
changes. A fake map checks source content and cleanup; one Chromium real-runtime smoke uses WebGL and a local
empty style with external requests blocked. Viewport screenshots are layout evidence, not physical-phone GPS or
a real provider basemap. Executed results and any failed initial checks are recorded in progress notes.
