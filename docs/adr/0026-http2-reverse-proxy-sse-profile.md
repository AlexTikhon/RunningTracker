# ADR-0026: HTTP/2 reverse-proxy profile for SSE

- Status: accepted; P08.5 implemented and locally verified
- Date: 2026-09-28
- Scope: P08.5 only

## Context

The application already emits authenticated `text/event-stream` responses with
`private, no-store`, `X-Accel-Buffering: no`, a 15-second heartbeat, bounded
application backpressure, and revision-based recovery over ordinary HTTP. That
behavior still depends on an external transport which does not buffer, compress,
cache, retry, or prematurely time out the long-lived response. The browser also
needs one HTTPS same-origin boundary so its Secure/HttpOnly session cookie is
valid without putting credentials in a URL.

## Decision

1. The reproducible profile uses the pinned Nginx 1.28 Alpine image. Nginx serves
   the built React application and proxies `/api/*` to an internal Express
   container. Only `127.0.0.1:8443` is published; the API port remains on the
   Compose network. Unconfigured TLS host names are rejected.
2. Browser-to-Nginx uses TLS 1.2/1.3 with HTTP/2 negotiated by ALPN. Nginx-to-
   Express deliberately uses persistent HTTP/1.1 with an empty `Connection`
   request header. HTTP/2 is an edge transport property, not an application
   protocol change.
3. The `/api/orgs/*/live` location disables request/response buffering, proxy
   cache, gzip, upstream `Accept-Encoding`, and upstream retry. It passes the
   application's `X-Accel-Buffering` header, uses a five-second connect timeout,
   30-second upstream/client send timeouts, and a 75-second read timeout. The
   read timeout is five heartbeat periods; the send timeout remains bounded but
   is twice the healthy heartbeat interval.
4. Both API locations preserve the external `Host` and set `X-Forwarded-For`,
   `X-Forwarded-Host`, and `X-Forwarded-Proto`. Nginx does not interpret session
   cookies; the original same-origin cookie is forwarded to Express. Ordinary
   API responses retain conventional proxy buffering and the application's
   existing 64 KiB JSON limit; the edge rejects bodies above 128 KiB.
5. The Compose overlay targets the disposable local test database, enables only
   the existing local identity fixture, requires Secure cookies, and uses the
   tracked local-only signing key. These settings are development verification,
   not production identity or secret management.
6. `npm run transport:tls` builds the pinned proxy image and creates a seven-day
   self-signed localhost certificate under gitignored `.local/tls`. Real
   deployments must terminate TLS with managed certificates and external secret
   storage; P12 owns that production integration.

## Consequences

- Proxy buffering and automatic retry cannot delay or disguise one live stream.
  Disconnect remains visible to the existing bounded reconnect/revision recovery
  logic; SSE is not migrated to WebSockets and gains no durable replay.
- The 75-second read timeout is intentionally much larger than the 15-second
  heartbeat, but it still bounds an upstream which stops producing bytes.
- Nginx does not weaken the API hub's connection, poll-concurrency, latest-only
  pending-state, or blocked-writer limits.
- The profile is single-host and local. It does not provide a production identity
  provider, managed certificates, external secrets, multi-replica routing,
  resource quotas, or a backup/restore process. Those remain P11/P12 concerns.

## Verification

`npm run transport:verify` uses Node's HTTP/2 client against the real TLS socket
and the real Express/PostGIS path. It checks ALPN `h2`, static web and health
responses, Secure/HttpOnly login, SSE headers, prompt initial state, heartbeat,
strict per-stream sequencing, untrusted Host rejection, and zero idle-in-
transaction API sessions. It commits eight revision/point updates and reports
commit-to-visible latency, restarts the API under the open stream, requires a
disconnect, and verifies a replacement stream starts at sequence zero with a new
stream ID. This is a small local diagnostic, not the final P11 load result.
