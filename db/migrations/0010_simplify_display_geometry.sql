CREATE FUNCTION app_private.simplify_display_geometry(
  accepted_chains geometry,
  requested_algorithm_version text
)
RETURNS geometry(MultiLineString, 4326)
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  chain record;
  split_piece record;
  chain_length_m double precision;
  measured_chain public.geometry;
  part_count integer;
  part_index integer;
  start_distance_m double precision;
  end_distance_m double precision;
  source_part public.geometry;
  projected_part public.geometry;
  simplified_part public.geometry;
  unwrapped_part public.geometry;
  split_parts public.geometry;
  split_blades public.geometry;
  normalized_piece public.geometry;
  result_parts public.geometry;
  midpoint public.geometry;
  source_projection text := '+proj=longlat +datum=WGS84 +no_defs +over';
  local_projection text;
  minimum_x double precision;
  maximum_x double precision;
  center_world double precision;
  piece_world double precision;
BEGIN
  IF requested_algorithm_version <> app_private.current_track_algorithm_version() THEN
    RAISE EXCEPTION 'unsupported track algorithm version: %', requested_algorithm_version
      USING ERRCODE = '22023';
  END IF;

  IF public.ST_SRID(accepted_chains) <> 4326
    OR public.GeometryType(accepted_chains) <> 'MULTILINESTRING'
    OR public.ST_NDims(accepted_chains) <> 2
  THEN
    RAISE EXCEPTION 'accepted chains must be a 2D MultiLineString with SRID 4326'
      USING ERRCODE = '22023';
  END IF;

  IF public.ST_IsEmpty(accepted_chains) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.ST_DumpPoints(accepted_chains) AS point
    WHERE NOT (
      public.ST_X(point.geom) BETWEEN -180.0 AND 180.0
      AND public.ST_Y(point.geom) BETWEEN -90.0 AND 90.0
    )
  ) THEN
    RAISE EXCEPTION 'accepted chains contain invalid WGS84 coordinates'
      USING ERRCODE = '22023';
  END IF;

  FOR chain IN
    SELECT dumped.path, dumped.geom
    FROM public.ST_Dump(accepted_chains) AS dumped
    ORDER BY dumped.path
  LOOP
    WITH points AS (
      SELECT
        point.path[1] AS point_index,
        point.geom,
        public.ST_X(point.geom) AS longitude,
        public.ST_Y(point.geom) AS latitude,
        pg_catalog.lag(point.geom) OVER (
          ORDER BY point.path[1]
        ) AS previous_geom,
        pg_catalog.lag(public.ST_X(point.geom)) OVER (
          ORDER BY point.path[1]
        ) AS previous_longitude
      FROM public.ST_DumpPoints(chain.geom) AS point
    ),
    increments AS (
      SELECT
        point_index,
        longitude,
        latitude,
        CASE
          WHEN previous_geom IS NULL THEN 0.0
          ELSE public.ST_Distance(previous_geom::public.geography, geom::public.geography)
        END AS edge_length_m,
        CASE
          WHEN previous_longitude IS NULL THEN 0.0
          WHEN longitude - previous_longitude > 180.0 THEN -360.0
          WHEN longitude - previous_longitude < -180.0 THEN 360.0
          ELSE 0.0
        END AS longitude_offset
      FROM points
    ),
    measured_points AS (
      SELECT
        point_index,
        longitude + pg_catalog.sum(longitude_offset) OVER (
          ORDER BY point_index
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS unwrapped_longitude,
        latitude,
        pg_catalog.sum(edge_length_m) OVER (
          ORDER BY point_index
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_length_m
      FROM increments
    )
    SELECT
      public.ST_SetSRID(
        public.ST_MakeLine(
          public.ST_MakePointM(
            unwrapped_longitude,
            latitude,
            cumulative_length_m
          )
          ORDER BY point_index
        ),
        4326
      ),
      pg_catalog.max(cumulative_length_m)
    INTO measured_chain, chain_length_m
    FROM measured_points;

    part_count := greatest(1, pg_catalog.ceil(chain_length_m / 20000.0)::integer);

    FOR part_index IN 0..part_count - 1 LOOP
      IF chain_length_m = 0.0 THEN
        source_part := chain.geom;
      ELSE
        start_distance_m := part_index * 20000.0;
        end_distance_m := least((part_index + 1) * 20000.0, chain_length_m);
        source_part := public.ST_Force2D(
          public.ST_LineMerge(
            public.ST_CollectionExtract(
              public.ST_LocateBetween(
                measured_chain,
                start_distance_m,
                end_distance_m
              ),
              2
            )
          )
        );
      END IF;

      midpoint := public.ST_LineInterpolatePoint(source_part, 0.5);
      local_projection := pg_catalog.format(
        '+proj=aeqd +lat_0=%s +lon_0=%s +datum=WGS84 +units=m +no_defs',
        public.ST_Y(midpoint),
        public.ST_X(midpoint)
          - 360.0 * pg_catalog.floor((public.ST_X(midpoint) + 180.0) / 360.0)
      );

      projected_part := public.ST_Transform(
        public.ST_SetSRID(source_part, 0),
        source_projection,
        local_projection
      );
      simplified_part := public.ST_SetSRID(
        public.ST_Transform(
          public.ST_Simplify(projected_part, 5.0, true),
          local_projection,
          source_projection
        ),
        4326
      );

      WITH points AS (
        SELECT
          point.path[1] AS point_index,
          public.ST_X(point.geom) AS longitude,
          public.ST_Y(point.geom) AS latitude,
          pg_catalog.lag(public.ST_X(point.geom)) OVER (
            ORDER BY point.path[1]
          ) AS previous_longitude
        FROM public.ST_DumpPoints(simplified_part) AS point
      ),
      offsets AS (
        SELECT
          point_index,
          longitude,
          latitude,
          pg_catalog.sum(
            CASE
              WHEN previous_longitude IS NULL THEN 0.0
              WHEN longitude - previous_longitude > 180.0 THEN -360.0
              WHEN longitude - previous_longitude < -180.0 THEN 360.0
              ELSE 0.0
            END
          ) OVER (
            ORDER BY point_index
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS longitude_offset
        FROM points
      )
      SELECT public.ST_SetSRID(
        public.ST_MakeLine(
          public.ST_MakePoint(longitude + longitude_offset, latitude)
          ORDER BY point_index
        ),
        4326
      )
      INTO unwrapped_part
      FROM offsets;

      center_world := pg_catalog.floor(
        (public.ST_X(public.ST_LineInterpolatePoint(unwrapped_part, 0.5)) + 180.0) / 360.0
      );
      unwrapped_part := public.ST_Translate(unwrapped_part, -360.0 * center_world, 0.0);
      minimum_x := public.ST_XMin(public.Box3D(unwrapped_part));
      maximum_x := public.ST_XMax(public.Box3D(unwrapped_part));

      SELECT public.ST_SetSRID(
        public.ST_Collect(
          public.ST_MakeLine(
            public.ST_MakePoint(180.0 + 360.0 * boundary.world, -91.0),
            public.ST_MakePoint(180.0 + 360.0 * boundary.world, 91.0)
          )
          ORDER BY boundary.world
        ),
        4326
      )
      INTO split_blades
      FROM pg_catalog.generate_series(
        pg_catalog.ceil((minimum_x - 180.0) / 360.0)::bigint,
        pg_catalog.floor((maximum_x - 180.0) / 360.0)::bigint
      ) AS boundary(world)
      WHERE 180.0 + 360.0 * boundary.world > minimum_x
        AND 180.0 + 360.0 * boundary.world < maximum_x;

      split_parts := CASE
        WHEN split_blades IS NULL THEN unwrapped_part
        ELSE public.ST_Split(unwrapped_part, split_blades)
      END;

      FOR split_piece IN
        SELECT dumped.path, dumped.geom
        FROM public.ST_Dump(public.ST_CollectionExtract(split_parts, 2)) AS dumped
        WHERE NOT public.ST_IsEmpty(dumped.geom)
        ORDER BY dumped.path
      LOOP
        piece_world := pg_catalog.floor(
          (
            public.ST_X(public.ST_LineInterpolatePoint(split_piece.geom, 0.5))
            + 180.0
          ) / 360.0
        );
        normalized_piece := public.ST_SetSRID(
          public.ST_Translate(split_piece.geom, -360.0 * piece_world, 0.0),
          4326
        );
        IF public.ST_NPoints(normalized_piece) >= 2
          AND public.ST_Length(normalized_piece) > 0.0
        THEN
          result_parts := CASE
            WHEN result_parts IS NULL THEN normalized_piece
            ELSE public.ST_Collect(result_parts, normalized_piece)
          END;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF result_parts IS NULL OR public.ST_IsEmpty(result_parts) THEN
    RETURN NULL;
  END IF;

  RETURN public.ST_Multi(
    public.ST_CollectionExtract(result_parts, 2)
  )::public.geometry(MultiLineString, 4326);
END;
$$;

REVOKE ALL ON FUNCTION app_private.simplify_display_geometry(geometry, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.simplify_display_geometry(geometry, text)
  FROM running_tracker_runtime;
GRANT EXECUTE ON FUNCTION app_private.simplify_display_geometry(geometry, text)
  TO running_tracker_maintenance;

COMMENT ON FUNCTION app_private.simplify_display_geometry(geometry, text) IS
  'Builds display-only WGS84 MultiLineString geometry by <=20 km geography partitioning, local 5 m azimuthal-equidistant simplification, and antimeridian splitting.';
