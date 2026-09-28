# ADR-0024: Coach live state and marker freshness

- Status: accepted; P08.3 implemented and locally verified
- Date: 2026-09-27
- Scope: P08.3 only

## Context

The SSE payload is a complete authorization-filtered state, but its position
quality describes the latest edge rather than whether the measurement is still
fresh in the browser. The coach screen also needs a last-known marker for GPS
loss without presenting it as current, and it must not retain coordinates or
track selection after a run disappears from an authorized full state.

Track geometry already has an atomic revision-bound store from P07.5. Loading
and coalescing those tracks belongs to P08.4, so P08.3 needs an explicit
selection boundary without starting speculative or hidden track reads.

## Decision

1. A mounted coach view opens one same-origin `EventSource` for its selected
   organization and validates every `live.state` with the shared strict schema.
   Non-increasing sequence values are ignored only within the same `streamId`;
   a new stream starts a new ordering domain.
2. Every accepted event replaces the available run set. A missing run loses its
   current position, last-known position, and selected-track state immediately.
3. A non-null position replaces both current and last-known data. A later null
   position may retain the previous coordinate only as `stale`; it is never
   exposed as confirmed or unconfirmed current data.
4. Browser freshness is anchored to event `serverTime` plus elapsed monotonic
   browser time. A current position becomes stale at 10 seconds, so stopped GPS
   is visible even while heartbeats and full states continue. Ten seconds is an
   initial UX/operational parameter, not a protocol guarantee; P11 must measure
   and confirm or adjust it against the five-second live-latency objective.
5. Confirmed, unconfirmed, stale, and unavailable states are visibly distinct.
   Track checkboxes maintain an explicit set of authorized selected run IDs;
   P08.3 does not load geometry or instantiate a map provider.
6. A transport or contract failure closes the native `EventSource` and clears
   all position/selection state fail-closed. Reconnection is explicit in this
   slice, avoiding an unbounded browser retry loop. Session-aware automatic
   reconnect and revision-coalesced selected-track recovery remain P08.4.

## Consequences

- GPS edge quality and observation freshness remain separate concepts.
- Local wall-clock skew does not affect age after a state is received, while a
  server timestamp still anchors the initial age.
- Temporary transport loss also clears the board. This trades availability for
  the stronger guarantee that a disconnect caused by authorization loss cannot
  leave coordinates visible.
- The screen is useful without Mapbox or another external token; geographic map
  rendering and archive layers remain P09.

## Verification

- Reducer tests cover time-driven staleness, null-position last-known behavior,
  selection cleanup on run removal, and connection-local ordering.
- SSE client tests cover the exact organization URL, strict shared-contract
  parsing, transport closure without native retry looping, and invalid-event
  fail-closed behavior.
- Static component coverage checks the marker board and explicit track-selection
  boundary. The full repository verification and real-role PostGIS integration
  regression suites pass unchanged.
