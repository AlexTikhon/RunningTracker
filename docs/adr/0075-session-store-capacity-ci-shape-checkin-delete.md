# ADR-0075: Session store at capacity, the CI workflow's shape, and deleting a check-in day

- Status: accepted; implemented and verified locally (the workflow has not run on a hosted runner)
- Date: 2026-11-06
- Amends: ADR-0074 ("no delete control" in the web Check-in tab is lifted; the API is unchanged). Relates to ADR-0007 (the
  capacity behaviour of the in-memory session store is now an explicit, tested decision, unchanged in behaviour).
- Scope: `.github/workflows/ci.yml`, `scripts/ci-workflow.test.mjs`, `tests/e2e/support/suite-config.ts` (reporter),
  `apps/api/src/auth` (tests only), `apps/web` (Check-in delete control), README, docs. No new dependency, no migration.

## Decision 1: at capacity the session store evicts expired sessions, then refuses (503); it never evicts a live one

The question asked: what should the in-memory session store do when it is full? The rule given with it: **if demo
sign-in is enabled in any deployed environment, evict expired and then the oldest sessions instead of answering 503.**

**Finding: demo sign-in cannot be enabled in a deployed environment.** Demo sign-in is `POST /api/session`, which exists
only with `LOCAL_AUTH_ENABLED=true`.

- `validateEnvironment` refuses `LOCAL_AUTH_ENABLED=true` with `APP_ENV=production` (`environment.spec.ts`,
  "LOCAL_AUTH_ENABLED must be false in production"). The API does not start.
- The only deployment profile, `infra/compose/docker-compose.production.yml`, sets `APP_ENV: production` and
  `LOCAL_AUTH_ENABLED: "false"`, both pinned by `scripts/production-profile.test.mjs`.
- The profiles that do enable it are local: the development `.env`, `npm run demo:up`, the browser suite, and the
  transport profile (`docker-compose.transport.yml`, `APP_ENV=development`, `https://localhost:8443`, loopback only).
  There is no hosted demo configuration in the repository.

So the condition is false. The decision is to **keep fail-closed**:

1. On every insert the store first evicts every record whose `expiresAt <= issuedAt` of the new session (this was
   already the behaviour).
2. If it is still full of live sessions, it refuses: `503 SESSION_STORE_UNAVAILABLE` for the local endpoint, and the
   OIDC callback redirects with `sign_in_error=unavailable`. No live session is evicted, the oldest included.
3. Replacing a record under the same digest, and revocation (sign-out), behave as before.

Why not evict the oldest live session in production: the only deployed source of sessions is OIDC sign-in by a
provisioned member. With oldest-eviction, one member signing in repeatedly (`SESSION_STORE_MAX_ENTRIES` times, 100 by
default) would silently sign every other member out, and the victims would see a 401 mid-task with no explanation.
Fail-closed limits the same abuse to "new sign-ins wait", which is loud (a logged refusal, a visible message), recovers
on its own as sessions expire, and never takes away a session someone is using. Demo sign-in is different, because
anyone who can reach it can create sessions, so filling the store would lock out the demo; that is why the rule above
would switch to eviction if demo sign-in were ever deployed.

**Revisit trigger:** a deployed environment with `LOCAL_AUTH_ENABLED=true`. That needs `APP_ENV` other than
`production` on a deployed host, or removal of the config guard, and either change fails the two tests above first.

New tests (no behaviour change): `apps/api/src/auth/session-store.spec.ts` (7) pins expired-first eviction, the `<=`
boundary, refusal without evicting live sessions, same-digest replacement, revocation freeing a slot, and recovery as
sessions expire. `oidc-http.spec.ts` gains one test for the OIDC callback at capacity. Two mutations were checked red
(see docs/progress.md).

### Options considered

| Option | For | Against |
|---|---|---|
| **Expired first, then 503** (chosen, unchanged) | Never revokes a session in use; abuse is visible and self-healing | A full store blocks new sign-ins until sessions expire or are revoked |
| Expired first, then the oldest | New sign-ins always succeed | Lets one member sign everyone else out silently; the rule above reserves it for a deployed demo sign-in, which does not exist |
| A shared store (database or Redis) with no cap | Survives restarts; a cap set by storage | New infrastructure; out of scope (ADR-0046 already notes a shared store was not built) |

## Decision 2: the CI workflow's shape

`.github/workflows/ci.yml` already existed (one `verify` job that also ran the integration suite, and a `browser`
matrix). It is restructured:

1. **`verify`**, the gate: `npm ci`, `npm run verify`, npm cache, no database. Every other job `needs: verify`, so a
   lint, type, unit or build failure stops the run before any database or browser work.
2. **`integration`**, in parallel with 3: a PostGIS service container with **the same image and digest as
   `infra/compose/docker-compose.yml`**, the same `POSTGRES_DB` and superuser, and the test database created by **the
   same init script** compose mounts (`db/test-support/20-create-test-database.sql`). Then `db:bootstrap:test`,
   `db:migrate:test`, `test:integration`. A step asserts PostgreSQL 17 and the test database's extension set
   (`plpgsql,postgis`).
   - Found: the previous workflow set `POSTGRES_DB=running_tracker_test`. The image's entrypoint installs postgis,
     postgis_topology, fuzzystrmatch and postgis_tiger_geocoder into `POSTGRES_DB`, so the CI test database had four
     extensions the local one does not (checked against the local container: `running_tracker` has all five, the
     compose-created `running_tracker_test` has `plpgsql` and `postgis`). CI now matches local.
   - The restore drill (9 tests) is configured instead of skipped: the drill URLs point at the service, pg_dump and
     pg_restore run inside the service container (`BACKUP_PG_DOCKER_CONTAINER`, so the client is PostgreSQL 17 like
     the server), and the backup key is generated in the job (`backup:keygen`), never stored.
3. **`e2e`**, in parallel with 2: the Chromium suite (`chromium` and `chromium-oidc` projects) in three shards,
   each its own runner and PostGIS service. Every shard uploads a blob report (one day); **`e2e-report`** runs only
   when a shard failed, merges them into one HTML report (traces and screenshots of failed tests included) and uploads
   `playwright-report-chromium` (14 days).
4. **`e2e-firefox`** is kept from the previous workflow (the 18-test `firefox-core` gate), also after `verify` and in
   parallel. It was not asked for; it is kept so the restructure removes no existing check.

No secret is read (`scripts/ci-workflow.test.mjs` fails on any reference to the secrets context); every credential is a
fixed test-only value for a database that exists only inside the job. `permissions: contents: read`. A newer push to the
same pull request cancels the older run.

**Shard count: 3.** One full local run (132 tests, 13.8 min wall, 810 s of test time over 31 files, the longest file
80 s) gives, with Playwright's own file assignment (`--list --shard`), a longest shard of about 409 s for 2 shards, 291 s
for 3 and 243 s for 4. A CI shard also spends roughly 3 to 4 minutes on checkout, `npm ci`, two package builds,
migrations and the browser install. Two shards would be about 10 to 11 minutes; three is the smallest count expected
under ~10 minutes; four saves under a minute for one more runner and database. The three shards were then run
separately with `CI=1`: 47, 43 and 42 tests passed in 331, 261 and 304 s wall each (servers included), and their three
blobs merged into one HTML report. Raise the matrix to `[1, 2, 3, 4]` if hosted shards approach the 15-minute timeout.

Two problems were found by replaying the integration job against a fresh container configured like the service:
`backup:keygen` imports the built contracts package, which nothing had built yet on a fresh runner (an explicit build
step now precedes it), and the default socket health check passed against the image's temporary initdb server, which
then shut down under the first `psql` (the services now check over TCP, which that temporary server does not listen on).
Both are pinned by `scripts/ci-workflow.test.mjs`.

## Decision 3: deleting a check-in day in the web UI

- The control is on the day shown in the form, not on each history row: the history's Edit button already brings any
  day into the form, and the form is where the day's state (loaded, saving, uncertain) lives.
- It appears only for a loaded day with a record. **Delete check-in** opens an inline confirmation (permanent, cannot be
  undone) with **Confirm delete** and **Cancel**, the same pattern as deleting an activity (ADR-0072).
- The request runs in `CheckInDayController`, which now allows **one mutation at a time**: while a save or a deletion is
  pending, the other is refused and so is another date, so an answer always belongs to the date it was sent for.
- `DELETE /daily-metrics/{localDate}` answers 204 for every case, so an unknown outcome says "Deleting again is safe";
  401, 403 and other definitive 4xx say the check-in was not deleted. The stored values stay on screen after a failure.
- After a confirmed deletion: the form is empty ("Nothing recorded for … yet."), the status says "Check-in deleted.",
  the 14-day history reloads, and focus moves to the page heading. The erasure ledger records the deletion (ADR-0073),
  as for any API deletion.

## Consequences

- The integration job now runs the restore drill, which the previous hosted run skipped; a drill failure in CI is new
  signal, and it makes that job slower.
- The PostGIS image is now written in four places (compose and three jobs); the workflow test fails if any differs.
- Not established: the workflow has not run on GitHub. actionlint 1.7.7 reports no error, the structure tests pass, and
  the shard split, the merge step and the drill configuration were exercised locally only.
