# ADR-0064: The owner manages a finished run's sharing from My runs

- Status: accepted; implemented and verified locally (web unit, Chromium against the real API)
- Date: 2026-10-22
- Amends: ADR-0063 (the panel now also opens from Archive → My runs); ADR-0056 and ADR-0060 are unchanged
- Scope: the web app only. No route, contract, migration or RLS change.

## Context

ADR-0063 mounted `RunSharePanel` for `runner.run`. Pressing **New run** clears that run, so the panel went away
while the server-side grant stayed: the owner could no longer see or revoke it. My runs (ADR-0056) lists the
owner's finished runs and had no sharing action. The routes already worked for an owned finished run, and
`run-read-share.integration.test.ts` covers granting and revoking history access on one, owner-only management and
410 for a deleted run. No backend test was missing, so none was added.

## Decision

1. **One action per card, one panel at a time.**
   - Each My runs card has **Manage sharing** (`aria-expanded`, named "Manage sharing for your run of <date>").
   - The open card spans the row and holds the panel. Its heading is "Sharing for your run of <date> #<first 8 of
     the ID>".
   - Close and Escape close the panel and return focus to the button. Opening moves focus to the heading.
   - Nothing about sharing is requested before a panel is opened.
2. **The same panel and controller.**
   - The panel is `RunSharePanel` with `variant="archive"`: the same rows, Share (live and history), Revoke, exact
     partial grants and revoke-only members.
   - The copy says the run is finished, so the coach sees its recorded route, distance and duration until the share
     is revoked.
   - The heading id comes from `useId`, because the Runner tab's hidden panel can be in the page at the same time.
3. **Scope.**
   - `App` passes `session.signal` through `ArchiveScreen` and `RunSearchPanel`, and the panel is keyed by user,
     organization and run.
   - Closing, choosing another card, another organization or person, leaving the Archive, or ending the session
     unmounts it, which disposes the controller (ADR-0063 §6).
   - A same-user session replacement also gives organization discovery a new signal, so the whole Archive remounts
     and the panel closes.
   - The selected run is never handed to the runner: no reducer action, no storage write, no active-run pointer.
4. **The selection belongs to the search on screen.**
   - It is kept only while the applied search is the one shown, its first page is ready, and the list contains the
     run. Loading another page keeps it.
   - A newly applied search, a first page read again (Retry, Search again), lost access or a failure drops it. A later
     list that contains the run again does not reopen it.
   - The list is the owner-only search, so the action is never offered for a run that only appears on the map.
5. **A run the server refuses for good loses its controls.**
   - The controller now reports `unavailable`: `deleted` (410 `RUN_DELETED`), `missing` (404 `RUN_NOT_FOUND`) or
     `no-access` (403 `ORG_ACCESS_DENIED`). It is set on the error snapshot of a load or of the re-read after a
     change.
   - The Archive frame then unmounts the panel and shows the reason with Close only. The Runner tab ignores it and
     keeps Retry, because a run started offline can be unknown to the server for a while.
   - A change that failed or timed out is still not shown as done. The share list is read again (ADR-0063), and
     nothing is replayed or queued. 401 handling and the CSRF and Origin checks are unchanged.

## Consequences

- A grant survives New run and a reload and stays manageable for as long as the run appears in a search.
- The search does not refresh by itself. After a deletion the card stays until the next search, but its panel shows
  only the reason.
- Live and history are still granted together. Separate choices and display names are still not built.

## Verification

- **Web unit:** 700 tests, 684 + 16.
  - `run-sharing.spec.ts` (+2): the classification of six failures, and a refused change that leaves nothing to act
    on and sends nothing again.
  - `RunSharePanel.spec.tsx` (+2): the archive copy, and a unique heading id.
  - `ArchiveRunShare.spec.tsx` (8): the selection rule, the frame's name, Close, and the loading state.
  - `RunSearchResults.spec.tsx` (+4): the action on every card, one panel in the chosen card, and nothing for a
    run that is not listed.
- **Chromium, real API:** `tests/e2e/archive-sharing.spec.ts` (4).
  - A run is shared from the Runner tab, finished and cleared with New run, and its summary is published. It is then
    revoked from My runs: the coach's history read gets 404 and the owner's 200. After a reload the run is still
    manageable and the active run is still null.
  - An unshared run is shared and revoked from My runs, with the coach's read going 404 → 200 → 404. One panel at a
    time; Close, Escape and focus return. A new search closes the panel. A run deleted while its panel is open
    leaves only the deleted notice and Close.
  - Held answers:
    - A held share list for run A, released after B is opened, changes nothing and causes no further read of A.
    - A held grant on B, released after an organization switch, causes no re-read of B, and there is still no
      active run.
    - A grant held across a same-user session replacement is never re-sent. The next grant carries the new CSRF
      token.
  - Sign-out with a held grant leaves no panel and no follow-up read.
