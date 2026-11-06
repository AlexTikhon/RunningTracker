# ADR-0071: Map DOM ownership and runtime lifecycle

Date: 2026-11-06. Status: accepted.

## Context

The November 5 freeze recorded a successful route screenshot alongside a
nonempty-container warning and unhandled Mapbox `errorCb` rejections. ArchiveMap
renders React notices inside the Mapbox constructor's container. React and
Mapbox consequently mutate the same subtree. CoachMap already uses a dedicated
empty canvas host; RunDetailMap also has an empty host.

Map construction and navigation-control installation are duplicated across the
three views. A failed control installation can leave an allocated map behind.
Browser assertions currently check visible application notices but do not fail
on browser exceptions or Mapbox container warnings.

## Decision

Give each map a dedicated empty host. Place React notices beside that host in a
positioned wrapper, retaining the existing responsive archive dimensions.
Centralize asynchronous runtime loading and map/control construction with an
abort check before allocation and cleanup if setup fails. The owning controller
or effect remains responsible for listeners and removal after successful setup.

Exercise the installed runtime in Chromium with a local empty style, including
archive/detail transitions, repeated opening, refresh and sign-out. Collect
uncaught browser errors and Mapbox container warnings throughout those lifetimes.
Keep provider protocol fixtures explicit and record their limits: a local style
and synthetic provider responses cannot certify a real basemap or account.

## Trade-offs and boundaries

The dedicated host avoids a shared DOM owner at the cost of one wrapper element.
The shared factory handles allocation only; archive authorization/revisions,
coach live geometry and detail snapshot cancellation retain their separate
owners. No dependency patch, database migration, GPS change, new map framework
or production/provider verification belongs to this slice. External network
failures and any dependency callback defect must be distinguished from successful
local rendering; passing UI assertions alone is insufficient evidence.
