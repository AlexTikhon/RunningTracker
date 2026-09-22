import { z } from 'zod';

import { activeRunStatusSchema } from './models.js';
import {
  accuracyMetersSchema,
  coordinatesSchema,
  revisionSchema,
  seqSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

export const livePositionSchema = z.strictObject({
  accuracyM: accuracyMetersSchema,
  coordinates: coordinatesSchema,
  quality: z.enum(['confirmed', 'unconfirmed']),
  recordedAt: timestampSchema,
  seq: seqSchema,
});

export const liveStateRunSchema = z.strictObject({
  dataRevision: revisionSchema,
  position: livePositionSchema.nullable(),
  runId: uuidSchema,
  status: activeRunStatusSchema,
});

export const liveStateSchema = z.strictObject({
  algorithmVersion: z.string().min(1).max(128),
  runs: z.array(liveStateRunSchema),
  sequence: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  serverTime: timestampSchema,
  streamId: uuidSchema,
});

export const liveEventName = 'live.state' as const;

export type LivePosition = z.infer<typeof livePositionSchema>;
export type LiveStateRun = z.infer<typeof liveStateRunSchema>;
export type LiveState = z.infer<typeof liveStateSchema>;
