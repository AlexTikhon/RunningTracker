import { describe, expect, it } from 'vitest';

import { FakeInterpreter } from './fake-interpreter.js';
import { InterpreterFailure } from './interpretation-types.js';

const base = { timeZone: 'Europe/Warsaw', today: '2026-10-15' };
const signal = () => new AbortController().signal;

async function interpret(text: string, options?: ConstructorParameters<typeof FakeInterpreter>[0]) {
  return new FakeInterpreter(options).interpret({ ...base, text }, { signal: signal() });
}

describe('fake interpreter', () => {
  it('turns the documented sentence into the documented proposal', async () => {
    const { proposal } = await interpret('Show my runs of at least 5 km from last month, longest first.');
    expect(proposal).toMatchObject({
      distanceUnit: 'km',
      minDistance: '5',
      outcome: 'search',
      period: 'previous-month',
      sort: 'longest',
    });
  });

  it('understands a Russian sentence', async () => {
    const { proposal } = await interpret('Мои пробежки не менее 5 км за прошлый месяц, сначала самые длинные');
    expect(proposal).toMatchObject({ minDistance: '5', outcome: 'search', period: 'previous-month', sort: 'longest' });
  });

  it('asks about a strict bound and a missing period instead of guessing', async () => {
    expect((await interpret('runs of more than 5 km last month')).proposal).toMatchObject({
      clarificationReason: 'distance_boundary_strict',
      outcome: 'clarify',
    });
    expect((await interpret('runs of at least 5 km')).proposal).toMatchObject({
      clarificationReason: 'period_missing',
      outcome: 'clarify',
    });
  });

  it('reports what it cannot filter on', async () => {
    expect((await interpret('runs in Berlin last month')).proposal).toMatchObject({
      outcome: 'unsupported',
      unsupportedReason: 'location',
    });
  });

  it('can be told to fail, refuse or answer invalidly, and to take time', async () => {
    await expect(interpret('runs [fail]')).rejects.toMatchObject({ reason: 'provider_error' });
    await expect(interpret('runs [refuse]')).rejects.toMatchObject({ reason: 'refusal' });
    await expect(interpret('runs [invalid]')).rejects.toMatchObject({ reason: 'invalid_output' });
    const started = Date.now();
    await interpret('runs this month [delay=60]');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('stops waiting when cancelled', async () => {
    const controller = new AbortController();
    const pending = new FakeInterpreter().interpret(
      { ...base, text: 'runs this month [delay=4000]' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(InterpreterFailure);
  });
});
