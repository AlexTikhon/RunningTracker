# Architecture review and four-commit freeze

Date: 2026-11-05. Starting commit: `1c97264fa096013ee6adb7108da712dec666d67b`.
The starting worktree was clean, on `main`, equal to the local `origin/main` reference.
No remote refresh or hosted CI result is implied by that comparison.

## Decision

Keep the React/Express modular monolith and PostgreSQL/PostGIS. The recorded
capture-to-review journey is already connected. Close one bounded operational
gap after ADR-0069, then freeze: maintenance failure backoff, visibility and
failure/recovery evidence. Four local commits are the requested delivery boundary.

The last commit added independent PostgreSQL statement/lock budgets to the
maintenance pool (60 s / 5 s defaults), configuration validation, production
pass-through and real-role cancellation/rollback checks. It did not change the
scheduler's retry cadence. ADR-0070 now supplies bounded, jittered, per-task retry
delays after settled errors. This reduces repeated work during a dependency
failure; it trades faster recovery detection for lower failure load.

## Code review coverage

Review followed runtime ownership, data flow and failure boundaries across the
repository, using the plan, SDD, contracts, migrations, code and tests together.
This is an architectural review of those boundaries, not a line-by-line proof
of every source/test file or an audit of every concurrent execution.

| Boundary | Inspected implementation | Assessment |
|---|---|---|
| Composition/lifecycle | API app/main, pool creation, PeriodicRunner/auto-finish, shutdown | Runtime and maintenance credentials/pools remain distinct. Scheduling waits for actual settlement; no timer releases an unsettled operation. |
| Authentication/tenancy | SessionManager/store, authenticated tenant transactions, RLS/capability migrations | Identity enters transaction-local context through the session. Real-role tests remain essential. Both composition paths still use process-local sessions. |
| Capture/durability | App, session hook, capture/upload/request controllers, IndexedDB storage, writer lease | App owns capture and uploader lifetime across result navigation; durable mutations must retain their transaction-local writer fence. |
| Ingestion/processing | Run service, shared schemas, summary publication/batch, candidate-claim/publication SQL | Idempotent commands/points and revision-bound publication are retained. A claim is not a durable retry record. |
| Live observation | Live hub/state, coach and selected-track controllers | Authorization snapshots, bounded pending state and scoped reads are retained; no distributed live fan-out is required for this profile. |
| Archive/search/review | Archive scheduler/cache/read, search query, result synchronization, detail controller/map | Response limits, revision provenance and cancellation remain the boundary. Publication readiness alone cannot certify this device's uploads. |
| Retention/recovery | Retention worker, journal exporter/file sink, restore drill and access reapplication | Export acknowledges only after a durable sink result. The transaction still spans filesystem I/O; retry backoff cannot cancel a hung write. |
| AI/tooling | Interpretation service/normalizer, fixtures/simulator entry point, demo scripts | Model output proposes contract-validated filters. Provider work keeps admission until settlement; it does not execute arbitrary queries. |
| Delivery | Production Compose, CI/browser configuration and runbooks | Single-host profile is coherent. Current local checks do not establish hosted, device or production evidence. |

## Remaining priorities after the freeze

1. **Physical-phone evidence (D10).** Use the existing sanitized GPX pipeline and
   the [pilot checklist](real-device-pilot.md). A synthetic trace or desktop
   Playwright pass cannot validate foreground phone capture, app switching or GPS
   accuracy. Decide on a native capture client separately if locked-screen
   recording becomes required.
2. **Maintenance candidate progress.** Persist attempts/next eligibility and
   define fair selection/quarantine before claiming that healthy summaries advance
   beside a permanently failing candidate. Current oldest-first selection and
   batch-wide error semantics can retry the same candidate or delay healthy work.
   Independent-task progress in ADR-0070 is a narrower property.
   This closeout also observed a finite test-fixture backlog exceeding a browser
   assertion's 120-second wait at the normal two-worker/60-second cadence; see
   the failed attempt and subsequent setup correction in the verification report.
3. **Whole-job and I/O bounds.** Individual statements are bounded, not the entire
   transaction/filesystem operation. Cancellation must retain ownership until
   underlying work settles and preserve journal durability before acknowledgement.
4. **Durable sessions before routine participant use.** Prefer PostgreSQL-backed
   opaque hashed sessions, with asynchronous authentication and SSE revalidation;
   prove restart/logout/expiry/revocation. OIDC login transactions need an explicit
   restart policy of their own.
5. **Target-environment verification.** Hosted CI at the eventual pushed SHA,
   actual HTTPS/OIDC/basemap and off-host backup/journal/restore evidence remain
   separate gates. No framework migration, microservice split or new AI feature
   is justified by this review.

The Chromium installed-runtime detail scenario passed and its saved screenshot
visibly renders both disconnected route segments against the local empty style.
It also logged a nonempty-container warning and two unhandled Mapbox
`this.errorCb is not a function` rejections. Investigate the runtime/React map
lifecycle and test network-abort paths before claiming a clean map console or
demonstrating a provider basemap; the present evidence does not identify the
cause. This maintenance slice changes no map code.

## Freeze evidence

Commands, exact results and restart steps are recorded in
[the verification report](freeze-verification-2026-11-05.md) and
[pause handoff](../pause-handoff.md). Historical reports retain their original
snapshot/date; their test counts are not current coverage claims.
