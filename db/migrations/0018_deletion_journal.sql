-- P10.5: durable deletion journal (D09). See ADR-0037.
--
-- A tombstone protects one running database. It is reclaimed after a year and
-- it is lost together with the node. The journal is the record that leaves the
-- database: every deletion writes one row here in the SAME transaction as the
-- tombstone and the cascade delete, and maintenance exports these rows to
-- storage outside the database host before removing them. After a restore from
-- an older backup the exported records are reapplied so a deleted run is not
-- resurrected. Rows hold identifiers and timestamps only: no coordinates, no
-- payload, no session or provider data.
CREATE TABLE run_deletion_journal (
  journal_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  deleted_at timestamp(3) with time zone NOT NULL,
  CONSTRAINT run_deletion_journal_deleted_at_finite CHECK (isfinite(deleted_at))
);

COMMENT ON TABLE run_deletion_journal IS
  'Outbox of deletions awaiting durable export outside the database host. Written only by app_private.execute_run_deletion inside the deletion transaction; drained only by the maintenance export capability after the export is durable. Identifiers and timestamps only. No foreign keys: a journal row must outlive the run, the membership, and the tombstone it describes.';

ALTER TABLE run_deletion_journal ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE run_deletion_journal FROM PUBLIC;
REVOKE ALL ON TABLE run_deletion_journal FROM running_tracker_runtime;
REVOKE ALL ON TABLE run_deletion_journal FROM running_tracker_maintenance;

-- 1. Every deletion, owner-initiated or annual retention, journals atomically.
--
-- Same signature and body as migration 0017 plus one INSERT. Both public
-- deletion capabilities already funnel through this primitive, so a deletion
-- that commits always has its journal row and a deletion that rolls back never
-- leaves an orphan journal row.
CREATE OR REPLACE FUNCTION app_private.execute_run_deletion(
  target_org_id uuid,
  target_run_id uuid,
  deleting_owner_user_id uuid,
  effective_now timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  has_summary boolean;
  new_archive_revision bigint;
BEGIN
  INSERT INTO public.run_tombstones AS tombstone (
    org_id, run_id, owner_user_id, deleted_at, expires_at
  )
  VALUES (
    target_org_id,
    target_run_id,
    deleting_owner_user_id,
    effective_now,
    effective_now + interval '1 year'
  )
  ON CONFLICT (org_id, run_id) DO UPDATE
  SET owner_user_id = EXCLUDED.owner_user_id,
      deleted_at = EXCLUDED.deleted_at,
      expires_at = GREATEST(tombstone.expires_at, EXCLUDED.expires_at);

  INSERT INTO public.run_deletion_journal (org_id, run_id, owner_user_id, deleted_at)
  VALUES (target_org_id, target_run_id, deleting_owner_user_id, effective_now);

  SELECT EXISTS (
    SELECT 1
    FROM public.run_summaries AS summary
    WHERE summary.org_id = target_org_id
      AND summary.run_id = target_run_id
  ) INTO has_summary;

  -- See migration 0016: summary first so its trigger performs the single
  -- archive-revision increment, shares next, then the run and its cascade.
  DELETE FROM public.run_summaries AS summary
  WHERE summary.org_id = target_org_id
    AND summary.run_id = target_run_id;

  DELETE FROM public.run_shares AS share
  WHERE share.org_id = target_org_id
    AND share.run_id = target_run_id;

  DELETE FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id;

  IF NOT has_summary THEN
    UPDATE public.organizations AS organization
    SET archive_revision = organization.archive_revision + 1
    WHERE organization.id = target_org_id;
  END IF;

  SELECT organization.archive_revision
  INTO new_archive_revision
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id;

  RETURN new_archive_revision;
END;
$$;

REVOKE ALL ON FUNCTION app_private.execute_run_deletion(uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.execute_run_deletion(uuid, uuid, uuid, timestamptz) IS
  'Shared trusted deletion primitive used by owner deletion, annual retention, and journal reapplication. Assumes the caller already holds the per-run advisory lock and locked organization/run rows and has confirmed authorization/eligibility. Writes the tombstone (a newer deletion takes over an existing marker and never shortens its expiry) and one run_deletion_journal row in the same transaction, deletes run_summaries before run_shares so exactly one archive-revision increment occurs regardless of whether a summary existed, then deletes the run, cascading run_points/run_commands.';

-- 2. Maintenance export capability: claim a bounded batch, then acknowledge it.
--
-- The caller holds one transaction across claim, durable external write, and
-- acknowledge. FOR UPDATE SKIP LOCKED makes concurrent exporters take disjoint
-- rows, and a crash or rollback anywhere before COMMIT leaves every row in
-- place, so a row is only ever removed after its export was durable. The price
-- of that ordering is at-least-once export: a crash between the external write
-- and COMMIT re-exports the batch. Reapplication is idempotent, so duplicates
-- are harmless.
CREATE FUNCTION app_private.claim_deletion_journal_batch(batch_limit integer)
RETURNS TABLE (
  journal_seq bigint,
  org_id uuid,
  run_id uuid,
  owner_user_id uuid,
  deleted_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'deletion journal batch limit must be between 1 and 1000: %', batch_limit
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT entry.journal_seq, entry.org_id, entry.run_id, entry.owner_user_id, entry.deleted_at
  FROM public.run_deletion_journal AS entry
  ORDER BY entry.journal_seq
  LIMIT batch_limit
  FOR UPDATE SKIP LOCKED;
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_deletion_journal_batch(integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_deletion_journal_batch(integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.claim_deletion_journal_batch(integer) IS
  'Maintenance-only. Returns and row-locks at most batch_limit (1..1000) journal rows, oldest first, skipping rows locked by another transaction. The locks last until the caller''s transaction ends.';

CREATE FUNCTION app_private.ack_deletion_journal_batch(acknowledged_seqs bigint[])
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
    RAISE EXCEPTION 'deletion journal acknowledgement is limited to 1000 rows'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.run_deletion_journal AS entry
  WHERE entry.journal_seq = ANY (acknowledged_seqs);
  GET DIAGNOSTICS acknowledged_count = ROW_COUNT;

  RETURN acknowledged_count;
END;
$$;

REVOKE ALL ON FUNCTION app_private.ack_deletion_journal_batch(bigint[])
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.ack_deletion_journal_batch(bigint[])
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.ack_deletion_journal_batch(bigint[]) IS
  'Maintenance-only. Deletes the named journal rows (at most 1000) and returns how many existed. Call only after the batch is durable outside the database host.';

-- 3. Restore-time reapplication. Granted to nobody: only the object owner (the
-- migration role) or a superuser can run it, against a restored database that
-- is not yet open to the application.
--
-- The journal entry is authoritative about "this run was deleted at T". Outcomes:
--   deleted                      the run still exists in the restored data and
--                                 existed at T: full deletion, which also
--                                 journals the deletion again on the new node
--   skipped_newer_run            a run with this ID exists but was created after
--                                 T (ID reuse): it is a different run, left alone
--   marker_restored              the run is absent; its tombstone was missing
--   marker_present               the run is absent and a tombstone already exists
--   expired                      the run is absent and the one-year marker window
--                                 has passed; nothing to protect
--   skipped_unknown_organization the organization does not exist in this database
--   skipped_unknown_membership   the owner has no membership here, so no marker
--                                 can be stored and no such run can exist
CREATE FUNCTION app_private.reapply_journaled_deletion(
  target_org_id uuid,
  target_run_id uuid,
  journal_owner_user_id uuid,
  journal_deleted_at timestamptz,
  effective_now timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  stored_created_at timestamptz;
  stored_owner uuid;
  marker_expires_at timestamptz;
  journal_expires_at timestamptz;
BEGIN
  IF target_org_id IS NULL
    OR target_run_id IS NULL
    OR journal_owner_user_id IS NULL
    OR journal_deleted_at IS NULL
    OR effective_now IS NULL
  THEN
    RAISE EXCEPTION 'journal reapplication arguments must be non-null'
      USING ERRCODE = '22004';
  END IF;
  IF NOT pg_catalog.isfinite(journal_deleted_at) OR NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'journal reapplication times must be finite'
      USING ERRCODE = '22007';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'running-tracker:run-summary:' || target_org_id::text || ':' || target_run_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'skipped_unknown_organization';
  END IF;

  SELECT run.created_at, run.user_id
  INTO stored_created_at, stored_owner
  FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id
  FOR UPDATE;

  IF FOUND THEN
    IF stored_created_at <= journal_deleted_at THEN
      PERFORM app_private.execute_run_deletion(
        target_org_id,
        target_run_id,
        stored_owner,
        journal_deleted_at
      );
      RETURN 'deleted';
    END IF;
    RETURN 'skipped_newer_run';
  END IF;

  journal_expires_at := journal_deleted_at + interval '1 year';
  IF journal_expires_at <= effective_now THEN
    RETURN 'expired';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships AS membership
    WHERE membership.org_id = target_org_id
      AND membership.user_id = journal_owner_user_id
  ) THEN
    RETURN 'skipped_unknown_membership';
  END IF;

  SELECT tombstone.expires_at
  INTO marker_expires_at
  FROM public.run_tombstones AS tombstone
  WHERE tombstone.org_id = target_org_id
    AND tombstone.run_id = target_run_id
  FOR UPDATE;

  IF FOUND THEN
    IF marker_expires_at < journal_expires_at THEN
      UPDATE public.run_tombstones AS tombstone
      SET expires_at = journal_expires_at
      WHERE tombstone.org_id = target_org_id
        AND tombstone.run_id = target_run_id;
    END IF;
    RETURN 'marker_present';
  END IF;

  INSERT INTO public.run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
  VALUES (
    target_org_id,
    target_run_id,
    journal_owner_user_id,
    journal_deleted_at,
    journal_expires_at
  );
  RETURN 'marker_restored';
END;
$$;

REVOKE ALL ON FUNCTION app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz)
  FROM PUBLIC, running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz) IS
  'Owner-only restore-time reapplication of one exported deletion record. Idempotent: applying the same record twice yields deleted then marker_present (or marker_present twice). Never deletes a run created after the journaled deletion instant.';
