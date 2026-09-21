CREATE FUNCTION app_private.display_geom_coordinates_valid(candidate geometry)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    bool_and(
      public.ST_X(dumped.geom) BETWEEN -180.0 AND 180.0
      AND public.ST_Y(dumped.geom) BETWEEN -90.0 AND 90.0
    ),
    false
  )
  FROM public.ST_DumpPoints(candidate) AS dumped
$$;

REVOKE ALL ON FUNCTION app_private.display_geom_coordinates_valid(geometry) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.display_geom_coordinates_valid(geometry)
  FROM running_tracker_runtime, running_tracker_maintenance;

ALTER TABLE run_summaries
  DROP CONSTRAINT run_summaries_display_geom_coordinates_valid;

ALTER TABLE run_summaries
  ADD CONSTRAINT run_summaries_display_geom_coordinates_valid CHECK (
    display_geom IS NULL
    OR app_private.display_geom_coordinates_valid(display_geom)
  );
