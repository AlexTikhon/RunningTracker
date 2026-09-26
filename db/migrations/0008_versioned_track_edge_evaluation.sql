CREATE FUNCTION app_private.current_track_algorithm_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT 'v1'::text
$$;

CREATE FUNCTION app_private.evaluate_track_edge(
  requested_algorithm_version text,
  predecessor_seq bigint,
  predecessor_segment_id integer,
  predecessor_recorded_at timestamp with time zone,
  predecessor_geom geometry,
  predecessor_accuracy_m double precision,
  successor_seq bigint,
  successor_segment_id integer,
  successor_recorded_at timestamp with time zone,
  successor_geom geometry,
  successor_accuracy_m double precision
)
RETURNS TABLE (
  accepted boolean,
  rejection_reason text,
  distance_m double precision,
  duration_s double precision
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  evaluated_distance_m double precision;
  evaluated_duration_s double precision;
BEGIN
  IF requested_algorithm_version <> 'v1' THEN
    RAISE EXCEPTION 'unsupported track algorithm version: %', requested_algorithm_version
      USING ERRCODE = '22023';
  END IF;

  evaluated_distance_m := public.ST_Distance(
    predecessor_geom::public.geography,
    successor_geom::public.geography
  );
  evaluated_duration_s := EXTRACT(
    EPOCH FROM successor_recorded_at - predecessor_recorded_at
  )::double precision;

  accepted := false;
  distance_m := evaluated_distance_m;
  duration_s := evaluated_duration_s;

  IF successor_seq <= predecessor_seq OR successor_seq - predecessor_seq <> 1 THEN
    rejection_reason := 'seq_gap';
  ELSIF successor_segment_id <> predecessor_segment_id THEN
    rejection_reason := 'segment_break';
  ELSIF predecessor_accuracy_m > 30.0 OR successor_accuracy_m > 30.0 THEN
    rejection_reason := 'poor_accuracy';
  ELSIF evaluated_duration_s <= 0.0 THEN
    rejection_reason := 'nonpositive_time_delta';
  ELSIF evaluated_duration_s > 10.0 THEN
    rejection_reason := 'excessive_time_gap';
  ELSIF evaluated_distance_m / evaluated_duration_s > 12.0 THEN
    rejection_reason := 'excessive_speed';
  ELSE
    accepted := true;
    rejection_reason := NULL;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION app_private.current_track_algorithm_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.evaluate_track_edge(
  text,
  bigint,
  integer,
  timestamp with time zone,
  geometry,
  double precision,
  bigint,
  integer,
  timestamp with time zone,
  geometry,
  double precision
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.current_track_algorithm_version()
  TO running_tracker_runtime, running_tracker_maintenance;
GRANT EXECUTE ON FUNCTION app_private.evaluate_track_edge(
  text,
  bigint,
  integer,
  timestamp with time zone,
  geometry,
  double precision,
  bigint,
  integer,
  timestamp with time zone,
  geometry,
  double precision
) TO running_tracker_runtime, running_tracker_maintenance;

COMMENT ON FUNCTION app_private.current_track_algorithm_version() IS
  'Current immutable track-processing version shared by summary and live-track queries.';

COMMENT ON FUNCTION app_private.evaluate_track_edge(
  text,
  bigint,
  integer,
  timestamp with time zone,
  geometry,
  double precision,
  bigint,
  integer,
  timestamp with time zone,
  geometry,
  double precision
) IS
  'Classifies one seq-adjacent track edge using versioned PostGIS geodesic rules. Rejection precedence: seq, segment, accuracy, nonpositive dt, time gap, speed.';
