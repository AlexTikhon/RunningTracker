import type { DailyTrends } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { DailyTrendsController, type TrendsReader, type TrendsSnapshot } from './daily-trends-controller.js';
import { trendsFixture } from './daily-trends-fixtures.js';
import { RunnerApiError, type DailyTrendsTarget } from './runner-api.js';

const END = '2026-11-09';
const OTHER = '2026-10-31';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  reject: (error: unknown) => void;
  resolve: (trends: DailyTrends) => void;
  signal: AbortSignal;
  target: DailyTrendsTarget;
}

/** A reader whose answers the test releases one by one, in any order. */
function deferredReader() {
  const calls: Call[] = [];
  const read: TrendsReader = (target, signal) =>
    new Promise<DailyTrends>((resolve, reject) => {
      calls.push({ reject, resolve, signal, target });
    });
  return { calls, read };
}

function harness(read: TrendsReader, signal?: AbortSignal) {
  const snapshots: TrendsSnapshot[] = [];
  const controller = new DailyTrendsController({
    endDate: END,
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: ORG,
    read,
    ...(signal ? { signal } : {}),
    timeZone: 'Europe/Warsaw',
  });
  return { controller, last: () => snapshots.at(-1) ?? controller.snapshot, snapshots };
}

const withSteps = (steps: number, endDate: string = END) => trendsFixture(endDate, { [endDate]: { steps } }, END);

describe('daily trends controller', () => {
  it('reads the range with the zone, shows it, and does not poll', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    expect(controller.snapshot).toEqual({ endDate: END, load: { kind: 'loading' } });
    controller.start();
    expect(reader.calls[0]!.target).toEqual({ endDate: END, orgId: ORG, timeZone: 'Europe/Warsaw' });
    reader.calls[0]!.resolve(trendsFixture(END));
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls).toHaveLength(1);
  });

  it('clears the previous range at once on an end-date change, aborts its request and drops its late answer', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(withSteps(8042));
    await flush();
    controller.select(OTHER);
    expect(last()).toEqual({ endDate: OTHER, load: { kind: 'loading' } });
    controller.select(END);
    expect(reader.calls[1]!.signal.aborted).toBe(true);
    reader.calls[1]!.resolve(withSteps(1, OTHER)); // the late answer of an abandoned request
    await flush();
    expect(last()).toEqual({ endDate: END, load: { kind: 'loading' } });
    reader.calls[2]!.resolve(withSteps(2));
    await flush();
    expect(last()).toMatchObject({ endDate: END, load: { kind: 'ready', trends: { range: { endDate: END } } } });
  });

  it('drops a late failure of an abandoned range instead of showing it for the new one', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    controller.select(OTHER);
    reader.calls[0]!.reject(new RunnerApiError('Boom', 500, 'INTERNAL', null));
    await flush();
    expect(last()).toEqual({ endDate: OTHER, load: { kind: 'loading' } });
    reader.calls[1]!.resolve(withSteps(1, OTHER));
    await flush();
    expect(last()).toMatchObject({ endDate: OTHER, load: { kind: 'ready' } });
  });

  it('keeps the shown range while refreshing, and the latest request wins', async () => {
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
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: false, trends: { summary: { steps: { recordedTotal: 3 } } } });
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
    expect(last()).toEqual({ endDate: END, load: { kind: 'error', message: 'Database unavailable. Reference req-1.' } });
    controller.refresh();
    expect(last()).toEqual({ endDate: END, load: { kind: 'loading' } });
    reader.calls[2]!.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(last().load).toEqual({ kind: 'error', message: 'These dates could not be loaded. Check your connection and try again.' });
    controller.refresh();
    reader.calls[3]!.reject(new RunnerApiError('No', 401, 'SESSION_REQUIRED', null));
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

  it('never starts under a session that has already ended, and stays silent after dispose', async () => {
    const ended = new AbortController();
    ended.abort();
    const first = deferredReader();
    harness(first.read, ended.signal).controller.start();
    expect(first.calls).toHaveLength(0);

    const reader = deferredReader();
    const { controller, snapshots } = harness(reader.read);
    controller.start();
    controller.dispose();
    reader.calls[0]!.resolve(withSteps(8042));
    await flush();
    expect(snapshots).toEqual([]);
  });
});
