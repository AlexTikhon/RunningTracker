# ADR-0043: Single-host deployment profile, file-based secrets, and production configuration rules

- Status: accepted; P12.2 implemented and locally verified
- Date: 2026-09-30
- Scope: P12.2. P12.1 (identity provider), P12.3 (backup/restore drill), and P12.4 (permission
  recovery) are separate and not covered.

## Context

The repository had a development Compose file with fixed credentials and a published database
port, and a local transport profile (ADR-0026) with a self-signed localhost certificate. Nothing
described how to run the system anywhere else: where secrets come from, how the four database
logins get real passwords, what the containers are allowed to do, what the public edge looks like,
or how an update and a credential rotation proceed. The SDD (section 13) asks for a single
host/region, a TLS reverse proxy, a persistent volume, and independent resource limits for the
backend and PostgreSQL.

## Decision

1. **A standalone production Compose file**, not an overlay on the development files, so no
   development credential or published port can leak into it. Services: `postgres`, a one-shot
   `db-init`, `api`, and `proxy`. Health conditions order them: PostgreSQL healthy, `db-init`
   completed successfully, API healthy, then the proxy.
2. **Secrets are files.** `scripts/generate-production-secrets.mjs` writes six files (administrator
   password, four database URLs, cursor key) with independent 256-bit random passwords. Compose
   mounts them under `/run/secrets`. The API reads `DATABASE_URL_FILE`,
   `MAINTENANCE_DATABASE_URL_FILE`, and `LIVE_TRACK_CURSOR_SIGNING_KEY_FILE` (a new
   `resolveSecretFiles`, applied to exactly those three variables); setting a variable and its
   `_FILE` together is an error; one trailing line ending is stripped; errors name the variable,
   never the content. `db-init` exports the four URLs from files for the existing bootstrap and
   migration scripts, which are unchanged. Secret files are `0444` inside a `0700` directory:
   containers run as unrelated uids and must read a bind-mounted file, so the directory is the host
   boundary.
3. **Two more production startup rules.** `ALLOWED_ORIGINS` must be non-empty and contain only
   `https` origins when `APP_ENV=production`. Every state-changing request is checked against it
   (session, Origin, CSRF chain), so an empty list is an outage that would otherwise appear only as
   rejected requests; an `http` origin contradicts the required `Secure` cookies.
4. **Bounded, unprivileged containers.** Memory (no swap), CPU, and pids limits on every service;
   `cap_drop: ALL` (PostgreSQL and the proxy add back only what their entrypoints need);
   `no-new-privileges`; read-only root file systems for `db-init`, `api`, and `proxy`; rotated
   logs. PostgreSQL sits on an `internal` network with no route out, and only the proxy publishes
   ports (80 and 443).
5. **Public edge.** A `production` build target of the proxy image, with the site file rendered
   from an envsubst template: HTTP only redirects, always to the configured `PUBLIC_ORIGIN` (never
   the request Host); TLS 1.2/1.3 with an operator-supplied certificate; an unknown server name is
   refused at the handshake; HSTS (one year, without `includeSubDomains` or `preload`, which are
   hard to undo), `nosniff`, a Referrer-Policy, a Permissions-Policy allowing geolocation for the
   site, and `Content-Security-Policy: frame-ancestors 'none'`. The SSE location keeps the
   no-buffer/no-cache/no-compress/no-retry policy verified in ADR-0026. Content-hashed `/assets/`
   are cached immutable; `index.html` is `no-cache`. The header snippet is included in every
   location that sets its own `add_header`, because nginx drops inherited headers in such a
   location.
6. **Rotation without locking out the bootstrap.** PostgreSQL reads `POSTGRES_PASSWORD_FILE` only
   at first initialization, so regenerating the administrator password on a live volume would make
   the bootstrap job fail. `--rotate-roles` replaces only the owner, runtime, and maintenance
   passwords; `db-init` applies them (the bootstrap script already re-sets role passwords), and
   the API is recreated.
7. **Proof is behavioural.** `npm run deploy:verify` builds and starts the stack with throwaway
   secrets and a self-signed certificate, then asserts the properties above against the running
   containers. `scripts/production-profile.test.mjs` guards the file structure without Docker.

## Alternatives considered

- **Overlay on the development Compose files.** Rejected: the development file publishes the
  database and embeds credentials; an overlay can only add, not remove, which makes the safe state
  depend on every future edit.
- **Docker secrets with `uid/gid/mode`.** Those keys apply to Swarm; plain Compose bind-mounts
  the host file and ignores them.
- **`_FILE` support in the bootstrap and migration scripts.** Rejected in favour of a three-line
  shell export in the one-shot job: it avoids a second copy of the file-reading rules in
  untyped scripts, and those scripts run only inside that job.
- **A `deploy:check` preflight command.** Rejected for now: Compose `${VAR:?}` catches missing
  inputs and the API's own validation fails fast at start with a named variable, which is the
  same check without another entry point.
- **A full Content-Security-Policy, request rate limiting.** Not done: neither could be validated
  here (the map needs a browser to prove a policy; no traffic model exists to size a limit), and a
  wrong value breaks legitimate use. Listed as gaps in the runbook.

## Consequences

- Production has no sign-in until P12.1: local login is forbidden and `POST /api/session` is a
  404. The stack is deployable and verifiable, not launchable.
- The `production` proxy stage and `tools` API stage are added before the historical last stages
  (`transport`, `runtime`), which stay the default build targets; the transport Compose file now
  names its targets explicitly. A structural test pins both.
- The resource limits are starting values from the P11 measurements, taken against a process on
  one workstation. They have not been re-measured under the limits.
- The journal directory is a bind mount whose durability the application cannot verify.
- Database traffic inside the Docker network is unencrypted; on a single host this is a
  deliberate, documented boundary.
