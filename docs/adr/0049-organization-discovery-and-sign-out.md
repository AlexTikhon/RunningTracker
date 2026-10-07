# ADR-0049: Organization discovery and explicit application sign-out

- Status: accepted; implemented and verified locally
- Date: 2026-10-06
- Amends: ADR-0007 (a session can now also be ended from the web app), ADR-0046 (sign-out stays application-only), ADR-0048 (sign-out is one more way to suspend the runner)

## Context

The only way into an organization was to paste its UUID into the web app, and the web app had no way to end a
session although `DELETE /api/session` already existed. Every tenant policy needs `app.org_id` to be set
before any row is visible, so the runtime role could not ask which organizations an identity belongs to, and
the browser had nothing to ask.

## Decision

1. **`GET /api/organizations`.** Session-authenticated, `no-store`, no parameters (any query string is refused
   with 400, so nothing can be mistaken for a way to ask about another user). It answers
   `{ items: [{ organizationId }] }` for the identity's active memberships, ordered by organization id, at most
   100. A person with no active membership gets `200` with an empty list. Only identifiers are returned, because
   the `organizations` table holds nothing else and no name is invented for the screen. Discovery grants
   nothing: every later request is still checked against the membership inside its own transaction.
2. **How the database answers (migration 0022).** A read-only `SECURITY DEFINER` function
   `app_private.list_current_user_organizations()`, in the shape of `resolve_login_user` (migration 0021). It
   takes no argument and reads `app.user_id`, so it can only answer for the identity the transaction was opened
   for and returns nothing when none was declared. Executable by the runtime role only. A user-only transaction
   helper (`withUserTransaction`) sets `app.user_id` and no organization. Considered and rejected: querying as
   the owner role (bypasses row-level security), and a new `memberships` select policy (it would let every query
   of the runtime role read the identity's membership rows across organizations, a wider surface than one
   function that returns identifiers). The list is capped at 100 and the cap is stated in the OpenAPI
   description; a person with more would see the first 100 by id (memberships are provisioned by the operator
   and have two roles, so this is a bound, not an expected case).
3. **Selection in the web app.** After the session is ready the app loads the list. One organization is
   selected on its own, several are offered in a selector, none shows a plain explanation. The selection is
   always derived from the list the server just returned: a preferred organization counts only while it is in
   it. The preference is the organization of a recovered run, else the one this identity chose last (kept in
   `localStorage` under the user id; storage that is refused just means choosing again). The list and the
   preference are tied to the session lifetime and identity, so another person never sees the previous one's.
   The manual UUID field is removed from every view, with no debug variant.
4. **A run keeps its own organization.** Capture and upload use the organization recorded with the run
   (restored from IndexedDB, or the one the run started in), not the selection. Before this, the Coach and
   Archive inputs shared one value with the uploader, so changing it while a run existed would have redirected
   that run's points. The selector is also disabled while a run exists.
5. **Sign out.** The button calls `DELETE /api/session` and waits for the answer. Success (or a `401`, which means
   the session was already gone) ends the local session: capture and upload stop through the same suspension
   as expiry, the writer lease is released, the in-memory runner state, selection and organization list are
   dropped, and the page shows "Sign in required" with the reason. A failure leaves the person signed in and says
   so; the page never looks signed out while the cookie still works. **Nothing durable is touched**: the exact
   points, lifecycle requests, run pointer and rejected queue stay in IndexedDB under the user id, so the same
   person recovers them through ADR-0048 on the next sign-in, and a different person on the same browser reads
   keys that are scoped to a different user and sees none of it. A run that was recording stays recording on the
   server; if nobody returns, the existing auto-finish rule ends it. The session bar says so when something is
   unsent. There is no "clear local data" option.
6. **Not done.** No provider-side (RP-initiated) logout; the provider session survives and the next sign-in
   completes without a login page. The remembered organization of a signed-out identity stays in `localStorage`
   (an organization identifier the person belongs to, keyed by user id, applied only through the list). Other
   tabs learn of a sign-out the way they learn of an expiry: at their next request or when the tab regains
   focus.

## Verification

Unit: the contract, the route against a recording pool (identity, no organization set, query refused, uncached,
fail-closed on a malformed row), the user-only transaction, the selection rules, the session-end reasons, the
sign-out reducer reset, and the components. Real PostgreSQL under the runtime role: one, several (stable order),
inactive, another user's, none, the 100-row bound, no widening of direct table reads, privileges. Browser
(Chromium): discovery for one, several (with a foreign and an inactive organization), a stale remembered choice,
and no membership; ordinary sign-out with `401` on every protected route and the cookie gone; a failed sign-out;
mid-run recovery with every buffered point delivered exactly once; a pending lifecycle request retried with its
exact body; a rejected buffer kept through sign-out; a different person who sees and uploads nothing of the
previous one's. Mutation checks: dropping the active-membership filter, dropping the identity filter, and making
sign-out delete the IndexedDB database each failed the tests that name them.
