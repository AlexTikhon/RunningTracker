# ADR-0063: The run's owner shares and revokes coach access from the Runner tab

- Status: accepted; implemented and verified locally (API unit and real-role integration, web unit, Chromium)
- Date: 2026-10-22
- Amends: ADR-0049 (a second, narrower discovery function); keeps ADR-0059, ADR-0060 and ADR-0061 unchanged
- Scope: one migration, two read routes, contracts and OpenAPI, the web app's Runner view and one browser test. The
  share mutation routes, the coach board, the live stream and every GPS rule are unchanged.

## Context

`PUT` and `DELETE /api/orgs/{orgId}/runs/{runId}/shares/{userId}` existed: owner-only, behind the session, Origin and
CSRF checks. The coach board already removed a run, with its position, track and selection, once the live
snapshot stopped listing it (`coach-live.spec.ts`). The web app had no way to use these endpoints: `demo.md` said
"the Runner tab has no control for sharing a run with a coach", and only scripts and tests created shares.

Two facts blocked a UI-only change. A runner cannot see other members: the `memberships` policy shows a person only
their own row, so the runner had no way to learn whom to share with. Nobody has a name: `users` holds an ID and the
identity provider's subject, and no name or email claim is stored.

## Decision

1. **Coach discovery, narrow and organization-scoped.**
   - Migration `0024` adds `app_private.list_current_org_coaches()`. It is `SECURITY DEFINER`, takes no argument
     and is executable by the runtime role only. It returns the user IDs of active `coach` memberships in
     `app.org_id`: never runners, inactive members, other organizations or the caller, at most 100, ordered by ID.
     It returns nothing unless the caller has an active membership there. Direct table visibility is unchanged.
   - `GET /api/orgs/{orgId}/coaches` calls it inside `withAuthenticatedTenantTransaction`, so a non-member gets
     403 `ORG_ACCESS_DENIED`. It refuses any query string and answers `no-store`.
2. **The owner's view of a run's shares.**
   - `GET /api/orgs/{orgId}/runs/{runId}/shares` uses the existing `ensureOwnedRun`. A grantee, another member and a
     missing run all get 404 `RUN_NOT_FOUND`; a deleted owned run gets 410.
   - It returns both flags exactly as stored, at most 100 rows by grantee, and `truncated` when more exist. It takes
     no query and answers `no-store`.
   - No migration was needed: row-level security already let the owner read `run_shares`. The explicit owner check
     matters because the same policy also shows a grantee their own row. With the check removed, the grantee and
     deleted-run tests fail.
3. **One grant in the UI.** Share sends `{ canReadLive: true, canReadHistory: true }`, and the panel says so: "Share
   gives the coach live and history access … until you revoke it". Revoke sends `DELETE`. Partial grants made through
   the API are shown as they are ("Live only", "History only", "No access"), and can be completed or revoked. A
   grantee who is not a listed coach appears as "Member" and can only be revoked.
4. **People are labelled by role and identifier.** Each row reads "Coach" or "Member" with the last 8 characters of
   the user ID, and the full ID is in the tooltip. No name is invented or stored.
5. **Sharing stays outside the runner machinery.**
   - `RunSharingController` (`run-sharing.ts`) serves one session, one organization and one run. It does not use the
     runner reducer, the IndexedDB request queue, the writer lease or capture, so a read-only second tab can share
     too: the server decides ownership.
   - Only one request is open at a time. After every change, confirmed or not, it reads the share list again, so a
     change that timed out but happened is shown as it is.
   - Offline, the action fails with a visible message and Retry. Nothing is queued or replayed.
6. **Stale answers cannot cross scopes.**
   - `App` keys the panel by user, organization and run, and passes the session's abort signal.
   - Changing any of these, or ending or replacing the session, disposes the controller. That aborts its request
     and drops any late answer, for loads, changes and the read that follows a change.
   - The panel appears only when the server knows the run (`runner.run` is set and the authority is not `refused`).

## Consequences

- Owner, coach discovery and the share list are all checked on the server. The client's choice of coach is a
  convenience: the existing foreign key still refuses a recipient outside the organization.
- Any active member, not only a run owner, can list the organization's active coaches by ID. This is new: before, a
  member could learn no other member's identifier. Only coaches are listed, never runners. An identifier reveals
  nothing else, because no name, email or identity-provider subject is returned.
- Separate live and history choices and display names are not built. Sharing a finished run from Archive → My runs
  was added later by ADR-0064, with the same panel and controller.
- A share made in another tab or through the API appears after the panel reloads (a page reload or the next change),
  not live.

## Verification

- **Contracts:** 3 new tests (schemas, bounds, OpenAPI), and `openapi.json` regenerated. **API unit:**
  `organization-coaches.spec.ts` (5); route coverage picks up both routes.
- **Integration on the `_test` database through the real runtime role:**
  - `organization-coaches.integration.test.ts` (12): scoping; inactive coaches, runners, other organizations and the
    caller excluded; deactivation followed; non-members refused; query refused; the 100 bound; nothing without an
    identity; table visibility unchanged; runtime-only execution.
  - `run-read-share.integration.test.ts` (+6): exact flags and order; it follows grants and revokes; grantee,
    stranger and other organization refused; 410 for a deleted run; query refused; truncation at 100; PUT and DELETE
    without CSRF still 403 `CSRF_DENIED`.
- **Web:**
  - `runner-api.spec.ts` (+6).
  - `run-sharing.spec.ts` (11): rows, labels, actions, one change at a time, reload after success and failure, error
    and retry, truncation, silence after dispose.
  - `RunSharePanel.spec.tsx` (6).
- **Chromium, real API:** `tests/e2e/run-sharing.spec.ts` (2).
  - The runner presses Share in the Runner tab, the coach's board shows the marker and the selected track, the runner
    presses Revoke, and the marker, the track option and the selection disappear while the run keeps recording.
  - A live-only grant made through the API is shown as "Live only" and completed from the panel.
  - With Share changed to send `canReadLive: false`, both tests failed on the panel showing "History only".
