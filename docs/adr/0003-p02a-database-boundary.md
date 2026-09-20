# ADR-0003: P02A database roles, tenant context, and identity RLS

- Status: accepted
- Date: 2026-09-20
- Scope: P01.1 migration hardening and P02A

## Context

The API needs tenant isolation before run/share tables exist, while PostgreSQL extensions and roles require privileges that the runtime process must never receive. A pooled connection also cannot retain one request's user/organization context when it is reused. Policies on `memberships` cannot query the same RLS-protected table recursively.

## Decision

1. A separately invoked bootstrap uses local admin credentials to create PostGIS and three `NOSUPERUSER NOBYPASSRLS` roles. `running_tracker_owner` owns objects and runs migrations; `running_tracker_runtime` is the API login; `running_tracker_maintenance` has CONNECT only in P02A.
2. Migration URLs are required explicitly. The migration runner never falls back to the API `DATABASE_URL`, and API configuration never loads bootstrap or migration credentials.
3. `withTenantTransaction` validates canonical UUIDs, checks out one client, begins a transaction, sets `app.user_id` and `app.org_id` with `set_config(..., true)`, and gives that same client to the callback. COMMIT failure is an unknown outcome and destroys the connection; rollback failure does not replace the callback error and also destroys the connection.
4. Runtime access in P02A is read-only and requires an active membership for the exact context:

   | Relation | Visible rows | Runtime writes |
   |---|---|---|
   | `users` | current user | none |
   | `organizations` | current organization | none |
   | `memberships` | current user's active membership in current organization | none |
   | `schema_migrations` | none | none |

5. `app_private.has_active_membership()` is the sole `SECURITY DEFINER` helper. It returns only a boolean, is owned by the object owner, uses `search_path = pg_catalog` with fully qualified application objects, is revoked from PUBLIC, and is executable only by runtime. This narrow owner-bypass avoids recursive membership RLS without exposing membership rows or general SQL.
6. The trusted application/session boundary chooses context. Custom GUC values do not protect against arbitrary SQL executed with compromised runtime credentials; HTTP authentication remains P03.

## Consequences

- Missing/malformed context and inactive/absent membership fail closed with zero visible rows.
- Runtime cannot perform DDL, own tables, bypass RLS, or mutate migration metadata.
- Fixtures require the explicit owner connection; integration assertions use runtime credentials.
- P02B must add run/share/child policies and finish D02 without broadening this identity baseline by default.
