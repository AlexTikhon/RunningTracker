# Architecture review: map lifecycle closeout

Date: 2026-11-06. Clean starting commit: `8c4f9e2` on `main`, equal to the
local `origin/main` reference. No remote refresh is implied.

## Decision and review scope

Retain the React/Express modular monolith and PostgreSQL/PostGIS. The previous
four commits completed maintenance failure backoff and observability; the last
commit itself reconciled verification and pause documentation. Its report
explicitly left a Mapbox container warning and uncaught `errorCb` failures open.
Close that concrete demo defect in exactly four new local commits, then pause.

Review traced composition, ownership, authorization and failure paths across
the source tree, contracts, migrations, CI and runbooks. This is a review of
architectural boundaries and the selected map implementation, not a claim that
every source/test line or concurrent schedule has been exhaustively audited.

| Boundary | Current implementation and assessment |
|---|---|
| Composition and shutdown | `main.ts`, `app.ts`, database pools and shutdown own process resources explicitly. Runtime and maintenance identities/budgets remain separate. Shutdown's deadline and a maintenance statement timeout do not bound filesystem work. |
| Identity and tenant isolation | SessionManager, authenticated tenant transactions, route guards and RLS retain server-selected identity and transaction-local organization context. Session tokens are hashed in the store; the store and OIDC transactions are still process-local. |
| Capture and durable browser state | App, writer coordinator, IndexedDB storage and upload worker keep capture lifetime independent of review navigation. Writer ownership must be checked inside each durable mutation, not only before an asynchronous request. |
| Commands, points and publication | Shared contracts, run service, publication worker and claim SQL retain idempotency and revision provenance. Transaction-scoped claims deduplicate active work but do not provide durable attempts, fairness or quarantine. |
| Live access | SSE hub, coach state and selected-track synchronization retain authorization revalidation and bounded transport/application state. A map's lifetime ends with its owning session. |
| Archive and review | Tile admission/cache/source synchronization, archive-track read and detail controller retain revision checks and complete-response limits. Device upload completion and published-summary freshness remain separate. |
| Map runtime | ArchiveMap shared its host with React notices. CoachMap could leak an instance after control setup failure and leave an attachment exception as an unhandled promise. All three maps now use one allocation boundary; archive notices are siblings of its empty host. |
| Retention and recovery | Journal export spans claim, durable sink write and acknowledgement in one transaction. Restore tooling reapplies deletions and narrower access. Preserve that durability ordering when adding cancellation; a timeout race alone must not acknowledge an unfinished write. |
| AI and tooling | Interpreter admission retains reservations until provider settlement; model output feeds validated deterministic filters. Limits and sessions are process-local. No new provider or AI capability is needed for this freeze. |
| Delivery | Compose/proxy and CI retain a single-host profile with independent hosted test databases. Local regression is distinct from hosted CI, actual HTTPS/OIDC/basemap and physical-device evidence. |

## Selected corrections (ADR-0071)

1. ArchiveMap gives Mapbox a dedicated empty, absolutely positioned host inside
   its existing responsive wrapper. React owns the sibling notices.
2. `createMapboxMap` checks cancellation before/after lazy import and transfers
   ownership only after navigation-control setup. Failed setup removes the map
   while preserving the original error. Archive setup/late-event handling and
   CoachMap attachment errors retain their own cleanup boundary.
3. Installed-runtime browser scenarios collect uncaught exceptions and container
   warnings, exercise archive/detail refresh/reopening/sign-out and a failed
   style, and use a shared explicit local provider protocol fixture.
4. Current regression evidence and restart/remaining-work instructions are
   recorded in the [verification report](freeze-verification-2026-11-06.md) and
   [pause handoff](../pause-handoff.md).

The installed Mapbox 3.31.0 source map explains the prior `errorCb` symptom:
MapLoadEvent and MapSessionAPI set `errorCb = null` during removal, while a
failed pending event/session request later calls it without a guard. The old
browser fixture aborted those requests, including when leaving Archive for
details. The successful-runtime fixture now answers session/event requests
locally; it does not suppress page errors or modify the dependency. A separate
HTTP 503 style scenario exercises application failure cleanup. This does not
fix or certify the dependency's callback behavior during real auth/telemetry
network failures, which remains a provider-environment investigation.

## Priorities after the freeze

1. **Physical phone pilot / D10.** Collect sanitized real GPX evidence and follow
   `real-device-pilot.md`. Desktop simulation cannot establish GPS accuracy,
   mobile permission behavior, background recording or locked-screen support.
2. **Fair maintenance progress.** Persist per-candidate attempts and next
   eligibility, define revision-aware retry/reset and quarantine, and prove that
   healthy candidates advance beside a permanently failing one across restart
   and multiple workers. Per-task backoff alone cannot provide this property.
3. **Whole-job and I/O bounds.** Bound transactions and external writes with
   cancellation that keeps ownership until settlement. Preserve journal
   at-least-once delivery and do not mistake a timer for completed cancellation.
4. **Durable sessions before participant use.** Prefer hashed opaque sessions in
   PostgreSQL, asynchronous resolution and SSE revalidation; verify restart,
   expiry, logout and revocation. Define OIDC login-transaction restart policy.
5. **Target environment.** Run hosted CI at the eventual pushed SHA and validate
   actual HTTPS, OIDC, Mapbox responses/failures and off-host backup/journal
   recovery. The local protocol fixture cannot establish provider behavior.

No framework migration, microservice split, new AI feature, GPS algorithm change
or database migration is justified by this bounded closeout.
