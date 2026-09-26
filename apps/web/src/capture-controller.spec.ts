import type { PointInput } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CaptureController, type CaptureState } from './capture-controller.js';
import type { CaptureSink, CaptureSource } from './capture-source.js';
import type { WriterLease } from './runner-storage.js';

const scope = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId: '11111111-1111-4111-8111-111111111111',
};
const lease: WriterLease = {
  expiresAt: '2026-09-26T08:01:00.000Z',
  fencingToken: '1',
  ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  userId: scope.userId,
};
const measurement = {
  accuracyM: 4.5,
  latitude: 52.2297,
  longitude: 21.0122,
  recordedAt: '2026-09-26T08:00:00.000Z',
};

function sourceHarness() {
  let sink: CaptureSink | null = null;
  const stop = vi.fn();
  const source: CaptureSource = {
    label: 'Test source',
    start: vi.fn((nextSink: CaptureSink) => {
      sink = nextSink;
      return { stop };
    }),
  };
  return {
    emit: () => sink?.measurement(measurement),
    source,
    stop,
  };
}

describe('CaptureController', () => {
  it('serializes source measurements and assigns one durable segment to the session', async () => {
    const source = sourceHarness();
    const points: PointInput[] = [];
    let nextSeq = 1;
    const storage = {
      allocateCaptureSegment: vi.fn(() => Promise.resolve(3)),
      appendPointForWriter: vi.fn((_scope, value) => Promise.resolve({
        ...value,
        seq: String(nextSeq++),
      } as PointInput)),
    };
    const states: CaptureState[] = [];
    const controller = new CaptureController({
      assertOwnedLease: () => Promise.resolve(lease),
      onPoint: (point) => points.push(point),
      onState: (state) => states.push(state),
      scope,
      source: source.source,
      storage,
    });

    await expect(controller.start()).resolves.toBe(true);
    source.emit();
    source.emit();
    await controller.whenIdle();

    expect(points.map(({ seq, segmentId }) => ({ seq, segmentId }))).toEqual([
      { segmentId: 3, seq: '1' },
      { segmentId: 3, seq: '2' },
    ]);
    expect(states.at(-1)).toMatchObject({ capturedCount: 2, segmentId: 3, status: 'capturing' });
  });

  it('rejects a callback stopped while its ownership check is still in flight', async () => {
    const source = sourceHarness();
    let resolveOwnership: ((value: WriterLease | null) => void) | undefined;
    const ownership = vi.fn()
      .mockResolvedValueOnce(lease)
      .mockImplementationOnce(() => new Promise<WriterLease | null>((resolve) => {
        resolveOwnership = resolve;
      }));
    const storage = {
      allocateCaptureSegment: vi.fn(() => Promise.resolve(0)),
      appendPointForWriter: vi.fn(),
    };
    const controller = new CaptureController({
      assertOwnedLease: ownership,
      onPoint: vi.fn(),
      onState: vi.fn(),
      scope,
      source: source.source,
      storage,
    });
    await controller.start();

    source.emit();
    await Promise.resolve();
    controller.stop();
    resolveOwnership?.(lease);
    await controller.whenIdle();

    expect(source.stop).toHaveBeenCalledOnce();
    expect(storage.appendPointForWriter).not.toHaveBeenCalled();
  });

  it('fails closed when the lease is lost before accepting a measurement', async () => {
    const source = sourceHarness();
    const states: CaptureState[] = [];
    const storage = {
      allocateCaptureSegment: vi.fn(() => Promise.resolve(0)),
      appendPointForWriter: vi.fn(),
    };
    const controller = new CaptureController({
      assertOwnedLease: vi.fn().mockResolvedValueOnce(lease).mockResolvedValueOnce(null),
      onPoint: vi.fn(),
      onState: (state) => states.push(state),
      scope,
      source: source.source,
      storage,
    });
    await controller.start();

    source.emit();
    await controller.whenIdle();

    expect(storage.appendPointForWriter).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ status: 'lost' });
    expect(source.stop).toHaveBeenCalledOnce();
  });

  it('stops instead of building an unbounded callback queue behind slow storage', async () => {
    const source = sourceHarness();
    const states: CaptureState[] = [];
    const neverSettles = new Promise<WriterLease | null>(() => undefined);
    const controller = new CaptureController({
      assertOwnedLease: vi.fn().mockResolvedValueOnce(lease).mockReturnValue(neverSettles),
      onPoint: vi.fn(),
      onState: (state) => states.push(state),
      scope,
      source: source.source,
      storage: {
        allocateCaptureSegment: vi.fn(() => Promise.resolve(0)),
        appendPointForWriter: vi.fn(),
      },
    });
    await controller.start();

    for (let index = 0; index < 101; index += 1) source.emit();

    expect(states.at(-1)).toMatchObject({ status: 'error' });
    expect(source.stop).toHaveBeenCalledOnce();
  });
});
