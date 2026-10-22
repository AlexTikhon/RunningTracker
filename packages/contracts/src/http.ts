import { z } from 'zod';

import { pointInputSchema, runStatusSchema, runViewSchema, trackPageSchema } from './models.js';
import {
  coordinatesSchema,
  cursorSchema,
  ianaTimeZoneSchema,
  latitudeSchema,
  localDateSchema,
  longitudeSchema,
  nonnegativeFiniteSchema,
  nonnegativeIntegerSchema,
  parseLocalDate,
  revisionSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const POINT_BATCH_MAX_SIZE = 100;
export const ARCHIVE_PERIOD_MAX_DAYS = 366;
export const ARCHIVE_TILE_MIN_ZOOM = 8;
export const ARCHIVE_TILE_MAX_ZOOM = 16;
const queryLimit = (maximum: number) =>
  z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.int().min(1).max(maximum));

function validateOrderedRange(
  value: { from: string; to: string },
  context: z.RefinementCtx,
  maximumDays?: number,
): void {
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (from >= to) {
    context.addIssue({ code: 'custom', message: '`from` must be earlier than `to`' });
    return;
  }
  if (maximumDays !== undefined && to - from > maximumDays * 86_400_000) {
    context.addIssue({
      code: 'custom',
      message: `The requested period must not exceed ${maximumDays} days`,
    });
  }
}

export const sessionCreateRequestSchema = z.strictObject({ userId: uuidSchema });
export const sessionResponseSchema = z.strictObject({
  csrf: z.strictObject({
    headerName: z.literal('x-csrf-token'),
    token: opaqueTokenSchema,
  }),
  expiresAt: timestampSchema,
  identity: z.strictObject({ userId: uuidSchema }),
});

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    message: z.string().min(1),
    requestId: uuidSchema,
  }),
});

export const healthResponseSchema = z.strictObject({
  checks: z.strictObject({ database: z.enum(['up', 'down']) }).optional(),
  status: z.enum(['ok', 'not-ready']),
});

// The organizations the signed-in identity belongs to through an active membership. Only the identifier is
// exposed: the organizations table holds nothing else, and a name would have to be invented for the screen.
export const ORGANIZATION_LIST_MAX = 100;
export const organizationListResponseSchema = z.strictObject({
  items: z.array(z.strictObject({ organizationId: uuidSchema })).max(ORGANIZATION_LIST_MAX),
});

export const organizationPathSchema = z.strictObject({ orgId: uuidSchema });
export const runPathSchema = z.strictObject({ orgId: uuidSchema, runId: uuidSchema });
export const runSharePathSchema = z.strictObject({
  orgId: uuidSchema,
  runId: uuidSchema,
  userId: uuidSchema,
});

export const createRunRequestSchema = z.strictObject({ startedAt: timestampSchema });

export const runCommandTypeSchema = z.enum(['pause', 'resume', 'finish']);
export const runCommandRequestSchema = z.strictObject({
  commandId: uuidSchema,
  expectedControlRevision: revisionSchema,
  type: runCommandTypeSchema,
});
export const runCommandResponseSchema = z
  .strictObject({
    commandId: uuidSchema,
    controlRevision: revisionSchema,
    dataRevision: revisionSchema,
    finishedAt: timestampSchema.nullable(),
    status: runStatusSchema,
  })
  .refine((response) => (response.status === 'finished') === (response.finishedAt !== null), {
    message: '`finishedAt` must be present exactly when status is finished',
    path: ['finishedAt'],
  });

export const ingestPointsRequestSchema = z.strictObject({
  points: z.array(pointInputSchema).min(1).max(POINT_BATCH_MAX_SIZE),
});
export const ingestPointsResponseSchema = z
  .strictObject({
    dataRevision: revisionSchema,
    duplicateCount: nonnegativeIntegerSchema.max(POINT_BATCH_MAX_SIZE),
    insertedCount: nonnegativeIntegerSchema.max(POINT_BATCH_MAX_SIZE),
  })
  .refine(
    (response) =>
      response.duplicateCount + response.insertedCount <= POINT_BATCH_MAX_SIZE,
    {
    message: 'point result counts must not exceed the maximum batch size',
    },
  );

export const upsertRunShareRequestSchema = z.strictObject({
  canReadHistory: z.boolean(),
  canReadLive: z.boolean(),
});
export const runShareResponseSchema = z.strictObject({
  canReadHistory: z.boolean(),
  canReadLive: z.boolean(),
});

// The active coaches of the caller's organization, as identifiers only: no name exists to show (ADR-0063).
export const ORGANIZATION_COACH_LIST_MAX = 100;
export const organizationCoachListResponseSchema = z.strictObject({
  items: z.array(z.strictObject({ userId: uuidSchema })).max(ORGANIZATION_COACH_LIST_MAX),
});

// An owned run's shares with both flags exactly as stored, ordered by grantee. `truncated` says more exist.
export const RUN_SHARE_LIST_MAX = 100;
export const runShareListResponseSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        canReadHistory: z.boolean(),
        canReadLive: z.boolean(),
        userId: uuidSchema,
      }),
    )
    .max(RUN_SHARE_LIST_MAX),
  truncated: z.boolean(),
});

export const runListQuerySchema = z
  .strictObject({
    cursor: cursorSchema.optional(),
    from: timestampSchema,
    limit: queryLimit(100).optional(),
    to: timestampSchema,
  })
  .superRefine((value, context) => validateOrderedRange(value, context));
export const runListResponseSchema = z.strictObject({
  items: z.array(runViewSchema).max(100),
  nextCursor: cursorSchema.nullable(),
});

// Search over the signed-in person's own finished runs. The owner is never a parameter: the server takes it from
// the session (ADR-0056). A period is either a preset or an inclusive range of local calendar dates in a named
// time zone; the server turns it into a half-open UTC interval over `started_at`.
export const RUN_SEARCH_PAGE_MAX = 50;
export const RUN_SEARCH_DISTANCE_MAX_UNITS = 100_000;
export const runSearchPresetSchema = z.enum(['this-month', 'previous-month']);
export const runSearchSortSchema = z.enum(['newest', 'longest', 'shortest']);
export const distanceUnitSchema = z.enum(['km', 'mi']);
export const gpsQualitySchema = z.enum(['good', 'poor', 'insufficient']);

// A decimal in the chosen unit with at most three fraction digits, so the server converts it to metres exactly.
// No sign, no exponent, no leading zero: one spelling per value.
export const distanceBoundSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/u)
  .refine((value) => Number(value) <= RUN_SEARCH_DISTANCE_MAX_UNITS, {
    message: `A distance bound must not exceed ${RUN_SEARCH_DISTANCE_MAX_UNITS}`,
  });

/**
 * The checks shared by a search request and a proposed search: an ordered, inclusive range of at most
 * `ARCHIVE_PERIOD_MAX_DAYS` days. Dates that are not real calendar dates are left to `localDateSchema`.
 */
export function validateInclusiveDateRange(
  fromDate: string,
  toDate: string,
  context: z.RefinementCtx,
): void {
  const from = parseLocalDate(fromDate);
  const to = parseLocalDate(toDate);
  if (from === null || to === null) {
    return;
  }
  const days =
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000 + 1;
  if (days < 1) {
    context.addIssue({ code: 'custom', message: '`fromDate` must not be after `toDate`' });
  } else if (days > ARCHIVE_PERIOD_MAX_DAYS) {
    context.addIssue({
      code: 'custom',
      message: `The period must not exceed ${ARCHIVE_PERIOD_MAX_DAYS} days`,
    });
  }
}

export const runSearchQuerySchema = z
  .strictObject({
    cursor: cursorSchema.optional(),
    distanceUnit: distanceUnitSchema.optional(),
    fromDate: localDateSchema.optional(),
    limit: queryLimit(RUN_SEARCH_PAGE_MAX).optional(),
    maxDistance: distanceBoundSchema.optional(),
    minDistance: distanceBoundSchema.optional(),
    preset: runSearchPresetSchema.optional(),
    sort: runSearchSortSchema.optional(),
    timeZone: ianaTimeZoneSchema,
    toDate: localDateSchema.optional(),
  })
  .superRefine((value, context) => {
    const hasDates = value.fromDate !== undefined || value.toDate !== undefined;
    if (value.preset !== undefined && hasDates) {
      context.addIssue({ code: 'custom', message: 'Give either a preset or dates, not both' });
    } else if (value.preset === undefined) {
      if (value.fromDate === undefined || value.toDate === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Give a preset, or both `fromDate` and `toDate`',
        });
      } else {
        validateInclusiveDateRange(value.fromDate, value.toDate, context);
      }
    }
    const hasBound = value.minDistance !== undefined || value.maxDistance !== undefined;
    if (hasBound && value.distanceUnit === undefined) {
      context.addIssue({ code: 'custom', message: 'A distance bound needs an explicit `distanceUnit`' });
    }
    if (!hasBound && value.distanceUnit !== undefined) {
      context.addIssue({ code: 'custom', message: '`distanceUnit` needs a distance bound' });
    }
    if (
      value.minDistance !== undefined &&
      value.maxDistance !== undefined &&
      Number(value.minDistance) > Number(value.maxDistance)
    ) {
      context.addIssue({ code: 'custom', message: '`minDistance` must not exceed `maxDistance`' });
    }
  });

export const runSearchItemSchema = z.strictObject({
  distanceM: nonnegativeFiniteSchema,
  // Derived by the server from the summary's quality statistics; see ADR-0056 for the rule.
  gpsQuality: gpsQualitySchema,
  // The summary's `observedDurationS`: the sum of the durations of the run's accepted edges (ADR-0013). Time spent
  // across rejected edges, gaps and pauses is not in it, so it is not the time between the first and the last
  // measurement, and it is not moving time or workout time.
  observedDurationS: nonnegativeFiniteSchema,
  runId: uuidSchema,
  startedAt: timestampSchema,
});
export const runSearchResponseSchema = z.strictObject({
  // What the server actually applied: the resolved period and the distance bounds in metres.
  applied: z.strictObject({
    from: timestampSchema,
    fromDate: localDateSchema,
    maxDistanceM: nonnegativeFiniteSchema.nullable(),
    minDistanceM: nonnegativeFiniteSchema.nullable(),
    sort: runSearchSortSchema,
    timeZone: ianaTimeZoneSchema,
    to: timestampSchema,
    toDate: localDateSchema,
  }),
  items: z.array(runSearchItemSchema).max(RUN_SEARCH_PAGE_MAX),
  nextCursor: cursorSchema.nullable(),
  // Finished runs of this person in the period that have no current summary yet, counted before any distance
  // filter. They are not in `items` and nothing is claimed about whether they match.
  pendingSummaryCount: nonnegativeIntegerSchema,
});

// The decoded content of `nextCursor`. Opaque to clients; documented so the server's checks are explicit. `context`
// is a digest of the person, the organization and every filter that shapes the result set, so a cursor from a
// different query is refused instead of silently paging a different set.
export const runSearchCursorSchema = z
  .strictObject({
    context: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    // `double precision::text` of the last item's distance; null when the sort is not by distance.
    distanceKey: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/u)
      .nullable(),
    runId: uuidSchema,
    sort: runSearchSortSchema,
    startedAt: timestampSchema,
    version: z.literal(1),
  })
  .superRefine((cursor, context) => {
    if ((cursor.sort === 'newest') !== (cursor.distanceKey === null)) {
      context.addIssue({
        code: 'custom',
        message: '`distanceKey` is required exactly for the distance sorts',
        path: ['distanceKey'],
      });
    }
  });

export const pointsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: queryLimit(1_000).optional(),
});
export const pointsResponseSchema = z.strictObject({
  dataRevision: revisionSchema,
  nextCursor: cursorSchema.nullable(),
  points: z.array(pointInputSchema).max(1_000),
});

export const liveTrackQuerySchema = pointsQuerySchema;
const liveTrackChangePageQueryFields = { limit: queryLimit(1_000).optional() };
export const liveTrackChangesQuerySchema = z.union([
  z.strictObject({ afterRevision: revisionSchema, ...liveTrackChangePageQueryFields }),
  z.strictObject({ cursor: cursorSchema, ...liveTrackChangePageQueryFields }),
]);

export const archiveTrackQuerySchema = z.strictObject({ mode: z.literal('archive') });
export const multiLineStringSchema = z.strictObject({
  coordinates: z.array(z.array(coordinatesSchema).min(2)).min(1),
  type: z.literal('MultiLineString'),
});
export const archiveTrackResponseSchema = z.strictObject({
  geometry: multiLineStringSchema.nullable(),
  properties: z.strictObject({
    algorithmVersion: z.string().min(1).max(128),
    sourceRevision: revisionSchema,
  }),
  type: z.literal('Feature'),
});

function validBbox(value: string): boolean {
  const parts = value.split(',');
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(part))) {
    return false;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part))) return false;
  const [west, south, east, north] = numbers as [number, number, number, number];
  return (
    west >= -180 &&
    west <= 180 &&
    east >= -180 &&
    east <= 180 &&
    south >= -90 &&
    south <= 90 &&
    north >= -90 &&
    north <= 90 &&
    south <= north
  );
}

export const bboxSchema = z
  .string()
  .refine(validBbox, 'Expected west,south,east,north in WGS84 ranges');
export const archiveRunListQuerySchema = z
  .strictObject({
    bbox: bboxSchema,
    cursor: cursorSchema.optional(),
    from: timestampSchema,
    limit: queryLimit(100).optional(),
    to: timestampSchema,
  })
  .superRefine((value, context) => validateOrderedRange(value, context, 366));
export const archiveRunListResponseSchema = runListResponseSchema;

const finiteQueryNumber = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u)
  .transform((value, context) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      context.addIssue({ code: 'custom', message: 'Expected a finite number' });
      return z.NEVER;
    }
    return parsed;
  });
export const nearbyQuerySchema = z.strictObject({
  latitude: finiteQueryNumber.pipe(latitudeSchema),
  longitude: finiteQueryNumber.pipe(longitudeSchema),
  radiusM: finiteQueryNumber.pipe(z.number().nonnegative().max(5_000)),
});
export const nearbyResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      coordinates: coordinatesSchema,
      distanceM: nonnegativeFiniteSchema,
      recordedAt: timestampSchema,
      runId: uuidSchema,
    }),
  ),
  serverTime: timestampSchema,
});

export const archiveMetadataQuerySchema = z
  .strictObject({ from: timestampSchema, to: timestampSchema })
  .superRefine((value, context) =>
    validateOrderedRange(value, context, ARCHIVE_PERIOD_MAX_DAYS),
  );
export const archiveMetadataResponseSchema = z
  .strictObject({
    archiveRevision: revisionSchema,
    filter: z.strictObject({ from: timestampSchema, to: timestampSchema }),
    maxzoom: z.int().min(0).max(24),
    minzoom: z.int().min(0).max(24),
    sourceLayer: z.string().min(1),
    tiles: z.array(z.string().min(1)).min(1),
  })
  .superRefine((metadata, context) => {
    if (metadata.minzoom > metadata.maxzoom) {
      context.addIssue({
        code: 'custom',
        message: '`minzoom` must not exceed `maxzoom`',
        path: ['minzoom'],
      });
    }
    validateOrderedRange(metadata.filter, context, 366);
  });

const tileCoordinateSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .transform(Number)
  .pipe(z.int().nonnegative());
export const tilePathSchema = z
  .strictObject({
    orgId: uuidSchema,
    x: tileCoordinateSchema,
    y: tileCoordinateSchema,
    z: tileCoordinateSchema,
  })
  .superRefine((value, context) => {
    if (value.z < ARCHIVE_TILE_MIN_ZOOM || value.z > ARCHIVE_TILE_MAX_ZOOM) {
      context.addIssue({
        code: 'custom',
        message: `Tile zoom must be between ${ARCHIVE_TILE_MIN_ZOOM} and ${ARCHIVE_TILE_MAX_ZOOM}`,
        path: ['z'],
      });
      return;
    }
    const coordinateLimit = 2 ** value.z;
    for (const coordinate of ['x', 'y'] as const) {
      if (value[coordinate] >= coordinateLimit) {
        context.addIssue({
          code: 'custom',
          message: `${coordinate} must be less than 2^z`,
          path: [coordinate],
        });
      }
    }
  });
export const tileQuerySchema = z
  .strictObject({
    from: timestampSchema,
    revision: revisionSchema,
    to: timestampSchema,
  })
  .superRefine((value, context) =>
    validateOrderedRange(value, context, ARCHIVE_PERIOD_MAX_DAYS),
  );

export const liveTrackResponseSchema = trackPageSchema;

export type SessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export type RunCommandType = z.infer<typeof runCommandTypeSchema>;
export type RunCommandRequest = z.infer<typeof runCommandRequestSchema>;
export type RunCommandResponse = z.infer<typeof runCommandResponseSchema>;
export type IngestPointsRequest = z.infer<typeof ingestPointsRequestSchema>;
export type IngestPointsResponse = z.infer<typeof ingestPointsResponseSchema>;
export type UpsertRunShareRequest = z.infer<typeof upsertRunShareRequestSchema>;
export type RunShareResponse = z.infer<typeof runShareResponseSchema>;
export type OrganizationCoachListResponse = z.infer<typeof organizationCoachListResponseSchema>;
export type RunShareListResponse = z.infer<typeof runShareListResponseSchema>;
export type RunListQuery = z.infer<typeof runListQuerySchema>;
export type RunListResponse = z.infer<typeof runListResponseSchema>;
export type RunSearchQuery = z.infer<typeof runSearchQuerySchema>;
export type RunSearchResponse = z.infer<typeof runSearchResponseSchema>;
export type RunSearchItem = z.infer<typeof runSearchItemSchema>;
export type RunSearchCursor = z.infer<typeof runSearchCursorSchema>;
export type RunSearchPreset = z.infer<typeof runSearchPresetSchema>;
export type RunSearchSort = z.infer<typeof runSearchSortSchema>;
export type DistanceUnit = z.infer<typeof distanceUnitSchema>;
export type GpsQuality = z.infer<typeof gpsQualitySchema>;
export type PointsQuery = z.infer<typeof pointsQuerySchema>;
export type PointsResponse = z.infer<typeof pointsResponseSchema>;
export type LiveTrackChangesQuery = z.infer<typeof liveTrackChangesQuerySchema>;
export type ArchiveTrackResponse = z.infer<typeof archiveTrackResponseSchema>;
export type ArchiveRunListQuery = z.infer<typeof archiveRunListQuerySchema>;
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;
export type NearbyResponse = z.infer<typeof nearbyResponseSchema>;
export type ArchiveMetadataResponse = z.infer<typeof archiveMetadataResponseSchema>;
export type OrganizationListResponse = z.infer<typeof organizationListResponseSchema>;
export type OrganizationPath = z.infer<typeof organizationPathSchema>;
export type RunPath = z.infer<typeof runPathSchema>;
export type RunSharePath = z.infer<typeof runSharePathSchema>;
export type LiveTrackQuery = z.infer<typeof liveTrackQuerySchema>;
export type LiveTrackResponse = z.infer<typeof liveTrackResponseSchema>;
export type ArchiveTrackQuery = z.infer<typeof archiveTrackQuerySchema>;
export type ArchiveRunListResponse = z.infer<typeof archiveRunListResponseSchema>;
export type ArchiveMetadataQuery = z.infer<typeof archiveMetadataQuerySchema>;
export type TilePath = z.infer<typeof tilePathSchema>;
export type TileQuery = z.infer<typeof tileQuerySchema>;
