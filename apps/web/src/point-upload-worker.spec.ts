import type { PointInput } from '@running-tracker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PointUploadProtocolError, PointUploadWorker } from './point-upload-worker.js';
import { RunnerApiError } from './runner-api.js';

const scope = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId: '11111111-1111-4111-8111-111111111111',
};

function point(seq: number): PointInput {
  return {
    accuracyM: 4.5,
    latitude: 52.2297,
    longitude: 21.0122,
    recordedAt: new Date(Date.UTC(2026, 8, 26, 8, 0, seq % 60)).toISOString(),
    segmentId: 0,
    seq: seq.toString(),
  };
}

function storageHarness(size: number) {
  let points = Array.from({ length: size }, (_, index) => point(index + 1));
  const acknowledged: string[][] = [];
  return {
    acknowledged,
    storage: {
      acknowledgePointBatch: vi.fn((_scope, sequences: readonly string[]) => {
        acknowledged.push([...sequences]);
        const removed = new Set(sequences);
        points = points.filter((candidate) => !removed.has(candidate.seq));
        return Promise.resolve();
      }),
      countPoints: vi.fn(() => Promise.resolve(points.length)),
      readPointBatch: vi.fn((_scope, limit: number) => Promise.resolve(points.slice(0, limit))),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PointUploadWorker', () => {
  it('uploads sequential bounded batches and deletes each exact acknowledged sequence set', async () => {
    vi.useFakeTimers();
    const harness = storageHarness(205);
    const sent: string[][] = [];
    const states: string[] = [];
    const worker = new PointUploadWorker({
      onState: (state) => states.push(`${state.status}:${state.pendingCount}`),
      scope,
      send: vi.fn((points: PointInput[]) => {
        sent.push(points.map((candidate) => candidate.seq));
        return Promise.resolve({
          dataRevision: sent.length.toString(),
          duplicateCount: 0,
          insertedCount: points.length,
        });
      }),
      storage: harness.storage,
    });

    worker.start(true);
    await vi.runAllTimersAsync();

    expect(sent.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(harness.acknowledged).toEqual(sent);
    expect(states.at(-1)).toBe('idle:0');
  });

  it('keeps an unacknowledged batch intact and retries it with capped exponential jitter', async () => {
    vi.useFakeTimers();
    const harness = storageHarness(2);
    const sent: string[][] = [];
    const states: string[] = [];
    const send = vi.fn((points: PointInput[]) => {
      sent.push(points.map((candidate) => candidate.seq));
      if (sent.length === 1) {
        return Promise.reject(new TypeError('network unavailable'));
      }
      return Promise.resolve({ dataRevision: '1', duplicateCount: 0, insertedCount: 2 });
    });
    const worker = new PointUploadWorker({
      onState: (state) => states.push(state.status),
      random: () => 0.5,
      scope,
      send,
      storage: harness.storage,
    });

    worker.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.acknowledged).toEqual([]);
    expect(states.at(-1)).toBe('retrying');

    await vi.advanceTimersByTimeAsync(499);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toEqual([['1', '2'], ['1', '2']]);
    expect(harness.acknowledged).toEqual([['1', '2']]);
    expect(states.at(-1)).toBe('idle');
  });

  it('honours Retry-After and does not retry early', async () => {
    vi.useFakeTimers();
    const harness = storageHarness(1);
    const send = vi.fn()
      .mockRejectedValueOnce(new RunnerApiError('Slow down', 429, 'RATE_LIMITED', null, 4_000))
      .mockResolvedValueOnce({ dataRevision: '1', duplicateCount: 0, insertedCount: 1 });
    const worker = new PointUploadWorker({
      onState: vi.fn(),
      random: () => 0,
      scope,
      send,
      storage: harness.storage,
    });

    worker.start(true);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch while offline and resumes the preserved batch on reconnection', async () => {
    vi.useFakeTimers();
    const harness = storageHarness(1);
    const send = vi.fn(() => Promise.resolve({
      dataRevision: '1',
      duplicateCount: 0,
      insertedCount: 1,
    }));
    const worker = new PointUploadWorker({
      onState: vi.fn(),
      scope,
      send,
      storage: harness.storage,
    });

    worker.start(false);
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();

    worker.setOnline(true);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.acknowledged).toEqual([['1']]);
  });

  it('stops on a permanent API error, preserves points, and runs reconciliation once', async () => {
    vi.useFakeTimers();
    const harness = storageHarness(1);
    const reconcile = vi.fn(() => Promise.resolve());
    const send = vi.fn(() => Promise.reject(
      new RunnerApiError('Upload window closed', 409, 'UPLOAD_WINDOW_CLOSED', 'request-id'),
    ));
    const onState = vi.fn();
    const worker = new PointUploadWorker({
      onPermanentError: reconcile,
      onState,
      scope,
      send,
      storage: harness.storage,
    });

    worker.start(true);
    await vi.runAllTimersAsync();
    worker.wake();
    worker.setOnline(true);
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(harness.acknowledged).toEqual([]);
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ pendingCount: 1, status: 'error' }));
  });

  it('treats an incomplete success acknowledgement as permanent and never deletes the batch', async () => {
    vi.useFakeTimers();
    const harness = storageHarness(2);
    const reconcile = vi.fn();
    const worker = new PointUploadWorker({
      onPermanentError: reconcile,
      onState: vi.fn(),
      scope,
      send: () => Promise.resolve({ dataRevision: '1', duplicateCount: 0, insertedCount: 1 }),
      storage: harness.storage,
    });

    worker.start(true);
    await vi.runAllTimersAsync();

    expect(harness.acknowledged).toEqual([]);
    expect(reconcile).toHaveBeenCalledWith(expect.any(PointUploadProtocolError));
  });
});
