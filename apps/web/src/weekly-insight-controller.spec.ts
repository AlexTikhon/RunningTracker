import type { WeeklyInsightView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { RunnerApiError } from './runner-api.js';
import {
  canGenerate,
  POLL_LIMIT,
  WeeklyInsightController,
  type InsightPanelSnapshot,
  type InsightReader,
  type InsightRequester,
  type InsightTimers,
} from './weekly-insight-controller.js';
import { insightView } from './weekly-insight-fixtures.js';

const WEEK = '2026-11-02';
const csrf = { headerName: 'x-csrf-token' as const, token: 't' };

/** Manual timers: nothing runs until the test fires it. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  let next = 1;
  const timers: InsightTimers = {
    clearTimeout: (handle) => {
      pending.delete(handle as unknown as number);
    },
    setTimeout: (callback, delayMs) => {
      const id = next++;
      pending.set(id, { callback, delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
  };
  const fire = () => {
    const [id, entry] = [...pending.entries()][0] ?? [];
    if (id === undefined || !entry) throw new Error('no timer pending');
    pending.delete(id);
    entry.callback();
  };
  return { fire, pending, timers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { read: InsightReader; request?: InsightRequester; signal?: AbortSignal }) {
  const snapshots: InsightPanelSnapshot[] = [];
  const clock = manualTimers();
  const controller = new WeeklyInsightController({
    csrf: () => csrf,
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    read: options.read,
    request: options.request ?? (() => Promise.resolve({ id: insightView().id, status: 'queued' })),
    ...(options.signal ? { signal: options.signal } : {}),
    timeZone: 'Europe/Warsaw',
    timers: clock.timers,
    weekStart: WEEK,
  });
  const last = () => snapshots.at(-1)!;
  return { clock, controller, last, snapshots };
}

describe('weekly insight controller (ADR-0076)', () => {
  it('shows the no-insight state for a 404 and offers Generate', async () => {
    const { controller, last } = harness({ read: () => Promise.resolve(null) });
    controller.start();
    await flush();
    expect(last().load).toEqual({ kind: 'none' });
    expect(canGenerate(last())).toBe(true);
  });

  it('polls while queued or running and stops when the insight is ready', async () => {
    const answers = [insightView({ status: 'queued' }), insightView({ status: 'running' }), insightView({ status: 'ready', output: null, freshness: 'outdated_policy' })];
    const { clock, controller, last } = harness({ read: () => Promise.resolve(answers.shift()!) });
    controller.start();
    await flush();
    expect(clock.pending.size).toBe(1);
    clock.fire();
    await flush();
    expect(last().load).toMatchObject({ view: { status: 'running' } });
    clock.fire();
    await flush();
    expect(last().load).toMatchObject({ view: { status: 'ready' } });
    expect(clock.pending.size).toBe(0);
  });

  it('bounds polling: after POLL_LIMIT reads it stops and says so, and checking again starts a new bounded round', async () => {
    let reads = 0;
    const { clock, controller, last } = harness({
      read: () => {
        reads += 1;
        return Promise.resolve(insightView({ status: 'running' }));
      },
    });
    controller.start();
    await flush();
    for (let index = 0; index < POLL_LIMIT; index += 1) {
      clock.fire();
      await flush();
    }
    expect(reads).toBe(POLL_LIMIT + 1);
    expect(last().pollingExhausted).toBe(true);
    expect(clock.pending.size).toBe(0);
    controller.refresh();
    await flush();
    expect(last().pollingExhausted).toBe(false);
    expect(clock.pending.size).toBe(1);
  });

  it('stops polling and silences late answers when the session ends or the panel is disposed', async () => {
    const session = new AbortController();
    let release!: (view: WeeklyInsightView) => void;
    let calls = 0;
    const { clock, controller, snapshots } = harness({
      read: (_target, signal) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(insightView({ status: 'running' }));
        return new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
      signal: session.signal,
    });
    controller.start();
    await flush();
    clock.fire();
    await flush();
    const before = snapshots.length;
    session.abort();
    release(insightView({ status: 'ready', freshness: 'outdated_policy' }));
    await flush();
    expect(snapshots.length).toBe(before);
    expect(clock.pending.size).toBe(0);
  });

  it('a week change drops the previous week\'s polling and answers', async () => {
    const { clock, controller, last } = harness({
      read: (target) => Promise.resolve(target.weekStart === WEEK ? insightView({ status: 'running' }) : null),
    });
    controller.start();
    await flush();
    expect(clock.pending.size).toBe(1);
    controller.select('2026-10-26');
    expect(clock.pending.size).toBe(0);
    await flush();
    expect(last()).toMatchObject({ load: { kind: 'none' }, weekStart: '2026-10-26' });
  });

  it('generates: sends the request, then reads and polls the new job', async () => {
    const reads: string[] = [];
    let state: WeeklyInsightView | null = null;
    const { clock, controller, last } = harness({
      read: () => {
        reads.push('read');
        return Promise.resolve(state);
      },
      request: () => {
        state = insightView({ status: 'queued' });
        return Promise.resolve({ id: state.id, status: 'queued' });
      },
    });
    controller.start();
    await flush();
    controller.generate();
    expect(last().request).toBe('pending');
    await flush();
    await flush();
    expect(last()).toMatchObject({ load: { view: { status: 'queued' } }, request: 'idle' });
    expect(clock.pending.size).toBe(1);
    expect(reads).toHaveLength(2);
  });

  it('reports busy, the retry limit and a disabled server without changing the shown insight', async () => {
    const failing = (code: string, status: number) => () => Promise.reject(new RunnerApiError('refused', status, code, 'r1'));
    for (const [code, status, expected] of [
      ['WEEKLY_INSIGHTS_BUSY', 503, /busy right now/u],
      ['WEEKLY_INSIGHT_RETRY_LIMIT', 409, /too many times/u],
    ] as const) {
      const { controller, last } = harness({ read: () => Promise.resolve(null), request: failing(code, status) });
      controller.start();
      await flush();
      controller.generate();
      await flush();
      expect(last().request).toBe('failed');
      expect(last().requestMessage).toMatch(expected);
      expect(last().load).toEqual({ kind: 'none' });
    }
    const { controller, last } = harness({ read: () => Promise.resolve(null), request: failing('WEEKLY_INSIGHTS_DISABLED', 503) });
    controller.start();
    await flush();
    controller.generate();
    await flush();
    expect(last().generationDisabled).toBe(true);
    expect(canGenerate(last())).toBe(false);
  });

  it('offers Regenerate only when the server says a new request would generate', () => {
    const base = { generationDisabled: false, pollingExhausted: false, request: 'idle' as const, requestMessage: null, weekStart: WEEK };
    const offered = (view: WeeklyInsightView) => canGenerate({ ...base, load: { kind: 'view', view } });
    expect(offered(insightView({ status: 'running', retryable: true }))).toBe(false);
    expect(offered(insightView({ status: 'interrupted', retryable: true }))).toBe(true);
    expect(offered(insightView({ status: 'failed_grounding', retryable: false }))).toBe(false);
    expect(offered(insightView({ freshness: 'stale', retryable: true, status: 'failed_safety' }))).toBe(true);
  });

  it('shows access loss and errors, and retries a failed load', async () => {
    let fail = true;
    const { controller, last } = harness({
      read: () => (fail ? Promise.reject(new RunnerApiError('nope', 403, 'ORG_ACCESS_DENIED', null)) : Promise.resolve(null)),
    });
    controller.start();
    await flush();
    expect(last().load.kind).toBe('access-denied');
    fail = false;
    controller.refresh();
    await flush();
    expect(last().load.kind).toBe('none');
  });
});
