CREATE FUNCTION app_private.calculate_run_summary(
  target_org_id uuid,
  target_run_id uuid,
  target_source_revision bigint,
  requested_algorithm_version text
)
RETURNS TABLE (
  distance_m double precision,
  observed_duration_s double precision,
  quality_stats jsonb,
  accepted_chains geometry(MultiLineString, 4326)
)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF target_source_revision < 0 THEN
    RAISE EXCEPTION 'source revision must be nonnegative: %', target_source_revision
      USING ERRCODE = '22023';
  END IF;

  IF requested_algorithm_version <> app_private.current_track_algorithm_version() THEN
    RAISE EXCEPTION 'unsupported track algorithm version: %', requested_algorithm_version
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH ordered_points AS (
    SELECT
      point.seq AS successor_seq,
      point.segment_id AS successor_segment_id,
      point.recorded_at AS successor_recorded_at,
      point.geom AS successor_geom,
      point.accuracy_m AS successor_accuracy_m,
      lag(point.seq) OVER point_order AS predecessor_seq,
      lag(point.segment_id) OVER point_order AS predecessor_segment_id,
      lag(point.recorded_at) OVER point_order AS predecessor_recorded_at,
      lag(point.geom) OVER point_order AS predecessor_geom,
      lag(point.accuracy_m) OVER point_order AS predecessor_accuracy_m
    FROM public.run_points AS point
    WHERE point.org_id = target_org_id
      AND point.run_id = target_run_id
      AND point.ingested_revision <= target_source_revision
    WINDOW point_order AS (ORDER BY point.seq)
  ),
  evaluated_edges AS (
    SELECT
      point.predecessor_seq,
      point.predecessor_geom,
      point.successor_seq,
      point.successor_geom,
      evaluation.accepted,
      evaluation.rejection_reason,
      evaluation.distance_m,
      evaluation.duration_s
    FROM ordered_points AS point
    CROSS JOIN LATERAL app_private.evaluate_track_edge(
      requested_algorithm_version,
      point.predecessor_seq,
      point.predecessor_segment_id,
      point.predecessor_recorded_at,
      point.predecessor_geom,
      point.predecessor_accuracy_m,
      point.successor_seq,
      point.successor_segment_id,
      point.successor_recorded_at,
      point.successor_geom,
      point.successor_accuracy_m
    ) AS evaluation
    WHERE point.predecessor_seq IS NOT NULL
  ),
  grouped_edges AS (
    SELECT
      edge.*,
      count(*) FILTER (WHERE NOT edge.accepted) OVER (
        ORDER BY edge.successor_seq
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS chain_id
    FROM evaluated_edges AS edge
  ),
  accepted_edge_points AS (
    SELECT edge.chain_id, edge.predecessor_seq AS seq, edge.predecessor_geom AS geom
    FROM grouped_edges AS edge
    WHERE edge.accepted
    UNION ALL
    SELECT edge.chain_id, edge.successor_seq AS seq, edge.successor_geom AS geom
    FROM grouped_edges AS edge
    WHERE edge.accepted
  ),
  accepted_points AS (
    SELECT DISTINCT ON (point.chain_id, point.seq)
      point.chain_id,
      point.seq,
      point.geom
    FROM accepted_edge_points AS point
    ORDER BY point.chain_id, point.seq
  ),
  chain_lines AS (
    SELECT
      point.chain_id,
      public.ST_MakeLine(point.geom ORDER BY point.seq) AS geom
    FROM accepted_points AS point
    GROUP BY point.chain_id
  ),
  point_stats AS (
    SELECT
      count(*) AS raw_point_count,
      count(*) FILTER (WHERE point.successor_accuracy_m > 30.0) AS poor_accuracy_point_count
    FROM ordered_points AS point
  ),
  edge_stats AS (
    SELECT
      count(*) FILTER (WHERE edge.accepted) AS accepted_edge_count,
      count(*) FILTER (WHERE edge.rejection_reason = 'seq_gap') AS seq_gap_count,
      count(*) FILTER (WHERE edge.rejection_reason = 'segment_break') AS segment_break_count,
      count(*) FILTER (
        WHERE edge.rejection_reason = 'nonpositive_time_delta'
      ) AS nonpositive_time_delta_count,
      count(*) FILTER (
        WHERE edge.rejection_reason = 'excessive_time_gap'
      ) AS excessive_time_gap_count,
      count(*) FILTER (
        WHERE edge.rejection_reason = 'excessive_speed'
      ) AS excessive_speed_count,
      coalesce(sum(edge.distance_m) FILTER (WHERE edge.accepted), 0.0) AS distance_m,
      coalesce(sum(edge.duration_s) FILTER (WHERE edge.accepted), 0.0) AS observed_duration_s
    FROM grouped_edges AS edge
  ),
  accepted_point_stats AS (
    SELECT count(*) AS accepted_point_count
    FROM accepted_points
  ),
  chain_geometry AS (
    SELECT public.ST_Multi(
      public.ST_Collect(line.geom ORDER BY line.chain_id)
    )::public.geometry(MultiLineString, 4326) AS accepted_chains
    FROM chain_lines AS line
  )
  SELECT
    edge.distance_m::double precision,
    edge.observed_duration_s::double precision,
    pg_catalog.jsonb_build_object(
      'rawPointCount', point.raw_point_count,
      'acceptedPointCount', accepted_point.accepted_point_count,
      'acceptedEdgeCount', edge.accepted_edge_count,
      'poorAccuracyPointCount', point.poor_accuracy_point_count,
      'seqGapCount', edge.seq_gap_count,
      'segmentBreakCount', edge.segment_break_count,
      'nonpositiveTimeDeltaCount', edge.nonpositive_time_delta_count,
      'excessiveTimeGapCount', edge.excessive_time_gap_count,
      'excessiveSpeedCount', edge.excessive_speed_count,
      'insufficientData', edge.accepted_edge_count = 0
    ),
    chain.accepted_chains
  FROM point_stats AS point
  CROSS JOIN edge_stats AS edge
  CROSS JOIN accepted_point_stats AS accepted_point
  CROSS JOIN chain_geometry AS chain;
END;
$$;

REVOKE ALL ON FUNCTION app_private.calculate_run_summary(uuid, uuid, bigint, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.calculate_run_summary(uuid, uuid, bigint, text)
  FROM running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.calculate_run_summary(uuid, uuid, bigint, text)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.calculate_run_summary(uuid, uuid, bigint, text) IS
  'Calculates revision-bound metrics, quality counters, and unsimplified accepted MultiLineString chains without publishing a run summary.';
