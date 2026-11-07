import type { WeeklyInsightClaim, WeeklyInsightFact } from '@running-tracker/contracts';

import { WEEKLY_INSIGHT_FACTS_HEADER, WEEKLY_INSIGHT_SUGGESTION_NULL } from './insight-prompt.js';
import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmJsonSchema,
  type LlmProvider,
  type LlmStructuredInput,
  type LlmStructuredResult,
} from './llm-provider.js';

// A deterministic stand-in for a local model (ADR-0076): no network, no randomness. It reads the week's facts back out
// of the prompt it is given, exactly as a model would have to, so a test that passes with it proves that the prompt
// carries the facts. Every mode but `grounded` produces one specific bad answer for a negative test. Refused in
// production by the configuration.

export const fakeProviderModes = [
  'grounded',
  'invalid_schema',
  'invalid_then_grounded',
  'not_json',
  'number_in_prose',
  'unrelated_value',
  'wrong_unit',
  'reversed_direction',
  'swapped_min_max',
  'unknown_fact',
  'missing_as_zero',
  'diagnosis',
  'unsafe_medication',
  'unsafe_ignore_pain',
  'extreme_model_suggestion',
  'provider_error',
  'timeout',
] as const;
export type FakeProviderMode = (typeof fakeProviderModes)[number];

export const FAKE_PROVIDER_MODEL = 'fake';

export interface FakeProviderOptions {
  /** Awaited before each answer, so a test can hold a generation in flight. */
  beforeAnswer?: () => Promise<void>;
  /** Milliseconds to wait before answering (end-to-end tests observe the queued and running states). */
  delayMs?: number;
  /** Weeks (their Monday) for which every attempt fails as unavailable (end-to-end failure scenarios). */
  failingWeeks?: readonly string[];
  mode?: FakeProviderMode;
}

/** The facts embedded in a weekly insight prompt. Throws when the prompt does not carry them. */
export function factsFromPrompt(user: string): WeeklyInsightFact[] {
  const marker = `${WEEKLY_INSIGHT_FACTS_HEADER}\n`;
  const start = user.indexOf(marker);
  if (start < 0) throw new Error('The prompt does not carry the week facts');
  return JSON.parse(user.slice(start + marker.length)) as WeeklyInsightFact[];
}

/** The Monday of the week a prompt is about. */
export function weekOfPrompt(user: string): string {
  const matched = /^Week: (\d{4}-\d{2}-\d{2}) to /u.exec(user);
  if (!matched) throw new Error('The prompt does not name its week');
  return matched[1]!;
}

const claimOf = (fact: WeeklyInsightFact): WeeklyInsightClaim => ({
  day: fact.day,
  direction: fact.direction,
  factId: fact.id,
  unit: fact.unit,
  value: fact.value,
});

/** A schema-valid, grounded and safe answer about the prompt's facts, built only from them. */
export function groundedAnswer(facts: readonly WeeklyInsightFact[], suggestionNull: boolean): Record<string, unknown> {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const observations: { claims: WeeklyInsightClaim[]; text: string }[] = [];
  const checkIns = byId.get('check_ins.days_with_data');
  if (checkIns) observations.push({ claims: [claimOf(checkIns)], text: 'Here is how often you checked in.' });
  const sleep = byId.get('sleep.average_minutes');
  if (sleep) observations.push({ claims: [claimOf(sleep)], text: 'This is your average sleep for the nights you logged.' });
  const shortest = byId.get('sleep.shortest');
  const longest = byId.get('sleep.longest');
  if (shortest && longest) observations.push({ claims: [claimOf(shortest), claimOf(longest)], text: 'Your nights varied in length.' });
  const weight = byId.get('weight.change');
  if (weight) observations.push({ claims: [claimOf(weight)], text: 'Your weight is summarised here.' });
  return {
    observations: observations.slice(0, 4),
    suggestion: suggestionNull ? null : 'Keep a regular bedtime and check in each evening.',
    summary: 'A calm look at your week, based on what you logged.',
  };
}

function firstFact(facts: readonly WeeklyInsightFact[], predicate: (fact: WeeklyInsightFact) => boolean): WeeklyInsightFact {
  const found = facts.find(predicate);
  if (!found) throw new Error('The fake provider mode needs a fact this week does not have');
  return found;
}

export class FakeProvider implements LlmProvider {
  public readonly model = FAKE_PROVIDER_MODEL;
  public readonly calls: LlmStructuredInput[] = [];
  public mode: FakeProviderMode;
  readonly #beforeAnswer: (() => Promise<void>) | undefined;
  readonly #delayMs: number;
  readonly #failingWeeks: ReadonlySet<string>;

  public constructor(options: FakeProviderOptions = {}) {
    this.mode = options.mode ?? 'grounded';
    this.#beforeAnswer = options.beforeAnswer;
    this.#delayMs = options.delayMs ?? 0;
    this.#failingWeeks = new Set(options.failingWeeks ?? []);
  }

  public async generateStructured(
    input: LlmStructuredInput,
    _schema: LlmJsonSchema,
    options: LlmCallOptions,
  ): Promise<LlmStructuredResult> {
    this.calls.push(input);
    const signal = options.signal;
    if (signal?.aborted) throw new LlmProviderError('aborted', false);
    const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    if (this.#beforeAnswer) await Promise.race([this.#beforeAnswer(), aborted]);
    if (this.#delayMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#delayMs))), aborted]);
      clearTimeout(timer);
    }
    if (signal?.aborted) throw new LlmProviderError('aborted', false);
    if (this.#failingWeeks.has(weekOfPrompt(input.user))) throw new LlmProviderError('unavailable', true);

    const facts = factsFromPrompt(input.user);
    const suggestionNull = input.user.includes(WEEKLY_INSIGHT_SUGGESTION_NULL);
    const valid = groundedAnswer(facts, suggestionNull);
    const answer = (value: unknown): LlmStructuredResult => ({ value });
    const withObservation = (claim: WeeklyInsightClaim, text = 'Here is one part of your week.') =>
      answer({ ...valid, observations: [{ claims: [claim], text }] });

    switch (this.mode) {
      case 'grounded':
        return answer(valid);
      case 'invalid_schema':
        return answer({ ...valid, summary: 42 });
      case 'invalid_then_grounded':
        return answer(this.calls.length % 2 === 1 ? { ...valid, extra: true } : valid);
      case 'not_json':
        throw new LlmProviderError('invalid_response', false);
      case 'number_in_prose':
        return answer({ ...valid, summary: 'Your average sleep was 2 hours.' });
      case 'unrelated_value': {
        // The value of another fact, under the average sleep fact.
        const target = firstFact(facts, (fact) => fact.id === 'sleep.average_hours');
        const other = firstFact(facts, (fact) => fact.id !== target.id && fact.value !== target.value);
        return withObservation({ ...claimOf(target), value: other.value });
      }
      case 'wrong_unit':
        return withObservation({ ...claimOf(firstFact(facts, (fact) => fact.id === 'sleep.shortest')), unit: 'hours' });
      case 'reversed_direction': {
        const change = firstFact(facts, (fact) => fact.id === 'weight.change');
        return withObservation({ ...claimOf(change), direction: change.direction === 'down' ? 'up' : 'down' });
      }
      case 'swapped_min_max': {
        const shortest = firstFact(facts, (fact) => fact.id === 'sleep.shortest');
        const longest = firstFact(facts, (fact) => fact.id === 'sleep.longest');
        return withObservation({ ...claimOf(shortest), day: longest.day, value: longest.value });
      }
      case 'unknown_fact':
        return withObservation({ day: 'none', direction: 'none', factId: 'sleep.rem_minutes', unit: 'minutes', value: 90 });
      case 'missing_as_zero':
        return withObservation({ day: 'none', direction: 'none', factId: 'sleep.average_minutes', unit: 'minutes', value: 0 });
      case 'diagnosis':
        return answer({ ...valid, summary: 'Your short nights look like signs of insomnia.' });
      case 'unsafe_medication':
        return answer({ ...valid, summary: 'Take melatonin before bed to settle your nights.' });
      case 'unsafe_ignore_pain':
        return answer({ ...valid, summary: 'Rest and ignore severe pain.' });
      case 'extreme_model_suggestion':
        return answer({ ...valid, suggestion: 'Add an extra interval session to build toughness.' });
      case 'provider_error':
        throw new LlmProviderError('unavailable', true);
      case 'timeout':
        throw new LlmProviderError('timeout', true);
      default:
        return assertNever(this.mode);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unknown fake provider mode: ${String(value)}`);
}
