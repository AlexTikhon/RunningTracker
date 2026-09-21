# ADR-0007: HTTP session, CSRF, request identity, and tenant trust boundary

- Status: accepted; P03.1 implemented and locally verified
- Date: 2026-09-21
- Scope: P03.1 plus the minimal session/error runtime contracts from P03.2

## Context

P02 establishes RLS only after trusted code supplies transaction-local user and
organization values. It does not authenticate an HTTP caller. Accepting a user
identifier from a header, body, query, Host, or forwarded header would let the
caller choose that trusted database context. The project also needs a local
identity fixture without turning it into an implicit production fallback.

## Decision

1. The session API is outside the organization prefix:
   - `POST /api/session` exists only when local auth is explicitly enabled in
     development/test. It requires an exact allowlisted `Origin`,
     `application/json`, and `{ userId }`; the ID must be in the server-side
     allowlist. This Origin plus non-simple JSON request is the pre-session
     login-CSRF bootstrap mechanism.
   - `GET /api/session` requires a valid session and returns verified `userId`,
     server expiry, and the per-session CSRF header name/token.
   - `DELETE /api/session` requires the session, exact Origin, and its CSRF
     token; it revokes the server record before returning and clears the cookie.
2. The bearer is a 32-byte random opaque token. Only its SHA-256 digest indexes
   the in-memory server record. The separate CSRF token is also random and is
   compared in constant time. Tokens are never accepted through URLs and are not
   logged.
3. The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, has no `Domain`, and
   uses a bounded `Max-Age`. It is `Secure` by default. Disabling `Secure`
   requires explicit development/test configuration; production validation
   rejects it.
4. The in-memory store is injected, bounded, has no import-time singleton,
   connection, interval, or background cleanup. Expiry is checked against the
   injected clock on every resolution. Restart loses all sessions. Capacity
   exhaustion fails closed instead of silently evicting a valid session. This
   store is not the P12 production provider.
5. Local auth defaults off. Production configuration with local auth enabled is
   rejected by the first configuration step in `main`, before pool construction
   or HTTP binding. With local auth disabled and no P12 provider, protected
   session API has no anonymous/default identity fallback.
6. Authenticated mutation middleware always resolves the session first, then
   checks exact configured Origin and the session-bound CSRF token. Missing,
   `null`, malformed, non-allowlisted, or non-canonical Origin values fail.
   Allowed origins are static configuration and are never derived from
   `Host`/`X-Forwarded-*`; no wildcard credentialed CORS or blanket trust proxy
   is enabled.
7. `withAuthenticatedTenantTransaction` receives the resolved session, validates
   client-selected `orgId`, enters `withTenantTransaction` with only the
   session's `userId`, verifies active membership inside that same runtime-role
   transaction, and invokes the DB callback on the same client. It returns
   `403 ORG_ACCESS_DENIED` before the callback when membership is absent or
   inactive. Membership is not cached in the session.
8. A server-generated UUID request ID is installed before parsers and routers,
   returned as `X-Request-Id`, and included in every application error body.
   Caller-provided request-ID headers are ignored. Application errors use:

   ```json
   {"error":{"code":"...","message":"...","requestId":"...","details":{}}}
   ```

   Invalid JSON/validation, session, Origin/CSRF, organization, unknown route,
   and unexpected failures use this envelope. Unexpected details, stacks, SQL,
   credentials, cookies, and tokens are not returned or logged. Health remains
   the pre-existing operational `{ status, checks? }` contract and status
   semantics, with only the request-ID response header added.
9. Runtime session and ApiError response schemas live in `packages/contracts`
   and have no dependency on Express or `pg`. Other P03.2 API/OpenAPI/SSE
   contracts remain deferred.

## Consequences

- Request headers/body/query cannot select the authenticated principal after a
  session is created; only server-side session resolution can do so.
- A CSRF token from another valid session is useless, and denied middleware does
  not enter the protected handler/DB callback.
- Local process restart, capacity exhaustion, or expiry can require a new local
  login. This is an explicit fixture limitation, not production availability.
- P03.1 is complete, but run/command API behavior in P03.3-P03.5 and production
  identity/session integration in P12 are not implemented.

## Verification

- focused API tests cover create/read/revoke, missing/malformed/unknown/expired
  tokens, cookie attributes, no-store, spoof attempts, local-auth defaults and
  production guards, login Origin/JSON, session-bound CSRF, request IDs, invalid
  JSON, unknown routes, and sanitized unexpected failures;
- a test-only Express router composes the production middleware/helper without
  adding a production diagnostic route;
- real `running_tracker_test` integration passed through HTTP, the in-memory
  session, and `running_tracker_runtime` for both organizations, absent/inactive
  membership, deactivation between requests, and pooled connection reuse.
