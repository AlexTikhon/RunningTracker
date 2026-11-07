import type { WeeklyReview } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { RunnerApiError, type WeeklyReviewTarget } from './runner-api.js';
import { WeeklyInsightController, type InsightPanelSnapshot } from './weekly-insight-controller.js';
import { WeeklyReviewController, type ReviewReader, type ReviewSnapshot } from './weekly-review-controller.js';
import { reviewFixture } from './weekly-review-fixtures.js';

const WEEK = '2026-11-02';
const OTHER = '2026-10-26';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  reject: (error: unknown) => void;
  resolve: (review: WeeklyReview) => void;
  signal: AbortSignal;
  target: WeeklyReviewTarget;
}

/** A reader whose answers the test releases one by one, in any order. */
function deferredReader() {
  const calls: Call[] = [];
  const read: ReviewReader = (target, signal) =>
    new Promise<WeeklyReview>((resolve, reject) => {
      calls.push({ reject, resolve, signal, target });
    });
  return { calls, read };
}

function harness(read: ReviewReader, signal?: AbortSignal) {
  const snapshots: ReviewSnapshot[] = [];
  const controller = new WeeklyReviewController({
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    read,
    ...(signal ? { signal } : {}),
    timeZone: 'Europe/Warsaw',
    weekStart: WEEK,
  });
  return { controller, last: () => snapshots.at(-1) ?? controller.snapshot, snapshots };
}

const forWeek = (weekStart: string) => reviewFixture({ week: { ...reviewFixture().week, end: weekStart, start: weekStart } });

describe('weekly review controller', () => {
  it('reads the week with the zone, shows it, and does not poll', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    expect(controller.snapshot.load).toEqual({ kind: 'loading' });
    controller.start();
    expect(reader.calls[0]!.target).toEqual({ orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timeZone: 'Europe/Warsaw', weekStart: WEEK });
    reader.calls[0]!.resolve(reviewFixture());
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls).toHaveLength(1);
  });

  it('clears the previous week at once on a week change, and drops its late answer', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(reviewFixture());
    await flush();
    controller.select(OTHER);
    expect(last()).toEqual({ load: { kind: 'loading' }, weekStart: OTHER });
    controller.select(WEEK);
    expect(reader.calls[1]!.signal.aborted).toBe(true);
    reader.calls[1]!.resolve(forWeek(OTHER)); // late answer of an abandoned request
    await flush();
    expect(last()).toEqual({ load: { kind: 'loading' }, weekStart: WEEK });
    reader.calls[2]!.resolve(reviewFixture());
    await flush();
    expect(last()).toMatchObject({ load: { kind: 'ready' }, weekStart: WEEK });
  });

  it('keeps the shown review while refreshing, and the latest request wins', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(reviewFixture());
    await flush();
    controller.refresh();
    expect(last().load).toMatchObject({ kind: 'ready', refreshing: true });
    controller.refresh(); // a second save before the first refresh answered
    expect(reader.calls[1]!.signal.aborted).toBe(true);
    const newer = reviewFixture({ statements: [{ code: 'check_ins.none', text: 'No check-ins were recorded this week.' }] });
    reader.calls[2]!.resolve(newer);
    reader.calls[1]!.resolve(reviewFixture()); // the older answer arrives last and is ignored
    await flush();
    expect(last().load).toEqual({ kind: 'ready', refreshing: false, review: newer });
  });

  it('shows an error without the previous review, and recovers on retry', async () => {
    const reader = deferredReader();
    const { controller, last } = harness(reader.read);
    controller.start();
    reader.calls[0]!.resolve(reviewFixture());
    await flush();
    controller.refresh();
    reader.calls[1]!.reject(new RunnerApiError('The database is unavailable', 503, 'DATABASE_UNAVAILABLE', 'req-1'));
    await flush();
    expect(last().load).toEqual({ kind: 'error', message: 'The database is unavailable. Reference req-1.' });
    controller.refresh();
    expect(last().load).toEqual({ kind: 'loading' });
    reader.calls[2]!.resolve(reviewFixture());
    await flush();
    expect(last().load).toMatchObject({ kind: 'ready' });
  });

  it('says so when access is gone, and a network failure gets a plain message', async () => {
    const denied = harness(() => Promise.reject(new RunnerApiError('Forbidden', 403, 'ORG_ACCESS_DENIED', null)));
    denied.controller.start();
    await flush();
    expect(denied.last().load).toEqual({ kind: 'access-denied', message: 'You no longer have access to this organization.' });
    const offline = harness(() => Promise.reject(new TypeError('Failed to fetch')));
    offline.controller.start();
    await flush();
    expect(offline.last().load).toMatchObject({ kind: 'error', message: expect.stringMatching(/could not be loaded/u) as unknown });
  });

  it('goes silent when its session ends: the request is aborted and a late answer never shows', async () => {
    const reader = deferredReader();
    const session = new AbortController();
    const { controller, snapshots } = harness(reader.read, session.signal);
    controller.start();
    session.abort();
    expect(reader.calls[0]!.signal.aborted).toBe(true);
    reader.calls[0]!.resolve(reviewFixture());
    await flush();
    controller.refresh();
    controller.select(OTHER);
    expect(snapshots).toEqual([]);
    expect(reader.calls).toHaveLength(1);
  });

  it('a controller for a new scope starts empty, whatever the old one showed', async () => {
    const first = harness(() => Promise.resolve(reviewFixture()));
    first.controller.start();
    await flush();
    expect(first.last().load.kind).toBe('ready');
    first.controller.dispose();
    const second = harness(deferredReader().read);
    expect(second.controller.snapshot.load).toEqual({ kind: 'loading' });
  });

  it('stays usable while the AI insight of the same week fails', async () => {
    const review = harness(() => Promise.resolve(reviewFixture()));
    const insightSnapshots: InsightPanelSnapshot[] = [];
    const insight = new WeeklyInsightController({
      csrf: () => ({ headerName: 'x-csrf-token', token: 't' }),
      onChange: (snapshot) => insightSnapshots.push(snapshot),
      orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      read: () => Promise.reject(new RunnerApiError('Generation failed', 500, 'INTERNAL_ERROR', null)),
      request: () => Promise.reject(new RunnerApiError('Weekly insights are not enabled', 503, 'WEEKLY_INSIGHTS_DISABLED', null)),
      timeZone: 'Europe/Warsaw',
      weekStart: WEEK,
    });
    insight.start();
    review.controller.start();
    await flush();
    expect(insightSnapshots.at(-1)!.load.kind).toBe('error');
    expect(review.last().load.kind).toBe('ready');
    insight.dispose();
  });
});
