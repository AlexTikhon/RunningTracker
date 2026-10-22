# ADR-0062: The proxy's error log crosses an allow-listed boundary before Docker keeps it

- Status: accepted; implemented and verified locally (unit tests, the production and transport profiles, and the
  proxy image under the deployment profile's container hardening)
- Date: 2026-10-22
- Amends: ADR-0043 (single-host deployment profile) and ADR-0026 (HTTP/2 reverse proxy profile); completes F01
- Scope: `infra/proxy`, the profile verifiers and their tests. No API, OIDC, SQL, browser, Compose service or
  dependency change.

## Context

F01 (`2f7e293`) removed the query string from the access log, because the OIDC callback carries a one-time `code` and
`state` there. nginx's error log is a different path. When nginx itself fails a request, before routing or at the
upstream, its entry ends with `client`, `server`, `request: "<request line>"`, `upstream: "<URI>"`, `host` and
`referrer`. Each of these can quote the callback query, either directly or as a copy in the Referer. nginx 1.28
cannot change that: `log_format` and its `escape=` apply only to `access_log`, and `error_log` accepts only a
destination and a level. The production profile sent it to `/dev/stderr`. The local profile had no `error_log`, so it
used the compiled default `/var/log/nginx/error.log`, which the image links to `/dev/stderr`. Both went straight to
Docker's json-file log.

The baseline was reproduced with unique fake canaries. `deploy:verify` found 12 of the 20 sent values in the proxy's
stored stderr. They came from the 413s on both listeners, a Referer-only 413 and an unreachable upstream. The
transport profile found 8 of 12 values and 5 raw error lines. The access log held none in either profile.

Rejected options:

- Lowering the level or discarding the error log. Operators would lose the 413 and upstream diagnostics, and the
  `crit`/`alert` entries would still carry the request context.
- Regex redaction that falls back to the raw line. A miss would leak.
- syslog to a receiver. The image has no receiver that can do more than copy raw lines.
- A new log platform or sidecar. It would be new infrastructure for a single stream.

## Decision

1. **The boundary is nginx's file descriptor 2.** The image's entrypoint, `nginx-error-log-boundary`, creates a FIFO
   (mode 0600, in a 0700 directory on the `/run` tmpfs) and starts nginx with that FIFO as its stderr. Its only
   reader is the sanitizer, which writes to the container's stderr. Every `error_log` in both profiles is `stderr`,
   and a structural test enforces that. The compiled default log and nginx's console messages also resolve to fd 2,
   so every error path nginx has passes the sanitizer. Raw entries exist only in the pipe's kernel buffer (64 KiB at
   most) and never in a file.
2. **Allow-listed output.** The sanitizer (`infra/proxy/error-log-sanitizer.mjs`) rebuilds each line from validated
   fields only: entry time, level, `pid#tid`, connection `*N`, and an event from a fixed table (for example
   `request_body_too_large`, `upstream_connect_failed`, `upstream_timeout`, `request_rate_limited`,
   `tls_handshake_failed` or `configuration_error`). Details are digits only (errno, byte count, worker, line), plus a
   phase taken from nginx's fixed "while ..." phrases and the names of the image's own configuration files. Message
   text, paths, zone names, request, upstream, host and referrer are never written. A recognized prefix with an
   unknown message becomes `event=unclassified`. A line without a valid prefix becomes
   `nginx-error-log: event=unrecognized_record bytes=N`. A record over 4096 bytes is dropped as it arrives and
   reported once by size, a record cut off at end of input is reported by size, and an exception while parsing gives
   a fixed line. No raw fallback exists.
3. **Correlation without the query.** The access log gains `connection=$connection`, the number an error entry carries
   as `*N`. A sanitized `*39 event=request_body_too_large` therefore joins the query-free access line
   `"POST /api/auth/callback HTTP/2.0" 413 ... connection=39`.
4. **Engine.** The sanitizer runs on the njs CLI already in the pinned image, with the QuickJS engine
   (`njs -n QuickJS`). The default njs engine does not free memory and reached 330 MB after 200,000 lines, while
   QuickJS stayed at about 3.6 MiB. The same file runs under Node in the unit tests, and the image test checks that
   the two give identical output.
5. **Lifecycle.**
   - Before the FIFO exists, the entrypoint runs the base image's template rendering and `nginx -t`. Nothing listens
     yet, so configuration errors reach the container's stderr unchanged. They hold configuration, never traffic.
   - QUIT (Docker's stop signal, graceful), TERM, INT and HUP are forwarded to the nginx master. `nginx -s reload`
     still signals the master through its pid file.
   - The sanitizer ignores stop signals and exits at end of input, once every nginx process has closed the FIFO.
     The entrypoint waits for it for at most 5 s.
   - If the sanitizer ends while nginx is running, the entrypoint writes
     `nginx-error-log: event=sanitizer_stopped action=stopping_nginx`, stops nginx and exits 70. A clean stop exits
     with nginx's status (0).
   - The sanitizer's own stderr is discarded, because an njs error report could quote input.
6. **Backpressure is blocking, not dropping.** If the sanitizer stalls, the FIFO fills, and nginx processes block on
   their next error write. Requests on those workers wait until it drains. Nothing goes around the sanitizer, and
   nothing is lost. A stalled log driver already blocks nginx in the same way when it writes directly to Docker.

## Consequences

- The proxy's stored stderr holds only sanitizer-built lines. Operators keep the severity, the time, the event
  category with its number, and the join to the access line through `connection=`. 413, refused upstream, upstream
  timeout and rate limiting each have their own event.
- **Diagnostic trade-off:** error lines no longer show file paths, header names, the upstream address or the text of
  messages outside the table. The upstream address and the path are in the access line. An unfamiliar failure
  appears as `unclassified`, and investigating it means reproducing it outside production with a debug
  configuration.
- A sanitizer crash restarts the proxy (`restart: unless-stopped`) instead of leaving it serving without an error
  log. A frozen sanitizer stalls the workers that are logging, and the health check shows it.
- Graceful stop time does not change. After an HTTP/2 connection it is about 6 s, with or without the boundary,
  because that is nginx's own HTTP/2 shutdown behaviour.

## Residual channels (not closed by this decision)

- The entrypoint's configuration phase and an operator's own `nginx -t` or `nginx -s reload` print configuration
  diagnostics unsanitized, to the container stderr or the operator's terminal.
- Running the image with another entrypoint (`--entrypoint`, or a Compose `entrypoint:` override) bypasses the
  boundary.
- The access log still records the path, `$host` and the client address. The query string is excluded (F01), but a
  value that a client puts in the path itself would be logged.
- The API's own logs are outside this decision. The verifiers report them (0 canaries) but do not gate them.
- A core dump of an nginx process would hold request memory. Whether one is written depends on the host's
  `core_pattern`.
- Error entries written by earlier images are still in existing json-file logs until those logs rotate or are
  deleted.

## Verification

- `scripts/proxy-error-log.test.mjs`: real entries, hostile text that imitates output, invalid UTF-8, every
  fragmentation size, overlong, truncated and parser failure cases, `run()` on files and a failed write.
- `scripts/production-profile.test.mjs`: every `error_log` is `stderr`, both image targets use the boundary
  entrypoint, and the script is LF, uses QuickJS and has its stdout on stderr.
- `npm run proxy:verify-error-log` (the production image, hardened like the profile, with the API replaced by a
  closed port):
  - Probes: the canary probes, startup failure, a sanitizer that cannot start, reload, the frozen-sanitizer
    backpressure burst and a killed sanitizer.
  - Shutdown: SIGQUIT and SIGTERM stops.
  - Sanitizer under njs QuickJS: parity with Node and a fragmented record. Memory was measured at 200,000 lines and
    with a 20 MB record, and a closed output was checked.
- `npm run deploy:verify` gates `errorLogQueryExposedOnNginxError`, and `npm run transport:verify` gates the same
  canary counts for the local profile. Both failed on the baseline and pass with this change.
