import type { ActivityTrends } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  ActivityTrendsController,
  type ActivityTrendsFilters,
  type ActivityTrendsReader,
  type ActivityTrendsSnapshot,
} from './activity-trends-controller.js';
import { activityTrendsFixture } from './activity-trends-fixtures.js';
import { RunnerApiError, type ActivityTrendsTarget } from './runner-api.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ZONE = 'UTC';
const FILTERS: ActivityTrendsFilters = { endDate: '2026-11-12', source: 'manual', type: 'ride' };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  reject: (error: unknown) => void;
  resolve: (trends: ActivityTrends) => void;
  signal: AbortSignal;
  target: ActivityTrendsTarget;
}

function deferredReader() {
  const calls: Call[] = [];
  const read: ActivityTrendsReader = (target, signal) =>
    new Promise<ActivityTrends>((resolve, reject) => {
      calls.push({ reject, resolve, signal, target });
    });
  return { calls, read };
}

function harness(read: ActivityTrendsReader, signal?: AbortSignal, filters: ActivityTrendsFilters = FILTERS) {
  const snapshots: ActivityTrendsSnapshot[] = [];
  const controller = new ActivityTrendsController({ filters, onChange: (snapshot) => snapshots.push(snapshot), orgId: ORG, read, ...(signal ? { signal } : {}), timeZone: ZONE });
  return { controller, last: () => snapshots.at(-1) ?? controller.snapshot, snapshots };
}

const answer = (filters: ActivityTrendsFilters, count = 1) =>
  activityTrendsFixture({ days: { [filters.endDate]: { count } }, endDate: filters.endDate, source: filters.source, today: '2026-11-12', type: filters.type });

describe('activity trends controller', () => {
  it('reads one source and type with the zone, shows the answer and does not poll', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    expect(reader.calls[0]!.target).toEqual({ ...FILTERS, orgId: ORG, timeZone: ZONE });
    reader.calls[0]!.resolve(answer(FILTERS));
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.calls).toHaveLength(1);
  });

  it('clears the answer on a source, type or end-date change, aborts the old request and drops its late answer', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(answer(FILTERS));
    await flush();
    for (const next of [
      { ...FILTERS, type: 'walk' as const },
      { ...FILTERS, source: 'gpx' as const, type: 'walk' as const },
      { ...FILTERS, endDate: '2026-11-01', source: 'gpx' as const, type: 'walk' as const },
    ]) {
      const previous = reader.calls.at(-1)!;
      controller.select(next);
      expect(last()).toEqual({ filters: next, load: { kind: 'loading' } });
      expect(reader.calls.at(-1)!.target).toMatchObject(next);
      expect(previous.signal.aborted || reader.calls.length === 2).toBe(true);
    }
    // The second request (type walk) answers late, after two newer selections: it is never shown.
    reader.calls[1]!.resolve(answer({ ...FILTERS, type: 'walk' }));
    reader.calls[2]!.reject(new RunnerApiError('Late failure', 503, 'UNAVAILABLE', null));
    await flush();
    expect(last().load).toEqual({ kind: 'loading' });
    expect(reader.calls[1]!.signal.aborted).toBe(true);
    reader.calls[3]!.resolve(answer({ endDate: '2026-11-01', source: 'gpx', type: 'walk' }));
    await flush();
    expect(last()).toMatchObject({ filters: { endDate: '2026-11-01', source: 'gpx', type: 'walk' }, load: { kind: 'ready' } });
  });

  it('moves the type to run when recorded runs are chosen, and ignores a selection of the same filters', () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    controller.select({ ...FILTERS, source: 'recorded_run' });
    expect(last().filters).toEqual({ endDate: FILTERS.endDate, source: 'recorded_run', type: 'run' });
    expect(reader.calls.at(-1)!.target.type).toBe('run');
    const calls = reader.calls.length;
    controller.select({ ...FILTERS, source: 'recorded_run', type: 'ride' });
    expect(reader.calls).toHaveLength(calls);
  });

  it('keeps an error without any previous answer and retries on refresh', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.reject(new RunnerApiError('Database unavailable.', 500, 'INTERNAL', 'rid-1'));
    await flush();
    expect(last().load).toEqual({ kind: 'error', message: 'Database unavailable. Reference rid-1.' });
    controller.refresh();
    expect(last().load).toEqual({ kind: 'loading' });
    reader.calls[1]!.resolve(answer(FILTERS));
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready' });
    // A refresh of a shown answer keeps it while the newer read is in flight.
    controller.refresh();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: true });
    reader.calls[2]!.reject(new TypeError('offline'));
    await flush();
    expect(last().load).toEqual({ kind: 'error', message: 'These activity trends could not be loaded. Check your connection and try again.' });
  });

  it('reports lost access, and refuses an answer for other filters from a reader that does not check', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.reject(new RunnerApiError('Denied', 403, 'ORG_ACCESS_DENIED', null));
    await flush();
    expect(last().load).toEqual({ kind: 'access-denied', message: 'You no longer have access to this organization.' });
    controller.refresh();
    reader.calls[1]!.resolve(answer({ ...FILTERS, type: 'swim' }));
    await flush();
    expect(last().load).toMatchObject({ kind: 'error' });
  });

  it('is silenced by disposal or the end of its session, aborting its request', async () => {
    for (const end of ['dispose', 'session'] as const) {
      const reader = deferredReader();
      const session = new AbortController();
      const { controller, snapshots } = harness(reader.read, session.signal);
      controller.start();
      const before = snapshots.length;
      if (end === 'dispose') controller.dispose();
      else session.abort();
      expect(controller.disposed).toBe(true);
      expect(reader.calls[0]!.signal.aborted).toBe(true);
      reader.calls[0]!.resolve(answer(FILTERS));
      await flush();
      controller.select({ ...FILTERS, type: 'walk' });
      controller.refresh();
      expect(snapshots).toHaveLength(before);
      expect(reader.calls).toHaveLength(1);
    }
    const ended = new AbortController();
    ended.abort();
    const reader = deferredReader();
    const { controller } = harness(reader.read, ended.signal);
    controller.start();
    expect(reader.calls).toHaveLength(0);
  });
});
