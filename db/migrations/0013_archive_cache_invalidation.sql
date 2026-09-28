CREATE FUNCTION app_private.lock_archive_revision_for_tile(target_org_id uuid)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_archive_revision bigint;
BEGIN
  IF target_org_id <> app_private.current_org_id() THEN
    RETURN NULL;
  END IF;

  SELECT organization.archive_revision
  INTO current_archive_revision
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id
  FOR SHARE;

  IF NOT FOUND OR NOT app_private.has_active_membership() THEN
    RETURN NULL;
  END IF;

  RETURN current_archive_revision;
END;
$$;

CREATE FUNCTION app_private.lock_archive_revision_for_acl_change(target_org_id uuid)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_archive_revision bigint;
BEGIN
  IF target_org_id <> app_private.current_org_id() THEN
    RETURN NULL;
  END IF;

  SELECT organization.archive_revision
  INTO current_archive_revision
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id
  FOR UPDATE;

  IF NOT FOUND OR NOT app_private.has_active_membership() THEN
    RETURN NULL;
  END IF;

  RETURN current_archive_revision;
END;
$$;

REVOKE ALL ON FUNCTION app_private.lock_archive_revision_for_tile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.lock_archive_revision_for_tile(uuid)
  FROM running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.lock_archive_revision_for_tile(uuid)
  TO running_tracker_runtime;

REVOKE ALL ON FUNCTION app_private.lock_archive_revision_for_acl_change(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.lock_archive_revision_for_acl_change(uuid)
  FROM running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.lock_archive_revision_for_acl_change(uuid)
  TO running_tracker_runtime;

CREATE FUNCTION app_private.advance_archive_revision_for_summary_delete()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.organizations AS organization
  SET archive_revision = organization.archive_revision + 1
  WHERE organization.id = OLD.org_id;
  RETURN OLD;
END;
$$;

CREATE FUNCTION app_private.advance_archive_revision_for_history_share()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_org_id uuid;
  target_run_id uuid;
BEGIN
  target_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  target_run_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;

  IF EXISTS (
    SELECT 1
    FROM public.run_summaries AS summary
    WHERE summary.org_id = target_org_id
      AND summary.run_id = target_run_id
  ) THEN
    UPDATE public.organizations AS organization
    SET archive_revision = organization.archive_revision + 1
    WHERE organization.id = target_org_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION app_private.advance_archive_revision_for_membership_change()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_org_id uuid;
BEGIN
  target_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  UPDATE public.organizations AS organization
  SET archive_revision = organization.archive_revision + 1
  WHERE organization.id = target_org_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION app_private.advance_archive_revision_for_summary_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.advance_archive_revision_for_summary_delete()
  FROM running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.advance_archive_revision_for_history_share() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.advance_archive_revision_for_history_share()
  FROM running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.advance_archive_revision_for_membership_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.advance_archive_revision_for_membership_change()
  FROM running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER run_summaries_advance_archive_revision_after_delete
AFTER DELETE ON public.run_summaries
FOR EACH ROW
EXECUTE FUNCTION app_private.advance_archive_revision_for_summary_delete();

CREATE TRIGGER run_shares_advance_archive_revision_after_insert
AFTER INSERT ON public.run_shares
FOR EACH ROW
WHEN (NEW.can_read_history)
EXECUTE FUNCTION app_private.advance_archive_revision_for_history_share();

CREATE TRIGGER run_shares_advance_archive_revision_after_update
AFTER UPDATE OF can_read_history ON public.run_shares
FOR EACH ROW
WHEN (OLD.can_read_history IS DISTINCT FROM NEW.can_read_history)
EXECUTE FUNCTION app_private.advance_archive_revision_for_history_share();

CREATE TRIGGER run_shares_advance_archive_revision_after_delete
AFTER DELETE ON public.run_shares
FOR EACH ROW
WHEN (OLD.can_read_history)
EXECUTE FUNCTION app_private.advance_archive_revision_for_history_share();

CREATE TRIGGER memberships_advance_archive_revision_after_active_change
AFTER UPDATE OF active ON public.memberships
FOR EACH ROW
WHEN (OLD.active IS DISTINCT FROM NEW.active)
EXECUTE FUNCTION app_private.advance_archive_revision_for_membership_change();

CREATE TRIGGER memberships_advance_archive_revision_after_delete
AFTER DELETE ON public.memberships
FOR EACH ROW
WHEN (OLD.active)
EXECUTE FUNCTION app_private.advance_archive_revision_for_membership_change();

COMMENT ON FUNCTION app_private.lock_archive_revision_for_tile(uuid) IS
  'Serializes an authorized tile cache lookup with archive epoch writers and returns the locked current revision.';

COMMENT ON FUNCTION app_private.lock_archive_revision_for_acl_change(uuid) IS
  'Takes the organization archive epoch write lock before a runtime history-share mutation.';

COMMENT ON FUNCTION app_private.advance_archive_revision_for_summary_delete() IS
  'Advances the organization archive epoch atomically when a published summary is deleted.';

COMMENT ON FUNCTION app_private.advance_archive_revision_for_history_share() IS
  'Advances the organization archive epoch when a history grant changes visible published archive data.';

COMMENT ON FUNCTION app_private.advance_archive_revision_for_membership_change() IS
  'Advances the organization archive epoch when active membership is revoked, restored, or deleted.';
