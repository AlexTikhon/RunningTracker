import { describe, expect, it } from 'vitest';

import { LIVE_TRACK_CURSOR_TTL_MS, LiveTrackCursorCodec } from './live-track-cursor.js';

const signingKey = Buffer.from('cursor-signing-key-with-at-least-32-bytes', 'utf8').toString(
  'base64url',
);
const otherSigningKey = Buffer.from('different-signing-key-with-32-plus-bytes', 'utf8').toString(
  'base64url',
);
const binding = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

class ControlledUtcClock {
  #nowMs = Date.parse('2031-01-03T00:00:00.000Z');

  public advanceBy(milliseconds: number): void {
    this.#nowMs += milliseconds;
  }

  public utcNow(): Date {
    return new Date(this.#nowMs);
  }
}

function createCodec(clock: ControlledUtcClock, key = signingKey): LiveTrackCursorCodec {
  return new LiveTrackCursorCodec({ clock, signingKey: key });
}

describe('LiveTrackCursorCodec', () => {
  it('signs and round-trips every snapshot binding and fixed-revision field', () => {
    const clock = new ControlledUtcClock();
    const codec = createCodec(clock);
    const token = codec.encodeSnapshot({
      ...binding,
      algorithmVersion: 'v1',
      lastSeq: '9007199254740993',
      operation: 'snapshot',
      toRevision: '12',
    });

    expect(token.split('.')).toHaveLength(2);
    expect(codec.decodeSnapshot(token, binding)).toEqual({
      ...binding,
      algorithmVersion: 'v1',
      expiresAtMs: clock.utcNow().getTime() + LIVE_TRACK_CURSOR_TTL_MS,
      lastSeq: '9007199254740993',
      operation: 'snapshot',
      toRevision: '12',
      version: 1,
    });
  });

  it('binds changes to the operation, user, organization, run, and revision window', () => {
    const clock = new ControlledUtcClock();
    const codec = createCodec(clock);
    const token = codec.encodeChanges({
      ...binding,
      algorithmVersion: 'v1',
      fromRevision: '7',
      lastSeq: '19',
      operation: 'changes',
      toRevision: '12',
    });

    expect(codec.decodeChanges(token, binding)).toMatchObject({
      fromRevision: '7',
      operation: 'changes',
      toRevision: '12',
    });
    for (const foreignBinding of [
      { ...binding, userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { ...binding, orgId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { ...binding, runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    ]) {
      expect(() => codec.decodeChanges(token, foreignBinding)).toThrow(
        'The live-track cursor is invalid',
      );
    }
    expect(() => codec.decodeSnapshot(token, binding)).toThrow(
      'The live-track cursor is invalid',
    );
  });

  it('rejects payload tampering, signature tampering, and another signing key', () => {
    const clock = new ControlledUtcClock();
    const codec = createCodec(clock);
    const token = codec.encodeSnapshot({
      ...binding,
      algorithmVersion: 'v1',
      lastSeq: '1',
      operation: 'snapshot',
      toRevision: '2',
    });
    const [payload, signature] = token.split('.') as [string, string];
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(() => codec.decodeSnapshot(`${tamperedPayload}.${signature}`, binding)).toThrow(
      'The live-track cursor is invalid',
    );
    expect(() => codec.decodeSnapshot(`${payload}.${tamperedSignature}`, binding)).toThrow(
      'The live-track cursor is invalid',
    );
    expect(() => createCodec(clock, otherSigningKey).decodeSnapshot(token, binding)).toThrow(
      'The live-track cursor is invalid',
    );
  });

  it('expires after ten minutes and preserves one deadline across a page chain', () => {
    const clock = new ControlledUtcClock();
    const codec = createCodec(clock);
    const first = codec.encodeSnapshot({
      ...binding,
      algorithmVersion: 'v1',
      lastSeq: '1',
      operation: 'snapshot',
      toRevision: '2',
    });
    const firstPayload = codec.decodeSnapshot(first, binding);

    clock.advanceBy(5 * 60 * 1_000);
    const second = codec.encodeSnapshot(
      { ...firstPayload, lastSeq: '2' },
      firstPayload.expiresAtMs,
    );
    expect(codec.decodeSnapshot(second, binding).expiresAtMs).toBe(firstPayload.expiresAtMs);

    clock.advanceBy(5 * 60 * 1_000);
    expect(() => codec.decodeSnapshot(first, binding)).toThrow(
      'The live-track cursor is invalid',
    );
    expect(() => codec.decodeSnapshot(second, binding)).toThrow(
      'The live-track cursor is invalid',
    );
  });
});
