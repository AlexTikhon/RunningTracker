# Four-commit map lifecycle freeze verification

Date: 2026-11-06. Local Windows workstation, Node 24.11.1 / npm 11.6.2,
PostgreSQL/PostGIS in the existing healthy Compose container.

## Scope and provenance

Clean base: `8c4f9e214024692e8627e35f45789ac60d5436f6`, `main`, initially equal to
the local `origin/main` reference. Exactly four new local commits were requested,
followed by another freeze. No remote refresh, push or deployment was performed.

| Commit | Scope |
|---|---|
| `cf7704b` | Dedicated empty archive DOM host, responsive canvas and ADR-0071 |
| `d006133` | Shared runtime/map/control allocation cleanup, cancellation, archive lifetime guards and Coach attachment-error containment; unit regressions |
| `ff03b31` | Installed-runtime diagnostics and lifecycle/failure scenarios; shared local provider protocol fixture |
| Fourth commit, containing this report | Architecture review, current evidence and reconciled pause/restart documentation |

Runtime changes are limited to the web map owners/controllers, the shared
allocation factory and archive canvas CSS. No schema migration, role grant,
dependency/lockfile, API contract, GPS algorithm or private configuration change
belongs to this closeout. The fourth commit changes documentation only.

## Executed checks

| Check | Result |
|---|---|
| Initial archive screen/source selection | 6 passed in 2 files |
| First expanded map selection | 38 passed, 1 failed: a new test used a spy matcher on a status array; assertion corrected |
| Final expanded map selection | 39 passed in 5 files |
| Web typecheck and changed web-file ESLint | Exit 0 |
| `npm run verify` | Exit 0: repository lint, all workspace typechecks, 2,463 tests and production builds |
| Changed E2E-file ESLint and `npx tsc --noEmit -p tests/e2e/tsconfig.json` | Exit 0 |
| `npm run test:integration` | Exit 0: 483 passed in 47 files, 0 skipped, 217.23 s |
| Test-only publication preflight | Live `running_tracker_test` / `running_tracker_maintenance` identity confirmed; production batch returned two idle workers, 0 publications and 0 remaining candidates |
| `npx playwright test run-details.spec.ts coach-map.spec.ts finish-result.spec.ts --project=chromium` from `tests/e2e` | Exit 0: 18 passed, retries 0, 2.4 min |
| `npm run test:e2e:smoke` | Exit 0: 24 passed, retries 0, 3.1 min |
| `npx playwright test coach-map.spec.ts --project=firefox-core` from `tests/e2e` | Exit 0: 3 passed, retries 0, 50.7 s; fake runtime, no Firefox WebGL claim |
| `npm run demo:doctor` | Exit 0; Node/npm, existing healthy container and free demo ports confirmed; no basemap token configured |
| Final TCP connection probes | All suite ports closed: 3100, 3101, 5273-5276 and 9100; existing PostgreSQL container retained |
| Changed-document relative file links | 126 checked across 9 documents; 0 missing (anchors not validated) |
| `git diff --check` | Exit 0 before final staging; repeated at commit audit |

The 2,463-test total is 83 script/migration tests, 1,351 API unit tests, 868 web,
144 contracts, 14 fixtures and 3 simulator tests. Integration/browser counts are
separate. The existing Mapbox production chunk-size warning remains.

Full verification covered runtime/unit changes at `d006133`; the later E2E-only
changes received their own ESLint/typecheck and browser execution. Integration
ran against the guarded test roles; documented tracked local-only values were
loaded into process environment without writing `.env`. No bootstrap or migration
was needed. Browser suites ran after builds/integration settled, sequentially,
without source/build changes during their execution.

## Map evidence and its limits

Unit regressions exercise cancellation before import and during a held import,
successful ownership transfer, navigation-control constructor/installation
failure, cleanup that itself throws, import rejection and Coach listener
attachment failure. Existing geometry, late-map disposal, StrictMode replacement,
session end and live-revocation checks remain in the selection.

Chromium uses installed Mapbox 3.31.0 and WebGL with a browser-local empty style.
The detail scenario verifies the archive canvas has usable height, opens the
published route, refreshes, returns to Archive, reopens and signs out; only one
canvas remains during detail review and none after sign-out. The Coach scenario
draws a live marker/selected track and signs out. Both assert no uncaught page
errors, no nonempty-container warnings and no unexpected external requests.

The style-failure scenario returns HTTP 503 for the base style, verifies an
archive error notice, then detail failure with statistics still available,
disabled Fit route and no remaining detail canvas. Sign-out completes without
uncaught errors or container warnings.

The saved detail screenshot was visually inspected: both disconnected route
segments render against the empty local style; statistics and navigation remain
readable. The Coach screenshot also shows a marker and selected line. These are
local rendering observations, not a provider basemap or GPS accuracy claim.

The old fixture aborted all external requests except the style. Installed
dependency source maps show that MapLoadEvent / MapSessionAPI removal nulls an
error callback while a failed pending request may still call it. The shared
successful-runtime fixture now returns synthetic success for map-session and
event endpoints, with external fonts replaced by empty CSS and unexpected
external requests rejected. It does not catch/suppress page errors or patch the
library. Actual Mapbox authentication/telemetry network failure after removal
remains unverified and the dependency callback hazard remains open. HTTP 503
style cleanup is a narrower verified failure boundary.

Local logs and screenshots are gitignored under `.local/` and Playwright's result
directory. The report records durable conclusions without committing private or
generated artifacts.

## Not run or not established by this closeout

No current hosted CI, full Chromium/OIDC matrix, full Firefox core/smoke matrix,
Safari/WebKit/mobile/physical-phone test, actual Mapbox/OIDC provider, production
deployment, fresh performance/load study or off-host recovery proof is implied.
Historical reports remain scoped to their recorded commits/environments. D10,
durable sessions, candidate fairness/persisted retries and whole-job/I/O bounds
remain deferred as listed in the [architecture review](architecture-review-2026-11-06.md).

Restart and verification commands are in the [pause handoff](../pause-handoff.md).
The project pauses after the fourth documentation commit; new features require
a separately selected task.
