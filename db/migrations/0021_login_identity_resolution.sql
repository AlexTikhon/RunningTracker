-- Sign-in happens before any tenant context exists, and the `users` policy shows a row only to
-- its own identity, so the runtime role cannot look an identity up. This function is the one
-- narrow, read-only exception: it maps a provider identity that an operator has already
-- provisioned to its user id. It never creates a user, never returns anything but the id, and
-- is executable by the runtime role only.
CREATE FUNCTION app_private.resolve_login_user(provider_identity text)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT user_row.id
  FROM public.users AS user_row
  WHERE user_row.external_identity = provider_identity
$$;

REVOKE ALL ON FUNCTION app_private.resolve_login_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.resolve_login_user(text) FROM running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.resolve_login_user(text) TO running_tracker_runtime;
