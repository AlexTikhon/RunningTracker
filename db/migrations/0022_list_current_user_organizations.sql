-- Organization discovery. A person has to learn which organizations they belong to before they can name one,
-- and every tenant policy in this schema requires an organization to already be selected
-- (`app.org_id`), so the runtime role cannot ask "which organizations am I in?" through the tables.
--
-- This function is the one narrow, read-only exception, in the same shape as resolve_login_user (migration
-- 0021). It takes no argument: the identity is whatever the application set for the current transaction
-- (`app.user_id`), so a caller cannot ask about anybody else, and an unset identity returns nothing. It
-- returns organization identifiers only, for active memberships only, in a fixed order, and never more than
-- 100. It is executable by the runtime role only.
CREATE FUNCTION app_private.list_current_user_organizations()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT membership.org_id
  FROM public.memberships AS membership
  WHERE membership.user_id = app_private.current_user_id()
    AND membership.active
  ORDER BY membership.org_id
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION app_private.list_current_user_organizations() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.list_current_user_organizations() FROM running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.list_current_user_organizations() TO running_tracker_runtime;
