# ADR-0006: run_commands and run_tombstones storage and ACL

- Status: accepted; implemented scope verified against PostgreSQL/PostGIS
- Date: 2026-09-21
- Scope: final database storage/ACL fragment of P02B and D02

## Context

Command retries need immutable request/response records, but the schema alone
cannot implement lifecycle validation or atomic command execution. Deletion
retries need a marker that survives removal of the parent run, but retention and
the deletion transaction belong to P10. Neither record may become visible merely
because a user has live/history access or the coach role.

## Decision

1. `run_commands` stores UUID tenant/run/command identifiers, non-null JSONB
   objects for `canonical_payload` and `response`, and a finite
   `timestamptz(3)` receive time. Its composite primary key provides command
   identity; its composite run FK is tenant-bound and cascades on run deletion.
2. Runtime may SELECT and INSERT commands only when
   `app_private.is_run_owner(org_id, run_id)` confirms an active owner in the
   current organization. It receives no UPDATE or DELETE privilege. Run grants
   and coach membership never expose payloads or saved responses. Direct reads
   and reads joined to `runs` have the same result.
3. JSONB object storage and the name `canonical_payload` do not define input
   canonicalization, semantic duplicate comparison, command validation, replay
   behavior, or atomicity with the run state change. P03 must provide those
   guarantees in one transaction and define the complete HTTP response contract.
4. `run_tombstones` stores only `(org_id, run_id, owner_user_id, deleted_at,
   expires_at)`. Both timestamps are finite millisecond timestamps and expiry
   must be later than deletion. The owner has a same-organization membership FK
   with `ON DELETE RESTRICT`; deactivation therefore preserves the marker. There
   is deliberately no FK to `runs`, and an expiry index supports future cleanup.
5. Runtime receives only SELECT on tombstones. RLS compares the row's
   `owner_user_id` and `org_id` directly with the current context and requires an
   active membership. It does not query the deleted run or reuse run/share
   predicates. Prior grants, coach role, and membership in another organization
   confer no access.
6. Tombstone INSERT/UPDATE/DELETE remains object-owner-only test/setup behavior.
   Maintenance receives no new privilege. P10 must atomically verify the actual
   run owner, insert the tombstone, delete the run, and advance
   `archive_revision`; it must also decide retention, expiry behavior, and
   cleanup. The schema does not prohibit later reuse of a deleted run ID.

## Database guarantees

- PK/FK/CHECK constraints enforce tenant-bound command parents, object-shaped
  command JSON, immutable runtime command rows, same-organization tombstone
  owners, finite timestamps, and ordered expiry.
- Run deletion cascades commands but not tombstones; tombstones may exist with no
  parent and the same run UUID may be represented independently in different
  organizations.
- Both tables have RLS enabled, are owned by `running_tracker_owner`, have narrow
  runtime grants, and remain inaccessible to `running_tracker_maintenance`.

## Consequences

- D02 is resolved for the database boundary: the full identity/run/share/child
  direct and joined ACL matrix passed under the real runtime role. This assumes
  trusted transaction-local tenant/user context; HTTP authentication and session
  establishment remain P03 and are not proven by RLS tests.
- D01 remains TODO. Command JSON constraints do not settle `PointInput`
  canonicalization or retry comparison.
- D08, retention, cleanup, replay after expiry, and the atomic deletion workflow
  remain P10. P03 and P10 services are not implemented by this ADR.

## Verification

On 2026-09-21, migration `0005` was applied to the isolated
`running_tracker_test` database and then skipped on rerun. Twelve focused
commands/tombstones scenarios passed, followed by the complete five-file,
69-scenario integration suite under the real owner, runtime, and maintenance
roles. Coverage included direct/JOIN reads, all grant/role denial paths,
same-transaction run then command `INSERT ... RETURNING`, immutable duplicate and
upsert behavior, exact SQLSTATE/constraint checks, command cascade, post-delete
tombstones, inactive membership, cross-tenant isolation, catalog grants/RLS/
ownership, and maintenance denial. `npm run verify` and `git diff --check` also
passed locally; hosted CI was not run.
