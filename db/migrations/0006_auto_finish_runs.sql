CREATE FUNCTION app_private.auto_finish_runs(effective_now timestamp with time zone)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  finished_count integer;
BEGIN
  IF NOT pg_catalog.isfinite(effective_now) THEN
    RAISE EXCEPTION 'effective auto-finish time must be finite'
      USING ERRCODE = '22007';
  END IF;

  WITH finished AS (
    UPDATE public.runs AS run
    SET status = 'finished',
        finished_at = effective_now,
        data_revision = run.data_revision + 1
    WHERE run.status IN ('recording', 'paused')
      AND run.created_at <= effective_now - INTERVAL '24 hours'
    RETURNING 1
  )
  SELECT count(*)::integer
  INTO finished_count
  FROM finished;

  RETURN finished_count;
END;
$$;

REVOKE ALL ON FUNCTION app_private.auto_finish_runs(timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.auto_finish_runs(timestamp with time zone)
  FROM running_tracker_runtime;
GRANT USAGE ON SCHEMA app_private TO running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.auto_finish_runs(timestamp with time zone)
  TO running_tracker_maintenance;
