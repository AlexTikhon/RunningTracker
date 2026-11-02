# Finished-run review freeze (2026-11-02)

Base: `9d20877978a045aedc3854be71cd43fe77eafdaf`. This report accompanies the single
ADR-0068 commit on that base. The project pauses after this slice as a local demo/portfolio application.

## Architectural conclusion and scope

Keep React, the Express modular monolith and PostgreSQL/PostGIS. The review followed composition,
tenant/session authorization, durable recording and upload, summary publication, live/archive access,
retention/recovery and delivery boundaries; the source references and deferred findings are in the
[architecture review](architecture-review-2026-11-02.md). This is a review of architectural flows,
not a line-by-line proof of every source file or concurrent interleaving.

The last commit, `9d20877`, added owner finished-run details from My runs. This slice completes the
adjacent journey: **Finish → View result → Back to Runner → New run**. It completes the existing
uncommitted result-navigation work rather than adding a separate product feature.

- Result navigation preserves the durable run pointer, queued command identities and buffered points;
  the uploader stays owned by App while the Runner presentation is hidden.
- Device synchronization is distinct from summary publication. Pending/rejected/unsettled upload,
  loss of the writer or a detail read older than acknowledged upload revisions hides route/metrics.
- A restored finished run and a finished run seen offline need a fresh authoritative read before
  result entry. Existing numbered attempts and snapshot merging remain in use; capture stays stopped.
- Session/scope changes and navigation end the result/read/map lifetime. Archive details retain their
  existing search context, applied units and timezone. Refresh remains explicit.

No API, contract, SQL/migration, retention/algorithm, dependency/lockfile, environment or deployment
configuration changes. The E2E helper invokes existing production calculation/publication SQL on
one guarded scenario run; it does not substitute ready metrics or change application SQL.

## Fresh local verification

Windows, Node 24.11.1, npm 11.6.2. A read-only preflight checked live owner/runtime/maintenance
connections: all use `running_tracker_test` and their expected roles; 25 migrations are present.
No bootstrap/migration, development-database reset or environment edit was performed.

| Check | Result |
|---|---|
| Authority regressions before the correction | 2 failed / 48 passed; both new failures reproduce finished-run confirmation gaps |
| Focused web tests after the correction: `runner-authority`, `run-result-sync`, `RunnerView` | 88 passed in 3 files |
| `npm run verify` | Exit 0: lint, all workspace typechecks including E2E, 2,436 tests and production builds |
| Sequential Chromium regression | Exit 0: 33 passed in 9 spec files, 5.5 min, retries 0 |
| Visual inspection | Fresh 375 px result screenshot and real Mapbox runtime route screenshot inspected; viewport overflow assertion passed |
| Final whitespace/link/source checks | Passed: 18 changed/new files, 48 relative file links; all 10 changed TypeScript implementation/test files match the fingerprints taken before browser execution |

The 2,436 tests comprise scripts 83, API 1,332, web 860, contracts 144, fixtures 14 and simulator 3.
The existing Mapbox chunk-size warning remains; the build succeeds.

Browser command:

```text
npm run e2e --workspace=@running-tracker/e2e -- --project=chromium finish-result.spec.ts run-details.spec.ts record.spec.ts reload-offline.spec.ts runner-recovery.spec.ts lifecycle-takeover.spec.ts new-run-takeover.spec.ts second-tab.spec.ts sign-out.spec.ts
```

The final browser run starts after `verify`, with no workspace builds or source mutations in parallel.
Earlier attempts overlapped builds/source changes, including another active session in this checkout,
and are excluded as final evidence. Its abandoned browser process tree was stopped after the user
stopped the other session. Current logs/screenshots are ignored local artifacts under `.local/`:
`freeze-authority-before.log`, `freeze-focused.log`, `freeze-verify.log`, `freeze-e2e.log`,
`finish-result-mobile.png` and `run-details-real-map.png`. Changed TypeScript sources/tests are fingerprinted before this
browser run and compared again before delivery.

## Freeze boundary

[The handoff](../pause-handoff.md), README and implementation plan now agree that work stops after
ADR-0068. Historical verification records retain their dates and tested snapshots. In particular,
the earlier 478-test integration run and the October full browser/Firefox/smoke matrix are not fresh
coverage of this slice. A separate integration run is not required for this web-only change.

Not run in this closeout: full Chromium/OIDC, Firefox, Safari, physical-phone GPS, real identity/map/
inference providers, hosted CI or deployment verification. Synthetic viewport and local empty-style
Mapbox-runtime checks do not establish physical-phone capture or a provider basemap.

Deferred until explicitly resumed: real GPS measurements; durable sessions and maintenance deadlines,
bounded retries/fairness before unattended participant use; actual HTTPS/OIDC/basemap and off-host
backup/restore evidence before a hosted pilot. No further product work is required for this freeze.
Delivery is one local commit with no push, provider provisioning or deployment.
