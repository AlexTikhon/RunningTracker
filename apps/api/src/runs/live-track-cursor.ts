import { createHmac, timingSafeEqual } from 'node:crypto';

import { revisionSchema, seqSchema, uuidSchema } from '@running-tracker/contracts';
import { z } from 'zod';

import type { Clock } from '../clock.js';

export const LIVE_TRACK_CURSOR_TTL_MS = 10 * 60 * 1_000;

const sharedCursorShape = {
  algorithmVersion: z.string().min(1).max(128),
  expiresAtMs: z.number().int().nonnegative().safe(),
  lastSeq: seqSchema,
  orgId: uuidSchema,
  runId: uuidSchema,
  userId: uuidSchema,
  version: z.literal(1),
} as const;

const snapshotCursorSchema = z.strictObject({
  ...sharedCursorShape,
  operation: z.literal('snapshot'),
  toRevision: revisionSchema,
});

const changesCursorSchema = z
  .strictObject({
    ...sharedCursorShape,
    fromRevision: revisionSchema,
    operation: z.literal('changes'),
    toRevision: revisionSchema,
  })
  .refine((cursor) => BigInt(cursor.fromRevision) <= BigInt(cursor.toRevision), {
    message: 'The source revision must not exceed the target revision',
    path: ['fromRevision'],
  });

export type LiveTrackSnapshotCursor = z.infer<typeof snapshotCursorSchema>;
export type LiveTrackChangesCursor = z.infer<typeof changesCursorSchema>;

export interface LiveTrackCursorBinding {
  orgId: string;
  runId: string;
  userId: string;
}

type NewSnapshotCursor = Omit<LiveTrackSnapshotCursor, 'expiresAtMs' | 'version'>;
type NewChangesCursor = Omit<LiveTrackChangesCursor, 'expiresAtMs' | 'version'>;

export class InvalidLiveTrackCursorError extends Error {
  public constructor() {
    super('The live-track cursor is invalid');
    this.name = 'InvalidLiveTrackCursorError';
  }
}

function canonicalBinding(binding: LiveTrackCursorBinding): LiveTrackCursorBinding {
  return {
    orgId: binding.orgId.toLowerCase(),
    runId: binding.runId.toLowerCase(),
    userId: binding.userId.toLowerCase(),
  };
}

function matchesBinding(
  cursor: Pick<LiveTrackSnapshotCursor, 'orgId' | 'runId' | 'userId'>,
  binding: LiveTrackCursorBinding,
): boolean {
  const expected = canonicalBinding(binding);
  return (
    cursor.orgId.toLowerCase() === expected.orgId &&
    cursor.runId.toLowerCase() === expected.runId &&
    cursor.userId.toLowerCase() === expected.userId
  );
}

export class LiveTrackCursorCodec {
  readonly #clock: Pick<Clock, 'utcNow'>;
  readonly #signingKey: Buffer;

  public constructor(options: {
    clock: Pick<Clock, 'utcNow'>;
    signingKey: string;
  }) {
    this.#clock = options.clock;
    this.#signingKey = Buffer.from(options.signingKey, 'base64url');
  }

  public encodeSnapshot(cursor: NewSnapshotCursor, expiresAtMs?: number): string {
    return this.#encode(
      snapshotCursorSchema.parse({
        ...cursor,
        expiresAtMs: expiresAtMs ?? this.#newExpiry(),
        version: 1,
      }),
    );
  }

  public encodeChanges(cursor: NewChangesCursor, expiresAtMs?: number): string {
    return this.#encode(
      changesCursorSchema.parse({
        ...cursor,
        expiresAtMs: expiresAtMs ?? this.#newExpiry(),
        version: 1,
      }),
    );
  }

  public decodeSnapshot(token: string, binding: LiveTrackCursorBinding): LiveTrackSnapshotCursor {
    const cursor = this.#decode(token, snapshotCursorSchema);
    if (!matchesBinding(cursor, binding)) {
      throw new InvalidLiveTrackCursorError();
    }
    return cursor;
  }

  public decodeChanges(token: string, binding: LiveTrackCursorBinding): LiveTrackChangesCursor {
    const cursor = this.#decode(token, changesCursorSchema);
    if (!matchesBinding(cursor, binding)) {
      throw new InvalidLiveTrackCursorError();
    }
    return cursor;
  }

  #decode<Cursor>(token: string, schema: z.ZodType<Cursor>): Cursor {
    try {
      const parts = token.split('.');
      if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1] ||
        !/^[A-Za-z0-9_-]+$/u.test(parts[0]) ||
        !/^[A-Za-z0-9_-]+$/u.test(parts[1])
      ) {
        throw new InvalidLiveTrackCursorError();
      }

      const signature = Buffer.from(parts[1], 'base64url');
      const expectedSignature = this.#signature(parts[0]);
      if (
        signature.length !== expectedSignature.length ||
        !timingSafeEqual(signature, expectedSignature)
      ) {
        throw new InvalidLiveTrackCursorError();
      }

      const decoded: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) {
        throw new InvalidLiveTrackCursorError();
      }
      const expiresAtMs = (parsed.data as { expiresAtMs?: unknown }).expiresAtMs;
      if (typeof expiresAtMs !== 'number' || expiresAtMs <= this.#clock.utcNow().getTime()) {
        throw new InvalidLiveTrackCursorError();
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof InvalidLiveTrackCursorError) {
        throw error;
      }
      throw new InvalidLiveTrackCursorError();
    }
  }

  #encode(cursor: LiveTrackSnapshotCursor | LiveTrackChangesCursor): string {
    const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    return `${payload}.${this.#signature(payload).toString('base64url')}`;
  }

  #newExpiry(): number {
    return this.#clock.utcNow().getTime() + LIVE_TRACK_CURSOR_TTL_MS;
  }

  #signature(payload: string): Buffer {
    return createHmac('sha256', this.#signingKey).update(payload, 'ascii').digest();
  }
}
