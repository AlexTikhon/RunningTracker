# Managing sharing of finished runs from My runs: design

Date: 2026-10-22. Status: approved by the task brief. Decision record: ADR-0064.

## Goal

The owner manages coach access to a finished run from **Archive → My runs**, also after **New run** and after a
reload. Today the only panel is mounted for `runner.run`, so clearing the finished run removes it while the
server-side grant stays.

## What stays unchanged

- The share routes, the coach and share-list routes, RLS and every migration. `run-read-share.integration.test.ts`
  already covers granting, reading and revoking a finished run's history, owner-only management, and 410 for a
  deleted run.
- The runner reducer, the IndexedDB queue, writer fencing, capture, archive tiles and the search contract.
- `RunSharingController` and its permission semantics (ADR-0063).

## Additions (web only)

1. Each My runs card gets a **Manage sharing** button (`aria-expanded`, named by the card's date). The list is the
   owner-only search, so the action is never offered for another person's run.
2. One open panel at a time, inside its card, which then spans the row. It names the run by date and the first
   8 characters of its ID, has Close (and Escape), takes focus on open and returns it to the button on close.
3. The panel is the existing `RunSharePanel` with an `archive` variant: finished-run copy and no heading of its own.
   It is keyed by user, organization and run, and takes the session signal that `App` threads through `ArchiveScreen`
   and `RunSearchPanel`.
4. The selection belongs to one applied search. It is dropped when that search is no longer shown or no longer lists
   the run: a newly applied search, a first page read again, lost access, a failure. Another page keeps it.
5. `RunSharingSnapshot.unavailable` marks a 410 `RUN_DELETED`, 404 `RUN_NOT_FOUND` or 403 `ORG_ACCESS_DENIED`. The
   Archive frame then unmounts the panel (disposing its controller) and shows the reason with Close only. The Runner
   tab ignores it and keeps Retry.

## Testing

- Unit: the controller's `unavailable` classification and the refused change; the selection rule; static markup for
  the cards, the frame and the archive copy.
- Chromium, real API: the Runner-tab grant managed from My runs after New run and a reload; share and revoke from
  My runs with coach reads; one panel, Close, Escape and focus; a deleted run; held answers across runs,
  organizations and a replaced session; sign-out while a change is held.
