# ADR-0081: Pending OIDC logins in PostgreSQL, single use across instances, never across a restore

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including the restore drill,
  real API processes behind one external origin with a real loopback identity provider, Chromium end-to-end). Hosted
  CI: see the final report of the change.
- Date: 2026-11-08
- Supersedes: the in-memory `OidcLoginStore` of ADR-0046 and the "pending OIDC logins stay process-local" boundary of
  ADR-0080. Keeps ADR-0046's protocol (authorization code, PKCE S256, `state`, `nonce`, ID-token validation, the Lax
  login cookie, the configured callback URL, provisioning by `<issuer>|<subject>` only) and ADR-0075's capacity policy
  (expired first, then refuse; never evict a live entry).
- Relates to: ADR-0080 (sessions in PostgreSQL; the same table/function pattern, deadline and outage semantics),
  ADR-0044/0045/0073 (backup, restore order and journals).
- Scope: migration 0037, `apps/api/src/auth` (async `PendingLoginStore`, `PostgresPendingLoginStore`, the OIDC
  routes), `main.ts`/`app.ts` composition, a maintenance purge, the backup dump options, `restore:clear-sessions`, the
  restore drill, tests, docs. No sticky sessions, Redis, new identity provider, change to the session protocol, or
  authentication redesign.

## Context

A sign-in is two requests: `/api/auth/login` stores the PKCE verifier, `state` and `nonce` and redirects to the
provider; `/api/auth/callback` needs them back to exchange the code. They lived in a `Map` inside the API process, so
an API restart between the two requests failed the sign-in (`login_expired`), and with two instances the callback had
to reach the one that started it. The goal of this slice: **a login started before an ordinary restart completes after
it, and a login started on instance A completes on instance B with the same database and the same OIDC
configuration.**

## Decision 1: one private table, reached only through narrow functions

`app_private.oidc_pending_logins`:

| Column | Why |
|---|---|
| `login_digest` (PK) | SHA-256 of the opaque login identifier (the login cookie), base64url. The identifier never reaches the database. |
| `created_at`, `expires_at` | Absolute lifetime from the reservation instant (`OIDC_LOGIN_TTL_MS`, at most one hour, also a constraint). |
| `code_verifier`, `oidc_state`, `oidc_nonce` | Empty for a reservation; all three once completed (a constraint). Bounded URL-safe text. |

Nothing about the person, the device, the address or any provider token is stored.

**Privileges.** As in ADR-0080: no application role has a table privilege, row-level security is on with no policy,
and access is through `SECURITY DEFINER` functions with `search_path = pg_catalog`:

| Function | Granted to | What it can do |
|---|---|---|
| `reserve_oidc_login(digest, at, until, capacity, replaced_digest)` | runtime | Reserve one attempt under the capacity rule (Decision 4). Returns `reserved`, `at_capacity` or `duplicate`; never replaces an existing digest. |
| `complete_oidc_login(digest, verifier, state, nonce, now)` | runtime | Store the material on that digest's live, uncompleted reservation. Never touches `expires_at`; never overwrites a completed or consumed attempt. |
| `consume_oidc_login(digest, now)` | runtime | Delete that digest's row and return its material only if it was completed and is live. |
| `cancel_oidc_login(digest)` | runtime | Delete that digest's row. |
| `purge_expired_oidc_logins(now, limit)` | maintenance | Delete at most `limit` (1..1000) expired rows. |
| `clear_oidc_pending_logins()` | nobody (owner only) | Delete every row; run at restore while the database is closed. |

The runtime role cannot list, count or read attempts, nor reach one without already holding the identifier whose
digest it is. Pinned in `test/postgres-pending-login-store.integration.test.ts` (every direct statement by runtime
and maintenance fails with 42501; the exact EXECUTE grants and return types are pinned; guessed digests, a
completion over the victim's material and a duplicate reservation leave the victim's attempt intact) and re-checked
by the restore drill (`pending-login-store-denied-to-application`).

**Material at rest.** The verifier, `state` and `nonce` are stored as generated, for at most the login lifetime. They
are needed in the clear to complete the exchange, and they are useless without the authorization code the provider
sends only to the browser and the client secret the token request requires (confidential client). They are not
encrypted with an application key: that would add key management without protecting against the role that can read
the table (the owner), and the runtime role cannot read them at all. They are never logged and never in backups.

## Decision 2: the lifecycle is kept, and every step is awaited

| Step | When | Store call |
|---|---|---|
| Reserve | `/login`, **before** provider discovery, so a full store never starts provider work | `reserve(previousCookie)` |
| Complete | `/login`, after `beginLogin()` produced the material | `completeReservation(id, material)`; `false` (expired during discovery, or replaced/used meanwhile) answers 503 as before |
| Cancel | `/login`, on any failure after a reservation | `cancel(id)`; a failed cancel is logged (`auth.login.cancel_failed`) and the reservation expires by itself |
| Consume | `/callback`, **before any provider work** | `consume(id)` |

A reservation's expiry is fixed at reservation time; completion never extends it. Incomplete, expired, unknown and
malformed attempts are never returned, so they never reach the token exchange (`login_expired`). The login cookie is
cleared on every callback answer. No database connection or transaction is held across discovery or the token
exchange: each store call is one autocommit statement.

## Decision 3: atomic single use, at most once

`consume_oidc_login` deletes the row in the statement that returns it. Two callbacks for one login on any number of
instances: the first DELETE locks and removes the row, the second finds nothing. At most one receives the material,
so at most one token exchange happens. Shown with six consumers on three pools queued on the row lock (exactly one
winner), ten unsynchronized rounds, and with real processes: the same callback sent to two instances at once gives one
200, one `login_expired`, one session and exactly one token request at the provider.

**At most once, not exactly once.** If the process dies after the consume committed, or the consume's answer is lost
(the store deadline expired while the DELETE may still have committed), the attempt is gone or uncertain: the callback
answers `unavailable`, the exchange is never attempted and never retried, and the person starts a new sign-in. The
provider's code is then simply unused. Exactly-once completion would need the exchange and the session creation to be
recoverable after a crash, which is out of scope.

## Decision 4: capacity is shared, serialized, and never evicts a live attempt

`OIDC_STORE_MAX_ENTRIES` (default 100, at most 10,000) now caps the **shared** store: every instance on one database
should use the same value. `reserve_oidc_login` takes one transaction-scoped advisory lock, removes the browser's own
previous attempt (the digest of the login cookie it presented; this is cancellation by its holder, as before, not
eviction), removes at most 100 rows already expired at the reservation instant, counts live rows (**reservations and
completed attempts alike**) and refuses at capacity. 24 racing reservations on three pools with 8 free slots admit
exactly 8; with the lock removed (and a 20 ms widening of the race window) the same test fails. A maintenance task
removes expired rows in batches of 500 every `SESSION_PURGE_INTERVAL_MS`; sign-in does not depend on it.

**The batch bounds are plan-independent.** Both cleanups choose their batch once in a `MATERIALIZED` CTE (ordered by
expiry, then digest) and delete by join. The first version used `DELETE ... WHERE digest IN (SELECT ... LIMIT n FOR
UPDATE SKIP LOCKED)`, the pattern of migration 0036: one full integration run failed because the purge reported more
than its limit. The mechanism was then reproduced directly: under a nested-loop semi join that re-runs the subquery
per outer row, `LockRows` skips rows the statement already deleted and each rescan returns new ones, so 700 tied rows
were all deleted with a limit of 500. The exact plan of the failed run was not captured. A regression test forces
that plan through session planner settings and requires exactly 100 and 500.

## Decision 5: asynchronous boundary, no cache, no fallback, outages are not expiry

`PostgresPendingLoginStore` bounds each call, checkout included, by `SESSION_STORE_TIMEOUT_MS` (the same deadline as
the session store; no new setting) through the deadline helper extracted unchanged from `PostgresSessionStore`
(`database/bounded-statement.ts`); on the deadline the connection is destroyed. Every failure becomes
`OidcLoginStoreUnavailableError`. `createApp` refuses an OIDC configuration without an injected store; `main.ts`
wires PostgreSQL; unit tests pass `InMemoryPendingLoginStore` (`src/testing`), which follows the same contract
(`test/support/pending-login-store-contract.ts` runs against both).

| Situation | Answer (unchanged UX unless noted) |
|---|---|
| Login: store full | `503 LOGIN_TEMPORARILY_UNAVAILABLE`, log `reason: store_full` |
| Login: store cannot answer | `503 LOGIN_TEMPORARILY_UNAVAILABLE`, `Retry-After: 5`, no login cookie, provider not contacted; log `reason: store_unavailable` (new) |
| Callback: no cookie, unknown, malformed, incomplete, expired or already used | `sign_in_error=login_expired` |
| Callback: store cannot answer, or the consume outcome is uncertain | `sign_in_error=unavailable`; no token exchange; the cookie is cleared (new: was impossible in memory) |
| Callback: provider outage | `sign_in_error=unavailable` (the attempt is already consumed) |

Logs carry only the outcome, the error name and a short code (SQLSTATE or Node network code): never a login
identifier, digest, code, verifier, state, nonce, cookie, token or credential. Checked in route specs and in every
real-process scenario's output.

## Decision 6: one OIDC configuration for every instance

The callback builds the token request's redirect URI from `OIDC_REDIRECT_URI` plus only the query the provider sent
back, never from `Host` or forwarded headers, and discovery uses `OIDC_ISSUER_URL`. A login completes on another
instance only if that instance has the same issuer, client ID, client secret and external redirect URI (and a
synchronized clock, since expiry is judged by each instance's clock, as for sessions). The redirect URI must name the
stable external origin (the reverse proxy), not an instance.

## Decision 7: restart keeps pending logins; restore never does

- **Restart.** Nothing about a pending login is in the process. Proven with real processes behind one external
  origin (`test/oidc-login-restart.integration.test.ts`): a login started, the process stopped, a new process started,
  the callback completes and the session works. With the in-memory store swapped back into `main.ts`, the restart and
  A-to-B scenarios fail.
- **Backup.** `pg_dump --exclude-table-data=app_private.oidc_pending_logins`: schema kept, rows never.
- **Restore.** The existing step `npm run restore:clear-sessions` now clears both kinds of temporary authentication
  state. **Compatibility decision:** the command keeps its ADR-0080 name, arguments, owner check and its first three
  output lines (`database`, `sessions cleared`, `sessions remaining`), so runbooks and scripts keep working; it adds
  `pending logins cleared` and `pending logins remaining`, and fails if either kind remains. No alias and no second
  command: one step, one name, as the runbook already orders it. The drill's recovery step stays `sessions_cleared`;
  its report gains a separate `pendingLogins` section and the checks `pending-logins-not-in-backup`,
  `pending-logins-cleared-before-reopening` and `pending-login-store-denied-to-application`.
- Proven in `test/backup-restore.integration.test.ts`: a sign-in at the provider when a dump that kept the rows was
  taken; after restoring that dump its row is back until `restore:clear-sessions` removes it; on the reopened database
  the pre-restore callback answers `login_expired` without a token request, and a new sign-in through the same
  provider completes. The previous-schema drill restores from 0036 (no pending-login table, created empty by 0037).

## Explicit boundaries

- **This is not general multi-replica readiness.** What is now shared through PostgreSQL: sessions (ADR-0080) and
  pending logins. What is still per process: the login admission limits (five in flight and thirty initiations per
  minute **per process**, so N instances admit N times as many; the nginx per-IP edge limit is unchanged), the
  run-search admission limits, the weekly insight queue, the archive tile cache, metrics, and each process's cached
  provider discovery metadata (harmless: it is re-read per process). Live streams, maintenance runners and journals
  have their own single-instance assumptions that were not reviewed here.
- At most once: a crash or an uncertain consume makes the person sign in again (Decision 3).
- The provider still sees one authorization request per attempt; nothing here changes provider-side sessions.
- Expiry is judged by each instance's clock; instances need synchronized clocks.
- Migration 0036's `create_auth_session` sweep and `purge_expired_auth_sessions` still use the unbounded
  `IN (SELECT ... LIMIT)` pattern (Decision 4). They delete only expired sessions, so no live session is affected, but
  a purge can exceed its batch and then be reported as failed by `runSessionPurgeOnce`. Not changed here (it is session
  storage, outside this slice); a small follow-up migration should apply the same materialized batch.

## Options considered

| Option | For | Against |
|---|---|---|
| **PostgreSQL table + narrow functions** (chosen) | Existing infrastructure, atomic single use, privileges in the database, same pattern as sessions | One short statement per step |
| Sticky sessions at the proxy | No storage change | Does not survive a restart; couples routing to authentication; out of scope |
| Stateless signed or encrypted login cookie holding the verifier | No storage | Single use needs a server-side replay list anyway; key management; the browser would carry the verifier |
| Grant the runtime role table access | Simpler SQL | It could enumerate and read every pending attempt |
| Fall back to memory when the database is down | Sign-in "works" during an outage | Attempts invisible to other instances and lost on restart; the database is down for every request anyway |
| Redis | Common pattern | New infrastructure; out of scope |

## Consequences

- A sign-in adds three short statements (reserve, complete, consume), plus a cancel when it fails before the
  redirect. A database outage now
  also stops starting and completing sign-ins (503 / `unavailable`).
- `OIDC_STORE_MAX_ENTRIES` is now a per-database limit; every instance should agree on it, as on
  `SESSION_STORE_MAX_ENTRIES`.
- The e2e harness empties the pending-login table with the session table at teardown.
