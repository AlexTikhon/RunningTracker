DROP FUNCTION app_private.purge_run_raw_points_batch(uuid, uuid, integer);

CREATE FUNCTION app_private.claim_run_raw_purge_candidate(
  effective_now timestamptz,
  candidate_scan_limit integer
)
RETURNS TABLE (
  org_id uuid,
  run_id uuid
)
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
    RAISE EXCEPTION 'raw purge candidate time must be finite'
      USING ERRCODE = '22007';
  END IF;

  IF candidate_scan_limit < 1 OR candidate_scan_limit > 1000 THEN
    RAISE EXCEPTION 'raw purge candidate scan limit must be between 1 and 1000: %',
      candidate_scan_limit
      USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT run.org_id, run.id AS run_id
    FROM public.runs AS run
    LEFT JOIN public.run_summaries AS summary
      ON summary.org_id = run.org_id
     AND summary.run_id = run.id
    WHERE run.status = 'finished'
      AND (
        run.raw_state = 'purging'
        OR (
          run.raw_state = 'available'
          AND run.finished_at <= effective_now - interval '7 days'
          AND effective_now > run.finished_at + interval '24 hours'
          AND summary.source_revision = run.data_revision
          AND summary.algorithm_version = app_private.current_track_algorithm_version()
          AND app_private.run_summary_quality_stats_valid(summary.quality_stats)
        )
      )
    ORDER BY
      CASE run.raw_state WHEN 'purging' THEN 0 ELSE 1 END,
      run.finished_at,
      run.org_id,
      run.id
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
      LEFT JOIN public.run_summaries AS summary
        ON summary.org_id = run.org_id
       AND summary.run_id = run.id
      WHERE run.org_id = candidate.org_id
        AND run.id = candidate.run_id
        AND run.status = 'finished'
        AND (
          run.raw_state = 'purging'
          OR (
            run.raw_state = 'available'
            AND run.finished_at <= effective_now - interval '7 days'
            AND effective_now > run.finished_at + interval '24 hours'
            AND summary.source_revision = run.data_revision
            AND summary.algorithm_version = app_private.current_track_algorithm_version()
            AND app_private.run_summary_quality_stats_valid(summary.quality_stats)
          )
        )
    ) THEN
      org_id := candidate.org_id;
      run_id := candidate.run_id;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_run_raw_purge_candidate(timestamptz, integer)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_run_raw_purge_candidate(timestamptz, integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.claim_run_raw_purge_candidate(timestamptz, integer) IS
  'Claims one restart candidate or one seven-day, upload-closed run with a current valid summary under the shared per-run transaction advisory lock.';

CREATE FUNCTION app_private.has_overdue_raw_purge_summary_blocker(effective_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'raw purge backlog time must be finite'
      USING ERRCODE = '22007';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.runs AS run
    LEFT JOIN public.run_summaries AS summary
      ON summary.org_id = run.org_id
     AND summary.run_id = run.id
    WHERE run.status = 'finished'
      AND run.raw_state = 'available'
      AND run.finished_at <= effective_now - interval '7 days'
      AND effective_now > run.finished_at + interval '24 hours'
      AND (
        summary.run_id IS NULL
        OR summary.source_revision <> run.data_revision
        OR summary.algorithm_version <> app_private.current_track_algorithm_version()
        OR NOT app_private.run_summary_quality_stats_valid(summary.quality_stats)
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION app_private.has_overdue_raw_purge_summary_blocker(timestamptz)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.has_overdue_raw_purge_summary_blocker(timestamptz)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.has_overdue_raw_purge_summary_blocker(timestamptz) IS
  'Reports whether retention is overdue because an upload-closed available run lacks a current valid summary; exposes no run identity.';

CREATE FUNCTION app_private.purge_run_raw_points_batch(
  target_org_id uuid,
  target_run_id uuid,
  batch_limit integer,
  effective_now timestamptz
)
RETURNS TABLE (
  previous_raw_state text,
  current_raw_state text,
  deleted_count integer,
  completed boolean,
  has_more boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  remaining_points boolean;
  stored_data_revision bigint;
  stored_finished_at timestamptz;
  stored_raw_state text;
  stored_status text;
BEGIN
  IF target_org_id IS NULL
    OR target_run_id IS NULL
    OR batch_limit IS NULL
    OR effective_now IS NULL
  THEN
    RAISE EXCEPTION 'raw purge arguments must be non-null'
      USING ERRCODE = '22004';
  END IF;

  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'raw purge batch limit must be between 1 and 1000: %', batch_limit
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'raw purge time must be finite'
      USING ERRCODE = '22007';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'running-tracker:run-summary:' || target_org_id::text || ':' || target_run_id::text,
      0
    )
  );

  SELECT run.raw_state, run.status, run.finished_at, run.data_revision
  INTO stored_raw_state, stored_status, stored_finished_at, stored_data_revision
  FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'run not found for raw purge: %/%', target_org_id, target_run_id
      USING ERRCODE = 'P0002';
  END IF;

  IF stored_status <> 'finished' THEN
    RAISE EXCEPTION 'raw purge requires a finished run: %/%', target_org_id, target_run_id
      USING ERRCODE = '55000';
  END IF;

  previous_raw_state := stored_raw_state;

  IF stored_raw_state = 'purged' THEN
    current_raw_state := 'purged';
    deleted_count := 0;
    completed := true;
    has_more := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF stored_raw_state = 'available' THEN
    IF stored_finished_at > effective_now - interval '7 days'
      OR effective_now <= stored_finished_at + interval '24 hours'
      OR NOT EXISTS (
        SELECT 1
        FROM public.run_summaries AS summary
        WHERE summary.org_id = target_org_id
          AND summary.run_id = target_run_id
          AND summary.source_revision = stored_data_revision
          AND summary.algorithm_version = app_private.current_track_algorithm_version()
          AND app_private.run_summary_quality_stats_valid(summary.quality_stats)
      )
    THEN
      RAISE EXCEPTION 'run is not eligible for raw purge: %/%', target_org_id, target_run_id
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.runs AS run
    SET raw_state = 'purging'
    WHERE run.org_id = target_org_id
      AND run.id = target_run_id;
  ELSIF stored_raw_state <> 'purging' THEN
    RAISE EXCEPTION 'unsupported raw state for purge: %', stored_raw_state
      USING ERRCODE = '55000';
  END IF;

  WITH deletion_batch AS MATERIALIZED (
    SELECT point.org_id, point.run_id, point.seq
    FROM public.run_points AS point
    WHERE point.org_id = target_org_id
      AND point.run_id = target_run_id
    ORDER BY point.seq
    LIMIT batch_limit
    FOR UPDATE
  )
  DELETE FROM public.run_points AS point
  USING deletion_batch AS batch
  WHERE point.org_id = batch.org_id
    AND point.run_id = batch.run_id
    AND point.seq = batch.seq;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1
    FROM public.run_points AS point
    WHERE point.org_id = target_org_id
      AND point.run_id = target_run_id
  )
  INTO remaining_points;

  IF remaining_points THEN
    current_raw_state := 'purging';
    completed := false;
    has_more := true;
  ELSE
    UPDATE public.runs AS run
    SET raw_state = 'purged'
    WHERE run.org_id = target_org_id
      AND run.id = target_run_id;
    current_raw_state := 'purged';
    completed := true;
    has_more := false;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION app_private.purge_run_raw_points_batch(uuid, uuid, integer, timestamptz)
  FROM PUBLIC, running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.purge_run_raw_points_batch(uuid, uuid, integer, timestamptz)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.purge_run_raw_points_batch(uuid, uuid, integer, timestamptz) IS
  'Revalidates seven-day, upload-window, and current-summary eligibility before starting a bounded raw purge; committed purging runs resume without re-eligibility.';
