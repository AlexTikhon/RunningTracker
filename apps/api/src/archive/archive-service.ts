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

interface ArchiveRevisionRow {
  archive_revision: string;
}

export interface ArchiveTileRequest {
  path: TilePath;
  query: TileQuery;
}

export interface ArchiveTilePipeline {
  render(client: PoolClient, request: ArchiveTileRequest): Promise<Buffer>;
}

export const unavailableArchiveTilePipeline: ArchiveTilePipeline = {
  render: () =>
    Promise.reject(
      new ApiError(
        503,
        'TILE_BUSY',
        'Archive tile generation is temporarily unavailable',
      ),
    ),
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
  const archiveRevision = await readArchiveRevision(client, orgId);
  if (BigInt(archiveRevision) !== BigInt(requestedRevision)) {
    throw new ApiError(
      409,
      'ARCHIVE_REVISION_CHANGED',
      'The archive changed while the tile was being requested',
      { archiveRevision },
    );
  }
}
