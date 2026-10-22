-- Coach discovery for sharing a run (ADR-0063). A run's owner needs to know whom to share with, but the
-- memberships policy shows a person only their own membership, so the runtime role cannot ask "who are the
-- coaches here?" through the table.
--
-- This function is a narrow, read-only exception in the same shape as list_current_user_organizations (migration
-- 0022). It takes no argument: the organization and the identity are whatever the application set for the current
-- transaction (`app.org_id`, `app.user_id`), and nothing is returned unless that identity has an active membership
-- in that organization. It returns user identifiers only, for active `coach` memberships only, never the caller,
-- in a fixed order, and never more than 100. It is executable by the runtime role only. Direct visibility of the
-- memberships table is unchanged.
CREATE FUNCTION app_private.list_current_org_coaches()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT membership.user_id
  FROM public.memberships AS membership
  WHERE app_private.has_active_membership()
    AND membership.org_id = app_private.current_org_id()
    AND membership.role = 'coach'
    AND membership.active
    AND membership.user_id IS DISTINCT FROM app_private.current_user_id()
  ORDER BY membership.user_id
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION app_private.list_current_org_coaches() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.list_current_org_coaches() FROM running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.list_current_org_coaches() TO running_tracker_runtime;
