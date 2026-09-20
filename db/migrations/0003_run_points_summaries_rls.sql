CREATE TABLE run_points (
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  seq bigint NOT NULL,
  segment_id integer NOT NULL,
  recorded_at timestamp(3) with time zone NOT NULL,
  received_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  geom geometry(Point, 4326) NOT NULL,
  accuracy_m double precision NOT NULL,
  ingested_revision bigint NOT NULL,
  PRIMARY KEY (org_id, run_id, seq),
  CONSTRAINT run_points_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id) ON DELETE CASCADE,
  CONSTRAINT run_points_seq_positive CHECK (seq > 0),
  CONSTRAINT run_points_segment_id_nonnegative CHECK (segment_id >= 0),
  CONSTRAINT run_points_recorded_at_finite CHECK (isfinite(recorded_at)),
  CONSTRAINT run_points_received_at_finite CHECK (isfinite(received_at)),
  CONSTRAINT run_points_accuracy_finite_nonnegative CHECK (
    accuracy_m >= 0
    AND accuracy_m < 'Infinity'::double precision
  ),
  CONSTRAINT run_points_ingested_revision_nonnegative CHECK (ingested_revision >= 0),
  CONSTRAINT run_points_geom_not_empty CHECK (NOT ST_IsEmpty(geom)),
  CONSTRAINT run_points_longitude_in_range CHECK (ST_X(geom) BETWEEN -180.0 AND 180.0),
  CONSTRAINT run_points_latitude_in_range CHECK (ST_Y(geom) BETWEEN -90.0 AND 90.0)
);

CREATE INDEX run_points_revision_seq_idx
  ON run_points (org_id, run_id, ingested_revision, seq);

CREATE TABLE run_summaries (
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  source_revision bigint NOT NULL,
  algorithm_version text NOT NULL,
  display_geom geometry(MultiLineString, 4326),
  distance_m double precision NOT NULL,
  observed_duration_s double precision NOT NULL,
  quality_stats jsonb NOT NULL,
  computed_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (org_id, run_id),
  CONSTRAINT run_summaries_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id) ON DELETE CASCADE,
  CONSTRAINT run_summaries_source_revision_nonnegative CHECK (source_revision >= 0),
  CONSTRAINT run_summaries_algorithm_version_valid CHECK (
    btrim(algorithm_version) <> ''
    AND octet_length(algorithm_version) <= 128
  ),
  CONSTRAINT run_summaries_display_geom_not_empty CHECK (
    display_geom IS NULL OR NOT ST_IsEmpty(display_geom)
  ),
  CONSTRAINT run_summaries_display_geom_coordinates_valid CHECK (
    display_geom IS NULL
    OR (
      ST_XMin(Box3D(display_geom)) BETWEEN -180.0 AND 180.0
      AND ST_XMax(Box3D(display_geom)) BETWEEN -180.0 AND 180.0
      AND ST_YMin(Box3D(display_geom)) BETWEEN -90.0 AND 90.0
      AND ST_YMax(Box3D(display_geom)) BETWEEN -90.0 AND 90.0
    )
  ),
  CONSTRAINT run_summaries_distance_finite_nonnegative CHECK (
    distance_m >= 0
    AND distance_m < 'Infinity'::double precision
  ),
  CONSTRAINT run_summaries_duration_finite_nonnegative CHECK (
    observed_duration_s >= 0
    AND observed_duration_s < 'Infinity'::double precision
  ),
  CONSTRAINT run_summaries_quality_stats_object CHECK (jsonb_typeof(quality_stats) = 'object'),
  CONSTRAINT run_summaries_computed_at_finite CHECK (isfinite(computed_at))
);

CREATE INDEX run_summaries_display_geom_gist_idx
  ON run_summaries USING gist (display_geom);

COMMENT ON COLUMN run_summaries.quality_stats IS
  'Versioned by algorithm_version. Expected object keys: rawPointCount, acceptedPointCount, acceptedEdgeCount, poorAccuracyPointCount, seqGapCount, segmentBreakCount, nonpositiveTimeDeltaCount, excessiveTimeGapCount, excessiveSpeedCount (nonnegative integer counts), plus insufficientData (boolean). Exact production validation belongs to the summary publication transaction.';

COMMENT ON COLUMN run_points.geom IS
  'WGS84 point with longitude as X and latitude as Y.';

CREATE FUNCTION app_private.can_read_run_history(target_org_id uuid, target_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT app_private.has_active_membership()
    AND target_org_id = app_private.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.runs AS target_run
      WHERE target_run.org_id = target_org_id
        AND target_run.id = target_run_id
        AND (
          target_run.user_id = app_private.current_user_id()
          OR (
            target_run.status = 'finished'
            AND EXISTS (
              SELECT 1
              FROM public.run_shares AS share
              WHERE share.org_id = target_run.org_id
                AND share.run_id = target_run.id
                AND share.grantee_user_id = app_private.current_user_id()
                AND share.can_read_history
            )
          )
        )
    )
$$;

REVOKE ALL ON FUNCTION app_private.can_read_run_history(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_read_run_history(uuid, uuid)
  TO running_tracker_runtime;

DROP POLICY runs_select_authorized ON runs;

CREATE POLICY runs_select_authorized
ON runs
FOR SELECT
TO running_tracker_runtime
USING (
  (
    org_id = app_private.current_org_id()
    AND user_id = app_private.current_user_id()
    AND app_private.has_active_membership()
  )
  OR app_private.can_read_run(org_id, id)
);

ALTER TABLE run_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_points_select_authorized
ON run_points
FOR SELECT
TO running_tracker_runtime
USING (app_private.can_read_run(org_id, run_id));

CREATE POLICY run_points_insert_owner
ON run_points
FOR INSERT
TO running_tracker_runtime
WITH CHECK (app_private.is_run_owner(org_id, run_id));

CREATE POLICY run_summaries_select_authorized_history
ON run_summaries
FOR SELECT
TO running_tracker_runtime
USING (app_private.can_read_run_history(org_id, run_id));

REVOKE ALL ON TABLE run_points, run_summaries FROM PUBLIC;
REVOKE ALL ON TABLE run_points, run_summaries FROM running_tracker_runtime;
REVOKE ALL ON TABLE run_points, run_summaries FROM running_tracker_maintenance;
GRANT SELECT, INSERT ON TABLE run_points TO running_tracker_runtime;
GRANT SELECT ON TABLE run_summaries TO running_tracker_runtime;
