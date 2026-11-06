import { z } from 'zod';
import type { ZodType } from 'zod';

import {
  activityListResponseSchema,
  activityViewSchema,
  createActivityRequestSchema,
} from './activities.js';
import {
  dailyMetricsListResponseSchema,
  dailyMetricsViewSchema,
  putDailyMetricsRequestSchema,
} from './daily-metrics.js';
import {
  apiErrorResponseSchema,
  archiveMetadataResponseSchema,
  archiveTrackResponseSchema,
  createRunRequestSchema,
  healthResponseSchema,
  ingestPointsRequestSchema,
  ingestPointsResponseSchema,
  nearbyResponseSchema,
  organizationCoachListResponseSchema,
  organizationListResponseSchema,
  pointsResponseSchema,
  runCommandRequestSchema,
  runCommandResponseSchema,
  runListResponseSchema,
  runSearchResponseSchema,
  runShareListResponseSchema,
  runShareResponseSchema,
  sessionCreateRequestSchema,
  sessionResponseSchema,
  upsertRunShareRequestSchema,
} from './http.js';
import {
  runSearchInterpretationRequestSchema,
  runSearchInterpretationResponseSchema,
} from './run-search-interpretation.js';
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
// Specified in SDD section 11 but never built; the answer today is 404 ROUTE_NOT_FOUND. A test in the
// API package keeps this flag and the mounted routes consistent in both directions.
const notImplemented =
  'NOT IMPLEMENTED. Specified in SDD section 11 but not mounted by the service; the request is answered 404 ROUTE_NOT_FOUND. Archive display uses /archive/metadata and the revision-bound /tiles instead; live positions come from the /live stream.';
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
    { name: 'Organizations' },
    { name: 'Runs' },
    { name: 'Activities' },
    { name: 'Daily metrics' },
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
    '/api/auth/login': {
      get: {
        tags: ['Session'],
        summary: 'Start OpenID Connect sign-in (browser navigation)',
        description:
          'Mounted only when OIDC is configured; otherwise 404. Meant to be followed by a browser, not called with fetch: it answers a redirect to the identity provider (authorization code, PKCE S256, state, nonce) and sets the short-lived HttpOnly login cookie scoped to /api/auth.',
        security: [],
        responses: {
          '302': {
            description: 'Redirect to the identity provider.',
            headers: {
              Location: { description: 'The provider authorization URL.', schema: { type: 'string', format: 'uri' } },
              'Set-Cookie': {
                description: 'running_tracker_login: HttpOnly, SameSite=Lax, Path=/api/auth, bounded lifetime.',
                schema: { type: 'string' },
              },
            },
          },
          '503': jsonResponse(
            'IDENTITY_PROVIDER_UNAVAILABLE, or LOGIN_TEMPORARILY_UNAVAILABLE when too many sign-ins are pending.',
            'ApiErrorResponse',
          ),
        },
      },
    },
    '/api/auth/callback': {
      get: {
        tags: ['Session'],
        summary: 'Complete OpenID Connect sign-in (provider redirect target)',
        description:
          'Mounted only when OIDC is configured; otherwise 404. The identity provider sends the browser here. The pending login is single use and its cookie is always cleared. Only an identity already provisioned as <issuer>|<subject> signs in; nobody is created.',
        security: [],
        responses: {
          '200': {
            description:
              'Signed in. The session cookie (HttpOnly, SameSite=Strict) is set and the page navigates to the application. A 200 page rather than a redirect, because a redirect chain started from the provider would not carry the Strict cookie.',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
          '302': {
            description:
              'Not signed in. Redirect to the application with sign_in_error set to exactly one of denied, login_expired, not_provisioned or unavailable.',
            headers: {
              Location: { description: 'The post-login path with ?sign_in_error=<code>.', schema: { type: 'string' } },
            },
          },
        },
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
    '/api/organizations': {
      get: {
        tags: ['Organizations'],
        summary: 'List the organizations the current identity belongs to',
        description:
          'The identity comes only from the session; there is no way to ask about another user. Returns the organizations in which the identity has an active membership, ordered by organization id, at most 100. A person with no active membership gets an empty list, not an error. Only identifiers are returned: this is discovery, and every request that follows is still checked against the membership inside its own transaction.',
        responses: {
          '200': jsonResponse('Organizations with an active membership.', 'OrganizationListResponse'),
          ...defaultErrors,
        },
      },
    },
    '/api/orgs/{orgId}/coaches': {
      get: {
        tags: ['Shares'],
        summary: 'List the active coaches of the organization',
        description:
          'For choosing whom to share a run with. The caller must have an active membership in the organization. Returns the user ids of the other active coaches in this organization, ordered by id, at most 100; runners, inactive members, other organizations and the caller are never listed. No query parameters are accepted.',
        parameters: [parameterRef('OrgId')],
        responses: {
          '200': jsonResponse('Active coaches of the organization.', 'OrganizationCoachListResponse'),
          ...defaultErrors,
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
    '/api/orgs/{orgId}/runs/search': {
      get: {
        tags: ['Runs'],
        summary: "Search the signed-in person's own finished runs",
        description:
          "Owner-only: the owner is the session's identity and is not a parameter, and a run that was only shared with the person is never returned (unlike the run list). Only finished runs with a current published summary are items; a finished run in the period whose summary is missing or was computed from an older data revision is counted in `pendingSummaryCount` instead, before any distance filter. The period is a preset or an inclusive range of local calendar dates in the given IANA time zone, converted by the server to a half-open UTC interval over `started_at` (a local day is not always 24 hours). `this-month` and `previous-month` are whole calendar months in that zone, relative to the server clock. Distance bounds are decimals in `distanceUnit` (kilometres, or international miles of 1609.344 m), at most three fraction digits, and are compared inclusively with the stored metres, not with a rounded display value. Pages use a keyset cursor that is bound to the person, organization and every filter; a cursor from another query is a 400 INVALID_CURSOR. This path is registered before `/runs/{runId}`.",
        parameters: [
          parameterRef('OrgId'),
          parameterRef('SearchTimeZone'),
          parameterRef('SearchPreset'),
          parameterRef('SearchFromDate'),
          parameterRef('SearchToDate'),
          parameterRef('SearchMinDistance'),
          parameterRef('SearchMaxDistance'),
          parameterRef('SearchDistanceUnit'),
          parameterRef('SearchSort'),
          parameterRef('Limit50'),
          parameterRef('Cursor'),
        ],
        responses: { '200': jsonResponse('One page of matching runs.', 'RunSearchResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/runs/search/interpretations': {
      post: {
        tags: ['Runs'],
        summary: 'Propose "My runs" search filters from a sentence (English or Russian)',
        description:
          "Optional and off by default. Sends the text, and nothing else about the person, to the configured language model provider once; the answer is a proposal for the filter form, never a search: the caller reviews it and then calls the search endpoint above. `search` is a complete replacement filter set already checked against the search contract (the time zone is the request's, not the model's; a preset is resolved by the server clock when the search runs; the sort is `newest` when the text names none). `clarify` and `unsupported` carry only a bounded reason code, and the caller owns the wording. A condition that the search cannot express exactly (a strict distance bound, a place, a pace) is never dropped or approximated. Nothing is stored. Failures: 503 INTERPRETATION_DISABLED when the feature is off, 429 INTERPRETATION_RATE_LIMITED or INTERPRETATION_IN_PROGRESS (Retry-After where known), 503 INTERPRETATION_BUSY or INTERPRETATION_BUDGET_EXHAUSTED, 504 INTERPRETATION_TIMEOUT, and 502 INTERPRETATION_FAILED with `details.reason` for a refusal, an incomplete or invalid answer or a provider error. A provider refusal is a failure here, not an `unsupported` answer. The membership is checked before the provider is contacted and again before the answer is returned; no database connection is held while the provider works. Every accepted request that reaches the provider is billable, so clients must not retry automatically.",
        parameters: [parameterRef('OrgId'), ...csrfParameters],
        requestBody: requestBody('RunSearchInterpretationRequest'),
        responses: {
          '200': jsonResponse('A proposal, a clarification or an unsupported reason.', 'RunSearchInterpretationResponse'),
          ...defaultErrors,
        },
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
    '/api/orgs/{orgId}/activities': {
      get: {
        tags: ['Activities'],
        summary: "List the signed-in person's own activities, newest first",
        description:
          "Owner-only health data (ADR-0072): the owner is the session's identity and is never a parameter; coaches and other members never see another person's activities, whatever run sharing grants they hold. Ordered by `startedAt` descending, then activity id descending. `limit` 1 to 50, default 20. The keyset cursor is bound to the person and organization; a tampered or foreign cursor is a 400 INVALID_CURSOR. Answers `Cache-Control: no-store`.",
        parameters: [parameterRef('OrgId'), parameterRef('Limit50'), parameterRef('Cursor')],
        responses: { '200': jsonResponse('One page of activities.', 'ActivityListResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/activities/{activityId}': {
      put: {
        tags: ['Activities'],
        summary: 'Create an idempotent client-identified manual activity',
        description:
          'The id is a client-generated UUID, and `idempotencyKey` is a client-generated UUID per form session, unique per owner in the organization (ADR-0073). 201 when created; 200 with the stored activity when the same id is sent again with an equal payload and key (omitted and null optional fields are equal); 409 ACTIVITY_CONFLICT when the id already holds a different payload or key. When the key already created an activity under another id: 200 with that activity if the details are equal (its `activityId` is then not the one in the path), otherwise 409 ACTIVITY_ALREADY_SAVED with `details.activityId` naming the saved activity; the details sent are not saved. An id that belongs to another member answers 404 ACTIVITY_NOT_FOUND, the same as runs. `startedAt` must not be before 2000-01-01T00:00:00Z or more than 24 hours after server time. Unknown fields are refused; the source is always `manual`.',
        parameters: [parameterRef('OrgId'), parameterRef('ActivityId'), ...csrfParameters],
        requestBody: requestBody('CreateActivityRequest'),
        responses: {
          '200': jsonResponse('Existing activity returned for an equivalent retry.', 'ActivityView'),
          '201': jsonResponse('Activity created.', 'ActivityView'),
          ...defaultErrors,
        },
      },
      get: {
        tags: ['Activities'],
        summary: "Read one of the signed-in person's activities",
        description: "Anyone else's activity, or an unknown id, is 404 ACTIVITY_NOT_FOUND. Answers `Cache-Control: no-store`.",
        parameters: [parameterRef('OrgId'), parameterRef('ActivityId')],
        responses: { '200': jsonResponse('The activity.', 'ActivityView'), ...defaultErrors },
      },
      delete: {
        tags: ['Activities'],
        summary: "Delete one of the signed-in person's activities",
        description:
          'A permanent hard delete without a tombstone. 204 in every case: deleted now, already deleted, never existed, or another member\'s (which is left untouched). The erasure is recorded in the erasure ledger in the same statement and exported off the database host, so a restored backup is cleaned by `restore:reapply-erasures` (ADR-0073). If the ledger cannot be written the deletion is not performed and the request fails (5xx); retrying is safe.',
        parameters: [parameterRef('OrgId'), parameterRef('ActivityId'), ...csrfParameters],
        responses: { '204': noContentResponse, ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/daily-metrics': {
      get: {
        tags: ['Daily metrics'],
        summary: "List the signed-in person's own daily check-ins in a date range",
        description:
          "Owner-only health data (ADR-0074): the owner is the session's identity and is never a parameter; coaches and other members never see another person's check-ins, whatever run sharing grants they hold. `from` and `to` are inclusive local dates (YYYY-MM-DD), not before 2000-01-01, `from` not after `to`, at most 92 days. Only days with a record are returned, ordered by `localDate` ascending. Answers `Cache-Control: no-store`.",
        parameters: [parameterRef('OrgId'), parameterRef('DailyMetricsFrom'), parameterRef('DailyMetricsTo')],
        responses: { '200': jsonResponse('The days with a record in the range.', 'DailyMetricsListResponse'), ...defaultErrors },
      },
    },
    '/api/orgs/{orgId}/daily-metrics/{localDate}': {
      put: {
        tags: ['Daily metrics'],
        summary: "Create or fully replace the signed-in person's check-in for one local date",
        description:
          'Naturally idempotent: the body is the whole day, so sending it again changes nothing (not even `updatedAt`). Omitted and null value fields are equal and clear the field; at least one value is required. 201 when the day is first written, 200 when it is replaced or unchanged. `timeZone` is the IANA zone the person is in now: `localDate` must not be before 2000-01-01 nor after today in that zone by server time (400 INVALID_REQUEST). The zone is stored with the day when it is first written and never rewritten, also not when a later replacement or the person uses another zone (ADR-0074). Unknown fields are refused.',
        parameters: [parameterRef('OrgId'), parameterRef('LocalDate'), ...csrfParameters],
        requestBody: requestBody('PutDailyMetricsRequest'),
        responses: {
          '200': jsonResponse('The day was replaced, or already held these values.', 'DailyMetricsView'),
          '201': jsonResponse('The day was written for the first time.', 'DailyMetricsView'),
          ...defaultErrors,
        },
      },
      get: {
        tags: ['Daily metrics'],
        summary: "Read the signed-in person's check-in for one local date",
        description: 'A day without a record is 404 DAILY_METRICS_NOT_FOUND; so is anyone else\'s. Answers `Cache-Control: no-store`.',
        parameters: [parameterRef('OrgId'), parameterRef('LocalDate')],
        responses: { '200': jsonResponse('The day.', 'DailyMetricsView'), ...defaultErrors },
      },
      delete: {
        tags: ['Daily metrics'],
        summary: "Delete the signed-in person's check-in for one local date",
        description:
          'A permanent hard delete. 204 in every case: deleted now, already deleted, never written, or a date in the future. The erasure is recorded in the erasure ledger in the same statement and exported off the database host, so a restored backup is cleaned by `restore:reapply-erasures` (ADR-0073). If the ledger cannot be written the deletion is not performed and the request fails (5xx); retrying is safe.',
        parameters: [parameterRef('OrgId'), parameterRef('LocalDate'), ...csrfParameters],
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
    '/api/orgs/{orgId}/runs/{runId}/shares': {
      get: {
        tags: ['Shares'],
        summary: 'List the shares of an owned run',
        description:
          'Owner only: anyone else, a grantee included, gets the same answer as for a missing run. Each item carries both permission flags as stored, ordered by grantee id, at most 100; `truncated` is true when more exist. No query parameters are accepted.',
        parameters: [...orgRunParameters],
        responses: {
          '200': jsonResponse('The run shares.', 'RunShareListResponse'),
          ...defaultErrors,
        },
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
        description: 'Finished runs only, under active membership and history authorization. One statement snapshot returns a GeoJSON Feature with run metadata and pending/stale/ready summary state. Only ready carries metrics and geometry; null geometry in ready is a valid empty track. Reads published summaries even after raw purge. Source revision equality determines readiness; algorithmVersion identifies the published algorithm. Private/no-store, at most 1 MiB UTF-8 JSON and 100,000 vertices; oversized tracks fail without truncation.',
        parameters: [...orgRunParameters, parameterRef('ArchiveMode')],
        responses: {
          '200': jsonResponse('GeoJSON Feature with explicit summary state.', 'ArchiveTrackResponse'),
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '410': errorResponse,
          '422': { ...errorResponse, description: 'ARCHIVE_TRACK_TOO_COMPLEX: response exceeds 1 MiB or 100,000 vertices.' },
          ...defaultErrors,
        },
      },
    },
    '/api/orgs/{orgId}/archive/runs': {
      get: {
        tags: ['Archive'],
        summary: 'List visible archive runs intersecting a WGS84 bbox',
        description: notImplemented,
        'x-implemented': false,
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
        description: notImplemented,
        'x-implemented': false,
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
      ActivityId: { name: 'activityId', in: 'path', required: true, schema: schemaRef('UUID') },
      LocalDate: {
        name: 'localDate',
        in: 'path',
        required: true,
        description: 'Local calendar date (YYYY-MM-DD), not before 2000-01-01.',
        schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      DailyMetricsFrom: {
        name: 'from',
        in: 'query',
        required: true,
        description: 'First local date of the range, inclusive (YYYY-MM-DD), not before 2000-01-01.',
        schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      DailyMetricsTo: {
        name: 'to',
        in: 'query',
        required: true,
        description: 'Last local date of the range, inclusive (YYYY-MM-DD). Not before `from`; at most 92 days from it.',
        schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      UserId: { name: 'userId', in: 'path', required: true, schema: schemaRef('UUID') },
      Origin: { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' } },
      CsrfToken: { name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' } },
      From: { name: 'from', in: 'query', required: true, schema: schemaRef('Timestamp') },
      To: { name: 'to', in: 'query', required: true, schema: schemaRef('Timestamp') },
      Cursor: { name: 'cursor', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 4096 } },
      Limit100: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      Limit50: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } },
      Limit1000: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } },
      SearchTimeZone: {
        name: 'timeZone',
        in: 'query',
        required: true,
        description: 'IANA time zone name, for example Europe/Warsaw. Offsets and abbreviations are refused.',
        schema: { type: 'string', minLength: 1, maxLength: 64 },
      },
      SearchPreset: {
        name: 'preset',
        in: 'query',
        required: false,
        description: 'Whole calendar month in `timeZone`. Give either `preset` or both `fromDate` and `toDate`.',
        schema: { type: 'string', enum: ['this-month', 'previous-month'] },
      },
      SearchFromDate: {
        name: 'fromDate',
        in: 'query',
        required: false,
        description: 'First local calendar date of the period, inclusive (YYYY-MM-DD).',
        schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      SearchToDate: {
        name: 'toDate',
        in: 'query',
        required: false,
        description: 'Last local calendar date of the period, inclusive (YYYY-MM-DD). At most 366 days from `fromDate`.',
        schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      SearchMinDistance: {
        name: 'minDistance',
        in: 'query',
        required: false,
        description: 'Inclusive lower bound in `distanceUnit`. Needs `distanceUnit`.',
        schema: { type: 'string', pattern: '^(?:0|[1-9]\\d{0,5})(?:\\.\\d{1,3})?$' },
      },
      SearchMaxDistance: {
        name: 'maxDistance',
        in: 'query',
        required: false,
        description: 'Inclusive upper bound in `distanceUnit`. Needs `distanceUnit`; not below `minDistance`.',
        schema: { type: 'string', pattern: '^(?:0|[1-9]\\d{0,5})(?:\\.\\d{1,3})?$' },
      },
      SearchDistanceUnit: {
        name: 'distanceUnit',
        in: 'query',
        required: false,
        description: 'Required with a distance bound and refused without one. `mi` is the international mile, 1609.344 m.',
        schema: { type: 'string', enum: ['km', 'mi'] },
      },
      SearchSort: {
        name: 'sort',
        in: 'query',
        required: false,
        description: 'Default `newest`. Ties on the sort key are ordered by newest start, then run id.',
        schema: { type: 'string', enum: ['newest', 'longest', 'shortest'] },
      },
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
      TileZ: { name: 'z', in: 'path', required: true, schema: { type: 'integer', minimum: 8, maximum: 16 } },
      TileX: { name: 'x', in: 'path', required: true, description: 'XYZ x coordinate; must be less than 2^z.', schema: { type: 'integer', minimum: 0 } },
      TileY: { name: 'y', in: 'path', required: true, description: 'XYZ y coordinate; must be less than 2^z.', schema: { type: 'integer', minimum: 0 } },
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
      OrganizationListResponse: jsonSchema(organizationListResponseSchema),
      OrganizationCoachListResponse: jsonSchema(organizationCoachListResponseSchema),
      RunShareListResponse: jsonSchema(runShareListResponseSchema),
      CreateRunRequest: jsonSchema(createRunRequestSchema),
      RunCommandRequest: jsonSchema(runCommandRequestSchema),
      RunCommandResponse: jsonSchema(runCommandResponseSchema),
      IngestPointsRequest: jsonSchema(ingestPointsRequestSchema),
      IngestPointsResponse: jsonSchema(ingestPointsResponseSchema),
      UpsertRunShareRequest: jsonSchema(upsertRunShareRequestSchema),
      RunShareResponse: jsonSchema(runShareResponseSchema),
      RunListResponse: jsonSchema(runListResponseSchema),
      CreateActivityRequest: jsonSchema(createActivityRequestSchema),
      ActivityView: jsonSchema(activityViewSchema),
      ActivityListResponse: jsonSchema(activityListResponseSchema),
      PutDailyMetricsRequest: jsonSchema(putDailyMetricsRequestSchema),
      DailyMetricsView: jsonSchema(dailyMetricsViewSchema),
      DailyMetricsListResponse: jsonSchema(dailyMetricsListResponseSchema),
      RunSearchResponse: jsonSchema(runSearchResponseSchema),
      RunSearchInterpretationRequest: jsonSchema(runSearchInterpretationRequestSchema),
      RunSearchInterpretationResponse: jsonSchema(runSearchInterpretationResponseSchema),
      PointsResponse: jsonSchema(pointsResponseSchema),
      ArchiveTrackResponse: jsonSchema(archiveTrackResponseSchema),
      NearbyResponse: jsonSchema(nearbyResponseSchema),
      ArchiveMetadataResponse: jsonSchema(archiveMetadataResponseSchema),
    },
  },
} as const;

export type OpenApiDocument = typeof openApiDocument;
