CREATE FUNCTION app_private.claim_stale_run_summary(candidate_scan_limit integer)
RETURNS TABLE (
  org_id uuid,
  run_id uuid,
  source_revision bigint,
  algorithm_version text
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
  IF candidate_scan_limit < 1 OR candidate_scan_limit > 1000 THEN
    RAISE EXCEPTION 'summary candidate scan limit must be between 1 and 1000: %',
      candidate_scan_limit
      USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT stale.org_id, stale.run_id, stale.source_revision, stale.algorithm_version
    FROM app_private.find_stale_run_summaries(candidate_scan_limit) AS stale
  LOOP
    IF pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'running-tracker:run-summary:' || candidate.org_id::text || ':' || candidate.run_id::text,
        0
      )
    ) THEN
      org_id := candidate.org_id;
      run_id := candidate.run_id;
      source_revision := candidate.source_revision;
      algorithm_version := candidate.algorithm_version;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app_private.claim_stale_run_summary(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_stale_run_summary(integer)
  FROM running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_stale_run_summary(integer)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.claim_stale_run_summary(integer) IS
  'Claims one stale summary candidate with a transaction-scoped advisory lock, skipping candidates claimed by other workers.';
