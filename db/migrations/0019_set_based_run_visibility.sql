-- P11.5: set-based read visibility for runs, run_points and run_summaries. See ADR-0042.
--
-- P11.4 measured the per-row policy predicate as nearly all of the cost of every hot read: the SELECT
-- policies on run_points, run_summaries and (for non-owned rows) runs called a SECURITY DEFINER
-- function once per candidate row, and that function re-checked the membership and looked the run and
-- its share up by key each time (about 8 buffers and 45-50 microseconds per row). The visible result
-- is a function of the identity and the tenant only, so it can be computed once per statement.
--
-- The two set functions below return, in one statement, exactly the (org_id, run_id) pairs for which
-- the existing per-row functions are true:
--   readable_run_keys()          <=> app_private.can_read_run(org_id, id)
--   history_readable_run_keys()  <=> app_private.can_read_run_history(org_id, id)
-- The per-row functions are unchanged and remain the specification: they are still used by explicit
-- statements, and the integration suite compares every set with them for every fixture identity.
--
-- The policies use `(org_id, run_id) IN (SELECT ... FROM set_function())`. The subquery is uncorrelated,
-- so PostgreSQL evaluates it once per statement into a hash table and each row costs one probe. The
-- functions keep the same security properties as the per-row ones: SECURITY DEFINER (so they read `runs`
-- and `run_shares` without recursing into their policies), STABLE, a pinned search_path, no PUBLIC
-- execute, runtime-role execute only, and a fail-closed answer (no rows) without an active membership
-- in the current tenant, with a missing or malformed context, or for another tenant's runs.
--
-- The cost of that set is proportional to the runs the identity can read, however few rows the statement
-- touches. The live-state poll reads a handful of rows and runs every two seconds, so it may narrow the
-- set: with the transaction-local setting `app.visibility_scope = 'live'`, readable_run_keys() returns
-- only the readable runs that are recording or paused. The setting can only REMOVE rows from the answer,
-- never add one, so a wrong, stale, or hostile value fails closed. The narrowing is chosen by one-time
-- filters so the planner does not execute the branch that is switched off. history_readable_run_keys()
-- has no narrowing: the archive never needs it.
--
-- Point reads: the owner branch of the `runs` policy stays first and stays a plain column comparison, so
-- a runner reading their own run never builds the set. Only a row that is not the caller's own (a
-- shared run) evaluates the set, once per statement. The row estimate is declared so the planner
-- hashes the result.
--
-- Nothing here widens or narrows access: no table privilege, no grant on a table, and no other policy
-- (insert/update/delete on runs and run_shares, run_points insert, run_commands, run_tombstones) changes.

CREATE FUNCTION app_private.live_visibility_scope()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(pg_catalog.current_setting('app.visibility_scope', true) = 'live', false)
$$;

CREATE FUNCTION app_private.readable_run_keys()
RETURNS TABLE (org_id uuid, run_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
ROWS 4000
SET search_path = pg_catalog
AS $$
  SELECT owned.org_id, owned.id
  FROM public.runs AS owned
  WHERE NOT app_private.live_visibility_scope()
    AND app_private.has_active_membership()
    AND owned.org_id = app_private.current_org_id()
    AND owned.user_id = app_private.current_user_id()
  UNION ALL
  SELECT owned.org_id, owned.id
  FROM public.runs AS owned
  WHERE app_private.live_visibility_scope()
    AND app_private.has_active_membership()
    AND owned.org_id = app_private.current_org_id()
    AND owned.user_id = app_private.current_user_id()
    AND owned.status IN ('recording', 'paused')
  UNION ALL
  SELECT shared.org_id, shared.id
  FROM public.runs AS shared
  JOIN public.run_shares AS share
    ON share.org_id = shared.org_id
   AND share.run_id = shared.id
  WHERE NOT app_private.live_visibility_scope()
    AND app_private.has_active_membership()
    AND shared.org_id = app_private.current_org_id()
    AND shared.user_id IS DISTINCT FROM app_private.current_user_id()
    AND share.grantee_user_id = app_private.current_user_id()
    AND (
      (shared.status IN ('recording', 'paused') AND share.can_read_live)
      OR (shared.status = 'finished' AND share.can_read_history)
    )
  UNION ALL
  SELECT shared.org_id, shared.id
  FROM public.runs AS shared
  JOIN public.run_shares AS share
    ON share.org_id = shared.org_id
   AND share.run_id = shared.id
  WHERE app_private.live_visibility_scope()
    AND app_private.has_active_membership()
    AND shared.org_id = app_private.current_org_id()
    AND shared.user_id IS DISTINCT FROM app_private.current_user_id()
    AND shared.status IN ('recording', 'paused')
    AND share.grantee_user_id = app_private.current_user_id()
    AND share.can_read_live
$$;

CREATE FUNCTION app_private.history_readable_run_keys()
RETURNS TABLE (org_id uuid, run_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
ROWS 4000
SET search_path = pg_catalog
AS $$
  SELECT owned.org_id, owned.id
  FROM public.runs AS owned
  WHERE app_private.has_active_membership()
    AND owned.org_id = app_private.current_org_id()
    AND owned.user_id = app_private.current_user_id()
  UNION ALL
  SELECT shared.org_id, shared.id
  FROM public.runs AS shared
  JOIN public.run_shares AS share
    ON share.org_id = shared.org_id
   AND share.run_id = shared.id
  WHERE app_private.has_active_membership()
    AND shared.org_id = app_private.current_org_id()
    AND shared.user_id IS DISTINCT FROM app_private.current_user_id()
    AND shared.status = 'finished'
    AND share.grantee_user_id = app_private.current_user_id()
    AND share.can_read_history
$$;

REVOKE ALL ON FUNCTION app_private.live_visibility_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.readable_run_keys() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.history_readable_run_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.readable_run_keys() TO running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.history_readable_run_keys() TO running_tracker_runtime;

DROP POLICY runs_select_authorized ON runs;

CREATE POLICY runs_select_authorized
ON runs
FOR SELECT
TO running_tracker_runtime
USING (
  (
    org_id = app_private.current_org_id()
    AND user_id = app_private.current_user_id()
    AND app_private.has_active_membership()
  )
  OR (org_id, id) IN (
    SELECT visible.org_id, visible.run_id FROM app_private.readable_run_keys() AS visible
  )
);

DROP POLICY run_points_select_authorized ON run_points;

CREATE POLICY run_points_select_authorized
ON run_points
FOR SELECT
TO running_tracker_runtime
USING (
  (org_id, run_id) IN (
    SELECT visible.org_id, visible.run_id FROM app_private.readable_run_keys() AS visible
  )
);

DROP POLICY run_summaries_select_authorized_history ON run_summaries;

CREATE POLICY run_summaries_select_authorized_history
ON run_summaries
FOR SELECT
TO running_tracker_runtime
USING (
  (org_id, run_id) IN (
    SELECT visible.org_id, visible.run_id FROM app_private.history_readable_run_keys() AS visible
  )
);
