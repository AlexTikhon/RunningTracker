# Managing sharing of finished runs from My runs: implementation plan

Spec: `docs/superpowers/specs/2026-10-22-archive-run-sharing-design.md`. Nothing is committed or pushed.

1. **Controller.** Add `unavailable` to `RunSharingSnapshot`, set from the failure in `#fail`. Tests in
   `run-sharing.spec.ts`.
2. **Panel.** In `RunSharePanel.tsx`, add the `archive` variant and `onUnavailable`, and take the heading id from
   `useId`. Tests in `RunSharePanel.spec.tsx`.
3. **Frame.** Add `ArchiveRunShare.tsx` (the frame, focus, Close and Escape, the unavailable notice) and the
   `openSharingItem` rule, with `ArchiveRunShare.spec.tsx`.
4. **Cards.**
   - `RunSearchResults.tsx`: the Manage sharing button and the open panel. Tests in `RunSearchResults.spec.tsx`.
   - `RunSearchPanel.tsx`: the selection state.
   - `ArchiveScreen.tsx` and `App.tsx`: pass the session signal.
   - A little CSS.
5. **Browser.** Add `tests/e2e/archive-sharing.spec.ts` and `AuthedApi.getRunStatus`. Build first, then run it with
   `run-sharing`, `coach-live`, `run-search*` and `new-run-takeover`.
6. **Docs.** ADR-0064, a note in ADR-0063, `demo.md`, `progress.md` and the README count. D10 stays open.
7. **Verification.** `npm run verify`, `npm run test:integration` on `_test`, the browser specs, `git diff --check`
   and `git status`.
