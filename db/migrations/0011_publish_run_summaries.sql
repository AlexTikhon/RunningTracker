CREATE FUNCTION app_private.run_summary_quality_stats_valid(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_typeof(candidate) = 'object'
    AND candidate ?& ARRAY[
      'rawPointCount',
      'acceptedPointCount',
      'acceptedEdgeCount',
      'poorAccuracyPointCount',
      'seqGapCount',
      'segmentBreakCount',
      'nonpositiveTimeDeltaCount',
      'excessiveTimeGapCount',
      'excessiveSpeedCount',
      'insufficientData'
    ]
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(candidate) AS present_key(key)
      WHERE present_key.key <> ALL (ARRAY[
        'rawPointCount',
        'acceptedPointCount',
        'acceptedEdgeCount',
        'poorAccuracyPointCount',
        'seqGapCount',
        'segmentBreakCount',
        'nonpositiveTimeDeltaCount',
        'excessiveTimeGapCount',
        'excessiveSpeedCount',
        'insufficientData'
      ])
    )
    AND pg_catalog.jsonb_typeof(candidate -> 'insufficientData') = 'boolean'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[
        'rawPointCount',
        'acceptedPointCount',
        'acceptedEdgeCount',
        'poorAccuracyPointCount',
        'seqGapCount',
        'segmentBreakCount',
        'nonpositiveTimeDeltaCount',
        'excessiveTimeGapCount',
        'excessiveSpeedCount'
      ]) AS required_count(key)
      WHERE CASE
        WHEN pg_catalog.jsonb_typeof(candidate -> required_count.key) <> 'number' THEN true
        ELSE (candidate ->> required_count.key)::numeric < 0
          OR pg_catalog.trunc((candidate ->> required_count.key)::numeric)
            <> (candidate ->> required_count.key)::numeric
          OR (candidate ->> required_count.key)::numeric > 9223372036854775807
      END
    )
$$;

REVOKE ALL ON FUNCTION app_private.run_summary_quality_stats_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.run_summary_quality_stats_valid(jsonb)
  FROM running_tracker_runtime, running_tracker_maintenance;

CREATE FUNCTION app_private.find_stale_run_summaries(candidate_limit integer)
RETURNS TABLE (
  org_id uuid,
  run_id uuid,
  source_revision bigint,
  algorithm_version text
)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF candidate_limit < 1 OR candidate_limit > 1000 THEN
    RAISE EXCEPTION 'summary candidate limit must be between 1 and 1000: %', candidate_limit
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    run.org_id,
    run.id,
    run.data_revision,
    app_private.current_track_algorithm_version()
  FROM public.runs AS run
  LEFT JOIN public.run_summaries AS summary
    ON summary.org_id = run.org_id
   AND summary.run_id = run.id
  WHERE run.status = 'finished'
    AND run.raw_state = 'available'
    AND (
      summary.run_id IS NULL
      OR summary.source_revision <> run.data_revision
      OR summary.algorithm_version <> app_private.current_track_algorithm_version()
      OR NOT app_private.run_summary_quality_stats_valid(summary.quality_stats)
    )
  ORDER BY run.finished_at, run.org_id, run.id
  LIMIT candidate_limit;
END;
$$;

CREATE FUNCTION app_private.publish_run_summary(
  target_org_id uuid,
  target_run_id uuid,
  target_source_revision bigint,
  requested_algorithm_version text,
  calculated_display_geom geometry,
  calculated_distance_m double precision,
  calculated_observed_duration_s double precision,
  calculated_quality_stats jsonb,
  calculated_at timestamp with time zone
)
RETURNS TABLE (
  published boolean,
  archive_revision bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  current_archive_revision bigint;
  current_data_revision bigint;
  current_raw_state text;
  current_status text;
  summary_is_current boolean;
BEGIN
  IF target_org_id IS NULL
    OR target_run_id IS NULL
    OR target_source_revision IS NULL
    OR requested_algorithm_version IS NULL
    OR calculated_distance_m IS NULL
    OR calculated_observed_duration_s IS NULL
    OR calculated_quality_stats IS NULL
    OR calculated_at IS NULL
  THEN
    RAISE EXCEPTION 'summary publication arguments must be non-null except display geometry'
      USING ERRCODE = '22004';
  END IF;

  IF target_source_revision < 0 THEN
    RAISE EXCEPTION 'source revision must be nonnegative: %', target_source_revision
      USING ERRCODE = '22023';
  END IF;

  IF requested_algorithm_version <> app_private.current_track_algorithm_version() THEN
    RAISE EXCEPTION 'unsupported track algorithm version: %', requested_algorithm_version
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_catalog.isfinite(calculated_at) THEN
    RAISE EXCEPTION 'summary computation time must be finite'
      USING ERRCODE = '22007';
  END IF;

  IF NOT app_private.run_summary_quality_stats_valid(calculated_quality_stats) THEN
    RAISE EXCEPTION 'summary quality statistics do not match the v1 contract'
      USING ERRCODE = '22023';
  END IF;

  SELECT organization.archive_revision
  INTO current_archive_revision
  FROM public.organizations AS organization
  WHERE organization.id = target_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::bigint;
    RETURN;
  END IF;

  SELECT run.data_revision, run.raw_state, run.status
  INTO current_data_revision, current_raw_state, current_status
  FROM public.runs AS run
  WHERE run.org_id = target_org_id
    AND run.id = target_run_id
  FOR UPDATE;

  IF NOT FOUND
    OR current_status <> 'finished'
    OR current_raw_state <> 'available'
    OR current_data_revision <> target_source_revision
    OR EXISTS (
      SELECT 1
      FROM public.run_tombstones AS tombstone
      WHERE tombstone.org_id = target_org_id
        AND tombstone.run_id = target_run_id
    )
  THEN
    RETURN QUERY SELECT false, current_archive_revision;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.run_summaries AS summary
    WHERE summary.org_id = target_org_id
      AND summary.run_id = target_run_id
      AND summary.source_revision = target_source_revision
      AND summary.algorithm_version = requested_algorithm_version
      AND app_private.run_summary_quality_stats_valid(summary.quality_stats)
  )
  INTO summary_is_current;

  IF summary_is_current THEN
    RETURN QUERY SELECT false, current_archive_revision;
    RETURN;
  END IF;

  INSERT INTO public.run_summaries (
    org_id,
    run_id,
    source_revision,
    algorithm_version,
    display_geom,
    distance_m,
    observed_duration_s,
    quality_stats,
    computed_at
  ) VALUES (
    target_org_id,
    target_run_id,
    target_source_revision,
    requested_algorithm_version,
    calculated_display_geom,
    calculated_distance_m,
    calculated_observed_duration_s,
    calculated_quality_stats,
    calculated_at
  )
  ON CONFLICT (org_id, run_id) DO UPDATE
  SET source_revision = EXCLUDED.source_revision,
      algorithm_version = EXCLUDED.algorithm_version,
      display_geom = EXCLUDED.display_geom,
      distance_m = EXCLUDED.distance_m,
      observed_duration_s = EXCLUDED.observed_duration_s,
      quality_stats = EXCLUDED.quality_stats,
      computed_at = EXCLUDED.computed_at;

  UPDATE public.organizations AS organization
  SET archive_revision = organization.archive_revision + 1
  WHERE organization.id = target_org_id
  RETURNING organization.archive_revision
  INTO current_archive_revision;

  RETURN QUERY SELECT true, current_archive_revision;
END;
$$;

REVOKE ALL ON FUNCTION app_private.find_stale_run_summaries(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.find_stale_run_summaries(integer)
  FROM running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.find_stale_run_summaries(integer)
  TO running_tracker_maintenance;

REVOKE ALL ON FUNCTION app_private.publish_run_summary(
  uuid,
  uuid,
  bigint,
  text,
  geometry,
  double precision,
  double precision,
  jsonb,
  timestamp with time zone
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.publish_run_summary(
  uuid,
  uuid,
  bigint,
  text,
  geometry,
  double precision,
  double precision,
  jsonb,
  timestamp with time zone
) FROM running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.publish_run_summary(
  uuid,
  uuid,
  bigint,
  text,
  geometry,
  double precision,
  double precision,
  jsonb,
  timestamp with time zone
) TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.find_stale_run_summaries(integer) IS
  'Finds finished, raw-available runs whose published summary is missing or stale without reserving work or taking mutation locks.';

COMMENT ON FUNCTION app_private.publish_run_summary(
  uuid,
  uuid,
  bigint,
  text,
  geometry,
  double precision,
  double precision,
  jsonb,
  timestamp with time zone
) IS
  'Locks organization then run, rejects stale/deleted/non-finished work, and atomically publishes one summary with the organization archive revision.';
