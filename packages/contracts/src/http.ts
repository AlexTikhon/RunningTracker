import { z } from 'zod';

import { pointInputSchema, runStatusSchema, runViewSchema, trackPageSchema } from './models.js';
import {
  coordinatesSchema,
  cursorSchema,
  latitudeSchema,
  longitudeSchema,
  nonnegativeFiniteSchema,
  nonnegativeIntegerSchema,
  revisionSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
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
  points: z.array(pointInputSchema).min(1).max(100),
});
export const ingestPointsResponseSchema = z
  .strictObject({
    dataRevision: revisionSchema,
    duplicateCount: nonnegativeIntegerSchema.max(100),
    insertedCount: nonnegativeIntegerSchema.max(100),
  })
  .refine((response) => response.duplicateCount + response.insertedCount <= 100, {
    message: 'point result counts must not exceed the maximum batch size',
  });

export const upsertRunShareRequestSchema = z.strictObject({
  canReadHistory: z.boolean(),
  canReadLive: z.boolean(),
});
export const runShareResponseSchema = z.strictObject({
  canReadHistory: z.boolean(),
  canReadLive: z.boolean(),
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
  .superRefine((value, context) => validateOrderedRange(value, context, 366));
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

export const tilePathSchema = z.strictObject({
  orgId: uuidSchema,
  x: z.string().regex(/^\d+$/u),
  y: z.string().regex(/^\d+$/u),
  z: z.string().regex(/^\d+$/u),
});
export const tileQuerySchema = z
  .strictObject({
    from: timestampSchema,
    revision: revisionSchema,
    to: timestampSchema,
  })
  .superRefine((value, context) => validateOrderedRange(value, context, 366));

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
export type RunListQuery = z.infer<typeof runListQuerySchema>;
export type RunListResponse = z.infer<typeof runListResponseSchema>;
export type PointsQuery = z.infer<typeof pointsQuerySchema>;
export type PointsResponse = z.infer<typeof pointsResponseSchema>;
export type LiveTrackChangesQuery = z.infer<typeof liveTrackChangesQuerySchema>;
export type ArchiveTrackResponse = z.infer<typeof archiveTrackResponseSchema>;
export type ArchiveRunListQuery = z.infer<typeof archiveRunListQuerySchema>;
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;
export type NearbyResponse = z.infer<typeof nearbyResponseSchema>;
export type ArchiveMetadataResponse = z.infer<typeof archiveMetadataResponseSchema>;
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
