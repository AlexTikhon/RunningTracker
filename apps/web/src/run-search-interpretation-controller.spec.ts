import type { RunSearchInterpretationResponse, RunSearchProposedFilters } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { RunnerApiError } from './runner-api.js';
import {
  RunSearchInterpretationController,
  type InterpretationLoader,
  type InterpretationSnapshot,
} from './run-search-interpretation-controller.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const ZONE = 'Europe/Warsaw';

const filters: RunSearchProposedFilters = {
  distanceUnit: 'km',
  maxDistance: null,
  minDistance: '5',
  period: { kind: 'preset', preset: 'previous-month' },
  sort: 'longest',
  timeZone: ZONE,
};
const searchAnswer: RunSearchInterpretationResponse = { filters, outcome: 'search' };

interface Deferred {
  reject(error: unknown): void;
  resolve(value: RunSearchInterpretationResponse): void;
  signal: AbortSignal;
  text: string;
}

function setup(overrides: { load?: InterpretationLoader; timeZone?: string } = {}) {
  const snapshots: InterpretationSnapshot[] = [];
  const proposals: RunSearchProposedFilters[] = [];
  const pending: Deferred[] = [];
  const load: InterpretationLoader =
    overrides.load ??
    ((input, signal) =>
      new Promise<RunSearchInterpretationResponse>((resolve, reject) => {
        pending.push({ reject, resolve, signal, text: input.text });
      }));
  const controller = new RunSearchInterpretationController({
    load,
    onChange: (snapshot) => snapshots.push(snapshot),
    onProposal: (proposal) => proposals.push(proposal),
    orgId: ORG,
    timeZone: overrides.timeZone ?? ZONE,
  });
  const latest = () => snapshots.at(-1)!;
  return { controller, latest, pending, proposals, snapshots };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function apiError(status: number, code: string, retryAfterMs: number | null = null): RunnerApiError {
  return new RunnerApiError('Message from the server.', status, code, 'request-1', retryAfterMs);
}

describe('RunSearchInterpretationController', () => {
  it('starts idle and does nothing until submitted', () => {
    const { controller, pending } = setup();
    expect(controller.snapshot).toEqual({ status: 'idle' });
    expect(pending).toHaveLength(0);
  });

  it('makes one request per submission and proposes the filters when they arrive', async () => {
    const { controller, latest, pending, proposals } = setup();
    controller.submit('runs of at least 5 km last month');
    expect(latest()).toEqual({ status: 'interpreting' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe('runs of at least 5 km last month');

    pending[0]!.resolve(searchAnswer);
    await flush();

    expect(proposals).toEqual([filters]);
    expect(latest()).toEqual({ status: 'proposal' });
    expect(pending).toHaveLength(1);
  });

  it('ignores a second submission while one is running, so one click is one dispatch', () => {
    const { controller, pending } = setup();
    controller.submit('first');
    controller.submit('second');
    expect(pending).toHaveLength(1);
  });

  it('shows a clarification and an unsupported reason without proposing anything', async () => {
    const first = setup();
    first.controller.submit('more than 5 km');
    first.pending[0]!.resolve({ outcome: 'clarify', reason: 'distance_boundary_strict' });
    await flush();
    expect(first.latest()).toEqual({ reason: 'distance_boundary_strict', status: 'clarify' });
    expect(first.proposals).toHaveLength(0);

    const second = setup();
    second.controller.submit('runs in Berlin');
    second.pending[0]!.resolve({ outcome: 'unsupported', reason: 'location' });
    await flush();
    expect(second.latest()).toEqual({ reason: 'location', status: 'unsupported' });
    expect(second.proposals).toHaveLength(0);
  });

  it.each([
    ['a disabled server', apiError(503, 'INTERPRETATION_DISABLED'), { kind: 'disabled', status: 'unavailable' }],
    ['a rate limit', apiError(429, 'INTERPRETATION_RATE_LIMITED', 30_000), { kind: 'rate_limited', retryAfterMs: 30_000, status: 'error' }],
    ['an interpretation still running', apiError(429, 'INTERPRETATION_IN_PROGRESS'), { kind: 'in_progress', retryAfterMs: null, status: 'error' }],
    ['a busy interpreter', apiError(503, 'INTERPRETATION_BUSY'), { kind: 'busy', retryAfterMs: null, status: 'error' }],
    ['a used up allowance', apiError(503, 'INTERPRETATION_BUDGET_EXHAUSTED', 600_000), { kind: 'busy', retryAfterMs: 600_000, status: 'error' }],
    ['a timeout', apiError(504, 'INTERPRETATION_TIMEOUT'), { kind: 'timeout', retryAfterMs: null, status: 'error' }],
    ['a provider failure', apiError(502, 'INTERPRETATION_FAILED'), { kind: 'failed', retryAfterMs: null, status: 'error' }],
    ['lost access', apiError(403, 'ORG_ACCESS_DENIED'), { kind: 'access', retryAfterMs: null, status: 'error' }],
    ['a refused origin', apiError(403, 'ORIGIN_DENIED'), { kind: 'access', retryAfterMs: null, status: 'error' }],
    ['a broken connection', new TypeError('Failed to fetch'), { kind: 'network', retryAfterMs: null, status: 'error' }],
    ['an unexpected status', apiError(500, 'INTERNAL_ERROR'), { kind: 'failed', retryAfterMs: null, status: 'error' }],
  ])('maps %s to a state the form can word', async (_name, error, expected) => {
    const { controller, latest, pending, proposals } = setup();
    controller.submit('runs last month');
    pending[0]!.reject(error);
    await flush();
    expect(latest()).toEqual(expected);
    expect(proposals).toHaveLength(0);
  });

  it('goes quiet on a 401: the application\'s own session recovery takes over', async () => {
    const { controller, latest, pending } = setup();
    controller.submit('runs last month');
    pending[0]!.reject(apiError(401, 'AUTH_REQUIRED'));
    await flush();
    expect(latest()).toEqual({ status: 'idle' });
  });

  it('never retries by itself after a failure', async () => {
    const { controller, pending } = setup();
    controller.submit('runs last month');
    pending[0]!.reject(apiError(502, 'INTERPRETATION_FAILED'));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pending).toHaveLength(1);
  });

  it('can be submitted again by the person after a failure, as a new request', async () => {
    const { controller, pending } = setup();
    controller.submit('runs last month');
    pending[0]!.reject(apiError(502, 'INTERPRETATION_FAILED'));
    await flush();
    controller.submit('runs last month');
    expect(pending).toHaveLength(2);
  });

  it('remembers that the server has no interpreter and spends no more requests', async () => {
    const { controller, latest, pending } = setup();
    controller.submit('runs last month');
    pending[0]!.reject(apiError(503, 'INTERPRETATION_DISABLED'));
    await flush();
    controller.submit('runs last month');
    expect(pending).toHaveLength(1);
    expect(latest()).toMatchObject({ status: 'unavailable' });
  });

  describe('stale completions', () => {
    it('drops the answer of an invalidated request even when the transport ignored the abort', async () => {
      const { controller, latest, pending, proposals } = setup();
      controller.submit('runs last month');
      controller.invalidate();
      expect(pending[0]!.signal.aborted).toBe(true);
      expect(latest()).toEqual({ status: 'idle' });

      pending[0]!.resolve(searchAnswer);
      await flush();

      expect(proposals).toHaveLength(0);
      expect(latest()).toEqual({ status: 'idle' });
    });

    it('drops a late failure of an invalidated request too', async () => {
      const { controller, latest, pending } = setup();
      controller.submit('runs last month');
      controller.invalidate();
      pending[0]!.reject(apiError(502, 'INTERPRETATION_FAILED'));
      await flush();
      expect(latest()).toEqual({ status: 'idle' });
    });

    it('lets only the newest interpretation win, whatever order the answers come back in', async () => {
      const { controller, latest, pending, proposals } = setup();
      controller.submit('first');
      controller.invalidate();
      controller.submit('second');

      const newer: RunSearchProposedFilters = { ...filters, minDistance: '10', sort: 'newest' };
      pending[1]!.resolve({ filters: newer, outcome: 'search' });
      await flush();
      pending[0]!.resolve(searchAnswer);
      await flush();

      expect(proposals).toEqual([newer]);
      expect(latest()).toEqual({ status: 'proposal' });
    });

    it('never applies anything after being disposed, and aborts the request', async () => {
      const { controller, pending, proposals, snapshots } = setup();
      controller.submit('runs last month');
      const seen = snapshots.length;
      controller.dispose();
      expect(pending[0]!.signal.aborted).toBe(true);

      pending[0]!.resolve(searchAnswer);
      await flush();

      expect(proposals).toHaveLength(0);
      expect(snapshots).toHaveLength(seen);
    });

    it('does not accept a submission after being disposed', () => {
      const { controller, pending } = setup();
      controller.dispose();
      controller.submit('runs last month');
      expect(pending).toHaveLength(0);
    });

    it('treats an answer for another time zone as a failure instead of applying it', async () => {
      const { controller, latest, pending, proposals } = setup();
      controller.submit('runs last month');
      pending[0]!.resolve({ filters: { ...filters, timeZone: 'Asia/Tokyo' }, outcome: 'search' });
      await flush();
      expect(proposals).toHaveLength(0);
      expect(latest()).toMatchObject({ kind: 'failed', status: 'error' });
    });

    it('clears a shown proposal when the draft is edited, so it is never mistaken for current', async () => {
      const { controller, latest, pending } = setup();
      controller.submit('runs last month');
      pending[0]!.resolve(searchAnswer);
      await flush();
      expect(latest()).toEqual({ status: 'proposal' });
      controller.invalidate();
      expect(latest()).toEqual({ status: 'idle' });
    });

    it('does not turn an abort into an error message', async () => {
      const { controller, latest, pending } = setup();
      controller.submit('runs last month');
      controller.invalidate();
      pending[0]!.reject(new DOMException('aborted', 'AbortError'));
      await flush();
      expect(latest()).toEqual({ status: 'idle' });
    });
  });
});
