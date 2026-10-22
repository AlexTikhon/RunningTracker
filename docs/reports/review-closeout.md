# Review closeout (2026-10-15)

Audience: whoever decides whether this review cycle can be closed. Decision records: `docs/adr/0058-local-abandonment-of-a-rejected-start.md`
and the entries in `docs/progress.md`; deployment procedure: `docs/runbooks/deployment.md`.

## Result

**All six repairs are in `main` and the closeout run passed: 0 failed, 0 skipped, 0 flaky.** Nothing needed
correcting during this run, so no code, test, retry or timeout was changed. The review cycle is complete.

| This run (2026-10-15, test database `running_tracker_test`) | Result |
|---|---|
| `npm run db:migrate:test` | exit 0; 24 migrations, 0 applied, 24 already applied (head `0023_normalize_future_run_start.sql`) |
| `npm run test:integration` | exit 0; **445 passed** in 44 files, 0 failed, 0 skipped (116 s) |
| `npm run test:e2e` | exit 0; **87 passed** (5.6 min), 0 failed, 0 skipped, 0 flaky, retries 0 |
| &nbsp;&nbsp;project `chromium` | 78 tests, including the harness test that is meant to fail (below) |
| &nbsp;&nbsp;project `chromium-oidc` | 9 tests |
| `git diff --check` | exit 0 |

The three commands ran one after another against the same database. E2E used the in-process fake run-search
adapter (`RUN_SEARCH_AI_PROVIDER=fake`) and the repository's `oidc-provider` process; no paid or networked
model call is configured in this environment.

Reading the E2E list: `harness.spec.ts:66` is printed with `x` because it calls `test.fail()` on purpose; it proves
that the scenario fixture removes a failed test's data, and Playwright counts it among the 87 passed.

## Update 2026-10-22: the nginx error-log exposure is closed (ADR-0062)

The last remaining privacy limit below ("Nginx error-log query exposure") is closed in the working tree after
`aa42f83`, uncommitted at the time of writing. The sections after this one are left as they were recorded on
2026-10-15, including the carried-forward `deploy:verify` row that reports `errorLogQueryExposedOnNginxError`
**true**.

| Run (2026-10-22, Docker Desktop, self-signed, localhost) | Result |
|---|---|
| `npm run deploy:verify` on the baseline proxy, with the new gate | exit 1: `errorLogQueryExposedOnNginxError`, 12 of 20 canaries in the stored proxy stderr |
| `npm run deploy:verify` with the boundary | exit 0; access, error stream and writable files 0 of 20; 0 unsanitized stderr lines; 413 and 504 paired with `request_body_too_large` and `upstream_timeout`/`upstream_connect_failed`; reload, restart, re-migration and rotation pass |
| `npm run transport:verify` on baseline images, then with the boundary | exit 1 (8 of 12 canaries, 5 raw error lines), then exit 0 (0, 0); SSE checks unchanged |
| `npm run proxy:verify-error-log` | exit 0: startup failure stays readable; a missing sanitizer exits 70; reload; frozen sanitizer blocks and then delivers 600 of 600 lines with none bypassing; killed sanitizer exits 70; SIGQUIT and SIGTERM exit 0; njs QuickJS output identical to Node; about 3.7 MiB peak |
| `npm run verify` | exit 0; scripts 68, API 1324, web 661, contracts 129, fixtures 14, simulator 3, build |

This is workstation evidence with throwaway secrets and certificates. It is not proof on a production host, and the
residual channels are listed in ADR-0062.

## Findings, commits and regression tests

| Finding | Commit | Regression tests |
|---|---|---|
| F01: the OIDC callback's one-time `code` and `state` were written to the proxy access log | `2f7e293` | `scripts/production-profile.test.mjs` ("F01 proxy: the access log format carries no query string and keeps its diagnostics"), `scripts/transport-profile.test.mjs` ("F01 transport proxy: ..."); runtime canary probe in `scripts/verify-production-profile.mjs` |
| F03: maintenance and journal validators rejected UUID v7 that the public contract accepts | `5274256` | `packages/contracts/src/contracts.spec.ts`; `access-journal-format`, `deletion-journal-format`, `run-raw-purge`, `run-retention-delete`, `run-*-journal-export`, `reapply-*` and `environment` specs; integration `access-restriction-journal`, `run-deletion-journal`, `run-raw-purge` |
| F04: a Start requested ahead of the server clock made an immediate Finish violate `runs_finished_state_consistent` | `ddb5326` | `apps/api/test/run-lifecycle.integration.test.ts`, `apps/api/test/run-auto-finish.integration.test.ts`; migration `0023` |
| Docker-built images always shipped the tokenless Mapbox fallback | `5de985b` | `scripts/production-profile.test.mjs` ("Mapbox token: ..." three tests), `scripts/transport-profile.test.mjs` ("transport Compose passes the optional public Mapbox token ...") |
| A definitively rejected Start (403 `ORG_ACCESS_DENIED`) could not be left | `83f804f` | `runner-state`, `runner-storage`, `runner-requests` and `RunnerView` specs in `apps/web/src`; `tests/e2e/rejected-start-recovery.spec.ts` |
| Compose-profile tests failed on a CRLF checkout (7 of 54) | `fb20668` | the same two profile test files, with line endings normalized at their read boundary |

## Evidence of this run

- The integration suite exercises `ddb5326` and `5274256` against PostgreSQL at migration 0023.
- The E2E run passed `rejected-start-recovery.spec.ts` (2) and `refused-run-recovery.spec.ts` (4) on the real API,
  the test database, Chromium and native IndexedDB. Commit `83f804f` recorded the same 6/6 earlier; this run repeats it.
- All 9 OIDC sign-in tests passed in `chromium-oidc`.

## Hosted CI run (a different commit, not this run)

Checked on 2026-10-15 with `gh run view 38624437491 --json headSha,conclusion,jobs,url` and the two job logs.

| Item | Value |
|---|---|
| Run | [actions/runs/38624437491](https://github.com/AlexTikhon/RunningTracker/actions/runs/38624437491), workflow `CI`, push to `main`, 2026-10-14 19:31 to 19:39 UTC |
| Tested SHA | `83f804f357f203135ddead8ce083c062ce42d284` (the last of the six repairs) |
| Runner | GitHub-hosted `ubuntu-24.04` |
| Conclusion | `success`; jobs `verify` and `browser` both `success` |
| `verify` job | lint, typecheck, build and `npm test` passed (scripts 54/54); integration **436 passed, 9 skipped** of 445 in 44 files |
| `browser` job | `npm run test:e2e`: **87 passed** (6.0 min) |

- The 9 skipped integration tests are `backup-restore.integration.test.ts`: the file skips itself unless
  `RESTORE_DRILL_ADMIN_URL` is set, and CI does not set it. The local run above executed them (445 of 445).
- **Not covered by the hosted run:** the commits after `83f804f`, which are `fb20668` (a test-only change to two
  profile test files, for CRLF checkouts) and `6550a81` (the first version of this report). The diff from
  `83f804f` to `fb20668` touches no application code.
- This is one run of one commit. It does not show stability across runs, and it is not production, device or
  real-provider evidence.

## Carried forward, not re-run in this closeout

Same working tree and same day, but earlier commands:

| Evidence | Result | Where it comes from |
|---|---|---|
| `npm run deploy:verify` (Docker Desktop, self-signed, localhost) | exit 0; `accessLogCanariesFound` 0, `errorLogCanariesDuringProbe` 0, `apiLogCanariesFound` 0, callback path and status observable on HTTP and HTTPS, `errorLogQueryExposedOnNginxError` **true** | earlier session turn; commit `2f7e293` had deferred it |
| `npm run verify` (lint, typecheck, build, unit tests) | exit 0; scripts 54, API 1324, web 568, contracts 129, fixtures 14, simulator 3 | earlier session turn, tree identical to HEAD `fb20668` |
| LF and CRLF give identical profile-test results; removing the Mapbox build arg fails the two Mapbox assertions under both | 19/19 clean, 17/19 mutated, both endings | scratch copies, earlier session turn |
| Mapbox token reaches the shipped bundle (unique fake token found; omitted token compiles to `accessToken:null`) | pass | stated in the message of `5de985b`; not reproduced here |

## Remaining limits

- **Workstation execution of this closeout.** The commands above ran on one Windows 11 machine with Docker Desktop
  and loopback addresses. The only hosted evidence is the single Ubuntu CI run of `83f804f`; the current HEAD has no
  hosted run of its own.
- **Remote deployment.** Nothing was deployed. `deploy:verify` used throwaway secrets and a self-signed certificate on
  localhost, so there is no real host, DNS name or certificate authority behind any result here.
- **Real devices.** Chromium only, with the Simulator standing in for GPS. Safari, Firefox, mobile browsers and real
  device location, permission and background behaviour are unverified.
- **Real identity provider.** Sign-in was exercised only against the test `oidc-provider` process and, in
  `deploy:verify`, against an unreachable issuer that must fail closed. Provider-specific behaviour is unverified.
- **Browser fencing coverage.** Stale-writer fencing of `abandonQueuedStart` (a stale writer, a different request or an
  active run writes nothing) is covered by unit tests on `fake-indexeddb`. No browser test drives a stale writer
  against the abandonment of a rejected Start.
- **Real Mapbox rendering.** No run in this cycle rendered a map with a real token. Token propagation was checked by
  finding a fake token in the built bundle; scope and URL restrictions are a provider-side setting.
- **Nginx error-log query exposure** (as of 2026-10-15; closed on 2026-10-22, see the update at the top and
  ADR-0062). nginx writes its own error entries with the full request line and upstream URI.
  `deploy:verify` provoked one (a 413) and the callback query appeared in it. This was documented in the deployment
  runbook and was not fixed at the time: the access log was query-free, the error log was not.

## Test-resource state

- E2E: the two suite users (`eeeeeeee-eeee-4eee-8eee-eeeeeeee000{1,2}`) and every scenario row are gone (0 rows);
  no process listens on the E2E ports (3100, 3101, 5273, 5274, 9100).
- Integration: the test database keeps the integration suite's fixed seed from its last file (7 users, 2
  organizations, 8 memberships, 8 runs, all fixed-ID rows written when that suite finished). That is the suite's
  normal end state and it re-seeds itself; it was left in place.
- `tests/e2e/test-results/` holds Playwright's artifact for the intentional harness failure; the directory is git-ignored.
- The dev PostgreSQL container and its volume were not changed. A stopped Docker Desktop had been started earlier.
