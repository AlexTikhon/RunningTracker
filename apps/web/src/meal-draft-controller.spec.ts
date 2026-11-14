import type { MealDraftProposalResponse } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { MealDraftController, type MealDraftLoader, type MealDraftSnapshot } from './meal-draft-controller.js';
import { RunnerApiError } from './runner-api.js';

const DAY = '2026-11-13';
const proposal = (localDate = DAY): MealDraftProposalResponse => ({
  localDate,
  mealType: { status: 'not_stated' },
  nutrition: {
    carbohydrateG: { status: 'not_stated' },
    energyKcal: { excerpt: '650 kcal', status: 'proposed', value: 650 },
    fatG: { status: 'not_stated' },
    proteinG: { reason: 'per_portion', status: 'withheld' },
  },
  outcome: 'draft',
  timeZone: 'Europe/Warsaw',
  title: 'Stew',
  version: 'meal-draft-1',
});

interface Pending {
  input: Parameters<MealDraftLoader>[0];
  reject: (error: unknown) => void;
  resolve: (value: MealDraftProposalResponse) => void;
  signal: AbortSignal;
}

function setup(session = new AbortController()) {
  const pending: Pending[] = [];
  const snapshots: MealDraftSnapshot[] = [];
  const load: MealDraftLoader = (input, signal) =>
    new Promise((resolve, reject) => {
      pending.push({ input, reject, resolve, signal });
    });
  const controller = new MealDraftController({ load, onChange: (snapshot) => snapshots.push(snapshot), orgId: 'org-a', signal: session.signal, timeZone: 'Europe/Warsaw' });
  return { controller, pending, session, snapshots };
}

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe('MealDraftController (ADR-0092)', () => {
  it('asks once for the exact text, date, organization and zone, and shows the proposal with its scope', async () => {
    const { controller, pending } = setup();
    expect(controller.submit('Stew, 650 kcal', DAY)).toBe(true);
    // A double click sends one request.
    expect(controller.submit('Stew, 650 kcal', DAY)).toBe(false);
    expect(pending.map((call) => call.input)).toEqual([{ localDate: DAY, orgId: 'org-a', text: 'Stew, 650 kcal', timeZone: 'Europe/Warsaw' }]);
    pending[0]!.resolve(proposal());
    await flush();
    expect(controller.snapshot).toMatchObject({ scope: { localDate: DAY, text: 'Stew, 650 kcal' }, status: 'proposal' });
  });

  it('drops a late answer after the text or the date changed, or after a cancel', async () => {
    const { controller, pending } = setup();
    controller.submit('Stew', DAY);
    controller.invalidate();
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(controller.snapshot).toEqual({ status: 'idle' });
    pending[0]!.resolve(proposal());
    await flush();
    expect(controller.snapshot).toEqual({ status: 'idle' });
    // A new request is allowed at once.
    expect(controller.submit('Stew', '2026-11-12')).toBe(true);
  });

  it('refuses an answer made for another date than the one asked about', async () => {
    const { controller, pending } = setup();
    controller.submit('Stew', DAY);
    pending[0]!.resolve(proposal('2026-11-12'));
    await flush();
    expect(controller.snapshot).toEqual({ kind: 'failed', retryAfterMs: null, status: 'error' });
  });

  it('is silenced for good when the session ends: nothing late reaches a form', async () => {
    const { controller, pending, session, snapshots } = setup();
    controller.submit('Stew', DAY);
    const before = snapshots.length;
    session.abort();
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve(proposal());
    await flush();
    expect(snapshots).toHaveLength(before);
    expect(controller.submit('Stew', DAY)).toBe(false);
  });

  it('turns "off" into a lasting unavailable state, and maps the bounded error codes', async () => {
    const cases: Array<[unknown, MealDraftSnapshot]> = [
      [new RunnerApiError('x', 503, 'MEAL_DRAFT_DISABLED', null), { status: 'unavailable' }],
      [new RunnerApiError('x', 429, 'MEAL_DRAFT_RATE_LIMITED', null, 30_000), { kind: 'rate_limited', retryAfterMs: 30_000, status: 'error' }],
      [new RunnerApiError('x', 429, 'MEAL_DRAFT_IN_PROGRESS', null), { kind: 'in_progress', retryAfterMs: null, status: 'error' }],
      [new RunnerApiError('x', 503, 'MEAL_DRAFT_BUSY', null), { kind: 'busy', retryAfterMs: null, status: 'error' }],
      [new RunnerApiError('x', 504, 'MEAL_DRAFT_TIMEOUT', null), { kind: 'timeout', retryAfterMs: null, status: 'error' }],
      [new RunnerApiError('x', 502, 'MEAL_DRAFT_FAILED', null), { kind: 'failed', retryAfterMs: null, status: 'error' }],
      [new RunnerApiError('x', 403, 'ORG_ACCESS_DENIED', null), { kind: 'access', retryAfterMs: null, status: 'error' }],
      [new TypeError('Failed to fetch'), { kind: 'network', retryAfterMs: null, status: 'error' }],
      [new DOMException('deadline', 'TimeoutError'), { kind: 'timeout', retryAfterMs: null, status: 'error' }],
    ];
    for (const [error, expected] of cases) {
      const { controller, pending } = setup();
      controller.submit('Stew', DAY);
      pending[0]!.reject(error);
      await flush();
      expect(controller.snapshot).toEqual(expected);
    }
    const { controller, pending } = setup();
    controller.submit('Stew', DAY);
    pending[0]!.reject(new RunnerApiError('x', 503, 'MEAL_DRAFT_DISABLED', null));
    await flush();
    expect(controller.submit('Stew', DAY)).toBe(false);
    controller.invalidate();
    expect(controller.snapshot).toEqual({ status: 'unavailable' });
  });

  it('shows clarifications and unsupported answers with their code only', async () => {
    const { controller, pending } = setup();
    controller.submit('Breakfast and lunch', DAY);
    pending[0]!.resolve({ localDate: DAY, outcome: 'clarify', reason: 'multiple_meals', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' });
    await flush();
    expect(controller.snapshot).toMatchObject({ reason: 'multiple_meals', status: 'clarify' });
  });
});
