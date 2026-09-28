import type { ArchiveMetadataResponse } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_METADATA_POLL_INTERVAL_MS,
  ArchiveSourceController,
  type ArchiveFocusSubscriber,
  type ArchiveMetadataLoader,
  type ArchivePollScheduler,
  type ArchiveSourceSnapshot,
} from './archive-source.js';
import { RunnerApiError } from './runner-api.js';

const metadata = (revision: string): ArchiveMetadataResponse => ({
  archiveRevision: revision,
  filter: {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
  },
  maxzoom: 16,
  minzoom: 8,
  sourceLayer: 'runs',
  tiles: [`/api/tiles/{z}/{x}/{y}.mvt?revision=${revision}`],
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function harness(loadMetadata: ArchiveMetadataLoader) {
  const snapshots: ArchiveSourceSnapshot[] = [];
  let poll: (() => void) | null = null;
  let focus: (() => void) | null = null;
  let scheduledInterval: number | null = null;
  const schedulePoll: ArchivePollScheduler = (callback, intervalMs) => {
    poll = callback;
    scheduledInterval = intervalMs;
    return vi.fn();
  };
  const subscribeFocus: ArchiveFocusSubscriber = (callback) => {
    focus = callback;
    return vi.fn();
  };
  const controller = new ArchiveSourceController({
    from: '2026-09-01T00:00:00.000Z',
    loadMetadata,
    now: () => 42,
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: '11111111-1111-4111-8111-111111111111',
    schedulePoll,
    subscribeFocus,
    to: '2026-10-01T00:00:00.000Z',
  });
  return {
    controller,
    focus: () => focus?.(),
    poll: () => poll?.(),
    scheduledInterval: () => scheduledInterval,
    snapshots,
  };
}

describe('ArchiveSourceController', () => {
  it('loads immediately and refreshes on the 30-second poll and focus boundary', async () => {
    const loadMetadata = vi.fn<ArchiveMetadataLoader>()
      .mockResolvedValueOnce(metadata('1'))
      .mockResolvedValueOnce(metadata('2'))
      .mockResolvedValueOnce(metadata('3'));
    const subject = harness(loadMetadata);

    subject.controller.start();
    await flush();
    expect(subject.scheduledInterval()).toBe(ARCHIVE_METADATA_POLL_INTERVAL_MS);
    expect(subject.snapshots.at(-1)).toMatchObject({
      checkedAt: 42,
      metadata: { archiveRevision: '1' },
      status: 'ready',
    });

    subject.poll();
    await flush();
    expect(subject.snapshots.at(-1)?.metadata?.archiveRevision).toBe('2');

    subject.focus();
    await flush();
    expect(subject.snapshots.at(-1)?.metadata?.archiveRevision).toBe('3');
    expect(loadMetadata).toHaveBeenCalledTimes(3);
  });

  it('retains the last valid source on transient metadata and tile failures', async () => {
    const loadMetadata = vi.fn<ArchiveMetadataLoader>()
      .mockResolvedValueOnce(metadata('8'))
      .mockRejectedValueOnce(new Error('network unavailable'));
    const subject = harness(loadMetadata);

    subject.controller.start();
    await flush();
    subject.poll();
    await flush();
    expect(subject.snapshots.at(-1)).toMatchObject({
      message: 'network unavailable',
      metadata: { archiveRevision: '8' },
      status: 'error',
    });

    subject.controller.handleTileError(503);
    expect(subject.snapshots.at(-1)).toMatchObject({
      metadata: { archiveRevision: '8' },
      status: 'error',
    });
  });

  it.each([401, 403])('clears all metadata after HTTP %s access loss', async (status) => {
    const loadMetadata = vi.fn<ArchiveMetadataLoader>()
      .mockResolvedValueOnce(metadata('9'))
      .mockRejectedValueOnce(new RunnerApiError('Denied', status, 'ORG_ACCESS_DENIED', null));
    const subject = harness(loadMetadata);

    subject.controller.start();
    await flush();
    subject.poll();
    await flush();
    expect(subject.snapshots.at(-1)).toMatchObject({
      metadata: null,
      status: 'access-denied',
    });
  });

  it('refreshes metadata after a stale-revision tile response', async () => {
    const loadMetadata = vi.fn<ArchiveMetadataLoader>()
      .mockResolvedValueOnce(metadata('10'))
      .mockResolvedValueOnce(metadata('11'));
    const subject = harness(loadMetadata);

    subject.controller.start();
    await flush();
    subject.controller.handleTileError(409);
    await flush();

    expect(loadMetadata).toHaveBeenCalledTimes(2);
    expect(subject.snapshots.at(-1)?.metadata?.archiveRevision).toBe('11');
  });

  it('coalesces a refresh requested during an in-flight metadata read', async () => {
    const first = deferred<ArchiveMetadataResponse>();
    const loadMetadata = vi.fn<ArchiveMetadataLoader>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(metadata('13'));
    const subject = harness(loadMetadata);

    subject.controller.start();
    subject.focus();
    expect(loadMetadata).toHaveBeenCalledTimes(1);
    first.resolve(metadata('12'));
    await flush();
    await flush();

    expect(loadMetadata).toHaveBeenCalledTimes(2);
    expect(subject.snapshots.at(-1)?.metadata?.archiveRevision).toBe('13');
  });

  it('aborts the active request and ignores its result after disposal', async () => {
    const request = deferred<ArchiveMetadataResponse>();
    const observed: { signal?: AbortSignal } = {};
    const loadMetadata: ArchiveMetadataLoader = (_input, signal) => {
      observed.signal = signal;
      return request.promise;
    };
    const subject = harness(loadMetadata);

    subject.controller.start();
    const countBeforeDispose = subject.snapshots.length;
    subject.controller.dispose();
    request.resolve(metadata('14'));
    await flush();

    expect(observed.signal?.aborted).toBe(true);
    expect(subject.snapshots).toHaveLength(countBeforeDispose);
  });
});
