import { z } from 'zod';

import {
  accuracyMetersSchema,
  canonicalFiniteNumber,
  coordinatesSchema,
  nonnegativeFiniteSchema,
  nonnegativeIntegerSchema,
  revisionSchema,
  segmentIdSchema,
  seqSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

export const runStatusSchema = z.enum(['recording', 'paused', 'finished']);
export const activeRunStatusSchema = z.enum(['recording', 'paused']);
export const rawStateSchema = z.enum(['available', 'purging', 'purged']);

function canonicalPointTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u.exec(value);
  if (!match) {
    return value;
  }
  const fraction = match[2] ?? '';
  const milliseconds = Date.parse(`${match[1]}.${fraction.padEnd(3, '0').slice(0, 3)}Z`);
  if (!Number.isFinite(milliseconds)) {
    return value;
  }
  const rounded = milliseconds + (fraction.length > 3 && Number(fraction[3]) >= 5 ? 1 : 0);
  return new Date(rounded).toISOString();
}

export const qualityStatsSchema = z.strictObject({
  acceptedEdgeCount: nonnegativeIntegerSchema,
  acceptedPointCount: nonnegativeIntegerSchema,
  excessiveSpeedCount: nonnegativeIntegerSchema,
  excessiveTimeGapCount: nonnegativeIntegerSchema,
  insufficientData: z.boolean(),
  nonpositiveTimeDeltaCount: nonnegativeIntegerSchema,
  poorAccuracyPointCount: nonnegativeIntegerSchema,
  rawPointCount: nonnegativeIntegerSchema,
  segmentBreakCount: nonnegativeIntegerSchema,
  seqGapCount: nonnegativeIntegerSchema,
});

export const runSummarySchema = z.strictObject({
  algorithmVersion: z.string().min(1).max(128),
  distanceM: nonnegativeFiniteSchema,
  observedDurationS: nonnegativeFiniteSchema,
  qualityStats: qualityStatsSchema,
  sourceRevision: revisionSchema,
});

export const runViewSchema = z
  .strictObject({
    controlRevision: revisionSchema,
    dataRevision: revisionSchema,
    finishedAt: timestampSchema.nullable(),
    rawState: rawStateSchema,
    runId: uuidSchema,
    startedAt: timestampSchema,
    status: runStatusSchema,
    summary: runSummarySchema.nullable(),
  })
  .superRefine((run, context) => {
    const isFinished = run.status === 'finished';
    if (isFinished !== (run.finishedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: '`finishedAt` must be present exactly when status is finished',
        path: ['finishedAt'],
      });
    }
    if (run.finishedAt !== null && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
      context.addIssue({
        code: 'custom',
        message: '`finishedAt` must not be earlier than `startedAt`',
        path: ['finishedAt'],
      });
    }
    if (run.rawState !== 'available' && !isFinished) {
      context.addIssue({
        code: 'custom',
        message: 'purging or purged raw state requires a finished run',
        path: ['rawState'],
      });
    }
    if (run.summary !== null && !isFinished) {
      context.addIssue({
        code: 'custom',
        message: 'a published summary requires a finished run',
        path: ['summary'],
      });
    }
  });

export const pointInputSchema = z.strictObject({
  accuracyM: accuracyMetersSchema.overwrite(canonicalFiniteNumber),
  latitude: z.number().finite().min(-90).max(90).overwrite(canonicalFiniteNumber),
  longitude: z.number().finite().min(-180).max(180).overwrite(canonicalFiniteNumber),
  recordedAt: timestampSchema
    .overwrite(canonicalPointTimestamp)
    .refine((value) => timestampSchema.safeParse(value).success, 'Timestamp rounding is out of range'),
  segmentId: segmentIdSchema,
  seq: seqSchema.overwrite((value) => BigInt(value).toString()),
});

export const trackPointSchema = z.strictObject({
  accuracyM: accuracyMetersSchema,
  connectFromPrevious: z.boolean(),
  coordinates: coordinatesSchema,
  predecessorSeq: seqSchema.nullable(),
  recordedAt: timestampSchema,
  segmentId: segmentIdSchema,
  seq: seqSchema,
});

export const trackPageSchema = z
  .strictObject({
    algorithmVersion: z.string().min(1).max(128),
    fromRevision: revisionSchema.nullable(),
    nextCursor: z.string().min(1).max(4_096).nullable(),
    toRevision: revisionSchema,
    upserts: z.array(trackPointSchema).max(1_000),
  })
  .refine(
    (page) => page.fromRevision === null || BigInt(page.fromRevision) <= BigInt(page.toRevision),
    { message: '`fromRevision` must not exceed `toRevision`', path: ['fromRevision'] },
  );

export type RunStatus = z.infer<typeof runStatusSchema>;
export type RawState = z.infer<typeof rawStateSchema>;
export type QualityStats = z.infer<typeof qualityStatsSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunView = z.infer<typeof runViewSchema>;
export type PointInput = z.infer<typeof pointInputSchema>;
export type TrackPoint = z.infer<typeof trackPointSchema>;
export type TrackPage = z.infer<typeof trackPageSchema>;
