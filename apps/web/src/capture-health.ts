import { captureFailureMayRetry, type CaptureState } from './capture-controller.js';

// How long the page calls the last saved point fresh, and how long it waits for a first fix before it offers Retry
// GPS. A display rule on the page's monotonic clock only: it is not the server's edge gap or speed rule, it changes
// no measurement, and nothing is ever persisted to keep a point "fresh".
export const CAPTURE_STALE_AFTER_MS = 15_000;

export interface CaptureHealth {
  detail: string;
  headline: string;
  // Whether an explicit Retry GPS can help: a blocked permission, a receiver failure, or a watch without a recent fix.
  retry: boolean;
  // Whether the last saved point is older than the freshness bound or comes from before a failure.
  stale: boolean;
  tone: 'blocked' | 'idle' | 'ok' | 'waiting';
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function lastPoint(lastPersistedAtMs: number | null, nowMs: number, stale: boolean): string {
  if (lastPersistedAtMs === null) return 'No point saved yet.';
  return `Last point saved ${duration(nowMs - lastPersistedAtMs)} ago${stale ? ' (stale)' : ''}.`;
}

export function captureHealth(capture: CaptureState, nowMs: number): CaptureHealth {
  switch (capture.status) {
    case 'idle':
      return { detail: 'Capture runs while the run is recording.', headline: 'Not capturing', retry: false, stale: false, tone: 'idle' };
    case 'starting':
      return {
        detail: lastPoint(capture.lastPersistedAtMs, nowMs, capture.lastPersistedAtMs !== null),
        headline: 'Starting capture',
        retry: false,
        stale: capture.lastPersistedAtMs !== null,
        tone: 'waiting',
      };
    case 'error': {
      const stale = capture.lastPersistedAtMs !== null;
      if (capture.reason === 'permission-denied') {
        return {
          detail: `${capture.message} Allow location for this site in the browser settings, then choose Retry GPS. `
            + `Buffered points are kept. ${lastPoint(capture.lastPersistedAtMs, nowMs, stale)}`,
          headline: 'Location permission blocked',
          retry: true,
          stale,
          tone: 'blocked',
        };
      }
      return {
        detail: `${capture.message} ${lastPoint(capture.lastPersistedAtMs, nowMs, stale)}`,
        headline: 'Capture stopped',
        retry: captureFailureMayRetry(capture.reason),
        stale,
        tone: 'blocked',
      };
    }
    case 'lost': {
      const stale = capture.lastPersistedAtMs !== null;
      return {
        detail: `${capture.message} ${lastPoint(capture.lastPersistedAtMs, nowMs, stale)}`,
        headline: 'Capture stopped',
        retry: false,
        stale,
        tone: 'blocked',
      };
    }
    case 'complete':
      return {
        detail: lastPoint(capture.lastPersistedAtMs, nowMs, false),
        headline: 'Capture complete',
        retry: false,
        stale: false,
        tone: 'ok',
      };
    case 'capturing': {
      if (capture.signal === 'waiting') {
        const attempts = `${capture.consecutiveFailures} attempt${capture.consecutiveFailures === 1 ? '' : 's'}`;
        return {
          detail: `${capture.warning ?? 'No location.'} ${attempts} without a fix; still listening. `
            + lastPoint(capture.lastPersistedAtMs, nowMs, true),
          headline: 'Waiting for location',
          retry: true,
          stale: capture.lastPersistedAtMs !== null,
          tone: 'waiting',
        };
      }
      if (capture.signal === 'no-fix') {
        const waited = nowMs - capture.startedAtMs;
        const stale = capture.lastPersistedAtMs !== null;
        return {
          detail: stale
            ? `Waiting ${duration(waited)} for a location from the restarted watch. ${lastPoint(capture.lastPersistedAtMs, nowMs, true)}`
            : `Waiting ${duration(waited)} for the first location.`,
          headline: 'No fix yet',
          retry: waited >= CAPTURE_STALE_AFTER_MS,
          stale,
          tone: 'waiting',
        };
      }
      const age = capture.lastPersistedAtMs === null ? 0 : nowMs - capture.lastPersistedAtMs;
      const stale = age >= CAPTURE_STALE_AFTER_MS;
      return {
        detail: lastPoint(capture.lastPersistedAtMs, nowMs, stale),
        headline: stale ? 'No recent location' : 'Capturing',
        retry: stale,
        stale,
        tone: stale ? 'waiting' : 'ok',
      };
    }
  }
}
