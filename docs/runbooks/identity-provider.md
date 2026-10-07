# Runbook: identity provider and provisioning people

Audience: the operator who connects the service to an identity provider and decides who may use it.
Design: ADR-0046. Related: `docs/runbooks/deployment.md`.

## Status: what this proves and what it does not

Sign-in is OpenID Connect (authorization code with PKCE) against any compliant provider. It has been verified
against an in-process test provider and the production profile with an unreachable issuer, **not** against a real
provider such as Keycloak, Google or Auth0. (Chromium has also driven the whole sign-in against the same test provider, with the provider on a different site from the application: `npm run test:e2e`, the `chromium-oidc` project. Other browsers have not.) Expect to find provider-specific details on first contact (claim
shapes, issuer spelling, secret formats) and treat the first real sign-in as a test.

Nobody can sign in merely by having a provider account: the service is **invite-only**. A person must first be
provisioned in the database (below).

## Register the client at the provider

Create one client for this deployment with these properties:

| Setting | Value |
|---|---|
| Client type | confidential (it has a secret) |
| Flow | authorization code; no implicit, no password grant |
| PKCE | S256 (the service refuses a provider that does not advertise it) |
| Redirect URI | exactly `<PUBLIC_ORIGIN>/api/auth/callback`, for example `https://tracker.example/api/auth/callback` |
| Client authentication | `client_secret_basic` |
| Scopes | `openid` (nothing else is needed; no profile or e-mail data is read) |

Note the **issuer**. It must be an `https` URL without credentials, query or fragment, and it must be exactly the
`issuer` value in the provider's discovery document, because the identity stored for a person includes it:

```sh
curl -s <issuer>/.well-known/openid-configuration
```

A trailing slash or a different host spelling is a different issuer.

## Configure the deployment

In the compose environment file (`infra/compose/production.env.example` is the template):

```
OIDC_ISSUER_URL=https://idp.example/realms/running-tracker
OIDC_CLIENT_ID=running-tracker
```

The client secret is a file, never an environment value. It is issued by the provider, so `npm run deploy:secrets`
does not create it. Place it next to the generated secrets:

```sh
umask 077
printf '%s' '<client secret>' > <SECRETS_DIR>/oidc-client-secret
chmod 0444 <SECRETS_DIR>/oidc-client-secret   # like the other secrets: the directory (0700) is the boundary
```

Without the file Compose refuses to start the API; with an empty file the API refuses to start. Then deploy as
usual (`up -d --build --wait`). The API starts even when the provider is unreachable; discovery happens at the
first sign-in and is retried by the next one.

### Rotate the client secret

1. Create the new secret at the provider (keep the old one valid if the provider allows two).
2. Overwrite `<SECRETS_DIR>/oidc-client-secret`.
3. `docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> up -d --no-deps --force-recreate --wait api`
4. Revoke the old secret at the provider.

Recreating the API ends every application session (they are process memory); people sign in again, which is
usually a single redirect while their provider session is alive.

## Provision a person

The service reads a person's identity as `<issuer>|<subject>`: the `iss` and `sub` claims of the ID token. Take the
subject from the provider's user record (it is stable and opaque; it is not the e-mail address). The service's logs
deliberately do not contain it.

Open `psql` as the administrator:

```sh
docker compose -f infra/compose/docker-compose.production.yml --env-file <env file> \
  exec postgres psql -U running_tracker_admin -d running_tracker
```

```sql
BEGIN;
-- A person. The identity is the issuer, a pipe, and the subject, with no spaces.
INSERT INTO users (id, external_identity)
VALUES (gen_random_uuid(), 'https://idp.example/realms/running-tracker|4f6c0d1e-...')
RETURNING id;
-- An organization, only when creating a new one.
INSERT INTO organizations (id) VALUES (gen_random_uuid()) RETURNING id;
-- Membership: role is 'runner' or 'coach'.
INSERT INTO memberships (org_id, user_id, role) VALUES ('<organization id>', '<user id>', 'runner');
COMMIT;
```

The person can now sign in. Until they have a membership they sign in successfully and can do nothing.

## Remove access

Deactivating the membership takes effect on the person's next request (row-level security reads it per
request) and is recorded in the access-restriction journal (ADR-0045):

```sql
UPDATE memberships SET active = false WHERE org_id = '<organization id>' AND user_id = '<user id>';
```

**Disabling the person at the provider is not enough on its own.** It stops new sign-ins, but an application
session that already exists stays valid until it expires (`SESSION_TTL_MS`, 8 hours by default) or the API
restarts. Deactivate the membership as well; lower `SESSION_TTL_MS` if that window is too long. Do not delete the
`users` row: runs and memberships reference it.

## When sign-in fails

The browser lands on the app with `sign_in_error`; the API logs `auth.login.failed` with a `reason` (never a code,
token or subject).

| `sign_in_error` / status | Likely cause | Check |
|---|---|---|
| `not_provisioned` | The identity is not in `users`, or its issuer spelling differs | The `external_identity` value against the discovery `issuer` and the provider's subject |
| `denied` | The provider refused or the response failed validation: wrong client secret, redirect URI not registered, altered state, expired or reused code | Client secret file, the registered redirect URI, server clock (ID-token times are checked) |
| `login_expired` | The attempt is older than `OIDC_LOGIN_TTL_MS` (10 minutes), was started in another browser, or was already used | Start again from the app |
| `unavailable` | Provider outage, timeout, a 5xx, or a non-conforming response while exchanging the code | Provider status; API container reaches the issuer over HTTPS |
| HTTP 503 `IDENTITY_PROVIDER_UNAVAILABLE` at `/api/auth/login` | Discovery failed, or the provider does not advertise PKCE S256 | `curl` the discovery document from inside the API container |
| HTTP 503 `LOGIN_TEMPORARILY_UNAVAILABLE` | The pending-login store is full (100 attempts in 10 minutes) | Traffic to `/api/auth/login`; the browser's previous attempt is replaced when restarting |
| HTTP 429 at login / `LOGIN_RATE_LIMITED` from the API | Public-edge per-IP throttling, or application admission (five in flight, thirty per minute) | Wait and retry; investigate abandoned initiations and abusive traffic |

The production nginx proxy is the public edge: it limits the direct socket address to five login
initiations per minute, with burst four. It does not derive that identity from client-supplied
`X-Forwarded-For` or `X-Real-IP`, and the API admission is process-wide, independent of those headers.
If another ingress is placed in front of nginx, configure that ingress's exact trusted addresses
before enabling real-IP processing; otherwise its users share the ingress address's allowance.

When the application session expires, the runner suspends capture and upload and shows sign-in
without requiring a reload. Buffered points and exact unresolved lifecycle requests remain in
IndexedDB for that user. Reauthentication restores them with the new session's CSRF credentials.

## Not done here

| Gap | Note |
|---|---|
| Verification against a real provider | Not performed |
| Logout at the provider (RP-initiated logout) | `DELETE /api/session` ends the application session only. The web app's Sign out button calls it (ADR-0049), so the next sign-in completes without a login page while the provider session lives |
| Provisioning through the application | Manual SQL by design for now |
| Shared session store | Sessions are process memory; a restart signs everyone out |
| Provider-side re-validation of a live session | A disabled provider account keeps its session until expiry |
| MFA, password policy, account recovery | The provider's responsibility |
