import { z } from 'zod';

import {
  accuracyMetersSchema,
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

// D01 deliberately remains open: this validates the transport value domain but does not
// canonicalize numeric spelling, -0, timestamp spelling, or retry equivalence.
export const pointInputSchema = z.strictObject({
  accuracyM: accuracyMetersSchema,
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  recordedAt: timestampSchema,
  segmentId: segmentIdSchema,
  seq: seqSchema,
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
