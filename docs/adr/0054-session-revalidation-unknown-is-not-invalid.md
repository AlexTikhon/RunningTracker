# ADR-0054: Session revalidation: "could not verify" is not "invalid"

- Status: accepted; implemented and verified locally
- Date: 2026-10-07
- Amends: ADR-0007 (what the browser does with a failed session check), ADR-0048 and ADR-0049 (the one way a session
  is suspended is now reached only by an authoritative answer or a known expiry)
- Scope: the web app's re-check of a session it already holds. No server change: `GET /api/session` is as before.

## Context

The page re-checks `GET /api/session` at start-up and whenever the tab gains focus or becomes visible. Its `catch`
treated every failure as the end of the session: a network error, a request deadline, a 429, a 503 or a body that
could not be read all called the same suspension as a real 401. Suspension stops capture and upload, disposes the
writer lease coordinator and turns the page into "Sign in required".

Reproduced before the change (Chromium, Simulator run recording, `GET /api/session` answered 503, then a `focus`
event): the page showed "Not signed in", the Capture card went to `idle`, and the same cookie was still accepted by the
server (`200`). A person on a flaky connection who switched tabs and came back lost a valid, offline-capable recording
session to a check that had told the page nothing.

## Decision

Three answers are kept apart. The decision is a pure function (`decideSessionTransition`, `session-revalidation.ts`);
the hook only applies it.

| What the page learns                                          | Meaning                       | Effect                                                   |
| ------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `200` with a valid session that has not run out               | confirmed                     | keep or reconcile; clears "unavailable"                  |
| `200` whose `expiresAt` has passed                            | expired                       | suspend (`expired`)                                      |
| `401` from `GET /api/session` (the server's `AUTH_REQUIRED`)  | invalid                       | suspend (`expired`, or `none` if nothing was confirmed)  |
| network error, deadline, 408/425/429/5xx, any other status, a body outside the contract | cannot verify | keep the session; mark verification "unavailable"; retry |
| cannot verify, and the held session's `expiresAt` has passed  | expired                       | suspend (`expired`)                                      |
| cannot verify, and nothing was ever confirmed on this page    | nothing to keep               | "Not signed in", reason `unreachable`                    |
| superseded by a newer check, or the page stopped checking     | stale                         | ignored                                                  |

1. **Only a 401 is authoritative.** The session endpoint answers 200 or 401 about the session. A 403 is not one of its
   answers (origin and CSRF refusals belong to `POST`/`DELETE`; resource and membership refusals belong to their own
   routes and do not touch the session), so it is not read as session loss. It is "cannot verify", which the known
   expiry still bounds. The 401 rule is the one `request.ts` already applies to every request.
2. **Known expiry still wins.** The server gives a fixed `expiresAt` (no sliding window), and the page already ends the
   session at that time. A failed check never extends it: if the held session's `expiresAt` has passed when a check
   cannot be answered, the session ends as expired. No expiry is invented where none is known.
3. **Verification is a separate state, not a new session state.** `useRunnerSession` returns `verification`
   (`confirmed` | `unavailable`). The `ready` state object keeps its identity, so none of the effects keyed on `session`
   in `App` (writer coordinator, upload worker, capture controller, run confirmation) restart. Capture, upload, the
   writer lease, buffered points and queued requests are untouched by "unavailable"; capture follows the same offline
   rules as any lost connection. The session bar says "Cannot confirm your session right now. Your work stays on this
   device and the check is repeated automatically." It never says the session ended.
4. **Retry.** While "unavailable", the page asks again every 30 s, never sooner than a `Retry-After` the server sent
   (429, 503), and also on focus, visibility and the browser's `online` event (the last is new). The first good answer
   returns to "confirmed" as a reconciliation: same identity, same run, same lease, no re-initialisation. A different
   identity or a new CSRF token still replaces the session as it did before.
5. **Start-up is different from background.** With nothing confirmed there is nothing to keep, and a stored identity is
   not trusted, so a failed first check is "Not signed in" with its own message ("The server could not be reached to
   check your session... stays on this device") instead of the sign-in prompt or "Your session ended". It ranks with
   "none": it never replaces "expired" or "signed-out" and a real answer replaces it.
6. **Ordering.** `SessionChecker` numbers its checks. Starting one cancels the previous and only the newest may report;
   an older answer that still arrives (a transport may ignore the abort) is `stale`. The attempt number, not the abort
   signal, is what orders results. `cancel()` (suspension, sign-out, unmount) also makes any in-flight answer stale.
   `loadSession` no longer announces its 401 on the global channel: that announcement is not ordered and would let an
   old check end a newer session. Every other request still announces its 401 as before. Focus, visibilitychange and
   online may fire together; each cancels the one before, so one transition costs at most one extra cancelled GET.
7. **Run authority is a separate boundary.** Session verification says who the user is. ADR-0051 says whether the run
   may be captured online, and still needs the server's answer about the run. "Session unavailable" never marks a
   run confirmed. After a reload with the session endpoint down the page is not signed in, so storage is not loaded and
   nothing is resumed; the run's data stays in IndexedDB and recovers through ADR-0048/0051 on the first good check.

## Unchanged

Real expiry and real 401: capture and upload stop, the lease is released, the page says "Your session ended", and
everything durable stays in IndexedDB for the same person's next sign-in (ADR-0049). Server-facing work while the
session is unverifiable keeps its existing behaviour: upload retries and queued lifecycle requests use the same
durable paths as any lost connection, and the server still authenticates and authorises every request itself.

## Limits

- Nothing is persisted: a reload while the server cannot be reached cannot keep recording, by design (see 5). Recording
  across a reload needs a confirmed session.
- The page's clock decides "expired". A badly wrong device clock was already a limit of the expiry timer.
- A 401 from another request (an upload, for example) is still announced and ends the session without ordering
  against a newer check; that path was not part of this change.
- The web app has no logging layer, so the categories (confirmed, invalid, unverifiable, stale) exist as the
  `SessionCheckResult` kinds and in tests, not as emitted events.

## Verification

Unit (`session-revalidation.spec.ts`): classification of 401, 403, 408, 425, 429, 500, 502, 503, 504, network failure,
deadline, abort and unreadable body; the transition table including known expiry reached while offline and the
start-up case; retry delay with `Retry-After`; and the ordering races with deferred promises (older failure after a
newer success; older success after a newer invalid answer; older answer before the newer one; transient failure then
success; cancellation; cancel). Also `use-runner-session`, `SessionBar`, `request` and `runner-api` specs. Chromium
(`tests/e2e/session-revalidation.spec.ts`): 503, a network failure and a 429 with `Retry-After` on focus and visibility
during a recording run (still signed in, still capturing, same writer, points still delivered, back to confirmed
without a restart, finished run gap-free); the browser coming back online; a reload while the endpoint is down (not
signed in, nothing captured, run kept, recovered on retry); and a real 401 (signed out, run kept on the device).
Mutation check: classifying every failure as invalid failed the 503 test and eleven unit tests. Before the change the
503 reproduction ended the session and set capture to idle.
