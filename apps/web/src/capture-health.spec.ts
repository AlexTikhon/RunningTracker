import { describe, expect, it } from 'vitest';

import type { CaptureState } from './capture-controller.js';
import { CAPTURE_STALE_AFTER_MS, captureHealth } from './capture-health.js';

// What the page says about capture, from the controller state and the page's monotonic clock. The freshness bound is
// a display rule only; it is not the server's edge-validity gap and it never creates a point.

const facts = { capturedCount: 0, lastPersistedAtMs: null, lastRecordedAt: null };

function capturing(overrides: Partial<Extract<CaptureState, { signal: unknown }>> = {}): CaptureState {
  return {
    ...facts,
    consecutiveFailures: 0,
    segmentId: 0,
    signal: 'no-fix',
    source: 'Device GPS',
    startedAtMs: 10_000,
    status: 'capturing',
    warning: null,
    ...overrides,
  };
}

describe('captureHealth', () => {
  it('a watch that has just started has no fix yet and is not called healthy', () => {
    expect(captureHealth(capturing(), 13_000)).toEqual({
      detail: 'Waiting 3 s for the first location.',
      headline: 'No fix yet',
      retry: false,
      stale: false,
      tone: 'waiting',
    });
  });

  it('offers a retry when no first fix arrived within the freshness bound', () => {
    const health = captureHealth(capturing(), 10_000 + CAPTURE_STALE_AFTER_MS);
    expect(health).toMatchObject({ headline: 'No fix yet', retry: true, tone: 'waiting' });
  });

  it('a recent persisted fix is live, with its age', () => {
    const state = capturing({ capturedCount: 4, lastPersistedAtMs: 20_000, signal: 'live' });
    expect(captureHealth(state, 24_400)).toEqual({
      detail: 'Last point saved 4 s ago.',
      headline: 'Capturing',
      retry: false,
      stale: false,
      tone: 'ok',
    });
  });

  it('a live watch that went silent past the bound is marked stale and offers a retry', () => {
    const state = capturing({ capturedCount: 4, lastPersistedAtMs: 20_000, signal: 'live' });
    expect(captureHealth(state, 20_000 + 125_000)).toEqual({
      detail: 'Last point saved 2 min 5 s ago (stale).',
      headline: 'No recent location',
      retry: true,
      stale: true,
      tone: 'waiting',
    });
  });

  it('a temporary failure keeps the last facts, marks them stale and says the watch keeps trying', () => {
    const state = capturing({
      capturedCount: 4,
      consecutiveFailures: 2,
      lastPersistedAtMs: 20_000,
      signal: 'waiting',
      warning: 'The location provider timed out while waiting for a fresh measurement.',
    });
    expect(captureHealth(state, 22_000)).toEqual({
      detail: 'The location provider timed out while waiting for a fresh measurement. 2 attempts without a fix; '
        + 'still listening. Last point saved 2 s ago (stale).',
      headline: 'Waiting for location',
      retry: true,
      stale: true,
      tone: 'waiting',
    });
  });

  it('a temporary failure before any fix says so', () => {
    const state = capturing({ consecutiveFailures: 1, signal: 'waiting', warning: 'No location.' });
    expect(captureHealth(state, 12_000)).toMatchObject({
      detail: 'No location. 1 attempt without a fix; still listening. No point saved yet.',
      headline: 'Waiting for location',
    });
  });

  it('a permission denial is blocked with guidance and a retry', () => {
    const state: CaptureState = { ...facts, message: 'Location permission was denied.', reason: 'permission-denied', source: 'Device GPS', status: 'error' };
    const health = captureHealth(state, 0);
    expect(health).toMatchObject({ headline: 'Location permission blocked', retry: true, tone: 'blocked' });
    expect(health.detail).toContain('Allow location for this site in the browser settings, then choose Retry GPS.');
  });

  it.each(['storage', 'overflow', 'unsupported', 'source'] as const)('a %s failure stops capture without a GPS retry', (reason) => {
    const state: CaptureState = { ...facts, capturedCount: 2, lastPersistedAtMs: 5_000, message: 'Broken.', reason, source: 'Device GPS', status: 'error' };
    expect(captureHealth(state, 9_000)).toEqual({
      detail: 'Broken. Last point saved 4 s ago (stale).',
      headline: 'Capture stopped',
      retry: false,
      stale: true,
      tone: 'blocked',
    });
  });

  it('a lost writer stops capture without a GPS retry', () => {
    const state: CaptureState = { ...facts, message: 'No lease.', source: 'Device GPS', status: 'lost' };
    expect(captureHealth(state, 0)).toMatchObject({ headline: 'Capture stopped', retry: false, tone: 'blocked' });
  });

  it('idle and starting are neither healthy nor retryable', () => {
    expect(captureHealth({ status: 'idle' }, 0)).toMatchObject({ headline: 'Not capturing', retry: false, tone: 'idle' });
    expect(captureHealth({ ...facts, source: 'Device GPS', status: 'starting' }, 0))
      .toMatchObject({ headline: 'Starting capture', retry: false, tone: 'waiting' });
  });
});
