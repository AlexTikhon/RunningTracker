# ADR-0004: non-recursive runs and run_shares ACL fragment

- Status: accepted; implementation not yet executed against PostgreSQL
- Date: 2026-09-20
- Scope: first bounded fragment of P02B and D02

## Context

`runs` must be visible to its owner or to an explicitly authorized grantee, while
`run_shares` must remain directly queryable only by the run owner and the grant's
recipient. A policy on `runs` that queries `run_shares` and a policy on
`run_shares` that queries `runs` would create mutual RLS recursion. The first
P02B fragment also deliberately excludes child tables, tombstones, lifecycle
services, and HTTP behavior.

## Decision

1. Create only `runs` and `run_shares`, with composite tenant keys and foreign
   keys through same-organization memberships. Keep the SDD's global partial
   unique index on `runs(user_id)` for `recording` and `paused` states.
2. Interpret `can_read_live` as access to `recording` and `paused` runs, and
   `can_read_history` as access to `finished` runs. A coach role alone grants no
   run access. Every path requires an active membership in the current
   transaction-local organization context.
3. Use two narrow boolean `SECURITY DEFINER` functions:
   `app_private.can_read_run(org_id, run_id)` reads `runs` and `run_shares`, and
   `app_private.is_run_owner(org_id, run_id)` reads only `runs`. Both have a
   fixed `pg_catalog` search path, fully qualified relation names, and PUBLIC
   EXECUTE revoked. Policies call these functions in one direction instead of
   querying the other RLS-protected table.
4. The runtime role receives `SELECT` and `INSERT` on `runs`, plus column-level
   `UPDATE` only for status, finish time, revisions, and raw state. It receives no
   `DELETE` until tombstone-backed atomic deletion exists. Run insert/update
   policies also require the current active member to remain the owner in the
   current organization, preventing owner or tenant reassignment even if grants
   are broadened later.
5. The runtime role receives `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on
   `run_shares`. Only the run owner may mutate shares; a grantee may read only
   its own grant and cannot mutate either the run or grants.
6. Maintenance receives no new table privileges. Child-table ACL remains for a
   later P02B fragment, so D02 remains PARTIAL.

## Consequences

- Owner/grantee authorization is evaluated from current database state, so grant
  revocation and membership deactivation take effect on the next statement.
- Direct `run_shares` reads do not disclose other users' grants to a grantee or
  unrelated member.
- The definer functions expose only authorization booleans, not rows or generic
  SQL execution, but their behavior still requires real runtime-role integration
  verification before this fragment can be called verified.
- `run_points`, `run_commands`, `run_summaries`, and `run_tombstones` are absent;
  therefore P02B.1 and D02 are not complete.
