# ADR-0048: Independent runner revisions, session suspension and rejected-buffer recovery

- Status: accepted; implemented and verified locally
- Date: 2026-10-05
- Amends: ADR-0009 upload outcomes, ADR-0046 login admission

## Decision

1. Reducer and IndexedDB use the same snapshot merge. Lifecycle fields follow
   `controlRevision`; `dataRevision` is their independent maximum. An upload ACK
   changes only the data revision. A summary survives only for a finished run
   with `sourceRevision` equal to the merged data revision; advancing data clears it.
2. Session lifetime is shared by runner controls, capture and upload. Expiry and
   any JSON API `401` synchronously cancel outstanding work and require sign-in;
   focus and visibility restoration revalidate the session. Exact requests and
   buffered points remain scoped to the authenticated user in IndexedDB. A fresh
   session restores them before capture or upload can resume with fresh CSRF.
3. All JSON runner requests have a 15-second deadline covering headers and body
   consumption, plus caller cancellation. An unknown mutation outcome preserves
   the original run/command ID and body. Worker stop aborts its send and error
   reconciliation; a cancelled generation cannot publish subsequent UI state.
4. Retryable transport failures retain jitter/Retry-After. Authentication failure
   suspends; terminal data/protocol rejection becomes a durable blocked queue.
   Capture stops, and reload does not retry that queue. The UI exports the exact
   retained points as JSON. Finish remains available on a blocked active run.
   Explicit discard requires a finished run and the current writer fence, then
   atomically deletes that run's points and requests before clearing its active
   pointer. Other runs and users are untouched.
5. Login reserves bounded storage before asynchronous provider work, replaces
   the browser's previous attempt, and releases a failed reservation. Application
   admission allows at most five concurrent initiations and thirty per minute
   per process. The production public-edge proxy adds five initiations per minute
   per direct socket address with burst four and HTTP 429. Case and trailing-slash
   variants share that zone. Arbitrary forwarded addresses are not trusted by the
   application or used by the proxy limiter. An additional ingress requires
   an explicit trusted-address configuration before changing that boundary.

## Verification

Unit regressions cover both pause/finish ACK orders, close/reopen recovery,
summary validity, rejected-buffer persistence and fenced discard, request/body
deadlines, cancellation, exact retry, and login admission/replacement/expiry.
Browser regressions use the disposable PostgreSQL database and the real test
OIDC provider for recording expiry and fresh-session recovery. The deployment
verifier exercises burst rejection with forged address headers and alternate
route spellings through the actual TLS/HTTP2 nginx profile.
