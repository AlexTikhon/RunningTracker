# Architecture review and proposed next milestone

Date: 2026-11-01. Reviewed application snapshot: `2691432be6cbda5d1125c287c7a94cc8f3a48331`.
This is an assessment and a proposed direction, not a change to the accepted implementation plan.

## Decision

Develop the project into a small, invite-only runner/coach pilot with a complete recording-to-review workflow.
Keep the React application, Express modular monolith and PostgreSQL/PostGIS boundary. The next value comes from
usable finished-run review, physical-device evidence and operating the existing design outside the workstation.

The largest uncertainty is measurement quality and browser capture in real conditions. More aggregate statistics
or AI explanations would currently amplify that uncertainty. The first bounded product addition should be an
owner's finished-run detail view, starting with its archive-track read contract. Physical trace collection can
begin before that feature is complete; it does not depend on a new algorithm or dashboard.

## Latest commit and review coverage

`2691432` changes four documentation files: README, interview notes, progress and the new pause handoff.
It records the completed closeout; it introduces no application, SQL, dependency or test changes.
The preceding code changes add finished-run deletion, pending-delete sharing protection and the local demo simulator.
The working tree was clean at the start of this review.

The repository contains 696 tracked files, 25 SQL migrations and 65 ADRs at the reviewed snapshot. The inventory
of non-test TS/TSX/JS/MJS/SQL under application, packages, database, scripts, infrastructure and tools contains
269 files and approximately 42,400 nonblank lines, including substantial operator and evaluation tooling.

The review traced the runtime flows across these subsystems, checked the migration/policy/function inventory,
and compared source behavior with contracts, representative regression tests, CI configuration and recorded reports.
It is an architectural source review, not a proof of every interleaving or a new physical-device validation.

| Area | Principal source evidence | Assessment |
|---|---|---|
| Composition and lifecycle | `apps/api/src/app.ts`, `main.ts`, `lifecycle/shutdown.ts` | Explicit dependency composition, separate runtime/maintenance pools, bounded shutdown |
| Identity and tenancy | `auth/`, `database/tenant-transaction.ts`, migrations 0001–0005 and 0019–0024 | Session identity establishes transaction-local context; RLS protects row visibility |
| Commands and ingestion | `runs/run-service.ts`, `runs/run.routes.ts`, contracts | Durable command identity, canonical point equality, run locks and separate revision axes |
| Browser recording | `runner-storage.ts`, `writer-lease.ts`, `capture-controller.ts`, `runner-requests.ts`, `run-authority.ts` | Durable buffer, monotonic writer epochs and checks at persistence boundaries |
| Track processing | migrations 0008–0012, 0014–0015; `maintenance/run-summary-publication.ts` | Shared versioned evaluator and revision-checked summary publication |
| Live observation | `live/`, `coach-live-client.ts`, `selected-track-sync.ts`, `live-track-sync.ts` | Full state over SSE, separate track synchronization, bounded backpressure |
| Archive | `archive/`, `ArchiveScreen.tsx`, `ArchiveMap.tsx`, `archive-source.ts` | PostGIS MVT, authorization-aware cache, archive revision invalidation |
| Search and AI | `runs/run-search-*`, `runs/interpretation/`, `evaluation/`, `RunSearchPanel.tsx` | Deterministic owner search; optional model only proposes validated filters |
| Retention and recovery | migrations 0014–0020; `maintenance/`, `backup/`, `restore/` | Raw retention, tombstones, deletion/access journals and restore tooling |
| Delivery and evidence | `infra/`, `scripts/`, `.github/workflows/ci.yml`, `tests/e2e/` | Reproducible local stack and a single-host deployment profile; recent evidence is local |

## Architectural strengths to preserve

1. **The database is an enforceable boundary.** Runtime, owner and maintenance capabilities are separated. The
   runtime role does not own the tables. Tenant/user settings are transaction-local, and the HTTP layer derives
   the user from the session. RLS still depends on that trusted application context; possession of runtime database
   credentials is not equivalent to an untrusted end-user connection.
2. **Retries have domain semantics.** A run ID binds creation to a payload; a command ID binds a lifecycle command;
   point sequence IDs bind canonical measurements. An unknown network outcome can be retried without inventing
   a new operation. This is at-least-once delivery with idempotent effects.
3. **Browser ownership is checked where writes happen.** Writer epochs survive release, and relevant IndexedDB
   transactions recheck the lease and active run. Request/session generations prevent obsolete completions from
   changing a different screen. Preserve these checks when moving code out of App.
4. **Derived data has provenance.** Data, control, summary source and archive revisions serve different purposes.
   Summary publication checks the calculation's source revision. The same edge rules drive live and final processing.
5. **Resources are bounded.** SSE keeps a latest pending snapshot, tiles have queue/concurrency/SQL/size limits,
   and AI calls have admission and operation-lifetime accounting. Existing limits should change in response to
   measurements, not a speculative scale target.
6. **Recovery includes permission loss.** Restoring an old database can otherwise resurrect deleted runs or revoked
   access. Separate journals explicitly address that problem. Actual off-host durability remains an operator concern.

## Constraints that should determine the roadmap

### 1. GPS distance is not yet a validated training metric

Migration 0009 sums geodesic distance over accepted, unsimplified edges. Migration 0008 rejects poor accuracy,
sequence/segment breaks, invalid time intervals and excessive speed; it does not estimate receiver drift.
Display simplification is a separate transformation and does not correct the stored distance.

The existing [synthetic tolerance report](d10-gps-tolerances.md) records distance at 120–134% of known truth for
3 m white-noise sigma, and 174–202% for 8 m. These are historical synthetic results, not fresh measurements of
phones. The [physical pilot report](real-device-pilot.md) still records no physical recordings.

Consequences: show quality and measurement limitations alongside metrics; collect real traces before tuning v2;
do not base training recommendations, personal records or accuracy claims on the current distance alone.
`observedDurationS` is time covered by accepted edges, not moving time. Wall elapsed time includes pauses and gaps.

### 2. The retention policy constrains future analytics

Migration 0015 allows raw-point purge after seven days, after the late-upload window closes and a current valid
summary exists. The archive retains summary metrics and simplified geometry; annual retention later deletes runs.

A detail view must therefore work from the published summary after raw purge. Future splits, pace series or
elevation cannot be reconstructed from a simplified line without timestamps. Compute and retain any approved
derived series before purge, with source revision and algorithm version, or deliberately revise the retention policy.
After purge, historical summaries cannot be recalculated under a new algorithm from the original measurements.
Keep algorithm provenance visible rather than silently mixing v1 and v2 in comparisons.

### 3. Foreground buffering and an offline-launchable application are different capabilities

The current implementation buffers measurements in an already running page and recovers durable work after an
online reload and sign-in. No service-worker app shell or persistent-storage request was found in the web source.
The reload/offline browser tests exercise these scenarios separately.

Do not infer offline cold-start or locked-screen recording from these tests. Add an offline shell only if the pilot
needs offline reopening, with an explicit private-data caching policy. If ordinary use requires recording with the
phone locked, evaluate a native capture client after the physical pilot. A PWA installation alone does not establish
that recording guarantee. Keep the existing ingestion protocol as the shared backend contract.

### 4. Authentication and provisioning are operator-oriented

OIDC uses a provisioned issuer/subject identity. The resolver does not create people or memberships, and there is
no end-user onboarding or club administration workflow. This is acceptable for a first pilot using the documented
operator provisioning procedure; build invitation UX only after the workflow proves useful.

Sessions and pending OIDC logins are in process memory. An API restart invalidates sessions; the browser's refusal
handling then suspends recording/upload until sign-in. Before unattended hosting, either accept and document this
pilot behavior or implement durable sessions with expiry/revocation. PostgreSQL can serve a small single-host pilot;
that change would require an asynchronous session contract and review of HTTP and SSE revalidation paths.

### 5. Product navigation stops short of finished-run review

My runs lists distance, observed duration and quality, plus sharing/deletion actions. ArchiveMap displays an MVT
layer but has no run selection/detail interaction. Map and list have separate date filters (UTC map dates versus
the search's timezone-aware filters). The three top-level views are component state, without shareable detail URLs.

Add owner run details first; then connect list selection, route highlighting and a common applied period. Keep
shared history as a distinct authorization case: a coach role by itself must not expose finished routes.

### 6. Maintenance needs an unattended-operation failure policy

The runtime pool has statement and lock budgets. The maintenance pool intentionally has neither. PeriodicRunner
prevents overlapping cycles and reports errors, but waits for runOnce to settle. Summary claims do not persist
per-run attempts, a next retry time or a failed-job state.

Architectural risk, not a reproduced failure in this review: a hanging operation can stop a maintenance task's
progress; a repeatedly failing old candidate can repeatedly consume worker capacity. Before unattended operation,
define task-specific SQL/I/O budgets, bounded retry/backoff and an operator-visible failure state. Exercise a
failing candidate alongside a healthy one to prove progress. A new broker is not required for that change.

### 7. Complexity is concentrated in a few orchestration files

App contains roughly 880 nonblank lines, runner storage roughly 1,150, and run service roughly 1,230. Their
responsibilities are identifiable, but each new runner feature risks touching many lifecycle effects.

Extract runner composition behind one hook/controller boundary when the next change needs it. Split run-service
by lifecycle, ingestion, sharing and track reads while retaining the caller-owned transaction boundary. Keep
IndexedDB transaction ownership intact; splitting a transaction into repository calls would weaken existing invariants.
Avoid combining structural extraction with new recording behavior in the same change.

## Proposed delivery sequence

| Step | Deliverable | Completion evidence |
|---|---|---|
| 0 | Re-establish a reproducible baseline | Fresh local verify; isolated integration/browser checks when Docker is available; current-SHA hosted CI checked separately; reconcile stale SDD status text |
| 1 | Owner finished-run detail vertical slice | Archive-track contract/API, summary and quality UI, route display, usable state after raw purge, focused authorization/race tests |
| 2 | Physical measurement and browser pilot | Sanitized real traces using existing tooling; real phone capture, interruption, reconnect, Finish and coach revoke; documented observations and reference-distance method |
| 3 | Operated invite-only pilot | Trusted HTTPS, real OIDC, explicit provisioning, session-restart policy, real map check, off-host backup/journal verification, restore and alerts |
| 4 | Evidence-led analytics | Comparable period totals first; splits or algorithm v2 only after deciding what derived data survives purge |
| 5 | Evaluated AI assistance, if useful | Existing search evaluation on a chosen provider, latency/quality/error results and a call budget before enabling the feature |

For step 2, recorded GPX from another application validates the processing path only. It does not validate this
application's browser capture. Both forms of evidence are needed. Start with one operator/runner and one coach;
expand to a few invited participants after the core flow works.

Step 3 is a proposed milestone, not authorization to purchase infrastructure, expose the local machine or deploy.
Choose the host/provider and monthly budget only when that milestone is selected. Existing single-host Compose
is a useful starting point, with API, proxy and PostgreSQL. A managed database trades reduced database operations
for additional cost and a need to verify PostGIS, role provisioning and restore permissions.

## First bounded engineering task: archive-track read contract

Implement the missing archive-track read needed by owner run details. The SDD already reserves
`GET /api/orgs/{orgId}/runs/{runId}/track?mode=archive`; settle its exact response in an ADR/contracts change before
building the screen. Preserve its GeoJSON intent, and define an explicit representation of pending/stale summaries.

Requirements for the slice:

- Read a finished run and its published summary/geometry in one coherent database statement/snapshot. Return the
  run revision and the summary's source revision/algorithm version; never label an older summary as current.
- Read `run_summaries.display_geom`, not raw points or decoded MVT. Return a valid MultiLineString or null and
  preserve disconnected segments/antimeridian behavior. Null geometry with insufficient data is a valid outcome.
- Work identically after raw purge. Pending/stale summary is a typed state, distinct from a valid empty track.
- Retain the existing active-membership and history-share policy. No coach-role shortcut; live-only permission
  must not authorize a finished route. Owner tombstones retain their existing semantics.
- Set private/no-store response caching. Bound geometry payload size explicitly; reject excess complexity with a
  typed error rather than silently returning a partial route. Establish the numerical limit in the contract/ADR.
- Test owner, history grantee, live-only grantee, another tenant, inactive membership, pending/stale summary,
  insufficient data, raw-purged run, deletion and summary publication during reads under real database roles.

Then add the owner detail screen as a separate slice. Keep textual details usable without a map token, cancel
obsolete reads on identity/run changes, and make list-to-detail-to-list navigation preserve applied filters.
Do not add GPX export, a GPS algorithm change, splits or an AI coach to this first slice.

## AI direction

The current filter interpreter has a sound boundary: the model proposes a restricted schema; deterministic code
validates it; the person applies the filters; SQL and RLS execute the actual search. Retain that separation.
Tests use a fake, and recorded local model results do not establish useful inference latency or accuracy.

The next AI task, when selected, is evaluating the existing adapter against the existing dataset and error
taxonomy. A later grounded activity summary could consume authorized summary data and deterministic aggregates,
with a reference to the runs used. This would be a separate data-access decision: the current interpreter reads
no training history. RAG/vector storage and autonomous training-plan changes have no demonstrated requirement here.

## Validation in this review

- `npm run verify`: passed, exit 0. Lint, workspace typechecks, 2,384 tests (scripts 83, API 1,332, web 820,
  contracts 132, fixtures 14, simulator 3) and production builds passed on this workstation.
- The web build reports a large-chunk warning: the application JS is approximately 144.6 kB gzip and the separately
  loaded Mapbox runtime approximately 509.7 kB gzip. This is a performance budget to measure on the target phone;
  Mapbox is already loaded dynamically, so adding that existing split is not a proposed fix.
- `npm run demo:doctor`: dependencies/configuration/ports passed; Docker Engine is not reachable.
- Integration, Playwright and container deployment/restore verifiers were not rerun because Docker is unavailable.
- The 2026-10-28 [pause verification](pause-verification.md) records 2,384 unit tests, 463 integration tests,
  115 Chromium/OIDC tests, an 18-test Firefox core gate and 24-test smokes per browser. These are historical results.
- Hosted CI was not queried or triggered in this review. The repository's pause report describes its older hosted
  run; this assessment does not establish current remote CI status.
- `git diff --check` passed; local Markdown links in this report were checked against the filesystem.
- No physical recording, real identity provider, map provider or inference provider was contacted.
- Application source, tests, database, local configuration and deployment state were not changed. This report is
  the only intended tracked-file addition; the verification log is ignored under `.local/`.
