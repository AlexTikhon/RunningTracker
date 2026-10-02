# ADR-0046: OpenID Connect sign-in with invite-only identities and the existing session

- Status: accepted; P12.1 implemented and verified locally against a test provider, not against any real provider
- Date: 2026-10-02
- Scope: P12.1 only. The final documentation pass is P12.5. Closes the "production sign-in" half of D03 (D03b) for
  the mechanism; interoperability with a specific provider is not established.

## Context

Until now the only sign-in was the development fixture (`POST /api/session` for an allow-listed UUID), which
production configuration forbids. Production therefore had no way to sign anyone in. The SDD requires a verified
identity provider and forbids a home-grown cryptographic protocol. The data model already anticipated one:
`users.external_identity` is unique and non-blank, and every authorization decision downstream (RLS,
memberships, shares) is keyed by `users.id` from the session, not by anything the provider says.

## Decision

1. **Generic OpenID Connect, authorization code flow with PKCE (S256), `state` and `nonce`**, through the
   `openid-client` library (6.8.8). The provider is chosen by configuration, not code: `OIDC_ISSUER_URL`,
   `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (a file in production, like the other secrets), `OIDC_REDIRECT_URI`.
   The client is confidential and authenticates with `client_secret_basic`. The client fails closed if the
   provider's metadata does not advertise PKCE S256. Discovery is lazy (first login, cached for an hour), so a
   provider outage never stops the API from starting; the next login retries.
2. **Two routes, then the existing session.** `GET /api/auth/login` stores the attempt and redirects to the
   provider; `GET /api/auth/callback` validates the response, resolves the identity, and calls the unchanged
   `SessionManager.create`. The session cookie, CSRF token, expiry, store bound and `DELETE /api/session` logout
   are exactly those of the development fixture, so every authorization path is unchanged and still exercised
   by the existing suites. The routes exist only when OIDC is configured.
3. **Pending logins are server-side, bounded, single use.** `OidcLoginStore` keeps `{ codeVerifier, nonce, state }`
   under the digest of an opaque 256-bit identifier for `OIDC_LOGIN_TTL_MS` (default 10 minutes, at most one
   hour) and at most `OIDC_STORE_MAX_ENTRIES` (default 100) entries. `take` deletes the entry, so a callback
   cannot be replayed. The browser holds only the identifier, in a `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`
   cookie (`Secure` unless the deployment explicitly allows plain HTTP outside production). It is `Lax` because
   the provider returns the browser with a cross-site top-level GET.
4. **The callback URL is rebuilt, never read from the request.** The URL handed to the library is the configured
   `OIDC_REDIRECT_URI` plus only the query string the browser sent (at most 4,096 characters), so a forged `Host`
   header cannot influence validation. `OIDC_REDIRECT_URI` must be exactly `<origin>/api/auth/callback`, on an
   origin in `ALLOWED_ORIGINS`, and https in production.
5. **Identity is `<issuer>|<sub>`, invite-only.** The ID token's `iss` and `sub` are matched against
   `users.external_identity` through `app_private.resolve_login_user(text)` (migration 0021). It is `SECURITY
   DEFINER`, read-only, returns only the user id, never creates a row, and is executable by the runtime role only
   (the `users` policy otherwise hides every row before a tenant exists). Nobody gains access by signing in: an
   unprovisioned identity is refused (`not_provisioned`) and no user, membership or session is created. `|`
   cannot appear unescaped in an issuer URL, so the pair is unambiguous, and the same subject at another issuer
   is a different identity. E-mail addresses are never used as identity.
6. **No provider token is kept.** The ID token is verified (signature, issuer, audience, expiry, `nonce`), its
   subject read, and everything discarded. There is no refresh token and no call to the provider after sign-in.
   When the application session expires the person signs in again.
7. **The browser is told a closed set of outcomes.** Failures redirect to `OIDC_POST_LOGIN_PATH` (a validated
   in-application path, default `/`) with `sign_in_error` = `denied`, `login_expired`, `not_provisioned` or
   `unavailable`. The web app maps only those four codes to text and never reflects URL content. Provider
   outage, timeout, 5xx and non-conforming responses are `unavailable`; every validation failure and OAuth error
   response is `denied`. Logs carry the outcome code and error class only (the P11.1 allow-list drops everything
   else), never a code, token, subject or provider message.
8. **Success is a 200 page, not a redirect.** The session cookie is `SameSite=Strict`. The browser reaches the
   callback from another site, and a redirect chain begun there is still treated as cross-site, so the first
   request to the app would arrive without the cookie and look signed out. The callback therefore answers 200
   with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a `<meta http-equiv="refresh">` to the
   fixed path; the navigation from that page is same-site and carries the cookie.
9. **Production.** `OIDC_*` is required and `https` only; the issuer must carry no credentials, query or
   fragment; plain `http` is accepted only for a loopback issuer outside production (the integration provider).
   `LOCAL_AUTH_ENABLED` stays forbidden in production, so there is no development login and `POST /api/session`
   does not exist (404). The raw `OIDC_*` variables are removed from the resulting configuration object, which
   exposes one structured `OIDC` value.
10. **The deployment profile takes the settings from the environment and the secret from a file**
    (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `<SECRETS_DIR>/oidc-client-secret`); the redirect URI is derived from
    `PUBLIC_ORIGIN`. The client secret is issued by the provider, so `deploy:secrets` does not generate it.

## Consequences

- **Provider-side changes do not end an application session.** Disabling a person at the provider stops new
  sign-ins at once but leaves an existing session valid until `SESSION_TTL_MS` (8 hours by default) or an API
  restart. Removing access immediately is a database operation (deactivate the membership: row-level security
  then applies it to the next request, and the access journal records it). Lowering `SESSION_TTL_MS` shortens
  the window. A shorter-lived session plus provider re-validation was not built.
- **Sessions remain process memory.** An API restart signs everyone out; with a provider session still alive the
  re-login is a redirect round trip. A shared session store was not built.
- **A flood of `GET /api/auth/login` can fill the pending store** (100 entries for ten minutes) and make new
  sign-ins answer 503 until entries expire. The store is bounded on purpose (an unbounded one is a memory
  attack); the proxy, not this process, is where request-rate limits belong. A sealed cookie would remove the
  state but also the single-use property.
- **Provisioning is a manual database step.** No application path creates users or memberships, so the runbook
  documents the owner-role SQL (`docs/runbooks/identity-provider.md`). The `sub` is taken from the provider's
  user record, because logs deliberately do not contain it.
- **RP-initiated logout is not implemented.** `DELETE /api/session` ends the application session only; the
  provider's own session stays, so a following sign-in may not ask for credentials.
- **No account recovery, MFA or password handling** exists here: all of it belongs to the provider.
- **`apps/api/tsconfig.json` sets `skipLibCheck: true`** (the repository default stays `false`) because
  `openid-client`'s declaration file does not compile under this repository's `exactOptionalPropertyTypes`
  (`Configuration.timeout`). The relaxation is confined to the API package and applies to all its dependencies'
  declarations, not only that one.
- Two dependencies were added: `openid-client` (runtime) and `oidc-provider` with `@types/oidc-provider`
  (tests only, an in-process OpenID provider on a loopback port).

## What was verified, and what was not

Verified locally: unit tests for the configuration rules, the pending-login store (single use, expiry, bound),
and the routes (cookies, outcomes, callback reconstruction, logging); PostgreSQL integration tests for the
identity function (execute privileges, no creation, no widened reads) and for the whole flow against a real
`oidc-provider` (login, tenant read under RLS, logout, unprovisioned identity, altered state, no cookie, replay,
nonce/PKCE/state mismatch rejected by the real client, wrong client secret, unreachable provider); and
`npm run deploy:verify`, which starts the production profile and asserts that there is no development login,
that `/api/auth/login` answers 503 for an unreachable provider while the API stays ready, and that the client
secret is a file and appears in neither container configuration nor logs.

Not verified: any real identity provider (Keycloak, Google, Auth0 or another), real TLS to a provider, provider
key rotation, clock skew against a provider, behaviour in a real browser (the cookie and meta-refresh reasoning
in decision 8 was not exercised in one), load, and the operational process of provisioning people.
