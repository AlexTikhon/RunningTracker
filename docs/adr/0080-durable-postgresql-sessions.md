# ADR-0080: Authenticated sessions in PostgreSQL, kept across an ordinary API restart and never across a restore

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including the restore drill
  and a real API process restart, Chromium end-to-end). Hosted CI: see the final report of the change.
- Date: 2026-11-08
- Supersedes: the in-memory session store of ADR-0007 for the API process. Keeps ADR-0075's capacity policy (expired
  first, then refuse; never evict a live session) and ADR-0054's client rules (only a 401 ends a confirmed session).
- Relates to: ADR-0046 (OIDC sign-in, which ends in the same session record), ADR-0023 (live stream authorization
  checkpoints), ADR-0044/0045/0073 (backup, restore order and journals).
- Scope: migration 0036, `apps/api/src/auth` (async store boundary, `PostgresSessionStore`), the session, OIDC, run
  interpretation and live-stream callers, `main.ts`/`app.ts` composition, a maintenance purge, the backup dump options,
  `restore:clear-sessions`, the restore drill, tests, docs. No Redis, JWT, refresh token, new identity provider,
  session-management UI, or change to the session protocol (cookie, CSRF, Origin checks, TTL).

## Context

Sessions lived in a bounded `Map` inside the API process. Every restart or redeploy signed everyone out, and two API
processes could not share a sign-out. The goal of this slice is narrow: **a signed-in browser's existing cookie keeps
working after an ordinary API restart, until its original expiry or a committed revocation**, using the PostgreSQL the
service already has.

## Decision 1: one private table, reached only through narrow functions

`app_private.auth_sessions` holds exactly what the current protocol needs:

| Column | Why |
|---|---|
| `token_digest` (PK) | SHA-256 of the opaque bearer token, base64url, as before. The raw token never reaches the database. |
| `user_id` | The identity; `REFERENCES users ON DELETE CASCADE`, so a removed user has no session. |
| `csrf_token` | `GET /api/session` returns it, so it must be retrievable. It is useless without the cookie. |
| `issued_at`, `expires_at` | Absolute TTL from issue (`SESSION_TTL_MS`, at most 24 h, also a table constraint). |

Nothing about the device, address or provider token is stored.

**Privileges.** No application role has any table privilege (`REVOKE ALL`), and row-level security is enabled with no
policy as a second barrier. Access is through `SECURITY DEFINER` functions with `search_path = pg_catalog`:

| Function | Granted to | What it can do |
|---|---|---|
| `create_auth_session(digest, user, csrf, issued, expires, capacity)` | runtime | Insert one session for a provisioned user under the capacity rule. Never replaces an existing digest, so it cannot move a session to another identity. Returns `created`, `at_capacity`, `unknown_user` or `duplicate`. |
| `read_auth_session(digest, now)` | runtime | Return the one session stored under exactly that digest if it expires after `now`. |
| `revoke_auth_session(digest)` | runtime | Delete the one session under that digest. |
| `purge_expired_auth_sessions(now, limit)` | maintenance | Delete at most `limit` (1..1000) already-expired rows. |
| `clear_auth_sessions()` | nobody (owner only) | Delete every row; run at restore while the database is closed. |

So the runtime role can neither list nor count sessions, nor read one without already holding the token whose digest
it is, nor change a stored session's identity. It can create a session for any provisioned user, which it could
already act as (the runtime role sets the tenant identity of every transaction); that trust boundary is unchanged.
Health-data RLS is untouched. Tested in `test/postgres-session-store.integration.test.ts` (every direct
`SELECT/INSERT/UPDATE/DELETE` by runtime and maintenance fails with 42501; the exact EXECUTE grants are pinned; a
`duplicate` attempt leaves the victim's session as it was) and re-checked by the restore drill's readiness checks.

## Decision 2: capacity is per database, serialized, and still never evicts a live session

`SESSION_STORE_MAX_ENTRIES` (default 100, max 10,000) now caps the **shared** store: every instance on one database
should use the same value. Each `create_auth_session` takes one transaction-scoped advisory lock, removes at most 100
rows already expired at the new session's issue instant, counts the live rows, and refuses at capacity. The lock makes
concurrent sign-ins on any number of instances count one after another: 24 racing creations across three pools with 8
free slots admit exactly 8 (a mutation without the lock admitted 11-12, three runs out of three). The total row count
stays bounded by the capacity (expired rows are removed at least as fast as new ones are added). A maintenance task
(`SESSION_PURGE_INTERVAL_MS`, default 15 minutes, 500 rows per cycle) removes expired rows in between; sign-in does not
depend on it.

A local sign-in for an unprovisioned user is now refused (`403 LOCAL_IDENTITY_DENIED`), because a session row needs its
user; the OIDC path only ever creates sessions for resolved users.

## Decision 3: asynchronous boundary, no cache, no fallback, and outages are not refusals

`SessionStore` and `SessionManager` are asynchronous. `PostgresSessionStore` runs one autocommit statement per call
on the runtime pool, bounded as a whole (checkout included) by `SESSION_STORE_TIMEOUT_MS` (default 2 s); on the deadline
the connection is destroyed rather than returned. Every failure to get an answer becomes
`SessionStoreUnavailableError`. There is **no positive cache** (every authenticated request asks the database, so a
committed sign-out is seen by the next request on any instance) and **no fallback** to memory. `createApp` now requires
a session manager; `main.ts` wires the PostgreSQL store, and tests pass an explicit in-memory one
(`src/testing/in-memory-sessions.ts`), which follows the same contract (`test/support/session-store-contract.ts` runs
against both).

| Situation | Answer |
|---|---|
| Valid session | as before |
| Unknown, revoked or expired (from the expiry instant on, against the instance clock) | `401 AUTH_REQUIRED` |
| Store unreachable, timed out or failing | `503 SESSION_STORE_UNAVAILABLE`, `Retry-After: 5`, **no `Set-Cookie`**: no access, and the browser keeps its cookie and its last confirmed session (ADR-0054 treats a 503 as "could not ask") |
| Sign-out whose delete did not commit | `503`, cookie **not** cleared; the web app says "Could not sign out … You are still signed in." Only a committed delete answers `204` and clears the cookie |
| Sign-in whose insert failed | local `503` / OIDC `sign_in_error=unavailable`; no cookie |

Every caller awaits: authentication middleware, `GET/POST/DELETE /api/session`, the OIDC callback, the run
interpretation's last check (an outage there is a 503, not the interpreter's 500, and never the proposal), and the
live stream. Boundaries that only accept a resolved `true` (`=== true`) make sure a Promise or any other value never
counts as active; `@typescript-eslint/no-misused-promises` and the compiler reject a Promise in a condition.

Secrets in logs: the store's errors carry only a fixed message and a short code (SQLSTATE or Node network code);
`describeError` logs name and code only. A real-process test checks that no process output contains the cookie, the CSRF
token or a database URL with a password.

## Decision 4: live streams check the store once per poll cycle, fail closed, and hold no connection

The hub used to ask the in-memory store synchronously on every publish, drain and heartbeat. Now:

- Opening a stream asks the store before and after the initial read (as before, now awaited); an outage rejects the
  opening with 503 before any header is sent. The connection limit counts openings from before the first check, so
  concurrent openings waiting on the store cannot overshoot it.
- Each poll cycle starts with one store question per distinct open session (two tabs of one session share it), at most
  `LIVE_SSE_POLL_CONCURRENCY` at a time, each bounded by the store deadline. Only connections whose session is confirmed
  receive that cycle's state. `false`, a rejection or anything but `true` closes all that session's connections; an
  outage is logged as a count only (`live.session_check.failed`).
- Checks never overlap: the poll is single-flight and so is the check; a slow store delays the cycle instead of
  stacking questions. No database connection is held between checks or for a stream's lifetime.
- Heartbeats (comment lines, no private state) and drains (the latest cycle's pending state, already checked) no longer
  ask the store. The exact expiry timer still closes a stream at `expiresAt`.

**Bound:** private delivery stops no later than the first poll cycle that starts after the revocation is committed,
that is within `LIVE_SSE_POLL_INTERVAL_MS` (default 2 s) plus one cycle, on every instance. Before, a same-process
sign-out took effect at the next publish or heartbeat, which is no earlier.

## Decision 5: restart keeps sessions; restore never does

- **Restart.** Nothing about sessions is in the process, so a new process accepts the same cookie until its original
  expiry; the TTL is not extended. Proven with real processes (`test/session-restart.integration.test.ts`: sign in on
  the real entrypoint, stop it, start a new process on the same database, the kept cookie returns the same identity,
  CSRF token and expiry; a sign-out there holds in the next process). With the in-memory store swapped back in, the
  same test fails with 401.
- **Backup.** `pg_dump` runs with `--exclude-table-data=app_private.auth_sessions` (`BACKUP_EXCLUDED_TABLE_DATA`): the
  schema is kept, the rows never are. Older databases without the table are unaffected (the pattern matches nothing).
- **Restore.** A new step, `npm run restore:clear-sessions` (owner, `RESTORE_DATABASE_URL`), runs after the erasure
  replay and before the database is reopened. It calls `clear_auth_sessions()`, verifies nothing remains, and prints
  counts only. It exists for dumps the application did not make (an older tool, a hand-made `pg_dump`) that may carry
  session rows, including revoked ones. The drill has a new recovery step `sessions_cleared` and checks
  `sessions-not-in-backup`, `sessions-cleared-before-reopening`, `session-store-denied-to-application`.
- Proven in `test/backup-restore.integration.test.ts` at the current schema: two sessions on the source, a dump that
  kept session rows and then a sign-out, then an application backup. Restoring the application backup gives an empty
  table; restoring the carrying dump brings the revoked session's row back until `restore:clear-sessions` removes
  all three. In both cases, once opened, the valid and the revoked cookie get 401, a new sign-in works, and the health
  data (runs, activities, check-ins, movement) equals the source at backup time. The previous-schema drill restores a
  backup from before migration 0036, so its table is created empty by the catch-up migration; no artificial migration
  was added to change that.

## Explicit boundaries

- **Pending OIDC logins stay process-local** (`OidcLoginStore`). A login started before an API restart cannot complete
  after it: the callback answers `sign_in_error=login_expired` and the person starts again. With several instances,
  the callback must reach the instance that started the login, so **multi-replica OIDC is not ready**; making the
  pending-login transaction durable is a separate slice.
- Other process-local state is unchanged: the sign-in rate limit, the run-search admission limits, the weekly insight
  queue, the archive tile cache, metrics.
- Expiry is judged by each instance's clock (as before); instances need synchronized clocks.
- A disabled provider account keeps its application session until it expires or is signed out; a restart no longer
  ends it. Deactivate the membership, or lower `SESSION_TTL_MS` (ADR-0046's advice still applies).
- No session list or "sign out everywhere" exists; an operator can end every session with the owner-only function.

## Options considered

| Option | For | Against |
|---|---|---|
| **PostgreSQL table + narrow functions** (chosen) | Existing infrastructure, transactional sign-out visible to all instances, privileges in the database | One query per authenticated request (a primary-key lookup) |
| Grant the runtime role `SELECT/INSERT/DELETE` on the table | Simpler SQL | The runtime could enumerate every session and rewrite identities |
| A positive cache in front of the store | Fewer queries | Hides a sign-out committed on another instance until the cache expires |
| Fall back to memory when the database is down | Sign-in "works" during an outage | Sessions that vanish later and are invisible to other instances; the database is down for every other request anyway |
| Redis / signed tokens (JWT) | Common patterns | New infrastructure, or revocation that needs a server-side list anyway; out of scope |

## Consequences

- Every authenticated request adds one short query to the runtime pool; a database outage now also stops
  authentication, with 503 rather than 401.
- The three e2e API processes share the test database's store, so the harness gives all of them the raised cap and
  empties the table at global teardown.
- `SESSION_STORE_TIMEOUT_MS` and `SESSION_PURGE_INTERVAL_MS` are new optional settings with defaults.
