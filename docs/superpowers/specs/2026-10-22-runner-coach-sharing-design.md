# Runner → coach sharing in the web app: design

Date: 2026-10-22. Status: approved (approach A). Decision record: ADR-0063.

## Goal

The run's owner grants a coach access to the run from the Runner tab, the coach sees it through the existing live
stream, the owner revokes it, and the coach's position, track and selection for that run disappear. Today this is
only possible with direct API calls (`demo:run`, tests).

## What already exists and stays unchanged

- `PUT`/`DELETE /api/orgs/{orgId}/runs/{runId}/shares/{userId}`: owner-only (`ensureOwnedRun`), with session
  authentication and the existing Origin and CSRF mutation protection. The grantee must be a member of the
  organization (foreign key).
- RLS: `run_shares_select_owner_or_grantee` already lets the owner read a run's shares.
- The coach board: every live snapshot replaces the run list, and `coach-state.ts` drops runs that are no longer
  there, together with their last-known position, track and selection (`coach-live.spec.ts` covers a revocation
  made through the API).

## Additions

1. **Migration `0024_list_current_org_coaches.sql`** (0023 is taken): `app_private.list_current_org_coaches()`.
   It is `SECURITY DEFINER`, takes no argument, and returns at most 100 user IDs: active `coach` memberships of
   `app.org_id`, excluding `app.user_id`, ordered by user ID. It returns nothing unless the caller has an active
   membership in that organization. It is executable by `running_tracker_runtime` only. Direct table visibility
   does not change.
2. **`GET /api/orgs/{orgId}/coaches`** returns `{ items: [{ userId }] }` with `no-store`. It takes no query string
   (one is refused with a 400). It runs in `withAuthenticatedTenantTransaction`, so a non-member gets
   403 `ORG_ACCESS_DENIED`.
3. **`GET /api/orgs/{orgId}/runs/{runId}/shares`** returns `{ items: [{ userId, canReadLive, canReadHistory }],
   truncated }` with `no-store`. It is owner-only through `ensureOwnedRun`: a grantee or another member gets the same
   404 `RUN_NOT_FOUND` as for a missing run, and a deleted owned run gives 410. It returns at most 100 rows ordered
   by grantee, and `truncated` is true when more exist.
4. **Contracts and OpenAPI:** the two response schemas, two paths, and the regenerated `openapi.json`.
5. **Web:**
   - `runner-api.ts` gains `loadOrganizationCoaches`, `loadRunShares`, `grantRunShare` (always
     `{ canReadLive: true, canReadHistory: true }`) and `revokeRunShare`. The mutations send the session's CSRF
     header.
   - `run-sharing.ts` holds a pure row model and a `RunSharingController`. Each controller serves one session, one
     organization and one run. `dispose()` aborts the requests in flight and silences late answers. Only one change
     runs at a time. After every change, whether it succeeded or failed, the share list is read again, so the
     panel never shows a guessed state.
   - `RunSharePanel.tsx` renders the controller's state.
   - `App` mounts it under the Runner view when the session is ready, the run exists, its organization is known and
     the server has not refused it. Its key is `userId|orgId|runId`, and the session's abort signal disposes the
     controller.
   - The panel does not use the runner reducer, the durable request queue, the writer lease or capture. It is
     available in a read-only tab too: the server decides ownership.

## Panel behaviour

- The panel states plainly: **Share gives the coach live and history access**: the position and track while
  recording, and the finished run afterwards, until the owner revokes it.
- Rows are the listed coaches plus any existing grantee who is not a listed coach (shown as "Member"). The label is
  "Coach" or "Member" with the last 8 characters of the user ID. The full ID is in the `title`. No name exists.
- The access column shows "Not shared", "Live and history", "Live only", "History only" or "No access", exactly as
  the server reports it.
  - An unshared coach row offers **Share**.
  - A full grant offers **Revoke**.
  - A partial grant offers **Share live and history** and **Revoke**.
  - A non-coach grantee row offers **Revoke** only.
- While loading or changing, the buttons are disabled. A failure shows the server's message with a request
  reference and a **Retry** button. A 401 goes to the existing sign-in handling. Offline, actions fail visibly;
  nothing is queued.

## Out of scope

Display names, sharing from the Archive, separate live and history checkboxes, offline sharing, and any change to
the coach board, the share mutation routes, the live stream, GPS, or D10 (still awaiting physical recordings).

## Verification

- **API unit tests (stub pool):** the statement and identity used, the no-query refusal, and contract
  fail-closed.
- **Real-role integration (`_test`):**
  - Coach discovery is scoped to active coaches of the caller's organization; inactive coaches, runners, other
    organizations and the caller are excluded; a non-member is refused.
  - The function is runtime-only and returns nothing without an identity; table visibility does not widen.
  - The share list is owner-only: a grantee, a stranger and another organization are refused, partial flags are
    exact, and truncation works.
  - Share PUT/DELETE without CSRF is still refused.
- **Web unit tests:** the row model, the controller (stale answers after dispose, one change at a time, a reload
  after success and after failure), the panel markup, and the API functions.
- **Browser (Chromium, real API, `_test`):** the runner records with the simulator and presses Share; the coach sees
  the marker and selects the track; the runner presses Revoke; the marker, track option and selection go.
