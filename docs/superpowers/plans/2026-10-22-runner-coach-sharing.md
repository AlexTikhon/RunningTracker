# Runner → coach sharing: implementation plan

Spec: `docs/superpowers/specs/2026-10-22-runner-coach-sharing-design.md`. Work test-first inside each step. Nothing is
committed or pushed.

1. **Contracts.**
   - Add `organizationCoachListResponseSchema` and `runShareListResponseSchema` (with `ORGANIZATION_COACH_LIST_MAX`
     and `RUN_SHARE_LIST_MAX` = 100), their types, the OpenAPI paths and component schemas.
   - Add contract tests and regenerate `openapi.json` by building the contracts.
2. **Migration 0024.**
   - Add `list_current_org_coaches()`, following 0022.
   - Integration test `organization-coaches.integration.test.ts`: scoping, inactive, other organizations, self,
     no identity, privileges, unchanged table visibility, and the route through the real runtime role.
3. **Coach route.**
   - Add `organizations/organization-coach.routes.ts` and mount it at `/api/orgs/:orgId/coaches`.
   - Unit test with a stub pool (`organization-coaches.spec.ts`). The route-coverage test must pass unchanged.
4. **Share list.**
   - Add `listRunShares` in `run-service.ts` and the `GET /:runId/shares` route.
   - Extend `run-read-share.integration.test.ts`: owner list, partial flags, grantee, stranger and other
     organization refused, deleted run, truncation, and CSRF still required on PUT/DELETE.
5. **Web API.** Add four functions to `runner-api.ts`, with tests in `runner-api.spec.ts`.
6. **Web model and controller.** Add `run-sharing.ts` with `run-sharing.spec.ts`.
7. **Panel.**
   - Add `RunSharePanel.tsx` with `RunSharePanel.spec.tsx` (static markup) and a little CSS.
   - Mount it in `App.tsx`, with an `App.spec.tsx` check if the existing harness allows it.
8. **Browser test.**
   - Add `RunnerPage` share helpers and `tests/e2e/run-sharing.spec.ts`: Share → coach marker → select track →
     Revoke → marker, track option and selection gone.
   - Build first (`npm run build`), then run the new spec and the coach-live spec.
9. **Documentation.**
   - Write ADR-0063 and update `demo.md` (the Runner tab can share), `progress.md`, `review-closeout.md` (if it
     lists the gap) and `real-device-pilot.md` step 5.
   - D10 stays awaiting physical recordings.
10. **Verification.**
    - Run lint, typecheck and unit tests (`npm run verify`).
    - Run the API integration suite on `_test`.
    - Run the e2e specs above, then the full e2e suite if time allows.
    - Run `git diff --check` and check `git status`.
