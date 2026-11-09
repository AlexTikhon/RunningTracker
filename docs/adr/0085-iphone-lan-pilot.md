# ADR-0085: An isolated iPhone web pilot over trusted LAN HTTPS, for synthetic data only

- Status: accepted; implemented and verified on the Windows workstation (unit, the running pilot through its HTTPS
  proxy with Node's TLS, desktop Chromium through the same proxy). Physical iPhone checks: not run (owner's step).
- Date: 2026-11-09
- Relates to: ADR-0026 (SSE transport), ADR-0043 (single-host deployment profile), ADR-0046 (OpenID Connect), ADR-0062
  (proxy error-log boundary), the local demo (`docs/runbooks/demo.md`), D10 (real-device pilot).
- Scope: `infra/compose/docker-compose.lan-pilot.yml`, a `lan-pilot` proxy image stage and site template,
  `scripts/lan-pilot*.mjs`, `scripts/verify-lan-pilot.mjs`, the web demo sign-in gate, `tests/e2e/lan-pilot/`, docs. No
  API code, migration, contract or production default changes.

## Context

The owner has a Windows computer and an iPhone, and no Mac. A native client and HealthKit need macOS and Xcode, so the
next useful step is the existing web app in Safari on the phone. Safari gives Geolocation and Secure cookies only to a
trusted HTTPS origin, and the phone cannot reach `localhost`. The loopback transport profile cannot simply be
published: it binds `127.0.0.1:8443`, its certificate names `localhost`, and its API uses `running_tracker_test`.

## Decision 1: a separate, opt-in Compose project with its own database

`running-tracker-lan-pilot` has its own PostgreSQL container, database (`running_tracker_lan_pilot`), internal network
and volume, and reuses the existing images: the tools image runs bootstrap, migrations and a seed of the two demo
people only (`scripts/lan-pilot-seed.mjs`, refusing any other database or host); the runtime image runs the API in
development mode with local auth for those two IDs, Secure cookies, `ALLOWED_ORIGINS` set to the one pilot origin and
both AI providers off. PostgreSQL and the API publish nothing. Configuration and random per-pilot secrets are generated
under `.local/lan-pilot/` (the production secret builder gains a database-name option). Nothing can reach the
development or test database: different project, container and network, and the verifier shows a written row is
absent from both.

## Decision 2: publish only HTTPS, on one explicitly configured private address

`npm run pilot:configure` accepts only an RFC 1918 IPv4 address assigned to the computer (optionally a private-use name
ending in `.local`, `.home.arpa`, `.internal` or `.lan`, and a port). The proxy publishes `address:port:443` and nothing
else. Firewall changes and trust installation stay manual and documented, never automated.

## Decision 3: a name-constrained local CA, Apple-compatible server certificate

`npm run pilot:tls` uses OpenSSL from the pilot image (`--network none`) to issue a CA (RSA 3072, 120 days, `pathlen:0`,
critical name constraints permitting exactly the pilot address and, if configured, its name, or an unusable `.invalid`
name otherwise) and a server certificate meeting Apple's published requirements (RSA 2048, SHA-256, address/name in
subjectAltName, serverAuth EKU, 90 days). A CA, rather than a self-signed leaf, keeps the signing key out of the proxy
(only `tls/server/` is mounted) and lets the owner delete it after issuing. Name constraints mean a leaked CA key cannot
vouch for any other site. The server's common name is descriptive, not the address: OpenSSL checks a host-like common
name against DNS constraints (found when the first issuance failed `openssl verify`). The step ends with a strict
`openssl verify`, never overwrites a file and keeps nothing after a failure. Only the public CA certificate (DER) is
written for the phone. A `--without-name-constraints` fallback exists in case a client refuses constrained roots.

## Decision 4: one host, refused otherwise; the deployment proxy policy

The pilot image uses the deployment nginx configuration (query-free access log, ADR-0062 error-log boundary, security
headers) with its own site. Safari sends no SNI for an IP address, so the deployment pattern of refusing unknown names
in the handshake would refuse the phone. Instead every handshake gets the pilot certificate, and a request whose Host
is not the pilot host is answered `421` by a default server that reaches neither the app nor the API. SSE keeps the
verified no-buffer policy.

## Decision 5: the existing demo sign-in in a dedicated build mode

The demo buttons were dev-server only (`DEV && VITE_LOCAL_DEMO_ENABLED === 'true'`), and the proxy serves a production
bundle. The gate now also opens for `MODE === 'lan-pilot'`, which only the `web-build-lan-pilot` image stage uses
(`vite build --mode lan-pilot` with the flag set for that one command). The ordinary production bundle was rebuilt and
is byte-identical to before; it contains neither the buttons nor the demo IDs. The API still refuses local auth in
production; the pilot is development mode by design and labelled as such.

## Decision 6: behavioral verification on the real proxy; no device claims

`npm run pilot:verify` uses Node's TLS with the pilot CA as the only extra root and checks exposure, TLS acceptance and
refusal, Host and Origin enforcement, session cookie flags, an owner-only read with CSRF, database isolation, SSE and
log sanitization. `npm run pilot:e2e` runs desktop Chromium through the proxy; it trusts the one server key through
Chromium's per-key allow-list in a throwaway profile and asserts the received certificate's issuer, because installing
the CA in a desktop trust store is excluded. Neither is evidence about Safari or the phone; those checks are listed in
`docs/reports/iphone-lan-pilot.md` as not run until the owner records them.

## Consequences

- The owner can open the app in Safari on the phone without bypassing a certificate warning, with synthetic data.
- The pilot's sign-in is not identity verification. Anyone on the network who can reach the address can act as the
  demo runner, so it is limited to synthetic data on a trusted network.
- A root CA is installed on the phone for the pilot's duration; it is constrained, short-lived and removable.
- IPv4 only. An address change means a new CA and new trust on the phone.
- HealthKit and a native client remain deferred until Mac/Xcode access exists.
