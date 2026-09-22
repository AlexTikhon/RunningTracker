import { z } from 'zod';
import type { ZodType } from 'zod';

import {
  apiErrorResponseSchema,
  archiveMetadataResponseSchema,
  archiveTrackResponseSchema,
  createRunRequestSchema,
  healthResponseSchema,
  ingestPointsRequestSchema,
  ingestPointsResponseSchema,
  nearbyResponseSchema,
  pointsResponseSchema,
  runCommandRequestSchema,
  runCommandResponseSchema,
  runListResponseSchema,
  runShareResponseSchema,
  sessionCreateRequestSchema,
  sessionResponseSchema,
  upsertRunShareRequestSchema,
} from './http.js';
import {
  pointInputSchema,
  qualityStatsSchema,
  rawStateSchema,
  runStatusSchema,
  runSummarySchema,
  runViewSchema,
  trackPageSchema,
  trackPointSchema,
} from './models.js';
import { revisionSchema, seqSchema, timestampSchema, uuidSchema } from './primitives.js';

function jsonSchema(schema: ZodType): Record<string, unknown> {
  const generated: Record<string, unknown> = z.toJSONSchema(schema);
  delete generated.$schema;
  return generated;
}

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const parameterRef = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const jsonContent = (name: string) => ({
  'application/json': { schema: schemaRef(name) },
});
const requestBody = (name: string) => ({
  content: jsonContent(name),
  required: true,
});
const jsonResponse = (description: string, name: string) => ({
  content: jsonContent(name),
  description,
});
const errorResponse = { $ref: '#/components/responses/ApiError' };
const noContentResponse = { description: 'The operation completed successfully.' };
const defaultErrors = { default: errorResponse };
const orgRunParameters = [parameterRef('OrgId'), parameterRef('RunId')];
const csrfParameters = [parameterRef('Origin'), parameterRef('CsrfToken')];

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Running Tracker HTTP API',
    version: '1.0.0',
    description:
      'Ordinary HTTP transport contract from SDD section 11. The /live SSE protocol is specified separately in packages/contracts/sse.md.',
  },
  servers: [{ url: '/' }],
  security: [{ sessionCookie: [] }],
  tags: [
    { name: 'Session' },
    { name: 'Runs' },
    { name: 'Shares' },
    { name: 'Live reads' },
    { name: 'Archive' },
    { name: 'Health' },
  ],
  paths: {
    '/api/session': {
      post: {
        tags: ['Session'],
        summary: 'Create a development/test local session',
        security: [],
        parameters: [parameterRef('Origin')],
        requestBody: requestBody('SessionCreateRequest'),
        responses: {
          '201': jsonResponse('Session created. The opaque session is set in an HttpOnly cookie.', 'SessionResponse'),
          ...defaultErrors,
        },
      },
      get: {
        tags: ['Session'],
        summary: 'Read the current session',
        responses: { '200': jsonResponse('Current session.', 'SessionResponse'), ...defaultErrors },
      },
      delete: {
        tags: ['Session'],
        summary: 'Revoke the current session',
        parameters: csrfParameters,
        responses: { '204': noContentResponse, ...defaultErrors },
      },
    },
    '/api/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Process liveness',
        security: [],
        responses: { '200': jsonResponse('The API process is live.', 'HealthResponse') },
      },
    },
    '/api/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Database readiness',
        security: [],
        responses: {
          '200': jsonResponse('The API and database are ready.', 'HealthResponse'),
          '503': jsonResponse('The database is unavailable.', 'HealthResponse'),
        },
      },
    },
    '/api/orgs/{orgId}/runs': {
      get: {
        tags: ['Runs'],
        summary: 'List visible runs by started-at half-open interval',
        parameters: [
          parameterRef('OrgId'),
          parameterRef('From'),
          parameterRef('To'),
          parameterRef('Limit100'),
          parameterRef('Cursor'),
        ],
        responses: { '200': jsonResponse('Visible runs.', 'RunListResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}': {
      put: {
        tags: ['Runs'],
        summary: 'Create an idempotent client-identified run',
        parameters: [...orgRunParameters, ...csrfParameters],
        requestBody: requestBody('CreateRunRequest'),
        responses: {
          '200': jsonResponse('Existing run returned for an equivalent retry.', 'RunView'),
          '201': jsonResponse('Run created.', 'RunView'),
          ...defaultErrors,
        },
      },
      get: {
        tags: ['Runs'],
        summary: 'Read a visible run',
        parameters: orgRunParameters,
        responses: { '200': jsonResponse('Run details.', 'RunView'), ...defaultErrors },
      },
      delete: {
        tags: ['Runs'],
        summary: 'Delete an owned run',
        parameters: [...orgRunParameters, ...csrfParameters],
        responses: { '204': noContentResponse, ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}/commands': {
      post: {
        tags: ['Runs'],
        summary: 'Apply or replay an idempotent lifecycle command',
        parameters: [...orgRunParameters, ...csrfParameters],
        requestBody: requestBody('RunCommandRequest'),
        responses: {
          '200': jsonResponse('Stored command result.', 'RunCommandResponse'),
          ...defaultErrors,
        },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}/points': {
      post: {
        tags: ['Runs'],
        summary: 'Atomically ingest a point batch',
        parameters: [...orgRunParameters, ...csrfParameters],
        requestBody: requestBody('IngestPointsRequest'),
        responses: {
          '200': jsonResponse('Point batch result.', 'IngestPointsResponse'),
          ...defaultErrors,
        },
      },
      get: {
        tags: ['Runs'],
        summary: 'Read raw point history',
        parameters: [...orgRunParameters, parameterRef('Limit1000'), parameterRef('Cursor')],
        responses: { '200': jsonResponse('Raw point page.', 'PointsResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}/shares/{userId}': {
      put: {
        tags: ['Shares'],
        summary: 'Create or replace an owned run share',
        parameters: [
          ...orgRunParameters,
          parameterRef('UserId'),
          ...csrfParameters,
        ],
        requestBody: requestBody('UpsertRunShareRequest'),
        responses: {
          '200': jsonResponse('Persisted share permissions.', 'RunShareResponse'),
          ...defaultErrors,
        },
      },
      delete: {
        tags: ['Shares'],
        summary: 'Revoke an owned run share',
        parameters: [
          ...orgRunParameters,
          parameterRef('UserId'),
          ...csrfParameters,
        ],
        responses: { '204': noContentResponse, ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}/live-track': {
      get: {
        tags: ['Live reads'],
        summary: 'Read a stable initial live-track page',
        parameters: [...orgRunParameters, parameterRef('Limit1000'), parameterRef('Cursor')],
        responses: { '200': jsonResponse('Track snapshot page.', 'TrackPage'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}/live-track/changes': {
      get: {
        tags: ['Live reads'],
        summary: 'Read a stable live-track change page',
        description: 'Exactly one of afterRevision or cursor is required.',
        parameters: [
          ...orgRunParameters,
          parameterRef('AfterRevision'),
          parameterRef('Limit1000'),
          parameterRef('Cursor'),
        ],
        responses: { '200': jsonResponse('Track change page.', 'TrackPage'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/{runId}/track': {
      get: {
        tags: ['Archive'],
        summary: 'Read published archive geometry',
        parameters: [...orgRunParameters, parameterRef('ArchiveMode')],
        responses: {
          '200': jsonResponse('GeoJSON Feature with published geometry metadata.', 'ArchiveTrackResponse'),
          ...defaultErrors,
        },
      },
    },
    '/api/orgs/{orgId}/archive/runs': {
      get: {
        tags: ['Archive'],
        summary: 'List visible archive runs intersecting a WGS84 bbox',
        parameters: [
          parameterRef('OrgId'),
          parameterRef('Bbox'),
          parameterRef('From'),
          parameterRef('To'),
          parameterRef('Limit100'),
          parameterRef('Cursor'),
        ],
        responses: { '200': jsonResponse('Visible archive runs.', 'RunListResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/live/nearby': {
      get: {
        tags: ['Live reads'],
        summary: 'Read confirmed fresh nearby run positions',
        parameters: [
          parameterRef('OrgId'),
          parameterRef('Longitude'),
          parameterRef('Latitude'),
          parameterRef('RadiusM'),
        ],
        responses: { '200': jsonResponse('Nearby live runs.', 'NearbyResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/archive/metadata': {
      get: {
        tags: ['Archive'],
        summary: 'Read revisioned archive tile metadata',
        parameters: [parameterRef('OrgId'), parameterRef('From'), parameterRef('To')],
        responses: {
          '200': jsonResponse('Archive tile metadata.', 'ArchiveMetadataResponse'),
          ...defaultErrors,
        },
      },
    },
    '/api/orgs/{orgId}/tiles/runs/{z}/{x}/{y}.mvt': {
      get: {
        tags: ['Archive'],
        summary: 'Read a revision-bound Mapbox Vector Tile',
        parameters: [
          parameterRef('OrgId'),
          parameterRef('TileZ'),
          parameterRef('TileX'),
          parameterRef('TileY'),
          parameterRef('Revision'),
          parameterRef('From'),
          parameterRef('To'),
        ],
        responses: {
          '200': {
            description: 'A Mapbox Vector Tile; an empty result is a valid empty MVT.',
            content: {
              'application/vnd.mapbox-vector-tile': {
                schema: { type: 'string', contentEncoding: 'binary' },
              },
            },
          },
          ...defaultErrors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'running_tracker_session' },
    },
    responses: {
      ApiError: jsonResponse('Application error envelope.', 'ApiErrorResponse'),
    },
    parameters: {
      OrgId: { name: 'orgId', in: 'path', required: true, schema: schemaRef('UUID') },
      RunId: { name: 'runId', in: 'path', required: true, schema: schemaRef('UUID') },
      UserId: { name: 'userId', in: 'path', required: true, schema: schemaRef('UUID') },
      Origin: { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' } },
      CsrfToken: { name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' } },
      From: { name: 'from', in: 'query', required: true, schema: schemaRef('Timestamp') },
      To: { name: 'to', in: 'query', required: true, schema: schemaRef('Timestamp') },
      Cursor: { name: 'cursor', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 4096 } },
      Limit100: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      Limit1000: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } },
      AfterRevision: { name: 'afterRevision', in: 'query', required: false, schema: schemaRef('Revision') },
      ArchiveMode: { name: 'mode', in: 'query', required: true, schema: { type: 'string', const: 'archive' } },
      Bbox: {
        name: 'bbox',
        in: 'query',
        required: true,
        description: 'west,south,east,north in WGS84; west > east crosses the antimeridian.',
        schema: { type: 'string' },
      },
      Longitude: { name: 'longitude', in: 'query', required: true, schema: { type: 'number', minimum: -180, maximum: 180 } },
      Latitude: { name: 'latitude', in: 'query', required: true, schema: { type: 'number', minimum: -90, maximum: 90 } },
      RadiusM: { name: 'radiusM', in: 'query', required: true, schema: { type: 'number', minimum: 0, maximum: 5000 } },
      Revision: { name: 'revision', in: 'query', required: true, schema: schemaRef('Revision') },
      TileZ: { name: 'z', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } },
      TileX: { name: 'x', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } },
      TileY: { name: 'y', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } },
    },
    schemas: {
      UUID: jsonSchema(uuidSchema),
      Revision: jsonSchema(revisionSchema),
      Seq: jsonSchema(seqSchema),
      Timestamp: jsonSchema(timestampSchema),
      RunStatus: jsonSchema(runStatusSchema),
      RawState: jsonSchema(rawStateSchema),
      QualityStats: jsonSchema(qualityStatsSchema),
      RunSummary: jsonSchema(runSummarySchema),
      RunView: jsonSchema(runViewSchema),
      PointInput: jsonSchema(pointInputSchema),
      TrackPoint: jsonSchema(trackPointSchema),
      TrackPage: jsonSchema(trackPageSchema),
      SessionCreateRequest: jsonSchema(sessionCreateRequestSchema),
      SessionResponse: jsonSchema(sessionResponseSchema),
      ApiErrorResponse: jsonSchema(apiErrorResponseSchema),
      HealthResponse: jsonSchema(healthResponseSchema),
      CreateRunRequest: jsonSchema(createRunRequestSchema),
      RunCommandRequest: jsonSchema(runCommandRequestSchema),
      RunCommandResponse: jsonSchema(runCommandResponseSchema),
      IngestPointsRequest: jsonSchema(ingestPointsRequestSchema),
      IngestPointsResponse: jsonSchema(ingestPointsResponseSchema),
      UpsertRunShareRequest: jsonSchema(upsertRunShareRequestSchema),
      RunShareResponse: jsonSchema(runShareResponseSchema),
      RunListResponse: jsonSchema(runListResponseSchema),
      PointsResponse: jsonSchema(pointsResponseSchema),
      ArchiveTrackResponse: jsonSchema(archiveTrackResponseSchema),
      NearbyResponse: jsonSchema(nearbyResponseSchema),
      ArchiveMetadataResponse: jsonSchema(archiveMetadataResponseSchema),
    },
  },
} as const;

export type OpenApiDocument = typeof openApiDocument;
