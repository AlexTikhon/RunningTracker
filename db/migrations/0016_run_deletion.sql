-- P10.3: owner deletion and annual retention with an atomic tombstone and
-- archive revision change. See ADR-0035 for the full design, including the
-- deliberate interaction with the existing P09.4 summary-delete
-- archive-revision trigger (migration 0013).

-- Shared deletion primitive. Every caller must already hold, in order: the
-- per-run summary/purge transaction advisory lock, organizations FOR UPDATE,
-- and runs FOR UPDATE for this exact run, and must have already confirmed
-- authorization (owner match) or retention eligibility. It is intentionally
-- not SECURITY DEFINER and has no grants of its own: it always executes
-- under the calling SECURITY DEFINER function's owner context, the same
-- internal-helper pattern as app_private.run_summary_quality_stats_valid.
CREATE FUNCTION app_private.execute_run_deletion(
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
  INSERT INTO public.run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
  VALUES (
    target_org_id,
    target_run_id,
    deleting_owner_user_id,
    effective_now,
    effective_now + interval '1 year'
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.run_summaries AS summary
    WHERE summary.org_id = target_org_id
      AND summary.run_id = target_run_id
  ) INTO has_summary;

  -- Deleting the summary first lets its existing AFTER DELETE trigger
  -- (migration 0013, advance_archive_revision_for_summary_delete) perform
  -- the single required archive-revision increment for this run. run_shares
  -- is deleted next, explicitly, so that its own history-grant trigger
  -- (advance_archive_revision_for_history_share) observes that the summary
  -- row is already gone and therefore does not add a second increment. If
  -- both deletes were instead left to FK ON DELETE CASCADE from the run row,
  -- their relative firing order would be unspecified and could double-count.
  DELETE FROM public.run_summaries AS summary
  WHERE summary.org_id = target_org_id
    AND summary.run_id = target_run_id;

  DELETE FROM public.run_shares AS share
  WHERE share.org_id = target_org_id
    AND share.run_id = target_run_id;

  -- run_points and run_commands carry no archive-revision trigger, so the
  -- ordinary FK ON DELETE CASCADE from the run row is sufficient for them.
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
  'Shared trusted deletion primitive used by both owner and annual-retention deletion. Assumes the caller already holds the per-run advisory lock and locked organization/run rows and has confirmed authorization/eligibility. Inserts the tombstone, deletes run_summaries before run_shares so exactly one archive-revision increment occurs regardless of whether a summary existed, then deletes the run, cascading run_points/run_commands.';

CREATE FUNCTION app_private.delete_run_as_owner(
  target_org_id uuid,
  target_run_id uuid,
  requesting_user_id uuid,
  effective_now timestamptz
)
RETURNS TABLE (outcome text, archive_revision bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF target_org_id IS NULL
    OR target_run_id IS NULL
    OR requesting_user_id IS NULL
    OR effective_now IS NULL
  THEN
    RAISE EXCEPTION 'run deletion arguments must be non-null'
      USING ERRCODE = '22004';
  END IF;
  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'run deletion time must be finite'
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
    outcome := 'not_found';
    archive_revision := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id
    AND run.user_id = requesting_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Either the run never existed, belongs to a different owner, or was
    -- already deleted. Only this caller's own prior tombstone distinguishes
    -- an idempotent repeat delete; an unrelated caller must not learn that
    -- any tombstone exists for this run.
    IF EXISTS (
      SELECT 1
      FROM public.run_tombstones AS tombstone
      WHERE tombstone.org_id = target_org_id
        AND tombstone.run_id = target_run_id
        AND tombstone.owner_user_id = requesting_user_id
    ) THEN
      outcome := 'already_deleted';
    ELSE
      outcome := 'not_found';
    END IF;
    archive_revision := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  archive_revision := app_private.execute_run_deletion(
    target_org_id,
    target_run_id,
    requesting_user_id,
    effective_now
  );
  outcome := 'deleted';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION app_private.delete_run_as_owner(uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.delete_run_as_owner(uuid, uuid, uuid, timestamptz)
  TO running_tracker_runtime;

COMMENT ON FUNCTION app_private.delete_run_as_owner(uuid, uuid, uuid, timestamptz) IS
  'Runtime-only owner deletion. Locks organization then run under the shared per-run advisory lock; a repeated call from the same owner while its tombstone is retained is idempotent (already_deleted); a missing, non-owned, or differently-owned tombstoned run all return not_found without revealing which.';

CREATE FUNCTION app_private.claim_run_deletion_candidate(
  effective_now timestamptz,
  candidate_scan_limit integer
)
RETURNS TABLE (org_id uuid, run_id uuid)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate record;
BEGIN
  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'run deletion candidate time must be finite'
      USING ERRCODE = '22007';
  END IF;
  IF candidate_scan_limit < 1 OR candidate_scan_limit > 1000 THEN
    RAISE EXCEPTION 'run deletion candidate scan limit must be between 1 and 1000: %',
      candidate_scan_limit
      USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT run.org_id, run.id AS run_id
    FROM public.runs AS run
    WHERE run.status = 'finished'
      AND run.finished_at <= effective_now - interval '1 year'
    ORDER BY run.finished_at, run.org_id, run.id
    LIMIT candidate_scan_limit
  LOOP
    IF pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'running-tracker:run-summary:' || candidate.org_id::text || ':' || candidate.run_id::text,
        0
      )
    ) AND EXISTS (
      SELECT 1
      FROM public.runs AS run
      WHERE run.org_id = candidate.org_id
        AND run.id = candidate.run_id
        AND run.status = 'finished'
        AND run.finished_at <= effective_now - interval '1 year'
    ) THEN
      org_id := candidate.org_id;
      run_id := candidate.run_id;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_run_deletion_candidate(timestamptz, integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_run_deletion_candidate(timestamptz, integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.claim_run_deletion_candidate(timestamptz, integer) IS
  'Claims one finished run whose finished_at is at least one year old, oldest first, under the shared per-run transaction advisory lock. Selection is an optimization only; delete_run_for_retention independently revalidates eligibility after its own locks.';

CREATE FUNCTION app_private.delete_run_for_retention(
  target_org_id uuid,
  target_run_id uuid,
  effective_now timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  stored_finished_at timestamptz;
  stored_owner uuid;
  stored_status text;
BEGIN
  IF target_org_id IS NULL OR target_run_id IS NULL OR effective_now IS NULL THEN
    RAISE EXCEPTION 'run deletion arguments must be non-null'
      USING ERRCODE = '22004';
  END IF;
  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'run deletion time must be finite'
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
    RAISE EXCEPTION 'organization not found for retention deletion: %', target_org_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT run.user_id, run.status, run.finished_at
  INTO stored_owner, stored_status, stored_finished_at
  FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'run not found for retention deletion: %/%', target_org_id, target_run_id
      USING ERRCODE = 'P0002';
  END IF;

  IF stored_status <> 'finished' OR stored_finished_at > effective_now - interval '1 year' THEN
    RAISE EXCEPTION 'run is not eligible for annual retention deletion: %/%',
      target_org_id, target_run_id
      USING ERRCODE = '55000';
  END IF;

  RETURN app_private.execute_run_deletion(
    target_org_id,
    target_run_id,
    stored_owner,
    effective_now
  );
END;
$$;

REVOKE ALL ON FUNCTION app_private.delete_run_for_retention(uuid, uuid, timestamptz)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.delete_run_for_retention(uuid, uuid, timestamptz)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.delete_run_for_retention(uuid, uuid, timestamptz) IS
  'Maintenance-only annual retention deletion. Reacquires the shared per-run advisory lock and organization/run locks and independently revalidates finished status plus the one-year finished_at boundary before deleting; not found or ineligible after claiming indicates a logic error, not a routine outcome.';
