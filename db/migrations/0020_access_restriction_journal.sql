-- P12.4: durable access-restriction journal (D09). See ADR-0045.
--
-- A restored backup is a snapshot of the past. Memberships and shares that were
-- deactivated, revoked or narrowed after the backup was taken are, in the
-- snapshot, still active, still granted and still wide. Deletions are covered by
-- run_deletion_journal (migration 0018); this is the same idea for access.
--
-- Only RESTRICTIONS are journaled and only restrictions are ever reapplied. A
-- grant is never reconstructed from an exported file, so a forged or stale file
-- can at worst remove access, never add it. A grant made after the backup is
-- lost with the node and has to be made again; that is the fail-closed side.
--
-- Triggers write the journal row in the same transaction as the change, so every
-- path is covered: the API's share revocation, an administrator's SQL, and the
-- cascade of a run deletion. Rows hold identifiers, two booleans and an instant
-- only: no coordinates, no run data, no session or provider data.
CREATE TABLE access_restriction_journal (
  journal_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL,
  user_id uuid NOT NULL,
  run_id uuid,
  can_read_history boolean,
  can_read_live boolean,
  changed_at timestamp(3) with time zone NOT NULL,
  CONSTRAINT access_restriction_journal_changed_at_finite CHECK (isfinite(changed_at)),
  CONSTRAINT access_restriction_journal_shape CHECK (
    (kind = 'membership_deactivated'
      AND run_id IS NULL AND can_read_history IS NULL AND can_read_live IS NULL)
    OR (kind = 'share_revoked'
      AND run_id IS NOT NULL AND can_read_history IS NULL AND can_read_live IS NULL)
    OR (kind = 'share_narrowed'
      AND run_id IS NOT NULL AND can_read_history IS NOT NULL AND can_read_live IS NOT NULL)
  )
);

COMMENT ON TABLE access_restriction_journal IS
  'Outbox of access restrictions (membership deactivated, share revoked or narrowed) awaiting durable export outside the database host. Written only by triggers on memberships and run_shares inside the changing transaction; drained only by the maintenance export capability after the export is durable. Identifiers, two booleans and an instant only. No foreign keys: a row must outlive the membership, share and run it describes.';

ALTER TABLE access_restriction_journal ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE access_restriction_journal FROM PUBLIC;
REVOKE ALL ON TABLE access_restriction_journal FROM running_tracker_runtime;
REVOKE ALL ON TABLE access_restriction_journal FROM running_tracker_maintenance;

-- 1. Triggers. SECURITY DEFINER so the journal is written for any caller, the
-- runtime role included, without that role ever holding a privilege on the table.
CREATE FUNCTION app_private.journal_membership_restriction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.access_restriction_journal (org_id, kind, user_id, changed_at)
  VALUES (OLD.org_id, 'membership_deactivated', OLD.user_id, pg_catalog.clock_timestamp());
  RETURN NULL;
END;
$$;

CREATE FUNCTION app_private.journal_share_restriction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR (OLD.org_id, OLD.run_id, OLD.grantee_user_id)
      IS DISTINCT FROM (NEW.org_id, NEW.run_id, NEW.grantee_user_id)
  THEN
    -- A changed key is a revocation of the old key (the new key is a grant and is not journaled).
    INSERT INTO public.access_restriction_journal (org_id, kind, user_id, run_id, changed_at)
    VALUES (OLD.org_id, 'share_revoked', OLD.grantee_user_id, OLD.run_id, pg_catalog.clock_timestamp());
  ELSE
    INSERT INTO public.access_restriction_journal (
      org_id, kind, user_id, run_id, can_read_history, can_read_live, changed_at
    )
    VALUES (
      NEW.org_id, 'share_narrowed', NEW.grantee_user_id, NEW.run_id,
      NEW.can_read_history, NEW.can_read_live, pg_catalog.clock_timestamp()
    );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_private.journal_membership_restriction()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;
REVOKE ALL ON FUNCTION app_private.journal_share_restriction()
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

CREATE TRIGGER memberships_journal_deactivation
AFTER UPDATE OF active ON memberships
FOR EACH ROW
WHEN (OLD.active AND NOT NEW.active)
EXECUTE FUNCTION app_private.journal_membership_restriction();

CREATE TRIGGER memberships_journal_removal
AFTER DELETE ON memberships
FOR EACH ROW
WHEN (OLD.active)
EXECUTE FUNCTION app_private.journal_membership_restriction();

CREATE TRIGGER run_shares_journal_revocation
AFTER DELETE ON run_shares
FOR EACH ROW
EXECUTE FUNCTION app_private.journal_share_restriction();

CREATE TRIGGER run_shares_journal_restriction
AFTER UPDATE ON run_shares
FOR EACH ROW
WHEN (
  (OLD.org_id, OLD.run_id, OLD.grantee_user_id)
    IS DISTINCT FROM (NEW.org_id, NEW.run_id, NEW.grantee_user_id)
  OR (OLD.can_read_history AND NOT NEW.can_read_history)
  OR (OLD.can_read_live AND NOT NEW.can_read_live)
)
EXECUTE FUNCTION app_private.journal_share_restriction();

-- 2. Maintenance export capability, identical in shape to the deletion journal's:
-- one transaction spans claim, the durable external write and acknowledgement, so a
-- row leaves the database only after its file is durable (at-least-once export).
CREATE FUNCTION app_private.claim_access_journal_batch(batch_limit integer)
RETURNS TABLE (
  journal_seq bigint,
  org_id uuid,
  kind text,
  user_id uuid,
  run_id uuid,
  can_read_history boolean,
  can_read_live boolean,
  changed_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'access journal batch limit must be between 1 and 1000: %', batch_limit
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT entry.journal_seq, entry.org_id, entry.kind, entry.user_id, entry.run_id,
         entry.can_read_history, entry.can_read_live, entry.changed_at
  FROM public.access_restriction_journal AS entry
  ORDER BY entry.journal_seq
  LIMIT batch_limit
  FOR UPDATE SKIP LOCKED;
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_access_journal_batch(integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_access_journal_batch(integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.claim_access_journal_batch(integer) IS
  'Maintenance-only. Returns and row-locks at most batch_limit (1..1000) access journal rows, oldest first, skipping rows locked by another transaction. The locks last until the caller''s transaction ends.';

CREATE FUNCTION app_private.ack_access_journal_batch(acknowledged_seqs bigint[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acknowledged_count integer;
BEGIN
  IF pg_catalog.cardinality(acknowledged_seqs) > 1000 THEN
    RAISE EXCEPTION 'access journal acknowledgement is limited to 1000 rows'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.access_restriction_journal AS entry
  WHERE entry.journal_seq = ANY (acknowledged_seqs);
  GET DIAGNOSTICS acknowledged_count = ROW_COUNT;

  RETURN acknowledged_count;
END;
$$;

REVOKE ALL ON FUNCTION app_private.ack_access_journal_batch(bigint[])
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.ack_access_journal_batch(bigint[])
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.ack_access_journal_batch(bigint[]) IS
  'Maintenance-only. Deletes the named access journal rows (at most 1000) and returns how many existed. Call only after the batch is durable outside the database host.';

-- 3. Restore-time reapplication. Granted to nobody: only the object owner (the
-- migration role) or a superuser can run it, against a restored database that is
-- not yet open to the application.
--
-- Outcomes:
--   applied                       the restored data was more permissive than the
--                                 journal entry and now is not
--   already_applied               nothing to remove: the restored data already
--                                 grants no more than the entry allows, or the
--                                 membership/share does not exist here
--   skipped_unknown_organization  the organization does not exist in this database
--
-- It only ever removes access: it deactivates, deletes a share, or ANDs a share's
-- two booleans with the journaled ones. It never inserts a share, never activates
-- a membership and never turns a boolean on. The existing archive-revision
-- triggers advance the organization's revision for every change it makes, and the
-- journal triggers record the change again on the new node.
CREATE FUNCTION app_private.reapply_access_restriction(
  restriction_kind text,
  target_org_id uuid,
  target_user_id uuid,
  target_run_id uuid,
  restricted_can_read_history boolean,
  restricted_can_read_live boolean
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  IF target_org_id IS NULL OR target_user_id IS NULL OR restriction_kind IS NULL THEN
    RAISE EXCEPTION 'access restriction arguments must be non-null'
      USING ERRCODE = '22004';
  END IF;

  IF NOT (
    (restriction_kind = 'membership_deactivated'
      AND target_run_id IS NULL
      AND restricted_can_read_history IS NULL AND restricted_can_read_live IS NULL)
    OR (restriction_kind = 'share_revoked'
      AND target_run_id IS NOT NULL
      AND restricted_can_read_history IS NULL AND restricted_can_read_live IS NULL)
    OR (restriction_kind = 'share_narrowed'
      AND target_run_id IS NOT NULL
      AND restricted_can_read_history IS NOT NULL AND restricted_can_read_live IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'invalid access restriction kind or shape'
      USING ERRCODE = '22023';
  END IF;

  IF target_run_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'running-tracker:run-summary:' || target_org_id::text || ':' || target_run_id::text,
        0
      )
    );
  END IF;

  PERFORM 1
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'skipped_unknown_organization';
  END IF;

  IF restriction_kind = 'membership_deactivated' THEN
    UPDATE public.memberships AS membership
    SET active = false
    WHERE membership.org_id = target_org_id
      AND membership.user_id = target_user_id
      AND membership.active;
  ELSIF restriction_kind = 'share_revoked' THEN
    DELETE FROM public.run_shares AS share
    WHERE share.org_id = target_org_id
      AND share.run_id = target_run_id
      AND share.grantee_user_id = target_user_id;
  ELSE
    UPDATE public.run_shares AS share
    SET can_read_history = share.can_read_history AND restricted_can_read_history,
        can_read_live = share.can_read_live AND restricted_can_read_live
    WHERE share.org_id = target_org_id
      AND share.run_id = target_run_id
      AND share.grantee_user_id = target_user_id
      AND ((share.can_read_history AND NOT restricted_can_read_history)
        OR (share.can_read_live AND NOT restricted_can_read_live));
  END IF;

  IF FOUND THEN
    RETURN 'applied';
  END IF;
  RETURN 'already_applied';
END;
$$;

REVOKE ALL ON FUNCTION app_private.reapply_access_restriction(text, uuid, uuid, uuid, boolean, boolean)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.reapply_access_restriction(text, uuid, uuid, uuid, boolean, boolean) IS
  'Owner-only restore-time reapplication of one exported access restriction. Only removes access (deactivate, delete a share, intersect a share''s booleans) and never grants. Idempotent: applying the same record twice yields applied then already_applied.';
