# Architecture review after owner run details

Date: 2026-11-02. Application snapshot: `9d20877978a045aedc3854be71cd43fe77eafdaf`.
This report proposes the next work; it does not change the accepted implementation plan.
It updates the [November 1 review](architecture-review-2026-11-01.md) after its first product slice shipped.

**Subsequent scope decision (2026-11-02):** Finish-to-result (ADR-0068) was selected for the user's
requested one-commit closeout and project freeze. That slice includes a correction found during
closeout: server confirmation of finished runs restored from IndexedDB or seen offline. Its checks
and the renewed pause are recorded in [the freeze report](freeze-verification-2026-11-02.md).
The broader roadmap below remains deferred, including the proposed mobile pilot. The review and
verification sections below describe the original `9d20877` snapshot, before ADR-0068.

## Architectural decision

Develop a small, invite-only runner/coach application with a verified recording-to-review workflow.
Keep React, the Express modular monolith and PostgreSQL/PostGIS. The next milestone is a usable,
measured mobile pilot with explicit foreground-recording limits. The existing backend is sufficient
for that milestone; the immediate constraints are workflow continuity, measurement evidence and
unattended operation.

The first bounded code change should connect a confirmed Finish to the existing owner result screen.
Start physical measurement collection alongside that work, once a usable secure origin is available.
Opening the application to participants comes after operational checks.

## What the latest commits delivered

- `1180470`: published archive-track API, strict GeoJSON contract, coherent run/summary read,
  pending/stale/ready states, history authorization, raw-purge independence and response limits.
- `9d20877`: owner detail screen from My runs, times/metrics/GPS diagnostics, optional route map,
  manual refresh, preserved list filters/draft/pages/focus, scoped cancellation and map disposal.
  It changes 20 files, with 962 insertions and 13 deletions; no SQL migration or dependency change.

The detail screen consumes the complete published geometry rather than reconstructing it from MVT
or raw points. It rejects mismatched run responses and drops obsolete completions. The map preserves
disconnected geometry, fits across the antimeridian, and leaves text usable without a provider token.
These are appropriate extensions of the existing consistency and retention model.

Sources: [archive read](../../apps/api/src/runs/archive-track-service.ts),
[detail controller](../../apps/web/src/run-detail-controller.ts),
[detail screen](../../apps/web/src/RunDetailScreen.tsx),
[map controller](../../apps/web/src/run-detail-map.ts),
[browser scenarios](../../tests/e2e/run-details.spec.ts).

## Review coverage and boundaries

The clean starting checkout contains 709 tracked files, 25 SQL migrations and 67 ADRs. The non-test
web source has 63 implementation files / 10,700 nonblank lines; API source has 149 / 23,055, including
backup, evaluation, GPS-analysis and load tooling; contracts have 7 / 1,507. Counts exclude declaration
files and spec files. The review followed the application flows and their security, transaction,
concurrency and retention boundaries; it is not a line-by-line proof of every file or interleaving.

| Boundary | Source inspected | Consequence for evolution |
|---|---|---|
| Composition and lifecycle | API app/main, pools, shutdown, configuration | Keep explicit dependency ownership and separate runtime/maintenance capabilities |
| Authentication and tenancy | Session/OIDC adapters, identity resolver, tenant transactions, RLS migrations | Session identity supplies trusted transaction-local context; preserve real-role tests |
| Recording and retries | App/reducer, IndexedDB storage, writer lease, capture, request and upload controllers, ingestion/commands | Preserve durable request identity and writer checks inside write transactions |
| Processing | Versioned edge evaluator, calculation/simplification/publication and claim SQL | Derived data must retain source revision and algorithm provenance |
| Live observation | SSE hub/state query, coach client/screen, selected-track synchronization | Keep bounded snapshots, separate track reads and revocation handling |
| Archive and search | MVT/cache coordinator, source lifecycle, search SQL/controller, new details | Keep history authorization, current-summary semantics and complete-route limits |
| Retention and recovery | Purge/deletion SQL, journals, backup and restore tools | New data must participate in deletion, retention and recovery |
| AI | Interpreter service/providers/normalization and evaluation boundary | Keep proposals constrained and separate from authorized data queries |
| Delivery | Production Compose/proxy, demo scripts, CI and browser harness | Existing local evidence must be supplemented by deployment/device evidence |

## Findings that determine priority

### 1. Finish and review are still separate user journeys

[RunnerView](../../apps/web/src/RunnerView.tsx) offers New run after Finish. It has no action to open
the result. [My runs search](../../apps/api/src/runs/run-search-service.ts) lists current published
summaries only, while pending runs contribute a count. The new detail view is reached from those
results. Consequently its pending state is supported by the API/UI but a newly finished run cannot
normally be opened through the list until its summary exists.

Add an explicit View result action for the confirmed finished run. Preserve the run pointer, pending
uploads and New run semantics. A finished lifecycle is not proof that all local points have uploaded
or that the summary reflects them. Represent synchronization and publication separately; do not
present a result as complete while this browser still has pending/rejected work. Existing pending/
stale states and manual Refresh can be reused. Automatic navigation, a router migration and new
statistics are separate choices.

Acceptance: online Finish to result; Finish with buffered points and reconnect; pending to ready;
late upload making a summary stale; unavailable/deleted result; session/organization change during
a read; Back and New run without dropped points or a changed command identity. Test that navigation
does not stop the uploader. Keep the existing writer/session regression gates.

### 2. Measurement quality and real capture remain unvalidated

The [v1 evaluator](../../db/migrations/0008_versioned_track_edge_evaluation.sql) rejects certain edges;
the [summary calculator](../../db/migrations/0009_calculate_run_summary.sql) sums accepted raw geodesic
distances. Display simplification does not correct measurement noise. The historical
[synthetic report](d10-gps-tolerances.md) records distance at 120-134% of truth for 3 m white-noise sigma,
and 174-202% for 8 m. Those scenarios are not estimates of actual phone error.

The current raw trace directory and committed sanitized trace inventory both contain zero trace files.
The [physical pilot](real-device-pilot.md) has no completed observations. Before algorithm v2, collect
sanitized real traces, report stationary drift, gaps/rejections and reference-distance error when an
independent reference exists. Use the existing sanitizer/replay tooling; preserve original private data
outside Git. A GPX recorded by another application tests processing, not this application's capture.

Test this application's browser on a physical phone: foreground recording, temporary receiver loss,
offline catch-up, Pause/Resume, Finish and coach revoke. Observe app switching and screen locking to
establish limitations. Background recording remains outside the current accepted scope. If ordinary
running with a locked phone becomes a requirement, select a native capture client in a separate ADR;
the existing ingestion protocol can remain its backend boundary.

### 3. Deployment readiness needs two bounded backend changes

**Sessions.** Both production composition paths currently use
[InMemorySessionStore](../../apps/api/src/auth/session-store.ts). Restarting the API loses sessions;
OIDC supplies authentication but does not make the application session durable. For a supervised first
exercise this can be documented. Before routine participant use, prefer PostgreSQL-backed opaque
sessions with expiry, revocation and hashed tokens. The synchronous SessionStore/SessionManager API
would need an asynchronous boundary, including HTTP authentication and SSE admission/revalidation.
Test restart, expiry, logout and revocation during a stream. Treat outstanding OIDC login transactions
separately: either persist them or explicitly require retry after a restart. Redis is not needed for
the current single-process deployment.

**Maintenance progress.** The [maintenance pool](../../apps/api/src/database/database.ts) has no SQL
budgets. [PeriodicRunner](../../apps/api/src/maintenance/periodic-runner.ts) schedules the next cycle
only after runOnce settles. Summary claims have advisory locks, but no persisted attempts/backoff/
terminal failure state. The exporter also holds a transaction across a durable filesystem write.
Hanging work and repeatedly failing candidates are architectural risks; this review does not claim
to reproduce them. Define per-task SQL/I/O deadlines and cancellation, bounded retry/backoff, fair
candidate selection and an operator-visible failure state. Prove healthy work progresses beside a
failing candidate. A Promise.race alone must not release a worker slot while its underlying operation
continues. Existing maintenance success/error metrics should feed alerts. The SDD's generic statement
that background jobs have timeouts is broader than this implementation and should be reconciled in
that change.

For a first hosted pilot use the existing single-host deployment profile with a trusted HTTPS origin,
real OIDC and operator-provisioned identities. Verify an actual basemap, off-host journal/backup storage,
scheduled backup age alerts and a restore before expanding access. A bind mount alone does not prove
off-host durability. Host/provider selection and spending remain separate decisions.

### 4. Future analytics must be designed before raw data disappears

Raw purge eligibility starts seven days after Finish and requires an upload-closed run with a current
valid summary. The retained geometry is simplified and has no per-point timestamps. Splits, pace series
and elevation cannot be faithfully reconstructed from that archive. Algorithm upgrades cannot replay
purged originals.

Start with server-side period totals over authorized current published summaries, with explicit timezone,
quality/version information and pending counts. Do not sum loaded UI pages. Before adding richer series,
decide which derived data survives purge, its source revision/version, publication atomicity and deletion
behavior. Avoid silently comparing incompatible algorithm versions. Keep the existing retention policy
until a product requirement explicitly changes it.

### 5. Frontend complexity should be reduced at specific seams

App is 925 lines, runner storage 1,239 and run service 1,312 (physical line counts including final line).
They contain meaningful domain logic; file size alone is not a defect. Extract runner composition into
one hook/controller boundary in a dedicated behavior-preserving change when the next flow needs it.
Split API lifecycle, ingestion, sharing and track queries without moving the caller-owned transaction.
Keep IndexedDB lease checks and mutations in the same transaction.

Archive map dates are UTC/exclusive; My runs uses timezone-aware search dates. They also have different
visibility scopes: the map includes shared history, the list is owner-only. A future common period
control must preserve that distinction. URL navigation and selection/highlighting can follow the
Finish/result slice. Coach finished-run review should reuse history-authorized reads, with its own UI
scope and revocation tests; a coach role alone grants no route access.

The targeted real-runtime browser test also emits Mapbox's nonempty-container warning. ArchiveMap
renders its loading/error spans inside the element passed to Mapbox. Move those overlays to a sibling
when touching that component; the review did not reproduce an interaction failure. Measure startup and
map interaction on the pilot phone before choosing further bundle work: the production build is
147.46 kB gzip for application JS and 509.69 kB gzip for the already dynamically loaded Mapbox runtime.

### 6. AI should follow useful, measurable data access

The current model boundary is appropriate: one bounded call proposes filters, deterministic validation
normalizes them, the user applies them, and SQL/RLS performs the search. Current tests use a fake;
recorded Ollama results do not establish usable latency/quality, and no live OpenAI evaluation is recorded.
Evaluate the existing feature before enabling it. A later explanation can consume authorized deterministic
aggregates with run references, version and quality limitations. Access to training history would be a
new capability: the current interpreter intentionally reads no history. There is no demonstrated need
for vector storage or an autonomous training planner in this milestone.

## Delivery order

| Order | Deliverable | Exit evidence |
|---|---|---|
| 1 | Finish -> synchronization/publication status -> existing owner result | Focused browser tests through the real API, including delayed upload/publication and session races |
| 2 | Secure phone-accessible test environment and physical pilot | Actual phone capture observations and sanitized trace analysis; explicit foreground limits |
| 3 | Durable sessions and maintenance progress safeguards, as separate changes | Restart/revocation and failure-with-healthy-work integration tests |
| 4 | Operated invite-only pilot | Real HTTPS/OIDC/map, current-SHA CI, backup/journal scheduling, restore and alerts |
| 5 | Shared-history review and period analytics | History ACL regression; coherent periods, pending counts, quality/version semantics |
| 6 | Richer derived series or evaluated AI, selected from pilot feedback | Retention/provenance contract or measured provider quality/latency/call budget |

Physical trace collection can start before step 1 finishes. A controlled secure phone test does not require
all unattended-operation work; participant hosting does. Microservices, horizontal scaling, a framework
rewrite, automatic map matching and a broad analytics/AI dashboard have no demonstrated prerequisite role.
The reserved `/archive/runs` and `/live/nearby` endpoints should be added only for an actual selected workflow.

## Verification on this snapshot

| Check | Fresh result |
|---|---|
| `npm run demo:doctor` | Passed; Docker Engine/PostGIS healthy, normal demo ports available, map token absent |
| Read-only database preflight | Confirmed owner/runtime/maintenance connections use `running_tracker_test` and their expected roles before fixture writes |
| `npm run verify` | Exit 0: lint, all workspace typechecks, 2,421 tests and production builds |
| `npm run test:integration` | Exit 0: 478 tests in 46 files; executed sequentially with respect to the browser suite, using the existing test DB without bootstrap/migrations |
| `npm run e2e --workspace=@running-tracker/e2e -- --project=chromium run-details.spec.ts` | Exit 0: all 7 scenarios, retries 0, including real Mapbox runtime with a local style and external requests blocked |
| Visual inspection | Fresh 375 px mobile screenshot and real-runtime route screenshot inspected; synthetic viewport/geometry evidence |
| Whitespace and report links | Checked after writing this report |

The 2,421 tests comprise scripts 83, API 1,332, web 845, contracts 144, fixtures 14 and simulator 3.
The build succeeds with the existing large-chunk warning. No failing check was observed in this run.
Logs are ignored local artifacts under `.local/architecture-review-2026-11-02-{verify,integration,e2e}.log`.

The full Chromium/OIDC suite, Firefox, Safari, physical-phone capture, real identity/map/inference
providers, hosted CI and deployment verification were not run in this review. Existing restore tests
in the integration suite do not establish an off-host recovery schedule or production RPO/RTO.
No fetch, push, commit, deployment or provider configuration change was performed. Local HEAD equals
the existing `origin/main` tracking ref; this is not a live remote CI check.

No application source, migration, dependency, environment file or accepted implementation plan is
changed by this review. This report is its only tracked-scope addition and remains uncommitted.
