import {
  ARCHIVE_TILE_MAX_ZOOM,
  ARCHIVE_TILE_MIN_ZOOM,
  type ArchiveMetadataQuery,
  type ArchiveMetadataResponse,
  type TilePath,
  type TileQuery,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import { ApiError } from '../http/errors.js';

export const ARCHIVE_SOURCE_LAYER = 'runs';
export const ARCHIVE_TILE_SQL_TIMEOUT_MS = 2_000;

interface ArchiveRevisionRow {
  archive_revision: string;
}

interface LockedArchiveRevisionRow {
  archive_revision: string | null;
}

export interface ArchiveTileRequest {
  path: TilePath;
  query: TileQuery;
}

export interface ArchiveTilePipeline {
  render(client: PoolClient, request: ArchiveTileRequest): Promise<Buffer>;
}

interface PostgresErrorLike {
  code?: unknown;
  message?: unknown;
}

export function isPostgresStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as PostgresErrorLike;
  return (
    candidate.code === '57014' &&
    typeof candidate.message === 'string' &&
    candidate.message.includes('statement timeout')
  );
}

export async function setArchiveTileStatementTimeout(client: PoolClient): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = '${ARCHIVE_TILE_SQL_TIMEOUT_MS}ms'`);
}

interface ArchiveTileRow {
  tile: Buffer;
}

const ARCHIVE_TILE_EXTENT = 4096;
const ARCHIVE_TILE_BUFFER = 64;
const WEB_MERCATOR_HALF_WORLD_M = 20_037_508.342789244;
const WEB_MERCATOR_WORLD_WIDTH_M = WEB_MERCATOR_HALF_WORLD_M * 2;
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

// Each UNION branch keeps the GiST-compatible bounding-box predicate local to
// one WGS84 search envelope. Edge tiles add the opposite antimeridian copy and
// shift it only after projection because PROJ normalizes longitudes outside
// [-180, 180] during EPSG:4326 -> EPSG:3857 transformation.
export const renderArchiveTileSql = `
WITH tile AS (
  SELECT public.ST_TileEnvelope($2::integer, $3::integer, $4::integer) AS bounds_3857
),
selection AS (
  SELECT tile.bounds_3857,
         (public.ST_XMax(tile.bounds_3857) - public.ST_XMin(tile.bounds_3857))
           * ${ARCHIVE_TILE_BUFFER}.0 / ${ARCHIVE_TILE_EXTENT}.0 AS margin_m
  FROM tile
),
bounds AS (
  SELECT selection.bounds_3857,
         public.ST_Transform(
           public.ST_Intersection(
             public.ST_Expand(selection.bounds_3857, selection.margin_m),
             public.ST_MakeEnvelope(
               -${WEB_MERCATOR_HALF_WORLD_M},
               -${WEB_MERCATOR_HALF_WORLD_M},
               ${WEB_MERCATOR_HALF_WORLD_M},
               ${WEB_MERCATOR_HALF_WORLD_M},
               3857
             )
           ),
           4326
         ) AS search_4326,
         CASE WHEN $3::integer = 0 THEN
           public.ST_Transform(
             public.ST_MakeEnvelope(
               ${WEB_MERCATOR_HALF_WORLD_M} - selection.margin_m,
               public.ST_YMin(public.ST_Expand(selection.bounds_3857, selection.margin_m)),
               ${WEB_MERCATOR_HALF_WORLD_M},
               public.ST_YMax(public.ST_Expand(selection.bounds_3857, selection.margin_m)),
               3857
             ),
             4326
           )
         END AS wrapped_east_4326,
         CASE WHEN $3::integer = ((1::bigint << $2::integer) - 1)::integer THEN
           public.ST_Transform(
             public.ST_MakeEnvelope(
               -${WEB_MERCATOR_HALF_WORLD_M},
               public.ST_YMin(public.ST_Expand(selection.bounds_3857, selection.margin_m)),
               -${WEB_MERCATOR_HALF_WORLD_M} + selection.margin_m,
               public.ST_YMax(public.ST_Expand(selection.bounds_3857, selection.margin_m)),
               3857
             ),
             4326
           )
         END AS wrapped_west_4326,
         public.ST_MakeEnvelope(
           -180.0,
           -${WEB_MERCATOR_MAX_LATITUDE},
           180.0,
           ${WEB_MERCATOR_MAX_LATITUDE},
           4326
         ) AS mercator_world_4326
  FROM selection
),
candidates AS (
  SELECT summary.run_id::text AS run_id,
         summary.display_geom,
         0.0::double precision AS shift_x_m
  FROM public.run_summaries AS summary
  JOIN public.runs AS run
    ON run.org_id = summary.org_id AND run.id = summary.run_id
  CROSS JOIN bounds
  WHERE summary.org_id = $1::uuid
    AND summary.display_geom IS NOT NULL
    AND summary.display_geom && bounds.search_4326
    AND public.ST_Intersects(summary.display_geom, bounds.search_4326)
    AND run.status = 'finished'
    AND run.started_at >= $5::timestamptz
    AND run.started_at < $6::timestamptz

  UNION ALL

  SELECT summary.run_id::text,
         summary.display_geom,
         -${WEB_MERCATOR_WORLD_WIDTH_M}::double precision
  FROM public.run_summaries AS summary
  JOIN public.runs AS run
    ON run.org_id = summary.org_id AND run.id = summary.run_id
  CROSS JOIN bounds
  WHERE summary.org_id = $1::uuid
    AND bounds.wrapped_east_4326 IS NOT NULL
    AND summary.display_geom IS NOT NULL
    AND summary.display_geom && bounds.wrapped_east_4326
    AND public.ST_Intersects(summary.display_geom, bounds.wrapped_east_4326)
    AND run.status = 'finished'
    AND run.started_at >= $5::timestamptz
    AND run.started_at < $6::timestamptz

  UNION ALL

  SELECT summary.run_id::text,
         summary.display_geom,
         ${WEB_MERCATOR_WORLD_WIDTH_M}::double precision
  FROM public.run_summaries AS summary
  JOIN public.runs AS run
    ON run.org_id = summary.org_id AND run.id = summary.run_id
  CROSS JOIN bounds
  WHERE summary.org_id = $1::uuid
    AND bounds.wrapped_west_4326 IS NOT NULL
    AND summary.display_geom IS NOT NULL
    AND summary.display_geom && bounds.wrapped_west_4326
    AND public.ST_Intersects(summary.display_geom, bounds.wrapped_west_4326)
    AND run.status = 'finished'
    AND run.started_at >= $5::timestamptz
    AND run.started_at < $6::timestamptz
),
world_clipped AS (
  SELECT candidate.run_id,
         candidate.shift_x_m,
         public.ST_CollectionExtract(
           public.ST_ClipByBox2D(candidate.display_geom, bounds.mercator_world_4326),
           2
         ) AS geom_4326
  FROM candidates AS candidate
  CROSS JOIN bounds
),
projected AS (
  SELECT world_clipped.run_id,
         public.ST_Translate(
           public.ST_Transform(world_clipped.geom_4326, 3857),
           world_clipped.shift_x_m,
           0.0
         ) AS geom_3857
  FROM world_clipped
  WHERE NOT public.ST_IsEmpty(world_clipped.geom_4326)
),
merged AS (
  SELECT projected.run_id,
         public.ST_CollectionExtract(public.ST_Collect(projected.geom_3857), 2) AS geom_3857
  FROM projected
  GROUP BY projected.run_id
),
mvt_geometries AS (
  SELECT merged.run_id,
         public.ST_AsMVTGeom(
           merged.geom_3857,
           bounds.bounds_3857,
           ${ARCHIVE_TILE_EXTENT},
           ${ARCHIVE_TILE_BUFFER},
           true
         ) AS geom
  FROM merged
  CROSS JOIN bounds
),
mvt_rows AS (
  SELECT mvt_geometries.run_id, mvt_geometries.geom
  FROM mvt_geometries
  WHERE mvt_geometries.geom IS NOT NULL
    AND NOT public.ST_IsEmpty(mvt_geometries.geom)
    AND public.ST_Dimension(mvt_geometries.geom) = 1
)
SELECT COALESCE(
         public.ST_AsMVT(mvt_rows, '${ARCHIVE_SOURCE_LAYER}', ${ARCHIVE_TILE_EXTENT}, 'geom'),
         '\\x'::bytea
       ) AS tile
FROM mvt_rows
`;

export const postgisArchiveTilePipeline: ArchiveTilePipeline = {
  async render(client, { path, query }) {
    const result = await client.query<ArchiveTileRow>(renderArchiveTileSql, [
      path.orgId,
      path.z,
      path.x,
      path.y,
      query.from,
      query.to,
    ]);
    const tile = result.rows[0]?.tile;
    if (!Buffer.isBuffer(tile)) {
      throw new Error('PostGIS did not return an archive MVT payload');
    }
    return tile;
  },
};

async function readArchiveRevision(client: PoolClient, orgId: string): Promise<string> {
  const result = await client.query<ArchiveRevisionRow>(
    `SELECT organization.archive_revision::text AS archive_revision
     FROM organizations AS organization
     WHERE organization.id = $1`,
    [orgId],
  );
  const revision = result.rows[0]?.archive_revision;
  if (!revision || !/^\d+$/u.test(revision)) {
    throw new Error('The authorized organization archive revision is unavailable');
  }
  return revision;
}

async function readLockedArchiveRevision(
  client: PoolClient,
  orgId: string,
  capability: 'acl_change' | 'tile',
): Promise<string> {
  const functionName =
    capability === 'tile'
      ? 'lock_archive_revision_for_tile'
      : 'lock_archive_revision_for_acl_change';
  const result = await client.query<LockedArchiveRevisionRow>(
    `SELECT app_private.${functionName}($1)::text AS archive_revision`,
    [orgId],
  );
  const revision = result.rows[0]?.archive_revision;
  if (!revision || !/^\d+$/u.test(revision)) {
    throw new ApiError(
      403,
      'ORG_ACCESS_DENIED',
      'The current identity cannot access this organization',
    );
  }
  return revision;
}

export async function lockArchiveRevisionForAclChange(
  client: PoolClient,
  orgId: string,
): Promise<void> {
  await readLockedArchiveRevision(client, orgId, 'acl_change');
}

function tileTemplate(orgId: string, revision: string, query: ArchiveMetadataQuery): string {
  const search = new URLSearchParams({
    revision,
    from: query.from,
    to: query.to,
  });
  return `/api/orgs/${orgId}/tiles/runs/{z}/{x}/{y}.mvt?${search.toString()}`;
}

export async function readArchiveMetadata(
  client: PoolClient,
  orgId: string,
  query: ArchiveMetadataQuery,
): Promise<ArchiveMetadataResponse> {
  const archiveRevision = await readArchiveRevision(client, orgId);
  return {
    archiveRevision,
    filter: { from: query.from, to: query.to },
    maxzoom: ARCHIVE_TILE_MAX_ZOOM,
    minzoom: ARCHIVE_TILE_MIN_ZOOM,
    sourceLayer: ARCHIVE_SOURCE_LAYER,
    tiles: [tileTemplate(orgId, archiveRevision, query)],
  };
}

export async function assertCurrentArchiveRevision(
  client: PoolClient,
  orgId: string,
  requestedRevision: string,
): Promise<void> {
  const archiveRevision = await readLockedArchiveRevision(client, orgId, 'tile');
  if (BigInt(archiveRevision) !== BigInt(requestedRevision)) {
    throw new ApiError(
      409,
      'ARCHIVE_REVISION_CHANGED',
      'The archive changed while the tile was being requested',
      { archiveRevision },
    );
  }
}
