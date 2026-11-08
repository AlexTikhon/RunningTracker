import type { DailyOverview } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { DailyOverviewController, type OverviewReader, type OverviewSnapshot } from './daily-overview-controller.js';
import { overviewFixture } from './daily-overview-fixtures.js';
import { RunnerApiError, type DailyOverviewTarget } from './runner-api.js';

const DAY = '2026-11-05';
const OTHER = '2026-11-04';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  reject: (error: unknown) => void;
  resolve: (overview: DailyOverview) => void;
  signal: AbortSignal;
  target: DailyOverviewTarget;
}

/** A reader whose answers the test releases one by one, in any order. */
function deferredReader() {
  const calls: Call[] = [];
  const read: OverviewReader = (target, signal) =>
    new Promise<DailyOverview>((resolve, reject) => {
      calls.push({ reject, resolve, signal, target });
    });
  return { calls, read };
}

function harness(read: OverviewReader, signal?: AbortSignal) {
  const snapshots: OverviewSnapshot[] = [];
  const controller = new DailyOverviewController({
    localDate: DAY,
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: ORG,
    read,
    ...(signal ? { signal } : {}),
    timeZone: 'Europe/Warsaw',
  });
  return { controller, last: () => snapshots.at(-1) ?? controller.snapshot, snapshots };
}

const forDate = (localDate: string) => overviewFixture({ day: { ...overviewFixture().day, localDate } });
const withSteps = (steps: number) => overviewFixture({ movement: { activeEnergyKcal: null, recorded: true, source: 'manual', steps, timeZone: 'Europe/Warsaw' } });

describe('daily overview controller', () => {
  it('reads the date with the zone, shows it, and does not poll', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    expect(controller.snapshot).toEqual({ load: { kind: 'loading' }, localDate: DAY });
    controller.start();
    expect(reader.calls[0]!.target).toEqual({ localDate: DAY, orgId: ORG, timeZone: 'Europe/Warsaw' });
    reader.calls[0]!.resolve(overviewFixture());
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls).toHaveLength(1);
  });

  it('clears the previous date at once on a date change, aborts its request and drops its late answer', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(withSteps(8042));
    await flush();
    controller.select(OTHER);
    expect(last()).toEqual({ load: { kind: 'loading' }, localDate: OTHER });
    controller.select(DAY);
    expect(reader.calls[1]!.signal.aborted).toBe(true);
    reader.calls[1]!.resolve(forDate(OTHER)); // the late answer of an abandoned request
    await flush();
    expect(last()).toEqual({ load: { kind: 'loading' }, localDate: DAY });
    reader.calls[2]!.resolve(forDate(DAY));
    await flush();
    expect(last()).toMatchObject({ load: { kind: 'ready', overview: { day: { localDate: DAY } } }, localDate: DAY });
  });

  it('drops a late failure of an abandoned date instead of showing it for the new one', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    controller.select(OTHER);
    reader.calls[0]!.reject(new RunnerApiError('Boom', 500, 'INTERNAL', null));
    await flush();
    expect(last()).toEqual({ load: { kind: 'loading' }, localDate: OTHER });
    reader.calls[1]!.resolve(forDate(OTHER));
    await flush();
    expect(last()).toMatchObject({ load: { kind: 'ready' }, localDate: OTHER });
  });

  it('keeps the shown overview while refreshing, and the latest request wins', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(withSteps(1));
    await flush();
    controller.refresh();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: true });
    controller.refresh();
    expect(reader.calls[1]!.signal.aborted).toBe(true);
    reader.calls[2]!.resolve(withSteps(3));
    reader.calls[1]!.resolve(withSteps(2)); // older, after the newer one: ignored
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready', overview: { movement: { steps: 3 } }, refreshing: false });
  });

  it('shows an error without the previous answer, offers a retry, and maps 401/403 to access denied', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(withSteps(8042));
    await flush();
    controller.refresh();
    reader.calls[1]!.reject(new RunnerApiError('Database unavailable.', 503, 'DATABASE_UNAVAILABLE', 'req-1'));
    await flush();
    expect(last()).toEqual({ load: { kind: 'error', message: 'Database unavailable. Reference req-1.' }, localDate: DAY });
    controller.refresh();
    expect(last()).toEqual({ load: { kind: 'loading' }, localDate: DAY });
    reader.calls[2]!.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(last().load).toEqual({ kind: 'error', message: 'This day could not be loaded. Check your connection and try again.' });
    controller.refresh();
    reader.calls[3]!.reject(new RunnerApiError('No', 403, 'ORG_ACCESS_DENIED', null));
    await flush();
    expect(last().load).toEqual({ kind: 'access-denied', message: 'You no longer have access to this organization.' });
  });

  it('stops at once when the session ends: the request is aborted and its answer never shown', async () => {
    const session = new AbortController();
    const reader = deferredReader();
    const { controller, snapshots } = harness(reader.read, session.signal);
    controller.start();
    session.abort();
    expect(controller.disposed).toBe(true);
    expect(reader.calls[0]!.signal.aborted).toBe(true);
    reader.calls[0]!.resolve(withSteps(8042));
    await flush();
    expect(snapshots).toEqual([]);
    controller.start();
    controller.select(OTHER);
    controller.refresh();
    expect(reader.calls).toHaveLength(1);
  });

  it('never starts under a session that has already ended', () => {
    const session = new AbortController();
    session.abort();
    const reader = deferredReader();
    const { controller } = harness(reader.read, session.signal);
    controller.start();
    expect(reader.calls).toHaveLength(0);
  });

  it('stays silent after dispose (a change of organization or person disposes the screen)', async () => {
    const reader = deferredReader();
    const { controller, snapshots } = harness(reader.read);
    controller.start();
    controller.dispose();
    reader.calls[0]!.resolve(withSteps(8042));
    await flush();
    expect(snapshots).toEqual([]);
  });
});
